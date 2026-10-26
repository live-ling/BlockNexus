'use strict';
// 面板自更新：纯逻辑层 + 唯一的探测 I/O
//
// 为什么要独立成模块：更新的判定（能不能升、该不该升、升之前要迁移什么、换哪些文件、
// 失败要不要回滚）全是**决策**，而决策出错比 IO 出错更难发现——它们必须能在没有网络、
// 没有真面板的情况下被单测钉住（见 agent/test-panel-update.js）。
// 因此本文件除 probeInstallKind() 之外**不做任何 IO**：
//   · 下载/解压/替换/重启在 scripts/panel-updater.js（执行器，独立进程）
//   · 接口、状态机、广播在 panel/api.js
//   · 启动时把 kind 算一次塞进 createApi 的 opts，在 panel/server.js
//
// 安全默认（本文件的中心思想）：**任何拿不准的情况都按「不许自动升、必须人工确认」处理**。
//   元数据缺失/非法 → severity=recommended + breaking=true（人工确认）
//   git 状态探测不出来 → 视为不可自更新（宁可不升级，也不覆盖别人的工作区）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---------- 资产命名（发布脚本、接口、更新器、测试共用，避免各写一份字符串） ----------

const ASSET = {
  app: (v) => `BlockNexus-v${v}-app.zip`,
  portable: (v) => `BlockNexus-v${v}-portable.zip`,
  shell: (v) => `BlockNexus-shell-v${v}.zip`,
  meta: 'update.json',
  sums: 'SHA256SUMS.txt',
  sig: 'update.json.sig',
};

// ---------- 版本比较（从 panel/api.js 上移，保持行为逐字一致） ----------

/**
 * 三段版本号比较：a 是否大于 b（忽略 v 前缀与后缀）。
 *
 * 与旧实现的差别（旧版在 api.js 里，已上移并修正）：
 *   · 缺段按 0 补：`0.6.0` 与 `0.6` 相等（旧实现把它判成 0.6.0 更大，会在两段版本号的
 *     Release 标签上误报"有新版本"）
 *   · 预发布段低于正式段：`0.6.0-beta` < `0.6.0`（旧实现按字典序，方向不定）
 * 三段数字版本（本项目的实际情形）行为与旧实现逐字一致。
 */
function semverGreater(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.\-+]/);
  const pb = String(b).replace(/^v/i, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i];
    const sb = pb[i];
    const na = sa === undefined || sa === '' ? 0 : Number(sa);
    const nb = sb === undefined || sb === '' ? 0 : Number(sb);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) {
      if (na !== nb) return na > nb;
      continue;
    }
    // 一边是数字段、一边不是：数字段更大（0.6.0 > 0.6.0-beta）
    if (aNum !== bNum) return aNum;
    const s = String(sa ?? '').localeCompare(String(sb ?? ''));
    if (s) return s > 0;
  }
  return false;
}

/** 'v0.6.0' → [0,6,0]；非法返回 null（缺段按 0 补） */
function normalizeVersion(v) {
  const s = String(v ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0];
  if (!/^\d+(\.\d+)*$/.test(s)) return null;
  return s.split('.').map((n) => Number(n));
}

/** 版本号是否「严格新于」另一个 */
function isNewer(candidate, current) {
  if (!normalizeVersion(candidate)) return false;
  if (!normalizeVersion(current)) return true; // 当前版本读不出来时不拦（部署异常场景）
  return semverGreater(candidate, current);
}

// ---------- 安装形态 ----------

const KIND_PORTABLE = 'portable';
const KIND_DIR = 'dir';
const KIND_GIT_CLEAN = 'git-clean';
const KIND_GIT_DIRTY = 'git-dirty';
const KIND_UNKNOWN = 'unknown';

/** 纯函数：由已探测到的事实决定安装形态（探测在 probeInstallKind） */
function resolveInstallKind(facts) {
  const f = facts || {};
  if (f.markerKind === KIND_PORTABLE && !f.hasGit) return KIND_PORTABLE;
  if (f.hasGit) {
    if (f.gitClean === true) return KIND_GIT_CLEAN;
    // git 脏工作区 / 探测不出（没装 git、不是仓库）：一律不许自更新
    if (f.gitClean === false) return KIND_GIT_DIRTY;
    return KIND_UNKNOWN;
  }
  if (f.hasServerJs && f.hasWebDist) return KIND_DIR;
  return KIND_UNKNOWN;
}

