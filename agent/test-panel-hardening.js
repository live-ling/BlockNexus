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

// 覆盖面按 panel/api.js 里实际用到的 hub.* 补齐：
// 之前只有 on/request/status，所以任何走到 /servers/:id 的用例都会 500
// （真实原因被包装成 internal.error，容易误判成业务 bug）。
const fakeHub = {
  on() {},
  request: async () => ({}),
  status: () => 'offline',
  isOnline: () => false,
  getLatency: () => null,
  getOnlineSince: () => null,
  conns: new Map(),
  stopOutbound() {},
  syncOutbound() {},
};
const fakeBus = { on() {}, emit() {} };

function makeConfig() {
  const data = {
    panel: { port: 0, username: 'admin', passwordHash: { salt: '', hash: '' }, authEnabled: false },
    // 放一台 server：用于验证「回凭据的响应必须禁缓存」
    servers: [{ id: 'srv1', name: 's1', host: '10.0.0.9', token: 'SECRET-AGENT-TOKEN', ssh: { port: 22, user: 'root', auth: 'password' }, agent: { mode: 'outbound', host: '', port: 3099 } }],
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
    getServer: (id) => data.servers.find((s) => s.id === id) || null,
    updateServer: () => null,
  };
}

/**
 * 复刻 panel/server.js 的中间件顺序——顺序本身就是要测的东西：
 * app 级 body parser 在 router **之前**，其错误不会进入 router 内部错误处理器。
 */
