'use strict';
// 发布收尾：给 update.json 补 files 哈希、签名（update.json.sig）、重算 SHA256SUMS.txt。
//
// 为什么不在 build-release.ps1 里做：签名要按「最终写盘的原始字节」进行，
// PowerShell 的 JSON 往返/编码很容易改变字节；交给 Node 读写同一份 Buffer 最稳。
//
// 用法：
//   BLOCKNEXUS_SIGNING_KEY=<base64(PKCS8 DER)> node scripts/finalize-release.js --dir <发布目录>
//   node scripts/finalize-release.js --dir <发布目录> --key data/update-signing-key.b64
//   node scripts/finalize-release.js --dir <发布目录> --verify
//
// 说明：
//   · files 只覆盖三个 zip（不覆盖 SHA256SUMS / update.json / .sig，避免循环引用）；
//   · 签名对象是 update.json 的原始字节；写入后不再改动它；
//   · SHA256SUMS.txt 覆盖目录内全部文件（含 update.json 与 .sig），供 0.6.0 与人工核对。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const upd = require(path.join(__dirname, '..', 'panel', 'update.js'));
const signature = require(path.join(__dirname, '..', 'panel', 'signature.js'));

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeSums(dir) {
  const names = fs
    .readdirSync(dir)
    .filter((n) => n !== upd.ASSET.sums && fs.statSync(path.join(dir, n)).isFile())
    .sort();
  const lines = names.map((n) => `${sha256(path.join(dir, n))}  ${n}`);
  fs.writeFileSync(path.join(dir, upd.ASSET.sums), lines.join('\n'), { encoding: 'utf8' });
  return lines.length;
}

/**
 * @param {{dir?:string, key?:string, keyId?:string, noSign?:boolean, verifyOnly?:boolean,
 *          publicKeys?:object, requireAssets?:boolean}} opts
 * @returns {{ok:boolean, version?:string, files?:object, signed?:boolean, sumsLines?:number}}
 */
function finalizeRelease(opts = {}) {
  const DIR = path.resolve(opts.dir || path.join(__dirname, '..', 'release'));
  const META = path.join(DIR, upd.ASSET.meta);
  const SIG = path.join(DIR, upd.ASSET.sig);
  const KEY_ID = String(opts.keyId || 'bn-1').trim() || 'bn-1';
  const publicKeys = opts.publicKeys || signature.PUBLIC_KEYS;
  if (!fs.existsSync(META)) throw new Error(`缺少 ${META}`);

  const raw = fs.readFileSync(META, 'utf8');
  const parsed = upd.parseUpdateMeta(raw);
  if (!parsed.ok) throw new Error('update.json 非法（先修好再 finalize）');
  const version = parsed.meta.version;

  if (opts.verifyOnly) {
    const sig = fs.existsSync(SIG) ? fs.readFileSync(SIG, 'utf8') : '';
    const verdict = signature.verifyUpdateMeta(raw, sig, publicKeys);
    if (!verdict.ok) throw new Error(`签名无效：${JSON.stringify(verdict)}`);
    return { ok: true, version, signed: true, files: parsed.meta.files || {} };
  }

  // ---------- 1. files（只覆盖三个 zip） ----------
  const obj = JSON.parse(raw);
  const files = {};
  for (const name of [upd.ASSET.app(version), upd.ASSET.portable(version), upd.ASSET.shell(version)]) {
    const p = path.join(DIR, name);
    if (!fs.existsSync(p)) {
      if (opts.requireAssets === false) continue;
      throw new Error(`缺少资产：${name}（先跑 build-release.ps1）`);
    }
    files[name] = sha256(p);
  }
  obj.schema = Math.max(Number(obj.schema) || 1, 2);
  obj.files = files;
  // 固定格式写回（签名覆盖最终字节；这里只要求「写一次就定稿」）
  fs.writeFileSync(META, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });

  // ---------- 2. 签名 ----------
  let signed = false;
  if (opts.noSign) {
    try { fs.rmSync(SIG, { force: true }); } catch {}
  } else {
    let key = String(opts.key || process.env.BLOCKNEXUS_SIGNING_KEY || '').trim();
    if (!key) throw new Error('缺少签名私钥：设置 BLOCKNEXUS_SIGNING_KEY 或传 --key <文件>（或用 --no-sign）');
    let keyText = key;
    // 允许传文件路径（本地开发）
    const maybeFile = path.resolve(key);
    if (!/^[A-Za-z0-9+/=\s]+$/.test(key) && fs.existsSync(maybeFile)) {
      keyText = fs.readFileSync(maybeFile, 'utf8').trim();
    }
    const finalRaw = fs.readFileSync(META, 'utf8');
    const sigText = signature.signUpdateMeta(finalRaw, keyText, KEY_ID);
    fs.writeFileSync(SIG, sigText, { encoding: 'utf8' });
    const verdict = signature.verifyUpdateMeta(finalRaw, sigText, publicKeys);
    if (!verdict.ok) throw new Error(`自检失败：签名无法通过验签（${JSON.stringify(verdict)}）`);
    signed = true;
  }

  // ---------- 3. SHA256SUMS.txt ----------
  const sumsLines = writeSums(DIR);
  return { ok: true, version, files, signed, sumsLines };
}

function main() {
  const arg = (name, fallback = '') => {
    const i = process.argv.indexOf('--' + name);
    if (i < 0) return fallback;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? 'true' : v;
  };
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', 'release')));
  try {
    const r = finalizeRelease({
      dir,
      key: arg('key', ''),
      keyId: arg('key-id', 'bn-1'),
      noSign: process.argv.includes('--no-sign'),
      verifyOnly: process.argv.includes('--verify'),
    });
    if (r.ok && r.signed) console.log(`✓ 签名完成：v${r.version}（${Object.keys(r.files || {}).length} 个资产）`);
    else if (r.ok) console.log(`✓ 完成：v${r.version}${r.signed ? '' : '（未签名）'}`);
    if (r.sumsLines) console.log(`✓ SHA256SUMS.txt: ${r.sumsLines} 行`);
    console.log(`\n下一步：node scripts/check-release.js --dir ${dir}${r.signed ? ' --require-signature' : ''}`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { finalizeRelease, writeSums };