/** 形态 → 能否自更新 + 不能的原因（i18n key） */
function describeKind(kind, facts) {
  switch (kind) {
    case KIND_PORTABLE:
    case KIND_DIR:
    case KIND_GIT_CLEAN:
      return { canSelfUpdate: true, reasonKey: '' };
    case KIND_GIT_DIRTY:
      return { canSelfUpdate: false, reasonKey: 'update.disabled-dirty' };
    case KIND_UNKNOWN:
      // 有 .git 但状态探测不出来（没装 git / 被安全软件拦 / 不是真仓库）：
      // 与「普通未知目录」分开报，否则会给用户一个误导性的"请下载便携包"
      return {
        canSelfUpdate: false,
        reasonKey: facts && facts.hasGit ? 'update.disabled-git-unknown' : 'update.disabled-unknown',
      };
    default:
      return { canSelfUpdate: false, reasonKey: 'update.disabled-unknown' };
  }
}

/**
 * 形态 → **实际应用方式**：git-clean 走 git，其余走 payload。
 *
 * 这是与 planUpgrade 的 direct/bridge/manual **正交**的另一个维度：
 * 「能不能跳」看版本/数据，`怎么换文件`看形态。早期把两者塞进同一个 mode 字段，
 * 导致 `pre.mode === 'git'` 永远不成立（git 安装实际被 payload 覆盖，工作区变脏）。
 */
function applyModeFor(kind) {
  return kind === KIND_GIT_CLEAN ? 'git' : 'payload';
}

function readInstallMarker(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'install.json'), 'utf8'));
    if (raw && raw.kind === KIND_PORTABLE) return { kind: KIND_PORTABLE, version: String(raw.version || '') };
  } catch {
    // 没有 / 坏掉都按「不是便携包」处理
  }
  return null;
}

/** git 工作区是否干净；探测失败返回 null（调用方按不可更新处理） */
function probeGitClean(root, opts = {}) {
  try {
    const r = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: opts.timeout || 8000,
      windowsHide: true,
    });
    if (r.error || typeof r.status !== 'number' || r.status !== 0) return null;
    return String(r.stdout || '').trim() === '';
  } catch {
    return null;
  }
}

/**
 * 探测安装形态（本文件唯一的 IO）。
 * 判定顺序与理由见 README「面板更新」一节：便携包标记优先，其次 git 工作区，最后普通目录。
 */
function probeInstallKind(root, opts = {}) {
  const marker = readInstallMarker(root);
  const hasGit = fs.existsSync(path.join(root, '.git'));
  const facts = {
    markerKind: marker ? marker.kind : '',
    hasGit,
    gitClean: hasGit ? probeGitClean(root, opts) : null,
    hasServerJs: fs.existsSync(path.join(root, 'panel', 'server.js')),
    hasWebDist: fs.existsSync(path.join(root, 'web', 'dist', 'index.html')),
  };
  const kind = resolveInstallKind(facts);
  return { kind, markerVersion: marker ? marker.version : '', facts, ...describeKind(kind, facts) };
}

// ---------- 发布元数据 ----------

const SEVERITIES = ['security', 'critical', 'recommended', 'optional'];

/**
 * 元数据缺失/非法时的**安全默认**：按「建议更新 + 必须人工确认」处理。
 * breaking 置真不是「一定有破坏性变更」，而是「发布方没声明，不许自动应用」。
 */
const META_DEFAULTS = Object.freeze({
  schema: 1,
  version: '',
  severity: 'recommended',
  autoSafe: false,
  breaking: true,
  requiresAgentReinstall: false,
  minSourceVersion: '',
  bridge: [],
  dataSchema: 1,
  minSchema: 1,
  irreversible: false,
  minNode: 18,
  lockHash: '',
  shellHash: '',
  files: Object.freeze({}),
  summary: '',
  notesUrl: '',
});

