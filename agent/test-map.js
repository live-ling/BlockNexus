'use strict';
// P4-1c 测试：地图服务（存档枚举 / 区域渲染 / 落盘缓存）+ 缓存目录的隔离
//
// 用临时目录造假实例，不依赖真实存档。
//
// 运行：node agent/test-map.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const A = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'anvil.js'));
const MAP = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'map.js'));
const PAL = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'map-palette.js'));
const { MAP_CACHE_DIR } = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'map-cache.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

// ==================== 最小 .mca 构造（与 test-anvil 同源，这里只需「一个合法小区域」）====================
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
      for (const [k, c] of Object.entries(node.v)) parts.push(encNamed(k, c));
      parts.push(Buffer.from([A.TAG.END]));
      return Buffer.concat(parts);
    }
    case A.TAG.LIST: {
      const head = Buffer.alloc(5);
      head.writeUInt8(node.v.itemType, 0);
      head.writeInt32BE(node.v.items.length, 1);
      return Buffer.concat([head, ...node.v.items.map(encPayload)]);
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
      throw new Error('编码器不支持 ' + node.t);
  }
}
function encNamed(name, node) {
  const nb = Buffer.from(name, 'utf8');
  const head = Buffer.alloc(3);
  head.writeUInt8(node.t, 0);
  head.writeUInt16BE(nb.length, 1);
  return Buffer.concat([head, nb, encPayload(node)]);
}
function encodeNbt(obj) {
  const body = [];
  for (const [k, c] of Object.entries(obj)) body.push(encNamed(k, c));
  body.push(Buffer.from([A.TAG.END]));
  return Buffer.concat([Buffer.from([A.TAG.COMPOUND, 0, 0]), ...body]);
}
function packBits(values, bits) {
  const longs = new Array(Math.ceil((values.length * bits) / 64)).fill(0n);
  for (let i = 0; i < values.length; i++) {
    const bit = i * bits;
    const li = Math.floor(bit / 64);
    const off = bit % 64;
    longs[li] |= BigInt(values[i]) << BigInt(off);
    if (off + bits > 64) longs[li + 1] |= BigInt(values[i]) >> BigInt(64 - off);
  }
  return longs;
}

/** 造一个区块：整块同一种方块、统一高度 */
function makeChunk(blockName, topY) {
  const secY = Math.floor(topY / 16);
  const stored = topY + 1 - -64;
  const heights = new Array(256).fill(stored);
  return encodeNbt({
    DataVersion: T.int(3465),
    sections: T.list(A.TAG.COMPOUND, [
      T.compound({
        Y: T.byte(secY),
        block_states: T.compound({
          palette: T.list(A.TAG.COMPOUND, [T.compound({ Name: T.str(blockName) })]),
        }),
      }),
    ]),
    Heightmaps: T.compound({ MOTION_BLOCKING: T.longArray(packBits(heights, 9)) }),
  });
}

/** 造区域文件：把区块放到指定相对位置 */
function buildRegion(chunks) {
  const header = Buffer.alloc(8192);
  const bodies = [];
  let sector = 2;
  for (const c of chunks) {
    const payload = zlib.deflateSync(c.nbt);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length + 1, 0); // MC：length **含**压缩类型字节（实测 gzip 会因此炸）
    let blob = Buffer.concat([len, Buffer.from([2]), payload]);
    const sectors = Math.ceil(blob.length / 4096) || 1;
    if (blob.length < sectors * 4096) blob = Buffer.concat([blob, Buffer.alloc(sectors * 4096 - blob.length)]);
    header.writeUInt32BE((sector << 8) | sectors, (c.cx + c.cz * 32) * 4);
    bodies.push(blob);
    sector += sectors;
  }
  return Buffer.concat([header, ...bodies]);
}

