'use strict';
// 发布门禁：在 gh release create 之前把「少传/传错/元数据写错」变成机器错误。
//
// 为什么要它：0.6.0 的 update.json 实际写着 dataSchema=1（代码是 3）、minSourceVersion=""，
// 发布脚本的默认值也会照抄这两个错误。人工 checklist 拦不住，必须让脚本退出码非 0。
//
// 用法：
//   node scripts/check-release.js --dir <发布产物目录> [--root <仓库根>]
//     [--require-signature] [--tag v1.0.0]
//     [--expect-lock-hash <64hex>] [--expect-shell-hash <64hex>]
//
// 退出码：0 = 全绿；1 = 有失败项。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const upd = require(path.join(__dirname, '..', 'panel', 'update.js'));
const migrate = require(path.join(__dirname, '..', 'panel', 'migrate.js'));
const signature = require(path.join(__dirname, '..', 'panel', 'signature.js'));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 纯检查（不退出进程，便于单测）。
 * @param {{dir?:string, root?:string, requireSignature?:boolean, tag?:string,
 *          expectLockHash?:string, expectShellHash?:string, publicKeys?:object}} opts
 * @returns {{ok:boolean, results:{desc:string,ok:boolean,detail?:string}[], meta:object|null}}
 */
function checkRelease(opts = {}) {
  const DIR = path.resolve(opts.dir || path.join(__dirname, '..', 'release'));
  const ROOT = path.resolve(opts.root || path.join(__dirname, '..'));
  const REQUIRE_SIG = opts.requireSignature === true;
  const TAG = String(opts.tag || '').trim().replace(/^v/i, '');
  const EXPECT_LOCK = String(opts.expectLockHash || '').trim().toLowerCase();
  const EXPECT_SHELL = String(opts.expectShellHash || '').trim().toLowerCase();
  const publicKeys = opts.publicKeys || signature.PUBLIC_KEYS;
  const results = [];
  const add = (desc, ok, detail) => {
    results.push({ desc, ok: !!ok, detail: detail || '' });
    return !!ok;
  };

  const metaPath = path.join(DIR, upd.ASSET.meta);
  const rawMeta = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
  if (!add('update.json 存在', !!rawMeta, metaPath)) return { ok: false, results, meta: null };

  const parsed = upd.parseUpdateMeta(rawMeta);
  if (!add('update.json 可解析且版本合法', parsed.ok === true, JSON.stringify(parsed.meta))) {
    return { ok: false, results, meta: null };
  }
  const meta = parsed.meta;

  // ---------- 版本 / 元数据一致性 ----------
  const pkg = readJson(path.join(ROOT, 'package.json')) || {};
  add('package.json.version === update.json.version',
    String(pkg.version) === String(meta.version), `${pkg.version} vs ${meta.version}`);
  if (TAG) add('tag === update.json.version', TAG === String(meta.version), `${TAG} vs ${meta.version}`);
  add('dataSchema === migrate.CURRENT_SCHEMA',
    Number(meta.dataSchema) === Number(migrate.CURRENT_SCHEMA),
    `${meta.dataSchema} vs ${migrate.CURRENT_SCHEMA}`);

  const migrationKeys = Object.keys(migrate.MIGRATIONS || {}).map(Number).filter((n) => Number.isInteger(n));
  const oldest = migrationKeys.length ? Math.min(...migrationKeys) : 1;
  add('minSchema <= 迁移链最旧 schema', Number(meta.minSchema) <= oldest, `${meta.minSchema} vs ${oldest}`);

  add('minSourceVersion 非空且合法', !!upd.normalizeVersion(meta.minSourceVersion), meta.minSourceVersion);
  if (upd.normalizeVersion(meta.minSourceVersion)) {
    add('minSourceVersion <= version', !upd.semverGreater(meta.minSourceVersion, meta.version),
      `${meta.minSourceVersion} > ${meta.version}`);
  }

  // bridge：升序、去重、介于 minSourceVersion 与 version 之间
  const bridge = Array.isArray(meta.bridge) ? meta.bridge : [];
  let bridgeOk = true;
  for (let i = 0; i < bridge.length; i++) {
    if (i > 0 && !upd.semverGreater(bridge[i], bridge[i - 1])) bridgeOk = false;
    if (meta.minSourceVersion && !upd.semverGreater(bridge[i], meta.minSourceVersion)) bridgeOk = false;
    if (!upd.semverGreater(meta.version, bridge[i])) bridgeOk = false;
  }
  add('bridge 升序、去重、落在 (minSourceVersion, version) 内', bridgeOk, JSON.stringify(bridge));

  // ---------- 资产与哈希 ----------
  const required = [upd.ASSET.app(meta.version), upd.ASSET.portable(meta.version), upd.ASSET.shell(meta.version)];
  for (const name of required) {
    const file = path.join(DIR, name);
    const exists = fs.existsSync(file);
    add(`资产存在: ${name}`, exists);
    if (!exists) continue;
    const declared = meta.files && meta.files[name];
    add(`update.json.files 声明了 ${name}`, !!declared);
    if (declared) add(`哈希匹配: ${name}`, sha256(file) === declared, `${sha256(file)} vs ${declared}`);
  }

  const sumsPath = path.join(DIR, upd.ASSET.sums);
  const sumsText = fs.existsSync(sumsPath) ? fs.readFileSync(sumsPath, 'utf8') : '';
  add('SHA256SUMS.txt 存在', !!sumsText, sumsPath);
  if (sumsText) {
    const sums = upd.parseChecksums(sumsText);
    for (const name of required) {
      if (!meta.files || !meta.files[name]) continue;
      add(`SHA256SUMS.txt 与 files 一致: ${name}`, sums[name] === meta.files[name],
        `${sums[name] || '(缺失)'} vs ${meta.files[name]}`);
    }
  }

  // ---------- lockHash / shellHash ----------
  const local = upd.computeLocalHashes(ROOT);
  const expectLock = EXPECT_LOCK || local.lockHash;
  const expectShell = EXPECT_SHELL || local.shellHash;
  add('lockHash 与实际 package-lock.json 一致', meta.lockHash === expectLock,
    `${meta.lockHash || '(空)'} vs ${expectLock || '(空)'}`);
  add('shellHash 与实际外壳文件一致', meta.shellHash === expectShell,
    `${meta.shellHash || '(空)'} vs ${expectShell || '(空)'}`);

  // ---------- 签名 ----------
  if (REQUIRE_SIG) {
    const sigPath = path.join(DIR, upd.ASSET.sig);
    const sigText = fs.existsSync(sigPath) ? fs.readFileSync(sigPath, 'utf8') : '';
    if (add('update.json.sig 存在', !!sigText, sigPath)) {
      const verdict = signature.verifyUpdateMeta(rawMeta, sigText, publicKeys);
      add('update.json 签名有效', verdict.ok === true, JSON.stringify(verdict));
    }
  }

  return { ok: results.every((r) => r.ok), results, meta };
}

function main() {
  const arg = (name, fallback = '') => {
    const i = process.argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? 'true' : v;
  };
  const opts = {
    dir: arg('dir', path.join(__dirname, '..', 'release')),
    root: arg('root', path.join(__dirname, '..')),
    requireSignature: process.argv.includes('--require-signature'),
    tag: arg('tag', ''),
    expectLockHash: arg('expect-lock-hash', ''),
    expectShellHash: arg('expect-shell-hash', ''),
  };
  console.log(`发布目录: ${path.resolve(opts.dir)}`);
  console.log(`仓库根:   ${path.resolve(opts.root)}`);
  const r = checkRelease(opts);
  for (const item of r.results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.desc}${!item.ok && item.detail ? '  → ' + item.detail : ''}`);
  }
  console.log(r.ok ? '\n全部门禁通过' : `\n${r.results.filter((x) => !x.ok).length} 项失败`);
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { checkRelease };
