'use strict';
// 「快速添加」编排层的集成测试：真面板 API（隔离 config）+ 假 Agent（stub hub）。
//
// 为什么不用真 Agent：真链路要下载真的 Paper 核心、还要 Java，CI 里既慢又不稳。
// 这里验证的是**编排本身**——参数补全、调用顺序、幂等复用、失败落点与 task-log 字段，
// 这些才是最容易写错的部分；下载/启动的正确性由 Agent 自己的测试覆盖。
// 运行：node agent/test-quick-setup.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const { Config } = require(path.join(ROOT, 'panel', 'config'));
const { createApi } = require(path.join(ROOT, 'panel', 'api'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blocknexus-quick-'));
const PANEL_PORT = 3270;
const SRV = 'srv_quick01';

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api${p}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** 假 Agent：按 action 返回预设，并记录收到的参数 */
function makeFakeHub() {
  const state = {
    instances: [], // 现有实例（{name, port, status, version, error}）
    created: null, // instance.create 收到的参数
    started: false,
    startCalls: 0,
    createCalls: 0,
    javaInstalled: true,
    javaMajor: 21,
    javaInstallCalls: 0,
    listCalls: 0,
    calls: [], // 调用顺序
  };
  const hub = new EventEmitter();
  hub.state = state;
  hub.conns = new Map();
  hub.isOnline = () => true;
  hub.getOnlineSince = () => Date.now();
  hub.getLatency = () => 5;
  hub.syncOutbound = () => {};
  hub.stopOutbound = () => {};
  hub.request = async (id, action, params = {}) => {
    state.calls.push(action);
    switch (action) {
      case 'sys.info':
        return {
          hostname: 'quick-test',
          os: 'Linux',
          arch: 'x64',
          node: process.version,
          memTotalMB: 4096,
          dir: TMP,
          instancesDir: path.join(TMP, 'instances'),
          java: state.javaInstalled
            ? { installed: true, major: state.javaMajor, raw: 'openjdk version "21"' }
            : { installed: false },
        };
      case 'instance.list': {
        // 启动后一切都报 running（startAndConfirm 要看到这个状态才算启动成功）
        if (state.started) {
          const rec = state.created || state.instances[0];
          return rec ? [{ ...rec, status: 'running' }] : [];
        }
        if (!state.created) return state.instances.slice();
        state.listCalls++;
        // 第一次看到「下载中」，第二次就绪——把等待时间压到 2 秒量级
        const st = state.listCalls >= 2 ? 'stopped' : 'downloading';
        return [{ ...state.created, status: st }];
      }
      case 'core.catalogs':
        return {
          kinds: [{ id: 'paper', label: 'Paper', api: true }],
          catalogs: {
            paper: {
              ok: true,
              latest: '1.21.4',
              versions: [{ id: '1.21.4' }, { id: '1.21.3' }, { id: '1.20.4' }],
            },
            vanilla: { ok: true, latest: '1.21.4', versions: [{ id: '1.21.4' }] },
          },
        };
      case 'instance.create':
        state.createCalls++;
        state.created = { ...params };
        return { ok: true, download: 'started' };
      case 'instance.start':
        state.startCalls++;
        state.started = true;
        return { ok: true };
      case 'java.install':
        state.javaInstallCalls++;
        state.javaInstalled = true;
        state.javaMajor = Number(params.major) || 21;
        return { ok: true, started: true };
      case 'instance.console':
        return { lines: [{ ts: Date.now(), text: 'Error: Unable to access jarfile server.jar' }], status: 'stopped' };
      default:
        throw new Error('假 Agent 未实现的操作: ' + action);
    }
  };
  return hub;
}

/** 等任务日志收尾（done 非 null） */
async function waitTaskDone(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', `/servers/${SRV}/task-log?kind=install`);
    if (r.data.done !== null && r.data.done !== undefined) return r.data;
    if (Date.now() > deadline) throw new Error('等待快速添加任务超时');
    await sleep(250);
  }
}

async function main() {
  const config = new Config(path.join(TMP, 'config.json'));
  config.data.servers.push({
    id: SRV,
    name: 'Quick',
    host: '10.0.0.9',
    token: 'quick-test-token',
    createdAt: Date.now(),
    status: 'online',
    lastSeen: Date.now(),
    info: { memTotalMB: 4096, java: { installed: true, major: 21 } },
    installing: false,
    ssh: { port: 22, user: 'root', auth: 'password', password: 'x', keyPath: '', key: '' },
    agent: {
      mode: 'outbound', host: '10.0.0.9', port: 3099, tls: false,
      tlsFingerprint: '', panelUrl: '', installDir: '/opt/blocknexus-agent',
    },
  });
  config.save();

  const bus = new EventEmitter();
  const hub = makeFakeHub();
  const st = hub.state;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApi(config, hub, bus));
  const srv = app.listen(PANEL_PORT, '127.0.0.1');
  await sleep(150);

  try {
    // ---------- 1. 入口校验 ----------
    {
      const r = await call('POST', '/servers/quick-create', { host: 'example.com', sshAuth: 'password', eula: true });
      report('远程缺凭据 → 400 quick-credentials-required', r.status === 400 && r.data.code === 'server.quick-credentials-required', JSON.stringify(r.data));
      const r2 = await call('POST', '/servers/quick-create', { host: 'example.com', sshAuth: 'password', sshPassword: 'x' });
      report('缺 EULA → 400 quick-eula-required', r2.status === 400 && r2.data.code === 'server.quick-eula-required', JSON.stringify(r2.data));
      const r3 = await call('POST', '/servers/quick-create', { host: 'not a host!', eula: true });
      report('非法主机 → 400 host-invalid', r3.status === 400 && r3.data.code === 'server.host-invalid', JSON.stringify(r3.data));
      const r4 = await call('POST', `/servers/${SRV}/quick-setup`, {});
      report('重试缺 EULA → 400', r4.status === 400 && r4.data.code === 'server.quick-eula-required', JSON.stringify(r4.data));
    }

    // ---------- 2. 全新机器：默认值 + 建实例 + 开服 ----------
    {
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { eula: true, mc: {} });
      report('快速添加受理', r.status === 200 && r.data.started === true, JSON.stringify(r.data));
      const log = await waitTaskDone();
      report('任务完成且成功', log.ok === true, JSON.stringify({ ok: log.ok, error: log.error }));
      report('返回实例名', log.instance === 'survival', String(log.instance));
      report(
        '创建参数：paper + 最新版 + 推荐内存 + 默认端口 + EULA',
        !!st.created &&
          st.created.source === 'paper' &&
          st.created.version === '1.21.4' &&
          st.created.memoryMB === 2048 && // 4GB 机器 → 2GB
          st.created.port === 25565 &&
          st.created.name === 'survival' &&
          st.created.eula === true &&
          st.created.onlineMode === true,
        JSON.stringify(st.created),
      );
      report('调用了 instance.start', st.startCalls === 1, `startCalls=${st.startCalls}`);
      report('已装 Java 21 时不重复安装', st.javaInstallCalls === 0);
      report('任务日志里有分段进度', /①/.test(log.lines) && /③ 创建实例/.test(log.lines) && /✓ 完成/.test(log.lines));
    }

    // ---------- 3. 显式同名的已就绪实例：复用而不是再建一份 ----------
    {
      st.created = null;
      st.createCalls = 0;
      st.startCalls = 0;
      st.listCalls = 0;
      st.started = false;
      st.instances = [{ name: 'reuse-me', port: 25570, status: 'stopped', version: '1.21.4' }];
      const r = await call('POST', `/servers/${SRV}/quick-setup`, {
        eula: true,
        mc: { name: 'reuse-me' },
      });
      report('复用场景受理', r.status === 200 && r.data.started === true);
      const log = await waitTaskDone();
      report('复用场景成功', log.ok === true && log.reused === true, JSON.stringify({ ok: log.ok, reused: log.reused }));
      report('没有重复创建实例', st.createCalls === 0, `createCalls=${st.createCalls}`);
      report('复用后顺手启动', st.startCalls === 1, `startCalls=${st.startCalls}`);
      report('日志说明复用了已有实例', /已存在且核心已就位，复用/.test(log.lines));
    }

    // ---------- 3b. 上次装失败的实例：续装同一个，不建 survival-2 ----------
    {
      st.created = null;
      st.createCalls = 0;
      st.startCalls = 0;
      st.listCalls = 0;
      st.started = false;
      st.retryCalls = 0;
      st.instances = [{ name: 'survival', port: 25565, status: 'failed', version: '1.21.4', error: '下载中断' }];
      const orig = hub.request;
      hub.request = async (id, action, params = {}) => {
        if (action === 'instance.retry-install') {
          st.retryCalls++;
          st.instances = [{ ...st.instances[0], status: 'downloading', error: undefined }];
          // 续装后直接进入「就绪」，模拟安装成功
          setTimeout(() => {
            st.instances = [{ ...st.instances[0], status: 'stopped' }];
          }, 300);
          return { ok: true, download: 'started' };
        }
        if (action === 'instance.list') {
          if (st.started) return [{ ...st.instances[0], status: 'running' }];
          return st.instances.slice();
        }
        if (action === 'instance.start') {
          st.startCalls++;
          st.started = true;
          return { ok: true };
        }
        if (action === 'instance.create') {
          st.createCalls++;
          return { ok: true, download: 'started' };
        }
        return orig(id, action, params);
      };
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { eula: true, mc: {} });
      report('续装场景受理', r.status === 200);
      const log = await waitTaskDone();
      hub.request = orig;
      report('续装场景成功', log.ok === true, String(log.error || ''));
      report('走的是 instance.retry-install', st.retryCalls === 1, `retryCalls=${st.retryCalls}`);
      report('没有新建第二个实例', st.createCalls === 0, `createCalls=${st.createCalls}`);
      report('实例名仍是 survival（不是 survival-2）', log.instance === 'survival', String(log.instance));
      report('日志说明「已存在但未就绪」', /已存在但未就绪/.test(log.lines));
    }

    // ---------- 4. 端口冲突：自动顺延（名字另起） ----------
    {
      st.created = null;
      st.started = false;
      st.createCalls = 0;
      st.startCalls = 0;
      st.listCalls = 0;
      st.instances = [{ name: 'survival', port: 25565, status: 'stopped', version: '1.20.4' }];
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { eula: true, mc: {} });
      report('冲突场景受理', r.status === 200);
      const log = await waitTaskDone();
      report('冲突场景成功', log.ok === true, String(log.error || ''));
      report('实例名自动变成 survival-2', st.created && st.created.name === 'survival-2', JSON.stringify(st.created));
      report('端口自动顺延到 25566', st.created && st.created.port === 25566, String(st.created && st.created.port));
      report('日志写明端口顺延原因', /25565 已被其他实例占用，改用 25566/.test(log.lines));
    }

    // ---------- 5. 指定参数 + 缺 Java 自动安装 ----------
    {
      st.created = null;
      st.started = false;
      st.createCalls = 0;
      st.startCalls = 0;
      st.listCalls = 0;
      st.instances = [];
      st.javaInstalled = false;
      st.javaMajor = 0;
      st.javaInstallCalls = 0;
      const r = await call('POST', `/servers/${SRV}/quick-setup`, {
        eula: true,
        mc: { source: 'paper', version: '1.20.4', memoryMB: 4096, port: 30000, name: 'custom', onlineMode: false, motd: 'hi' },
      });
      report('显式参数受理', r.status === 200);
      const log = await waitTaskDone();
      report('显式参数场景成功', log.ok === true, String(log.error || ''));
      report(
        '显式参数被原样采用',
        !!st.created &&
          st.created.name === 'custom' &&
          st.created.port === 30000 &&
          st.created.memoryMB === 4096 &&
          st.created.version === '1.20.4' &&
          st.created.onlineMode === false &&
          st.created.motd === 'hi',
        JSON.stringify(st.created),
      );
      report('缺 Java 时自动安装（1.20.4 → Java 17）', st.javaInstallCalls === 1 && st.javaMajor === 17);
    }

    // ---------- 6. 非法核心类型：快速失败，不建实例 ----------
    {
      st.created = null;
      st.createCalls = 0;
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { eula: true, mc: { source: 'url' } });
      report('非法核心受理后异步失败', r.status === 200);
      const log = await waitTaskDone();
      report('任务标记失败并带原因', log.ok === false && /不支持该核心类型/.test(log.error || ''), String(log.error));
      report('失败时没有创建实例', st.createCalls === 0);
      report('失败后保留服务器记录（可重试）', !!config.getServer(SRV));
    }

    // ---------- 7. 安装失败：记录错误、不假装成功 ----------
    {
      st.created = null;
      st.createCalls = 0;
      st.listCalls = 0;
      st.instances = [];
      st.started = false;
      // 让 instance.list 永远报 failed，模拟核心下载失败
      const origRequest = hub.request;
      hub.request = async (id, action, params = {}) => {
        if (action === 'instance.create') {
          st.createCalls++;
          st.created = { ...params };
          return { ok: true, download: 'started' };
        }
        if (action === 'instance.list' && st.created) {
          return [{ ...st.created, status: 'failed', error: '核心下载失败: 404' }];
        }
        return origRequest(id, action, params);
      };
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { eula: true, mc: {} });
      report('下载失败场景受理', r.status === 200);
      const log = await waitTaskDone();
      hub.request = origRequest;
      report('下载失败 → 任务失败并透出原因', log.ok === false && /核心下载失败/.test(log.error || ''), String(log.error));
      report('失败日志带排查指引', /服务器记录已保留/.test(log.lines));
    }

    // ---------- 8. 只装 Agent（不建实例）：默认路径 ----------
    {
      st.created = null;
      st.createCalls = 0;
      st.startCalls = 0;
      st.listCalls = 0;
      st.instances = [];
      const r = await call('POST', `/servers/${SRV}/quick-setup`, { createInstance: false });
      report('只装 Agent 场景受理（不需要 EULA）', r.status === 200 && r.data.started === true, JSON.stringify(r.data));
      const log = await waitTaskDone();
      report('只装 Agent 场景成功', log.ok === true, String(log.error || ''));
      report('没有创建实例', st.createCalls === 0, `createCalls=${st.createCalls}`);
      report('没有启动实例', st.startCalls === 0, `startCalls=${st.startCalls}`);
      report('任务结果里实例名为空', log.instance === null || log.instance === undefined, String(log.instance));
      report('日志说明「未创建实例」', /未创建实例/.test(log.lines));
    }
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败：\n' + failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n'));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}

main().catch((e) => {
  console.error('快速添加集成测试异常:', e);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 200).unref();
});
