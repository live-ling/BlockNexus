'use strict';
// Anvil（.mca）读取的回归测试。
//
// 为什么手工构造字节而不用真实存档：仓库里不能放几十 MB 的世界文件，而且
// 「真实存档」只能覆盖它恰好有的那几种情况（某个 MC 版本、某一种压缩类型）。
// 手工构造能精确覆盖边界：不存在的区块、gzip/zlib/未压缩、调色板 1 项/多项、
// 位宽跨 long 边界、坏区块不拖垮整个区域。
//
// ⚠ 自洽性陷阱：如果有「打包器」和「解包器」两份实现，它们互相验证**不能**证明
//   与 MC 的真实格式一致（两边一起错也能通过）。所以下面另有一组
//   **手工算好的期望值**用例（见「位解包：与手工算好的期望值比对」）。
//
// 运行：node agent/test-anvil.js

const path = require('path');
const zlib = require('zlib');
const A = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'anvil.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

// ==================== 测试用的 NBT 编码器 ====================
// 只用来造测试数据；生产侧只需要「读」，不该有写的能力（少一份能写坏用户存档的代码）。

const T = {
  byte: (v) => ({ t: A.TAG.BYTE, v }),
  int: (v) => ({ t: A.TAG.INT, v }),
  str: (v) => ({ t: A.TAG.STRING, v }),
  compound: (v) => ({ t: A.TAG.COMPOUND, v }),
  list: (itemType, items) => ({ t: A.TAG.LIST, v: { itemType, items } }),
  longArray: (v) => ({ t: A.TAG.LONG_ARRAY, v }),
};

function encPayload(node) {
  switch (node.t) {
    case A.TAG.BYTE:
      return Buffer.from([node.v & 0xff]);
    case A.TAG.INT: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(node.v);
      return b;
    }
    case A.TAG.STRING: {
      const s = Buffer.from(node.v, 'utf8');
      const l = Buffer.alloc(2);
      l.writeUInt16BE(s.length);
      return Buffer.concat([l, s]);
    }
    case A.TAG.COMPOUND: {
      const parts = [];
      for (const [k, child] of Object.entries(node.v)) parts.push(encNamed(k, child));
      parts.push(Buffer.from([A.TAG.END]));
      return Buffer.concat(parts);
    }
    case A.TAG.LIST: {
      const { itemType, items } = node.v;
      const head = Buffer.alloc(5);
      head.writeUInt8(itemType, 0);
      head.writeInt32BE(items.length, 1);
      // items 里放的是**已带类型**的节点（T.int(...) 等），不能再包一层
      return Buffer.concat([head, ...items.map((it) => encPayload(it))]);
    }
    case A.TAG.LONG_ARRAY: {
      const head = Buffer.alloc(4);
      head.writeInt32BE(node.v.length, 0);
      const parts = [head];
      for (const v of node.v) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(v)));
        parts.push(b);
      }
      return Buffer.concat(parts);
    }
    default:
      throw new Error('测试编码器不支持类型 ' + node.t);
  }
}

function encNamed(name, node) {
  const nb = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3);
  head.writeUInt8(node.t, 0);
  head.writeUInt16BE(nb.length, 1);
  return Buffer.concat([head, nb, encPayload(node)]);
}

/** 整棵 NBT：根必须是 Compound */
function encodeNbt(obj) {
  const nb = Buffer.from([A.TAG.COMPOUND, 0x00, 0x00]); // 根 Compound + 空名字
  const body = [];
  for (const [k, child] of Object.entries(obj)) body.push(encNamed(k, child));
  body.push(Buffer.from([A.TAG.END]));
  return Buffer.concat([nb, ...body]);
}

/**
 * 按 **MC 1.16+ 的填充式**打包：每个 long 放 `floor(64/bits)` 个值，
 * 装不下的整个值跳到下一个 long，**不跨边界**。
 *
 * ⚠ 这个函数必须**独立于读取实现**、只按 MC 格式规范写。
 *   我第一版两边同源地按「连续式」打包/解包 —— 测试全绿，却把位布局这个
 *   严重 bug 整个漏了过去（自洽但错）。现在互证手段有两条：
 *     · 长度：9bit/256 值 → 填充式 **37** 个 long，连续式 36 个（长度本身即判别依据）
 *     · 手算样本：见「位解包」那组用例
 */
