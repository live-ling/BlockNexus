'use strict';
// 「快速添加」的纯逻辑：把用户几乎没填的东西补成一套合法可用的实例参数。
//
// 为什么单独成文件：默认值推导（内存/端口/实例名/版本）全是**可枚举的规则**，
// 放在这里能被 agent/test-quick-create.js 直接单测；panel/api.js 只负责编排
// （SSH 安装、hub 转发、进度日志、SSE 广播），不在这里掺进来。
//
// 约定：所有函数都是纯函数（不碰 fs/网络），入参出参都可序列化。

/** 实例名规则：与 agent/src/util.js 的 NAME_RE **逐字一致**（Agent 侧会再校验一次） */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;
const DEFAULT_PORT = 25565;
const DEFAULT_MOTD = 'A Minecraft Server';
const DEFAULT_NAME = 'survival';
const MEM_MIN = 512;
const MEM_MAX = 32768;
const PORT_MIN = 1024;
const PORT_MAX = 65535;

/**
 * 快速添加只接受「能被 Agent 自动下载」的核心：
 * url / upload 需要用户自己提供 jar 或地址，谈不上「一键」，走原「新建实例」。
 */
const QUICK_SOURCES = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge'];

/** 核心类型是否可用于快速添加 */
function isQuickSource(source) {
  return QUICK_SOURCES.includes(String(source || '').toLowerCase());
}

/**
 * 推荐内存（MB）：物理内存的一半、向下对齐 512MB、上限 8GB，下限 512MB。
 *
 * 与前端「新建实例」弹窗里的「X（推荐）」**必须是同一个公式**——同一个用户在两处
 * 看到不同推荐值会以为是 bug。没有物理内存信息（Agent 还没上线）时退回 2GB。
 */
function recommendMemoryMB(memTotalMB) {
  const total = Number(memTotalMB);
  if (!Number.isFinite(total) || total <= 0) return 2048;
  return Math.max(MEM_MIN, Math.min(8192, Math.floor((total * 0.5) / 512) * 512));
}

/** 已被实例占用的端口集合（只认正整数，脏数据忽略） */
function usedPorts(instances) {
  const set = new Set();
  for (const it of Array.isArray(instances) ? instances : []) {
    const p = Number(it && it.port);
    if (Number.isInteger(p) && p > 0) set.add(p);
  }
  return set;
}

/**
 * 挑端口：优先用期望值；被占用就往上顺延，直到找到空闲的。
 * 已经到处都是实例时也不该直接失败——顺延比报错更符合「一键」的预期。
 */
