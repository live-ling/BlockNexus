'use strict';
// BlockNexus Agent — 配置与版本常量
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const state = require('./state.js');

// Agent 脚本版本：面板读取本文件头部的这个常量判断远端是否落后（不一致自动更新）
// 0.3.6：握手 HKDF info 标签由 'mcpan/*' 改为 'blocknexus/*'（更名兼容期结束）。
//        ⚠ 这是**破坏性协议变更**：新旧混用会握手失败，因此必须靠本版本号驱动面板自动更新远端 Agent。
const AGENT_VERSION = '0.4.2';

// 对外标识：启动横幅与面板握手 hello 的 agent 字段都用它；HTTP 请求的 User-Agent
// 也取自这里（见 http.js），因此只有 AGENT_VERSION 一处需要维护。
// 注意：Agent 与面板是两个独立发布的版本系列（本机 Agent 可单独更新），不要互相覆盖。
const VERSION = 'BlockNexus/' + AGENT_VERSION;

// ============================ 配置 ============================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    // 布尔开关（如 --insecure）不带值。原先一律写 `argv[i+1]`：
    //   · 放在**末位**时写成 undefined → 调用方用 `!== undefined` 判断，开关**静默失效**；
    //   · 后面紧跟另一个选项时会把那个选项当成它的值。
    // 这里把「下一个是选项或不存在」一律记为 true。
    out[argv[i]] = next === undefined || next.startsWith('--') ? true : next;
  }
  return out;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  let cfg = {};
  const cfgFile = path.join(__dirname, 'agent.json');
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {}
  const listenRaw = args['--listen'] || process.env.BLOCKNEXUS_LISTEN || cfg.listen;
  const tlsCert = args['--tls-cert'] || process.env.BLOCKNEXUS_TLS_CERT || (cfg.tls && cfg.tls.cert);
  const tlsKey = args['--tls-key'] || process.env.BLOCKNEXUS_TLS_KEY || (cfg.tls && cfg.tls.key);
  const conf = {
    mode: 'connect',
    panel: args['--panel'] || process.env.BLOCKNEXUS_PANEL || cfg.panel || null,
    listen: listenRaw ? Number(listenRaw) : null,
    token: args['--token'] || process.env.BLOCKNEXUS_TOKEN || cfg.token,
    id: args['--id'] || process.env.BLOCKNEXUS_ID || cfg.id,
    dir: args['--dir'] || __dirname,
  };
  conf.tls = tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null;
  if (conf.listen) {
    // 监听模式：Agent 在公网开放端口，由面板主动连入（推荐）
    conf.mode = 'listen';
    conf.panel = null;
    if (!Number.isInteger(conf.listen) || conf.listen < 1 || conf.listen > 65535) {
      console.error('--listen 端口不合法');
      process.exit(1);
    }
  }
  state.insecureTls = args['--insecure'] === undefined ? !!cfg.tlsInsecure : true;
  conf.instances = args['--instances'] || path.join(conf.dir, 'instances');
  if ((!conf.panel && !conf.listen) || !conf.token || !conf.id) {
    console.error(
      '缺少配置：需要 --token / --id，并给出 --listen <端口>（面板连入）或 --panel <面板地址>（Agent 连出）',
    );
    process.exit(1);
  }
  return conf;
}

module.exports = { VERSION, AGENT_VERSION, parseArgs, loadConfig };
