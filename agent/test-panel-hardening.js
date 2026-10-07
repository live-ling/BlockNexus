'use strict';
// 安全审计加固项回归测试（对应 docs/shenji 报告中的两条 P0 修复）
//
//   #5 app 级错误兜底：畸形/超大 body 不得回显堆栈（原先落到 Express 默认处理器，
//      非 production 下把 SyntaxError 堆栈 + 安装绝对路径回给未认证调用方）
//   #1 限流表数量上限：forgotSent / verifyFails 原先只有时间 GC、没有数量上限，
//      唯一键洪水可在存活窗口内把内存打爆
//
// 全程同进程 listen 到本地临时端口，用 fetch 发请求（不用 child_process：受限环境会 EPERM）。
//
// 运行：node agent/test-panel-hardening.js

const path = require('path');
const express = require('express');
const { createApi, __setTestHook } = require(path.join(__dirname, '..', 'panel', 'api.js'));
const { requestErrorHandler } = require(path.join(__dirname, '..', 'panel', 'http-errors.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const fakeHub = { on() {}, request: async () => ({}), status: () => 'offline' };
const fakeBus = { on() {}, emit() {} };

function makeConfig() {
  const data = {
    panel: { port: 0, username: 'admin', passwordHash: { salt: '', hash: '' }, authEnabled: false },
    servers: [],
    settings: {
      domain: '',
      adminEmail: 'admin@example.com',
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
    getServer: () => null,
    updateServer: () => null,
  };
}

/**
 * 复刻 panel/server.js 的中间件顺序——顺序本身就是要测的东西：
 * app 级 body parser 在 router **之前**，其错误不会进入 router 内部错误处理器。
 */
function makePanel({ limiterOpts = {}, withErrorHandler = true, trustProxy = undefined } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // 需要「大量不同来源 IP」的用例必须开 trust proxy，否则 req.ip 恒为 127.0.0.1，
  // 每张表只会有一条记录——上限永远触发不到，断言就成了**空转通过**。
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '1mb' })); // ← 与 server.js:76 一致（app 级、router 之前）

  let internal = null;
  __setTestHook((i) => {
    internal = i;
  });
  const router = express.Router();
  router.post('/echo', (req, res) => res.json({ ok: true }));
  router.use(createApi(makeConfig(), fakeHub, fakeBus, limiterOpts, {}));
  app.use('/api', router);

  // ← 与 server.js 一致：SPA 回退（非错误处理器）
  app.use((req, res, next) => next());

  if (withErrorHandler) app.use(requestErrorHandler);

  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        base: `http://127.0.0.1:${srv.address().port}`,
        get internal() {
          return internal;
        },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** 故意不做 JSON.stringify：本文件要能发**原始文本**（含畸形 JSON）来测错误兜底 */
function rawPost(base, p, body, headers = {}) {
  return fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

/** 正常请求：对象自动序列化 */
function jsonPost(base, p, body, headers = {}) {
  return rawPost(base, p, JSON.stringify(body), headers);
}

(async () => {
  // ================= #5 app 级错误兜底 =================
  {
    const panel = await makePanel();
    try {
      // --- 畸形 JSON ---
      const r = await rawPost(panel.base, '/api/echo', '{bad');
      const text = await r.text();
      const ct = r.headers.get('content-type') || '';

      check('畸形 JSON body → HTTP 400', r.status === 400, `实际 ${r.status}`);
      check('畸形 JSON body → 响应是 JSON（不是 Express 默认的 text/html 堆栈页）', /application\/json/.test(ct), `Content-Type=${ct}`);

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {}
      check('畸形 JSON body → 响应体可解析', !!parsed, text.slice(0, 120));
      check(
        '畸形 JSON body → 返回稳定错误码 request.body-invalid',
        parsed && parsed.code === 'request.body-invalid',
        JSON.stringify(parsed),
      );
      check(
        '畸形 JSON body → 不回显堆栈（无 SyntaxError / 无绝对路径 / 无 node_modules）',
        !/SyntaxError|node_modules|[A-Za-z]:\\\\|at\s+.*\(.*:\d+:\d+\)/.test(text),
        text.slice(0, 200),
      );

      // --- 超过 1mb ---
      const big = await rawPost(panel.base, '/api/echo', 'x'.repeat(2 * 1024 * 1024));
      const bigText = await big.text();
      let bigParsed = null;
      try {
        bigParsed = JSON.parse(bigText);
      } catch {}
      check('超大 body → HTTP 413', big.status === 413, `实际 ${big.status}`);
      check(
        '超大 body → 返回 request.body-too-large',
        bigParsed && bigParsed.code === 'request.body-too-large',
        bigText.slice(0, 120),
      );
      check('超大 body → 不回显堆栈', !/PayloadTooLarge|node_modules/i.test(bigText), bigText.slice(0, 160));

      // --- 语言跟随 Accept-Language ---
      const zh = await rawPost(panel.base, '/api/echo', '{bad', { 'Accept-Language': 'zh-CN,zh;q=0.9' });
      const en = await rawPost(panel.base, '/api/echo', '{bad', { 'Accept-Language': 'en-US,en;q=0.9' });
      const zhBody = await zh.json();
      const enBody = await en.json();
      check(
        '文案跟随 Accept-Language（zh ≠ en，且同 code）',
        zhBody.code === enBody.code && zhBody.error !== enBody.error,
        `zh=${JSON.stringify(zhBody.error)} en=${JSON.stringify(enBody.error)}`,
      );

      // --- 对照组：没有该中间件时确实会泄露（证明这条修复不是多余的） ---
      const bare = await makePanel({ withErrorHandler: false });
      try {
        // 对照组会走 Express 默认处理器，它把整段堆栈打到 stderr。
        // 这是**预期现象**（正是我们要证明的漏洞），临时静音以免污染 CI 日志。
        const origError = console.error;
        console.error = () => {};
        let b;
        let bText = '';
        let bCt = '';
        try {
          b = await rawPost(bare.base, '/api/echo', '{bad');
          bText = await b.text();
          bCt = b.headers.get('content-type') || '';
        } finally {
          console.error = origError;
        }
        check(
          '对照组：不挂该中间件时确实回显 text/html 堆栈（说明修复有实际作用）',
          b && /text\/html/.test(bCt) && /SyntaxError/.test(bText),
          `Content-Type=${bCt} body=${bText.slice(0, 80)}`,
        );
      } finally {
        await bare.close();
      }
    } finally {
      await panel.close();
    }
  }

  // ================= #1 限流表数量上限 =================
  {
    const MAX = 20; // 用小上限以便快速触发
    // trustProxy=true：让每个请求带不同的 X-Forwarded-For，从而产生**大量不同来源 IP**。
    // 不开它的话 req.ip 恒为 127.0.0.1，表里只有一条，上限根本触发不到。
    const panel = await makePanel({ limiterOpts: { maxTracked: MAX }, trustProxy: true });
    try {
      const internal = panel.internal;
      check('测试钩子已暴露 forgotSent / verifyFails', !!(internal && internal.forgotSent && internal.verifyFails));
      check(
        '测试钩子上限与注入值一致',
        internal && internal.limits.LIMITER_MAX_TRACKED === MAX,
        internal && JSON.stringify(internal.limits),
      );

      const ipReq = (p, body, i) =>
        jsonPost(panel.base, p, body, { 'X-Forwarded-For': `10.9.${Math.floor(i / 250)}.${i % 250}` });

      const N = MAX * 3;
      for (let i = 0; i < N; i++) {
        await ipReq('/api/forgot-password', { email: 'nobody@example.com' }, i);
      }
      // 断言 size === MAX 而不是 <= MAX：
      // 后者在「请求根本没打进去（路径错/被拒）」时也会通过（表是空的），属于空转通过。
      // 前者同时证明了「确实写进去了」且「上限确实拦住了」。
      check(
        `forgotSent 恰好被上限截在 ${MAX}（同时证明确实写入了）`,
        internal.forgotSent.size === MAX,
        `实际 ${internal.forgotSent.size}（${N} 个不同来源）`,
      );

      for (let i = 0; i < N; i++) {
        await ipReq('/api/verify-reset-code', { email: 'nobody@example.com', code: '000000' }, 10000 + i);
      }
      check(
        `verifyFails 恰好被上限截在 ${MAX}（同时证明确实写入了）`,
        internal.verifyFails.size === MAX,
        `实际 ${internal.verifyFails.size}（${N} 个不同来源）`,
      );
    } finally {
      await panel.close();
    }
  }

  // ================= H6 出站响应体上限 =================
  // 这些响应来自用户可配置的地址（AI baseUrl / 核心下载 / 更新检查），属不可信输入。
  // 原先各处都是无上限的 chunks.push，一个超大响应就能把面板堆打爆（目标 240MB）。
  {
    const http = require('http');
    const { readBodyCapped, MAX_REMOTE_BODY } = require(path.join(__dirname, '..', 'panel', 'api.js'));

    // 造一个「只发数据不结束」的端点：模拟恶意/异常服务端持续推送
    const srv = http.createServer((req, res) => {
      if (req.url === '/huge') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          if (res.writableEnded) return;
          // 一直发到远超上限（上限 2MB → 发到 12MB 足够）
          if (sent > 12 * 1024 * 1024) {
            res.end();
            return;
          }
          sent += chunk.length;
          if (res.write(chunk)) setImmediate(pump);
          else res.once('drain', pump);
        };
        pump();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok-small');
    });

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const fetchCapped = (p) =>
      new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
          readBodyCapped(res, req, MAX_REMOTE_BODY, '测试响应').then(resolve, reject);
        });
        req.on('error', reject);
      });

    try {
      const small = await fetchCapped('/small');
      check(
        '上限之内正常返回完整内容',
        small.toString('utf8') === 'ok-small',
        JSON.stringify(small.toString('utf8')),
      );

      let bigErr = null;
      try {
        await fetchCapped('/huge');
      } catch (e) {
        bigErr = e;
      }
      check('超过上限时 reject（而不是把整个 body 读进内存）', !!bigErr, String(bigErr));
      check(
        '超限错误信息说明是「过大」且不含响应内容',
        !!bigErr && /过大/.test(bigErr.message) && !/aaaa/.test(bigErr.message),
        bigErr && bigErr.message,
      );
    } finally {
      await new Promise((r) => srv.close(r));
    }
  }

  console.log(`\n${pass}/${total} panel-hardening cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
