'use strict';
// BlockNexus Agent — 地图服务（P4-1c）
//
// 职责：把实例里的世界目录找出来，按需把区域文件渲染成 PNG 并落盘缓存。
//
// 与 OPanel 的关键差异：**渲染在 Agent 侧做，产 PNG**，而不是把方块数据传给
// 浏览器用 wasm 渲染。理由见 docs/p4-1-map-plan.md §2：本项目没有 Rust/wasm
// 构建链，而 PNG 让前端零解码代码（createImageBitmap 直接用）。
//
// 粒度是**一个区域文件**（32×32 区块 = 512×512 像素），不是单个区块：
// 屏幕一屏只覆盖几个区域 → 每次交互只发几个请求（单区块瓦片要上千个）。

const fs = require('fs');
const path = require('path');
const anvil = require('./anvil.js');
const png = require('../png.js');
const palette = require('./map-palette.js');
const { mapCacheRoot } = require('./map-cache.js');
const { AGENT_VERSION } = require('../config.js');

/** 常见世界目录名（Paper/Vanilla 默认；自定义名由 server.properties 的 level-name 或扫描补上） */
const DEFAULT_WORLDS = ['world', 'world_nether', 'world_the_end'];

/**
 * 判断某个存档标识是否指向「非主世界维度」。
 * 覆盖两种布局：Paper 的 `world_nether` 后缀，原版的 `world/DIM-1` 嵌套。
 */
const DIM_SUFFIX = /(_nether|_the_end|\/DIM-?1)$/;

/** 缓存文件后缀 */
const SIG_SUFFIX = '.sig';

/**
 * 递归数某个目录下的 PNG 张数（只用于回报「清掉了多少」；目录不存在时返回 0）。
 * 不抛异常：缓存目录本来就可能不存在，那不是错误。
 */
function countPng(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isDirectory()) n += countPng(path.join(dir, e.name));
    else if (/\.png$/i.test(e.name)) n++;
  }
  return n;
}

/**
 * 单个区域的签名。
 *
 * ⚠ 必须把**渲染版本**算进去，不能只看文件的 size+mtime。
 *
 * 踩过的坑：签名原先只有 `${size}-${mtime}`，于是「**渲染代码改了、世界文件没变**」
 * 时缓存完全不会失效 —— 用户升级 Agent 之后，看到的仍然是**旧版本渲染出来的图**
 * （例如修位布局之前那批满是噪点的 PNG），而且没有任何入口能让他重新生成。
 * 现在带上 AGENT_VERSION：任何 Agent 升级都会让全部缓存一次性失效并重渲染。
 *
 * 代价：每次升级 Agent 后首屏要把用到的区域重渲染一遍（之后照旧走缓存）。
 * 这个代价我们接受 —— 「绝不拿旧渲染糊弄用户」比省那几百毫秒重要得多。
 *
 * 用 AGENT_VERSION 而不是自建一个 MAP_RENDER_VERSION：后者要靠人记得在每次
 * 改动渲染逻辑时递增，**一旦忘记就退回上面那个坑**；而 AGENT_VERSION 是
 * 发布流程强制递增的，不会漏。代价是「与渲染无关的 Agent 改动也会清缓存」，
 * 属于安全方向的过度保守。
 */
function regionSig(r) {
  return `${AGENT_VERSION}-${r.size}-${Math.round(r.mtime)}`;
}

