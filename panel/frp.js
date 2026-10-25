'use strict';
// frp 客户端托管：面板管理一个 frpc 进程（SakuraFrp 模式或自建 frps 模式）。
//
// 为什么由面板托管而不是让用户自己开黑窗口：
//   · 进程要跟面板一起活（启动/停止/异常重连），日志要能在面板里看；
//   · 统一 `windowsHide`，不会再弹 cmd 窗口；
//   · 配置生成与校验可单测，避免用户手写 TOML/INI 写错。
//
// 边界：**不打包、不下载 frpc 二进制**。用户自备（SakuraFrp 官方包或上游 release），
// 设置里填路径。这样面板体积、CI 与跨平台分发都不受影响。

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const MODES = ['sakura', 'upstream'];
const TYPES = ['tcp', 'udp'];
const PROXY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// localIP 允许 IP 或主机名（frpc 会自己解析）；不接受空格/换行等会破坏 TOML 的字符
const LOCAL_IP_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/;
const MAX_PROXIES = 50;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const DEFAULTS = {
  enabled: false,
  mode: 'sakura',
  binaryPath: '',
  sakura: { token: '', tunnels: '' },
  upstream: {
    serverAddr: '',
    serverPort: 7000,
    authToken: '',
    // 樱花节点强制要求 user（访问密钥）。上游 frpc 缺它时直接拒绝登录：
    //   "invalid configuration in upstream client, make sure token and user was set correctly"
    user: '',
    // transport.tls.enable：null = 不写这一行（沿用 frpc 默认 true，老配置行为不变）；
    // false/true = 显式写进生成的 TOML。樱花节点不支持 TLS，导入时必须显式 false。
    tlsEnable: null,
    proxies: [],
  },
};

const isWin = () => process.platform === 'win32';

function clampPort(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/** TOML 基本字符串转义（不能有裸换行/引号/反斜杠） */
function tomlStr(value) {
  return '"' + String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ') + '"';
}

/** 解析 "1, 2 ,3" → ['1','2','3']（SakuraFrp 的隧道 ID 列表） */
function parseTunnelIds(input) {
  return String(input || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,12}$/.test(s));
}

/** SakuraFrp 模式启动参数：`frpc -f <token>:<id1,id2> -n`（-n 关闭自动更新检查） */
function buildSakuraArgs(cfg = {}) {
  const token = String(cfg.sakura?.token || '').trim();
  const ids = parseTunnelIds(cfg.sakura?.tunnels);
  if (!token || !ids.length) return null;
  return ['-f', `${token}:${ids.join(',')}`, '-n'];
}

/** 自建 frps：按设置生成 frpc.toml（上游 frp v0.52+ 的 TOML 格式） */
function buildUpstreamToml(cfg = {}) {
  const u = cfg.upstream || {};
  const lines = [];
  // user 必须写在 auth.* 之前也行，位置无关；但缺 user 时樱花节点会拒绝登录，
  // 所以只要用户填了就一定输出（实测：0.71.1 上游 frpc 认这个字段）。
  if (String(u.user || '').trim()) lines.push(`user = ${tomlStr(u.user)}`);
  lines.push(`serverAddr = ${tomlStr(u.serverAddr)}`);
  lines.push(`serverPort = ${clampPort(u.serverPort, 7000)}`);
  if (String(u.authToken || '').trim()) {
    lines.push('auth.method = "token"');
    lines.push(`auth.token = ${tomlStr(u.authToken)}`);
  }
  // 只在明确设置时输出：樱花节点不支持 TLS，导入的配置会带 tlsEnable=false；
  // 老配置是 null → 不写这一行，行为与之前完全一致。
  if (u.tlsEnable === true || u.tlsEnable === false) {
    lines.push(`transport.tls.enable = ${u.tlsEnable ? 'true' : 'false'}`);
  }
  lines.push('log.to = "console"');
  lines.push('log.level = "info"');
  for (const p of Array.isArray(u.proxies) ? u.proxies : []) {
    if (!p || !p.name) continue;
    lines.push('');
    lines.push('[[proxies]]');
    lines.push(`name = ${tomlStr(p.name)}`);
    lines.push(`type = ${tomlStr(TYPES.includes(p.type) ? p.type : 'tcp')}`);
    // localIP：默认回环（实例与面板同机）；局域网/远程实例写成那台机器的地址
    lines.push(`localIP = ${tomlStr(p.localIP || '127.0.0.1')}`);
    lines.push(`localPort = ${clampPort(p.localPort, 25565)}`);
    lines.push(`remotePort = ${clampPort(p.remotePort, 25565)}`);
  }
  return lines.join('\n') + '\n';
}