function packBits(values, bits) {
  const per = Math.floor(64 / bits);
  const nLongs = Math.ceil(values.length / per);
  const longs = new Array(nLongs).fill(0n);
  for (let i = 0; i < values.length; i++) {
    const li = Math.floor(i / per);
    const off = (i % per) * bits;
    longs[li] |= BigInt(values[i]) << BigInt(off);
  }
  return longs;
}

/** 按 **1.15- 的连续式**打包（值可跨 long），用来验证读取器的自动判别 */
function packBitsStream(values, bits) {
  const nLongs = Math.ceil((values.length * bits) / 64);
  const longs = new Array(nLongs).fill(0n);
  for (let i = 0; i < values.length; i++) {
    const bit = i * bits;
    const li = Math.floor(bit / 64);
    const off = bit % 64;
    longs[li] |= BigInt(values[i]) << BigInt(off);
    if (off + bits > 64) longs[li + 1] |= BigInt(values[i]) >> BigInt(64 - off);
  }
  return longs;
}

// ==================== 构造 .mca ====================

/**
 * 组装一个区域文件。
 * @param {{cx:number, cz:number, nbt:Buffer, kind?:number}[]} chunks kind: 1=gzip 2=zlib 3=none
 */
function buildRegion(chunks) {
  const header = Buffer.alloc(8192); // 1024 location + 1024 timestamp
  const bodies = [];
  let sector = 2; // 0-1 是头部
  for (const c of chunks) {
    const kind = c.kind ?? 2;
    const payload = kind === 1 ? zlib.gzipSync(c.nbt) : kind === 2 ? zlib.deflateSync(c.nbt) : c.nbt;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length + 1, 0); // MC：length **含**压缩类型字节（实测 gzip 会因此炸）
    const type = Buffer.from([kind]);
    let blob = Buffer.concat([len, type, payload]);
    const sectors = Math.ceil(blob.length / 4096) || 1;
    if (blob.length < sectors * 4096) blob = Buffer.concat([blob, Buffer.alloc(sectors * 4096 - blob.length)]);
    const idx = c.cx + c.cz * 32;
    header.writeUInt32BE((sector << 8) | (sectors & 0xff), idx * 4);
    bodies.push(blob);
    sector += sectors;
  }
  return Buffer.concat([header, ...bodies]);
}

/** 造一个 1.18+ 区块：单节、单一方块、指定顶部高度 */
function makeChunk({ topY = 64, blockName = 'minecraft:stone', paletteExtra = [] } = {}) {
  const secY = Math.floor(topY / 16);
  const inSec = topY - secY * 16;
  const minY = -64;
  // 高度图：256 列都指向 topY（存的是 topY + 1 - minY）
  const stored = topY + 1 - minY;
  const heights = new Array(256).fill(stored);
  const palette = [{ Name: blockName }, ...paletteExtra.map((n) => ({ Name: n }))];

  let blockStates;
  if (palette.length === 1) {
    // 单一项：MC 省略 data
    blockStates = { palette };
  } else {
    // 每列都用调色板最后一项，逼出「位解包确实在按索引取」而不是无脑取 0
    const bits = A.bitsFor(palette.length);
    const data = new Array(4096).fill(0);
    for (let z = 0; z < 16; z++)
      for (let x = 0; x < 16; x++) data[inSec * 256 + z * 16 + x] = palette.length - 1;
    blockStates = { palette, data: packBits(data, bits) };
  }

  return encodeNbt({
    DataVersion: T.int(3465),
    xPos: T.int(0),
    zPos: T.int(0),
    Status: T.str('minecraft:full'),
    sections: T.list(
      A.TAG.COMPOUND,
      [
        T.compound({
          Y: T.byte(secY),
          block_states: T.compound({
            palette: T.list(A.TAG.COMPOUND, palette.map((p) => T.compound({ Name: T.str(p.Name) }))),
            ...(blockStates.data ? { data: T.longArray(blockStates.data) } : {}),
          }),
        }),
      ],
    ),
    Heightmaps: T.compound({ MOTION_BLOCKING: T.longArray(packBits(heights, 9)) }),
  });
}

