'use strict';
// 网络相关的小工具：目前只有「反向代理信任」的取值解析。
//
// 单独成模块的原因（低耦合 + 可测）：
//   panel/server.js 一旦被 require 就会启动 HTTP 服务并读配置，无法在测试里直接引用；
//   而 trust proxy 的取值直接决定「限流按谁分桶」，是安全相关逻辑，必须能单测。
//   这里保持零依赖、零副作用。

/**
 * 解析 --trust-proxy / BLOCKNEXUS_TRUST_PROXY 的取值，供 app.set('trust proxy', ...) 使用。
 *
 * 返回 null 表示「不信任任何转发头」（默认，最安全）。
 * 不认识的取值一律返回 null —— 宁可不信任，也不要误信任。
 *
 * 为什么推荐用「跳数」而不是 IP 列表：
 *   X-Forwarded-For 由每一层代理逐跳追加自己的上游地址。express 在 trust proxy = N 时
 *   取「从右往左第 N+1 个」，所以攻击者在请求里预塞多少个伪造值都不起作用。
 *   而 IP 列表一旦写宽（例如为了省事写 0.0.0.0/0），就等于无条件信任。
 *
 * @param {string|number|null|undefined} raw
 * @returns {number|string|null} 跳数、express 预设名，或 null
 */
function parseTrustProxy(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;

  // 纯数字 → 可信代理层数；0 视为未配置
  if (/^\d+$/.test(s)) {
    const hops = Number(s);
    return hops > 0 ? hops : null;
  }

  // express 内置预设
  if (['loopback', 'linklocal', 'uniquelocal'].includes(s)) return s;

  return null;
}

module.exports = { parseTrustProxy };