/** 供 API 返回：凭据只回 has* */
function publicConfig(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const u = { ...DEFAULTS.upstream, ...(c.upstream || {}) };
  return {
    enabled: !!c.enabled,
    mode: MODES.includes(c.mode) ? c.mode : 'sakura',
    binaryPath: c.binaryPath || '',
    sakura: { hasToken: !!c.sakura?.token, tunnels: c.sakura?.tunnels || '' },
    upstream: {
      serverAddr: u.serverAddr || '',
      serverPort: u.serverPort || 7000,
      hasToken: !!u.authToken,
      // 与 token 同一约定：只回是否已设置，绝不回原文
      hasUser: !!u.user,
      // null = 未显式设置（沿用 frpc 默认），true/false = 生成的 TOML 里会写死
      tlsEnable: u.tlsEnable === true ? true : u.tlsEnable === false ? false : null,
      proxies: (Array.isArray(u.proxies) ? u.proxies : []).map((p) => ({
        name: p.name || '',
        type: TYPES.includes(p.type) ? p.type : 'tcp',
        localPort: clampPort(p.localPort, 25565),
        remotePort: clampPort(p.remotePort, 25565),
        localIP: p.localIP || '127.0.0.1',
      })),
    },
  };
}

/** 合并 + 校验（空字符串凭据 = 保留原值） */
function normalizeConfig(input = {}, current = {}) {
  const cur = { ...DEFAULTS, ...current };
  const inSakura = input.sakura || {};
  const inUp = input.upstream || {};
  const curUp = cur.upstream || {};

  const cfg = {
    enabled: input.enabled !== undefined ? !!input.enabled : !!cur.enabled,
    mode: MODES.includes(input.mode) ? input.mode : MODES.includes(cur.mode) ? cur.mode : 'sakura',
    binaryPath: String(input.binaryPath !== undefined ? input.binaryPath : cur.binaryPath || '').trim(),
    sakura: {
      token: String(inSakura.token || cur.sakura?.token || '').trim(),
      tunnels: String(inSakura.tunnels !== undefined ? inSakura.tunnels : cur.sakura?.tunnels || '').trim(),
    },
    upstream: {
      serverAddr: String(inUp.serverAddr !== undefined ? inUp.serverAddr : curUp.serverAddr || '').trim(),
      serverPort: clampPort(inUp.serverPort !== undefined ? inUp.serverPort : curUp.serverPort, 7000),
      authToken: String(inUp.authToken || curUp.authToken || '').trim(),
      // 空字符串 = 保留原值（与 authToken 同一约定）
      user: String(inUp.user || curUp.user || '').trim(),
      // undefined = 保留原值；null = 显式「不写这一行」；true/false = 写死
      tlsEnable:
        inUp.tlsEnable === undefined
          ? curUp.tlsEnable === true || curUp.tlsEnable === false
            ? curUp.tlsEnable
            : null
          : inUp.tlsEnable === null
            ? null
            : !!inUp.tlsEnable,
      proxies: [],
    },
  };

  // proxies 只在请求里带了才覆盖（避免部分更新把列表清空）
  if (Array.isArray(inUp.proxies)) {
    // 校验顺序：先确认「自建模式最关键的 serverAddr」，再逐条校代理。
    // 否则一个空表单会先报「代理名无效」，用户根本不知道该先填什么。
    if (cfg.enabled && cfg.mode === 'upstream' && !cfg.upstream.serverAddr) {
      return { error: 'network.frp-server-required' };
    }
    if (inUp.proxies.length > MAX_PROXIES) return { error: 'network.frp-proxies-too-many' };
    for (const p of inUp.proxies) {
      const name = String(p?.name || '').trim();
      if (!PROXY_NAME_RE.test(name)) return { error: 'network.frp-proxy-name-invalid', params: { name: name || '?' } };
      const localPort = Number(p?.localPort);
      const remotePort = Number(p?.remotePort);
      if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        return { error: 'network.frp-port-invalid', params: { port: String(p?.localPort ?? '') } };
      }
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        return { error: 'network.frp-port-invalid', params: { port: String(p?.remotePort ?? '') } };
      }
      const localIP = String(p?.localIP || '').trim();
      if (localIP && !LOCAL_IP_RE.test(localIP)) {
        return { error: 'network.frp-localip-invalid', params: { ip: localIP } };
      }
      cfg.upstream.proxies.push({
        name,
        type: TYPES.includes(p?.type) ? p.type : 'tcp',
        localPort,
        remotePort,
        localIP: localIP || '127.0.0.1',
      });
    }
  } else {
    cfg.upstream.proxies = (Array.isArray(curUp.proxies) ? curUp.proxies : []).map((p) => ({ ...p }));
  }

  if (cfg.enabled) {
    if (!cfg.binaryPath) return { error: 'network.frp-binary-required' };
    if (cfg.mode === 'sakura') {
      if (!cfg.sakura.token) return { error: 'network.frp-credentials-required', params: { mode: 'SakuraFrp' } };
      if (!parseTunnelIds(cfg.sakura.tunnels).length) {
        return { error: 'network.frp-tunnels-required' };
      }
    } else {
      if (!cfg.upstream.serverAddr) return { error: 'network.frp-server-required' };
      if (!cfg.upstream.proxies.length) return { error: 'network.frp-proxies-required' };
    }
  }
  return { config: cfg };
}

