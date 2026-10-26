'use strict';
// 面板自更新的纯逻辑测试（零依赖，直接 require panel/update.js，不需要面板/网络）
//
// 覆盖的是**决策**：安装形态判定、发布元数据解析（外部输入，必须防御式）、
// 跨版本升级计划（直跳/桥接/手动）、自动更新策略矩阵、回滚决策、归档与写入路径安全。
// 这些决策写错的代价是覆盖用户工作区或把面板更新成起不来的版本，因此逐条钉住。
//
// 运行：node agent/test-panel-update.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const U = require(path.join(__dirname, '..', 'panel', 'update.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// ---------- 版本比较 ----------
check('semverGreater: 0.6.0 > 0.5.9', U.semverGreater('0.6.0', '0.5.9') === true);
check('semverGreater: 0.6.0 vs 0.6 相等 → false', U.semverGreater('0.6.0', '0.6') === false);
check('semverGreater: 0.6 vs 0.6.0 也不大于', U.semverGreater('0.6', '0.6.0') === false);
check('semverGreater: 预发布段低于正式段（0.6.0-beta < 0.6.0）',
  U.semverGreater('0.6.0-beta', '0.6.0') === false && U.semverGreater('0.6.0', '0.6.0-beta') === true);
check('semverGreater: 两个预发布段按字典序', U.semverGreater('0.6.0-rc2', '0.6.0-rc1') === true);
check('semverGreater: 带 v 前缀等价', U.semverGreater('v0.6.0', '0.5.0') === true);
check('semverGreater: 1.0.0 > 0.9.9', U.semverGreater('1.0.0', '0.9.9') === true);
check('semverGreater: 相等为 false', U.semverGreater('0.6.0', '0.6.0') === false);
check('normalizeVersion: v0.6.0 → [0,6,0]', JSON.stringify(U.normalizeVersion('v0.6.0')) === '[0,6,0]');
check('normalizeVersion: 1.2.3+build → [1,2,3]', JSON.stringify(U.normalizeVersion('1.2.3+build')) === '[1,2,3]');
check('normalizeVersion: 非法 → null', U.normalizeVersion('abc') === null && U.normalizeVersion('') === null);
check('isNewer: 0.6.0 新于 0.5.0', U.isNewer('0.6.0', '0.5.0') === true);
check('isNewer: 当前版本读不出时不拦', U.isNewer('0.6.0', '') === true);
check('isNewer: 旧版本不新', U.isNewer('0.5.0', '0.6.0') === false);

// ---------- 安装形态 ----------
check('形态: 便携标记且无 git → portable',
  U.resolveInstallKind({ markerKind: 'portable', hasGit: false }) === U.KIND_PORTABLE);
check('形态: 有 git 且干净 → git-clean',
  U.resolveInstallKind({ hasGit: true, gitClean: true }) === U.KIND_GIT_CLEAN);
check('形态: 有 git 且脏 → git-dirty（禁自更新）',
  U.resolveInstallKind({ hasGit: true, gitClean: false }) === U.KIND_GIT_DIRTY);
check('形态: git 状态探测不出 → unknown（宁可不升）',
  U.resolveInstallKind({ hasGit: true, gitClean: null }) === U.KIND_UNKNOWN);
check('形态: 无 git 但有 panel/web/dist → dir',
  U.resolveInstallKind({ hasGit: false, hasServerJs: true, hasWebDist: true }) === U.KIND_DIR);
check('形态: 什么都没有 → unknown',
  U.resolveInstallKind({}) === U.KIND_UNKNOWN);
check('形态: portable 标记但目录里还有 .git → 不当便携包（认 git）',
  U.resolveInstallKind({ markerKind: 'portable', hasGit: true, gitClean: true }) === U.KIND_GIT_CLEAN);
check('形态: git-dirty 不可自更新且给原因',
  U.describeKind(U.KIND_GIT_DIRTY).canSelfUpdate === false &&
    U.describeKind(U.KIND_GIT_DIRTY).reasonKey === 'update.disabled-dirty');
check('形态: git 存在但探测不出 → 与"未知目录"给不同原因（不误导用户去下便携包）',
  U.describeKind(U.KIND_UNKNOWN, { hasGit: true }).reasonKey === 'update.disabled-git-unknown' &&
    U.describeKind(U.KIND_UNKNOWN, { hasGit: false }).reasonKey === 'update.disabled-unknown');
check('形态: portable/dir/git-clean 可自更新',
  [U.KIND_PORTABLE, U.KIND_DIR, U.KIND_GIT_CLEAN].every((k) => U.describeKind(k).canSelfUpdate === true));
