'use strict';
// BlockNexus 面板入口：node panel/server.js → http://127.0.0.1:3080
// 架构参考 DeepSeek Harness：本地 Node 运行时内嵌 HTTP 服务器，浏览器打开即用。

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Config } = require('./config');
const { AgentHub } = require('./agentlink');
const { createApi } = require('./api');
const { parseTrustProxy } = require('./net');
const { requestErrorHandler } = require('./http-errors');

// ---------- 启动参数（命令行优先，其次环境变量）----------
function argOf(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

// 面板默认只监听本机（本地服务）；需要远程访问时显式 --host 0.0.0.0
const HOST = argOf('host') || process.env.BLOCKNEXUS_HOST || '127.0.0.1';
const PORT = Number(argOf('port') || process.env.BLOCKNEXUS_PORT) || 3080;
const TLS_CERT = argOf('tls-cert') || process.env.BLOCKNEXUS_TLS_CERT || null;
const TLS_KEY = argOf('tls-key') || process.env.BLOCKNEXUS_TLS_KEY || null;

// ---------- 反向代理信任（决定 req.ip，从而决定所有限流按谁分桶）----------
// 面板放在反向代理后面时，req.ip 会恒为代理地址（通常是 127.0.0.1），于是
// 登录/找回密码的 IP 限流退化成「全局限流」：任一攻击者失败几次就能把所有人锁在门外。
// 这里显式声明「我前面有几层可信代理」，让 express 从 X-Forwarded-For 右往左取真实客户端。
//
// 默认关闭 = 默认安全：不配就完全不信任转发头。
// ⚠ 面板若直连公网，绝不能开——否则攻击者可伪造 X-Forwarded-For 绕过限流。
//
// 取值：
//   '1' / '2' …        可信代理层数（推荐）。X-Forwarded-For 是每层代理逐跳追加的，
//                      express 取「从右往左第 N+1 个」，因此攻击者预塞伪造值无效。
//   'loopback'         仅信任本机回环代理（express 预设，等价于信任 127.0.0.1/::1）
//   'linklocal' / 'uniquelocal'   其余 express 预设
// 取值解析见 panel/net.js（单独成模块以便单测）
const TRUST_PROXY = parseTrustProxy(argOf('trust-proxy') || process.env.BLOCKNEXUS_TRUST_PROXY);

// ---------- 会话 Cookie 的 Secure 标志 ----------
// 面板自身走 HTTPS 时自动带上；放在反向代理后面（面板本身是 HTTP）时，用 --secure-cookies 显式开启。
// ⚠ 仅在确实通过 HTTPS 访问时开启：纯 HTTP 下浏览器会拒绝保存带 Secure 的 Cookie，表现为「登录成功但立刻掉线」。
const SECURE_COOKIE = argOf('secure-cookies') !== null || process.env.BLOCKNEXUS_SECURE_COOKIES === '1';

/** 监听地址是否仅限本机（回环 / localhost）。0.0.0.0 与具体 IP、主机名都算「对外」 */
function isLoopbackHost(h) {
  const s = String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return s === '127.0.0.1' || s === 'localhost' || s === '::1' || s === '0:0:0:0:0:0:0:1';
}

// 面板自身是否以 HTTPS 对外（自签或正式证书）。
// 提前判定：下面注册 /api 时要把「是否 https」告诉 createApi，由它决定会话 Cookie 是否带 Secure。
// 放在反代后面时面板自身是 HTTP，此时应改用 --secure-cookies。
const tlsOn = !!(TLS_CERT && TLS_KEY);

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'config.json');

const config = new Config(CONFIG_FILE);
config.data.panel.port = PORT;
config.data.panel.host = HOST;
const bus = new EventEmitter();
const hub = new AgentHub(config, bus);

// ---------- 密码保护：默认关闭（本地服务），可用环境变量或面板设置开启 ----------
if (process.env.BLOCKNEXUS_PASSWORD) {
  config.setCredentials({
    username: process.env.BLOCKNEXUS_USERNAME || 'admin',
    password: process.env.BLOCKNEXUS_PASSWORD,
  });
  config.data.panel.authEnabled = true;
  config.save();
}

