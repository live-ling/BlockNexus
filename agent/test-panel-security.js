'use strict';
// P0 安全项回归测试：trust proxy / Secure Cookie / loginFails GC 与上限 / CSRF 写方法覆盖
//
// 全程在同进程内起 express 并 listen 到本地临时端口，用 fetch 发请求。
// ⚠ 刻意不使用 child_process：受限环境下 spawn 会 EPERM，
//    而同进程足以覆盖全部用例（也更快）。
//
// 运行：node agent/test-panel-security.js

const path = require('path');
const express = require('express');
const { parseTrustProxy } = require(path.join(__dirname, '..', 'panel', 'net.js'));
const { createApi, __setTestHook } = require(path.join(__dirname, '..', 'panel', 'api.js'));

const ROOT = path.join(__dirname, '..');
const results = [];
function check(desc, ok, detail) {
  results.push({ desc, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '  → ' + detail : ''}`);
}

// ---------- 测试用假 config：内存态，绝不落盘 ----------
function makeConfig() {
  const data = {
    panel: {
      port: 0,
      username: 'admin',
      passwordHash: { salt: 'ab'.repeat(16), hash: 'cd'.repeat(32) },
      authEnabled: true,
    },
    servers: [],
    settings: {
      domain: '', adminEmail: '',
      smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
      notify: { offline: true, recovery: false },
      ai: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    },
  };
  return {
    data,
    save() {},
    verifyCredentials(u, p) { return u === 'admin' && p === 'correct-password'; },
    listServers() { return data.servers; },
    getServer() { return null; },
    updateServer() { return null; },
  };
}

const fakeHub = { on() {}, request: async () => ({}), status: () => 'offline' };
const fakeBus = { on() {}, emit() {} };

/** 起一个隔离面板；返回 {base, internal, close} */
function makePanel({ trustProxy, limiterOpts = {}, apiOpts = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '1mb' }));

  let internal = null;
  __setTestHook((i) => { internal = i; });
  app.use('/api', createApi(makeConfig(), fakeHub, fakeBus, limiterOpts, apiOpts));

  app.use((err, req, res, _next) => res.status(500).json({ error: 'internal', detail: err.message }));

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${srv.address().port}/api`;
      resolve({
        base,
        get internal() { return internal; },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const post = (base, p, body, headers = {}) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

// 用不同的 X-Forwarded-For 打 5 次错误登录，返回最后一次的状态码
async function failLogin5(base, ip) {
  let last = 0;
  for (let i = 0; i < 5; i++) {
    const r = await post(base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': ip });
    last = r.status;
  }
  return last;
}

/** 读一次错误响应的 { status, code, error }，用于同时断言状态码与错误代码 */
async function errorOf(base, path, body, headers = {}) {
  const r = await post(base, path, body, headers);
  let j = {};
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, code: j.code, error: j.error };
}

async function main() {
  // ================= A. parseTrustProxy 取值解析 =================
  check('parseTrustProxy: 空值 → 不信任', parseTrustProxy('') === null && parseTrustProxy(null) === null && parseTrustProxy(undefined) === null);
  check('parseTrustProxy: 跳数 1/2 → 数字', parseTrustProxy('1') === 1 && parseTrustProxy('2') === 2);
  check('parseTrustProxy: 0 → 视为未配置', parseTrustProxy('0') === null);
  check('parseTrustProxy: loopback 预设', parseTrustProxy('loopback') === 'loopback');
  check('parseTrustProxy: 不认识的值 → 不信任（宁可不信任）',
    parseTrustProxy('garbage') === null && parseTrustProxy('*') === null && parseTrustProxy('true') === null);
  check('parseTrustProxy: 允许前后空格', parseTrustProxy('  1  ') === 1);

  // ================= B. trust proxy 不影响默认行为（未配置时） =================
  {
    const p = await makePanel({ limiterOpts: { lockMs: 60e3 } });
    // 未设 trust proxy：X-Forwarded-For 被忽略，两个不同 XFF 共用同一个桶（直连 IP）
    await failLogin5(p.base, '1.1.1.1');
    const r = await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '2.2.2.2' });
    check('未配 trust proxy：伪造 XFF 不会换桶（仍被同一 IP 锁定）', r.status === 429, `got ${r.status}`);
    await p.close();
  }

  // ================= C. trust proxy=1 时按真实客户端分桶 =================
  {
    const p = await makePanel({ trustProxy: 1, limiterOpts: { lockMs: 60e3 } });
    await failLogin5(p.base, '1.1.1.1'); // A 被锁
    const rA = await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '1.1.1.1' });
    const rB = await post(p.base, '/login', { username: 'admin', password: 'correct-password' }, { 'X-Forwarded-For': '2.2.2.2' });
    check('trust proxy=1：A 被锁不影响 B（限流不再退化为全局锁）', rA.status === 429 && rB.status === 200,
      `A=${rA.status} B=${rB.status}`);
    await p.close();
  }

  // ================= D. 跳数语义：攻击者预塞伪造 XFF 无效 =================
  {
    const p = await makePanel({ trustProxy: 1, limiterOpts: { lockMs: 60e3 } });
    // 攻击者把自己伪造在最左侧；express 取右数第 1 跳的下一位，因此真实用的是最右侧那个
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '9.9.9.9, 3.3.3.3' });
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '8.8.8.8, 3.3.3.3' });
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '7.7.7.7, 3.3.3.3' });
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '6.6.6.6, 3.3.3.3' });
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '5.5.5.5, 3.3.3.3' });
    // 换掉最左伪造值但保持最右相同 → 应已累计 5 次失败而锁定
    const r = await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '4.4.4.4, 3.3.3.3' });
    check('trust proxy=1：左侧伪造值无效，按最右跳分桶', r.status === 429, `got ${r.status}`);
    await p.close();
  }

  // ================= E. loginFails 容量上限 =================
  {
    const p = await makePanel({ trustProxy: 1, limiterOpts: { maxTracked: 3, lockMs: 60e3 } });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5']) {
      await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': ip });
    }
    const size = p.internal.loginFails.size;
    check('loginFails 不超过上限（防无界增长）', size <= 3, `size=${size}`);
    check('loginFails 上限生效：最早记录被淘汰',
      !p.internal.loginFails.has('10.0.0.1') && p.internal.loginFails.has('10.0.0.5'),
      `keys=${[...p.internal.loginFails.keys()].join(',')}`);
    await p.close();
  }

  // ================= F. loginFails GC =================
  {
    const p = await makePanel({ trustProxy: 1, limiterOpts: { lockMs: 50 } }); // 极短锁定窗口
    await post(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '20.0.0.1' });
    const before = p.internal.loginFails.size;
    await new Promise((r) => setTimeout(r, 90)); // 越过锁定窗口
    p.internal.pruneLoginFails(Date.now());
    const after = p.internal.loginFails.size;
    check('loginFails 已纳入 GC：过期记录被清理', before === 1 && after === 0, `before=${before} after=${after}`);
    await p.close();
  }

  // ================= G. 正常登录仍可用（限流未误伤） =================
  {
    const p = await makePanel();
    const r = await post(p.base, '/login', { username: 'admin', password: 'correct-password' });
    const sc = r.headers.get('set-cookie') || '';
    check('正确凭据可登录', r.status === 200, `got ${r.status}`);
    check('默认（无 TLS、无参数）：Cookie 不带 Secure', sc && !/;\s*Secure/i.test(sc), sc);
    check('Cookie 仍带 HttpOnly 与 SameSite=Lax', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), sc);
    await p.close();
  }

  // ================= H. --secure-cookies 时带 Secure =================
  {
    const p = await makePanel({ apiOpts: { secureCookies: true } });
    const r = await post(p.base, '/login', { username: 'admin', password: 'correct-password' });
    const sc = r.headers.get('set-cookie') || '';
    check('secureCookies=true：Cookie 带 Secure', /;\s*Secure/i.test(sc), sc);
    await p.close();
  }

  // ================= I. CSRF：无 body 的写请求必须放行（关键回归） =================
  {
    const p = await makePanel();
    // 删除服务器就是这种形态：DELETE 且无 body → 前端不设 Content-Type
    const r = await fetch(`${p.base}/servers/nope`, { method: 'DELETE' });
    check('无 body 的 DELETE 不被 415（否则「删除服务器」会坏）', r.status !== 415, `got ${r.status}`);
    await p.close();
  }

  // ================= J. CSRF：带 JSON body 的写请求放行 =================
  {
    const p = await makePanel();
    const rPut = await fetch(`${p.base}/servers/nope`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const rDel = await fetch(`${p.base}/servers/nope`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{"force":true}',
    });
    check('带 JSON body 的 PUT 不被 415', rPut.status !== 415, `got ${rPut.status}`);
    check('带 JSON body 的 DELETE 不被 415', rDel.status !== 415, `got ${rDel.status}`);
    await p.close();
  }

  // ================= K. CSRF：非安全 Content-Type 被拦 =================
  {
    const p = await makePanel();
    const r = await fetch(`${p.base}/servers/nope`, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    const r2 = await fetch(`${p.base}/servers/nope`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x',
    });
    check('text/plain 的 PUT 被 415（CSRF 纵深防御）', r.status === 415, `got ${r.status}`);
    check('text/plain 的 POST 仍被 415（原行为不变）', r2.status === 415, `got ${r2.status}`);
    await p.close();
  }

  // ================= L. CSRF：SFTP 二进制直传豁免 =================
  {
    const p = await makePanel();
    const r = await fetch(`${p.base}/servers/s1/instances/a/files/upload/sftp`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x',
    });
    check('SFTP octet-stream 直传仍豁免（不被 415）', r.status !== 415, `got ${r.status}`);
    await p.close();
  }

  // ================= M. GET 不受 CSRF 检查影响 =================
  {
    const p = await makePanel();
    const r = await fetch(`${p.base}/me`);
    check('GET 不受 CSRF 检查影响', r.status === 200, `got ${r.status}`);
    await p.close();
  }

  // ================= N. 错误响应契约：code + error 并存 =================
  {
    const p = await makePanel({ trustProxy: 1, limiterOpts: { lockMs: 60e3 } });
    // 单次凭据错误 → auth.bad-credentials（前 3 次不提示剩余次数）
    const e1 = await errorOf(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': '30.0.0.1' });
    check('错误响应含 code 字段（前端据此本地化）', e1.code === 'auth.bad-credentials', JSON.stringify(e1));
    check('错误响应同时保留 error 文案（过渡期兼容旧调用方）',
      typeof e1.error === 'string' && e1.error.length > 0, JSON.stringify(e1));

    // 同一来源连打 5 次：第 4 次才提示剩余次数，第 5 次锁定
    const ips = '30.0.0.2';
    const seq = [];
    for (let i = 0; i < 5; i++) {
      seq.push(await errorOf(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': ips }));
    }
    check('第 4 次失败提示剩余次数', seq[3].code === 'auth.bad-credentials-with-left', JSON.stringify(seq[3]));
    check('第 5 次失败返回 auth.login-locked', seq[4].code === 'auth.login-locked', JSON.stringify(seq[4]));
    check('锁定文案里的分钟数取自 LOGIN_LOCK_MS（非硬编码）',
      seq[4].error.includes('1 分钟'), seq[4].error);

    // 已锁定状态下再请求 → auth.too-many-attempts
    const e6 = await errorOf(p.base, '/login', { username: 'admin', password: 'wrong' }, { 'X-Forwarded-For': ips });
    check('锁定期间返回 auth.too-many-attempts', e6.code === 'auth.too-many-attempts', JSON.stringify(e6));
    await p.close();
  }

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} panel-security cases passed`);
  if (pass !== results.length) {
    console.log('失败项：');
    for (const r of results) if (!r.ok) console.log(`  · ${r.desc}${r.detail ? ' → ' + r.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