check('applyMode: git-clean → git（这是 P0-2 的修复点）',
  U.applyModeFor(U.KIND_GIT_CLEAN) === 'git');
check('applyMode: portable/dir/unknown → payload',
  [U.KIND_PORTABLE, U.KIND_DIR, U.KIND_UNKNOWN, U.KIND_GIT_DIRTY].every((k) => U.applyModeFor(k) === 'payload'));

// probeInstallKind 走真实文件系统（临时目录，不碰仓库）
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-update-'));
  const plain = U.probeInstallKind(tmp);
  check('probe: 空目录 → unknown 且不可自更新',
    plain.kind === U.KIND_UNKNOWN && plain.canSelfUpdate === false, JSON.stringify(plain.kind));
  fs.mkdirSync(path.join(tmp, 'panel'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'panel', 'server.js'), '// x');
  fs.writeFileSync(path.join(tmp, 'web', 'dist', 'index.html'), '<html>');
  check('probe: 无 git、有 server.js + dist → dir 且可自更新',
    U.probeInstallKind(tmp).kind === U.KIND_DIR);
  fs.writeFileSync(path.join(tmp, 'install.json'), JSON.stringify({ kind: 'portable', version: '0.6.0' }));
  check('probe: 有 install.json 标记 → portable 且读出标记版本',
    U.probeInstallKind(tmp).kind === U.KIND_PORTABLE &&
      U.probeInstallKind(tmp).markerVersion === '0.6.0');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- 元数据解析（外部输入） ----------
const goodMeta = {
  schema: 1,
  version: '0.6.0',
  severity: 'security',
  autoSafe: true,
  breaking: false,
  requiresAgentReinstall: true,
  minSourceVersion: '0.5.0',
  bridge: ['0.5.0', '0.5.0', '0.6.0'],
  dataSchema: 2,
  minSchema: 1,
  irreversible: true,
  minNode: 18,
  lockHash: HASH_A,
  shellHash: HASH_B,
  summary: '修了一个会让面板重启后掉登录的问题',
  notesUrl: 'https://github.com/live-ling/BlockNexus/releases/tag/v0.6.0',
};
{
  const r = U.parseUpdateMeta(goodMeta);
  check('meta: 合法元数据全部字段落地',
    r.ok === true && r.meta.severity === 'security' && r.meta.autoSafe === true &&
      r.meta.breaking === false && r.meta.dataSchema === 2 && r.meta.lockHash === HASH_A,
    JSON.stringify(r.meta));
  check('meta: bridge 去重', JSON.stringify(r.meta.bridge) === '["0.5.0","0.6.0"]');
  check('meta: JSON 字符串形式也能解析', U.parseUpdateMeta(JSON.stringify(goodMeta)).ok === true);
}
{
  const r = U.parseUpdateMeta(undefined);
  check('meta: 缺失 → 安全默认（建议更新 + 必须人工确认）',
    r.ok === false && r.missing === true && r.meta.severity === 'recommended' &&
      r.meta.autoSafe === false && r.meta.breaking === true,
    JSON.stringify(r.meta));
}
check('meta: 坏 JSON → ok=false 且不抛', U.parseUpdateMeta('{oops').ok === false);
check('meta: 版本非法 → ok=false', U.parseUpdateMeta({ version: 'abc' }).ok === false);
check('meta: severity 非法 → recommended',
  U.parseUpdateMeta({ version: '1.0.0', severity: 'yolo' }).meta.severity === 'recommended');
check('meta: autoSafe 必须是布尔真值（"yes" 不算）',
  U.parseUpdateMeta({ version: '1.0.0', autoSafe: 'yes' }).meta.autoSafe === false);
check('meta: 未声明 breaking → 按真处理（安全默认）',
  U.parseUpdateMeta({ version: '1.0.0' }).meta.breaking === true);
check('meta: minSchema > dataSchema 时被夹回',
  U.parseUpdateMeta({ version: '1.0.0', dataSchema: 2, minSchema: 9 }).meta.minSchema === 2);
check('meta: 短哈希被丢弃',
  U.parseUpdateMeta({ version: '1.0.0', lockHash: 'deadbeef' }).meta.lockHash === '');
check('meta: 非 https 的 notesUrl 被丢弃',
  U.parseUpdateMeta({ version: '1.0.0', notesUrl: 'http://evil/x' }).meta.notesUrl === '');