function cleanText(v, max) {
  return String(v ?? '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .trim()
    .slice(0, max);
}

function cleanHash(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : '';
}

function cleanUrl(v) {
  const s = cleanText(v, 500);
  return /^https:\/\/[^\s]+$/i.test(s) ? s : '';
}

function cleanSchemaNumber(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : fallback;
}

/**
 * 解析 release 的 update.json。**这是外部输入**（GitHub 资产），必须防御式：
 * 类型不对就当没有、字符串清洗长度、URL 只收 https、哈希只收 64 位十六进制。
 * 返回 { ok, missing, meta }：ok=false 时 meta 是安全默认（绝不抛异常给调用方）。
 */
function parseUpdateMeta(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, missing: false, meta: { ...META_DEFAULTS } };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, missing: raw === undefined || raw === null, meta: { ...META_DEFAULTS } };
  }
  const version = cleanText(obj.version, 40);
  if (!normalizeVersion(version)) {
    return { ok: false, missing: false, meta: { ...META_DEFAULTS } };
  }
  const bridge = Array.isArray(obj.bridge)
    ? [...new Set(obj.bridge.map((v) => cleanText(v, 40)).filter((v) => !!normalizeVersion(v)))].slice(0, 8)
    : [];
  // files：资产名 → SHA256（Ed25519 签名把这份映射一起签掉）。名字只收安全字符，
  // 哈希只收 64 位十六进制；其余一律丢弃（外部输入，不能让它影响路径/匹配）。
  const files = {};
  if (obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files)) {
    for (const [name, hash] of Object.entries(obj.files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)) continue;
      const h = cleanHash(hash);
      if (h) files[name] = h;
    }
  }
  const meta = {
    schema: cleanSchemaNumber(obj.schema, 1),
    version,
    severity: SEVERITIES.includes(obj.severity) ? obj.severity : 'recommended',
    autoSafe: obj.autoSafe === true,
    // 未显式声明 breaking 时按「有破坏性」处理（安全默认）
    breaking: obj.breaking !== false,
    requiresAgentReinstall: obj.requiresAgentReinstall === true,
    minSourceVersion: normalizeVersion(obj.minSourceVersion) ? cleanText(obj.minSourceVersion, 40) : '',
    bridge,
    dataSchema: cleanSchemaNumber(obj.dataSchema, 1),
    minSchema: cleanSchemaNumber(obj.minSchema, 1),
    irreversible: obj.irreversible === true,
    minNode: cleanSchemaNumber(obj.minNode, 18),
    lockHash: cleanHash(obj.lockHash),
    shellHash: cleanHash(obj.shellHash),
    files,
    summary: cleanText(obj.summary, 500),
    notesUrl: cleanUrl(obj.notesUrl),
  };
  if (meta.minSchema > meta.dataSchema) meta.minSchema = meta.dataSchema;
  return { ok: true, missing: false, meta };
}

/**
 * 元数据缺失/非法时，用 Release tag 合成一份**安全默认**。
 *
 * 为什么需要它：0.6.0 及更早的 Release 没有 update.json（线上真实存在），而
 * `planUpgrade` 对 `meta.version` 非法是一律拒绝的 → 用户永远只能手动装。
 * 合成后的 meta 仍然 `breaking=true`、`autoSafe=false`，所以只会退化成
 * 「可直跳 + 必须人工确认」，不会变成「自动升级」。
 *
 * @returns {{meta: object, metaMissing: boolean, filled: boolean}}
 */
function fillMetaFromTag(meta, tag) {
  if (meta && typeof meta === 'object' && normalizeVersion(meta.version)) {
    return { meta, metaMissing: false, filled: false };
  }
  const t = String(tag || '').trim().replace(/^v/i, '');
  if (!normalizeVersion(t)) return { meta: { ...META_DEFAULTS }, metaMissing: true, filled: false };
  return {
    meta: { ...META_DEFAULTS, version: t, breaking: true, autoSafe: false },
    metaMissing: true,
    filled: true,
  };
}

