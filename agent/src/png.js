'use strict';
// 最小 PNG 编码器 —— 零依赖
//
// 用途：网页地图（P4-1）在 Agent 侧把区块俯视图编码成 PNG，浏览器原生解码。
// 这样前端零解码代码（createImageBitmap 直接用），也不需要自研瓦片二进制格式。
//
// 只实现「8 bit RGBA、非隔行」这一种形态 —— 地图正好只需要它。
// 不做调色板 PNG（虽然更小，但多一套索引同步逻辑，收益不值）。
//
// ⚠ 为什么要自写 CRC32：Node 的 `zlib.crc32` 是 **20.15+ / 22.2+** 才有的，
//   而 Agent 最低支持 Node 16。表驱动 CRC32 只有十几行，自己写最省事。

const zlib = require('zlib');

/** CRC32 查表（多项式 0xEDB88320，与 PNG 规范一致） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/**
 * 计算 CRC32。
 * 标准测试向量：`crc32(Buffer.from('123456789'))` === `0xCBF43926`。
 * @param {Buffer} buf
 * @returns {number} 无符号 32 位
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG 文件签名 */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 组装一个 PNG chunk：长度(4) + 类型(4) + 数据 + CRC(4)。
 * CRC 覆盖「类型 + 数据」（**不含**长度字段）。
 */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 行过滤器：0 = None（原样），2 = Up（减去上一行同列字节） */
const FILTER_NONE = 0;
const FILTER_UP = 2;

/**
 * 编码 PNG。
 *
 * @param {Buffer} rgba 长度必须是 width*height*4，顺序 R,G,B,A
 * @param {number} width
 * @param {number} height
 * @param {{filter?: number, level?: number}} [opts]
 *   filter 默认 **2（Up）**：地图相邻两行高度相似，逐行做差后大量字节归零，
 *   deflate 压缩率明显好于 None（代价是编码时多一次逐字节减法）。
 * @returns {Buffer}
 */
function encodePng(rgba, width, height, opts = {}) {
  const filter = opts.filter ?? FILTER_UP;
  const level = opts.level ?? 6;
  if (!Buffer.isBuffer(rgba)) throw new Error('encodePng 需要 Buffer');
  const stride = width * 4;
  const need = stride * height;
  if (rgba.length !== need) {
    throw new Error(`RGBA 长度不符：期望 ${need}，实际 ${rgba.length}`);
  }

  // 每条扫描线前面加 1 字节过滤器类型
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const cur = y * stride;
    raw[o] = filter;
    if (filter === FILTER_UP && y > 0) {
      const up = cur - stride;
      for (let i = 0; i < stride; i++) raw[o + 1 + i] = (rgba[cur + i] - rgba[up + i]) & 0xff;
    } else {
      // 第一行（Up 的 Prior 视为全 0）与 None 都直接照抄
      rgba.copy(raw, o + 1, cur, cur + stride);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方法（只有 0 合法）
  ihdr[11] = 0; // 过滤器方法（只有 0 合法）
  ihdr[12] = 0; // 非隔行

  const idat = zlib.deflateSync(raw, { level });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { crc32, encodePng, chunk, SIGNATURE, FILTER_NONE, FILTER_UP };