/** 二进制是否存在/可执行（只做存在性检查，不执行） */
function binaryOk(bin) {
  try {
    return !!bin && fs.statSync(bin).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析一段 TOML 标量值。只支持樱花「手动配置」里会出现的几种：
 * 双引号字符串（含 \" \\ 转义）、单引号字面量、整数、true/false。
 * 返回 undefined 表示这一行看不懂（调用方按「配置格式错误」处理）。
 */
function parseTomlValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) {
    return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return undefined;
}

/**
 * 解析樱花后台「手动配置」整段 TOML → 面板的 upstream 配置。
 *
 * 为什么要有它：樱花给的是 `user` + `auth.token` + 关 TLS 的组合，而面板原来的
 * upstream 模式既不输出 `user` 也不输出 `transport.tls`，导致登录被节点直接拒绝
 * （实测报错 "make sure token and user was set correctly"）。让用户粘贴原文、
 * 面板自己挑字段，比让用户对着表单抄 6 个字段可靠得多。
 *
 * 返回 `{ value }` 或 `{ error, params }`（error 是 error-codes 里的 key）。
 */
function parseSakuraConfig(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return { error: 'network.sakura-config-empty' };

  const value = {
    user: '',
    authToken: '',
    serverAddr: '',
    serverPort: 7000,
    tlsEnable: null,
    proxies: [],
    tunnelIds: [],
  };
  let cur = null;
  let sawKey = false;

  for (const rawLine of src.split(/\r?\n/)) {
    // 樱花导出的 #[id] 注释（`# id = 29662979`）：只用于展示，不参与连接逻辑
    const idMatch = rawLine.match(/^\s*#\s*id\s*=\s*(\d{1,12})\s*$/i);
    if (idMatch) {
      if (!value.tunnelIds.includes(idMatch[1])) value.tunnelIds.push(idMatch[1]);
      continue;
    }
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^\[\[\s*proxies\s*\]\]$/i.test(line)) {
      cur = { name: '', type: 'tcp', localIP: '127.0.0.1', localPort: 0, remotePort: 0 };
      value.proxies.push(cur);
      sawKey = true;
      continue;
    }
    // 其它表头（[common] / [transport] 等）：退出 proxies 段，内容忽略
    if (/^\[[^\]]*\]$/.test(line)) {
      cur = null;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) return { error: 'network.sakura-config-invalid', params: { line: line.slice(0, 80) } };
    const key = m[1];
    const val = parseTomlValue(m[2]);
    if (val === undefined) return { error: 'network.sakura-config-invalid', params: { line: line.slice(0, 80) } };
    sawKey = true;

    if (cur) {
      if (key === 'name') cur.name = String(val).trim();
      // 先原样记下类型，循环结束后统一校验：把 http/https 静默改成 tcp 会让用户以为通了、其实错位
      else if (key === 'type') cur.type = String(val).trim().toLowerCase();
      else if (key === 'localIP') cur.localIP = String(val).trim();
      else if (key === 'localPort') cur.localPort = Number(val);
      else if (key === 'remotePort') cur.remotePort = Number(val);
      continue;
    }

    if (key === 'user') value.user = String(val).trim();
    else if (key === 'auth.token') value.authToken = String(val).trim();
    else if (key === 'serverAddr') value.serverAddr = String(val).trim();
    else if (key === 'serverPort') value.serverPort = Number(val);
    else if (key === 'transport.tls.enable') value.tlsEnable = val === true;
    // transport.tls.disableCustomTLSFirstByte / log.* / metadatas 等：面板统一接管，忽略
  }

  if (!sawKey) return { error: 'network.sakura-config-invalid', params: { line: '' } };
  // user 缺失是「樱花连不上」的头号原因，必须在保存阶段就拦住，别留到启动后
  if (!value.user) return { error: 'network.sakura-missing-user' };
  if (!value.authToken) return { error: 'network.sakura-missing-token' };
  if (!value.serverAddr) return { error: 'network.frp-server-required' };
  if (!value.proxies.length) return { error: 'network.sakura-no-proxies' };

  const seenRemote = new Set();
  for (const p of value.proxies) {
    if (!PROXY_NAME_RE.test(p.name)) {
      return { error: 'network.frp-proxy-name-invalid', params: { name: p.name || '?' } };
    }
    if (!TYPES.includes(p.type)) {
      return { error: 'network.sakura-unsupported-type', params: { type: p.type || '?' } };
    }
    for (const port of [p.localPort, p.remotePort]) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: 'network.frp-port-invalid', params: { port: String(port) } };
      }
    }
    if (p.localIP && !LOCAL_IP_RE.test(p.localIP)) {
      return { error: 'network.frp-localip-invalid', params: { ip: p.localIP } };
    }
    if (seenRemote.has(p.remotePort)) {
      return { error: 'frp.port-in-use', params: { port: p.remotePort } };
    }
    seenRemote.add(p.remotePort);
  }

  value.serverPort = clampPort(value.serverPort, 7000);
  return { value };
}

