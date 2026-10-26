'use strict';
// 合规遥测：只上报「代码里写死的枚举与计数」，永不上报用户输入的字符串。
//
// 为什么要独立成模块且分成两层：遥测的**风险不在功能、在内容**——一个拼错的字段就可能
// 把用户的服务器地址、域名、密钥带出去，而且这种泄露在服务端是不可逆的（数据已经到了
// 别人的库里）。所以本文件把「该发什么」做成纯函数（可单测），把「发出去」做成唯一一个
// 需要注入 fetchImpl 的动作（测试里换成假实现，CI 不需要网络）。
//
// 三条硬约定（改动时不要放宽）：
//   1. 默认关闭（opt-in）。enabled 默认 false，必须由用户在设置页主动打开。
//   2. 白名单取值：payload 由 buildPayload() 从 facts 里**逐字段挑**，不整体透传。
//      不在白名单里的键一律丢弃——将来有人往 facts 里加字段也不会被顺带带出去。
//   3. 发送前自检：assertPayloadSafe() 扫一遍，命中敏感模式就**拒绝发送**（fail-closed）。
//      它是白名单之后的第二道闸，防止白名单本身被改坏。
//
// 网络动作必须 fire-and-forget：send() 永不抛异常、永不影响主流程。

const MAX_ENDPOINT_LEN = 200;
const MAX_ID_LEN = 64;
const MAX_VERSION_LEN = 32;
const MAX_AGENT_VERSIONS = 50;
const MAX_ERROR_KEYS = 20;
const MAX_ERROR_COUNT = 1000000;
const PAYLOAD_VERSION = 1;

/** 上报间隔默认 24 小时；失败退避（与 DDNS 同一思路：别把故障放大成重试风暴） */
const DEFAULT_INTERVAL_SEC = 24 * 3600;
const MIN_INTERVAL_SEC = 3600;
const MAX_INTERVAL_SEC = 7 * 24 * 3600;
const BACKOFF_SEC = [300, 1800, 7200];
const REQUEST_TIMEOUT_MS = 5000;

const DEFAULTS = {
  enabled: false,
  // 默认端点：项目官方接收端（自建 VPS，经 EO + 反代）。
  // 用户仍然可以改——这里只是「不填就用这个」，不是锁死。
  endpoint: 'https://api-blocknexus.liveling.top/telemetry',
  intervalSec: DEFAULT_INTERVAL_SEC,
  // 匿名统计 ID：首次启用时生成，关闭时**删除**（不只是置 enabled=false）。
  // 它不是机器指纹——不用 MAC / 硬盘序列号 / 用户名哈希，重装即换新。
  instanceId: '',
};

/**
 * 官方接收端的共享密钥。**公开值**：它不承担保密职责（公开仓库里谁都看得到），
 * 只提高伪造门槛——扫描器与随手脚本不带这个头就会被接收端拒收，
 * 污染数据需要有人主动读代码再写脚本，成本足以挡掉绝大多数噪音。
 * 真正的防线在接收端的白名单校验与限频上。
 */
const TELEMETRY_KEY = 'bnx-telemetry-v1-7f3a9c21e5d84b06';

const OSES = ['windows', 'linux', 'other'];
// 计数桶：'unknown' 表示「这次没采到」（离线/超时），与真实的 0 区分开——
// 把「没采到」当成 0 会让趋势图出现假的下降。
const BUCKETS = ['0', '1', '2-5', '6-20', '20+', 'unknown'];
const ARCHS = ['x64', 'arm64', 'x86', 'arm', 'other'];
const KINDS = ['portable', 'dir', 'git-clean', 'git-dirty', 'unknown'];
// 功能开关：只上报「是否启用」这个布尔，绝不上报任何配置值
const FEATURES = ['ddns', 'frp', 'ai', 'smtp', 'notify'];

// ---------- 取值工具（白名单的第一道闸：类型/长度/枚举） ----------

function str(v, max) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, max) : '';
}

/**
 * 版本号：只认「最多三段数字」（可带 v 前缀与预发布后缀）。
 *
 * 为什么封三段：`1.2.3.4` 既是合法的四段版本号，也是**一个 IPv4 地址**——放行四段就等于
 * 给「把 IP 塞进 agentVers 里带出去」留了一条正门。本项目版本号实际只有三段（0.6.0），
 * 封三段零代价，却能顺手关掉这个口子。
 */