// ==================== 位布局：两种格式与自动判别 ====================
// 这组是整个模块最要紧的验证。MC 1.16+ 起是「填充式」（值不跨 long），
// 1.15- 是「连续式」（值可跨）。我第一版把两者搞反了，而测试因为
// 「打包器与解包器同源」照样全绿 —— 所以这里刻意用**手工算好的常量**做锚点。
{
  // --- 手算锚点 1：4bit 是两种布局**唯一重合**的常见位宽，可当基准 ---
  // 0x123 = 0b100100011，从最低位起每 4 bit 一组 → [3, 2, 1, 0]
  const longs4 = [0x123n];
  const got4 = [0, 1, 2, 3].map((i) => A.readPadded(longs4, 4, i));
  check('4bit 填充式：[3,2,1,0]（手算锚点）', JSON.stringify(got4) === '[3,2,1,0]', JSON.stringify(got4));
  check(
    '4bit 时两种布局结果相同（长度也相同，所以随便读都对）',
    JSON.stringify(got4) === JSON.stringify([0, 1, 2, 3].map((i) => A.readStream(longs4, 4, i))),
  );

  // --- 手算锚点 2：5bit 时两布局**必然不同**，这是判别力的来源 ---
  // 填充式 5bit：每 long 放 floor(64/5)=12 个值。value12 在第 2 个 long 的 bit 0。
  const pad5 = [0xffffffffffffffffn, 0x1n];
  check('5bit 填充式：value12 落在下一 long 起始 → 1', A.readPadded(pad5, 5, 12) === 1, String(A.readPadded(pad5, 5, 12)));
  check('5bit 填充式：value11 是第 1 个 long 的最高一组（bit 55..59，全 1）→ 31', A.readPadded(pad5, 5, 11) === 31, String(A.readPadded(pad5, 5, 11)));
  // 连续式 5bit：value12 占 bit 60..64，跨 long → 0b11111 = 31
  check('5bit 连续式：value12 跨 long → 31', A.readStream(pad5, 5, 12) === 31, String(A.readStream(pad5, 5, 12)));
  check('两布局在 5bit 上确实不同（判别力所在）', A.readPadded(pad5, 5, 12) !== A.readStream(pad5, 5, 12));

  // --- 用**长度**自动判别（不依赖 DataVersion，新旧存档都能读）---
  check('9bit/256 值：填充式需 37 个 long', A.paddedLength(256, 9) === 37, String(A.paddedLength(256, 9)));
  check('9bit/256 值：连续式需 36 个 long', A.streamLength(256, 9) === 36, String(A.streamLength(256, 9)));
  check('layoutOf：长度 37 → padded', A.layoutOf(37, 9, 256) === 'padded');
  check('layoutOf：长度 36 → stream', A.layoutOf(36, 9, 256) === 'stream');
  check('5bit/4096 值：填充 342 / 连续 320', A.paddedLength(4096, 5) === 342 && A.streamLength(4096, 5) === 320);
  check('layoutOf：长度 342 → padded（5bit）', A.layoutOf(342, 5, 4096) === 'padded');
  check('layoutOf：长度 320 → stream（5bit）', A.layoutOf(320, 5, 4096) === 'stream');
  check('8bit 时两布局长度相同（512）', A.paddedLength(4096, 8) === A.streamLength(4096, 8));

  // --- 位宽由长度精确反推（不用 length*64/count 四舍五入，后者会进位出错）---
  check('bitsFromLength：37 → 9', A.bitsFromLength(37, 256) === 9, String(A.bitsFromLength(37, 256)));
  check('bitsFromLength：36 → 9', A.bitsFromLength(36, 256) === 9, String(A.bitsFromLength(36, 256)));
  check('bitsFromLength：342 → 5', A.bitsFromLength(342, 4096) === 5, String(A.bitsFromLength(342, 4096)));

  // --- 往返：两种布局各自独立打包 → 读取器都要能还原 ---
  const vals256 = Array.from({ length: 256 }, (_, i) => (i * 7) % 100);
  for (const [name, packer, wantLayout] of [
    ['填充式（1.16+）', packBits, 'padded'],
    ['连续式（1.15-）', packBitsStream, 'stream'],
  ]) {
    const longs = packer(vals256, 9);
    const layout = A.layoutOf(longs.length, 9, 256);
    const back = vals256.map((_, i) => A.readPacked(longs, 9, i, layout));
    check(`${name} 9bit 往返一致（长度 ${longs.length} → 判为 ${layout}）`, JSON.stringify(back) === JSON.stringify(vals256) && layout === wantLayout, `layout=${layout}`);
  }

  // --- 5bit 的往返（真实地形里调色板 17+ 项就会走这条）---
  const vals4096 = Array.from({ length: 4096 }, (_, i) => (i * 13) % 32);
  const p5 = packBits(vals4096, 5);
  const l5 = A.layoutOf(p5.length, 5, 4096);
  const b5 = vals4096.map((_, i) => A.readPacked(p5, 5, i, l5));
  check('5bit 填充式 4096 值往返一致（真实地形的常见位宽）', JSON.stringify(b5) === JSON.stringify(vals4096) && l5 === 'padded', `layout=${l5}`);

  // 位宽反推
  check('位宽最低 4（调色板 2 项）', A.bitsFor(2) === 4);
  check('位宽按调色板增长（17 项 → 5）', A.bitsFor(17) === 5);
}