// ==================== 临时实例环境 ====================
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-map-test-'));
function makeInstance(instName, worlds) {
  const instDir = path.join(tmpRoot, instName);
  fs.mkdirSync(instDir, { recursive: true });
  // InstanceManager.scan() 只登记含 blocknexus.json 的目录——没有它 manager.get() 会说「实例不存在」
  fs.writeFileSync(
    path.join(instDir, 'blocknexus.json'),
    JSON.stringify({ name: instName, launch: { kind: 'jar', file: 'server.jar' } }),
  );
  for (const [w, spec] of Object.entries(worlds)) {
    const rdir = path.join(instDir, w, 'region');
    fs.mkdirSync(rdir, { recursive: true });
    for (const r of spec.regions) {
      fs.writeFileSync(path.join(rdir, `r.${r.x}.${r.z}.mca`), buildRegion(r.chunks));
    }
  }
  return instDir;
}

// map.js 导出的是普通方法对象；补一个 instDir 就是可用的「管理器」
function mgrFor() {
  return Object.assign({ instDir: (n) => path.join(tmpRoot, n) }, MAP);
}

// ==================== 存档枚举 ====================
{
  makeInstance('i1', {
    world: { regions: [{ x: 0, z: 0, chunks: [{ cx: 0, cz: 0, nbt: makeChunk('minecraft:stone', 64) }] }] },
    world_nether: { regions: [{ x: -1, z: 2, chunks: [{ cx: 0, cz: 0, nbt: makeChunk('minecraft:netherrack', 40) }] }] },
  });
  fs.writeFileSync(path.join(tmpRoot, 'i1', 'server.properties'), 'level-name=world\nmotd=hi\n');
  const m = mgrFor();
  const r = m.mapSaves('i1');
  const names = r.saves.map((s) => s.save).sort();
  check('枚举到两个世界', JSON.stringify(names) === '["world","world_nether"]', JSON.stringify(names));
  const w = r.saves.find((s) => s.save === 'world');
  check('区域坐标格式为 [x,z] 数组', JSON.stringify(w.regions) === '[[0,0]]', JSON.stringify(w.regions));
  check('带版本号', typeof w.version === 'string' && w.version.length > 0, w.version);
  const n = r.saves.find((s) => s.save === 'world_nether');
  check('负坐标区域被正确解析', JSON.stringify(n.regions) === '[[-1,2]]', JSON.stringify(n.regions));
}

// ==================== level-name 自定义世界 ====================
{
  makeInstance('i2', { my_world: { regions: [{ x: 0, z: 0, chunks: [{ cx: 0, cz: 0, nbt: makeChunk('minecraft:sand', 63) }] }] } });
  fs.writeFileSync(path.join(tmpRoot, 'i2', 'server.properties'), 'level-name=my_world\n');
  const m = mgrFor();
  const r = m.mapSaves('i2');
  check('自定义 level-name 的世界被枚举到', r.saves.some((s) => s.save === 'my_world'), JSON.stringify(r.saves.map((s) => s.save)));
}

// ==================== 区域渲染 + 落盘缓存 ====================
{
  makeInstance('i3', {
    world: {
      regions: [
        { x: 0, z: 0, chunks: [{ cx: 0, cz: 0, nbt: makeChunk('minecraft:stone', 64) }, { cx: 1, cz: 0, nbt: makeChunk('minecraft:grass_block', 64) }] },
      ],
    },
  });
  const m = mgrFor();

  const first = m.mapRegion('i3', 'world', 0, 0);
  check('首次渲染 cached=false', first.cached === false);
  check('返回 base64 PNG（PNG 魔数）', Buffer.from(first.png, 'base64').subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '魔数不符');
  check('PNG 有合理体积', first.bytes > 200, `bytes=${first.bytes}`);
  check('两个区块都被渲染（无警告）', first.warns.length === 0, JSON.stringify(first.warns));

  const second = m.mapRegion('i3', 'world', 0, 0);
  check('第二次命中缓存 cached=true', second.cached === true);
  check('缓存命中内容与首次一致', second.png === first.png);

  // 缓存文件确实落盘了
  const cacheDir = path.join(tmpRoot, 'i3', MAP_CACHE_DIR, 'world');
  check('缓存目录已创建', fs.existsSync(cacheDir));
  check('缓存里有 PNG', fs.existsSync(path.join(cacheDir, '0.0.png')));
  check('缓存里有签名文件', fs.existsSync(path.join(cacheDir, '0.0.png.sig')));

  // 改动区域文件 → 签名变化 → 缓存失效
  const rfile = path.join(tmpRoot, 'i3', 'world', 'region', 'r.0.0.mca');
  fs.writeFileSync(rfile, buildRegion([{ cx: 0, cz: 0, nbt: makeChunk('minecraft:sand', 70) }]));
  // 保证 mtime 确实变化（同秒内写入可能 mtime 相同）
  const past = Date.now() / 1000 + 5;
  fs.utimesSync(rfile, past, past);
  const third = m.mapRegion('i3', 'world', 0, 0);
  check('区域文件变化后缓存失效并重渲染', third.cached === false, `cached=${third.cached}`);
  check('重渲染内容与之前不同', third.png !== first.png);

  // force 也要重渲染
  check('force=true 时忽略缓存', m.mapRegion('i3', 'world', 0, 0, { force: true }).cached === false);

  // 不存在的区域要报错（而不是回一张空图）
  let threw = false;
  try {
    m.mapRegion('i3', 'world', 9, 9);
  } catch {
    threw = true;
  }
  check('不存在的区域报错', threw);
}

