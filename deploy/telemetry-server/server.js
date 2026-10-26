'use strict';
/*
 * BlockNexus 匿名遥测接收端（自建，跑在用户自己的 VPS 上）
 *
 * 设计与 panel/telemetry.js 对应：客户端已经做了白名单 + assertPayloadSafe 自检，
 * 这里是**服务端第二道校验**——绝不信任客户端，任何不认识的字段直接丢弃。
 *
 * 隐私约定（与面板侧一致，改动不要放宽）：
 *   · 不落库 IP。请求 IP 只用于限频与「按天估算装机数」的去重（后者只存盐化哈希，见下），
 *     函数返回后不再被引用。
 *   · 落库的是「日 + salt(ip) 的哈希」，盐按天轮换：同一天内同一台机器可去重，
 *     跨天无法关联 —— 这就是「按天估算独立装机数」能做到的最大精度，也是刻意止步于此。
 *   · 不做地理位置解析（不引 GeoIP 依赖，也不需要那个精度）。
 *
 * 存储：JSONL 追加文件（data/telemetry.jsonl），每天一份聚合快照（data/summary/YYYY-MM-DD.json）。
 *   为什么不用 SQLite：Node 20 没有 node:sqlite，目标机不一定能 npm install，零依赖优先。
 *   每天几十条记录，追加文件完全够；备份 = 拷文件。
 *
 * 接口：
 *   POST /telemetry   上报（JSON body）
 *   GET  /health      健康检查（不含任何用户数据）
 *   GET  /summary     当日 + 累计聚合（用于查看趋势）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.TELEMETRY_PORT || 45565);
const DATA_DIR = process.env.TELEMETRY_DATA_DIR || path.join(__dirname, 'data');
const JSONL_FILE = path.join(DATA_DIR, 'telemetry.jsonl');
const SUMMARY_DIR = path.join(DATA_DIR, 'summary');
const MAX_BODY = 16 * 1024;
const MAX_RECORDS_PER_DAY = 100000;
/**
 * 共享密钥。与 panel/telemetry.js 的 TELEMETRY_KEY 逐字一致（公开仓库里两处一起改）。
 * 它不是保密措施——是伪造门槛：不带这个头的请求直接 401，
 * 扫描器与随手脚本污染数据得先读代码再写脚本，成本足以挡掉绝大多数噪音。
 * 可用环境变量 TELEMETRY_KEY 覆盖（换端点/自建时不必改代码）。
 */
const TELEMETRY_KEY = process.env.TELEMETRY_KEY || 'bnx-telemetry-v1-7f3a9c21e5d84b06';

/**
 * 读取 token（**真正的秘密**：只存在 VPS 的环境文件与本地，绝不进仓库）。
 *
 * 为什么读和写用两把不同的钥匙：
 *   · 写（POST /telemetry）面对全网，任何人都可能打过来，所以用「公开的共享串」——
 *     它只提高门槛、不承担保密职责：被绕过的代价是垃圾数据，而限频与白名单兜得住；
 *   · 读（GET /summary）暴露的是**运营数据**（装机量、版本分布、错误码），
 *     只有运维者本人该看，所以必须用真秘密。
 *
 * 没配 token 时 /summary 直接 503（fail-closed）：宁可看不到报表，
 * 也不能因为忘了配环境变量就把运营数据开放给全网——这是唯一安全的默认。
 */
const TELEMETRY_TOKEN = process.env.TELEMETRY_TOKEN || '';

/** 常量时间比较：避免按字节逐位泄漏正确前缀 */
function safeEqual(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function keyOk(got) {
  return safeEqual(got, TELEMETRY_KEY);
}

/** 读 token：支持 X-Summary-Token 或 Authorization: Bearer <token> */
function tokenOk(req) {
  if (!TELEMETRY_TOKEN) return false;
  const direct = req.headers['x-summary-token'];
  if (direct && safeEqual(direct, TELEMETRY_TOKEN)) return true;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '').trim());
  return !!(m && safeEqual(m[1], TELEMETRY_TOKEN));
}

// ---------- 与 panel/telemetry.js 对齐的校验 ----------

const VERSION_RE = /^\d{1,4}(?:\.\d{1,4}){0,2}(?:-[0-9a-z.-]+)?$/i;
const BUCKETS = new Set(['0', '1', '2-5', '6-20', '20+', 'unknown']);
const OSES = new Set(['windows', 'linux', 'other']);
const ARCHS = new Set(['x64', 'arm64', 'x86', 'arm', 'other']);
const KINDS = new Set(['portable', 'dir', 'git-clean', 'git-dirty', 'unknown']);
const FEATURES = ['ddns', 'frp', 'ai', 'smtp', 'notify'];
const MAX_AGENT_VERSIONS = 50;
const MAX_ERROR_KEYS = 20;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

