'use strict';
// 面板数据 schema 迁移：纯逻辑层，零依赖、零 IO
//
// 为什么要有这一层：「应用内一键更新」会把程序文件整体换掉，而 data/config.json
// （servers 列表、SMTP、AI key）是**用户数据**，只能就地升级。旧配置里没有 schema 版本
// 字段，新版程序无法分辨磁盘上写的是哪一版结构，于是只能猜——猜错的代价是用户的服务器
// 列表/密钥被写坏。所以本模块把「现在是什么版本、该怎么升、能不能升」全部做成纯函数：
// 不读文件、不写文件、不联网，且**任何拿不准的输入都按「不许迁移」处理**。
//
// 调用方（panel/server.js 启动时）的用法：
//   const from = readSchema(cfg);
//   const r = migrateConfig(cfg, from);
//   if (r.ok) 落盘 r.data；否则保持磁盘原样，用迁移前那份数据继续跑/提示用户人工处理。
// 本文件绝不自己写盘——这样「迁移决策写错了」也不会直接把用户数据毁掉。
//
// 版本语义：SCHEMA_FIELD 记录「磁盘数据是按哪一版结构写的」；字段缺失或非法一律当成 1
// （本模块出生之前的所有配置都是 1）。MIGRATIONS 的键 = 源 schema，值 = 纯函数，负责把它
// 升到「源 + 1」。生产链当前为 1→2→3（3 = 新增 settings.telemetry）。
//
// 引入 panel/telemetry.js 只取 DEFAULTS.endpoint 常量：它是零依赖纯逻辑模块，
// 不破坏本文件「零 IO、零副作用」的约定。

const { DEFAULTS: TELEMETRY_DEFAULTS } = require('./telemetry');

// ---------- 契约常量 ----------

/** 数据 schema 版本字段名（写在 data/config.json 顶层） */
const SCHEMA_FIELD = 'schemaVersion';

/** 当前生产 schema。将来新增一次真正的结构变更时 +1，并在 MIGRATIONS 里补一条迁移。 */
const CURRENT_SCHEMA = 3;

/**
 * 生产迁移链：`{ 源schema: (data) => 源+1 的数据 }`。
 * 约定（硬要求）：纯函数、不得有副作用、不得改自己的入参、必须返回对象；
 * 返回非对象会被 migrate() 判为失败——宁可停在旧结构，也不能把写坏的数据落盘。
 */
const MIGRATIONS = {
  // 2：新增「网络」两块设置（DDNS / frp）。Config.load() 会深合并默认值，
  // 这里只保证键存在且是对象，避免老配置里出现 `settings.ddns = null` 之类让后续读取炸掉的值。
  1: (data) => {
    const out = { ...data };
    const settings = { ...(data.settings && typeof data.settings === 'object' ? data.settings : {}) };
    if (!settings.ddns || typeof settings.ddns !== 'object' || Array.isArray(settings.ddns)) {
      settings.ddns = { enabled: false, provider: 'cloudflare', domain: '', ipv4: true, ipv6: false, source: 'api' };
    }
    if (!settings.frp || typeof settings.frp !== 'object' || Array.isArray(settings.frp)) {
      settings.frp = { enabled: false, mode: 'sakura', binaryPath: '' };
    }
    out.settings = settings;
    return out;
  },
  // 3：新增 settings.telemetry（合规遥测，默认关闭）。
  // 只保证键存在且是对象，且**强制 enabled=false / instanceId=''**——老配置里不存在遥测
  // 这个东西，迁移绝不替用户打开一个会外发数据的开关（opt-in 是硬约定）。
  // 端点用 panel/telemetry.js 的默认值（官方接收端）：用户开开关即可用，不必再抄地址。
  2: (data) => {
    const out = { ...data };
    const settings = { ...(data.settings && typeof data.settings === 'object' ? data.settings : {}) };
    if (!settings.telemetry || typeof settings.telemetry !== 'object' || Array.isArray(settings.telemetry)) {
      settings.telemetry = { enabled: false, endpoint: TELEMETRY_DEFAULTS.endpoint, intervalSec: 24 * 3600, instanceId: '' };
    } else {
      // 已有配置不动端点（用户可能改过），只强制复位开关与 ID
      settings.telemetry = { ...settings.telemetry, enabled: false, instanceId: '' };
    }
    out.settings = settings;
    return out;
  },
};

