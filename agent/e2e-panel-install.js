'use strict';
// BlockNexus 端到端测试：隔离面板（临时 config）+ 独立 Agent（listen 模式）
// 覆盖：加密通道上传断点续传（含 Agent 重启后续传）→ 面板代下全链路 → 安装失败自动兜底
// 运行：node agent/e2e-panel-install.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const { Config } = require(path.join(ROOT, 'panel', 'config'));
const { AgentHub } = require(path.join(ROOT, 'panel', 'agentlink'));
const { createApi } = require(path.join(ROOT, 'panel', 'api'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blocknexus-e2e-'));
const INSTANCES = path.join(TMP, 'instances');
const TOKEN = Buffer.from('e2e-test-token-00000000000000').toString('base64url');
const SRV = 'srv_e2e01';
const PANEL_PORT = 3200;
const AGENT_PORT = 3199;
const FILE_PORT = 3210;

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const assert = (cond, msg) => {
  if (!cond) throw new Error('断言失败: ' + msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api${p}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function listInstances() {
  return api('GET', `/servers/${SRV}/instances`);
}
async function findInstance(name) {
  return (await listInstances()).find((i) => i.name === name) || null;
}
async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try {
      v = await cond();
    } catch {}
    if (v) return v;
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await sleep(500);
  }
}
async function consoleLines(name, tail = 300) {
  const r = await api('GET', `/servers/${SRV}/instances/${encodeURIComponent(name)}/console?tail=${tail}`);
  return (r.lines || []).map((l) => l.text || '').join('\n');
}

// ---- 假核心站点：/a.jar /b.jar 返回确定性伪随机内容 ----
function fakeJar(seed, size) {
  const buf = Buffer.alloc(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = s & 0xff;
  }
  return buf;
}
const JAR_A = fakeJar(42, 640 * 1024);
const JAR_B = fakeJar(1337, 1100 * 1024);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  // ---------- 隔离面板 ----------
  const config = new Config(path.join(TMP, 'config.json'));
  config.data.servers.push({
    id: SRV,
    name: 'E2E',
    host: '127.0.0.1',
    token: TOKEN,
    createdAt: Date.now(),
    status: 'offline',
    lastSeen: null,
    info: null,
    installing: false,
    ssh: { port: 22, user: 'root', auth: 'password', password: '', keyPath: '', key: '' },
    agent: {
      mode: 'outbound', host: '127.0.0.1', port: AGENT_PORT, tls: false,
      tlsFingerprint: '', panelUrl: '', installDir: '/opt/blocknexus-agent',
    },
  });
  config.save();
  const bus = new EventEmitter();
  const hub = new AgentHub(config, bus);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApi(config, hub, bus));
  const panelSrv = app.listen(PANEL_PORT, '127.0.0.1');

  // ---------- 假核心站点 ----------
  const fileSrv = http.createServer((req, res) => {
    const jar = req.url.startsWith('/a.jar') ? JAR_A : req.url.startsWith('/b.jar') ? JAR_B : null;
    if (!jar) {
      res.statusCode = 404;
      return res.end('nope');
    }
    res.setHeader('Content-Length', String(jar.length));
    res.end(jar);
  });
  await new Promise((r) => fileSrv.listen(FILE_PORT, '127.0.0.1', r));

  // ---------- 独立 Agent（listen 模式） ----------
  let agentProc = null;
  const agentLog = fs.openSync(path.join(TMP, 'agent.log'), 'a');
  function startAgent() {
    agentProc = spawn(
      process.execPath,
      [path.join(ROOT, 'agent', 'agent.js'), '--listen', String(AGENT_PORT), '--token', TOKEN, '--id', SRV, '--instances', INSTANCES],
      { stdio: ['ignore', agentLog, agentLog] },
    );
    return agentProc;
  }
  startAgent();

  try {
    // ---------- T0：Agent 上线 ----------
    await waitFor(
      async () => (await api('GET', `/servers/${SRV}`).catch(() => null))?.online === true,
      20000,
      'Agent 上线',
    );
    report('T0 Agent 经加密通道上线', true);

    // ---------- T1：加密通道上传断点续传 ----------
    await api('POST', `/servers/${SRV}/instances`, {
      name: 'e2e0', port: 25600, source: 'upload', memoryMB: 512, eula: true,
    });
    const req = (action, params, timeout = 30000) => hub.request(SRV, action, params, timeout);
    const total = 3 * 512 * 1024;
    const data = crypto.randomFillSync(Buffer.alloc(total));
    const chunk = 512 * 1024;
    const b1 = await req('fs.upload.begin', {
      name: 'e2e0', dir: '', filename: 'resume-test.bin', size: total, lastModified: 111,
    });
    assert(!b1.resumed && b1.received === 0, '全新 begin 应从 0 开始');
    await req('fs.upload.chunk', { uploadId: b1.uploadId, seq: 1, dataB64: data.subarray(0, chunk).toString('base64') });
    // 模拟 ACK 丢失：同参数重新 begin（resume）→ 应复用同一会话并汇报进度
    const b2 = await req('fs.upload.begin', {
      name: 'e2e0', dir: '', filename: 'resume-test.bin', size: total, lastModified: 111, resume: true,
    });
    assert(b2.uploadId === b1.uploadId && b2.resumed && b2.received === chunk, '进行中的会话应被复用并汇报 received');
    await req('fs.upload.chunk', { uploadId: b2.uploadId, seq: 1, dataB64: data.subarray(chunk, 2 * chunk).toString('base64') });
    await req('fs.upload.chunk', { uploadId: b2.uploadId, seq: 2, dataB64: data.subarray(2 * chunk, 3 * chunk).toString('base64') });
    await req('fs.upload.finish', { uploadId: b2.uploadId });
    const got = fs.readFileSync(path.join(INSTANCES, 'e2e0', 'resume-test.bin'));
    assert(got.equals(data), '续传后的文件内容必须与原始一致');
    report('T1 分块续传（ACK 丢失重连复用会话 / 内容校验）', true);

    // 指纹不匹配 → 不续传，从头来（防止同名不同文件被污染）
    const f1 = await req('fs.upload.begin', { name: 'e2e0', dir: '', filename: 'fp.bin', size: 600 * 1024, lastModified: 222 });
    await req('fs.upload.chunk', { uploadId: f1.uploadId, seq: 1, dataB64: Buffer.alloc(100, 1).toString('base64') });
    const f2 = await req('fs.upload.begin', { name: 'e2e0', dir: '', filename: 'fp.bin', size: 600 * 1024, lastModified: 333, resume: true });
    assert(f2.resumed === false && f2.received === 0, '指纹不匹配必须重新开始');
    await req('fs.upload.abort', { uploadId: f2.uploadId });
    report('T1b 文件指纹防误续传', true);

    // Agent 重启后续传：会话在内存里丢了，磁盘 tmp 还在；追加的 100 字节模拟崩溃时写了一半的块
    const r1 = await req('fs.upload.begin', { name: 'e2e0', dir: '', filename: 'restart.bin', size: total, lastModified: 444 });
    await req('fs.upload.chunk', { uploadId: r1.uploadId, seq: 1, dataB64: data.subarray(0, chunk).toString('base64') });
    fs.appendFileSync(path.join(INSTANCES, 'e2e0', 'restart.bin.blocknexus-upload'), Buffer.alloc(100, 7));
    // 半块不足一块（对齐点为 0）：重启后必须 seekTo=0 截掉，否则会拼在垃圾后面
    await req('fs.upload.begin', { name: 'e2e0', dir: '', filename: 'half.bin', size: total, lastModified: 555 });
    fs.appendFileSync(path.join(INSTANCES, 'e2e0', 'half.bin.blocknexus-upload'), Buffer.alloc(100, 7));
    agentProc.kill();
    await waitFor(() => agentProc.exitCode !== null || agentProc.signalCode !== null, 10000, 'Agent 退出');
    await sleep(300);
    startAgent();
    await waitFor(async () => hub.isOnline(SRV), 25000, 'Agent 重连');
    const r2 = await req('fs.upload.begin', {
      name: 'e2e0', dir: '', filename: 'restart.bin', size: total, lastModified: 444, resume: true,
    });
    assert(r2.resumed === true && r2.received === chunk + 100, '重启后应按磁盘 tmp 续传（含半块）');
    const aligned = Math.floor(r2.received / r2.chunk) * r2.chunk;
    assert(aligned === chunk, '对齐到整块边界');
    // 半块被 seekTo 截掉，从对齐点继续
    await req('fs.upload.chunk', { uploadId: r2.uploadId, seq: 1, dataB64: data.subarray(chunk, 2 * chunk).toString('base64'), seekTo: aligned });
    await req('fs.upload.chunk', { uploadId: r2.uploadId, seq: 2, dataB64: data.subarray(2 * chunk, 3 * chunk).toString('base64') });
    await req('fs.upload.finish', { uploadId: r2.uploadId });
    assert(fs.readFileSync(path.join(INSTANCES, 'e2e0', 'restart.bin')).equals(data), '重启续传内容一致（半块已截掉）');
    // 半块 < 1 块：对齐点为 0，seekTo=0 截掉全部垃圾后从头传
    const h1 = await req('fs.upload.begin', {
      name: 'e2e0', dir: '', filename: 'half.bin', size: total, lastModified: 555, resume: true,
    });
    assert(h1.resumed === true && h1.received === 100, '不足一块的半块也应计入 received');
    await req('fs.upload.chunk', { uploadId: h1.uploadId, seq: 1, dataB64: data.subarray(0, chunk).toString('base64'), seekTo: 0 });
    await req('fs.upload.chunk', { uploadId: h1.uploadId, seq: 2, dataB64: data.subarray(chunk, 2 * chunk).toString('base64') });
    await req('fs.upload.chunk', { uploadId: h1.uploadId, seq: 3, dataB64: data.subarray(2 * chunk, 3 * chunk).toString('base64') });
    await req('fs.upload.finish', { uploadId: h1.uploadId });
    assert(fs.readFileSync(path.join(INSTANCES, 'e2e0', 'half.bin')).equals(data), 'seekTo=0 截断后内容一致');
    report('T1c Agent 重启后断点续传（含半块对齐截断）', true);

    // ---------- T2：常规安装（回归：Agent 自己下载直链） ----------
    await api('POST', `/servers/${SRV}/instances`, {
      name: 'e2e1', port: 25601, source: 'url', url: `http://127.0.0.1:${FILE_PORT}/a.jar`,
      version: 'fake-1.0', memoryMB: 512, eula: true,
    });
    await waitFor(async () => (await findInstance('e2e1'))?.status === 'stopped', 60000, 'e2e1 常规安装完成');
    const gotA = fs.readFileSync(path.join(INSTANCES, 'e2e1', 'server.jar'));
    assert(gotA.equals(JAR_A), '常规安装的 server.jar 内容一致');
    report('T2 常规直链安装（回归）', true);

    // ---------- T3：面板代下全链路 ----------
    await api('POST', `/servers/${SRV}/instances`, {
      name: 'e2e2', port: 25602, source: 'url', url: `http://127.0.0.1:${FILE_PORT}/b.jar`,
      version: 'fake-2.0', memoryMB: 512, eula: true,
    });
    await waitFor(async () => (await findInstance('e2e2'))?.status === 'stopped', 60000, 'e2e2 初始安装');
    const p1 = await api('POST', `/servers/${SRV}/instances/e2e2/panel-install`, {});
    assert(p1 && p1.ok, 'panel-install 返回 ok');
    await waitFor(async () => {
      const lines = await consoleLines('e2e2');
      return lines.includes('面板代下完成');
    }, 60000, '面板代下完成叙述');
    assert(fs.readFileSync(path.join(INSTANCES, 'e2e2', 'server.jar')).equals(JAR_B), '面板代下落位的 server.jar 内容一致');
    const lines2 = await consoleLines('e2e2');
    assert(lines2.includes('经加密通道传输到服务器'), '控制台应有传输叙述');
    report('T3 面板代下（解析→下载→加密通道推送→落位安装）', true);

    // ---------- T4：安装失败自动兜底（面板也拉不到 → 只触发一次，不循环） ----------
    await api('POST', `/servers/${SRV}/instances`, {
      name: 'e2e3', port: 25603, source: 'url', url: 'http://127.0.0.1:1/x.jar',
      version: 'fake-3.0', memoryMB: 512, eula: true,
    });
    await waitFor(async () => (await findInstance('e2e3'))?.status === 'failed', 90000, 'e2e3 安装失败');
    await waitFor(async () => (await consoleLines('e2e3')).includes('面板代下失败'), 60000, '自动兜底触发并失败');
    await sleep(3000); // 冷却期内不应再触发
    const bad = await consoleLines('e2e3');
    const hits = bad.split('[BlockNexus] 服务器侧下载失败，自动改由面板侧下载').length - 1;
    assert(hits === 1, `自动兜底只触发一次（实际 ${hits} 次）`);
    report('T4 安装失败自动兜底 + 冷却防循环', true);

    // ---------- 汇总 ----------
    const failed = results.filter((r) => !r.ok);
    console.log('');
    console.log(failed.length ? `结果：${results.length - failed.length}/${results.length} 通过` : `结果：全部 ${results.length} 项通过 ✓`);
    console.log('临时目录: ' + TMP);
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('');
    console.error('✗ 测试异常: ' + e.message);
    console.error(e.stack);
    for (const r of results) if (!r.ok) console.error(`✗ ${r.name} — ${r.detail}`);
    console.log('临时目录（保留供排查）: ' + TMP);
    process.exitCode = 1;
  } finally {
    try { agentProc && agentProc.kill(); } catch {}
    try { panelSrv.close(); } catch {}
    try { fileSrv.close(); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
}

main();