check('meta: 摘要里的控制字符被清洗',
  U.parseUpdateMeta({ version: '1.0.0', summary: 'a\u0000b\u001fc' }).meta.summary === 'abc');
check('meta: 超长摘要被截断',
  U.parseUpdateMeta({ version: '1.0.0', summary: 'x'.repeat(900) }).meta.summary.length === 500);
check('meta: minNode 非法 → 默认 18',
  U.parseUpdateMeta({ version: '1.0.0', minNode: 'abc' }).meta.minNode === 18);
{
  const ok = U.fillMetaFromTag(U.parseUpdateMeta({ version: '0.7.0' }).meta, '0.7.0');
  check('fillMetaFromTag: 合法 meta 原样返回',
    ok.filled === false && ok.metaMissing === false && ok.meta.version === '0.7.0');
  const fb = U.fillMetaFromTag(U.META_DEFAULTS, 'v0.7.0');
  check('fillMetaFromTag: 缺 meta 用 tag 合成，且保持保守（breaking/autoSafe）',
    fb.filled === true && fb.metaMissing === true && fb.meta.version === '0.7.0' &&
      fb.meta.breaking === true && fb.meta.autoSafe === false);
  const bad = U.fillMetaFromTag(U.META_DEFAULTS, 'nope');
  check('fillMetaFromTag: tag 也非法 → 安全默认且不填版本',
    bad.filled === false && bad.metaMissing === true && bad.meta.version === '');
}
{
  const r = U.parseUpdateMeta({
    version: '1.0.0',
    files: { 'a.zip': HASH_A, '../evil.zip': HASH_B, 'b.zip': 'bad', 'c.zip': HASH_A.toUpperCase() },
  });
  check('meta: files 只收安全名字与 64 位哈希（大写转小写）',
    JSON.stringify(r.meta.files) === JSON.stringify({ 'a.zip': HASH_A, 'c.zip': HASH_A }),
    JSON.stringify(r.meta.files));
}

// ---------- 资产与校验值 ----------
{
  const assets = [
    { name: 'BlockNexus-v0.6.0-app.zip', size: 1234, browser_download_url: 'https://x/app.zip' },
    { name: 'update.json', size: 500, browser_download_url: 'https://x/u.json' },
  ];
  check('asset: 按名挑选', U.pickAsset(assets, 'BlockNexus-v0.6.0-app.zip').size === 1234);
  check('asset: 找不到 → null', U.pickAsset(assets, 'nope.zip') === null);
  check('asset: 缺下载地址 → null',
    U.pickAsset([{ name: 'a.zip' }], 'a.zip') === null);
  check('asset: 资产名构造函数与发布脚本一致',
    U.ASSET.portable('0.6.0') === 'BlockNexus-v0.6.0-portable.zip' &&
      U.ASSET.meta === 'update.json' && U.ASSET.sums === 'SHA256SUMS.txt' &&
      U.ASSET.sig === 'update.json.sig');
}
{
  const sums = U.parseChecksums(
    `${HASH_A}  BlockNexus-v0.6.0-app.zip\n${HASH_B} *BlockNexus-v0.6.0-portable.zip\ngarbage\n  ${HASH_A.toUpperCase()}   update.json\n`);
  check('sums: 标准/星号/大写十六进制都能解析', sums['BlockNexus-v0.6.0-app.zip'] === HASH_A &&
    sums['BlockNexus-v0.6.0-portable.zip'] === HASH_B && sums['update.json'] === HASH_A);
  check('sums: 垃圾行被忽略（不产生键）', Object.keys(sums).length === 3);
  check('hash: 声明缺失时返回 null（调用方必须拒绝更新）',
    U.expectedHash(sums, 'nope.zip') === null && U.expectedHash(null, 'x') === null);
}