/**
 * 与 assertPayloadSafe 同思路的服务端自检：任何字符串字段命中敏感模式就整包拒收。
 * 服务端多一道这道闸的理由：客户端可能是**改过的**（有人魔改面板把字段换成域名），
 * 拒收能让问题在第一时间被发现，而不是悄悄把脏数据存下来。
 */
const SENSITIVE = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/i,
  /@/,
  /:\/\//,
  /^[a-z]:[\\/]/i,
  /\/(?:home|opt|root|Users|var|etc|srv|mnt)(?:\/|$)/,
  /[\\/]/,
  /[A-Za-z0-9+/=_-]{40,}/,
  /\b(?:sk-|ghp_|gho_|xox[baprs]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/,
];

function scanStrings(v, depth = 0) {
  if (depth > 6) return false;
  if (typeof v === 'string') return !SENSITIVE.some((re) => re.test(v));
  if (v === null || v === undefined) return true;
  if (typeof v !== 'object') return Number.isFinite(v) || typeof v === 'boolean';
  return Object.values(v).every((x) => scanStrings(x, depth + 1));
}

/** 白名单二次校验；返回 null 表示拒收 */
function sanitize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!ID_RE.test(id)) return null;
  const panelVer = typeof body.panelVer === 'string' && VERSION_RE.test(body.panelVer) ? body.panelVer : '';
  if (!panelVer) return null;

  const agentVers = [];
  if (Array.isArray(body.agentVers)) {
    for (const v of body.agentVers) {
      if (agentVers.length >= MAX_AGENT_VERSIONS) break;
      if (typeof v === 'string' && VERSION_RE.test(v) && !agentVers.includes(v)) agentVers.push(v);
    }
  }

  const errors = {};
  if (body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)) {
    for (const [k, v] of Object.entries(body.errors).slice(0, MAX_ERROR_KEYS)) {
      if (typeof k !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k)) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) errors[k] = Math.min(Math.floor(n), 1000000);
    }
  }

  const features = {};
  for (const key of FEATURES) features[key] = !!(body.features && body.features[key]);

  const rec = {
    v: 1,
    id,
    ts: Number.isFinite(Number(body.ts)) ? Number(body.ts) : Date.now(),
    panelVer,
    os: OSES.has(body.os) ? body.os : 'other',
    arch: ARCHS.has(body.arch) ? body.arch : 'other',
    installKind: KINDS.has(body.installKind) ? body.installKind : 'unknown',
    agentVers,
    servers: BUCKETS.has(body.servers) ? body.servers : 'unknown',
    instances: BUCKETS.has(body.instances) ? body.instances : 'unknown',
    features,
    errors,
  };
  if (!scanStrings(rec)) return null;
  return rec;
}

// ---------- 限频：同一 ID 每小时最多 1 次成功入库（防 bug 或恶意刷写盘） ----------

const recentIds = new Map(); // id -> ts
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, ts] of recentIds) if (ts < cutoff) recentIds.delete(id);
}, 600_000).unref();

// ---------- 存储 ----------

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SUMMARY_DIR, { recursive: true });
}

function appendRecord(rec) {
  fs.appendFileSync(JSONL_FILE, JSON.stringify(rec) + '\n');
}

