'use strict';
// Anvil（.mca）区域文件解析 —— 零依赖
//
// 用途：网页地图（P4-1）需要把世界的方块俯视图画出来，而世界存在 MC 服务器上，
// 所以必须在 Agent 侧读 region 文件。这里实现 Anvil 格式的读取部分。
//
// 格式要点（都是踩过才知道的）：
//   · 区域文件 r.X.Z.mca 覆盖区块坐标 [X*32, X*32+31] × [Z*32, Z*32+31]，共 1024 个
//   · 文件头 8 KiB = 1024 个 4 字节 location + 1024 个 4 字节 timestamp
//     location 的**高 3 字节是扇区偏移**、**低 1 字节是扇区数**（扇区 = 4 KiB）
//     location == 0 表示该区块不存在 —— 这是**正常情况**（未探索区域），不是错误
//   · 每个区块数据：4 字节长度 + 1 字节压缩类型 + 压缩数据
//     压缩类型最高位 0x80 = 数据外置到同名 .mcc 文件（1.15+ 的大区块）
//   · 压缩类型：1 = gzip、2 = zlib、3 = 未压缩
//
// 为什么不用第三方库：Agent 是单文件零依赖产物，且打包器只支持纯 CJS 纯 JS。
// 引入 NBT 库会把体积与依赖面都撑大，而这里只需要读（不需要写）一小部分标签类型。

const zlib = require('zlib');

// ---------- NBT 常量 ----------
const TAG = {
  END: 0,
  BYTE: 1,
  SHORT: 2,
  INT: 3,
  LONG: 4,
  FLOAT: 5,
  DOUBLE: 6,
  BYTE_ARRAY: 7,
  STRING: 8,
  LIST: 9,
  COMPOUND: 10,
  INT_ARRAY: 11,
  LONG_ARRAY: 12,
};

/** 扇区大小：Anvil 的分配单位固定 4 KiB */
const SECTOR_BYTES = 4096;
/** 一个区域文件的区块边长 */
const REGION_CHUNKS = 32;
/** 一个区块的方块边长 */
const CHUNK_SIZE = 16;
/** 区域图像的像素边长（32 区块 × 16 方块） */
const REGION_PIXELS = REGION_CHUNKS * CHUNK_SIZE; // 512

/**
 * 解析 NBT。
 *
 * 只实现读取。long 一律读成 **unsigned BigInt** —— 位解包要做 64 位运算，
 * 用 Number 会在超过 2^53 时静默丢精度，这类 bug 极难发现（表现为地图局部花屏）。
 *
 * @param {Buffer} buf
 * @returns {{name: string, value: any}}
 */
function parseNbt(buf) {
  let p = 0;

  const u8 = () => buf[p++];
  const i16 = () => {
    const v = buf.readInt16BE(p);
    p += 2;
    return v;
  };
  const i32 = () => {
    const v = buf.readInt32BE(p);
    p += 4;
    return v;
  };
  const i64 = () => {
    const v = buf.readBigUInt64BE(p);
    p += 8;
    return v;
  };
  const f32 = () => {
    const v = buf.readFloatBE(p);
    p += 4;
    return v;
  };
  const f64 = () => {
    const v = buf.readDoubleBE(p);
    p += 8;
    return v;
  };
  const str = () => {
    const len = buf.readUInt16BE(p);
    p += 2;
    const v = buf.toString('utf8', p, p + len);
    p += len;
    return v;
  };

  /** 读一个「具名标签」的负载（类型已知） */
  function payload(type) {
    switch (type) {
      case TAG.BYTE:
        return u8();
      case TAG.SHORT:
        return i16();
      case TAG.INT:
        return i32();
      case TAG.LONG:
        return i64();
      case TAG.FLOAT:
        return f32();
      case TAG.DOUBLE:
        return f64();
      case TAG.BYTE_ARRAY: {
        const n = i32();
        const out = buf.subarray(p, p + n);
        p += n;
        return out;
      }
      case TAG.STRING:
        return str();
      case TAG.LIST: {
        const itemType = u8();
        const n = i32();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = payload(itemType);
        return out;
      }
      case TAG.COMPOUND: {
        const out = {};
        for (;;) {
          const t = u8();
          if (t === TAG.END) break;
          const key = str();
          out[key] = payload(t);
        }
        return out;
      }
      case TAG.INT_ARRAY: {
        const n = i32();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = i32();
        return out;
      }
      case TAG.LONG_ARRAY: {
        const n = i32();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = i64();
        return out;
      }
      default:
        // 未知类型无法安全跳过（长度未知），只能报错——静默返回 undefined 会让
        // 上层拿到残缺的树却以为解析成功，那种 bug 极难定位。
        throw new Error(`NBT 未知标签类型 ${type}（偏移 ${p - 1}）`);
    }
  }

  const rootType = u8();
  if (rootType !== TAG.COMPOUND) {
    // 区块数据一定是「根是 Compound」，其它形态说明不是我们预期的文件
    throw new Error(`NBT 根标签应为 Compound，实际为 ${rootType}`);
  }
  const name = str();
  return { name, value: payload(TAG.COMPOUND) };
}