// ==================== 区域文件读取 ====================
{
  const region = buildRegion([{ cx: 0, cz: 0, nbt: makeChunk({ topY: 64, blockName: 'minecraft:stone' }) }]);
  const r = A.readRegion(region);
  check('区域尺寸 512×512', r.size === 512);
  check('读到 1 个区块', r.chunkCount === 1, String(r.chunkCount));
  check('调色板含 stone', r.palette.includes('minecraft:stone'), JSON.stringify(r.palette));

  const si = r.palette.indexOf('minecraft:stone');
  check('区块 (0,0) 的像素 (0,0) 是 stone', r.indices[0] === si, `idx=${r.indices[0]} want=${si}`);
  check('区块 (0,0) 的像素 (15,15) 是 stone', r.indices[15 * 512 + 15] === si);
  check('高度图落成 64', r.heights[0] === 64, String(r.heights[0]));
  // 相邻区块没数据 → 必须是空（索引 0）
  check('未生成的区块保持为空（索引 0）', r.indices[16 * 512 + 16] === 0, String(r.indices[16 * 512 + 16]));
}

// ==================== 不存在的区块是「正常」不是「错误」 ====================
{
  // 只放 (1,2)，其余 1023 个都不存在
  const region = buildRegion([{ cx: 1, cz: 2, nbt: makeChunk() }]);
  const r = A.readRegion(region);
  check('只存在的那个区块被读到', r.chunkCount === 1, String(r.chunkCount));
  check('readChunk 对不存在的区块返回 null（不抛错）', A.readChunk(region, 0, 0) === null);
  check('readChunk 越界返回 null', A.readChunk(region, 32, 0) === null);
  // (1,2) 的像素起点 = (16, 32)
  const si = r.palette.indexOf('minecraft:stone');
  check('区块 (1,2) 落在正确的像素位置', r.indices[32 * 512 + 16] === si, String(r.indices[32 * 512 + 16]));
}

// ==================== 三种压缩类型 ====================
for (const [kind, label] of [[1, 'gzip'], [2, 'zlib'], [3, '未压缩']]) {
  const region = buildRegion([{ cx: 0, cz: 0, nbt: makeChunk(), kind }]);
  const r = A.readRegion(region);
  check(`压缩类型 ${kind}（${label}）能正确解压`, r.chunkCount === 1, `chunkCount=${r.chunkCount}`);
}

// ==================== 多调色板项：确认按索引取而不是无脑取 0 ====================
{
  const region = buildRegion([
    { cx: 0, cz: 0, nbt: makeChunk({ blockName: 'minecraft:air', paletteExtra: ['minecraft:grass_block'] }) },
  ]);
  const r = A.readRegion(region);
  const gi = r.palette.indexOf('minecraft:grass_block');
  check('多项调色板时取到了最后一项（不是索引 0）', r.indices[0] === gi, `idx=${r.indices[0]} want=${gi}`);
  check('多项调色板的索引 0 项没有被误当成结果', r.indices[0] !== r.palette.indexOf('minecraft:air'));
}

// ==================== 区块坏掉不该拖垮整个区域 ====================
{
  const good = makeChunk({ topY: 64 });
  const bad = Buffer.from('这不是 NBT 也不是压缩数据');
  const region = buildRegion([
    { cx: 0, cz: 0, nbt: bad, kind: 3 }, // 未压缩的垃圾 → parseNbt 会抛
    { cx: 1, cz: 0, nbt: good, kind: 2 },
  ]);
  const warns = [];
  const r = A.readRegion(region, { onWarn: (m) => warns.push(m) });
  check('坏区块被跳过，好区块仍在', r.chunkCount === 1, `chunkCount=${r.chunkCount}`);
  check('坏区块产生了警告（不是静默吞掉）', warns.length === 1, `warns=${warns.length}`);
}