/** 从 release.assets 里按名字挑资产（GitHub 的 assets[].name / browser_download_url） */
function pickAsset(assets, name) {
  if (!Array.isArray(assets) || !name) return null;
  const hit = assets.find((a) => a && a.name === name);
  if (!hit || !hit.browser_download_url) return null;
  const size = Number(hit.size);
  return {
    name: hit.name,
    url: String(hit.browser_download_url),
    size: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/** 解析 SHA256SUMS.txt：`<64hex>  <name>`（兼容 `*name` 与多余空格） */
function parseChecksums(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) continue;
    out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

/** 取某个资产的期望哈希；拿不到就是 null（调用方必须**拒绝更新**，不做「无可校验则放行」） */
function expectedHash(checksums, assetName) {
  if (!checksums || !assetName) return null;
  return checksums[assetName] || null;
}

// ---------- 升级计划 ----------

const KIND_DIRECT = 'direct';
const KIND_BRIDGE = 'bridge';
const KIND_MANUAL = 'manual';

/**
 * 从本地版本/schema 与目标元数据算出「能不能升、怎么升、要迁移什么」。
 * 纯函数：不触碰磁盘，便于把跨版本矩阵钉进单测。
 */
function planUpgrade({ localVersion, localSchema, meta, currentNode } = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) ;
  const warnings = [];
  const out = {
    allowed: false,
    mode: KIND_MANUAL,
    bridgeVersion: '',
    reasonKey: '',
    warnings,
    migrations: [],
    needsFullPackage: false,
    irreversible: m.irreversible === true,
    requiresAgentReinstall: m.requiresAgentReinstall === true,
    metaMissing: false,
  };

  if (!normalizeVersion(m.version)) {
    out.reasonKey = 'update.meta-invalid';
    return out;
  }
  if (localVersion && !isNewer(m.version, localVersion)) {
    out.reasonKey = 'update.version-not-newer';
    return out;
  }
  // Node 版本不够：完整包（便携版）会自带运行时，源码/git 形态才需要拦
  const needNode = Number(m.minNode) || 0;
  const curNode = Number(String(currentNode || process.versions.node).split('.')[0]) || 0;
  if (needNode && curNode && curNode < needNode) {
    out.reasonKey = 'update.node-too-old';
    out.warnings.push('update.node-too-old');
    return out;
  }
  if (m.breaking === true) warnings.push('update.warn-breaking');
  if (m.irreversible === true) warnings.push('update.warn-irreversible');
  if (m.requiresAgentReinstall === true) warnings.push('update.warn-agent-reinstall');

  // 跨版本判定：源版本低于 minSourceVersion，或本地数据 schema 低于本版迁移链的起点
  const srcTooOld =
    !!normalizeVersion(m.minSourceVersion) &&
    !!normalizeVersion(localVersion) &&
    semverGreater(m.minSourceVersion, localVersion);
  const schemaTooOld =
    Number.isInteger(localSchema) && localSchema >= 1 && localSchema < Number(m.minSchema || 1);

  if (srcTooOld || schemaTooOld) {
    if (Array.isArray(m.bridge) && m.bridge.length) {
      out.allowed = true;
      out.mode = KIND_BRIDGE;
      out.bridgeVersion = m.bridge[0];
      out.reasonKey = 'update.needs-bridge';
      return out;
    }
    out.allowed = false;
    out.mode = KIND_MANUAL;
    out.reasonKey = 'update.needs-manual';
    return out;
  }

  // 迁移项：localSchema+1 .. dataSchema
  const to = Number(m.dataSchema || 1);
  const from = Number.isInteger(localSchema) && localSchema >= 1 ? localSchema : 1;
  if (to > from) {
    for (let s = from + 1; s <= to; s++) out.migrations.push({ from: s - 1, to: s });
  }
  out.allowed = true;
  out.mode = KIND_DIRECT;
  return out;
}

/** 载荷是否必须走完整便携包：依赖或外壳有变（哈希对不上/未声明） */
function needsFullPackage(meta, local) {
  const m = meta || {};
  const l = local || {};
  if (m.lockHash && l.lockHash && m.lockHash !== l.lockHash) {
    return { needed: true, reason: 'lock', reasonKey: 'update.needs-full-package' };
  }
  if (m.shellHash && l.shellHash && m.shellHash !== l.shellHash) {
    return { needed: true, reason: 'shell', reasonKey: 'update.needs-full-package' };
  }
  return { needed: false, reason: '', reasonKey: '' };
}

// ---------- 本地哈希（判断"应用包是否够用"） ----------

/** 外壳运行件：与 scripts/build-release.ps1 的 shellHash 计算覆盖同一批文件 */
const SHELL_FILES = [
  'BlockNexus.exe',
  'BlockNexus.exe.config',
  'WebView2Loader.dll',
  'Microsoft.Web.WebView2.Core.dll',
  'Microsoft.Web.WebView2.WinForms.dll',
];

/**
 * 纯函数：由 [{name, hash}] 算出 shellHash。
 * 算法必须与发布脚本逐字一致：按**文件名 ordinal（逐字节）升序**，每项 `name:hash`，
 * 用 `\n` 连接（末尾不加换行），再对整个字符串取 SHA256。
 * ⚠ PowerShell 侧必须用 Ordinal 比较器（`Sort-Object` 默认是文化相关比较，
 *   对 `BlockNexus.exe` 与 `BlockNexus.exe.config` 的相对次序可能不同）。
 *   万一两边算不一致，后果只是"退化成需要完整便携包"（安全但多一步），不会换错文件。
 */
function shellHashOf(entries) {
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.name && e.hash)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => `${e.name}:${e.hash}`);
  if (!lines.length) return '';
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 读本地 lockHash / shellHash（读不到就给空串 = 无法判定，调用方按需完整包处理） */
function computeLocalHashes(root) {
  let lockHash = '';
  try {
    lockHash = hashFile(path.join(root, 'package-lock.json'));
  } catch {
    // 没有 lock 文件（极少见）→ 留空
  }
  const entries = [];
  for (const name of SHELL_FILES) {
    try {
      entries.push({ name, hash: hashFile(path.join(root, name)) });
    } catch {
      // 该外壳文件不存在（源码运行/纯应用包）→ 不参与
    }
  }
  return { lockHash, shellHash: shellHashOf(entries), shellFiles: entries.map((e) => e.name) };
}

