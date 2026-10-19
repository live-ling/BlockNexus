'use strict';
// 动态 DNS：把本机公网 IP 同步到 DNS 服务商（DDNS）。
//
// 分层：
//   · 纯函数（本文件大部分）：地址判定、域名拆分、请求构造、变更判定 —— 全部可单测；
//   · 网络动作（detectIp / applyRecord）：只做"发请求 + 解析结果"，fetch 由调用方注入，
//     测试里可以换成假实现，不需要网络；
//   · 调度与持久化在 panel/api.js（面板设置 + 定时器），这里不碰 config/fs。
//
// 设计参考 ddns-go：取址三选一（接口/网卡/命令）、只有 IP 变化才写记录（避免限流）、
// 未内置的服务商走 Callback 逃生口。

const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');

const PROVIDERS = ['cloudflare', 'dnspod', 'duckdns', 'callback'];
const SOURCES = ['api', 'nic', 'command'];
const DEFAULT_INTERVAL_SEC = 300;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 24 * 3600;
const DEFAULT_TTL = 600;

// 常见二级后缀：域名拆分时不能简单按"最后两段"切（否则 example.com.cn 会被拆坏）
const TWO_LEVEL_SUFFIXES = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au',
  'co.jp', 'or.jp', 'ne.jp',
  'com.tw', 'org.tw', 'com.hk', 'org.hk',
  'com.sg', 'com.br', 'com.tr', 'com.mx',
]);

// 公网 IP 探测接口（按顺序回退；只在 source=api 且用户没自定义 URL 时使用）
const IPV4_ENDPOINTS = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ipv4.icanhazip.com'];
const IPV6_ENDPOINTS = ['https://api64.ipify.org', 'https://ipv6.icanhazip.com', 'https://ifconfig.co/ip'];

const DEFAULTS = {
  enabled: false,
  provider: 'cloudflare',
  domain: '',
  ttl: DEFAULT_TTL,
  intervalSec: DEFAULT_INTERVAL_SEC,
  ipv4: true,
  ipv6: false,
  source: 'api',
  sourceUrl: '',
  sourceIPv6: '',
  command: '',
  cloudflare: { token: '', zoneId: '' },
  dnspod: { id: '', token: '', root: '', line: '默认' },
  duckdns: { token: '' },
  callback: { url: '', body: '' },
};

// ---------- 地址判定 ----------

/** 公网 IPv4（排除私网/回环/链路本地/CGNAT/组播/保留段） */
function isPublicV4(ip) {
  if (net.isIP(String(ip)) !== 4) return false;
  const [a, b] = String(ip).split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // 组播 / 保留
  return true;
}

/** 公网 IPv6（排除回环/ULA/链路本地/组播；IPv4-mapped 按 v4 判定） */
function isPublicV6(ip) {
  const s = String(ip).trim().toLowerCase();
  if (net.isIP(s) !== 6) return false;
  if (s === '::' || s === '::1') return false;
  if (s.startsWith('::ffff:')) return isPublicV4(s.slice(7));
  if (/^f[cd]/.test(s)) return false; // ULA fc00::/7
  if (/^fe[89ab]/.test(s)) return false; // 链路本地 fe80::/10
  if (/^ff/.test(s)) return false; // 组播
  return true;
}

/** 本机网卡里的公网地址（family=4|6），返回 [{iface,address}]；NAT 环境下为空 */
function pickInterfaceIps(ifaces, family = 4) {
  const out = [];
  const want = family === 6 ? ['IPv6', 6] : ['IPv4', 4];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (!a || a.internal) continue;
      if (!want.includes(a.family)) continue;
      const ip = String(a.address || '').split('%')[0]; // 去掉 IPv6 zone id
      if (family === 6 ? isPublicV6(ip) : isPublicV4(ip)) out.push({ iface: name, address: ip });
    }
  }
  return out;
}

/** 从命令输出 / 接口响应里挑出第一个符合 family 的公网 IP；找不到返回 '' */
function parseIpOutput(text, family = 4) {
  const s = String(text || '');
  const candidates = family === 6
    ? s.match(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi) || []
    : s.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  for (const raw of candidates) {
    const ip = raw.trim();
    if (family === 6 ? isPublicV6(ip) : isPublicV4(ip)) return ip;
  }
  return '';
}

// ---------- 域名 ----------

/** 去掉协议/路径/尾点，转小写；空串返回 '' */
function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//i, '').split('/')[0].split('#')[0];
  d = d.replace(/\.$/, '');
  return d;
}

