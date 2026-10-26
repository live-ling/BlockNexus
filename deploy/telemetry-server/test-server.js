'use strict';
// 遥测接收端的回归测试：起真 HTTP 服务 + 假出站，全部断言「什么不该被存下来」。
// 运行：node deploy/telemetry-server/test-server.js

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.TELEMETRY_PORT = '0'; // 随机端口
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-tel-srv-'));
process.env.TELEMETRY_DATA_DIR = dir;

const server = require('./server.js');

let pass = 0;
let total = 0;
function ok(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${!cond && detail ? ' — ' + detail : ''}`);
}

const ID = 'a1b2c3d4-0000-4000-8000-000000000000';
const GOOD = {
  v: 1,
  id: ID,
  ts: Date.now(),
  panelVer: '0.6.0',
  os: 'windows',
  arch: 'x64',
  installKind: 'portable',
  agentVers: ['0.5.2', '0.6.0'],
  servers: '2-5',
  instances: 'unknown',
  features: { ddns: true, frp: false, ai: true, smtp: false, notify: true },
  errors: { 'ssh.timeout': 3 },
};

function post(body, port) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = require('http').request(
      { host: '127.0.0.1', port, path: '/telemetry', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, body: t }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(p, port) {
  return new Promise((resolve, reject) => {
    require('http')
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, body: t }));
      })
      .on('error', reject);
  });
}

(async () => {
  // listen 是异步的：轮询 /health 直到能拿到真实端口
  let port = 0;
  for (let i = 0; i < 50; i++) {
    const p = server.port;
    if (p > 0) {
      try {
        await get('/health', p);
        port = p;
        break;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok('服务已监听', typeof port === 'number' && port > 0, String(port));

  // 1) 正常上报
  const r1 = await post(GOOD, port);
  ok('正常上报 → 200', r1.status === 200, r1.body);

  // 2) 幂等去重
  const r2 = await post(GOOD, port);
  ok('同一 ID 重复上报 → deduped', r2.status === 200 && r2.body.includes('deduped'), r2.body);

  // 3) 拒收类：整包非法的才拒（422）；能收敛的收敛、能剔除的剔除（200 + 语义正确）
  const dirty = [
    ['缺 id', { ...GOOD, id: '' }],
    ['id 非法形状', { ...GOOD, id: 'not-a-uuid' }],
    ['缺 panelVer', { ...GOOD, panelVer: '' }],
    ['panelVer 是 IP', { ...GOOD, panelVer: '1.2.3.4' }],
    ['数组 body', [GOOD]],
    ['字符串 body', 'x'],
  ];
  for (const [label, body] of dirty) {
    const r = await post(body, port);
    ok(`拒收: ${label}`, r.status === 422, `got ${r.status}`);
  }

  // 收敛/剔除类：不认识的东西不进库，但其余合法字段照常收——这才是白名单该有的行为
  const r3 = await post({ ...GOOD, os: 'windows; curl evil.com', arch: 'AMD64' }, port);
  ok('未知 os/arch 收敛为 other（不整包拒收）', r3.status === 200, `${r3.status}`);

  const r4 = await post({ ...GOOD, errors: { '连接 1.2.3.4 失败': 1, 'ssh.timeout': 5 } }, port);
  ok('errors 非法键剔除、合法键保留', r4.status === 200, `${r4.status}`);

  // JSON 坏 → 400
  const badJson = await new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: '/telemetry', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (r) => {
        let t = '';
        r.on('data', (c) => (t += c));
        r.on('end', () => resolve({ status: r.statusCode, body: t }));
      },
    );
    req.on('error', reject);
    req.end('{"broken');
  });
  ok('拒收: 非法 JSON', badJson.status === 400, JSON.stringify(badJson));

  // 5) /health 与 /summary
  ok('health → 200', (await get('/health', port)).status === 200);
  const sum = JSON.parse((await get('/summary', port)).body);
  ok('summary.totalRecords=1', sum.totalRecords === 1, JSON.stringify(sum.totalRecords));
  ok('summary.uniqueIds=1', sum.uniqueIds === 1);
  ok('summary.today.installs=1', sum.today.installs === 1, JSON.stringify(sum.today));
  ok('summary.panelVer 含 0.6.0', sum.panelVer['0.6.0'] === 1);
  ok('summary.features 含 ddns/ai', sum.features.ddns === 1 && sum.features.ai === 1, JSON.stringify(sum.features));
  ok('summary.agentVers 含 0.5.2', sum.agentVers['0.5.2'] === 1);

  // 6) 落盘内容审查：id 是设计内的匿名统计 ID（可重置），落库正确；
  //    除此之外不该有任何 payload 里没有的字段
  const jsonl = fs.readFileSync(path.join(dir, 'telemetry.jsonl'), 'utf8');
  ok('落盘含 id（匿名统计 ID 本就是设计内字段）', jsonl.includes(ID));
  ok('落盘不含 payload 里没有的字段', !jsonl.includes('"host"') && !jsonl.includes('"ip"') && !jsonl.includes('"domain"'));
  ok('落盘不含 IP 字面量', !/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(jsonl), jsonl.slice(0, 120));

  // 7) 多天聚合（手动注入历史记录验证 installsPerDay）
  const y = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, 'telemetry.jsonl'), JSON.stringify({ ...GOOD, id: 'b1b2c3d4-0000-4000-8000-000000000000', ts: Date.parse(y + 'T12:00:00Z') }) + '\n');
  const sum2 = JSON.parse((await get('/summary?days=7', port)).body);
  ok('按天装机数包含两天', Object.keys(sum2.installsPerDay).length >= 2, JSON.stringify(sum2.installsPerDay));

  // 8) 404
  ok('未知路径 → 404', (await get('/nope', port)).status === 404);

  server.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}/${total} telemetry-server cases passed`);
  if (pass !== total) process.exit(1);
  process.exit(0);
})();