/** git 远端是否为本项目官方仓库（git 形态更新前的硬校验，防止装了别人的远端） */
function isOfficialGitRemote(url) {
  const s = String(url || '').trim().toLowerCase();
  if (!s) return false;
  return /github\.com[:/]live-ling\/blocknexus(\.git)?$/.test(s);
}

const AUTO_FAIL_LIMIT = 3;
const AUTO_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * 自动更新策略：**只有发布方显式声明 autoSafe 且非破坏性才算数**。
 * 背景：v1.0.0 之前不纠结 semver 严格性（维护者约定），因此绝不能按「minor 就安全」猜。
 */
function shouldAutoApply({ meta, plan, ctx } = {}) {
  const m = meta || {};
  const p = plan || {};
  const c = ctx || {};
  if (c.exposedWithoutAuth) return { ok: false, reasonKey: 'update.disabled-exposed' };
  if (!p.allowed) return { ok: false, reasonKey: p.reasonKey || 'update.unsupported-payload' };
  if (!c.idle) return { ok: false, reasonKey: 'update.busy' };
  if (!m.autoSafe) return { ok: false, reasonKey: 'update.auto-not-declared' };
  if (m.severity !== 'security' && m.severity !== 'critical') return { ok: false, reasonKey: 'update.auto-severity' };
  if (m.breaking) return { ok: false, reasonKey: 'update.auto-breaking' };
  if (m.requiresAgentReinstall) return { ok: false, reasonKey: 'update.auto-agent-reinstall' };
  if (m.irreversible) return { ok: false, reasonKey: 'update.auto-irreversible' };
  if ((c.failures || 0) >= AUTO_FAIL_LIMIT) return { ok: false, reasonKey: 'update.auto-backoff' };
  if (c.lastAttemptAt && c.now && c.now - c.lastAttemptAt < AUTO_COOLDOWN_MS) {
    return { ok: false, reasonKey: 'update.auto-cooldown' };
  }
  return { ok: true, reasonKey: '' };
}

