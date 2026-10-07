'use strict';
// 地图缓存目录的位置 —— fs.js / backups.js / map.js 三处共用，单独放一个文件避免硬编码重复。
//
// 为什么要有这个目录、以及为什么它必须被排除：
//   地图是「从 world/*.mca 重新渲染即可」的**派生数据**。把它放进实例目录是为了
//   跟着实例走（删除实例时一起清掉），但它绝不能进备份——那只会让每份快照白白变大，
//   恢复时还会把过期缓存盖回实例目录。同理也不该出现在文件管理器里（用户看到会困惑）。

const path = require('path');

/** 缓存目录名（位于实例目录根部，点号开头表明是工具内部数据） */
const MAP_CACHE_DIR = '.blocknexus-map';

/**
 * 实例目录 → 地图缓存根目录。
 * @param {string} instDir 实例目录（绝对路径）
 */
function mapCacheRoot(instDir) {
  return path.join(instDir, MAP_CACHE_DIR);
}

module.exports = { MAP_CACHE_DIR, mapCacheRoot };
