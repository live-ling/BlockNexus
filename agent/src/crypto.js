'use strict';
// BlockNexus Agent — 加密（AES-256-GCM 帧 + token 挑战握手）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const crypto = require('crypto');

const FRAME_VERSION = 0x01;

// ============================ 加密 ============================
// 与面板 panel/crypto.js 保持一致（Agent 必须零依赖单文件，故内联一份）。

function hkdf(ikm, salt, info, length = 32) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]))
    .digest();
  return t.subarray(0, length);
}

function deriveKeys(token, nonceA, nonceP) {
  const salt = Buffer.concat([nonceA, nonceP]);
  // info 标签：2026-10-06 由历史遗留的 'mcpan/*' 正式改为 'blocknexus/*'。
  // 更名兼容期已结束（已确认无存量旧 Agent 在生产运行），因此不再保留旧标签。
  // ⚠ 两端（agent/src/crypto.js 与 panel/crypto.js）必须逐字一致，否则握手会互相解密失败。
  return {
    kA2P: hkdf(token, salt, 'blocknexus/a2p'),
    kP2A: hkdf(token, salt, 'blocknexus/p2a'),
    kProof: hkdf(token, salt, 'blocknexus/proof'),
  };
}

function computeProof(kProof, label, nonceC, nonceP) {
  return crypto
    .createHmac('sha256', kProof)
    .update(Buffer.concat([Buffer.from(label || 'auth1', 'utf8'), nonceC, nonceP]))
    .digest();
}

function be64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

class Sealer {
  constructor(key) {
    this.key = key;
    this.prefix = crypto.randomBytes(4);
    this.seq = 0;
  }
  seal(plain) {
    const counter = ++this.seq;
    const counterBuf = be64(counter);
    const nonce = Buffer.concat([this.prefix, counterBuf]);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(counterBuf);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([FRAME_VERSION]), this.prefix, counterBuf, ct, c.getAuthTag()]);
  }
}

class Opener {
  constructor(key) {
    this.key = key;
    this.last = 0n;
  }
  open(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 13 + 16 || frame[0] !== FRAME_VERSION) {
      throw new Error('坏帧');
    }
    const prefix = frame.subarray(1, 5);
    const counterBuf = frame.subarray(5, 13);
    const counter = frame.readBigUInt64BE(5);
    if (counter <= this.last) throw new Error('重放帧');
    const nonce = Buffer.concat([prefix, counterBuf]);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    d.setAAD(counterBuf);
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(13, frame.length - 16)), d.final()]);
    this.last = counter;
    return plain;
  }
}

module.exports = { FRAME_VERSION, hkdf, deriveKeys, computeProof, be64, Sealer, Opener };