// ---------- 升级计划 ----------
const directMeta = U.parseUpdateMeta({
  version: '0.6.0', severity: 'recommended', breaking: false, minSourceVersion: '0.5.0', dataSchema: 1, minSchema: 1,
}).meta;
{
  const p = U.planUpgrade({ localVersion: '0.5.0', localSchema: 1, meta: directMeta });
  check('plan: 同 schema 直跳允许', p.allowed === true && p.mode === U.KIND_DIRECT && p.migrations.length === 0);
}
{
  const p = U.planUpgrade({ localVersion: '0.6.0', localSchema: 1, meta: directMeta });
  check('plan: 不比当前新 → 拒绝且给原因',
    p.allowed === false && p.reasonKey === 'update.version-not-newer');
}
{
  const p = U.planUpgrade({ localVersion: '0.5.0', localSchema: 1, meta: {} });
  check('plan: 元数据无效 → 拒绝（update.meta-invalid）',
    p.allowed === false && p.reasonKey === 'update.meta-invalid');
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', breaking: true, minSourceVersion: '0.7.0', bridge: ['0.7.0', '0.8.0'], irreversible: true, requiresAgentReinstall: true }).meta;
  const p = U.planUpgrade({ localVersion: '0.5.0', localSchema: 1, meta });
  check('plan: 源版本过旧 + 有桥接 → 只允许先升桥接版本',
    p.allowed === true && p.mode === U.KIND_BRIDGE && p.bridgeVersion === '0.7.0' &&
      p.reasonKey === 'update.needs-bridge');
  check('plan: 破坏性/不可逆/需重装 Agent 都进警告',
    p.warnings.includes('update.warn-breaking') && p.warnings.includes('update.warn-irreversible') &&
      p.warnings.includes('update.warn-agent-reinstall'));
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', minSourceVersion: '0.7.0' }).meta;
  const p = U.planUpgrade({ localVersion: '0.5.0', localSchema: 1, meta });
  check('plan: 源版本过旧且无桥接 → 只能手动',
    p.allowed === false && p.mode === U.KIND_MANUAL && p.reasonKey === 'update.needs-manual');
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', dataSchema: 3, minSchema: 2 }).meta;
  const far = U.planUpgrade({ localVersion: '0.8.0', localSchema: 1, meta });
  check('plan: 本地 schema 低于迁移链起点且无桥接 → 手动',
    far.allowed === false && far.reasonKey === 'update.needs-manual');
  const bridged = U.planUpgrade({ localVersion: '0.8.0', localSchema: 1, meta: U.parseUpdateMeta({ version: '0.9.0', dataSchema: 3, minSchema: 2, bridge: ['0.8.5'] }).meta });
  check('plan: schema 过旧 + 有桥接 → 先升桥接',
    bridged.allowed === true && bridged.mode === U.KIND_BRIDGE && bridged.bridgeVersion === '0.8.5');
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', dataSchema: 3 }).meta;
  const p = U.planUpgrade({ localVersion: '0.8.0', localSchema: 1, meta });
  check('plan: 迁移链逐级列出',
    p.migrations.length === 2 && p.migrations[0].from === 1 && p.migrations[0].to === 2 &&
      p.migrations[1].from === 2 && p.migrations[1].to === 3, JSON.stringify(p.migrations));
}
{
  // 发布纪律：桥接版本自己的 update.json 必须允许「当前来源」直装，否则「先升级到 vX」这一跳也会被挡。
  const bridgeMeta = U.parseUpdateMeta({ version: '0.7.0', minSourceVersion: '0.6.0', dataSchema: 3 }).meta;
  const p = U.planUpgrade({ localVersion: '0.6.0', localSchema: 3, meta: bridgeMeta });
  check('plan: 桥接目标自身能被 0.6.0 直装（发布纪律）',
    p.allowed === true && p.mode === U.KIND_DIRECT);
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', minNode: 20 }).meta;
  const p = U.planUpgrade({ localVersion: '0.8.0', localSchema: 1, meta, currentNode: 16 });
  check('plan: Node 版本不够 → 拒绝', p.allowed === false && p.reasonKey === 'update.node-too-old');
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', lockHash: HASH_B }).meta;
  const r = U.needsFullPackage(meta, { lockHash: HASH_A });
  check('needsFullPackage: lock 哈希不同 → 需要完整包（reason=lock）',
    r.needed === true && r.reason === 'lock' && r.reasonKey === 'update.needs-full-package');
  check('needsFullPackage: 未声明哈希 → 不强制完整包',
    U.needsFullPackage(U.parseUpdateMeta({ version: '0.9.0' }).meta, { lockHash: HASH_A }).needed === false);
}
{
  const meta = U.parseUpdateMeta({ version: '0.9.0', shellHash: HASH_B }).meta;
  const r = U.needsFullPackage(meta, { shellHash: HASH_A });
  check('needsFullPackage: shell 哈希不同 → 需要完整包（reason=shell）',
    r.needed === true && r.reason === 'shell');
}