/**
 * 读取区域文件头：每个区块的扇区偏移与扇区数。
 * @param {Buffer} buf
 * @returns {{offset: number, sectors: number}[]} 长度 1024，offset/sectors 均为 0 表示区块不存在
 */
function readRegionHeader(buf) {
  const out = new Array(REGION_CHUNKS * REGION_CHUNKS);
  for (let i = 0; i < out.length; i++) {
    const raw = buf.readUInt32BE(i * 4);
    out[i] = { offset: raw >>> 8, sectors: raw & 0xff };
  }
  return out;
}

/**
 * 取出并解压一个区块的 NBT。
 *
 * @param {Buffer} buf 区域文件内容
 * @param {number} cx 区块 X（**区域内相对坐标 0..31**，不是世界坐标）
 * @param {number} cz 区块 Z（区域内相对坐标 0..31）
 * @returns {object|null} 解析后的 NBT；区块不存在时返回 null（不是错误）
 */
function readChunk(buf, cx, cz) {
  if (cx < 0 || cx >= REGION_CHUNKS || cz < 0 || cz >= REGION_CHUNKS) return null;
  const loc = readRegionHeader(buf)[cx + cz * REGION_CHUNKS];
  if (!loc.offset || !loc.sectors) return null;

  const start = loc.offset * SECTOR_BYTES;
  if (start + 5 > buf.length) return null; // 文件被截断

  const len = buf.readUInt32BE(start);
  const type = buf.readUInt8(start + 4);
  const body = buf.subarray(start + 5, start + 5 + len);

  // 最高位 0x80：数据外置到 .mcc。这里无法拿到那个文件（调用方只给了本文件），
  // 如实抛出而不是静默返回 null —— 「以为区块是空的」和「读不了」必须能区分。
  if (type & 0x80) throw new Error(`区块 (${cx},${cz}) 数据外置于 .mcc，当前不支持`);

  const kind = type & 0x7f;
  let raw;
  if (kind === 1) raw = zlib.gunzipSync(body);
  else if (kind === 2) raw = zlib.inflateSync(body);
  else if (kind === 3) raw = body;
  else throw new Error(`区块 (${cx},${cz}) 未知压缩类型 ${kind}`);

  return parseNbt(raw).value;
}

/**
 * 位解包：从 MC 的 packed long 数组里取第 `index` 个值。
 *
 * ⚠ 值**会跨 long 边界**（bits 不整除 64 时，例如 5 bit 时每 long 12.8 个），
 * 所以不能简单地「每 long 取固定个数」。这里按连续位流处理。
 *
 * 为什么要 BigInt：long 是 64 位，MC 把它当**无符号位流**用。用 Number 在
 * 超过 2^53 后静默丢精度，表现为地图上零散的花屏点——极难定位。
 *
 * @param {bigint[]} longs
 * @param {number} bits 每个值的位宽
 * @param {number} index 值序号
 */
function readPacked(longs, bits, index) {
  const bit = index * bits;
  const li = Math.floor(bit / 64);
  const off = bit % 64;
  const lo = longs[li];
  if (lo === undefined) return 0;
  const mask = (1n << BigInt(bits)) - 1n;
  let v = lo >> BigInt(off);
  if (off + bits > 64) {
    const next = longs[li + 1] ?? 0n;
    v |= next << BigInt(64 - off);
  }
  return Number(v & mask);
}

/**
 * 调色板位宽：Atlas 规定最低 4 bit（即使调色板只有 2 项）。
 * @param {number} paletteSize
 */
function bitsFor(paletteSize) {
  let bits = 4;
  while (1 << bits < paletteSize) bits++;
  return bits;
}

/**
 * 取一个区块的「每列顶部方块 + 高度」。
 *
 * 兼容两种世界格式：
 *   · 1.18+：根下 `sections[]`，每节 `block_states.{palette,data}`，Y 为节号（可为负）
 *   · 1.17-：根下 `Level.Sections[]`，每节 `Palette` + `BlockStates`，Y 为节号
 *
 * @param {object} chunk 解析后的区块 NBT
 * @returns {{names: (string|null)[], heights: Int16Array}|null}
 *   names 长度 256（z*16+x 索引），无方块处为 null
 */
