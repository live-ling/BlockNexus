'use strict';
// BlockNexus Agent — 版本/核心目录缓存与查询
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const { CORE_KINDS, FABRIC_GAME_API, FORGE_MAVEN, MSL_SOURCES, NEOFORGE_MAVEN, NEOFORGE_MC_PREFIX, PAPER_API, PURPUR_API, mslFetchJson } = require('../catalog.js');
const { MANIFEST_MIRRORS, MANIFEST_TTL, MANIFEST_URL, STALE_TTL, fetchJson } = require('../http.js');
const { cmpVersion, mavenVersions } = require('../util.js');



module.exports = {
  // 版本清单获取（带磁盘缓存兜底）：官方源 → 镜像源逐个尝试，全部失败时
  // 回退到最近 7 天内的磁盘缓存（返回 stale 标记），避免服务器网络抖动导致建不了实例
  versionsCacheFile() {
    return path.join(this.dir, '.blocknexus-versions-cache.json');
  },

  async ensureVersions() {
    if (this.versionsCache && Date.now() - this.versionsCache.at <= MANIFEST_TTL) {
      return this.versionsCache.data;
    }
    const errs = [];
    for (const url of [MANIFEST_URL, ...MANIFEST_MIRRORS]) {
      try {
        const data = await fetchJson(url, 12000);
        if (!data || !Array.isArray(data.versions)) throw new Error('清单格式异常');
        this.versionsCache = { at: Date.now(), data };
        try {
          fs.writeFileSync(
            this.versionsCacheFile(),
            JSON.stringify({ at: Date.now(), data }),
          );
        } catch {}
        return data;
      } catch (e) {
        errs.push(`${new URL(url).host}: ${e.message}`);
      }
    }
    try {
      const cached = JSON.parse(fs.readFileSync(this.versionsCacheFile(), 'utf8'));
      if (cached && cached.data && Date.now() - cached.at <= STALE_TTL) {
        this.versionsCache = { at: Date.now(), data: cached.data };
        return { ...cached.data, stale: true };
      }
    } catch {}
    throw new Error('版本清单获取失败（' + errs.join('；') + '），请检查服务器网络');
  },

  async getVersions() {
    const data = await this.ensureVersions();
    return {
      latest: data.latest.release,
      versions: data.versions
        .filter((v) => v.type === 'release')
        .slice(0, 80)
        .map((v) => ({ id: v.id, releaseTime: v.releaseTime })),
      stale: !!data.stale,
    };
  },

  // ---------- 服务端核心目录 ----------
  // 每个第三方核心一份磁盘缓存（1 小时新鲜 / 7 天过期兜底），结构与版本清单一致。

  coresCacheFile() {
    return path.join(this.dir, '.blocknexus-cores-cache.json');
  },

  readCoresCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.coresCacheFile(), 'utf8'));
      if (c && c.data && Date.now() - c.at <= STALE_TTL) return { at: c.at, data: c.data };
    } catch {}
    return null;
  },

  writeCoresCache(data) {
    try {
      fs.writeFileSync(this.coresCacheFile(), JSON.stringify({ at: Date.now(), data }));
    } catch {}
  },

  /** 官方源取某个核心可安装的 MC 版本列表；kind 决定数据源，api=false 的核心没有远端目录 */
  async coreVersionsForOfficial(kind) {
    if (kind === 'vanilla') {
      const data = await this.ensureVersions();
      return {
        versions: data.versions
          .filter((v) => v.type === 'release')
          .slice(0, 80)
          .map((v) => ({ id: v.id })),
        latest: data.latest.release,
        stale: !!data.stale,
      };
    }
    if (kind === 'paper' || kind === 'folia') {
      const d = await fetchJson(`${PAPER_API}/${kind}`, 15000);
      const list = Object.keys(d.versions || {}).sort((a, b) => cmpVersion(b, a));
      return { versions: list.map((id) => ({ id })), latest: list[0] || null };
    }
    if (kind === 'purpur') {
      const d = await fetchJson(PURPUR_API, 15000);
      // 该接口按发布时间升序返回，倒过来才是「新版本在前」
      const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
      return { versions: list.map((id) => ({ id })), latest: list[0] || null };
    }
    if (kind === 'fabric') {
      const g = await fetchJson(FABRIC_GAME_API, 15000);
      const stable = (Array.isArray(g) ? g : []).filter((v) => v.stable);
      return {
        versions: stable.slice(0, 40).map((v) => ({ id: v.version })),
        latest: stable[0] && stable[0].version,
      };
    }
    if (kind === 'forge') {
      const xml = await this.httpGetText(FORGE_MAVEN, 20000);
      // forge 版本号形如 1.20.1-47.2.0；取每个 MC 版本的最新构建
      const byMc = new Map();
      for (const v of mavenVersions(xml)) {
        const m = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(v);
        if (!m) continue;
        const cur = byMc.get(m[1]);
        if (!cur || cmpVersion(m[2], cur.build) > 0) byMc.set(m[1], { mc: m[1], build: m[2], full: v });
      }
      const list = [...byMc.values()].sort((a, b) => cmpVersion(b.mc, a.mc));
      return {
        versions: list.map((x) => ({ id: x.mc, build: x.full })),
        latest: list[0] && list[0].mc,
      };
    }
    if (kind === 'neoforge') {
      const xml = await this.httpGetText(NEOFORGE_MAVEN, 20000);
      const byMc = new Map();
      for (const v of mavenVersions(xml)) {
        if (!/^\d+\.\d+\.\d+/.test(v)) continue; // 跳过 0.25w14craftmine 这类快照
        const mc = Object.keys(NEOFORGE_MC_PREFIX).find((k) => v.startsWith(NEOFORGE_MC_PREFIX[k]));
        if (!mc) continue;
        const cur = byMc.get(mc);
        if (!cur || cmpVersion(v, cur) > 0) byMc.set(mc, v);
      }
      const list = [...byMc.entries()]
        .map(([mc, v]) => ({ id: mc, build: v }))
        .sort((a, b) => cmpVersion(b.id, a.id));
      return { versions: list, latest: list[0] && list[0].id };
    }
    throw new Error('未知核心类型: ' + kind);
  },

  /** MSL 镜像的版本目录兜底（官方源不可用时） */
  async mslVersionsFor(kind) {
    if (!MSL_SOURCES.has(kind)) throw new Error('MSL 不支持该核心类型: ' + kind);
    const d = await mslFetchJson('/mirrors/' + encodeURIComponent(kind), 15000);
    const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
    const versions = list.map((id) => ({ id }));
    if (!versions.length) throw new Error('MSL 版本目录为空');
    return { versions, latest: versions[0].id };
  },

  /** 取某个核心可安装的 MC 版本列表：官方源 → MSL 镜像兜底 */
  async coreVersionsFor(kind) {
    try {
      return await this.coreVersionsForOfficial(kind);
    } catch (officialErr) {
      try {
        return await this.mslVersionsFor(kind);
      } catch {
        throw officialErr; // 镜像也失败时保留官方错误（更接近根因）
      }
    }
  },

  /** 汇总所有核心的目录（各自失败不影响其他核心，失败项返回 error） */
  async coreCatalogs() {
    const out = { kinds: CORE_KINDS, catalogs: {} };
    const entries = await Promise.all(
      CORE_KINDS.filter((k) => k.api).map(async (k) => {
        try {
          const r = await this.coreVersionsFor(k.id);
          return [k.id, { ...r, ok: true }];
        } catch (e) {
          return [k.id, { ok: false, error: e.message, versions: [] }];
        }
      }),
    );
    for (const [id, r] of entries) out.catalogs[id] = r;
    // 任一核心成功就刷新缓存；全部失败时读旧缓存兜底
    const anyOk = entries.some(([, r]) => r.ok);
    if (anyOk) {
      this.writeCoresCache(out.catalogs);
      out.stale = false;
    } else {
      const cached = this.readCoresCache();
      if (cached) {
        out.catalogs = cached.data;
        out.stale = true;
      } else {
        out.stale = true;
      }
    }
    return out;
  }
};