/**
 * 从 frpc 输出判断「这个二进制不认识 -f」。
 * 上游 frpc 只认 -c，樱花定制版才有 -f/-n；报错文案各版本略有差异，这里按几种常见写法匹配。
 * 纯函数，便于单测（不需要真的跑一个坏二进制）。
 */
function sakuraBinaryUnsupported(logText) {
  const s = String(logText || '');
  return (
    /unknown shorthand flag:\s*'f'/i.test(s) ||
    /flag provided but not defined:\s*-f\b/i.test(s) ||
    /unknown flag:\s*-f\b/i.test(s) ||
    /unknown shorthand flag:\s*'n'/i.test(s)
  );
}

/**
 * 暴露风险：把「面板自己的端口」通了 frp，却没开登录保护 → 等于把面板交给公网。
 * 只看 upstream 代理列表（sakura 模式的隧道由樱花面板配置，面板这里看不到端口）。
 * 纯函数，便于单测；mayBeExposed 由 panel/server.js 的监听地址/反代判断给出。
 */
function exposureRisk(cfg = {}, opts = {}) {
  const panelPort = Number(opts.panelPort) || 0;
  if (!panelPort) return { risky: false, port: 0, proxy: '' };
  if (!opts.mayBeExposed) return { risky: false, port: 0, proxy: '' };
  if (opts.authEnabled) return { risky: false, port: 0, proxy: '' };
  const proxies = (cfg && cfg.upstream && Array.isArray(cfg.upstream.proxies) && cfg.upstream.proxies) || [];
  const hit = proxies.find((p) => p && Number(p.localPort) === panelPort);
  if (!hit) return { risky: false, port: 0, proxy: '' };
  return { risky: true, port: panelPort, proxy: hit.name || '' };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    if (!isWin()) return false;
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true });
      return new RegExp(`\\b${pid}\\b`).test(out.stdout || '');
    } catch {
      return false;
    }
  }
}

