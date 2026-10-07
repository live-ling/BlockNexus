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
  // ⚠ 标签**类型**是无符号的（0..12），但 TAG_BYTE 的**负载**是**有符号**的。
  //   踩过的坑：用 u8 读负载时，1.18+ 主世界的节号 -4 会被读成 252，
  //   于是 `sections.find(s => Number(s.Y) === secY)` 对负节号**永远匹配不上** →
  //   顶部方块落在 y<0 的列全部变成空白。
  const i8 = () => {
    const v = buf.readInt8(p);
    p += 1;
    return v;
  };
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
        return i8();
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
  // ⚠ `len` **包含**那个压缩类型字节（Region file format：remaining (length-1) bytes
  //   are the compressed chunk data）。所以数据是 `len - 1` 字节，即结束于 `start+4+len`。
  // 踩过的坑：原先取 `start+5+len` 会多读 1 字节 —— zlib 容忍尾随垃圾所以看不出问题，
  //   但 **gzip 不容忍**（Z_BUF_ERROR），于是所有 gzip 压缩的区块全部解析失败被跳过 →
  //   地图上整片空白，而且只报 warning，很难联想到是长度差 1。
  const body = buf.subarray(start + 5, start + 4 + len);

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
/** 填充式布局里每个 long 能放几个值（向下取整，剩的位浪费掉） */
function valuesPerLong(bits) {
  return Math.floor(64 / bits);
}
/** 填充式所需的 long 数 */
function paddedLength(count, bits) {
  return Math.ceil(count / valuesPerLong(bits));
}
/** 连续式所需的 long 数（值可跨 long） */
function streamLength(count, bits) {
  return Math.ceil((count * bits) / 64);
}

/**
 * 判定某个 packed 数组用的是哪种位布局。
 *
 * ⚠ 这是本模块最要紧的一处，也是我第一版**搞反了**的地方：
 *   · **MC 1.16+ 是「填充式」**：每个 long 固定塞 `floor(64/bits)` 个值，
 *     装不下的整个值跳到下一个 long，**不跨边界**。
 *     wiki（Chunk format，block_states.data）：「The indices are **not** packed across
 *     multiple elements of the array … it starts instead at the first (lowest) bit of
 *     the next 64-bit integer.」
 *   · **MC 1.15- 才是「连续式」**：值可跨 long 边界。
 *   我原先按连续式实现，等于在读 1.15- 的布局。在 `bits` 整除 64（4/8）时两种布局
 *   完全相同，所以小调色板的用例侥幸能过；而 `bits = 5/6/7/9`（调色板 17+ 项、
 *   以及 9 bit 的高度图）从第 `floor(64/bits)` 个值起就全错 →
 *   读到的是上一个值的高位残留 + 填充位 → **随机方块 → 满屏噪点**。
 *   高度图同时错位 → `secY` 落到错误的节 → 两个错误叠加。
 *
 * 判别依据：**数组长度**。两种布局的长度在 bits 不整除 64 时必然不同
 *   （9 bit/256 值：填充 37、连续 36；5 bit/4096 值：填充 342、连续 320），
 * 而 bits 整除 64 时长度相同、布局也相同 → 随便选哪个都对。
 * 这样不必依赖 DataVersion 就能同时兼容新旧存档。
 */
function layoutOf(len, bits, count) {
  const pad = paddedLength(count, bits);
  const strm = streamLength(count, bits);
  if (len === pad) return 'padded';
  if (len === strm) return 'stream';
  // 长度对不上任何一种（截断/异常）：按更接近的那个走
  return len >= pad ? 'padded' : 'stream';
}

/** 按「值数 + 数组长度」精确反推位宽（比 length*64/count 再四舍五入可靠） */
function bitsFromLength(len, count) {
  for (let b = 4; b <= 16; b++) {
    if (paddedLength(count, b) === len || streamLength(count, b) === len) return b;
  }
  return 9;
}

/** 填充式读取：每 long 独立，值不跨边界 */
function readPadded(longs, bits, index) {
  const per = valuesPerLong(bits);
  const li = Math.floor(index / per);
  const lo = longs[li];
  if (lo === undefined) return 0;
  const off = (index % per) * bits;
  return Number((lo >> BigInt(off)) & ((1n << BigInt(bits)) - 1n));
}

/**
 * 连续式读取（1.15-）：按连续位流处理，值**会**跨 long 边界。
 * 用 BigInt 是因为 long 是 64 位无符号位流，Number 超过 2^53 会静默丢精度。
 */
function readStream(longs, bits, index) {
  const bit = index * bits;
  const li = Math.floor(bit / 64);
  const off = bit % 64;
  const lo = longs[li];
  if (lo === undefined) return 0;
  let v = lo >> BigInt(off);
  if (off + bits > 64) v |= (longs[li + 1] ?? 0n) << BigInt(64 - off);
  return Number(v & ((1n << BigInt(bits)) - 1n));
}

/**
 * 按指定布局读取第 `index` 个值。
 * @param {'padded'|'stream'} layout
 */
