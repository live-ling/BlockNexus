'use strict';
// 玩家统计 / 聊天记录的接口面测试（零依赖测试框架）
//
// 覆盖两层，两层的失败模式不同：
//   ① **面板转发**：参数规范化（limit 夹到 1..300、q ≤64、player ≤32、非法 before 丢掉）
//      —— Agent 侧虽然会再校验一遍，但面板这一层是唯一能拦住「畸形请求变成巨型响应」
//      的地方（单帧别太大、别把用户输入当正则下发）；以及鉴权边界：新路由必须落在
//      鉴权中间件**之后**（否则等于给未登录者开了读取玩家聊天内容的接口）。
//   ② **Agent 派发**：handleAction 的 case 名与参数名必须和 InstanceManager 的方法对上
//      —— 写错一个字符串（instance.chat.logs？p.keyword？）静态检查发现不了，
//      只有真的走一遍派发才知道。
//
// 全程同进程 listen 到本地临时端口，用 fetch 发请求（受限环境下 spawn 会 EPERM）。
//
// 运行：node agent/test-chat-api.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createApi } = require(path.join(__dirname, '..', 'panel', 'api.js'));
const { InstanceManager } = require(path.join(__dirname, 'src', 'instance', 'manager.js'));
const { Agent } = require(path.join(__dirname, 'src', 'agent.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

/** 记录面板转发给 Agent 的每一次调用 */
const calls = [];
let agentError = null;

const fakeHub = {
  on() {},
  request: async (_id, action, params) => {
    calls.push({ action, params });
    if (agentError) throw Object.assign(new Error(agentError), { code: 'AGENT_ERROR' });
    if (action === 'instance.players.stats') return { instance: 'demo', now: 1, players: [] };
    if (action === 'instance.chat.log') return { instance: 'demo', records: [], size: 0, more: false, nextBefore: 0 };
    if (action === 'instance.chat.clear') return { ok: true, removedBytes: 42 };
    return { ok: true };
  },
  status: () => 'online',
  isOnline: () => true,
  getLatency: () => 1,
  getOnlineSince: () => 1,
  conns: new Map(),
  stopOutbound() {},
  syncOutbound() {},
};
const fakeBus = { on() {}, emit() {} };

function makeConfig({ authEnabled }) {
  const data = {
    panel: { port: 0, username: 'admin', passwordHash: { salt: '', hash: '' }, authEnabled },
    servers: [
      {
        id: 'srv1',
        name: 's1',
        host: '10.0.0.9',
        token: 'SECRET-AGENT-TOKEN',
        ssh: { port: 22, user: 'root', auth: 'password' },
        agent: { mode: 'outbound', host: '', port: 3099 },
      },
    ],
    settings: {
      domain: '',
      adminEmail: '',
      smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
      notify: { offline: true, recovery: false },
      ai: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    },
  };
  return {
    data,
    save() {},
    verifyCredentials: () => false,
    listServers: () => data.servers,
    getServer: (id) => data.servers.find((s) => s.id === id) || null,
    updateServer: () => null,
  };
}

function makePanel(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApi(makeConfig({ authEnabled: !!opts.authEnabled }), fakeHub, fakeBus));
  app.use((err, req, res, _next) => res.status(500).json({ error: 'internal', detail: err.message }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${srv.address().port}/api`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const last = () => calls[calls.length - 1];
const reset = () => {
  calls.length = 0;
  agentError = null;
};

(async () => {
  const panel = await makePanel();

  // ---------- 1. 三个新路由转发到正确的 action ----------
  {
    reset();
    const st = await (await fetch(`${panel.base}/servers/srv1/instances/demo/players/stats`)).json();
    check('玩家统计：action = instance.players.stats 且带实例名',
      last().action === 'instance.players.stats' && last().params.name === 'demo', JSON.stringify(calls));
    check('玩家统计：原样返回 Agent 结果', st.instance === 'demo' && Array.isArray(st.players));

    reset();
    const chat = await (await fetch(`${panel.base}/servers/srv1/instances/demo/chat`)).json();
    check('聊天记录：action = instance.chat.log 且带实例名',
      last().action === 'instance.chat.log' && last().params.name === 'demo', JSON.stringify(calls));
    check('聊天记录：无参时给默认 limit', last().params.limit === 100, JSON.stringify(last().params));
    check('聊天记录：原样返回 Agent 结果', chat.instance === 'demo' && Array.isArray(chat.records));

    reset();
    const cleared = await (await fetch(`${panel.base}/servers/srv1/instances/demo/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).json();
    check('清空：action = instance.chat.clear', last().action === 'instance.chat.clear' && last().params.name === 'demo', JSON.stringify(calls));
    check('清空：返回被删除的字节数', cleared.ok === true && cleared.removedBytes === 42, JSON.stringify(cleared));
  }

  // ---------- 2. 参数规范化 ----------
  {
    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo/chat?limit=99999&player=${'p'.repeat(50)}&q=${'k'.repeat(200)}&before=123.9`);
    const p = last().params;
    check('limit 被夹到上限 300（防止一帧塞太多记录）', p.limit === 300, JSON.stringify(p));
    check('player 截断到 32 字符', p.player.length === 32, String(p.player.length));
    check('q 截断到 64 字符', p.q.length === 64, String(p.q.length));
    check('before 取整后下发', p.before === 123, String(p.before));

    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo/chat?limit=0&before=-5`);
    check('limit=0 回退默认值、负数游标被丢弃',
      last().params.limit === 100 && last().params.before === undefined, JSON.stringify(last().params));

    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo/chat?limit=abc&before=NaN`);
    check('非数字 limit / 非数字 before 都不下发',
      last().params.limit === 100 && last().params.before === undefined, JSON.stringify(last().params));

    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo/chat?q=${encodeURIComponent('a.*b|(c)')}`);
    check('关键词原样当纯文本下发（不在这里做任何正则解释）', last().params.q === 'a.*b|(c)', last().params.q);
  }

  // ---------- 3. 编辑实例的 tracking 透传 ----------
  {
    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'n', tracking: { chat: false } }),
    });
    check('PUT 实例：action = instance.edit 且透传 tracking',
      last().action === 'instance.edit' && JSON.stringify(last().params.tracking) === JSON.stringify({ chat: false }),
      JSON.stringify(last().params));

    reset();
    await fetch(`${panel.base}/servers/srv1/instances/demo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'n' }),
    });
    check('未传 tracking 时不下发该字段（Agent 侧据此不动原值）',
      last().params.tracking === undefined && 'tracking' in last().params === false,
      JSON.stringify(last().params));
  }

  // ---------- 4. Agent 报错如实透出（旧 Agent 未升级 → 未知操作） ----------
  {
    reset();
    agentError = '未知操作: instance.chat.log';
    const r = await fetch(`${panel.base}/servers/srv1/instances/demo/chat`);
    const j = await r.json();
    check('旧 Agent 不支持时返回错误而不是空数据（前端据此提示升级 Agent）',
      r.status >= 400 && JSON.stringify(j).includes('未知操作'), `${r.status} ${JSON.stringify(j)}`);
  }

  // ---------- 5. 鉴权边界：新路由必须在鉴权之后 ----------
  {
    const locked = await makePanel({ authEnabled: true });
    reset();
    const r1 = await fetch(`${locked.base}/servers/srv1/instances/demo/chat`);
    const j1 = await r1.json();
    check('开启登录保护后：未登录读聊天记录 → 401', r1.status === 401 && j1.code === 'auth.not-logged-in', `${r1.status} ${JSON.stringify(j1)}`);
    const r2 = await fetch(`${locked.base}/servers/srv1/instances/demo/players/stats`);
    check('开启登录保护后：未登录读玩家统计 → 401（不泄露玩家名）', r2.status === 401, String(r2.status));
    const r3 = await fetch(`${locked.base}/servers/srv1/instances/demo/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    check('开启登录保护后：未登录清空聊天记录 → 401（写接口同样受保护）', r3.status === 401, String(r3.status));
    check('被拦住的三次请求都没有真的转发给 Agent', calls.length === 0, JSON.stringify(calls));
    await locked.close();
  }

  // ---------- 6. Agent 侧派发：case 名与参数名必须真的对上 ----------
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-chatapi-'));
    const instancesDir = path.join(ROOT, 'instances');
    const dir = path.join(instancesDir, 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'blocknexus.json'),
      JSON.stringify({ name: 'demo', version: '1.20.1', port: 25565, memoryMB: 1024, source: 'vanilla', launch: { kind: 'jar', file: 'server.jar' } }),
    );
    fs.writeFileSync(path.join(dir, 'server.jar'), 'fake');

    const mgr = new InstanceManager(instancesDir);
    mgr._nowOverride = 1700000000000;
    // Agent 实例不连接面板也能用来派发（构造函数只接管事件出口）
    const ag = new Agent({ id: 'srv1', token: 'x', panel: 'ws://127.0.0.1:1' }, mgr);

    mgr.emitConsole(mgr.get('demo'), '[12:34:56] [Server thread/INFO]: <Steve> dispatched');
    mgr.emitConsole(mgr.get('demo'), '[12:34:56] [Server thread/INFO]: Steve joined the game');
    mgr.flushChat(mgr.get('demo'));

    const log = await ag.handleAction('instance.chat.log', { name: 'demo', limit: 5, q: 'DISPATCHED' });
    check('instance.chat.log 派发成功：能按关键词读到记录',
      log.records.length === 1 && log.records[0].m === 'dispatched' && log.records[0].n === 'Steve',
      JSON.stringify(log.records));

    const stats = await ag.handleAction('instance.players.stats', { name: 'demo' });
    check('instance.players.stats 派发成功：返回统计结构',
      stats.instance === 'demo' && Array.isArray(stats.players) && stats.players.some((p) => p.name === 'Steve' && p.online === true),
      JSON.stringify(stats));

    const edited = await ag.handleAction('instance.edit', { name: 'demo', tracking: { chat: false } });
    check('instance.edit 的 tracking 参数接到 Agent 的 edit（字段名一致）',
      edited.tracking && edited.tracking.chat === false && edited.tracking.players === true,
      JSON.stringify(edited));

    const cleared = await ag.handleAction('instance.chat.clear', { name: 'demo' });
    check('instance.chat.clear 派发成功', cleared.ok === true, JSON.stringify(cleared));

    let threw = false;
    try {
      await ag.handleAction('instance.chat.notexist', { name: 'demo' });
    } catch (e) {
      threw = /未知操作/.test(e.message);
    }
    check('未实现的 action 仍报「未知操作」（不会静默成功）', threw);

    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  // ---------- 7. 端到端：面板路由 → 真 Agent → 真存储 ----------
  // 前面 1~2 用假 hub 验参数，6 用真 Agent 验派发；这里把两者接起来，
  // 用「真 Agent 的 handleAction」当 hub 的 request（只差 WebSocket 这一跳，
  // 而那一跳是既有代码，事件广播也是既有通用路径）。
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-chate2e-'));
    const instancesDir = path.join(ROOT, 'instances');
    const dir = path.join(instancesDir, 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'blocknexus.json'),
      JSON.stringify({ name: 'demo', version: '1.20.1', port: 25565, memoryMB: 1024, source: 'vanilla', launch: { kind: 'jar', file: 'server.jar' } }),
    );
    fs.writeFileSync(path.join(dir, 'server.jar'), 'fake');

    const mgr = new InstanceManager(instancesDir);
    const ag = new Agent({ id: 'srv1', token: 'x', panel: 'ws://127.0.0.1:1' }, mgr);

    // 用 agent 自己的 logLine（面板往控制台写行的既有动作）喂进一条真实的聊天日志行
    await ag.handleAction('instance.logLine', {
      name: 'demo',
      text: '[12:34:56] [Server thread/INFO]: <E2E_Steve> end to end',
    });
    // 记录先进内存缓冲，由 1.5 秒的时间片落盘——这里真的等它到点，
    // 顺带验证「时间片会自动落盘」这条路径（不等的话读到的必然是空）
    await new Promise((r) => setTimeout(r, 1700));

    const e2eHub = {
      on() {},
      request: async (_id, action, params) => ag.handleAction(action, params),
      status: () => 'online',
      isOnline: () => true,
      getLatency: () => 1,
      getOnlineSince: () => 1,
      conns: new Map(),
      stopOutbound() {},
      syncOutbound() {},
    };
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', createApi(makeConfig({ authEnabled: false }), e2eHub, fakeBus, {}, {}));
    app.use((err, req, res, _next) => res.status(500).json({ error: 'internal', detail: err.message }));
    const srv = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${srv.address().port}/api`;

    const page = await (await fetch(`${base}/servers/srv1/instances/demo/chat?limit=10`)).json();
    check('端到端：面板读到 Agent 落盘的聊天记录',
      page.records.length === 1 && page.records[0].n === 'E2E_Steve' && page.records[0].m === 'end to end',
      JSON.stringify(page.records));

    const stats = await (await fetch(`${base}/servers/srv1/instances/demo/players/stats`)).json();
    check('端到端：玩家统计接口可用（结构完整、含 trackedSince）',
      Array.isArray(stats.players) && typeof stats.trackedSince === 'number' && typeof stats.now === 'number',
      JSON.stringify(stats));

    const clearRes = await fetch(`${base}/servers/srv1/instances/demo/chat/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const cleared = await clearRes.json();
    const after = await (await fetch(`${base}/servers/srv1/instances/demo/chat`)).json();
    check('端到端：清空接口真的清掉了记录（且返回删除字节数）',
      cleared.ok === true && cleared.removedBytes > 0 && after.records.length === 0 && after.size === 0,
      JSON.stringify({ cleared, after }));

    await new Promise((r) => srv.close(r));
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  await panel.close();
  // 等一拍再退出：Windows 上 srv.close() 的回调与进程退出竞争会触发 libuv 的
  // UV_HANDLE_CLOSING 断言（退出码 1，看起来像测试失败其实全绿）
  await new Promise((r) => setTimeout(r, 50));
  console.log(`\n${pass}/${total} chat-api cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