function killTree(pid) {
  try {
    if (isWin()) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * frpc 进程管理器：一个面板只跑一个 frpc（多隧道用 SakuraFrp 的隧道列表 / 自建的多 proxies）。
 * 目录：data/frp/{frpc.toml, frpc.log, runtime.json}
 */
class FrpManager {
  constructor({ dir, onLog } = {}) {
    this.dir = dir;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.stopping = false;
    this.restarts = 0;
    this.restartTimer = null;
    this._stableTimer = null;
    this.lastExit = null;
    // 不在构造时建目录：单测/只读接口创建管理器时不应该在仓库里留空目录。
    // 真正写入（配置/日志/runtime）前由 start() 调 ensureDir()。
    this.cleanupStale();
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get configFile() {
    return path.join(this.dir, 'frpc.toml');
  }

  get logFile() {
    return path.join(this.dir, 'frpc.log');
  }

  get runtimeFile() {
    return path.join(this.dir, 'runtime.json');
  }

  cleanupStale() {
    const rt = readJson(this.runtimeFile);
    if (rt && rt.pid && !pidAlive(rt.pid)) {
      try {
        fs.rmSync(this.runtimeFile, { force: true });
      } catch {}
    }
  }

  /** 最近一次运行的 pid（面板重启后也能找到） */
  pid() {
    const rt = readJson(this.runtimeFile);
    return rt && pidAlive(rt.pid) ? rt.pid : 0;
  }

  running() {
    return !!this.pid();
  }

  logTail(maxLines = 120) {
    try {
      const st = fs.statSync(this.logFile);
      const start = Math.max(0, st.size - 16 * 1024);
      const fd = fs.openSync(this.logFile, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-maxLines);
    } catch {
      return [];
    }
  }

  status() {
    const rt = readJson(this.runtimeFile) || {};
    const running = this.running();
    return {
      running,
      pid: this.pid() || 0,
      startedAt: rt.startedAt || null,
      mode: rt.mode || '',
      // 三态：跑着 / 等待重连（退避中）/ 没跑。面板重启后 restartTimer 丢失，
      // 此时 displayed 为 stopped 也是对的——重新启动由「自动启动」那条链负责。
      state: running ? 'running' : this.restartTimer ? 'restarting' : 'stopped',
      restarts: this.restarts,
      lastExit: this.lastExit || null,
      log: this.logTail(),
    };
  }

  _rotateLog() {
    try {
      const st = fs.statSync(this.logFile);
      if (st.size <= MAX_LOG_BYTES) return;
      // 以前是直接删：排障时最想看的上一次退出原因正好没了。
      // 改成保留一份 .1（总量因此有 2×2MB 的上限，仍然不会无限增长）。
      const prev = this.logFile + '.1';
      try {
        fs.rmSync(prev, { force: true });
      } catch {}
      fs.renameSync(this.logFile, prev);
    } catch {}
  }

  /**
   * 启动 frpc。返回 { pid }；启动后 800ms 内退出则抛错并附日志尾部。
   */
  async start(cfg) {
    if (this.running()) return { pid: this.pid(), already: true };
    if (!binaryOk(cfg.binaryPath)) {
      throw Object.assign(new Error('frpc 可执行文件不存在'), { code: 'network.frp-binary-missing' });
    }
    this.ensureDir();
    let args;
    if (cfg.mode === 'sakura') {
      args = buildSakuraArgs(cfg);
      if (!args) throw Object.assign(new Error('SakuraFrp 配置不完整'), { code: 'network.frp-credentials-required' });
    } else {
      fs.writeFileSync(this.configFile, buildUpstreamToml(cfg));
      args = ['-c', this.configFile];
    }

    this._rotateLog();
    const fd = fs.openSync(this.logFile, 'a');
    const startedAt = Date.now();
    fs.writeSync(fd, `\n[BlockNexus] ${new Date(startedAt).toISOString()} 启动 frpc（${cfg.mode}）\n`);
    let child;
    try {
      child = spawn(cfg.binaryPath, args, {
        cwd: this.dir,
        detached: true, // 面板重启后进程可继续，由 runtime.json 找回
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    child.unref();
    this.child = child;
    this.stopping = false;
    writeJson(this.runtimeFile, { pid: child.pid, startedAt, mode: cfg.mode });
    this.onLog(`frpc 已启动（pid ${child.pid}）`);

    // 早退判定：配置错/端口占用/密钥错都会在 1 秒内退出
    await new Promise((r) => setTimeout(r, 800));
    if (!pidAlive(child.pid)) {
      const tail = this.logTail(20).join('\n');
      // frpc 报完 "unknown shorthand flag" 还会打一整屏 usage，20 行会被挤掉，
      // 所以判定用更大的窗口（读的是日志尾部 16KB，成本一样）。
      const recent = this.logTail(80).join('\n');
      try {
        fs.rmSync(this.runtimeFile, { force: true });
      } catch {}
      this.child = null;
      // 樱花模式用 `-f`/`-n`，这两个是樱花定制 frpc 的私有参数：上游 frpc 会报
      // "unknown shorthand flag: 'f' in -f"。不翻译的话用户只会看到「启动后立即退出」。
      const code =
        cfg.mode === 'sakura' && sakuraBinaryUnsupported(recent)
          ? 'network.frp-sakura-needs-custom-build'
          : 'network.frp-start-failed';
      throw Object.assign(new Error('frpc 启动后立即退出'), {
        code,
        detail: tail,
      });
    }
    this._watch(child, cfg);
    // 稳定运行 30 秒后才清零重连计数：
    //   · 启动即清零会让「每 20 秒崩一次」的进程变成永动机（永远 1 次重连）；
    //   · 永不清零又会让偶发抖动的进程在几次之后彻底放弃。
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      this._stableTimer = null;
      this.restarts = 0;
    }, 30000);
    if (this._stableTimer.unref) this._stableTimer.unref();
    return { pid: child.pid, args: args.length };
  }

  /** 异常退出 → 退避重连（5s/15s/60s，最多 3 次）；主动 stop 不重连 */
  _watch(child, cfg) {
    // 每个子进程只清理「自己那一份」runtime.json：如果它是被新实例替换掉的旧进程，
    // 退出时不能把新进程的 pid 记录删掉（否则面板会以为 frp 没在跑，再启一个 → 代理重名冲突）
    const ownsRuntime = () => {
      const rt = readJson(this.runtimeFile);
      return !rt || rt.pid === child.pid;
    };
    child.on('exit', (code, signal) => {
      const current = this.child === child;
      if (current) this.child = null;
      if (ownsRuntime()) {
        try {
          fs.rmSync(this.runtimeFile, { force: true });
        } catch {}
      }
      // 已经被替换掉的旧进程：只记录日志，不参与重连，也不动新实例的状态
      if (!current) {
        this.onLog(`旧 frpc 进程退出（pid ${child.pid}, code=${code}）`);
        return;
      }
      if (this.stopping) return;
      // 最近一次异常退出：面板重启后状态区仍能说清「上次为什么挂的」
      this.lastExit = { code: code === null ? -1 : code, signal: signal || '', at: Date.now() };
      this.onLog(`frpc 退出（code=${code}, signal=${signal || '-'}）`);
      if (this.restarts >= 3) {
        this.onLog('frpc 连续异常退出，已停止自动重连');
        return;
      }
      const delay = [5000, 15000, 60000][Math.min(this.restarts, 2)];
      this.restarts++;
      this.restartTimer = setTimeout(() => {
        // 必须先清掉：否则定时器触发后 restartTimer 一直是真值，
        // 状态会永远显示「重连中」，且 stop() 里 clearTimeout 也清不干净。
        this.restartTimer = null;
        this.start(cfg).catch((e) => this.onLog(`frpc 重连失败：${e.message}`));
      }, delay);
      if (this.restartTimer.unref) this.restartTimer.unref();
    });
  }

  /** 停止：先温和 TERM，2 秒后强杀进程树 */
  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    const pid = this.pid();
    if (!pid) {
      try {
        fs.rmSync(this.runtimeFile, { force: true });
      } catch {}
      return { stopped: false };
    }
    try {
      if (isWin()) {
        spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {}
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pidAlive(pid)) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (pidAlive(pid)) killTree(pid);
    try {
      fs.rmSync(this.runtimeFile, { force: true });
    } catch {}
    this.restarts = 0;
    this.onLog('frpc 已停止');
    return { stopped: !pidAlive(pid), pid };
  }

  async restart(cfg) {
    await this.stop();
    return this.start(cfg);
  }

  /** 同步停止（面板退出钩子用：此时不能再等异步） */
  stopSync() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    const pid = this.pid();
    if (!pid) return false;
    killTree(pid);
    try {
      fs.rmSync(this.runtimeFile, { force: true });
    } catch {}
    return true;
  }
}

/**
 * 是否私有/回环 IPv4。用途：判断「服务器是不是和面板在同一局域网」——
 * 是的话面板托管的 frpc 可以把 localIP 指过去，转发到那台机器上的实例端口。
 * （公网地址不走这条：那台机器本来就该直接对外，或由它自己跑 frpc。）
 */
function isPrivateIPv4(host) {
  const s = String(host || '').trim();
  if (net.isIP(s) !== 4) return false;
  const [a, b] = s.split('.').map(Number);
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * 实例的转发目标：本机 → 127.0.0.1；同一局域网（私有 IP）或主机名 → 服务器地址；
 * 公网 IP → lan=false（面板托管的 frpc 到不了，应由那台机器自己跑 frpc）。
 * 返回 { targetHost, lan }。
 */
function frpTarget(host, isLocal) {
  const h = String(host || '').trim();
  const local = !!isLocal || h === '127.0.0.1' || h.toLowerCase() === 'localhost';
  const lan = local || isPrivateIPv4(h) || !net.isIP(h);
  return { targetHost: local ? '127.0.0.1' : h, lan: !!lan };
}

module.exports = {
  DEFAULTS,
  MODES,
  TYPES,
  LOCAL_IP_RE,
  parseTunnelIds,
  buildSakuraArgs,
  buildUpstreamToml,
  tomlStr,
  parseTomlValue,
  parseSakuraConfig,
  sakuraBinaryUnsupported,
  exposureRisk,
  clampPort,
  publicConfig,
  normalizeConfig,
  binaryOk,
  isPrivateIPv4,
  frpTarget,
  FrpManager,
};