// ---------- 自动更新策略 ----------
{
  const meta = U.parseUpdateMeta({
    version: '0.6.0', severity: 'security', autoSafe: true, breaking: false,
  }).meta;
  const plan = U.planUpgrade({ localVersion: '0.5.0', localSchema: 1, meta });
  const base = { idle: true, exposedWithoutAuth: false, failures: 0, lastAttemptAt: 0, now: 1e12 };
  check('auto: 全部满足才允许', U.shouldAutoApply({ meta, plan, ctx: base }).ok === true);
  check('auto: 对外且免密 → 拒绝',
    U.shouldAutoApply({ meta, plan, ctx: { ...base, exposedWithoutAuth: true } }).reasonKey === 'update.disabled-exposed');
  check('auto: 忙 → 拒绝',
    U.shouldAutoApply({ meta, plan, ctx: { ...base, idle: false } }).reasonKey === 'update.busy');
  check('auto: 未声明 autoSafe → 拒绝（v1.0 前不猜 semver）',
    U.shouldAutoApply({ meta: { ...meta, autoSafe: false }, plan, ctx: base }).reasonKey === 'update.auto-not-declared');
  check('auto: recommended/optional 不自动',
    U.shouldAutoApply({ meta: { ...meta, severity: 'recommended' }, plan, ctx: base }).reasonKey === 'update.auto-severity' &&
      U.shouldAutoApply({ meta: { ...meta, severity: 'optional' }, plan, ctx: base }).reasonKey === 'update.auto-severity');
  check('auto: 破坏性/需重装/不可逆 一律不自动',
    U.shouldAutoApply({ meta: { ...meta, breaking: true }, plan, ctx: base }).reasonKey === 'update.auto-breaking' &&
      U.shouldAutoApply({ meta: { ...meta, requiresAgentReinstall: true }, plan, ctx: base }).reasonKey === 'update.auto-agent-reinstall' &&
      U.shouldAutoApply({ meta: { ...meta, irreversible: true }, plan, ctx: base }).reasonKey === 'update.auto-irreversible');
  check('auto: 连续失败 3 次 → 退避',
    U.shouldAutoApply({ meta, plan, ctx: { ...base, failures: 3 } }).reasonKey === 'update.auto-backoff');
  check('auto: 24h 冷却内不再尝试',
    U.shouldAutoApply({ meta, plan, ctx: { ...base, lastAttemptAt: base.now - 1000 } }).reasonKey === 'update.auto-cooldown');
  check('auto: 计划不允许时不自动',
    U.shouldAutoApply({ meta, plan: { allowed: false, reasonKey: 'update.needs-manual' }, ctx: base }).reasonKey === 'update.needs-manual');
}

// ---------- 回滚决策 ----------
check('rollback: 无备份 → 拒绝', U.canRollback({ hasBackup: false }).ok === false);
check('rollback: 不可逆迁移 → 拒绝（备份仍保留）',
  U.canRollback({ hasBackup: true, irreversible: true }).reasonKey === 'update.rollback-refused');
check('rollback: 有备份且可逆 → 允许', U.canRollback({ hasBackup: true }).ok === true);
check('decideRollback: 健康 → 不动', U.decideRollback({ healthOk: true }).action === 'none');
check('decideRollback: 不健康 → 回滚', U.decideRollback({ healthOk: false }).action === 'rollback');
check('decideRollback: 不健康 + 不可逆 → 拒绝回滚',
  U.decideRollback({ healthOk: false, irreversible: true }).action === 'refuse');

// ---------- 归档与写入安全 ----------
check('archive: 正常相对路径放行', U.assertSafeArchiveEntry('panel/server.js').ok === true);
check('archive: ../ 拒绝', U.assertSafeArchiveEntry('../../evil.js').ok === false);
check('archive: 中间夹 .. 拒绝', U.assertSafeArchiveEntry('panel/../../evil.js').ok === false);
check('archive: 绝对路径拒绝', U.assertSafeArchiveEntry('/etc/passwd').ok === false);
check('archive: 盘符拒绝', U.assertSafeArchiveEntry('C:\\Windows\\x.dll').ok === false);
check('archive: 反斜杠形式的 .. 拒绝', U.assertSafeArchiveEntry('..\\evil.js').ok === false);
check('archive: NUL 拒绝', U.assertSafeArchiveEntry('a\0b').ok === false);
check('archive: 空/超长拒绝', U.assertSafeArchiveEntry('').ok === false &&
  U.assertSafeArchiveEntry('a'.repeat(1001)).ok === false);

const allow = ['panel/server.js', 'web/dist/index.html', 'agent/agent.js', 'scripts/panel-updater.js',
  'package.json', 'package-lock.json', 'images/logo.png', 'install.json', 'manifest.json', 'README.md'];