function version(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '').slice(0, MAX_VERSION_LEN);
  if (!/^\d{1,4}(?:\.\d{1,4}){0,2}(?:-[0-9a-z.-]+)?$/i.test(s)) return '';
  return s;
}

function bool(v) {
  return v === true;
}

function oneOf(v, list, fallback) {
  const s = String(v ?? '').toLowerCase();
  return list.includes(s) ? s : fallback;
}

/**
 * 分桶：上报「区间」而不是精确值——精确的实例数本身就能指纹化一台机器。
 * 只接受数字；缺失（undefined/null）由调用方决定语义（见 buildPayload 的 'unknown'）。
 */
function bucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v === 0) return '0';
  if (v === 1) return '1';
  if (v <= 5) return '2-5';
  if (v <= 20) return '6-20';
  return '20+';
}

/**
 * 错误码计数表。只接受「错误码 → 次数」这种形状：
 * 键必须是错误码的样子（小写字母数字与 . - _），值必须是非负整数。
 * 这一步的意义是**挡住把错误文案当键传进来**——文案里可能有路径、地址、实例名。
 */
function errorCounts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const entries = Object.entries(raw);
  for (const [k, v] of entries) {
    if (Object.keys(out).length >= MAX_ERROR_KEYS) break;
    if (typeof k !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k)) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    out[k.slice(0, 64)] = Math.min(Math.floor(n), MAX_ERROR_COUNT);
  }
  return out;
}

/** 计数：数字走分桶；null/undefined（没采到）→ 'unknown' */
function countBucket(n) {
  if (n === undefined || n === null) return 'unknown';
  const v = Number(n);
  if (!Number.isFinite(v)) return 'unknown';
  return bucket(v);
}

/** Agent 版本列表：去重、校验形状、截断（数量上限防止一台机器塞几百条）。
 *  没采到（null/undefined）返回空数组——空数组本身就在 payload 里，后端能区分
 *  「没有 Agent」与「采不到」，所以不需要额外的 unknown 标记。 */