// ==================== .mcc 外置：必须明确报错，不能静默当成空区块 ====================
{
  const nbt = makeChunk();
  const payload = zlib.deflateSync(nbt);
  const header = Buffer.alloc(8192);
  const blob = Buffer.concat([Buffer.from([0, 0, 0, payload.length + 1, 0x82]), payload]); // 0x82 = 外置 + zlib
  const padded = Buffer.concat([blob, Buffer.alloc(Math.ceil(blob.length / 4096) * 4096 - blob.length)]);
  const sectors = padded.length / 4096;
  header.writeUInt32BE((2 << 8) | sectors, 0);
  const region = Buffer.concat([header, padded]);
  let threw = false;
  try {
    A.readChunk(region, 0, 0);
  } catch (e) {
    threw = /\.mcc/.test(e.message);
  }
  check('.mcc 外置区块明确报错（不静默当成空的）', threw);
  // 而 readRegion 会把它当坏区块跳过并告警——区域整体仍可用
  const warns = [];
  const r = A.readRegion(region, { onWarn: (m) => warns.push(m) });
  check('readRegion 对外置区块记警告并继续', r.chunkCount === 0 && warns.length === 1, `warns=${warns.length}`);
}

// ==================== NBT 解析器本身 ====================
{
  const buf = encodeNbt({
    num: T.int(1234567),
    neg: T.int(-42),
    text: T.str('hello 世界'),
    nested: T.compound({ a: T.byte(7) }),
    arr: T.longArray([1n, 0xffffffffffffffffn]),
    lst: T.list(A.TAG.INT, [T.int(1), T.int(2), T.int(3)]),
    empty: T.list(A.TAG.COMPOUND, []),
  });
  const v = A.parseNbt(buf).value;
  check('NBT int', v.num === 1234567, String(v.num));
  check('NBT 负数 int', v.neg === -42, String(v.neg));
  check('NBT UTF-8 字符串', v.text === 'hello 世界', v.text);
  check('NBT 嵌套 compound', v.nested.a === 7, String(v.nested.a));
  check('NBT long 读成 unsigned BigInt', v.arr[1] === 0xffffffffffffffffn, String(v.arr[1]));
  check('NBT list', JSON.stringify(v.lst) === '[1,2,3]', JSON.stringify(v.lst));
  check('NBT 空 list', Array.isArray(v.empty) && v.empty.length === 0);

  // 根不是 Compound 时要报错（否则会把别的文件当区块读）
  let threw = false;
  try {
    A.parseNbt(Buffer.from([A.TAG.INT, 0, 0, 0, 0, 0, 1]));
  } catch {
    threw = true;
  }
  check('NBT 根非 Compound → 报错', threw);

  // 未知标签类型必须报错：静默跳过会返回残缺的树，那种 bug 极难定位
  threw = false;
  try {
    A.parseNbt(Buffer.concat([Buffer.from([A.TAG.COMPOUND, 0, 0]), Buffer.from([99, 0, 1, 0x41])]));
  } catch {
    threw = true;
  }
  check('NBT 未知标签类型 → 报错（不静默返回残缺树）', threw);
}

// ==================== 旧格式（1.17-，Level.Sections）====================
{
  const minY = 0; // 旧格式高度从 0 起
  const topY = 64;
  const secY = Math.floor(topY / 16);
  const inSec = topY - secY * 16;
  const heights = new Array(256).fill(topY + 1 - minY);
  const legacy = encodeNbt({
    DataVersion: T.int(2586),
    Level: T.compound({
      Sections: T.list(
        A.TAG.COMPOUND,
        [
          T.compound({
            Y: T.byte(secY),
            Palette: T.list(A.TAG.COMPOUND, [T.compound({ Name: T.str('minecraft:dirt') })]),
          }),
        ],
      ),
      Heightmaps: T.compound({ MOTION_BLOCKING: T.longArray(packBits(heights, 9)) }),
    }),
  });
  const region = buildRegion([{ cx: 0, cz: 0, nbt: legacy }]);
  const r = A.readRegion(region);
  check('旧格式（Level.Sections）能读到区块', r.chunkCount === 1, String(r.chunkCount));
  check('旧格式方块名正确', r.palette.includes('minecraft:dirt'), JSON.stringify(r.palette));
  check('旧格式高度用 minY=0 换算正确', r.heights[0] === 64, String(r.heights[0]));
  void inSec;
}

console.log(`\n${pass}/${total} anvil cases passed`);
process.exit(pass === total ? 0 : 1);