/** 失败原因（i18n key，与 panel/update.js 的 reasonKey 一样交给前端翻译） */
const MIGRATE_ERROR = {
  DOWNGRADE: 'update.migrate-downgrade', // 数据比程序新：必须拒绝，见 migrate()
  UNSUPPORTED: 'update.migrate-unsupported', // 迁移链覆盖不到（起点太老或有缺口）
  FAILED: 'update.migrate-failed', // 某一步抛异常或返回了非法值
};

// 与 panel/update.js 的 cleanSchemaNumber 对齐的合理区间：挡住 1e9、Infinity 这类垃圾值
const MIN_SCHEMA = 1;
const MAX_SCHEMA = 9999;

// ---------- 基础工具（都是纯函数） ----------

/**
 * 版本号正规化：只认 [1, 9999] 的整数。
 * 字符串 '2'、2.5、0、-3、NaN、null 一律回落——**不猜**。理由：把非法值当成某个具体
 * 版本会让 migrator 面对一份它其实不认识的结构，比当成最老的 1 更危险（当成 1 至多是
 * 拒绝迁移，当成 5 可能直接跳过必需的迁移）。
 */
function normalizeSchema(n, fallback) {
  return Number.isInteger(n) && n >= MIN_SCHEMA && n <= MAX_SCHEMA ? n : fallback;
}

/** 配置根必须是「非 null、非数组的对象」：迁移链每一步的返回值都要过这一关 */
function isConfigObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深拷贝。优先 structuredClone（Node 18+ 内置，能正确处理循环引用）；退化到 JSON 往返
 * （会丢 Date/undefined/函数——但 config.json 本来就只存 JSON 能表达的东西）。
 * 两条路都失败时退回原引用：宁可「可能共享引用」，也不能在这里抛异常。
 */
function deepClone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // 含函数/不可克隆对象 → 走 JSON 路线
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * 读出数据的 schema 版本。缺失/非法（负数、0、小数、字符串、非对象）一律返回 1：
 * 「老配置没有这个字段」是唯一可以确定的解释，也是最保守的解释。
 */
function readSchema(data) {
  const raw = data && typeof data === 'object' ? data[SCHEMA_FIELD] : undefined;
  return normalizeSchema(raw, 1);
}

/**
 * 盖上版本号并返回**新对象**（入参不动，避免调用方手里的对象被悄悄改版本）。
 * n 非法时夹回当前 schema：绝不写一个 readSchema 认不出的值进去——否则下次启动会把它
 * 当成「没有版本字段的老配置」而重跑一遍迁移。
 */
function stampSchema(data, n) {
  const out = isConfigObject(data) ? { ...data } : {};
  out[SCHEMA_FIELD] = normalizeSchema(n, CURRENT_SCHEMA);
  return out;
}

// ---------- 迁移器工厂 ----------

/**
 * 造一个迁移器。工厂化的目的是**可单测**：生产链现在为空，只有拿合成链
 * （1→2→3、缺口链、会抛异常的链）才能把这段决策代码真正跑起来。
 *
 * @param {{migrations?: Object, currentSchema?: number}} opts
 * @returns {{currentSchema: number, oldest: number, path: Function, migrate: Function}}
 */