// ==================== 存档名注入防护 ====================
{
  const m = mgrFor();
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', '', null, 'x..y']) {
    let threw = false;
    try {
      m.mapRegion('i3', bad, 0, 0);
    } catch {
      threw = true;
    }
    check(`非法存档名被拒：${JSON.stringify(bad)}`, threw);
  }
}

// ==================== 渲染：透明 / 品红 / 明暗 ====================
{
  const m = mgrFor();
  const size = 4;
  // 手工造一个 img：一行 stone（有高度差）、一格未知方块、其余空
  const indices = new Uint16Array(size * size);
  const heights = new Int16Array(size * size);
  const palette = [null, 'minecraft:stone', 'minecraft:definitely_not_real'];
  // 第 0 行：stone；高度 65（北侧 pz=1 是 64 → 高 1 → 最亮）
  for (let x = 0; x < size; x++) {
    indices[0 * size + x] = 1;
    heights[0 * size + x] = 65;
    indices[1 * size + x] = 1;
    heights[1 * size + x] = 64;
  }
  // 第 2 行放一个未知方块
  indices[2 * size + 0] = 2;
  heights[2 * size + 0] = 64;

  const out = m.mapRenderPng({ size, indices, heights, palette });
  // 用 anvil 的解析器反向确认尺寸（PNG 头）
  const w = out.readUInt32BE(16);
  const h = out.readUInt32BE(20);
  check('渲染尺寸正确（4×4）', w === 4 && h === 4, `${w}x${h}`);

  // 逐像素解回来（复用 test-map-render 的思路：inflate + unfilter）
  const idatLen = out.readUInt32BE(out.length - 12 - 4);
  void idatLen;
  function decode(pngBuf) {
    let p = 8;
    const idats = [];
    let width = 0;
    let height = 0;
    for (;;) {
      const len = pngBuf.readUInt32BE(p);
      const type = pngBuf.toString('ascii', p + 4, p + 8);
      const data = pngBuf.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
      } else if (type === 'IDAT') idats.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idats));
    const stride = width * 4;
    const px = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
      const o = y * (stride + 1);
      const ft = raw[o];
      for (let i = 0; i < stride; i++) {
        const v = raw[o + 1 + i];
        px[y * stride + i] = ft === 2 ? (v + (y > 0 ? px[(y - 1) * stride + i] : 0)) & 0xff : v;
      }
    }
    return { width, height, px };
  }
  const dec = decode(out);
  const at = (x, y) => {
    const o = (y * dec.width + x) * 4;
    return [dec.px[o], dec.px[o + 1], dec.px[o + 2], dec.px[o + 3]];
  };

  // 空区块 → 全透明（不是黑）
  check('空区块是透明的（不是黑块）', at(3, 3)[3] === 0, JSON.stringify(at(3, 3)));
  // 未知方块 → 品红。注意它同样会**被明暗档乘**：
  // 该像素在 row 2，北侧 row 1 同高 → 次亮档 0.8 → 255×0.8 = 204。
  check(
    '未知方块渲染成品红（且被明暗档相乘：255×0.8=204）',
    at(0, 2)[0] === 204 && at(0, 2)[1] === 0 && at(0, 2)[2] === 204,
    JSON.stringify(at(0, 2)),
  );
  // 明暗取样：pz=0 时按 OPanel 的做法把**取样行**抬到 1 → 第一行与第二行档位相同。
  // 本组 h(0)=65、h(1)=64、h(2)=64：
  //   · pz=0：useRow=1 → cur=h(1)=64, north=h(0)=65 → diff -1 → 较暗档 0.5 → 62
  //   · pz=1：useRow=1，同上 → 62（与第一行**相同**，这正是 OPanel 的契约）
  //   · pz=2：useRow=2 → cur=h(2)=64, north=h(1)=64 → diff 0 → 次亮档 0.8 → 100
  check('第一行取第二行的档位（OPanel 契约）', at(1, 0)[0] === 62, JSON.stringify(at(1, 0)));
  check('第一行与第二行档位相同（抬 z 的直接后果）', at(1, 0)[0] === at(1, 1)[0], `${at(1, 0)[0]} vs ${at(1, 1)[0]}`);
  // 第三行（x=0 是那个未知方块）走**正常**的北邻：h(2)=h(1)=64 → diff 0 → 次亮档 0.8
  // → 255×0.8 = 204。用以证明「抬行」只对 pz=0 生效，不是所有行都抬。
  check('第三行走正常北邻（同高 → 次亮档，255×0.8=204）', at(0, 2)[0] === Math.round(255 * 0.8), JSON.stringify(at(0, 2)));
  check('第三行档位与第一行不同（证明只有 pz=0 抬行）', at(0, 2)[0] !== at(1, 0)[0], `${at(0, 2)[0]} vs ${at(1, 0)[0]}`);
  // 反向断言：若写成「把北邻换成 pz=1」（我第一版的错法），h(0)=65 高于 h(1)=64 → 会得最亮档 125
  check('第一行不是「比北邻高」的 125（排除方向写反）', at(1, 0)[0] !== PAL.COLORS.stone[0], String(at(1, 0)[0]));
}

