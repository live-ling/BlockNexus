'use strict';
// BlockNexus Agent — HTTP 下载、Mojang 清单与镜像改写
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const http = require('http');
const https = require('https');
const fs = require('fs');
const { VERSION } = require('./config.js');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// 版本清单镜像源：官方源不可达（超时/被墙）时依次回退；镜像返回的版本 JSON 与
// server.jar 下载地址同样指向镜像，因此创建实例的整条下载链路都会自动走可用源
const MANIFEST_MIRRORS = ['https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'];

// Mojang 的元数据/文件托管主机：镜像源可用相同路径代理（清单来自镜像时其 URL 已指向镜像）
const MOJANG_FILE_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com'];

const MANIFEST_TTL = 3600e3;

const STALE_TTL = 7 * 24 * 3600e3;

// 把 Mojang 托管的下载地址按原路径改写到镜像主机（BMCLAPI 支持相同路径代理）
function withMirror(urlStr, mirrorHost) {
  try {
    const u = new URL(urlStr);
    if (MOJANG_FILE_HOSTS.includes(u.host) && mirrorHost) {
      u.host = mirrorHost;
      return u.toString();
    }
  } catch {}
  return urlStr;
}

function mirrorHostOf() {
  try {
    return new URL(MANIFEST_MIRRORS[0]).host;
  } catch {
    return null;
  }
}

// ============================ HTTP 工具 ============================

// 部分镜像源（如清华 TUNA）会对不带 User-Agent 的请求返回 403，node 默认不带，必须显式设置。
// MSL 镜像源要求 UA 含应用名，统一用同一份（取自 config.js 的对外标识，避免版本号多处漂移）。
const HTTP_UA = VERSION;

function downloadToFile(urlStr, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('重定向过多'));
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ': ' + u));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total && onProgress) onProgress(got, total);
        });
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => resolve(dest));
      });
      req.on('error', (e) => reject(new Error((e.message || '网络错误') + ' — ' + u)));
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    };
    get(urlStr, 0);
  });
}

function fetchJson(urlStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('重定向过多'));
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ': ' + u));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    };
    get(urlStr, 0);
  });
}

module.exports = { MANIFEST_URL, MANIFEST_MIRRORS, MOJANG_FILE_HOSTS, MANIFEST_TTL, STALE_TTL, withMirror, mirrorHostOf, HTTP_UA, downloadToFile, fetchJson };
