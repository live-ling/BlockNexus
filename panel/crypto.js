'use strict';
// BlockNexus 加密层：Agent 与面板之间的 token 加密通道
// 握手：双方交换随机 nonce → 用 HKDF 从共享 token 派生三个会话密钥
//   kA2P  Agent→面板 方向加密密钥
//   kP2A  面板→Agent 方向加密密钥
//   kProof 挑战-应答证明密钥（不传输 token 本身）
// 数据帧（二进制）：[0x01][4B nonce前缀][8B 计数器 BE][AES-256-GCM 密文+16B tag]
// AAD = 计数器字节，接收端强制计数器单调递增，防重放。

const crypto = require('crypto');

const FRAME_VERSION = 0x01;

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
  // info 标签沿用 MCPan 时代的 'mcpan/*'：两端各有一份且必须一致，
  // 改名会让旧 Agent 与新面板握手失败（解密互相踢），等哪天统一弃用旧 Agent 再换
  return {
    kA2P: hkdf(token, salt, 'mcpan/a2p'),
    kP2A: hkdf(token, salt, 'mcpan/p2a'),
    kProof: hkdf(token, salt, 'mcpan/proof'),
  };
}

// label: 'auth1' = 连接发起方证明；'auth2' = 响应方证明（双向认证）
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
    return Buffer.concat([
      Buffer.from([FRAME_VERSION]),
      this.prefix,
      counterBuf,
      ct,
      c.getAuthTag(),
    ]);
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
    const plain = Buffer.concat([
      d.update(frame.subarray(13, frame.length - 16)),
      d.final(),
    ]);
    this.last = counter;
    return plain;
  }
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomNonce() {
  return crypto.randomBytes(16);
}

module.exports = { FRAME_VERSION, hkdf, deriveKeys, computeProof, Sealer, Opener, randomToken, randomNonce };