// ==================== 缓存目录的隔离 ====================
{
  // 文件管理器不该列出缓存目录（用真实 InstanceManager 验证，不是查源码字符串）
  const { InstanceManager } = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'manager.js'));
  makeInstance('i4', { world: { regions: [{ x: 0, z: 0, chunks: [{ cx: 0, cz: 0, nbt: makeChunk('minecraft:stone', 64) }] }] } });
  fs.mkdirSync(path.join(tmpRoot, 'i4', MAP_CACHE_DIR, 'world'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'i4', MAP_CACHE_DIR, 'world', '0.0.png'), 'x');

  const im = new InstanceManager(tmpRoot);
  const root = im.listFiles('i4', '');
  const names = root.map((e) => e.name);
  check('文件管理器不列出地图缓存目录', !names.includes(MAP_CACHE_DIR), JSON.stringify(names));
  check('但列出世界目录', names.includes('world'), JSON.stringify(names));

  // 子目录里同名目录**不该**被隐藏（只隐藏实例根下的那个）
  fs.mkdirSync(path.join(tmpRoot, 'i4', 'world', MAP_CACHE_DIR), { recursive: true });
  const sub = im.listFiles('i4', 'world').map((e) => e.name);
  check('子目录里的同名目录仍然可见（只隐藏根部那个）', sub.includes(MAP_CACHE_DIR), JSON.stringify(sub));

  // 备份命令必须排除缓存目录（这里是静态检查：真跑 tar 依赖平台，且 tar 的 --exclude 是标准语义）
  const backupSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'src', 'instance', 'backups.js'), 'utf8');
  check('备份 tar 命令带 --exclude 地图缓存目录', /--exclude=\.\/\$\{MAP_CACHE_DIR\}|--exclude=\.\/\.blocknexus-map/.test(backupSrc));
}

// 清理
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {}

console.log(`\n${pass}/${total} map cases passed`);
process.exit(pass === total ? 0 : 1);