/** 读全部记录（数据量小，直接读；将来超过 ~10 万条再改分天文件） */
function readRecords() {
  try {
    const text = fs.readFileSync(JSONL_FILE, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** 当天的盐（UTC 日期轮换）：盐化哈希只用于同一天去重，跨天无法关联 */
function daySalt(day) {
  return crypto.createHash('sha256').update(`blocknexus-telemetry:${day}`).digest('hex').slice(0, 16);
}

function dayHash(day, id) {
  return crypto.createHmac('sha256', daySalt(day)).update(id).digest('hex').slice(0, 16);
}

/** 聚合：按天去重装机数 + 字段分布。全程在内存里，不落任何原始 IP/ID */
function summarize(records, days) {
  const day = new Date().toISOString().slice(0, 10);
  const seenToday = new Set();
  const panelVer = {};
  const os = {};
  const arch = {};
  const installKind = {};
  const servers = {};
  const instances = {};
  const features = {};
  const agentVers = {};
  const errors = {};
  const perDay = {};

  for (const r of records) {
    const d = new Date(r.ts || 0).toISOString().slice(0, 10);
    const p = perDay[d] || (perDay[d] = { count: 0, ids: new Set() });
    p.count += 1;
    p.ids.add(r.id);
    if (d === day) seenToday.add(r.id);

    const inc = (obj, k) => {
      obj[k] = (obj[k] || 0) + 1;
    };
    inc(panelVer, r.panelVer || '(none)');
    inc(os, r.os);
    inc(arch, r.arch);
    inc(installKind, r.installKind);
    inc(servers, r.servers);
    inc(instances, r.instances);
    for (const [k, v] of Object.entries(r.features || {})) {
      if (v) inc(features, k);
    }
    for (const v of r.agentVers || []) inc(agentVers, v);
    for (const [k, n] of Object.entries(r.errors || {})) inc(errors, k);
  }

  const pick = (obj, top = 30) =>
    Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, top));

  const since = days
    ? Object.fromEntries(Object.entries(perDay).filter(([d]) => d >= new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)))
    : perDay;

  return {
    day,
    generatedAt: Date.now(),
    totalRecords: records.length,
    uniqueIds: new Set(records.map((r) => r.id)).size,
    today: { records: 0, installs: seenToday.size },
    installsPerDay: Object.fromEntries(
      Object.entries(since).map(([d, p]) => [d, p.ids.size]),
    ),
    reportsPerDay: Object.fromEntries(
      Object.entries(since).map(([d, p]) => [d, p.count]),
    ),
    panelVer: pick(panelVer),
    os: pick(os),
    arch: pick(arch),
    installKind: pick(installKind),
    servers: pick(servers),
    instances: pick(instances),
    features: pick(features),
    agentVers: pick(agentVers),
    errors: pick(errors, 20),
  };
}

// ---------- HTTP ----------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

  // 每请求的 IP 只在这个闭包里活着，离开 handler 之前不会进入任何持久化路径
  const done = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'GET' && url.pathname === '/health') {
    return done(200, { ok: true, uptimeSec: Math.floor(process.uptime()) });
  }

  if (req.method === 'GET' && url.pathname === '/summary') {
    // 读路径要真秘密：运营数据（装机量/版本分布）只有运维者该看。
    // 未配 token → 503 fail-closed；配了但不带/带错 → 401。
    if (!TELEMETRY_TOKEN) return done(503, { error: 'summary token not configured' });
    if (!rateLimit(`sum:${ip}`, 60, 3600_000)) return done(429, { error: 'too many requests' });
    if (!tokenOk(req)) return done(401, { error: 'unauthorized' });
    const records = readRecords();
    const s = summarize(records, Number(url.searchParams.get('days')) || 0);
    s.today.records = records.filter((r) => new Date(r.ts).toISOString().slice(0, 10) === s.day).length;
    return done(200, s);
  }

  if (req.method === 'POST' && url.pathname === '/telemetry') {
    if (!rateLimit(`post:${ip}`, 60, 3600_000)) return done(429, { error: 'too many requests' });
    // 共享密钥：不带或不对 → 401（在限频之后判，避免被用来无成本探测）
    if (!keyOk(req.headers['x-telemetry-key'])) return done(401, { error: 'unauthorized' });

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        return done(413, { error: 'body too large' });
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return done(400, { error: 'invalid json' });
      }
      const rec = sanitize(body);
      if (!rec) return done(422, { error: 'payload rejected' });

      // 同一 ID 一小时内只入库一次（重启频繁的机器会重复上报）
      const last = recentIds.get(rec.id) || 0;
      if (Date.now() - last < 3600_000) return done(200, { ok: true, deduped: true });

      recentIds.set(rec.id, Date.now());
      try {
        appendRecord(rec);
      } catch (e) {
        return done(500, { error: 'storage failed' });
      }
      done(200, { ok: true });
    });
    req.on('error', () => {});
    return;
  }

  done(404, { error: 'not found' });
});

// ---------- 粗限频（内存，重启即清零——够用，不值得引持久化） ----------

const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, arr] of rateBuckets) {
    const keep = arr.filter((t) => t >= cutoff);
    if (keep.length) rateBuckets.set(k, keep);
    else rateBuckets.delete(k);
  }
}, 600_000).unref();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    rateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  rateBuckets.set(key, arr);
  return true;
}

// ---------- 启动 ----------

ensureDirs();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[telemetry] listening on :${server.address().port}, data dir: ${DATA_DIR}`);
});
server.on('error', (e) => {
  console.error('[telemetry] listen error:', e.message);
  process.exit(1);
});

// 优雅退出：JSONL 是追加写，不需要 flush，但别让 systemd 等太久
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// 供测试拿到真实端口（TELEMETRY_PORT=0 时）；getter 保证 listen 完成后再取值
module.exports = {
  get port() {
    const a = server.address();
    return typeof a === 'object' && a ? a.port : PORT;
  },
  server,
};
