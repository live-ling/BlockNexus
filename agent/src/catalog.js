'use strict';
// BlockNexus Agent — 服务端核心目录与 MSL 镜像源
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const https = require('https');
const net = require('net');
const { fetchJson } = require('./http.js');

// ============================ 服务端核心目录 ============================
// 原版走 Mojang 清单；Paper/Purpur/Folia 有官方 API 可直接拿到 jar 直链；
// Fabric/Forge/NeoForge 没有可直连的服务端 jar，只能用官方安装器现场安装。
// 所有目录都带磁盘缓存：拉不到在线清单时退回缓存，保证建实例这一步不因网络抖动卡死。

const CORE_KINDS = [
  // api=true 表示有远端版本目录（coreVersionsFor 能给出可安装版本）
  { id: 'vanilla', label: '原版 Vanilla', api: true },
  { id: 'paper', label: 'Paper', api: true },
  { id: 'purpur', label: 'Purpur', api: true },
  { id: 'folia', label: 'Folia', api: true },
  { id: 'fabric', label: 'Fabric', api: true },
  { id: 'forge', label: 'Forge', api: true },
  { id: 'neoforge', label: 'NeoForge', api: true },
  { id: 'url', label: '自定义 URL', api: false },
  { id: 'upload', label: '上传本地核心', api: false },
];

const PAPER_API = 'https://fill.papermc.io/v3/projects';

// server.jar 实为 paperclip 引导器的来源：首次启动要自己去 piston-data.mojang.com 下载
// 原版核心到 cache/，国内服务器连不上官方源会一直启动失败 —— 需要面板预置该文件
const PAPERCLIP_SOURCES = new Set(['paper', 'purpur', 'folia']);

const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';

const FABRIC_GAME_API = 'https://meta.fabricmc.net/v2/versions/game';

const FABRIC_LOADER_API = 'https://meta.fabricmc.net/v2/versions/loader';

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';

const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';

// Fabric 安装器版本：官方 maven 上的固定版本，只在有新特性时才手动跟进
const FABRIC_INSTALLER = '1.1.2';

const FABRIC_INSTALLER_JAR = `fabric-installer-${FABRIC_INSTALLER}.jar`;

// NeoForge 版本号与 MC 版本的对应关系没有公开 API，只能用已知的主版本段映射（新版本取最新段）
const NEOFORGE_MC_PREFIX = {
  '1.21.1': '21.1.',
  '1.21.2': '21.2.',
  '1.21.3': '21.3.',
  '1.21.4': '21.4.',
  '1.21.5': '21.5.',
  '1.21.6': '21.6.',
  '1.21.7': '21.7.',
  '1.21.8': '21.8.',
  '1.21.9': '21.9.',
  '1.21.10': '21.10.',
  '1.20.5': '20.5.',
  '1.20.6': '20.6.',
  '1.20.4': '20.4.',
  '1.20.3': '20.3.',
  '1.20.2': '20.2.',
  '1.20.1': '20.1.',
  '1.20': '20.1.',
  '1.19.4': '19.4.',
  '1.19.3': '19.3.',
  '1.19.2': '19.2.',
  '1.18.2': '18.2.',
};

// ============================ MSL 镜像源 ============================
// MSL 开服器公共镜像（https://www.mslmc.cn，api.mslmc.cn/v4）：官方源不可用时的兜底。
// 使用要求：请求带含应用名的 User-Agent；API 有 QPS 限制，因此仅在官方源失败后才调用。
// 支持的核心名与内置来源同名：vanilla/paper/purpur/folia/forge/neoforge/fabric。
const MSL_API = 'https://api.mslmc.cn/v4';

// 可走 MSL 兜底的来源（url/upload 是用户自备的，不在此列）
const MSL_SOURCES = new Set(['vanilla', 'paper', 'purpur', 'folia', 'forge', 'neoforge', 'fabric']);

/** MSL 接口统一走 UA + 解包 {code,message,data}；code!==200 视为失败 */
async function mslFetchJson(suffix, timeoutMs = 15000) {
  const d = await fetchJson(MSL_API + suffix, timeoutMs);
  if (!d || d.code !== 200) throw new Error((d && d.message) || 'MSL 接口返回 ' + (d && d.code));
  return d.data;
}

module.exports = { CORE_KINDS, PAPER_API, PAPERCLIP_SOURCES, PURPUR_API, FABRIC_GAME_API, FABRIC_LOADER_API, FORGE_MAVEN, NEOFORGE_MAVEN, NEOFORGE_MAVEN_BASE, FORGE_MAVEN_BASE, FABRIC_INSTALLER, FABRIC_INSTALLER_JAR, NEOFORGE_MC_PREFIX, MSL_API, MSL_SOURCES, mslFetchJson };