/** 粗校验主机名（与 api.js 的 isValidHost 独立，避免循环依赖）；IP 与单段名直接拒绝给 DDNS 用 */
function isValidDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d || d.length > 253 || net.isIP(d)) return false;
  if (!d.includes('.')) return false; // DDNS 记录必须是 FQDN，不能只写 "mc"
  return d.split('.').every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/**
 * 拆分主域与子域：DNSPod 需要 root + sub，DuckDNS 需要子域。
 * rootHint 由用户显式给出时优先（最可靠）；否则按常见二级后缀推断，失败退回最后两段。
 */
function splitDomain(domain, rootHint = '') {
  const d = normalizeDomain(domain);
  if (!d) return { root: '', sub: '' };
  const hint = normalizeDomain(rootHint);
  if (hint && (d === hint || d.endsWith('.' + hint))) {
    return { root: hint, sub: d === hint ? '@' : d.slice(0, -(hint.length + 1)) };
  }
  const parts = d.split('.');
  if (parts.length <= 2) return { root: d, sub: '@' };
  const last2 = parts.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(last2) && parts.length >= 3) {
    return { root: parts.slice(-3).join('.'), sub: parts.slice(0, -3).join('.') };
  }
  return { root: last2, sub: parts.slice(0, -2).join('.') };
}

// ---------- 通用 ----------

/** 间隔钳制（秒） */
function clampInterval(sec) {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_SEC;
  return Math.min(Math.max(n, MIN_INTERVAL_SEC), MAX_INTERVAL_SEC);
}

/** TTL 钳制（秒） */
function clampTtl(sec) {
  const n = Math.round(Number(sec));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL;
  return Math.min(Math.max(n, 60), 86400);
}

/** 只有记录值真的变了才需要写（DDNS 限流的第一道闸） */
function needsUpdate(lastIp, ip) {
  return String(lastIp || '').trim().toLowerCase() !== String(ip || '').trim().toLowerCase();
}

