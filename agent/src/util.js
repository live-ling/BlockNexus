'use strict';
// BlockNexus Agent — 通用工具（哈希校验、子进程、版本号、名称校验）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** 从 maven-metadata.xml 里抽出所有 <version> */
function mavenVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

/** sha256 校验（MSL 等源会返回 hash，下载后核对防止 CDN 缓存损坏） */
// 子进程命令（压缩/解压用系统 tar/zip）：stderr 留尾作错误信息；超时强杀
function runCmd(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('操作超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e.code === 'ENOENT' ? '系统缺少命令 ' + cmd + '：' : '') + (e.message || '启动失败')));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = String(err).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error(tail || `${cmd} 退出码 ${code}`));
    });
  });
}

// tar 可执行文件解析：Windows 锁定系统自带 bsdtar（支持 zip/tar.gz、无 GNU tar 的
// “C: 被当作远程主机”问题），避免 Git Bash/MSYS 等环境里 PATH 上的 GNU tar 抢占；
// Linux 直接用 PATH 里的 tar
let tarCmdCache = null;

function tarCmd() {
  if (tarCmdCache === null) {
    if (process.platform === 'win32') {
      const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      tarCmdCache = fs.existsSync(sys) ? sys : 'tar';
    } else {
      tarCmdCache = 'tar';
    }
  }
  return tarCmdCache;
}

function verifyHash(file, expected, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => {
      const got = hash.digest('hex');
      if (expected && got.toLowerCase() === String(expected).toLowerCase()) resolve();
      else reject(new Error(`${algo} 校验失败（期望 ${String(expected).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`));
    });
  });
}

/** 语义化比较，用于给版本号排序（1.21.10 > 1.21.9） */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const s = String(pa[i] ?? '').localeCompare(String(pb[i] ?? ''));
      if (s) return s;
    } else if (na !== nb) return na - nb;
  }
  return 0;
}

// ============================ 实例管理 ============================

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function fmtSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** exp).toFixed(exp ? 1 : 0)} ${units[exp]}`;
}

module.exports = { mavenVersions, runCmd, tarCmdCache, tarCmd, verifyHash, cmpVersion, NAME_RE, fmtSize };