const app = express();
app.disable('x-powered-by');
// 反代信任必须在任何读取 req.ip 的中间件之前设置（登录/找回密码的限流都依赖它）
if (TRUST_PROXY !== null) app.set('trust proxy', TRUST_PROXY);
// ---------- 基础安全响应头 ----------
// ⚠ 必须注册在 `express.json()` **之前**：body parser 抛出的解析错误会跳过它之后的
//    所有普通中间件直奔错误处理器，于是畸形请求的响应会**丢掉这些头**
//    （实测确认过）。放最前面才能覆盖到错误响应。
// 只加**零功能风险**的几条。CSP 刻意不加：它最容易悄悄弄坏 UI
// （beUI/shadcn 的内联样式、内联脚本都可能被拦），而本项目没有可自动化的
// 浏览器回归测试——加一条测不出来的 CSP，风险大于收益。要加请单独一轮并人工过一遍界面。
app.use((req, res, next) => {
  // 禁止被 iframe 嵌入：面板是本地高权限服务，被套进第三方页面即可做点击劫持
  // （诱导管理员点「删除实例」「开启免密」之类）。
  res.setHeader('X-Frame-Options', 'DENY');
  // 不要根据内容猜类型：/agent.js 是可直接下载的脚本，猜错类型会有嗅探类风险
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 跨站跳转时不带 Referer。面板地址本身可能含主机名/端口等内部信息，
  // 而「关于」页有一堆指向 GitHub / 各服务官网的外链——不带 Referer 最省心。
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '1mb' }));
// agent.js 匿名下载（手动安装用，文件不含密钥）：根路径方便 curl，
// README 与前端手动安装命令都指向这里；api.js 里的 /api/agent.js 保留兼容
app.get('/agent.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'agent', 'agent.js'));
});
// 前端为 Vite + React (shadcn/ui + beUI) 构建产物：web/dist
// index.html 禁缓存：新版本发布后外壳/浏览器立即拿到新入口（带 hash 的 assets 仍长缓存）
app.use(express.static(path.join(__dirname, '..', 'web', 'dist'), {
  setHeaders(res, filePath) {
    if (String(filePath).endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));
app.use('/api', createApi(config, hub, bus, {}, {
  secureCookies: tlsOn || SECURE_COOKIE,
  // 是否可能被本机之外访问到（审计 H5 的告警依据）：
  //   · 监听非回环地址（--host 0.0.0.0 / 具体 IP / 主机名）
  //   · 或配置了 trust proxy —— 说明前面有反代，面板虽只听 127.0.0.1 但实际对外
  // 只用于提示，**不改变任何行为**。
  mayBeExposed: !isLoopbackHost(HOST) || TRUST_PROXY !== null,
}));

// SPA history 路由回退：/settings、/server/... 等路径直达时返回 index.html。
// API 与带扩展名的资源路径不回退（缺失照常 404）
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/agent.js') && !path.extname(req.path)) {
    res.sendFile(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
    return;
  }
  next();
});

// ---------- app 级错误兜底（**必须留在最后**）----------
// 为什么非补不可：上面的 express.json() 是 **app 级**中间件，在任何 router 之前运行。
// 它抛出的解析错误**不会**进入 api.js 里那个 router 级错误处理器（那个只在 router 内部生效）。
// 而此前 server.js 没有 app 级错误处理器 → 落到 Express 内置默认处理器 →
// NODE_ENV 未设为 production（本项目从不设置它）时会把**完整堆栈**回给客户端。
// 后果：未认证请求发一个畸形 JSON body 就能拿到面板安装的绝对路径与模块布局
// （实测确认响应为 text/html + SyntaxError 堆栈，且堆栈同时打到 stderr）。
// 实现放在 panel/http-errors.js，以便测试直接覆盖同一份代码。
app.use(requestErrorHandler);

// 面板自身也可上 HTTPS；tlsOn 已在上方判定（createApi 注册时会用到）
let server;
if (tlsOn) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app);
} else {
  server = http.createServer(app);
}
server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  const ver = (() => { try { return require('../package.json').version || ''; } catch { return ''; } })();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log(`  │  BlockNexus · Minecraft 服务器管理面板  v${ver}`.padEnd(50) + '│');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
  const scheme = tlsOn ? 'https' : 'http';
  console.log(`  面板地址:   ${scheme}://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  监听范围:   ${HOST}（对外可达）`);
    if (!config.data.panel.authEnabled) {
      console.log('  ⚠ 安全提示: 面板已对外监听但未开启登录保护，建议在右上角「设置」中开启');
    }
  } else {
    console.log('  监听范围:   仅本机（如需远程访问请用 --host 0.0.0.0 启动）');
  }
  if (config.data.panel.authEnabled) {
    console.log('  密码保护:   已启用');
  } else {
    console.log('  密码保护:   未启用（本地服务；若暴露给局域网/公网，建议在面板右上角设置中开启）');
  }
  console.log('  连接方式:   默认「面板连接 Agent」——面板主动连到各服务器上 Agent 监听的端口');
  console.log(`              也支持「Agent 连接面板」：Agent 回连 ws://<本机可达地址>:${PORT}/agent/ws`);
  if (TRUST_PROXY === null) {
    console.log('  反代信任:   未启用（按直连地址限流）');
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log('              若面板在反向代理后面，请加 --trust-proxy 1，否则登录限流会变成全局限流');
    }
  } else {
    console.log(`  反代信任:   已启用（${JSON.stringify(TRUST_PROXY)}）`);
    console.log('              ⚠ 请确认面板不直连公网，否则 X-Forwarded-For 可被伪造绕过限流');
  }
  console.log(`  安全 Cookie: ${tlsOn || SECURE_COOKIE ? 'Secure 已启用' : '未启用（纯 HTTP 访问时正常）'}`);
  console.log('');
  console.log('  配置文件:   ' + CONFIG_FILE);
  console.log('');
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));