/** 手工回滚是否允许：不可逆迁移之后只保留备份，不允许程序回滚 */
function canRollback({ irreversible, hasBackup } = {}) {
  if (!hasBackup) return { ok: false, reasonKey: 'update.rollback-no-backup' };
  if (irreversible) return { ok: false, reasonKey: 'update.rollback-refused' };
  return { ok: true, reasonKey: '' };
}

/** 更新器在健康检查之后该做什么 */
function decideRollback({ irreversible, healthOk } = {}) {
  if (healthOk) return { action: 'none', reasonKey: '' };
  if (irreversible) return { action: 'refuse', reasonKey: 'update.rollback-refused' };
  return { action: 'rollback', reasonKey: '' };
}

// ---------- 归档与写入安全 ----------

/** 解压条目是否安全：拒绝对路径、盘符、`..`、NUL（符号链接由更新器在解压后另行核查） */
function assertSafeArchiveEntry(name) {
  const raw = String(name ?? '');
  if (!raw || raw.length > 1000) return { ok: false, reasonKey: 'update.stage-invalid' };
  if (raw.includes('\0')) return { ok: false, reasonKey: 'update.stage-invalid' };
  const norm = raw.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return { ok: false, reasonKey: 'update.stage-invalid' };
  const parts = norm.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return { ok: false, reasonKey: 'update.stage-invalid' };
  return { ok: true, reasonKey: '' };
}

/** 允许被更新替换的路径（前缀白名单） */
const WRITE_ALLOW = [
  'panel/',
  'web/dist/',
  'agent/agent.js',
  'scripts/',
  'images/',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'install.json',
  'manifest.json',
];

/** 永远不许写的路径（凭据、仓库元数据、开发源码、发布素材） */
const WRITE_DENY = [
  'data/',
  '.git/',
  '.github/',
  'desin/',
  'docs/',
  'web/src/',
  'web/node_modules/',
  'agent/src/',
  'node_modules/',
  'root.txt',
  '.gitignore',
  'release/',
];

/** 写入目标是否被允许（先查 deny 再查 allow；纯字符串判定，可单测） */
function canWritePath(relPath) {
  const raw = String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return { ok: false, reasonKey: 'update.stage-invalid' };
  if (WRITE_DENY.some((d) => raw === d || raw.startsWith(d))) {
    return { ok: false, reasonKey: 'update.stage-invalid' };
  }
  if (WRITE_ALLOW.some((a) => raw === a || raw.startsWith(a))) return { ok: true, reasonKey: '' };
  return { ok: false, reasonKey: 'update.stage-invalid' };
}

module.exports = {
  // 资产名
  ASSET,
  // 版本
  semverGreater,
  normalizeVersion,
  isNewer,
  // 安装形态
  KIND_PORTABLE,
  KIND_DIR,
  KIND_GIT_CLEAN,
  KIND_GIT_DIRTY,
  KIND_UNKNOWN,
  resolveInstallKind,
  describeKind,
  applyModeFor,
  probeInstallKind,
  probeGitClean,
  readInstallMarker,
  // 元数据
  SEVERITIES,
  META_DEFAULTS,
  parseUpdateMeta,
  fillMetaFromTag,
  pickAsset,
  parseChecksums,
  expectedHash,
  // 计划与策略
  KIND_DIRECT,
  KIND_BRIDGE,
  KIND_MANUAL,
  planUpgrade,
  needsFullPackage,
  // 本地哈希（判断应用包是否够用）
  SHELL_FILES,
  shellHashOf,
  computeLocalHashes,
  isOfficialGitRemote,
  shouldAutoApply,
  canRollback,
  decideRollback,
  AUTO_FAIL_LIMIT,
  AUTO_COOLDOWN_MS,
  // 写入安全
  assertSafeArchiveEntry,
  canWritePath,
  WRITE_ALLOW,
  WRITE_DENY,
};
