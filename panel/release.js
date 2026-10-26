'use strict';
// 发布源与 URL 构造：纯逻辑，零 IO、零网络。
//
// 为什么单独成模块：更新检查原先同时依赖 api.github.com、Release 资产列表和
// 硬编码的资产名，任何一环不可用就整体失败。这里把「最新版元数据在哪、某个版本的
// 某个资产在哪」变成可单测的字符串规则：
//   · 主路径 = `releases/latest/download/update.json`（不消耗 GitHub API 速率限制）
//   · 资产 URL = 由版本号 + 命名约定构造（不需要 API 返回 assets 列表）
//   · 自定义源 = 一个 base URL 或带 {version}/{name} 的模板
//
// 网络请求与验签在 panel/api.js / panel/signature.js；本文件只回答「去哪儿取」。

const upd = require('./update');

const REPO = 'live-ling/BlockNexus';
const GITHUB_BASE = `https://github.com/${REPO}/releases/download`;
const GITHUB_LATEST_META = `https://github.com/${REPO}/releases/latest/download/update.json`;

/** GitHub 官方源：latest 走固定重定向端点，指定版本走 releases/download/vX/ */
const GITHUB_SOURCE = Object.freeze({
  id: 'github',
  label: 'GitHub',
  base: GITHUB_BASE,
  latestMeta: GITHUB_LATEST_META,
  metaTemplate: `${GITHUB_BASE}/v{version}/update.json`,
  assetTemplate: `${GITHUB_BASE}/v{version}/{name}`,
  versioned: true,
});

/** 简单模板填充：只认 {version} / {name}，不做表达式 */
function fill(template, vars) {
  const v = vars || {};
  return String(template)
    .replace(/\{version\}/g, v.version === undefined ? '' : String(v.version))
    .replace(/\{name\}/g, v.name === undefined ? '' : String(v.name));
}

function trimBase(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * 把用户填的「下载源」变成源对象。
 *
 * 支持的两种写法（与旧版 settings.update.source 兼容）：
 *   1. 模板：`https://mirror/{version}/{name}` —— 两个占位符都可用 name/update.json
 *   2. base：`https://mirror/bn` —— 元数据在 `<base>/update.json`，资产在 `<base>/<name>`
 *      （GitHub 风格的 `.../releases/download` 会自动补成 `.../releases/latest/download/...`）
 */
function customSource(raw) {
  const base = trimBase(raw);
  if (!base) return null;
  const isTemplate = base.includes('{version}') || base.includes('{name}');
  if (isTemplate) {
    return {
      id: 'custom',
      label: '自定义源',
      base,
      latestMeta: fill(base, { version: 'latest', name: upd.ASSET.meta }),
      metaTemplate: base,
      assetTemplate: base,
      versioned: base.includes('{version}'),
    };
  }
  // GitHub 风格的下载目录：.../releases/download → .../releases/latest/download/update.json
  if (/\/releases\/download$/i.test(base)) {
    return {
      id: 'custom',
      label: '自定义源',
      base,
      latestMeta: `${base.replace(/\/download$/i, '/latest/download')}/${upd.ASSET.meta}`,
      metaTemplate: `${base}/v{version}/${upd.ASSET.meta}`,
      assetTemplate: `${base}/v{version}/{name}`,
      versioned: true,
    };
  }
  // 普通镜像根：update.json 与资产都按名字直出
  return {
    id: 'custom',
    label: '自定义源',
    base,
    latestMeta: `${base}/${upd.ASSET.meta}`,
    metaTemplate: `${base}/v{version}/${upd.ASSET.meta}`,
    assetTemplate: `${base}/{name}`,
    versioned: false,
  };
}

/** 源列表：自定义源优先，GitHub 兜底；相同 id 去重 */
function sources(customRaw) {
  const custom = customSource(customRaw);
  const list = custom ? [custom, GITHUB_SOURCE] : [GITHUB_SOURCE];
  const seen = new Set();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** 取某个版本的 update.json；version 省略/空 = latest */
function metaUrl(source, version) {
  const v = String(version || '').trim().replace(/^v/i, '');
  if (!v) return source.latestMeta;
  return fill(source.metaTemplate, { version: v, name: upd.ASSET.meta });
}

/**
 * 某个版本的 update.json 的候选地址（按顺序尝试）。
 * 目的是兼容「镜像根只放一份 update.json」与「镜像按 vX/ 分目录」两种部署。
 */
function metaCandidates(source, version) {
  const v = String(version || '').trim().replace(/^v/i, '');
  if (!v) return [source.latestMeta];
  const out = [metaUrl(source, v)];
  if (!source.versioned) out.push(`${source.base}/${upd.ASSET.meta}`);
  return [...new Set(out.filter(Boolean))];
}

/** 某个版本的资产地址（name 必须是 ASSET.* 产出的名字） */
function assetUrl(source, version, name) {
  const v = String(version || '').trim().replace(/^v/i, '');
  return fill(source.assetTemplate, { version: v, name: String(name || '') });
}

function sigUrl(source, version) {
  return assetUrl(source, version, upd.ASSET.sig);
}

function sumsUrl(source, version) {
  return assetUrl(source, version, upd.ASSET.sums);
}

/** 一个版本需要出现在 assets 里的全部名字（顺序固定，便于测试与展示） */
function assetNames(version) {
  return [
    upd.ASSET.app(version),
    upd.ASSET.portable(version),
    upd.ASSET.shell(version),
    upd.ASSET.meta,
    upd.ASSET.sig,
    upd.ASSET.sums,
  ];
}

/**
 * 不依赖 GitHub API 的资产列表：名字由约定生成，URL 指向同一个源。
 * size=0 表示未知（进度条退化到「不确定态」）。
 */
function synthAssets(source, version, sizeOf) {
  const sizes = sizeOf || {};
  return assetNames(version).map((name) => ({
    name,
    size: Number(sizes[name]) > 0 ? Number(sizes[name]) : 0,
    browser_download_url: assetUrl(source, version, name),
  }));
}

/**
 * 合并 API 的资产列表与合成列表。
 * 自定义源**只用合成 URL**（否则下载又回到 GitHub，镜像等于没用）；
 * GitHub 源优先用 API 的真实 URL/大小，缺的项用合成 URL 补齐。
 */
function mergeAssets(apiAssets, source, version) {
  const synth = synthAssets(source, version);
  if (!source || source.id !== 'github') return synth;
  if (!Array.isArray(apiAssets) || !apiAssets.length) return synth;
  const byName = new Map();
  for (const a of apiAssets) {
    if (a && a.name && a.browser_download_url) byName.set(String(a.name), a);
  }
  return synth.map((s) => {
    const hit = byName.get(s.name);
    return hit
      ? { name: s.name, size: Number(hit.size) > 0 ? Number(hit.size) : 0, browser_download_url: String(hit.browser_download_url) }
      : s;
  });
}

/** 元数据缺失时用 tag 合成安全默认（转发到 panel/update.js，保持单一实现） */
function effectiveMeta(meta, tag) {
  return upd.fillMetaFromTag(meta, tag);
}

module.exports = {
  REPO,
  GITHUB_SOURCE,
  fill,
  customSource,
  sources,
  metaUrl,
  metaCandidates,
  assetUrl,
  sigUrl,
  sumsUrl,
  assetNames,
  synthAssets,
  mergeAssets,
  effectiveMeta,
};