function chunkColumns(chunk) {
  if (!chunk) return null;
  const isLegacy = !chunk.sections && chunk.Level && chunk.Level.Sections;
  const sections = isLegacy ? chunk.Level.Sections : chunk.sections;
  const heightmaps = isLegacy ? chunk.Level.Heightmaps : chunk.Heightmaps;
  if (!Array.isArray(sections) || !heightmaps) return null;

  const motion = heightmaps.MOTION_BLOCKING;
  if (!Array.isArray(motion)) return null;
  // 高度图位宽由「值数固定 256 + long 数组长度」**反推**，不要写死也不要猜。
  // MC 用 ceil(log2(worldHeight+1))：主世界 384 高 → 9 bit → 36 个 long。
  // （踩过的坑：想当然写 `bitsFor(4096)` 以为得到 9，实际得到 12——
  //   bitsFor 算的是「表示 N 个不同值的位宽」，不是「位图总位数」。）
  // 反推的好处：超高/模组世界（位宽不同）也自动适配。
  const hBits = motion.length ? Math.round((motion.length * 64) / 256) : 9;

  const names = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(null);
  const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);
  // 世界最低 Y：1.18+ 从 -64 开始（节号 -4 起）；旧格式从 0 开始
  const minY = isLegacy ? 0 : -64;

  /** 节号 → {palette, longs, bits}，只对真正用到的节做一次位宽准备 */
  const bySection = new Map();

  for (let i = 0; i < 256; i++) {
    const stored = readPacked(motion, hBits, i);
    if (!stored) continue; // 该列无高度记录（未生成/全空气）
    const topY = stored + minY - 1; // 高度图存的是「顶部方块 y + 1」
    const secY = Math.floor(topY / 16);
    const inSec = topY - secY * 16;

    let sec = bySection.get(secY);
    if (sec === undefined) {
      // 找到该节号对应的 section 对象（节号在 1.18+ 可为负，所以不能按数组下标取）
      const found = sections.find((s) => Number(s.Y) === secY);
      if (!found) {
        bySection.set(secY, null);
        continue;
      }
      if (isLegacy) {
        const pal = (found.Palette || []).map((e) => e && e.Name);
        const longs = found.BlockStates || [];
        sec = { pal, longs, bits: bitsFor(pal.length || 1) };
      } else {
        const bs = found.block_states || {};
        const pal = (bs.palette || []).map((e) => e && e.Name);
        const longs = bs.data || [];
        sec = { pal, longs, bits: bitsFor(pal.length || 1) };
      }
      bySection.set(secY, sec);
    }
    if (!sec) continue;

    const x = i % 16;
    const z = Math.floor(i / 16);
    const idx = inSec * 256 + z * 16 + x; // 节内顺序：Y → Z → X
    // 调色板只有 1 项时 MC 省略 data 数组（整节同一种方块）
    const pi = sec.longs.length ? readPacked(sec.longs, sec.bits, idx) : 0;
    names[i] = sec.pal[pi] ?? null;
    heights[i] = topY;
  }

  return { names, heights };
}

/**
 * 读取整个区域，产出俯视图所需的紧凑数据。
 *
 * 返回的调色板是「方块名 → 索引」，图像数据是索引数组 —— 而不是直接出 RGBA。
 * 这样单个区域的常驻内存是 512×512×2(索引) + 512×512×2(高度) ≈ 1MB，
 * 且调色板只存一份；着色（可能按生物群系变化）留给渲染阶段。
 *
 * 索引 0 保留给「空」（无区块/全空气），所以 palette[0] 恒为 null。
 *
 * @param {Buffer} buf 区域文件内容
 * @param {{onWarn?: (msg: string) => void}} [opts]
 * @returns {{size: number, indices: Uint16Array, heights: Int16Array, palette: (string|null)[], chunkCount: number}}
 */
function readRegion(buf, opts = {}) {
  const onWarn = opts.onWarn || (() => {});
  const size = REGION_PIXELS;
  const indices = new Uint16Array(size * size); // 0 = 空
  const heights = new Int16Array(size * size);
  const palette = [null]; // 0 号位固定为「空」
  const indexOf = new Map();

  const nameIndex = (name) => {
    let i = indexOf.get(name);
    if (i === undefined) {
      i = palette.length;
      palette.push(name);
      indexOf.set(name, i);
    }
    return i;
  };

  let chunkCount = 0;
  for (let cz = 0; cz < REGION_CHUNKS; cz++) {
    for (let cx = 0; cx < REGION_CHUNKS; cx++) {
      let cols;
      try {
        const nbt = readChunk(buf, cx, cz);
        if (!nbt) continue; // 未探索/不存在：正常情况，留空
        cols = chunkColumns(nbt);
      } catch (e) {
        // 单个区块坏掉不该让整个区域失败——记一条警告继续
        onWarn(`区块 (${cx},${cz}) 解析失败：${e.message}`);
        continue;
      }
      if (!cols) continue;
      chunkCount++;

      // 区块内 (x,z) → 区域像素 (px,pz)；索引按行主序（pz 为行）
      const px0 = cx * CHUNK_SIZE;
      const pz0 = cz * CHUNK_SIZE;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const name = cols.names[z * 16 + x];
          if (!name) continue;
          const p = (pz0 + z) * size + (px0 + x);
          indices[p] = nameIndex(name);
          heights[p] = cols.heights[z * 16 + x];
        }
      }
    }
  }

  return { size, indices, heights, palette, chunkCount };
}

module.exports = {
  TAG,
  SECTOR_BYTES,
  REGION_CHUNKS,
  CHUNK_SIZE,
  REGION_PIXELS,
  parseNbt,
  readRegionHeader,
  readChunk,
  readPacked,
  bitsFor,
  chunkColumns,
  readRegion,
};
