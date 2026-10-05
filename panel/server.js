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
app.use(express.json({ limit: '1mb' }));
// agent.js 匿名下载（手动安装用，文件不含密钥）：根路径方便 curl，
// README 与前端手动安装命令都指向这里；api.js 里的 /api/agent.js 保留兼容
app.get('/agent.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'agent', 'agent.js'));
});
// 前端为 Vite + React (shadcn/ui + beUI) 构建产物：web/dist
app.use(express.static(path.join(__dirname, '..', 'web', 'dist')));
app.use('/api', createApi(config, hub, bus));

// 面板自身也可上 HTTPS（自签或正式证书）；放在反代后面时用不到
let tlsOn = false;
let server;
if (TLS_CERT && TLS_KEY) {
  server = https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app);
  tlsOn = true;
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
  console.log('');
  console.log('  配置文件:   ' + CONFIG_FILE);
  console.log('');
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));