/** 整个存档的版本号：所有区域签名串起来做 FNV-1a（快，且文件一变就变） */
function saveVersion(regions) {
  let h = 0x811c9dc5;
  for (const r of regions) {
    const s = `${r.rx},${r.rz},${regionSig(r)};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36) + '-' + regions.length;
}

/**
 * 校验存档标识，防目录穿越。
 *
 * 允许**一级或两级**路径：原版的多维度是嵌套的（`world/DIM-1`），
 * 必须能表达它，否则原版服务端的下界/末地就无法访问。
 * 但每一段都必须是安全的单段名（字母数字与 `_ . -`），且显式拒绝 `.` / `..`，
 * 所以 `../../etc` 这类穿越仍然被挡住 —— 放宽的是**层数**，不是**字符集**。
 */
function assertSaveName(save) {
  const s = String(save || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || s.endsWith('/') || s.includes('//')) {
    throw new Error('存档名非法');
  }
  const segs = s.split('/');
  if (segs.length > 2) throw new Error('存档名层级过深');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..' || !/^[\w.-]+$/.test(seg)) {
      throw new Error('存档名非法');
    }
  }
  return segs.join('/');
}

module.exports = {
  /**
   * 列出实例下的所有世界（存档）及其可用区域。
   *
   * @param {string} name 实例名
   * @returns {{saves: {save: string, regions: [number,number][], version: string}[]}}
   */
  mapSaves(name) {
    const root = this.instDir(name);
    const saves = [];
    for (const save of this.mapWorldDirs(name)) {
      let regions;
      try {
        regions = this.mapRegionFiles(root, save);
      } catch {
        continue;
      }
      if (!regions.length) continue;
      saves.push({
        save,
        regions: regions.map((r) => [r.rx, r.rz]),
        version: saveVersion(regions),
        // 该存档渲染时遇到过的「色表里没有的方块」——界面据此提示用户补色，
        // 而不是让用户对着紫色截图猜（附上限避免响应无限膨胀）
        unknown: [...((this._mapUnknown && this._mapUnknown.get(save)) || [])].sort().slice(0, 40),
      });
    }
    return { saves };
  },

  /**
   * 找出实例下的世界目录。
   * 三个来源合一：server.properties 的 level-name、常见默认名、以及「真的含 region/*.mca」的目录。
   */
  mapWorldDirs(name) {
    const root = this.instDir(name);
    const tops = new Set(DEFAULT_WORLDS);

    // server.properties 的 level-name（用户可能改成 my_world 之类）
    try {
      const props = fs.readFileSync(path.join(root, 'server.properties'), 'utf8');
      const m = /^\s*level-name\s*=\s*(.+?)\s*$/m.exec(props);
      if (m && m[1] && !m[1].includes('/') && !m[1].includes('\\')) tops.add(m[1]);
    } catch {}

    // 扫描实例根目录下的所有目录（覆盖 Paper 的多世界与自定义名）
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) tops.add(e.name);
      }
    } catch {}

    // ⚠ 两种服务端的多维度布局都要认：
    //   · **原版（vanilla）**：维度嵌在主世界目录**里面** ——
    //       world/DIM-1/region（下界）、world/DIM1/region（末地）
    //   · **Paper / Bukkit**：各自独立目录 ——
    //       world_nether/region、world_the_end/region
    //   原先只扫顶层目录，于是**原版服务端永远只有主世界可选** ——
    //   用户看到的就是「没有维度切换」。
    //   （参考实现 OPanel 干脆不做其它维度，所以没有可借鉴的枚举逻辑。）
    const cand = new Set();
    for (const t of tops) {
      cand.add(t);
      cand.add(`${t}/DIM-1`);
      cand.add(`${t}/DIM1`);
    }

    const out = [];
    for (const d of cand) {
      try {
        if (this.mapRegionFiles(root, d).length) out.push(d);
      } catch {}
    }
    // 主世界排前面（默认选中它），其余按名字稳定排序
    return out.sort((a, b) => {
      const rank = (s) => (DIM_SUFFIX.test(s) ? 1 : 0);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  },

  /**
   * 列出某世界的区域文件及其签名信息。
   * @returns {{rx:number, rz:number, file:string, size:number, mtime:number}[]}
   */
  mapRegionFiles(root, save) {
    const s = assertSaveName(save);
    const dir = path.join(root, s, 'region');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(f);
      if (!m) continue;
      let st;
      try {
        st = fs.statSync(path.join(dir, f));
      } catch {
        continue;
      }
      out.push({ rx: Number(m[1]), rz: Number(m[2]), file: f, size: st.size, mtime: st.mtimeMs });
    }
    // 稳定排序：版本号必须与顺序无关，否则同一份数据会算出不同版本
    return out.sort((a, b) => a.rx - b.rx || a.rz - b.rz);
  },

  /**
   * 取单个区域的 PNG（走落盘缓存）。
   *
   * @param {string} name 实例名
   * @param {string} save 世界目录名
   * @param {number} rx 区域 X
   * @param {number} rz 区域 Z
   * @param {{force?: boolean}} [opts] force 时忽略缓存重渲染
   * @returns {{png: string, version: string, cached: boolean, bytes: number, warns: string[]}}
   */
  mapRegion(name, save, rx, rz, opts = {}) {
    // 「缺色方块」按存档累积（懒初始化；成员变量放在实例上，避免多实例互相污染）
    if (!this._mapUnknown) this._mapUnknown = new Map();
    const s = assertSaveName(save);
    const root = this.instDir(name);
    const X = Math.trunc(Number(rx));
    const Z = Math.trunc(Number(rz));
    if (!Number.isFinite(X) || !Number.isFinite(Z)) throw new Error('区域坐标非法');

    const regions = this.mapRegionFiles(root, s);
    const info = regions.find((r) => r.rx === X && r.rz === Z);
    if (!info) throw new Error(`区域 (${X},${Z}) 不存在`);

    const cacheDir = path.join(mapCacheRoot(root), s);
    const pngPath = path.join(cacheDir, `${X}.${Z}.png`);
    const sigPath = pngPath + SIG_SUFFIX;
    const sig = regionSig(info);

    // 缓存命中：PNG 在、且签名一致
    if (!opts.force) {
      try {
        if (fs.readFileSync(sigPath, 'utf8') === sig) {
          const buf = fs.readFileSync(pngPath);
          return { png: buf.toString('base64'), version: sig, cached: true, bytes: buf.length, warns: [] };
        }
      } catch {
        // 缓存缺失/损坏 → 往下走重新渲染
      }
    }

    const warns = [];
    const regionBuf = fs.readFileSync(path.join(root, s, 'region', info.file));
    const img = anvil.readRegion(regionBuf, { onWarn: (m) => warns.push(m) });
    const out = this.mapRenderPng(img);

    // 累积「色表里没有的方块」到本存档，供 mapSaves 上报给界面。
    // 只增不减：一旦发现某个方块缺色，用户界面就应当一直提示它，直到我们补上。
    if (out.unknown.length) {
      const cur = this._mapUnknown.get(s) || new Set();
      for (const n of out.unknown) cur.add(n);
      this._mapUnknown.set(s, cur);
    }

    // 原子写：并发请求下不能让别人读到半个 PNG。先写临时名再 rename。
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = pngPath + '.tmp' + process.pid;
    fs.writeFileSync(tmp, out.buf);
    fs.renameSync(tmp, pngPath);
    fs.writeFileSync(sigPath, sig);

    return { png: out.buf.toString('base64'), version: sig, cached: false, bytes: out.buf.length, warns };
  },

  /**
   * 清空地图缓存，强制下次重新渲染。
   *
   * 为什么需要显式入口：把渲染版本纳入签名后，**升级 Agent 会自动失效**；
   * 但用户可能因为别的原因想强制重来（怀疑图不对、手动改过世界而 mtime 没变等），
   * 原先没有任何入口 —— 只能删实例目录下的 `.blocknexus-map/`，对普通用户不现实。
   *
   * @param {string} name 实例名
   * @param {string} [save] 只清某个世界（含 `world/DIM-1` 这类嵌套名）；省略则清整个实例
   * @returns {{ok: boolean, removed: number}} removed = 删掉的 PNG 张数
   */
  mapClearCache(name, save) {
    const base = mapCacheRoot(this.instDir(name));
    const dir = save ? path.join(base, assertSaveName(save)) : base;
    const removed = countPng(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, removed };
  },

  /**
   * 把 anvil.readRegion 的结果渲染成 PNG。
   *
   * 逐像素内联做明暗计算（而不是调 palette.applyShade）：512×512 = 26 万次，
   * 每像素多分配一个数组会让 GC 压力明显上升，而 Agent 有内存预算。
   *
   * @param {{size:number, indices:Uint16Array, heights:Int16Array, palette:(string|null)[]}} img
   * @returns {Buffer} PNG
   */
  mapRenderPng(img) {
    const { size, indices, heights, palette: names } = img;
    const rgba = Buffer.alloc(size * size * 4); // 默认全透明（空区块 = 露出底色）
    const SHADES = palette.SHADES;

    // 调色板索引 → 已着色 RGB 的缓存：同一区域往往只有十几种方块，
    // 明暗只有 4 档，所以「方块 × 明暗」的组合数很少，缓存后省掉大量查表与乘法。
    const shaded = new Array(names.length * 4);
    /** 本区域出现过的、色表里没有的方块名（渲染成品红）—— 供诊断上报 */
    const unknown = new Set();

    for (let pz = 0; pz < size; pz++) {
      // 明暗取样行：**pz=0 时把取样行抬到 1**，即第一行直接复用第二行的档位。
      //
      // ⚠ 这里与 OPanel 对齐（.opanel-reference/frontend/wasm-lib/map-renderer
      //   /render.rs:56-59 的 `if z == 0 { z += 1 }`）。
      //   我第一版把它理解成「把北邻换成 pz=1」，于是算的是 h(0)-h(1) —— 方向相反。
      //   平地看不出来，但有坡度时每张区域图**顶部一行会与参考实现相反（通常更暗）**，
      //   形成每 512 像素一条水平色线。
      const useRow = pz === 0 ? 1 : pz;
      const northRow = (useRow - 1) * size;
      const sampleRow = useRow * size;
      const row = pz * size;
      for (let px = 0; px < size; px++) {
        const p = row + px;
        const pi = indices[p];
        if (!pi) continue; // 空区块
        const name = names[pi];
        if (!name) continue;
        const base = palette.colorOf(name);
        if (!base) continue; // 空气/透明方块

        // 诊断：记下**未识别**的方块名（渲染成品红）。
        // 为什么必须有：用户看到紫色色块时**没法知道缺的是哪个方块**，
        // 只能截图给我们猜 —— 那样永远补不全。让它自己报出来才是系统性解法。
        // 用引用相等判断：colorOf 对已知方块返回新数组，对未知方块返回 UNKNOWN 这个常量。
        if (base === palette.UNKNOWN) unknown.add(name);

        const diff = heights[sampleRow + px] - heights[northRow + px];
        const shade = diff > 0 ? 0 : diff === 0 ? 1 : diff > -2 ? 2 : 3;
        const key = pi * 4 + shade;
        let rgb = shaded[key];
        if (rgb === undefined) {
          const k = SHADES[shade];
          rgb = [(base[0] * k) | 0, (base[1] * k) | 0, (base[2] * k) | 0];
          shaded[key] = rgb;
        }
        const o = p * 4;
        rgba[o] = rgb[0];
        rgba[o + 1] = rgb[1];
        rgba[o + 2] = rgb[2];
        rgba[o + 3] = 255;
      }
    }
    return { buf: png.encodePng(rgba, size, size), unknown: [...unknown] };
  },
};