function readPacked(longs, bits, index, layout = 'padded') {
  return layout === 'stream' ? readStream(longs, bits, index) : readPadded(longs, bits, index);
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
 * 取调色板里的方块名。
 *
 * ⚠ MC 的 palette 有**三种**形态，都要兼容（1.21.5+ 起可能混用）：
 *   · `[{ Name: 'minecraft:stone', Properties: {...} }, ...]` —— 最常见
 *   · `['minecraft:stone', ...]` —— 全是默认状态时是**字符串列表**
 *   · `[{ id: 'minecraft:stone' }, ...]` —— 新版用 `id` 键而不是 `Name`
 * 只认 `e.Name` 时字符串项会变成 `undefined` → `names[i] = null` →
 * 那一列被**静默丢弃**（地图上成片黑洞），且不报任何错，非常难查。
 */
function paletteNames(list) {
  if (!Array.isArray(list)) return [];
  return list.map((e) => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') return e.Name || e.id || null;
    return null;
  });
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
  // 高度图位宽与布局：都用数组长度精确反推。
  // 9 bit 时填充式是 7 值/long、需 37 个 long；连续式（1.15-）是 36 个。
  // 原先我只按 `round(len*64/256)` 算位宽并一律按连续式读 → 现代存档从第 7 列起高度全错。
  const hBits = motion.length ? bitsFromLength(motion.length, 256) : 9;
  const hLayout = motion.length ? layoutOf(motion.length, hBits, 256) : 'padded';
  const readH = (i) => readPacked(motion, hBits, i, hLayout);

  const names = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(null);
  const heights = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);

  // 节号 → section 对象（不能按数组下标取：1.18+ 的节号可为负）
  const secMap = new Map();
  for (const s of sections) secMap.set(Number(s.Y), s);

  /**
   * 世界最低 Y：**不能写死 -64**。
   *   主世界 1.18+ 是 -64..319，但**下界 0..127、末地 0..255**，旧格式一律从 0 起。
   *   写死 -64 的后果：算出的 topY 整体偏移 64 → 找到错误的节 → **整张图错位成噪点**。
   *
   * 取法（自校验，不靠猜维度）：
   *   MC 1.18+ 会把**全空气的节省掉**，所以「最小节号 × 16」通常就是 minY
   *   （各维度底部都有实心层：主世界基岩 y=-64、下界基岩 y=0、末地末地石 y=0）。
   *   但**虚空/超平坦**世界的底部节是空气、会被省掉，那时该推导就错了。
   *   因此把三个候选都拿**采样列**试一遍，选「能命中真实存在的节」最多的那个：
   *   解析结果自己会告诉我们哪个 minY 是对的。
   */
  const minSecY = Math.min(...sections.map((s) => Number(s.Y)));
  const candidates = [];
  for (const c of [Number.isFinite(minSecY) ? minSecY * 16 : null, -64, 0]) {
    if (c !== null && !candidates.includes(c)) candidates.push(c);
  }
  const SAMPLE = [0, 17, 45, 90, 128, 160, 200, 255];
  let minY;
  // 1.18+ 的区块根节点带 `yPos` = **最低节的节号**（1.18 主世界是 -4）→ minY = yPos*16。
  // 这是权威值，优先用它；比下面那套启发式可靠得多（启发式在候选相差 16 的整数倍时
  // 会因为 secY±1 也存在而**平分**，而「第一个候选永远赢平分」意味着一旦首候选是错的
  // 你只会看到颜色系统性不对，很难察觉）。
  const yPos = Number(chunk.yPos);
  if (Number.isFinite(yPos)) {
    minY = yPos * 16;
  } else {
    // 没有 yPos（1.17- 或结构异常）时才回退到「候选 + 采样打分」
    minY = candidates[0];
    let bestScore = -1;
    for (const cand of candidates) {
      let score = 0;
      for (const i of SAMPLE) {
        const stored = readH(i);
        if (!stored) continue;
        // 高度图存的是「顶部方块 y + 1」
        if (secMap.has(Math.floor((stored + cand - 1) / 16))) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        minY = cand;
      }
    }
  }

  /** 节号 → {palette, longs, bits}，只对真正用到的节做一次准备 */
  const bySection = new Map();

  for (let i = 0; i < 256; i++) {
    const stored = readH(i);
    if (!stored) continue; // 该列无高度记录（未生成/全空气）
    const topY = stored + minY - 1;
    const secY = Math.floor(topY / 16);
    const inSec = topY - secY * 16;

    let sec = bySection.get(secY);
    if (sec === undefined) {
      const found = secMap.get(secY);
      if (!found) {
        bySection.set(secY, null);
        continue;
      }
      if (isLegacy) {
        const pal = paletteNames(found.Palette);
        const longs = found.BlockStates || [];
        sec = { pal, longs, bits: bitsFor(pal.length || 1), layout: layoutOf(longs.length, bitsFor(pal.length || 1), 4096) };
      } else {
        const bs = found.block_states || {};
        const pal = paletteNames(bs.palette);
        const longs = bs.data || [];
        sec = { pal, longs, bits: bitsFor(pal.length || 1), layout: layoutOf(longs.length, bitsFor(pal.length || 1), 4096) };
      }
      bySection.set(secY, sec);
    }
    if (!sec) continue;

    const x = i % 16;
    const z = Math.floor(i / 16);
    const idx = inSec * 256 + z * 16 + x; // 节内顺序：Y → Z → X
    // 调色板只有 1 项时 MC 省略 data 数组（整节同一种方块）
    const pi = sec.longs.length ? readPacked(sec.longs, sec.bits, idx, sec.layout) : 0;
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
  readPadded,
  readStream,
  layoutOf,
  paddedLength,
  streamLength,
  valuesPerLong,
  bitsFromLength,
  paletteNames,
  bitsFor,
  chunkColumns,
  readRegion,
};
