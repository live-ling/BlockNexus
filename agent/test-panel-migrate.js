'use strict';
// panel/migrate.js 的单测（零依赖，直接 require，不需要面板/网络/真实 data/config.json）
//
// 覆盖的是**会毁用户数据的决策**：版本字段怎么读、迁移链怎么串、失败时还敢不敢把数据
// 交回调用方写盘。生产链当前是 1→2（新增 settings.ddns / settings.frp），所以除了生产
// 迁移本身，其余用例跑的是**合成链**（1→2→3、带缺口的链、会抛异常的链、返回非法值的链）
// ——否则这段决策代码只会被真实迁移碰一次，覆盖面太窄。
//
// 运行：node agent/test-panel-migrate.js

const path = require('path');

const M = require(path.join(__dirname, '..', 'panel', 'migrate.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 一份「像真的」config.json：有嵌套结构、有密钥、有服务器列表
const SRC = {
  schemaVersion: 1,
  servers: [{ id: 'srv-a', name: '主服', port: 25565, rcon: 'secret' }],
  smtp: { host: 'smtp.example.com', user: 'panel', pass: 'p@ss' },
  ai: { key: 'sk-xxx', model: 'deepseek' },
  nested: { list: [1, 2, 3], deep: { flag: true } },
};
const SRC_SNAPSHOT = JSON.stringify(SRC);

// ---------- 契约常量 ----------
check('契约: SCHEMA_FIELD / CURRENT_SCHEMA / 生产链含 1→2',
  M.SCHEMA_FIELD === 'schemaVersion' && M.CURRENT_SCHEMA === 2 &&
    typeof M.MIGRATIONS[1] === 'function',
  JSON.stringify({ field: M.SCHEMA_FIELD, cur: M.CURRENT_SCHEMA, chain: Object.keys(M.MIGRATIONS) }));

// ---------- 1. readSchema ----------
check('readSchema: 字段缺失 → 1', M.readSchema({}) === 1);
check('readSchema: 非对象（null/undefined/字符串/数组）→ 1',
  M.readSchema(null) === 1 && M.readSchema(undefined) === 1 &&
    M.readSchema('x') === 1 && M.readSchema([]) === 1);
check('readSchema: 正常值原样返回',
  M.readSchema({ [M.SCHEMA_FIELD]: 1 }) === 1 && M.readSchema({ [M.SCHEMA_FIELD]: 7 }) === 7);
check('readSchema: 负数 / 0 → 1',
  M.readSchema({ [M.SCHEMA_FIELD]: -3 }) === 1 && M.readSchema({ [M.SCHEMA_FIELD]: 0 }) === 1);
check('readSchema: 小数 → 1', M.readSchema({ [M.SCHEMA_FIELD]: 1.5 }) === 1);
check('readSchema: 字符串 "2" 不猜成 2（当老配置）',
  M.readSchema({ [M.SCHEMA_FIELD]: '2' }) === 1);
check('readSchema: NaN / null / 对象 → 1',
  M.readSchema({ [M.SCHEMA_FIELD]: NaN }) === 1 && M.readSchema({ [M.SCHEMA_FIELD]: null }) === 1 &&
    M.readSchema({ [M.SCHEMA_FIELD]: {} }) === 1);

// ---------- stampSchema ----------
{
  const input = { servers: [], ai: { key: 'k' } };
  const before = JSON.stringify(input);
  const out = M.stampSchema(input, 2);
  check('stampSchema: 新对象带版本号且不改入参',
    out[M.SCHEMA_FIELD] === 2 && out.servers === input.servers &&
      !(M.SCHEMA_FIELD in input) && JSON.stringify(input) === before,
    JSON.stringify(out));
  check('stampSchema: 非法版本号夹回当前 schema（绝不写 readSchema 认不出的值）',
    M.stampSchema({}, 0)[M.SCHEMA_FIELD] === M.CURRENT_SCHEMA &&
      M.stampSchema({}, 'x')[M.SCHEMA_FIELD] === M.CURRENT_SCHEMA &&
      M.stampSchema({}, -5)[M.SCHEMA_FIELD] === M.CURRENT_SCHEMA);
}

// ---------- 合成迁移链：1 → 2 → 3 ----------
const chainM = M.createMigrator({
  migrations: {
    1: (d) => ({ ...d, v2: true }),
    2: (d) => ({ ...d, v3: true }),
  },
  currentSchema: 3,
});

// ---------- 2. path() ----------
check('oldest: 合成链取最小键 1', chainM.oldest === 1, String(chainM.oldest));
check('oldest: 空链回落到 currentSchema',
  M.createMigrator({ migrations: {}, currentSchema: 4 }).oldest === 4 &&
    M.createMigrator().oldest === M.CURRENT_SCHEMA);
check('path: 1→3 逐级两步', same(chainM.path(1, 3), [{ from: 1, to: 2 }, { from: 2, to: 3 }]),
  JSON.stringify(chainM.path(1, 3)));
check('path: 1→2 一步', same(chainM.path(1, 2), [{ from: 1, to: 2 }]));
check('path: 1→1 空', chainM.path(1, 1).length === 0);
check('path: 3→1 空（降级由 migrate 拒绝）', chainM.path(3, 1).length === 0);
check('path: 链中间有缺口时不越过缺口',
  same(M.createMigrator({ migrations: { 1: (d) => ({ ...d }), 3: (d) => ({ ...d }) }, currentSchema: 4 })
    .path(1, 4), [{ from: 1, to: 2 }]));

// ---------- 3. 成功迁移 1→3 ----------
{
  const r = chainM.migrate(SRC, 1, 3);
  check('迁移: 1→3 成功且结果 schemaVersion = 3',
    r.ok === true && r.data[M.SCHEMA_FIELD] === 3, JSON.stringify(r));
  check('迁移: applied 顺序为 1→2、2→3',
    same(r.applied, [{ from: 1, to: 2 }, { from: 2, to: 3 }]), JSON.stringify(r.applied));
  check('迁移: 两步迁移函数的改动都落在结果上', r.data.v2 === true && r.data.v3 === true);
  check('迁移: 其余字段完整保留',
    r.data.servers[0].port === 25565 && r.data.servers[0].rcon === 'secret' &&
      r.data.smtp.pass === 'p@ss' && r.data.ai.key === 'sk-xxx' &&
      same(r.data.nested, { list: [1, 2, 3], deep: { flag: true } }),
    JSON.stringify(r.data));
  check('迁移: 返回值是新对象（不是入参本身）', r.data !== SRC);
}

// ---------- 4. 不改入参 ----------
{
  chainM.migrate(SRC, 1, 3);
  check('不改入参: 迁移前后原对象深比较相等', JSON.stringify(SRC) === SRC_SNAPSHOT, JSON.stringify(SRC));
}
{
  // 更狠一点：把结果里的嵌套结构改掉，原对象必须毫无变化（证明是深拷贝而非共享引用）
  const r = chainM.migrate(SRC, 1, 3);
  r.data.nested.list.push('tampered');
  r.data.nested.deep.flag = false;
  r.data.servers[0].name = 'tampered';
  r.data.brandNew = true;
  check('不改入参: 结果与入参不共享嵌套引用（改结果不动入参）',
    JSON.stringify(SRC) === SRC_SNAPSHOT, JSON.stringify(SRC));
}
{
  // 迁移函数自己就地改入参也只能改到内部副本
  const mutM = M.createMigrator({ migrations: { 1: (d) => { d.hacked = true; return d; } }, currentSchema: 2 });
  const input = { [M.SCHEMA_FIELD]: 1, servers: [] };
  const before = JSON.stringify(input);
  const r = mutM.migrate(input, 1, 2);
  check('不改入参: 迁移函数就地修改只改到内部副本',
    r.ok === true && r.data.hacked === true && JSON.stringify(input) === before && !('hacked' in input),
    JSON.stringify(input));
}

// ---------- 5. 幂等 ----------
{
  const first = chainM.migrate(SRC, 1, 3);
  const second = chainM.migrate(first.data, M.readSchema(first.data), 3);
  check('幂等: 第二次 applied 为空且仍 ok',
    second.ok === true && second.applied.length === 0, JSON.stringify(second.applied));
  check('幂等: 第二次数据与第一次完全相同', same(second.data, first.data), JSON.stringify(second.data));
  check('幂等: 第二次仍是深拷贝（新对象）', second.data !== first.data);
  const third = chainM.migrate(second.data, 3, 3);
  check('幂等: 3→3 连续重跑结果稳定',
    third.ok === true && third.applied.length === 0 && same(third.data, first.data));
}

// ---------- 6. 某一步抛异常 ----------
const boomM = M.createMigrator({
  migrations: {
    1: (d) => ({ ...d, v2: true }),
    2: () => { throw new Error('boom'); },
  },
  currentSchema: 3,
});
{
  const r = boomM.migrate(SRC, 1, 3);
  check('失败: 迁移函数抛异常 → ok=false', r.ok === false, JSON.stringify(r));
  check('失败: error = update.migrate-failed', r.error === 'update.migrate-failed', String(r.error));
  check('失败: data = null（绝不把半迁移数据交给调用方写盘）', r.data === null);
  check('失败: applied 只含已完成的步骤',
    same(r.applied, [{ from: 1, to: 2 }]), JSON.stringify(r.applied));
  check('失败: 入参仍未被修改', JSON.stringify(SRC) === SRC_SNAPSHOT, JSON.stringify(SRC));
}

// ---------- 7. 降级 ----------
{
  const r = chainM.migrate(SRC, 3, 1);
  check('降级: from > to → ok=false + update.migrate-downgrade',
    r.ok === false && r.error === 'update.migrate-downgrade', JSON.stringify(r));
  check('降级: applied 为空且数据原样回传（调用方可继续按旧数据运行）',
    r.applied.length === 0 && same(r.data, SRC));
}
{
  // 真实场景：新版写出的 schema 5 配置被旧程序打开
  let ran = 0;
  const spyM = M.createMigrator({
    migrations: { 1: (d) => { ran++; return { ...d }; } },
    currentSchema: 2,
  });
  const r = spyM.migrate({ [M.SCHEMA_FIELD]: 5, servers: [] }, 5, 1);
  check('降级: 一个迁移函数都不会被调用',
    r.ok === false && r.error === 'update.migrate-downgrade' && ran === 0, `ran=${ran}`);
}

// ---------- 8. 链覆盖不到 ----------
{
  const oldM = M.createMigrator({ migrations: { 2: (d) => ({ ...d, v3: true }) }, currentSchema: 3 });
  check('oldest: 链从 2 开始时 oldest = 2', oldM.oldest === 2, String(oldM.oldest));
  const r = oldM.migrate(SRC, 1, 3);
  check('不支持: from < oldest → ok=false + update.migrate-unsupported',
    r.ok === false && r.error === 'update.migrate-unsupported', JSON.stringify(r));
  check('不支持: applied 为空且不交出可写数据', r.applied.length === 0 && r.data === null);
}
{
  const gapM = M.createMigrator({
    migrations: { 1: (d) => ({ ...d, v2: true }), 3: (d) => ({ ...d, v4: true }) },
    currentSchema: 4,
  });
  const r = gapM.migrate(SRC, 1, 4);
  check('不支持: 链中间有缺口 → 也按不支持处理（不跳级猜）',
    r.ok === false && r.error === 'update.migrate-unsupported' && r.data === null, JSON.stringify(r));
}
{
  // 生产链 1→2：新增 settings.ddns / settings.frp，其余字段一个都不能动
  const r = M.migrateConfig(SRC, 1, 2);
  const d = r.data || {};
  check(
    '生产: 1→2 成功并补齐网络设置',
    r.ok === true &&
      r.applied.length === 1 &&
      !!d.settings &&
      !!d.settings.ddns &&
      !!d.settings.frp &&
      d.servers[0].id === 'srv-a',
    JSON.stringify(r).slice(0, 300),
  );
  check('生产: 1→2 保留服务器/密钥等原有字段', same(d.servers, SRC.servers) && same(d.smtp, SRC.smtp) && same(d.ai, SRC.ai));
  check('生产: 1→2 不改入参', JSON.stringify(SRC) === SRC_SNAPSHOT);
}

// ---------- 9. migrateConfig（生产链：1→2 一步） ----------
{
  const cfg = {
    servers: [{ id: 'srv-a', port: 25565 }],
    smtp: { host: 'h', pass: 'p' },
    ai: { key: 'k' },
    someUnknownFlag: true,
  };
  const before = JSON.stringify(cfg);
  const r = M.migrateConfig(cfg);
  check('生产: 1→2 只执行一步', r.ok === true && r.applied.length === 1 && r.error === '', JSON.stringify(r).slice(0, 200));
  check(
    '生产: 原有字段完整保留',
    same(r.data.servers, cfg.servers) &&
      same(r.data.smtp, cfg.smtp) &&
      same(r.data.ai, cfg.ai) &&
      r.data.someUnknownFlag === true,
    JSON.stringify(r.data).slice(0, 200),
  );
  check('生产: 结果版本号是 2', M.readSchema(r.data) === 2);
  check('生产: 不改入参（也没有被偷偷写上版本字段）',
    JSON.stringify(cfg) === before && !(M.SCHEMA_FIELD in cfg), JSON.stringify(cfg));
  const r2 = M.migrateConfig(cfg, 1, M.CURRENT_SCHEMA);
  check('生产: 显式 1→CURRENT_SCHEMA 同样走一步且字段保留',
    r2.ok === true && r2.applied.length === 1 && same(r2.data.servers, cfg.servers));
  const r3 = M.migrateConfig({ ...cfg, [M.SCHEMA_FIELD]: M.CURRENT_SCHEMA });
  check('生产: 已带版本号的配置照常通过（重复启动幂等）',
    r3.ok === true && r3.applied.length === 0 && M.readSchema(r3.data) === M.CURRENT_SCHEMA);
}

// ---------- 10. 迁移函数返回非对象 ----------
{
  const cases = [
    ['undefined', () => undefined],
    ['字符串', () => 'oops'],
    ['null', () => null],
    ['数组', () => [1, 2]],
    ['数字', () => 42],
  ];
  for (const [label, fn] of cases) {
    const m = M.createMigrator({ migrations: { 1: fn }, currentSchema: 2 });
    const r = m.migrate({ [M.SCHEMA_FIELD]: 1, servers: [] }, 1, 2);
    check(`非法返回: 迁移函数返回${label} → update.migrate-failed 且 data=null`,
      r.ok === false && r.error === 'update.migrate-failed' && r.data === null && r.applied.length === 0,
      JSON.stringify(r));
  }
}
{
  // 第一步正常、第二步返回非法值：applied 只记已完成的，数据照样不交出去
  const m = M.createMigrator({
    migrations: { 1: (d) => ({ ...d, v2: true }), 2: () => undefined },
    currentSchema: 3,
  });
  const r = m.migrate({ [M.SCHEMA_FIELD]: 1, servers: [], ai: { key: 'k' } }, 1, 3);
  check('非法返回: 第二步非法 → applied 只含第一步且 data=null',
    r.ok === false && r.error === 'update.migrate-failed' &&
      same(r.applied, [{ from: 1, to: 2 }]) && r.data === null,
    JSON.stringify(r));
}

console.log(`\n${pass}/${total} panel-migrate cases passed`);
process.exit(pass === total ? 0 : 1);
