'use strict';
// 发布清单签名/验签测试（Ed25519，零依赖）。
//
// 运行：node agent/test-panel-signature.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const S = require(path.join(__dirname, '..', 'panel', 'signature.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const raw = JSON.stringify({ schema: 2, version: '1.0.0', files: { 'a.zip': 'x' } }, null, 2) + '\n';

// ---------- 用临时密钥对测签名/验签（不依赖仓库里的私钥） ----------
const pair = crypto.generateKeyPairSync('ed25519');
const pubB64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const privB64 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const testKeys = { 'test-1': pubB64 };

const sigText = S.signUpdateMeta(raw, privB64, 'test-1');
{
  let obj = null;
  try { obj = JSON.parse(sigText); } catch {}
  check('sign: 产出合法 JSON 且字段齐全',
    !!obj && obj.schema === 1 && obj.keyId === 'test-1' && typeof obj.sig === 'string' && obj.sig.length > 40);
}
check('verify: 正确签名通过',
  S.verifyUpdateMeta(raw, sigText, testKeys).ok === true,
  JSON.stringify(S.verifyUpdateMeta(raw, sigText, testKeys)));
check('verify: 篡改 update.json 一个字节 → bad-signature',
  S.verifyUpdateMeta(raw.replace('1.0.0', '1.0.1'), sigText, testKeys).reason === 'bad-signature');
{
  const obj = JSON.parse(sigText);
  const bad = obj.sig.slice(0, -4) + (obj.sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  check('verify: 篡改签名 → bad-signature',
    S.verifyUpdateMeta(raw, JSON.stringify({ ...obj, sig: bad }), testKeys).reason === 'bad-signature');
}
check('verify: 未知 keyId → unknown-key',
  S.verifyUpdateMeta(raw, JSON.stringify({ schema: 1, keyId: 'nope', sig: JSON.parse(sigText).sig }), testKeys).reason === 'unknown-key');
check('verify: 缺签名 → missing', S.verifyUpdateMeta(raw, '', testKeys).reason === 'missing');
check('verify: 坏 JSON → missing', S.verifyUpdateMeta(raw, '{oops', testKeys).reason === 'missing');
check('verify: 错误 schema → missing',
  S.verifyUpdateMeta(raw, JSON.stringify({ schema: 2, keyId: 'test-1', sig: JSON.parse(sigText).sig }), testKeys).reason === 'missing');
check('verify: 非 base64 签名 → missing',
  S.verifyUpdateMeta(raw, JSON.stringify({ schema: 1, keyId: 'test-1', sig: '!!!' }), testKeys).reason === 'missing');
check('verify: 换一段合法 base64 但非本消息的签名 → bad-signature',
  S.verifyUpdateMeta(raw + ' ', sigText, testKeys).reason === 'bad-signature');

// ---------- 解析器边界 ----------
check('parseSig: 只收对象/schema=1/keyId/合法 base64',
  S.parseSig(JSON.stringify({ schema: 1, keyId: 'a', sig: 'A'.repeat(64) })) !== null &&
    S.parseSig(JSON.stringify({ schema: 1, keyId: '', sig: 'A'.repeat(64) })) === null &&
    S.parseSig(JSON.stringify({ schema: 1, keyId: 'a', sig: 'short' })) === null &&
    S.parseSig(null) === null);

// ---------- 内置公钥 ----------
check('内置公钥: 至少有一把（bn-1）', S.keyIds().includes('bn-1'));

// 本地有私钥时，额外验证「本地私钥 ↔ 内置公钥」确实配对（CI 没有该文件，自动跳过）
{
  const keyFile = path.join(__dirname, '..', 'data', 'update-signing-key.b64');
  if (fs.existsSync(keyFile)) {
    const priv = fs.readFileSync(keyFile, 'utf8').trim();
    const localSig = S.signUpdateMeta(raw, priv, 'bn-1');
    check('内置公钥: 本地私钥签名能通过验签', S.verifyUpdateMeta(raw, localSig).ok === true);
  } else {
    console.log('SKIP | 内置公钥: 本地无私钥文件（CI 正常）');
  }
}

console.log(`\n${pass}/${total} panel-signature cases passed`);
process.exit(pass === total ? 0 : 1);
