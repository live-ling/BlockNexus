'use strict';
// panel/release.js 的纯逻辑测试：源模型、URL 构造、资产合成/合并。
//
// 运行：node agent/test-panel-release.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const R = require(path.join(__dirname, '..', 'panel', 'release.js'));
const U = require(path.join(__dirname, '..', 'panel', 'update.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const GH = R.GITHUB_SOURCE;

// ---------- 模板填充 ----------
check('fill: version/name 都替换',
  R.fill('https://x/{version}/{name}', { version: '1.0.0', name: 'a.zip' }) === 'https://x/1.0.0/a.zip');
check('fill: 缺变量替换为空串（不抛）',
  R.fill('https://x/{version}/{name}', {}) === 'https://x//');
check('fill: 未知占位符原样保留',
  R.fill('https://x/{other}', { version: '1' }) === 'https://x/{other}');

// ---------- GitHub 源 ----------
check('github: latest 元数据是固定重定向端点',
  R.metaUrl(GH, '') === `https://github.com/${R.REPO}/releases/latest/download/update.json` &&
    R.metaUrl(GH) === R.metaUrl(GH, ''));
check('github: 指定版本元数据',
  R.metaUrl(GH, 'v0.7.0') === `https://github.com/${R.REPO}/releases/download/v0.7.0/update.json`);
check('github: 资产 URL 由版本+名字构造',
  R.assetUrl(GH, '0.7.0', U.ASSET.app('0.7.0')) ===
    `https://github.com/${R.REPO}/releases/download/v0.7.0/BlockNexus-v0.7.0-app.zip`);
check('github: sig / sums 走同一个模板',
  R.sigUrl(GH, '0.7.0') === `https://github.com/${R.REPO}/releases/download/v0.7.0/update.json.sig` &&
    R.sumsUrl(GH, '0.7.0') === `https://github.com/${R.REPO}/releases/download/v0.7.0/SHA256SUMS.txt`);
check('github: 版本号带 v 也归一化',
  R.assetUrl(GH, 'v0.7.0', 'x.zip') === R.assetUrl(GH, '0.7.0', 'x.zip'));

// ---------- 自定义源 ----------
{
  const s = R.customSource('https://mirror.example/bn');
  check('custom base: 识别为 base 源', !!s && s.id === 'custom' && s.versioned === false);
  check('custom base: latest 元数据在根',
    R.metaUrl(s, '') === 'https://mirror.example/bn/update.json');
  check('custom base: 指定版本先试 vX 目录、再退根',
    JSON.stringify(R.metaCandidates(s, '0.7.0')) ===
      JSON.stringify(['https://mirror.example/bn/v0.7.0/update.json', 'https://mirror.example/bn/update.json']));
  check('custom base: 资产按名字直出',
    R.assetUrl(s, '0.7.0', 'a.zip') === 'https://mirror.example/bn/a.zip');
}
{
  const s = R.customSource('https://mirror.example/{version}/{name}');
  check('custom template: latest 元数据 = latest/update.json',
    R.metaUrl(s, '') === 'https://mirror.example/latest/update.json');
  check('custom template: 指定版本元数据',
    R.metaUrl(s, '0.7.0') === 'https://mirror.example/0.7.0/update.json');
  check('custom template: 资产',
    R.assetUrl(s, '0.7.0', 'a.zip') === 'https://mirror.example/0.7.0/a.zip');
  check('custom template: 只尝试模板地址',
    R.metaCandidates(s, '0.7.0').length === 1);
}
{
  const s = R.customSource('https://ghproxy.example/https://github.com/live-ling/BlockNexus/releases/download/');
  check('custom github-style: latest 自动补 /latest/download/',
    R.metaUrl(s, '') ===
      'https://ghproxy.example/https://github.com/live-ling/BlockNexus/releases/latest/download/update.json');
  check('custom github-style: 指定版本资产',
    R.assetUrl(s, '0.7.0', 'a.zip') ===
      'https://ghproxy.example/https://github.com/live-ling/BlockNexus/releases/download/v0.7.0/a.zip');
}
check('custom: 空串 → null', R.customSource('') === null && R.customSource('   ') === null);
check('custom: 末尾斜杠被裁掉',
  R.assetUrl(R.customSource('https://m/bn///'), '1.0.0', 'x') === 'https://m/bn/x');

// ---------- 源列表 ----------
check('sources: 留空只有 GitHub', R.sources('').length === 1 && R.sources('')[0].id === 'github');
check('sources: 自定义源优先，GitHub 兜底',
  R.sources('https://m/bn').map((s) => s.id).join(',') === 'custom,github');
check('sources: 每个源都是独立对象（可带不同 template）',
  R.sources('https://m/bn')[0] !== R.sources('https://m/bn')[0]);

// ---------- 资产合成/合并 ----------
{
  const names = R.assetNames('0.7.0');
  check('assetNames: 六个名字齐全', names.length === 6 && names.includes(U.ASSET.sig) && names.includes(U.ASSET.sums));
  const synth = R.synthAssets(GH, '0.7.0', { 'SHA256SUMS.txt': 123 });
  check('synthAssets: 每项都有 URL',
    synth.every((a) => a.name && a.browser_download_url) && synth.length === 6);
  check('synthAssets: size 可注入（未知为 0）',
    synth.find((a) => a.name === U.ASSET.sums).size === 123 &&
      synth.find((a) => a.name === U.ASSET.app('0.7.0')).size === 0);
}
{
  const api = [
    { name: U.ASSET.app('0.7.0'), size: 999, browser_download_url: 'https://api/app.zip' },
    { name: 'extra.txt', size: 1, browser_download_url: 'https://api/extra' },
  ];
  const merged = R.mergeAssets(api, GH, '0.7.0');
  const app = merged.find((a) => a.name === U.ASSET.app('0.7.0'));
  const sums = merged.find((a) => a.name === U.ASSET.sums);
  check('mergeAssets(github): 命中 API 的项用真实 URL/大小',
    app.browser_download_url === 'https://api/app.zip' && app.size === 999);
  check('mergeAssets(github): API 缺的项用约定 URL 补齐',
    sums.browser_download_url === R.assetUrl(GH, '0.7.0', U.ASSET.sums) && sums.size === 0);
  check('mergeAssets(github): API 多余项不会混进来', merged.every((a) => a.name !== 'extra.txt'));
  const custom = R.customSource('https://m/bn');
  const cm = R.mergeAssets(api, custom, '0.7.0');
  check('mergeAssets(custom): 永远用镜像 URL（否则等于没走镜像）',
    cm.every((a) => a.browser_download_url.startsWith('https://m/bn/')));
}

// ---------- 元数据回退 ----------
{
  const ok = R.effectiveMeta(U.parseUpdateMeta({ version: '0.7.0' }).meta, '0.7.0');
  check('effectiveMeta: 合法 meta 原样返回', ok.filled === false && ok.meta.version === '0.7.0');
  const fb = R.effectiveMeta(null, 'v0.7.0');
  check('effectiveMeta: 缺 meta 用 tag 合成且保守', fb.filled === true && fb.meta.breaking === true && fb.meta.version === '0.7.0');
}

// ---------- 与 api.js 的接线检查（防止又长出一份 URL 规则） ----------
{
  const api = fs.readFileSync(path.join(__dirname, '..', 'panel', 'api.js'), 'utf8');
  check('api.js 引用 panel/release.js', /require\(['"]\.\/release['"]\)/.test(api));
  const lib = fs.readFileSync(path.join(__dirname, '..', 'panel', 'release.js'), 'utf8');
  check('release.js 不直接发网络请求', !/https?\.get\(|fetch\(/.test(lib));
}

console.log(`\n${pass}/${total} panel-release cases passed`);
process.exit(pass === total ? 0 : 1);
