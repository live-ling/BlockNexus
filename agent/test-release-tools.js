'use strict';
// 发布门禁 / 收尾脚本的自测（不启动子进程，直接调导出的函数）。
//
// 覆盖：files 生成、签名、SHA256SUMS、dataSchema/minSourceVersion 拦截、缺件、篡改。
// 运行：node agent/test-release-tools.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const U = require(path.join(__dirname, '..', 'panel', 'update.js'));
const M = require(path.join(__dirname, '..', 'panel', 'migrate.js'));
const { checkRelease } = require(path.join(__dirname, '..', 'scripts', 'check-release.js'));
const { finalizeRelease } = require(path.join(__dirname, '..', 'scripts', 'finalize-release.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-rel-root-'));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-rel-out-'));
const VERSION = '0.7.0';

try {
  // 临时仓库根：package.json + lock + 五个外壳文件
  fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ version: VERSION }, null, 2));
  fs.writeFileSync(path.join(ROOT, 'package-lock.json'), '{"lockfileVersion":3}\n');
  for (const f of U.SHELL_FILES) fs.writeFileSync(path.join(ROOT, f), `shell:${f}`);
  const local = U.computeLocalHashes(ROOT);

  // 三个 zip（内容随意，finalize 会算哈希）
  for (const name of [U.ASSET.app(VERSION), U.ASSET.portable(VERSION), U.ASSET.shell(VERSION)]) {
    fs.writeFileSync(path.join(OUT, name), `zip:${name}`);
  }

  const baseMeta = {
    schema: 1,
    version: VERSION,
    severity: 'recommended',
    autoSafe: false,
    breaking: false,
    requiresAgentReinstall: false,
    minSourceVersion: '0.6.0',
    bridge: [],
    dataSchema: M.CURRENT_SCHEMA,
    minSchema: 1,
    irreversible: false,
    minNode: 18,
    lockHash: local.lockHash,
    shellHash: local.shellHash,
    summary: 'test',
    notesUrl: '',
  };
  const writeMeta = (patch) =>
    fs.writeFileSync(path.join(OUT, U.ASSET.meta), JSON.stringify({ ...baseMeta, ...patch }, null, 2) + '\n');
  writeMeta({});

  // 临时密钥对（不碰仓库里的生产私钥）
  const pair = crypto.generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const keys = { 'test-1': pub };

  const fin = finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  check('finalize: 生成 files / 签名 / sums',
    fin.ok === true && Object.keys(fin.files).length === 3 && fin.signed === true && fin.sumsLines > 0,
    JSON.stringify(fin));

  const good = checkRelease({
    dir: OUT,
    root: ROOT,
    requireSignature: true,
    publicKeys: keys,
    tag: 'v0.7.0',
  });
  check('checkRelease: 正常产物全绿', good.ok === true,
    good.results.filter((r) => !r.ok).map((r) => `${r.desc}: ${r.detail}`).join(' | '));

  // 篡改 zip
  fs.appendFileSync(path.join(OUT, U.ASSET.app(VERSION)), 'x');
  const tampered = checkRelease({ dir: OUT, root: ROOT, publicKeys: keys });
  check('checkRelease: 篡改 zip 会失败',
    tampered.ok === false && tampered.results.some((r) => !r.ok && r.desc.includes('哈希匹配')));
  fs.writeFileSync(path.join(OUT, U.ASSET.app(VERSION)), `zip:${U.ASSET.app(VERSION)}`);

  // 重新 finalize（修复哈希），再测元数据错误
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  writeMeta({ dataSchema: 1 });
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  const badSchema = checkRelease({ dir: OUT, root: ROOT, publicKeys: keys });
  check('checkRelease: dataSchema 与 CURRENT_SCHEMA 不符会失败',
    badSchema.ok === false && badSchema.results.some((r) => !r.ok && r.desc.includes('dataSchema')));

  writeMeta({});
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  writeMeta({ minSourceVersion: '' });
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  const badSrc = checkRelease({ dir: OUT, root: ROOT, publicKeys: keys });
  check('checkRelease: minSourceVersion 为空会失败',
    badSrc.ok === false && badSrc.results.some((r) => !r.ok && r.desc.includes('minSourceVersion')));

  writeMeta({});
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  fs.rmSync(path.join(OUT, U.ASSET.app(VERSION)));
  const missing = checkRelease({ dir: OUT, root: ROOT, publicKeys: keys });
  check('checkRelease: 缺 app zip 会失败',
    missing.ok === false && missing.results.some((r) => !r.ok && r.desc.includes('资产存在')));

  // 签名篡改
  fs.writeFileSync(path.join(OUT, U.ASSET.app(VERSION)), `zip:${U.ASSET.app(VERSION)}`);
  finalizeRelease({ dir: OUT, key: priv, keyId: 'test-1', publicKeys: keys });
  const sigPath = path.join(OUT, U.ASSET.sig);
  fs.writeFileSync(sigPath, fs.readFileSync(sigPath, 'utf8').replace(/"sig":\s*"[^"]+"/, '"sig": "AAAA"'));
  const badSig = checkRelease({ dir: OUT, root: ROOT, requireSignature: true, publicKeys: keys });
  check('checkRelease: 签名被篡改会失败',
    badSig.ok === false && badSig.results.some((r) => !r.ok && r.desc.includes('签名')));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
}

console.log(`\n${pass}/${total} release-tools cases passed`);
process.exit(pass === total ? 0 : 1);