function agentVersions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (out.length >= MAX_AGENT_VERSIONS) break;
    const s = version(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ---------- payload 构造（纯函数） ----------

/**
 * 由「事实」构造上报体。facts 是调用方手里的一堆信息，**只有下面这些键会被取用**，
 * 其余全部丢弃。新增字段必须同时改这里、改 assertPayloadSafe 的允许形状、改测试。
 *
 * @param {Object} facts
 * @returns {{ok: boolean, reason: string, payload: Object|null}}
 */
function buildPayload(facts) {
  const f = facts || {};
  const id = str(f.id, MAX_ID_LEN);
  if (!id) return { ok: false, reason: 'no-id', payload: null };

  const payload = {
    // 后端据此演进格式；不是面板版本
    v: PAYLOAD_VERSION,
    id,
    ts: Number.isFinite(Number(f.ts)) ? Number(f.ts) : Date.now(),
    panelVer: version(f.panelVer),
    os: oneOf(f.os, OSES, 'other'),
    arch: oneOf(f.arch, ARCHS, 'other'),
    installKind: oneOf(f.installKind, KINDS, 'unknown'),
    // 远端 Agent 版本分布：决定「还能不能改协议 / 要不要发强制升级」的关键数据
    agentVers: agentVersions(f.agentVers),
    servers: countBucket(f.servers),
    instances: countBucket(f.instances),
    features: {},
    errors: errorCounts(f.errors),
  };
  // 功能开关：逐个取布尔，缺键按 false（不猜）
  for (const key of FEATURES) payload.features[key] = bool(f.features && f.features[key]);

  const safe = assertPayloadSafe(payload);
  if (!safe.ok) return { ok: false, reason: safe.reason, payload: null };
  return { ok: true, reason: '', payload };
}

// ---------- 发送前自检（第二道闸） ----------

// 这些模式命中任意一条就**整包不发**。宁可少收一份数据，也不能外泄一次。
const SENSITIVE = [
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, reason: 'ipv4' },
  { re: /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/i, reason: 'ipv6' },
  { re: /@/, reason: 'at-sign' }, // 邮箱 / user@host / SSH 目标
  { re: /:\/\//, reason: 'url' },
  { re: /^[a-z]:[\\/]/i, reason: 'win-path' },
  { re: /\/(?:home|opt|root|Users|var|etc|srv|mnt)(?:\/|$)/, reason: 'unix-path' },
  { re: /[\\/]/, reason: 'path-separator' },
  // 疑似密钥/令牌：足够长的无分隔随机串，或带常见前缀
  { re: /[A-Za-z0-9+/=_-]{40,}/, reason: 'long-token' },
  { re: /\b(?:sk-|ghp_|gho_|xox[baprs]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/, reason: 'key-prefix' },
];

/** 递归扫描 payload 里所有字符串值；命中敏感模式即失败 */
function assertPayloadSafe(payload, depth = 0) {
  if (depth > 6) return { ok: false, reason: 'too-deep' };
  if (typeof payload === 'string') {
    for (const s of SENSITIVE) {
      if (s.re.test(payload)) return { ok: false, reason: s.reason };
    }
    return { ok: true, reason: '' };
  }
  if (payload === null || payload === undefined) return { ok: true, reason: '' };
  if (typeof payload !== 'object') {
    // 数字/布尔本身无信息风险，但 NaN/Infinity 不该出现（JSON 化会变 null）
    return Number.isFinite(payload) || typeof payload === 'boolean'
      ? { ok: true, reason: '' }
      : { ok: false, reason: 'non-finite' };
  }
  for (const v of Object.values(payload)) {
    const r = assertPayloadSafe(v, depth + 1);
    if (!r.ok) return r;
  }
  return { ok: true, reason: '' };
}

// ---------- 端点校验 ----------

/**
 * 遥测端点。与 AI baseUrl 的取舍**相反**——AI 需要访问本机 Ollama，所以那里放行回环/私网；
 * 遥测是**外发**，没有任何正当的内网目标，所以这里一律拒绝：
 * 明文 http、回环、私网、链路本地（云元数据）都不许。
 * 目的是防「配置被改成内网地址后，内网拓扑随遥测出去」。
 */
function normalizeEndpoint(raw) {
  const s = String(raw || '').trim().slice(0, MAX_ENDPOINT_LEN);
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:') return '';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return '';
  if (host === 'localhost' || host.endsWith('.localhost')) return '';
  if (host === '::1' || host === '127.0.0.1') return '';
  if (/^127\./.test(host)) return '';
  if (/^(10|192\.168)\./.test(host)) return '';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return '';
  if (/^169\.254\./.test(host)) return '';
  // IPv6 链路本地：hostname 里的方括号已在上面剥掉，所以直接按地址前缀判。
  // 注意不能写 /^fe[89ab]::/ —— fe80::1 在 fe8 后面还有个 0，那样写会漏判。
  if (/^fe[89ab][0-9a-f]*(?::|$)/.test(host)) return '';
  // 其余 IPv6 字面量：只允许是「冒号分隔的十六进制」，用于排除 ::1 之类的变体
  if (host.includes(':') && /^::(?:1|ffff:)?/i.test(host)) return '';
  if (u.username || u.password) return ''; // 凭据不该出现在 URL 里
  return u.toString();
}

/** 间隔正规化：夹在 [1h, 7d]；缺失/非法回落默认（注意 null 与 0 都算「没设」，不夹到下限） */
function normalizeInterval(sec) {
  if (sec === undefined || sec === null || sec === '') return DEFAULT_INTERVAL_SEC;
  const n = Number(sec);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SEC;
  return Math.min(Math.max(Math.floor(n), MIN_INTERVAL_SEC), MAX_INTERVAL_SEC);
}

// ---------- 发送时机（纯函数） ----------

/**
 * 现在该不该发一次。
 *
 * force=true 只跳过**节奏判断**（间隔/退避），安全相关的判断一个都不跳：
 * enabled、端点合法性仍在下面逐条查。手动发送按钮用的就是这条路。
 *
 * @param {{enabled: boolean, endpoint: string, intervalSec: number}} settings
 * @param {{now: number, lastSentAt: number, failures: number, force?: boolean}} state
 * @returns {{send: boolean, reason: string}}
 */
function shouldSend(settings, state) {
  const s = settings || {};
  if (!s.enabled) return { send: false, reason: 'disabled' };
  if (!normalizeEndpoint(s.endpoint)) return { send: false, reason: 'no-endpoint' };
  const now = Number(state && state.now);
  if (!Number.isFinite(now)) return { send: false, reason: 'no-now' };
  if (state && state.force) return { send: true, reason: '' };
  const interval = normalizeInterval(s.intervalSec) * 1000;
  const last = Number(state && state.lastSentAt) || 0;
  const fails = Number(state && state.failures) || 0;

  // 失败退避与正常间隔是**两条独立的通道**：
  // 上次失败后，重试只等退避时间（5/30/120 分钟），不再叠加一个 24 小时的间隔要求
  // ——否则一次偶然失败就会让这台机器消失整整一天，趋势数据出现假的低谷。
  // 退避到最后一级封顶（不再无限翻倍），于是长期离线的机器每天最多试一次。
  if (fails > 0) {
    const idx = Math.min(fails - 1, BACKOFF_SEC.length - 1);
    return now - last >= BACKOFF_SEC[idx] * 1000
      ? { send: true, reason: '' }
      : { send: false, reason: 'backoff' };
  }
  if (last && now - last < interval) return { send: false, reason: 'too-soon' };
  return { send: true, reason: '' };
}

// ---------- 唯一的 I/O ----------

/**
 * 上报一次。fetchImpl 由调用方注入（测试用假实现）。
 *
 * 契约：**永不抛异常**。失败只通过返回值告知，调用方（面板主流程）不需要 try/catch，
 * 也不需要关心结果——遥测挂了不能影响面板。
 *
 * @returns {Promise<{sent: boolean, reason: string, status: number}>}
 */
async function send(payload, endpoint, opts = {}) {
  const url = normalizeEndpoint(endpoint);
  if (!url) return { sent: false, reason: 'no-endpoint', status: 0 };
  const check = assertPayloadSafe(payload);
  if (!check.ok) return { sent: false, reason: check.reason, status: 0 };

  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) return { sent: false, reason: 'no-fetch', status: 0 };

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `BlockNexus/${payload.panelVer || '0'}`,
        // 共享密钥：接收端据此拒收无密钥的请求（防扫到端口后刷垃圾数据）。
        // 密钥是公开仓库里的固定串——它的作用不是保密，是提高伪造门槛：
        // 攻击者当然能看到它，但**得主动写代码带上它**才能污染数据，
        // 这足以过滤掉绝大多数扫描器与随手脚本的噪音。
        'X-Telemetry-Key': opts.key || TELEMETRY_KEY,
      },
      body: JSON.stringify(payload),
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    const status = Number(res && res.status) || 0;
    return { sent: status >= 200 && status < 300, reason: status >= 200 && status < 300 ? '' : `http-${status}`, status };
  } catch (e) {
    return { sent: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network', status: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- 事实采集（纯函数，平台/配置 → 白名单取值） ----------

/** process.platform → 上报枚举。不认识的统一 'other'，绝不把原始字符串带出去 */
function osOf(platform) {
  const p = String(platform || '').toLowerCase();
  if (p === 'win32' || p === 'win64' || p === 'windows') return 'windows';
  if (p === 'linux' || p === 'freebsd' || p === 'darwin') return p === 'darwin' ? 'other' : 'linux';
  return 'other';
}

function archOf(arch) {
  return oneOf(arch, ARCHS, 'other');
}

/**
 * 功能开关：只取「是否启用」这个布尔。
 * 刻意**不读任何配置值**——domain / baseUrl / host 都是用户填的任意字符串，
 * 读进来就等于把用户的内网拓扑与第三方服务地址带出去了。
 */
function featuresOf(settings) {
  const s = settings || {};
  return {
    ddns: bool(s.ddns && s.ddns.enabled),
    frp: bool(s.frp && s.frp.enabled),
    ai: bool(s.ai && s.ai.enabled),
    // SMTP「启用」= 配齐了主机与账号（与 smtpConfigured() 同义，这里不重复引 api.js）
    smtp: !!(s.smtp && s.smtp.host && s.smtp.user),
    notify: !!(s.notify && (s.notify.offline || s.notify.recovery)),
  };
}

/** 从服务器列表里取出所有远端 Agent 版本（去重由 agentVersions 负责） */
function agentVersOf(servers) {
  if (!Array.isArray(servers)) return [];
  return agentVersions(servers.map((s) => s && s.info && s.info.agentVersion));
}

// ---------- 错误码计数（bounded，供 buildPayload 的 errors 字段） ----------

/**
 * 错误码计数器。只记「code → 次数」，**绝不记文案与参数**——
 * 文案里可能有路径、地址、实例名（历史上确实出现过把 message 带进遥测的事故）。
 *
 * 表满时**淘汰最旧**而不是拒绝服务（与 loginFails 同一思路）：满表丢弃新数据会让
 * 常见错误反而统计不到，那正是遥测最需要看到的部分。
 */
function createErrorTally(limit = 200) {
  const counts = new Map();
  const max = Number.isInteger(limit) && limit > 0 ? limit : 200;
  return {
    bump(code) {
      const k = String(code || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k)) return; // 非法形状不记
      if (counts.has(k)) {
        counts.set(k, Math.min(counts.get(k) + 1, MAX_ERROR_COUNT));
        return;
      }
      if (counts.size >= max) {
        const oldest = counts.keys().next();
        if (!oldest.done) counts.delete(oldest.value);
      }
      counts.set(k, 1);
    },
    snapshot() {
      return Object.fromEntries(counts);
    },
    reset() {
      counts.clear();
    },
  };
}

// ---------- 配置归一化 ----------

/**
 * 遥测设置归一化。与 ddns/frp 的 normalizeConfig 同形状：{ config, error }。
 * 端点非法时返回 error——**不静默存一个坏地址**（否则用户以为关着其实在往外发）。
 */
function normalizeConfig(input, current = {}) {
  const b = input || {};
  const cur = current || {};
  const enabled = b.enabled === undefined ? !!cur.enabled : b.enabled === true || b.enabled === 'true';
  const rawEndpoint = b.endpoint === undefined ? cur.endpoint : String(b.endpoint ?? '').trim();
  const endpoint = normalizeEndpoint(rawEndpoint);
  // 给了端点但解析不出合法的公网 https 地址 → 报错，不静默清空
  if (rawEndpoint && !endpoint) return { config: cur, error: 'settings.telemetry-endpoint-invalid' };
  const config = {
    enabled,
    endpoint,
    intervalSec: normalizeInterval(b.intervalSec === undefined ? cur.intervalSec : b.intervalSec),
    instanceId: str(cur.instanceId, MAX_ID_LEN),
  };
  return { config, error: '' };
}

/** 给前端的设置（GET）：不含任何敏感值，遥测这边本来也没有密钥 */
function publicConfig(cfg) {
  const c = cfg || {};
  return {
    enabled: !!c.enabled,
    endpoint: normalizeEndpoint(c.endpoint),
    intervalSec: normalizeInterval(c.intervalSec),
    hasId: !!str(c.instanceId, MAX_ID_LEN),
  };
}

// ---------- 匿名 ID ----------

/**
 * 生成匿名统计 ID。刻意**不用任何机器指纹**（MAC / 硬盘序列号 / 用户名哈希）：
 * 那些东西的唯一目的就是跨重装追踪，与「匿名」矛盾，合规上也解释不清。
 * randomUUID 不可用时退回随机字节——宁可换个生成方式，也不退化成指纹。
 */
function newInstanceId(cryptoImpl) {
  const c = cryptoImpl || require('crypto');
  try {
    if (typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {}
  return c.randomBytes(16).toString('hex');
}

module.exports = {
  DEFAULTS,
  TELEMETRY_KEY,
  PAYLOAD_VERSION,
  OSES,
  BUCKETS,
  ARCHS,
  KINDS,
  FEATURES,
  BACKOFF_SEC,
  // 取值
  bucket,
  countBucket,
  version,
  errorCounts,
  agentVersions,
  // 事实采集
  osOf,
  archOf,
  featuresOf,
  agentVersOf,
  createErrorTally,
  // 构造与自检
  buildPayload,
  assertPayloadSafe,
  // 配置
  normalizeEndpoint,
  normalizeInterval,
  normalizeConfig,
  publicConfig,
  shouldSend,
  // I/O
  send,
  newInstanceId,
};