function pickPort(instances, want = DEFAULT_PORT) {
  const used = usedPorts(instances);
  let start = Number(want);
  if (!Number.isInteger(start) || start < PORT_MIN || start > PORT_MAX) start = DEFAULT_PORT;
  for (let p = start; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  // 极端情况：向上没有了就从下限往上再扫一遍
  for (let p = PORT_MIN; p < start; p++) {
    if (!used.has(p)) return p;
  }
  return null;
}

/** 实例名是否已被占用（同名目录也算——Agent 以目录名为准） */
function nameTaken(instances, name) {
  const n = String(name || '');
  return (Array.isArray(instances) ? instances : []).some((it) => it && String(it.name) === n);
}

/**
 * 挑实例名。
 *
 *   · 用户填了 → 只做格式校验，原样使用。同名实例怎么办由调用方判断
 *     （已就绪 = 复用并启动；没就绪 = 续装，见 api.js 的 quickSetup）。
 *     这里刻意**不**因为重名报错：快速添加必须可重试，而重试时实例往往已经半成品了。
 *   · 用户没填 → 优先续上「名为 survival 但还没就绪」的那个（上次失败/中途退出），
 *     其次 survival / survival-2 / survival-3 …；已就绪的同名实例视为另一台服，另起名字。
 */
function pickName(instances, want = '') {
  const list = Array.isArray(instances) ? instances : [];
  const explicit = String(want || '').trim();
  if (explicit) {
    if (!NAME_RE.test(explicit)) return { error: 'instance.name-invalid' };
    return { name: explicit };
  }
  const def = list.find((it) => it && String(it.name) === DEFAULT_NAME);
  if (def && readyVerdict(def) !== 'ready') return { name: DEFAULT_NAME }; // 续装同一个
  if (!def) return { name: DEFAULT_NAME };
  for (let i = 2; i < 1000; i++) {
    const n = `${DEFAULT_NAME}-${i}`;
    if (!nameTaken(list, n)) return { name: n };
  }
  return { name: DEFAULT_NAME }; // 理论上到不了；真有 999 个同名实例就交给 Agent 报错
}

/**
 * 从核心目录里挑版本：用户指定且存在就用它（带 build），否则用该核心的最新版。
 *
 * 目录结构见 panel/api.js 的 /servers/:id/cores：`{ catalogs: { paper: { ok, versions: [{id, build?}] } } }`。
 * 拿不到目录（ok=false / 空清单）时返回 error —— 这时硬塞一个版本号去下载，
 * 失败信息会变成「下载 404」，比直接说「拉不到版本清单」难排查得多。
 */
function pickVersion(catalogs, source, want = '') {
  const cat = catalogs && catalogs.catalogs ? catalogs.catalogs[source] : catalogs && catalogs[source];
  const versions = cat && cat.ok && Array.isArray(cat.versions) ? cat.versions : null;
  if (!versions || versions.length === 0) {
    return { error: 'instance.quick-catalog-missing', params: { source } };
  }
  const wanted = String(want || '').trim();
  if (wanted) {
    const hit = versions.find((v) => v && String(v.id) === wanted);
    if (!hit) return { error: 'instance.quick-version-invalid', params: { version: wanted } };
    return { version: String(hit.id), build: String(hit.build || '') };
  }
  const first = versions[0];
  return { version: String(first.id), build: String(first.build || '') };
}

/**
 * 规范化用户输入 → 实例创建参数。
 * ctx: { memTotalMB } 物理内存（Agent 上线信息里的值；没有则按 2GB）
 *
 * 返回 { params } 或 { error, params? }。params 里**不含**最终 name/port/version
 * ——那三项要先拿到 Agent 的实例列表与核心目录才能定（见 pickName/pickPort/pickVersion）。
 */
function normalizeOptions(input = {}, ctx = {}) {
  const rawSource = String(input.source || 'paper').trim().toLowerCase();
  if (!isQuickSource(rawSource)) {
    return { error: 'instance.quick-source-invalid', params: { source: rawSource || '-' } };
  }

  const memoryMB =
    Number(input.memoryMB) > 0 ? Math.round(Number(input.memoryMB)) : recommendMemoryMB(ctx.memTotalMB);
  if (!Number.isFinite(memoryMB) || memoryMB < MEM_MIN || memoryMB > MEM_MAX) {
    return { error: 'instance.quick-memory-range' };
  }

  const port = input.port === undefined || input.port === null || input.port === '' ? DEFAULT_PORT : Number(input.port);
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    return { error: 'instance.quick-port-range' };
  }

  const name = String(input.name || '').trim();
  if (name && !NAME_RE.test(name)) return { error: 'instance.name-invalid' };

  // onlineMode 接受 boolean 与 'true'/'false' 两种写法（前端 Select 给的是字符串）
  const onlineMode = input.onlineMode === undefined ? true : !(input.onlineMode === false || input.onlineMode === 'false');
  const motd = String(input.motd === undefined || input.motd === null ? DEFAULT_MOTD : input.motd).slice(0, 100);

  return {
    params: {
      source: rawSource,
      memoryMB,
      port,
      name,
      onlineMode,
      motd,
      version: String(input.version || '').trim(),
    },
  };
}

/**
 * 轮询实例状态直到「就绪」的判定（纯函数，方便单测）。
 * 返回 'wait' | 'ready' | 'failed'。
 *
 * installState 在列表里不直接暴露，只能由 status 推断：
 *   downloading（下载中）/ incomplete（下载完了但核心文件不在）→ 都算没就绪
 *   stopped（核心就位且没在跑）/ running / starting → 就绪
 *   failed → 失败（错误原因在 rec.error）
 */
function readyVerdict(rec) {
  if (!rec) return 'wait';
  const st = String(rec.status || '');
  if (st === 'failed') return 'failed';
  if (st === 'stopped' || st === 'running' || st === 'starting') return 'ready';
  return 'wait';
}

/**
 * 是否「同一个实例已经就绪」（重试快速添加时的幂等判断）：
 * 同名实例已存在且核心就位 → 直接复用它，不再重复创建。
 */
function reusableInstance(rec) {
  return !!rec && readyVerdict(rec) === 'ready';
}

/**
 * MC 版本 → 需要的 Java 主版本。
 *
 * 依据 Mojang/各核心的官方要求：
 *   1.20.5+（含 1.21.x）→ 21；1.18 – 1.20.4 → 17；1.17 → 16；更早 → 8。
 * 只用于「全新的机器上自动装一个能跑的 Java」，装的是刚好够用的版本——
 * 已有更高版本的 Java 时不会降级（调用方只判断 `已装 >= 需要`）。
 */
function javaMajorFor(version) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version || '').trim());
  if (!m) return 21; // 解析不出来（快照/自定义名）就按最新要求来，宁高勿低
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = m[3] === undefined ? 0 : Number(m[3]);
  // 1.20.5+ / 1.21+ —— 老版本号里 1.x 才需要逐段比较
  if (major > 1) return 21;
  if (minor > 20) return 21;
  if (minor === 20) return patch >= 5 ? 21 : 17;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

module.exports = {
  NAME_RE,
  DEFAULT_PORT,
  DEFAULT_NAME,
  QUICK_SOURCES,
  isQuickSource,
  recommendMemoryMB,
  pickPort,
  pickName,
  pickVersion,
  javaMajorFor,
  normalizeOptions,
  readyVerdict,
  reusableInstance,
};
