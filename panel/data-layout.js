'use strict';
// data/ 的目录分层：配置/凭据留在顶层；可再生缓存与运行日志分别放 cache/、logs/。
// 升级已有安装时按文件/目录迁移，绝不覆盖新位置已有内容；失败保留旧文件，后续回退读取。

const fs = require('fs');
const path = require('path');

const LOG_FILES = ['panel.log', 'agent.log', 'launcher.log', 'tray-trace.log', 'tray-crash.log'];
const CACHE_FILES = ['mc-versions-cache.json', 'mc-cores-cache.json'];

function moveIfNeeded(source, target) {
  if (source === target || !fs.existsSync(source) || fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
  } catch {
    // Windows 上文件可能被旧进程占用：复制保留内容，不冒险删除源文件。
    try {
      fs.copyFileSync(source, target);
    } catch {}
  }
}

/** 幂等：每次启动调用都可以；只迁移本程序拥有的日志/缓存，不碰用户配置。 */
function ensureDataLayout(dataDir) {
  const logsDir = path.join(dataDir, 'logs');
  const cacheDir = path.join(dataDir, 'cache');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const name of LOG_FILES) moveIfNeeded(path.join(dataDir, name), path.join(logsDir, name));
  for (const name of CACHE_FILES) moveIfNeeded(path.join(dataDir, name), path.join(cacheDir, name));
  moveIfNeeded(path.join(dataDir, 'webview2-profile'), path.join(cacheDir, 'webview2-profile'));
  return { logsDir, cacheDir };
}

/** 新缓存优先；升级过程中若复制成功但源文件被占用，旧路径仍可读。 */
function cacheFile(dataDir, name) {
  const { cacheDir } = ensureDataLayout(dataDir);
  const current = path.join(cacheDir, name);
  return fs.existsSync(current) ? current : path.join(dataDir, name);
}

module.exports = { ensureDataLayout, cacheFile, LOG_FILES, CACHE_FILES };