function makePanel({ limiterOpts = {}, withErrorHandler = true, trustProxy = undefined, apiOpts = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // 需要「大量不同来源 IP」的用例必须开 trust proxy，否则 req.ip 恒为 127.0.0.1，
  // 每张表只会有一条记录——上限永远触发不到，断言就成了**空转通过**。
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  // 复刻 server.js 的顺序：**安全头在 express.json 之前**。
  // 顺序是要点：body parser 抛错会跳过它之后的所有普通中间件直奔错误处理器，
  // 放后面的话畸形请求的响应会丢掉这些头。
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '1mb' })); // ← 与 server.js:76 一致（app 级、router 之前）

  let internal = null;
  __setTestHook((i) => {
    internal = i;
  });
  const router = express.Router();
  router.post('/echo', (req, res) => res.json({ ok: true }));
  router.use(createApi(makeConfig(), fakeHub, fakeBus, limiterOpts, apiOpts));
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

  // ================= H3 AI baseUrl 的 SSRF 地址守卫 =================
  {
    const { assertRemoteTargetAllowed } = require(path.join(__dirname, '..', 'panel', 'api.js'));
    const allow = (url) => {
      try {
        assertRemoteTargetAllowed(new URL(url));
        return true;
      } catch {
        return false;
      }
    };

    // 必须拒绝：链路本地 / 云元数据（SSRF 最典型的变现目标，无正当用途）
    check('拒绝 IPv4 云元数据 169.254.169.254', !allow('http://169.254.169.254/latest/meta-data/'));
    check('拒绝 IPv6 链路本地 fe80::1', !allow('http://[fe80::1]/x'));
    check('拒绝 AWS IPv6 元数据 fd00:ec2::254', !allow('http://[fd00:ec2::254]/x'));
    check('拒绝元数据主机名 metadata.google.internal', !allow('http://metadata.google.internal/x'));

    // 必须放行：这些是**正当用法**，一刀切挡掉会废掉产品能力
    // ⚠ 回环尤其重要——本地面板最常见的 AI 配置就是本机 Ollama（127.0.0.1:11434）
    check('放行回环（本机 Ollama / LM Studio）', allow('http://127.0.0.1:11434/v1'));
    check('放行局域网推理机', allow('http://192.168.1.50:8000/v1'));
    check('放行公网 API', allow('https://api.deepseek.com'));
  }

  // ================= H4 SSH 主机密钥 TOFU =================
  // 不做主机密钥校验的后果：能做中间人的人即可拿到 SSH 凭据并完全接管服务器。
  // 采 TOFU 而非强制人工核对：本项目是单人使用，用户手上通常没有服务器指纹。
  {
    const ssh = require(path.join(__dirname, '..', 'panel', 'ssh.js'));
    const keyA = Buffer.from('ssh-rsa AAAA-first-host-key');
    const keyB = Buffer.from('ssh-rsa AAAA-different-host-key');

    const fpA = ssh.hostKeyFingerprint(keyA);
    check('指纹是 OpenSSH 风格 SHA256:', /^SHA256:[A-Za-z0-9+/]+$/.test(fpA), fpA);
    check('同一密钥指纹稳定', ssh.hostKeyFingerprint(keyA) === fpA);
    check('不同密钥指纹不同', ssh.hostKeyFingerprint(keyB) !== fpA);

    // 首次：记录并放行
    const fresh = { ssh: {} };
    const r1 = ssh.verifyHostKey(fresh, keyA);
    check('首次连接：放行且标记为「需记录」', r1.ok === true && r1.recorded === true, JSON.stringify(r1));

    // 之后一致：放行且不再记录
    const same = { ssh: { hostKeyFingerprint: fpA } };
    const r2 = ssh.verifyHostKey(same, keyA);
    check('指纹一致：放行且不重复记录', r2.ok === true && r2.recorded === false, JSON.stringify(r2));

    // 不一致：拒绝，且错误里能同时看到两个指纹（便于用户判断是换机还是被劫持）
    const changed = { ssh: { hostKeyFingerprint: fpA } };
    const r3 = ssh.verifyHostKey(changed, keyB);
    check('指纹不一致：拒绝连接', r3.ok === false, JSON.stringify(r3));
    check(
      '拒绝时错误信息含「记录/本次」两个指纹与中间人提示',
      !!r3.error && r3.error.includes(fpA) && r3.error.includes(ssh.hostKeyFingerprint(keyB)) && /中间人/.test(r3.error),
      r3.error,
    );
  }

  // ================= H5「对外可达 + 免密」告警信号 =================
  // 只做**告警**不改默认行为：默认免密对「只听本机」的单用户场景是正当设计，
  // 危险的是「对外可达 + 免密」这个组合。前端据 /api/me 显示持久横幅。
  {
    // 测试用 config 的 authEnabled 恒为 false，所以 exposedWithoutAuth 直接跟随 mayBeExposed
    const exposedPanel = await makePanel({ apiOpts: { mayBeExposed: true } });
    try {
      const me = await (await fetch(`${exposedPanel.base}/api/me`)).json();
      check(
        '对外可达 + 免密 → /api/me 带 exposedWithoutAuth=true',
        me.exposedWithoutAuth === true,
        JSON.stringify(me),
      );
    } finally {
      await exposedPanel.close();
    }

    const localPanel = await makePanel({ apiOpts: { mayBeExposed: false } });
    try {
      const me = await (await fetch(`${localPanel.base}/api/me`)).json();
      check(
        '仅本机监听 → 不报警（避免误报刷屏）',
        me.exposedWithoutAuth === false,
        JSON.stringify(me),
      );
    } finally {
      await localPanel.close();
    }
  }

  // ================= 回凭据的响应必须禁缓存 =================
  // Agent token 等价于该服务器的登录凭据。它出现在**响应体**里（URL 上的 ?token=1
  // 只是个开关、不含秘密），所以真正的泄露面是「响应被浏览器/中间代理缓存下来」。
  {
    const panel = await makePanel();
    try {
      const withToken = await fetch(`${panel.base}/api/servers/srv1?token=1`);
      const bodyToken = await withToken.json();
      check(
        '?token=1 才返回 token（默认不返回）',
        bodyToken.token === 'SECRET-AGENT-TOKEN',
        JSON.stringify(bodyToken.token),
      );
      check(
        '回 token 的响应带 Cache-Control: no-store',
        /no-store/.test(withToken.headers.get('cache-control') || ''),
        `Cache-Control=${withToken.headers.get('cache-control')}`,
      );

      const plain = await fetch(`${panel.base}/api/servers/srv1`);
      const bodyPlain = await plain.json();
      check('不带 ?token=1 时不回 token', bodyPlain.token === undefined, JSON.stringify(bodyPlain.token));
    } finally {
      await panel.close();
    }
  }

  // ================= 基础安全响应头 =================
  {
    const panel = await makePanel();
    try {
      const ok = await fetch(`${panel.base}/api/me`);
      check('正常响应带 X-Frame-Options: DENY', ok.headers.get('x-frame-options') === 'DENY');
      check('正常响应带 X-Content-Type-Options: nosniff', ok.headers.get('x-content-type-options') === 'nosniff');
      check('正常响应带 Referrer-Policy: no-referrer', ok.headers.get('referrer-policy') === 'no-referrer');

      // 这条才是关键：错误响应也必须带上。
      // body parser 抛错会跳过其后注册的普通中间件，所以头中间件必须放在它**之前**——
      // 放后面时这里会拿到 null（我第一版就是放错了，靠这条断言才发现）。
      const bad = await rawPost(panel.base, '/api/echo', '{bad');
      check('HTTP 400', bad.status === 400, `实际 ${bad.status}`);
      check(
        '**错误响应**也带安全头（证明中间件顺序正确）',
        bad.headers.get('x-frame-options') === 'DENY',
        `X-Frame-Options=${bad.headers.get('x-frame-options')}`,
      );
    } finally {
      await panel.close();
    }
  }

  // ================= 邮件模板的 HTML 注入防护 =================
  // mail.js 里 kv 的值、页脚、品牌名都走了 esc()，唯独 p() 漏了。
  // 当时所有调用方传的都是静态文案，所以没有可注入点；但下一个把
  // 服务器名/玩家名塞进正文的调用方就会直接得到注入——而邮件是在邮件客户端里渲染的。
  // 现已让 p() 默认转义，内嵌标记必须显式用 pHtml()。
  {
    const mail = require(path.join(__dirname, '..', 'panel', 'mail.js'));
    const hostile = '服<script>alert(1)</script>';

    const off = mail.offlineMail({ name: hostile, host: '1.2.3.4' });
    check('恶意服务器名在 HTML 里被转义', !String(off.html).includes('<script>alert(1)'), '出现了原始 <script>');
    check('转义后留下实体（确实处理过而不是被丢掉）', String(off.html).includes('&lt;script&gt;'));
    check('纯文本部分保留原文（纯文本不需要转义）', String(off.text).includes(hostile));

    // 反向断言：有意内嵌的标记不能被「顺手转义」掉，否则验证码邮件会少格式
    const rc = mail.resetCodeMail({ code: '123456', minutes: 15 });
    check('有意内嵌的 <strong> 保留（pHtml 生效，未过度转义）', /<strong>15 分钟<\/strong>/.test(rc.html));
    check('且没有被双重转义', !/&lt;strong&gt;/.test(rc.html));
  }

  console.log(`\n${pass}/${total} panel-hardening cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