const deny = ['data/config.json', 'data/update/x', '.git/config', '.github/workflows/ci.yml', 'desin/a.png',
  'docs/shenji/a.md', 'web/src/App.tsx', 'agent/src/agent.js', 'node_modules/x/y.js', 'root.txt', '.gitignore',
  'release/app.zip', 'evil.txt'];
check('write: 白名单全部放行', allow.every((p) => U.canWritePath(p).ok === true),
  JSON.stringify(allow.filter((p) => !U.canWritePath(p).ok)));
check('write: 敏感/仓库路径全部拒绝', deny.every((p) => U.canWritePath(p).ok === false),
  JSON.stringify(deny.filter((p) => U.canWritePath(p).ok)));
check('write: Windows 分隔符归一化后判定', U.canWritePath('panel\\server.js').ok === true &&
  U.canWritePath('data\\config.json').ok === false);
check('write: deny 优先于 allow（web/src 在 deny，web/dist 在 allow）',
  U.canWritePath('web/dist/a.js').ok === true && U.canWritePath('web/src/a.tsx').ok === false);

// ---------- 本地哈希（应用包够不够用） ----------
{
  const { createHash } = require('crypto');
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const entries = [{ name: 'B.dll', hash: HASH_A }, { name: 'A.exe', hash: HASH_B }];
  // 公式：按文件名 ordinal 升序 → "name:hash" 用 \n 连接 → SHA256
  const expect = sha([`A.exe:${HASH_B}`, `B.dll:${HASH_A}`].join('\n'));
  check('shellHash: 公式与发布脚本一致（按名排序 + name:hash + \\n）',
    U.shellHashOf(entries) === expect, U.shellHashOf(entries));
  check('shellHash: 与传入顺序无关',
    U.shellHashOf([...entries].reverse()) === expect);
  check('shellHash: 空/缺哈希 → 空串（表示无法判定）',
    U.shellHashOf([]) === '' && U.shellHashOf([{ name: 'A.exe', hash: '' }]) === '');
  check('shellHash: 前缀相近的命名按 ordinal 排（.config 在 : 之前）',
    U.shellHashOf([{ name: 'BlockNexus.exe', hash: HASH_A }, { name: 'BlockNexus.exe.config', hash: HASH_B }]) ===
      sha([`BlockNexus.exe:${HASH_A}`, `BlockNexus.exe.config:${HASH_B}`].join('\n')),
    '排序与 build-release.ps1 的 Ordinal 排序不一致');
  check('shellHash: SHELL_FILES 覆盖 5 个外壳文件', U.SHELL_FILES.length === 5);
  check('git 远端白名单: 只认本项目仓库',
    U.isOfficialGitRemote('https://github.com/live-ling/BlockNexus.git') === true &&
      U.isOfficialGitRemote('git@github.com:live-ling/BlockNexus.git') === true &&
      U.isOfficialGitRemote('https://github.com/evil/BlockNexus.git') === false &&
      U.isOfficialGitRemote('') === false);
  const os2 = require('os');
  const fs2 = require('fs');
  const tmp2 = fs2.mkdtempSync(path.join(os2.tmpdir(), 'bn-hash-'));
  fs2.writeFileSync(path.join(tmp2, 'package-lock.json'), '{"lockfileVersion":3}');
  fs2.writeFileSync(path.join(tmp2, 'BlockNexus.exe'), 'MZ');
  const h = U.computeLocalHashes(tmp2);
  check('computeLocalHashes: 有 lock 与外核文件时都能算出',
    h.lockHash === sha('{"lockfileVersion":3}') && h.shellHash !== '' && h.shellFiles.length === 1,
    JSON.stringify(h));
  fs2.rmSync(path.join(tmp2, 'BlockNexus.exe'));
  const h2 = U.computeLocalHashes(tmp2);
  check('computeLocalHashes: 外壳文件缺失 → shellHash 为空串', h2.shellHash === '' && h2.shellFiles.length === 0);
  fs2.rmSync(tmp2, { recursive: true, force: true });
}

// ---------- panel/api.js 必须复用同一份版本比较（防止两套实现漂移） ----------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'panel', 'api.js'), 'utf8');
  check('api.js 复用 panel/update.js 的 semverGreater（不再自带一份）',
    /require\(['"]\.\/update['"]\)/.test(src) && !/function semverGreater\s*\(/.test(src),
    '仍在 api.js 里自带 semverGreater 实现');
}

console.log(`\n${pass}/${total} panel-update cases passed`);
process.exit(pass === total ? 0 : 1);
