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

/** 常见世界目录名（Paper/Vanilla 默认；自定义名由 server.properties 的 level-name 或扫描补上） */
const DEFAULT_WORLDS = ['world', 'world_nether', 'world_the_end'];

/** 缓存文件后缀 */
const SIG_SUFFIX = '.sig';

/**
 * 单个区域的签名：只要文件大小或修改时间变了，签名就变。
 *
 * 用「大小 + mtime」而不是内容哈希：读一遍几十 MB 的区域文件只为算哈希太贵，
 * 而这两个字段对「世界被改过」的判定已经足够（地图缓存是派生数据，偶发漏判
 * 只是显示旧图，重新打开即可，不是正确性问题）。
 */
function regionSig(r) {
  return `${r.size}-${Math.round(r.mtime)}`;
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

/** 非法存档名一律拒绝（防目录穿越；与其它模块同一条纪律） */
function assertSaveName(save) {
  const s = String(save || '');
  if (!s || s.includes('/') || s.includes('\\') || s === '.' || s === '..' || s.includes('..')) {
    throw new Error('存档名非法');
  }
  return s;
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
    const cand = new Set(DEFAULT_WORLDS);

    // server.properties 的 level-name（用户可能改成 my_world 之类）
    try {
      const props = fs.readFileSync(path.join(root, 'server.properties'), 'utf8');
      const m = /^\s*level-name\s*=\s*(.+?)\s*$/m.exec(props);
      if (m && m[1] && !m[1].includes('/') && !m[1].includes('\\')) cand.add(m[1]);
    } catch {}

    // 扫描实例根目录下所有「含 region/*.mca」的目录（覆盖 Paper 的多世界与自定义名）
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        cand.add(e.name);
      }
    } catch {}

    const out = [];
    for (const d of cand) {
      try {
        if (this.mapRegionFiles(root, d).length) out.push(d);
      } catch {}
    }
    return out.sort();
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

    // 原子写：并发请求下不能让别人读到半个 PNG。先写临时名再 rename。
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = pngPath + '.tmp' + process.pid;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, pngPath);
    fs.writeFileSync(sigPath, sig);

    return { png: out.toString('base64'), version: sig, cached: false, bytes: out.length, warns };
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

    for (let pz = 0; pz < size; pz++) {
      // 北侧邻居行：pz=0 时按原版做法改用 pz=1（避免第一行出现凭空的黑边）
      const northRow = (pz === 0 ? 1 : pz - 1) * size;
      const row = pz * size;
      for (let px = 0; px < size; px++) {
        const p = row + px;
        const pi = indices[p];
        if (!pi) continue; // 空区块
        const name = names[pi];
        if (!name) continue;
        const base = palette.colorOf(name);
        if (!base) continue; // 空气/透明方块

        const diff = heights[p] - heights[northRow + px];
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
    return png.encodePng(rgba, size, size);
  },
};
