'use strict';
// 服务器地区自动推断（ipwho.is）
//
// 以前地区靠用户在「快速添加 / 编辑服务器」里手动选择；现在改为面板侧
// 调用 https://ipwho.is/<host> 自动推断，用户不再选择：
//   · host 是域名 → ipwho.is 会先解析再按出口 IP 定位；
//   · host 是本机/回环/内网地址 → 直接跳过（内网地址没有地理位置，
//     ipwho.is 也只会回 401 reserved）；
//   · 结果带 in-memory 缓存（每地址最多 1 小时一查），失败一律返回 null，
//     绝不因为查不到地区而影响主流程。
//
// 纯网络模块、零依赖（Node 18+ 全局 fetch）；查的是面板本机出口看到的地址，
// 与本机/内网拓扑无关。

const net = require('net');

const REGION_TTL_MS = 60 * 60e3; // 同一地址最多 1 小时查一次
const LOOKUP_TIMEOUT_MS = 4000; // 单次查询超时（含 DNS 解析）

/** host -> { at, region }：不管成功与否都缓存（失败 region=null，防止反复打失败地址） */
const cache = new Map();

/** 是否本机/回环/内网地址（这些不该去查公网 GeoIP） */
function isPrivateHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const t = net.isIP(h);
  if (t === 4) {
    const p = h.split('.').map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || // CGNAT
      p[0] === 0
    );
  }
  if (t === 6) {
    return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h);
  }
  return false;
}

/**
 * 查一个公网 IP/域名的地区码（小写两位 ISO 国家码；失败/内网返回 null）。
 * @param {string} host
 * @returns {Promise<string|null>}
 */
async function lookupRegion(host) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h || isPrivateHost(h)) return null;

  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < REGION_TTL_MS) return hit.region;

  let region = null;
  try {
    // 延迟到调用时再取 fetch：面板测试会在 require api.js 之前替换 global.fetch，
    // 若在模块顶层缓存 fetch 会被测试替身永久接管（地区推断变成假数据）。
    const doFetch = global.fetch;
    if (typeof doFetch !== 'function') return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const r = await doFetch(`https://ipwho.is/${encodeURIComponent(h)}?fields=success,country_code`, {
        signal: ac.signal,
      });
      if (r.ok) {
        const j = await r.json();
        const cc = String((j && j.country_code) || '').trim().toLowerCase();
        if (j && j.success === true && /^[a-z]{2}$/.test(cc)) region = cc;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    region = null;
  }
  cache.set(h, { at: Date.now(), region });
  // 表满淘汰最旧（与 loginFails 同一思路：地址再杂也不让 Map 无限长）
  if (cache.size > 512) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return region;
}

module.exports = { lookupRegion, isPrivateHost, _cache: cache };