/** Callback 模板：支持 #{ip} #{domain} #{type} #{ttl} */
function renderCallback(template, vars = {}) {
  return String(template || '').replace(/#\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));
}

// ---------- 服务商请求构造（纯函数） ----------

const CF_API = 'https://api.cloudflare.com/client/v4';
const DNSPOD_API = 'https://dnsapi.cn';

function cfHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function cfZoneQueryUrl(root) {
  return `${CF_API}/zones?name=${encodeURIComponent(root)}&per_page=50`;
}

function cfRecordQueryUrl(zoneId, domain, type) {
  return `${CF_API}/zones/${encodeURIComponent(zoneId)}/dns_records?type=${encodeURIComponent(type)}` +
    `&name=${encodeURIComponent(domain)}&per_page=100`;
}

function cfRecordWriteBody({ type, domain, ip, ttl }) {
  return { type, name: domain, content: ip, ttl: clampTtl(ttl), proxied: false };
}

function dnspodHeaders() {
  return { 'Content-Type': 'application/x-www-form-urlencoded' };
}

function dnspodParams({ id, token, extra = {} }) {
  return new URLSearchParams({
    login_token: `${id},${token}`,
    format: 'json',
    lang: 'cn',
    error_on_empty: 'no',
    ...extra,
  }).toString();
}

function dnspodListBody({ id, token, root, sub, type }) {
  return dnspodParams({ id, token, extra: { domain: root, sub_domain: sub === '@' ? '@' : sub, record_type: type } });
}

function dnspodWriteBody({ id, token, root, sub, type, ip, ttl, line = '默认', recordId = '' }) {
  const extra = {
    domain: root,
    sub_domain: sub === '@' ? '@' : sub,
    record_type: type,
    record_line: line || '默认',
    value: ip,
    ttl: String(clampTtl(ttl)),
  };
  if (recordId) extra.record_id = String(recordId);
  return dnspodParams({ id, token, extra });
}

function duckdnsUrl({ domain, token, ip, family = 4 }) {
  const sub = normalizeDomain(domain).split('.')[0] || '';
  const q = new URLSearchParams({ domains: sub, token: String(token || '') });
  // DuckDNS 只更新与 family 对应的记录：v4 用 ip=，v6 用 ipv6=
  if (ip) q.set(family === 6 ? 'ipv6' : 'ip', ip);
  return `https://www.duckdns.org/update?${q.toString()}`;
}

// ---------- 配置校验 ----------

/** 供 API 返回：敏感字段只回 has* */
function publicConfig(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return {
    enabled: !!c.enabled,
    provider: c.provider,
    domain: c.domain || '',
    ttl: c.ttl,
    intervalSec: c.intervalSec,
    ipv4: !!c.ipv4,
    ipv6: !!c.ipv6,
    source: c.source,
    sourceUrl: c.sourceUrl || '',
    sourceIPv6: c.sourceIPv6 || '',
    command: c.command || '',
    cloudflare: { zoneId: c.cloudflare?.zoneId || '', hasToken: !!c.cloudflare?.token },
    dnspod: { id: c.dnspod?.id || '', root: c.dnspod?.root || '', line: c.dnspod?.line || '默认', hasToken: !!c.dnspod?.token },
    duckdns: { hasToken: !!c.duckdns?.token },
    callback: { url: c.callback?.url || '', body: c.callback?.body || '' },
  };
}

/**
 * 合并 + 校验用户提交的配置。空字符串的凭据表示"保留原值"（与 SMTP 同一约定）。
 * 返回 { config } 或 { error, params }（error 为 error-codes 的 code）。
 */
function normalizeConfig(input = {}, current = {}) {
  const cur = { ...DEFAULTS, ...current };
  const inCloudflare = input.cloudflare || {};
  const inDnspod = input.dnspod || {};
  const inDuckdns = input.duckdns || {};
  const inCallback = input.callback || {};

  const cfg = {
    enabled: input.enabled !== undefined ? !!input.enabled : cur.enabled,
    provider: PROVIDERS.includes(input.provider) ? input.provider : cur.provider,
    domain: normalizeDomain(input.domain !== undefined ? input.domain : cur.domain),
    ttl: clampTtl(input.ttl !== undefined ? input.ttl : cur.ttl),
    intervalSec: clampInterval(input.intervalSec !== undefined ? input.intervalSec : cur.intervalSec),
    ipv4: input.ipv4 !== undefined ? !!input.ipv4 : cur.ipv4,
    ipv6: input.ipv6 !== undefined ? !!input.ipv6 : cur.ipv6,
    source: SOURCES.includes(input.source) ? input.source : cur.source,
    sourceUrl: String(input.sourceUrl !== undefined ? input.sourceUrl : cur.sourceUrl || '').trim(),
    sourceIPv6: String(input.sourceIPv6 !== undefined ? input.sourceIPv6 : cur.sourceIPv6 || '').trim(),
    command: String(input.command !== undefined ? input.command : cur.command || '').trim(),
    cloudflare: {
      token: String(inCloudflare.token || cur.cloudflare?.token || '').trim(),
      zoneId: String(inCloudflare.zoneId !== undefined ? inCloudflare.zoneId : cur.cloudflare?.zoneId || '').trim(),
    },
    dnspod: {
      id: String(inDnspod.id !== undefined ? inDnspod.id : cur.dnspod?.id || '').trim(),
      token: String(inDnspod.token || cur.dnspod?.token || '').trim(),
      root: String(inDnspod.root !== undefined ? inDnspod.root : cur.dnspod?.root || '').trim(),
      line: String(inDnspod.line !== undefined ? inDnspod.line : cur.dnspod?.line || '默认').trim() || '默认',
    },
    duckdns: {
      token: String(inDuckdns.token || cur.duckdns?.token || '').trim(),
    },
    callback: {
      url: String(inCallback.url !== undefined ? inCallback.url : cur.callback?.url || '').trim(),
      body: String(inCallback.body !== undefined ? inCallback.body : cur.callback?.body || ''),
    },
  };

  if (cfg.domain && !isValidDomain(cfg.domain)) return { error: 'network.ddns-domain-invalid' };
  if (!cfg.ipv4 && !cfg.ipv6) return { error: 'network.ddns-ip-family-required' };
  if (cfg.source === 'command' && !cfg.command) return { error: 'network.ddns-command-required' };
  if (cfg.sourceUrl && !/^https?:\/\//i.test(cfg.sourceUrl)) return { error: 'network.ddns-url-invalid' };
  if (cfg.callback.url && !/^https?:\/\//i.test(cfg.callback.url)) return { error: 'network.ddns-url-invalid' };

  if (cfg.enabled) {
    if (!cfg.domain) return { error: 'network.ddns-domain-required' };
    const need = {
      cloudflare: !!cfg.cloudflare.token,
      dnspod: !!cfg.dnspod.id && !!cfg.dnspod.token,
      duckdns: !!cfg.duckdns.token,
      callback: !!cfg.callback.url,
    }[cfg.provider];
    if (!need) return { error: 'network.ddns-credentials-required', params: { provider: cfg.provider } };
  }
  return { config: cfg };
}

// ---------- 网络动作 ----------

/**
 * 执行用户命令取 IP：8 秒超时，输出上限 64KB。
 *
 * 为什么用 `shell: true` 而不是自己拼 cmd /s /c：Windows 上把 "C:\Program Files\node.exe"
 * 这种带引号的程序名交给 cmd 时，`/s` 的引号剥离规则会把外层引号一起吃掉，
 * 结果是「'\"C:\...\"' 不是内部或外部命令」。交给 Node 的 shell 模式处理引号才稳。
 */
function runCommand(command, timeoutMs = 8000) {
  try {
    const r = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return { out: (r.stdout || '') + (r.stderr || ''), error: r.error ? r.error.message : '' };
  } catch (e) {
    return { out: '', error: e.message };
  }
}

/**
 * 取当前公网 IP。返回 { ip, source, detail? , error? }。
 * family=4|6；source=api|nic|command。
 * fetchImpl 可注入，便于测试。
 */
async function detectIp({ family = 4, source = 'api', sourceUrl = '', command = '', ifaces, fetchImpl, timeoutMs = 8000 } = {}) {
  const familyName = family === 6 ? 'IPv6' : 'IPv4';

  if (source === 'nic') {
    const list = pickInterfaceIps(ifaces || os.networkInterfaces(), family);
    if (!list.length) {
      return {
        ip: '',
        source: 'nic',
        error:
          family === 4
            ? '本机没有公网 IPv4（可能处于 NAT/CGNAT，DDNS 对这类网络无效，需要内网穿透）'
            : '本机没有公网 IPv6',
      };
    }
    return { ip: list[0].address, source: 'nic', detail: list[0].iface };
  }

  if (source === 'command') {
    if (!command) return { ip: '', source: 'command', error: '未填写取址命令' };
    const r = runCommand(command);
    const ip = parseIpOutput(r.out, family);
    if (!ip) return { ip: '', source: 'command', error: r.error || `命令输出里没有可用的 ${familyName}` };
    return { ip, source: 'command' };
  }

  const urls = sourceUrl ? [sourceUrl] : family === 6 ? IPV6_ENDPOINTS : IPV4_ENDPOINTS;
  const errors = [];
  for (const url of urls) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await (fetchImpl || fetch)(url, {
        signal: ctrl ? ctrl.signal : undefined,
        headers: { 'User-Agent': 'BlockNexus-ddns' },
      });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      const ip = parseIpOutput(text, family);
      if (ip) return { ip, source: 'api', detail: new URL(url).host };
      errors.push(`${new URL(url).host}: 未返回 ${familyName}`);
    } catch (e) {
      errors.push(`${new URL(url).host}: ${e.name === 'AbortError' ? '超时' : e.message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ip: '', source: 'api', error: `取公网 ${familyName} 失败：${errors.join('；')}` };
}

/** 同时探测 IPv4/IPv6（设置页「检测公网 IP」按钮用） */
async function detectBoth(cfg = {}, opts = {}) {
  const out = { ipv4: null, ipv6: null };
  if (cfg.ipv4 !== false) {
    out.ipv4 = await detectIp({
      family: 4,
      source: cfg.source || 'api',
      sourceUrl: cfg.sourceUrl,
      command: cfg.command,
      ...opts,
    });
  }
  if (cfg.ipv6) {
    out.ipv6 = await detectIp({
      family: 6,
      source: cfg.sourceIPv6 || cfg.source || 'api',
      sourceUrl: cfg.sourceUrl,
      command: cfg.command,
      ...opts,
    });
  }
  return out;
}

function errText(json, fallback) {
  const e = json && (json.error || (Array.isArray(json.errors) && json.errors[0]));
  if (e && typeof e === 'object') return e.message || fallback;
  return e || fallback;
}

/** Cloudflare：查 zone → 查记录 → 有则改、无则建 */
async function applyCloudflare({ cfg, domain, type, ip, ttl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const headers = cfHeaders(cfg.token);
  const json = async (url, init) => {
    const res = await doFetch(url, { headers, ...init });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(`Cloudflare: ${errText(body, 'HTTP ' + res.status)}`);
    return body;
  };
  const { root } = splitDomain(domain);
  let zoneId = cfg.zoneId;
  if (!zoneId) {
    const zones = await json(cfZoneQueryUrl(root));
    const z = (zones.result || [])[0];
    if (!z) throw new Error(`Cloudflare 里找不到域名 ${root}（请检查 Token 权限或手填 Zone ID）`);
    zoneId = z.id;
  }
  const found = await json(cfRecordQueryUrl(zoneId, domain, type));
  const rec = (found.result || [])[0];
  const body = cfRecordWriteBody({ type, domain, ip, ttl });
  if (rec) {
    await json(`${CF_API}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(rec.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { action: 'updated' };
  }
  await json(`${CF_API}/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { action: 'created' };
}

/** DNSPod（传统 dnsapi.cn 接口，ID+Token） */
async function applyDnspod({ cfg, domain, type, ip, ttl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const { root, sub } = splitDomain(domain, cfg.root);
  const post = async (path, body) => {
    const res = await doFetch(`${DNSPOD_API}/${path}`, { method: 'POST', headers: dnspodHeaders(), body });
    const json = await res.json().catch(() => ({}));
    const code = json && json.status && json.status.code;
    if (!res.ok || String(code) !== '1') {
      throw new Error(`DNSPod: ${(json && json.status && json.status.message) || 'HTTP ' + res.status}`);
    }
    return json;
  };
  const listed = await post('Record.List', dnspodListBody({ id: cfg.id, token: cfg.token, root, sub, type }));
  const rec = ((listed.records) || []).find((r) => r && r.type === type) || (listed.records || [])[0];
  if (rec) {
    await post('Record.Modify', dnspodWriteBody({
      id: cfg.id,
      token: cfg.token,
      root,
      sub,
      type,
      ip,
      ttl,
      line: cfg.line,
      recordId: rec.id,
    }));
    return { action: 'updated' };
  }
  await post('Record.Create', dnspodWriteBody({ id: cfg.id, token: cfg.token, root, sub, type, ip, ttl, line: cfg.line }));
  return { action: 'created' };
}

/** DuckDNS：单条 GET，返回 OK 即成功 */
async function applyDuckdns({ cfg, domain, ip, family, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(duckdnsUrl({ domain, token: cfg.token, ip, family }));
  const text = (await res.text()).trim();
  if (!res.ok || !/^OK$/i.test(text)) throw new Error(`DuckDNS 返回：${text || 'HTTP ' + res.status}`);
  return { action: 'updated' };
}

/** 自定义回调：GET（无 body）或 POST，2xx 视为成功 */
async function applyCallback({ cfg, domain, type, ip, ttl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const vars = { ip, domain, type, ttl: clampTtl(ttl) };
  const url = renderCallback(cfg.url, vars);
  const body = cfg.body ? renderCallback(cfg.body, vars) : '';
  const res = await doFetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body || undefined,
  });
  if (!res.ok) throw new Error(`Callback 返回 HTTP ${res.status}`);
  return { action: 'updated' };
}

/** 按 provider 分发写记录 */
async function applyRecord({ provider, cfg = {}, domain, type, ip, ttl, fetchImpl }) {
  switch (provider) {
    case 'cloudflare':
      return applyCloudflare({ cfg: cfg.cloudflare || cfg, domain, type, ip, ttl, fetchImpl });
    case 'dnspod':
      return applyDnspod({ cfg: cfg.dnspod || cfg, domain, type, ip, ttl, fetchImpl });
    case 'duckdns':
      return applyDuckdns({ cfg: cfg.duckdns || cfg, domain, ip, family: type === 'AAAA' ? 6 : 4, fetchImpl });
    case 'callback':
      return applyCallback({ cfg: cfg.callback || cfg, domain, type, ip, ttl, fetchImpl });
    default:
      throw new Error('未知的 DDNS 服务商: ' + provider);
  }
}

module.exports = {
  PROVIDERS,
  SOURCES,
  DEFAULTS,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  isPublicV4,
  isPublicV6,
  pickInterfaceIps,
  parseIpOutput,
  normalizeDomain,
  isValidDomain,
  splitDomain,
  clampInterval,
  clampTtl,
  needsUpdate,
  renderCallback,
  cfHeaders,
  cfZoneQueryUrl,
  cfRecordQueryUrl,
  cfRecordWriteBody,
  dnspodHeaders,
  dnspodListBody,
  dnspodWriteBody,
  duckdnsUrl,
  publicConfig,
  normalizeConfig,
  runCommand,
  detectIp,
  detectBoth,
  applyRecord,
};
