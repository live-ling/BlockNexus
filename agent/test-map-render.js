'use strict';
// P4-1b 测试：PNG 编码器 + 方块色表 + 高度阴影
//
// ⚠ 自洽性陷阱：PNG 编码器的「往返测试」如果用同一套实现解码，两边一起错也能通过。
//   所以这里额外钉了两条**公开标准向量**：
//     · crc32('123456789') === 0xCBF43926（CRC-32 的标准测试向量）
//     · IEND chunk 的 CRC 恒为 0xAE426082（PNG 规范里的知名常量）
//   这两条与我的实现无关，能真正验证 CRC 实现是对的。
//
// 运行：node agent/test-map-render.js

const path = require('path');
const zlib = require('zlib');
const P = require(path.join(__dirname, '..', 'agent', 'src', 'png.js'));
const PAL = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'map-palette.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

// ==================== 测试用的独立 PNG 解码器 ====================
// 只支持 None / Up 两种过滤器（正是编码器会产出的），并**校验每个 chunk 的 CRC**。

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(P.SIGNATURE)) throw new Error('签名不对');
  let p = 8;
  let width = 0;
  let height = 0;
  const idats = [];
  const types = [];
  for (;;) {
    if (p + 12 > buf.length) throw new Error('文件在 chunk 头处截断');
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const crc = buf.readUInt32BE(p + 8 + len);
    const want = P.crc32(buf.subarray(p + 4, p + 8 + len));
    if (want !== crc) throw new Error(`chunk ${type} 的 CRC 不符`);
    types.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('只支持 8bit RGBA');
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const ft = raw[o];
    for (let i = 0; i < stride; i++) {
      const x = raw[o + 1 + i];
      let v;
      if (ft === P.FILTER_NONE) v = x;
      else if (ft === P.FILTER_UP) v = (x + (y > 0 ? out[(y - 1) * stride + i] : 0)) & 0xff;
      else throw new Error('测试解码器不支持过滤器 ' + ft);
      out[y * stride + i] = v;
    }
  }
  return { width, height, rgba: out, types, chunkCount: types.length };
}

// ==================== CRC32：公开标准向量 ====================
{
  check(
    "crc32('123456789') === 0xCBF43926（CRC-32 标准测试向量）",
    P.crc32(Buffer.from('123456789')) === 0xcbf43926,
    '0x' + P.crc32(Buffer.from('123456789')).toString(16),
  );
  check('crc32(空) === 0', P.crc32(Buffer.alloc(0)) === 0);
  check('crc32 返回无符号（不会出现负数）', P.crc32(Buffer.from([0xff, 0xff, 0xff, 0xff])) >= 0);
}

// ==================== IEND 的 CRC 是规范里的知名常量 ====================
{
  const png = P.encodePng(Buffer.alloc(2 * 2 * 4), 2, 2);
  const dec = decodePng(png); // 解码器内部已逐 chunk 校验 CRC
  check('chunk 顺序为 IHDR → IDAT → IEND', JSON.stringify(dec.types) === '["IHDR","IDAT","IEND"]', JSON.stringify(dec.types));
  // IEND 的 CRC：查最后 12 字节（len=0 + 'IEND' + crc）
  const iendCrc = png.readUInt32BE(png.length - 4);
  check('IEND 的 CRC === 0xAE426082（PNG 知名常量）', iendCrc === 0xae426082, '0x' + iendCrc.toString(16));
  check('IHDR 宽高正确回读', dec.width === 2 && dec.height === 2, `${dec.width}x${dec.height}`);
}

// ==================== 往返：小图精确比对 ====================
{
  // 4×3，每个像素一个可辨认的值
  const w = 4;
  const h = 3;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 17) & 0xff;
    rgba[i * 4 + 1] = (i * 31) & 0xff;
    rgba[i * 4 + 2] = (i * 7) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  const png = P.encodePng(rgba, w, h);
  const dec = decodePng(png);
  check('往返解码像素完全一致（4×3，Up 过滤）', dec.rgba.equals(rgba), '逐字节比对');
}

// ==================== 往返：较大图（真正压到 Up 过滤器）====================
{
  const w = 64;
  const h = 48;
  const rgba = Buffer.alloc(w * h * 4);
  // 上半平地 + 下半渐变：模拟「大片同色 + 局部地形」
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const flat = y < 24;
      rgba[i] = flat ? 125 : (x * 3) & 0xff;
      rgba[i + 1] = flat ? 125 : (y * 5) & 0xff;
      rgba[i + 2] = flat ? 125 : 90;
      rgba[i + 3] = 255;
    }
  }
  const dec = decodePng(P.encodePng(rgba, w, h));
  check('往返解码像素完全一致（64×48 混合图案）', dec.rgba.equals(rgba));
}

// ==================== 两种过滤器都能正确往返 ====================
for (const f of [P.FILTER_NONE, P.FILTER_UP]) {
  const w = 8;
  const h = 8;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = (i * 3) & 0xff;
  const dec = decodePng(P.encodePng(rgba, w, h, { filter: f }));
  check(`过滤器 ${f} 能正确往返`, dec.rgba.equals(rgba));
}