function createMigrator({ migrations, currentSchema } = {}) {
  const src = isConfigObject(migrations) ? migrations : {};
  const target = normalizeSchema(currentSchema, CURRENT_SCHEMA);

  // 只收「键是正整数 + 值是函数」的项。链里混进垃圾键时宁可少一条迁移：path() 少算一步
  // 只会导致「不支持」，而多算一步会去调用一个不存在的函数。
  const chain = Object.create(null);
  for (const key of Object.keys(src)) {
    const from = Number(key);
    if (!Number.isInteger(from) || from < MIN_SCHEMA || from > MAX_SCHEMA) continue;
    if (typeof src[key] !== 'function') continue;
    chain[from] = src[key];
  }
  const keys = Object.keys(chain).map(Number).sort((a, b) => a - b);

  // 链能处理的最旧 schema = 最小键；空链时没有「最旧」，用 currentSchema 兜底
  // （空链 + currentSchema = 1 时 oldest = 1，于是「1→1 空操作」不会被误判成不支持）
  const oldest = keys.length ? keys[0] : target;

  /**
   * 从 from 到 to 需要执行哪些步骤。
   * 只走到链的**第一个缺口**为止：少一步就返回半截，调用方据此判「覆盖不到」，
   * 而不是自作主张跳级。
   */
  function path(from, to) {
    const a = normalizeSchema(from, target);
    const b = normalizeSchema(to, target);
    const steps = [];
    if (b <= a) return steps; // from >= to：原地不动或降级都不产生步骤
    for (let s = a + 1; s <= b; s++) {
      if (typeof chain[s - 1] !== 'function') break;
      steps.push({ from: s - 1, to: s });
    }
    return steps;
  }

  /**
   * 执行迁移。四种结局：成功 / 降级 / 链覆盖不到 / 某一步失败。
   * 安全铁律：**不修改入参**；任何「数据可能处于中间态」的失败都不返回可写数据。
   */
  function migrate(data, from, to) {
    const a = normalizeSchema(from, readSchema(data));
    const b = normalizeSchema(to, target);

    if (a === b) {
      // 幂等：已经就是目标版本。回一份深拷贝（调用方拿到的东西永远不与入参共享引用），
      // 重复执行结果逐字相同。
      return { ok: true, applied: [], data: deepClone(data), error: '' };
    }

    if (a > b) {
      // 降级：磁盘数据比程序新（典型场景是用户先用新版、又退回旧版）。
      // 旧代码不认识新字段，硬跑一次「迁移」再写回就等于删数据，所以只拒绝、不动手。
      // 数据原样回传：调用方可以继续按现有内容运行，或提示用户升级程序。
      return { ok: false, applied: [], data, error: MIGRATE_ERROR.DOWNGRADE };
    }

    const steps = path(a, b);
    if (steps.length !== b - a) {
      // 链覆盖不到（起点比 oldest 还老，或链中间有缺口）。一步都没跑，所以不交数据：
      // 调用方拿到 data = null 就只能放弃写入，不存在「写进半成品」的路径。
      return { ok: false, applied: [], data: null, error: MIGRATE_ERROR.UNSUPPORTED };
    }

    // 先整份深拷贝再逐步迁移：迁移函数怎么就地改都只改到内部副本，入参永远干净。
    let working = deepClone(data);
    const applied = [];
    for (const step of steps) {
      try {
        const next = chain[step.from](working);
        // 返回非对象（undefined / 字符串 / null / 数组）视同抛异常：一份被写坏的配置
        // 比「没升级成功」糟糕得多，所以这里主动把它变成失败，而不是让 undefined 流出去。
        if (!isConfigObject(next)) throw new TypeError('migration must return a plain object');
        next[SCHEMA_FIELD] = step.to; // 每步都盖版本号，后面的步骤能据此知道自己面对哪版结构
        working = next;
      } catch {
        // 失败时 data 返回 null：调用方**无法**把这份中间态写盘（错误原因与已完成的步骤照常回报，
        // 便于排查与人工修复）。入参是深拷贝的源头，因此也从未被改动。
        return { ok: false, applied, data: null, error: MIGRATE_ERROR.FAILED };
      }
      applied.push(step);
    }

    // 收尾再盖一次目标版本：迁移函数即使自己写错 SCHEMA_FIELD 也会被纠正回来
    working[SCHEMA_FIELD] = b;
    return { ok: true, applied, data: working, error: '' };
  }

  return { currentSchema: target, oldest, path, migrate };
}

// ---------- 生产入口 ----------

const production = createMigrator({ migrations: MIGRATIONS, currentSchema: CURRENT_SCHEMA });

/**
 * 用生产迁移链迁移一份 data/config.json。
 * from 省略时按数据里的版本字段推断（缺失 = 1），to 默认当前生产 schema。
 */
function migrateConfig(data, from, to = CURRENT_SCHEMA) {
  return production.migrate(data, from, to);
}

module.exports = {
  // 契约
  SCHEMA_FIELD,
  CURRENT_SCHEMA,
  MIGRATIONS,
  MIGRATE_ERROR,
  // 纯函数
  readSchema,
  stampSchema,
  createMigrator,
  migrateConfig,
};
