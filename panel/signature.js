'use strict';
// 发布清单签名/验签：Ed25519（Node 内置 crypto，零依赖）。
//
// 为什么需要它：镜像要能承载 update.json 与 zip，就必须让面板在**不信任传输通道**的
// 前提下验证内容。SHA256SUMS 仍然保留（0.6.0 只认它），但校验值本身也必须被签名，
// 否则镜像可以同时替换 update.json 与 SHA256SUMS。
//
// 约定：
//   · 签名对象是 update.json 的**原始字节**（发布脚本与面板都不重新序列化）；
//   · update.json.sig = { schema: 1, keyId, sig: base64(Ed25519) }；
//   · update.json.files = { 资产名: SHA256 }，把 zip 的哈希也锚进签名；
//   · 公钥内置在本文件（base64 SPKI DER）；私钥绝不进仓库。

const crypto = require('crypto');

/** 生产公钥：keyId → base64(SPKI DER)。轮换时新增一项，旧 keyId 保留。 */
const PUBLIC_KEYS = Object.freeze({
  'bn-1': 'MCowBQYDK2VwAyEA15rR8mG4qP+Dv6jYg8yf7ZaclhBea1eoRZJ2MKA9IA0=',
});

const SIG_SCHEMA = 1;

/** 解析 update.json.sig；非法一律返回 null（调用方按「无签名」处理） */
function parseSig(text) {
  if (!text) return null;
  let obj = text;
  if (typeof text === 'string') {
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (Number(obj.schema) !== SIG_SCHEMA) return null;
  const keyId = String(obj.keyId || '').trim();
  const sig = String(obj.sig || '').trim();
  if (!keyId || !/^[A-Za-z0-9._-]{1,40}$/.test(keyId)) return null;
  if (!/^[A-Za-z0-9+/=]{40,200}$/.test(sig)) return null;
  return { schema: SIG_SCHEMA, keyId, sig };
}

function publicKeyFor(keyId, keys = PUBLIC_KEYS) {
  const b64 = keys[keyId];
  if (!b64) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * 验证 update.json 的签名。
 * @param {string} rawText update.json 原始字节（按 UTF-8 读出的字符串）
 * @param {string} sigText update.json.sig 内容
 * @param {object} [keys] 公钥表（测试注入；默认用内置 PUBLIC_KEYS）
 * @returns {{ok: boolean, keyId?: string, reason?: string}}
 *   reason: missing | invalid | unknown-key | bad-signature | error
 */
function verifyUpdateMeta(rawText, sigText, keys = PUBLIC_KEYS) {
  const sig = parseSig(sigText);
  if (!sig) return { ok: false, reason: 'missing' };
  const key = publicKeyFor(sig.keyId, keys);
  if (!key) return { ok: false, keyId: sig.keyId, reason: 'unknown-key' };
  try {
    const ok = crypto.verify(null, Buffer.from(String(rawText), 'utf8'), key, Buffer.from(sig.sig, 'base64'));
    return ok ? { ok: true, keyId: sig.keyId, reason: '' } : { ok: false, keyId: sig.keyId, reason: 'bad-signature' };
  } catch {
    return { ok: false, keyId: sig.keyId, reason: 'error' };
  }
}

/**
 * 生成 .sig 文件内容。私钥是 base64(PKCS8 DER)。
 * 仅供 scripts/finalize-release.js 使用；面板运行时不调用。
 */
function signUpdateMeta(rawText, privateKeyB64, keyId = 'bn-1') {
  const key = crypto.createPrivateKey({
    key: Buffer.from(String(privateKeyB64 || ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto.sign(null, Buffer.from(String(rawText), 'utf8'), key).toString('base64');
  return JSON.stringify({ schema: SIG_SCHEMA, keyId, sig }, null, 2) + '\n';
}

function keyIds() {
  return Object.keys(PUBLIC_KEYS);
}

module.exports = {
  PUBLIC_KEYS,
  SIG_SCHEMA,
  parseSig,
  verifyUpdateMeta,
  signUpdateMeta,
  keyIds,
};