// ==================== Up 过滤器对「地图式图像」确实更小 ====================
// 这是设计取舍的实测依据，不是感觉
{
  const w = 256;
  const h = 256;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 相邻两行大多相同（平坦地形），偶尔一处不同
      const v = x < 128 ? 120 : 130;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  const n = P.encodePng(rgba, w, h, { filter: P.FILTER_NONE }).length;
  const u = P.encodePng(rgba, w, h, { filter: P.FILTER_UP }).length;
  check(`Up 过滤比 None 更小（${u} < ${n}）`, u < n, `none=${n} up=${u}`);
}

// ==================== 入参校验 ====================
{
  let threw = false;
  try {
    P.encodePng(Buffer.alloc(10), 2, 2); // 长度应是 16
  } catch {
    threw = true;
  }
  check('RGBA 长度不符时报错（不静默画错）', threw);

  threw = false;
  try {
    P.encodePng(new Uint8Array(16), 2, 2);
  } catch {
    threw = true;
  }
  check('非 Buffer 输入报错', threw);
}

// ==================== 色表 ====================
{
  check('已知方块：stone → 灰色', JSON.stringify(PAL.colorOf('minecraft:stone')) === '[125,125,125]', JSON.stringify(PAL.colorOf('minecraft:stone')));
  check('不带前缀也能查', JSON.stringify(PAL.colorOf('stone')) === '[125,125,125]');

  // blockstate 后缀必须剥掉，否则「带朝向的原木」会全变成品红
  check(
    'blockstate 后缀被剥掉（oak_log[axis=y] → 原木色）',
    JSON.stringify(PAL.colorOf('minecraft:oak_log[axis=y]')) === JSON.stringify(PAL.COLORS.oak_log),
    JSON.stringify(PAL.colorOf('minecraft:oak_log[axis=y]')),
  );

  // 未知方块 → 品红（刻意刺眼）
  check('未知方块返回品红', JSON.stringify(PAL.colorOf('minecraft:not_a_real_block')) === '[255,0,255]', JSON.stringify(PAL.colorOf('minecraft:not_a_real_block')));
  check('品红是常量 UNKNOWN', JSON.stringify(PAL.UNKNOWN) === '[255,0,255]');

  // 空气 → null（不画）
  for (const air of ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']) {
    check(`${air} → null（不画）`, PAL.colorOf(air) === null, String(PAL.colorOf(air)));
  }
  check('空字符串 → null', PAL.colorOf('') === null);
  check('undefined → null', PAL.colorOf(undefined) === null);

  // 大小写与前后空白容错
  check('大小写不敏感', JSON.stringify(PAL.colorOf('  Minecraft:STONE  ')) === '[125,125,125]', JSON.stringify(PAL.colorOf('  Minecraft:STONE  ')));
}

// ==================== 高度阴影 ====================
{
  // 规则：与北侧的高度差决定明暗（不是绝对高度）
  check('比北侧高 → 最亮(0)', PAL.shadeIndexFor(70, 64) === 0);
  check('与北侧同高 → 次亮(1)', PAL.shadeIndexFor(64, 64) === 1);
  check('比北侧低 1 → 较暗(2)', PAL.shadeIndexFor(63, 64) === 2);
  check('比北侧低 2 → 最暗(3)', PAL.shadeIndexFor(62, 64) === 3);
  check('比北侧低很多 → 最暗(3)', PAL.shadeIndexFor(40, 64) === 3);

  // 绝对高度不参与判定：同一高度差在不同海拔应得到同一档
  check(
    '明暗只看高度差、不看绝对高度',
    PAL.shadeIndexFor(200, 194) === PAL.shadeIndexFor(70, 64),
  );

  // 乘数
  check('SHADES 四档且递减', PAL.SHADES.length === 4 && PAL.SHADES[0] > PAL.SHADES[1] && PAL.SHADES[1] > PAL.SHADES[2] && PAL.SHADES[2] > PAL.SHADES[3], JSON.stringify(PAL.SHADES));
  check('applyShade 最亮档保持原色', JSON.stringify(PAL.applyShade([100, 100, 100], 0)) === '[100,100,100]');
  check('applyShade 最暗档变暗', JSON.stringify(PAL.applyShade([100, 100, 100], 3)) === '[40,40,40]', JSON.stringify(PAL.applyShade([100, 100, 100], 3)));

  // 边界：第一行没有北侧邻居 → 按原版做法改用 pz=1，而不是当 0 高度
  const size = 4;
  const h = new Int16Array(size * size);
  h[0 * size + 0] = 64; // 第 0 行
  h[1 * size + 0] = 64; // 第 1 行（被当作第 0 行的「北侧」）
  check('第一行的北侧取 pz=1（不是当 0 高度）', PAL.shadeIndexAt(h, size, 0, 0) === 1, String(PAL.shadeIndexAt(h, size, 0, 0)));

  // 若真把越界当 0 高度，会得到「比北侧高 → 最亮」= 0，这里必须不是 0
  check('第一行不会出现凭空的最亮档（若当 0 高度就会是 0）', PAL.shadeIndexAt(h, size, 0, 0) !== 0);
}

console.log(`\n${pass}/${total} map-render cases passed`);
process.exit(pass === total ? 0 : 1);
