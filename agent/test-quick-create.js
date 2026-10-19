// 「快速添加」默认值推导（panel/quick.js）的回归测试。
//
// 为什么单独测这一层：快速添加不填参数也能跑，靠的就是这里补出来的
// 名称/端口/内存/版本。它们全是纯函数，不需要面板与真实服务器，最容易钉住；
// 另外还钉两条「测试与实现不许漂移」的断言：
//   · panel/quick.js 的实例名规则必须与 agent/src/util.js 逐字一致（Agent 侧会再校验）；
//   · quick.js / api.js 里用到的错误码必须都存在于 panel/error-codes.js（否则前端拿到空文案）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const quick = require(path.join(ROOT, 'panel', 'quick.js'));
const { ERROR_CODES } = require(path.join(ROOT, 'panel', 'error-codes.js'));

let pass = 0;
let total = 0;

function eq(name, got, want) {
  total++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} → ${g}（期望 ${w}）`);
}

function ok(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 内存推荐 ----------
eq('无物理内存信息 → 2GB', quick.recommendMemoryMB(0), 2048);
eq('无物理内存信息（undefined）→ 2GB', quick.recommendMemoryMB(undefined), 2048);
eq('1GB 机器 → 512MB（下限）', quick.recommendMemoryMB(1024), 512);
eq('4GB 机器 → 2GB', quick.recommendMemoryMB(4096), 2048);
eq('12GB 机器 → 6GB', quick.recommendMemoryMB(10240), 5120);
eq('32GB 机器 → 8GB（上限）', quick.recommendMemoryMB(32768), 8192);
eq('奇数内存向下对齐 512', quick.recommendMemoryMB(5000), 2048);

// ---------- 端口 ----------
eq('没有实例 → 25565', quick.pickPort([], 25565), 25565);
eq('25565 被占用 → 25566', quick.pickPort([{ port: 25565 }], 25565), 25566);
eq('连续占用 → 顺延到第一个空闲', quick.pickPort([{ port: 25565 }, { port: 25566 }, { port: 25568 }], 25565), 25567);
eq('用户指定端口空闲 → 原样使用', quick.pickPort([{ port: 25565 }], 30000), 30000);
eq('用户指定端口被占用 → 顺延', quick.pickPort([{ port: 30000 }], 30000), 30001);
eq('非法期望端口 → 退回 25565', quick.pickPort([], 80), 25565);
eq('脏数据（非数字端口）被忽略', quick.pickPort([{ port: 'oops' }, { port: 25565 }], 25565), 25566);
eq('顶到 65535 被占用 → 从 1024 回绕', quick.pickPort([{ port: 65535 }], 65535), 1024);

// ---------- 实例名 ----------
eq('没填 → survival', quick.pickName([], ''), { name: 'survival' });
eq(
  'survival 已就绪 → survival-2',
  quick.pickName([{ name: 'survival', status: 'stopped' }], ''),
  { name: 'survival-2' },
);
eq(
  'survival 与 survival-2 都已就绪 → survival-3',
  quick.pickName(
    [
      { name: 'survival', status: 'stopped' },
      { name: 'survival-2', status: 'running' },
    ],
    '',
  ),
  { name: 'survival-3' },
);
eq('用户指定的合法名字 → 原样', quick.pickName([], 'my-server_1'), { name: 'my-server_1' });
// 重名不报错：快速添加必须可重试，重名由调用方决定「复用/续装」（见 api.js 的 quickSetup）
eq('用户指定的名字与已有实例重名 → 仍原样返回', quick.pickName([{ name: 'mc1', status: 'stopped' }], 'mc1'), {
  name: 'mc1',
});
eq('非法名字 → name-invalid', quick.pickName([], '_x'), { error: 'instance.name-invalid' });
eq('名字过长（33 位）→ name-invalid', quick.pickName([], 'a'.repeat(33)), { error: 'instance.name-invalid' });
// 自动命名：已就绪的同名实例算「另一台服」，而没就绪的算「上次没装完」，应当续用
eq(
  'survival 已就绪 → 自动另起 survival-2',
  quick.pickName([{ name: 'survival', status: 'stopped' }], ''),
  { name: 'survival-2' },
);
eq(
  'survival 上次失败 → 自动续用 survival（重试不建第二份）',
  quick.pickName([{ name: 'survival', status: 'failed' }], ''),
  { name: 'survival' },
);
eq(
  'survival 正在下载 → 自动续用 survival',
  quick.pickName([{ name: 'survival', status: 'downloading' }], ''),
  { name: 'survival' },
);

// ---------- 版本 ----------
const agentCatalogs = {
  kinds: [{ id: 'paper' }],
  catalogs: {
    paper: { ok: true, latest: '1.21.4', versions: [{ id: '1.21.4' }, { id: '1.21.3' }] },
    forge: { ok: true, latest: '1.20.1', versions: [{ id: '1.20.1', build: '1.20.1-47.2.0' }] },
    fabric: { ok: false, error: '网络不可达', versions: [] },
  },
};
eq('未指定版本 → 最新版', quick.pickVersion(agentCatalogs, 'paper', ''), { version: '1.21.4', build: '' });
eq(
  '指定版本 → 用指定版本（带 build）',
  quick.pickVersion(agentCatalogs, 'forge', '1.20.1'),
  { version: '1.20.1', build: '1.20.1-47.2.0' },
);
eq(
  '指定不存在的版本 → 报错',
  quick.pickVersion(agentCatalogs, 'paper', '1.7.10'),
  { error: 'instance.quick-version-invalid', params: { version: '1.7.10' } },
);
eq(
  '目录为空（Agent 拉取失败）→ 报错而不是硬塞版本',
  quick.pickVersion(agentCatalogs, 'fabric', ''),
  { error: 'instance.quick-catalog-missing', params: { source: 'fabric' } },
);
eq(
  '面板兜底形状（无 catalogs 包裹）同样可用',
  quick.pickVersion({ paper: { ok: true, versions: [{ id: '1.21.1' }] } }, 'paper', ''),
  { version: '1.21.1', build: '' },
);
eq('目录完全缺失 → 报错', quick.pickVersion(null, 'paper', ''), {
  error: 'instance.quick-catalog-missing',
  params: { source: 'paper' },
});

// ---------- 参数规范化 ----------
const norm = quick.normalizeOptions({}, { memTotalMB: 4096 });
ok('全空输入 → 得到一套完整参数', !norm.error && norm.params.source === 'paper' && norm.params.memoryMB === 2048);
eq('默认端口 25565', norm.params.port, 25565);
eq('默认正版验证开', norm.params.onlineMode, true);
eq('默认 MOTD', norm.params.motd, 'A Minecraft Server');
eq("onlineMode='false' 字符串 → false", quick.normalizeOptions({ onlineMode: 'false' }).params.onlineMode, false);
eq('onlineMode=false → false', quick.normalizeOptions({ onlineMode: false }).params.onlineMode, false);
eq('显式内存优先于推荐值', quick.normalizeOptions({ memoryMB: 6144 }, { memTotalMB: 8192 }).params.memoryMB, 6144);
eq('内存过小 → 报错', quick.normalizeOptions({ memoryMB: 256 }).error, 'instance.quick-memory-range');
eq('内存过大 → 报错', quick.normalizeOptions({ memoryMB: 65536 }).error, 'instance.quick-memory-range');
eq('端口过小 → 报错', quick.normalizeOptions({ port: 80 }).error, 'instance.quick-port-range');
eq('端口非整数 → 报错', quick.normalizeOptions({ port: 25565.5 }).error, 'instance.quick-port-range');
eq('快速添加不接受自定义 URL 核心', quick.normalizeOptions({ source: 'url' }).error, 'instance.quick-source-invalid');
eq('快速添加不接受上传核心', quick.normalizeOptions({ source: 'upload' }).error, 'instance.quick-source-invalid');
eq('未知核心 → 报错', quick.normalizeOptions({ source: 'spigot' }).error, 'instance.quick-source-invalid');
eq('MOTD 截断到 100 字符', quick.normalizeOptions({ motd: 'x'.repeat(200) }).params.motd.length, 100);
eq('名字非法 → 报错', quick.normalizeOptions({ name: '有中文' }).error, 'instance.name-invalid');
eq('core 大小写不敏感', quick.normalizeOptions({ source: 'Paper' }).params.source, 'paper');

// ---------- Java 主版本要求 ----------
eq('1.21.4 需要 Java 21', quick.javaMajorFor('1.21.4'), 21);
eq('1.21 需要 Java 21', quick.javaMajorFor('1.21'), 21);
eq('1.20.5 需要 Java 21（分界线）', quick.javaMajorFor('1.20.5'), 21);
eq('1.20.4 需要 Java 17', quick.javaMajorFor('1.20.4'), 17);
eq('1.18.2 需要 Java 17', quick.javaMajorFor('1.18.2'), 17);
eq('1.17.1 需要 Java 16', quick.javaMajorFor('1.17.1'), 16);
eq('1.16.5 需要 Java 8', quick.javaMajorFor('1.16.5'), 8);
eq('1.12.2 需要 Java 8', quick.javaMajorFor('1.12.2'), 8);
eq('快照版本号（解析不出小版本）→ 按最新要求 21', quick.javaMajorFor('24w14a'), 21);
eq('空版本 → 21（宁高勿低）', quick.javaMajorFor(''), 21);

// ---------- 就绪判定 ----------
eq('null 记录 → 继续等', quick.readyVerdict(null), 'wait');
eq('downloading → 继续等', quick.readyVerdict({ status: 'downloading' }), 'wait');
eq('incomplete → 继续等', quick.readyVerdict({ status: 'incomplete' }), 'wait');
eq('failed → 失败', quick.readyVerdict({ status: 'failed' }), 'failed');
eq('stopped → 就绪', quick.readyVerdict({ status: 'stopped' }), 'ready');
eq('running → 就绪', quick.readyVerdict({ status: 'running' }), 'ready');
eq('starting → 就绪', quick.readyVerdict({ status: 'starting' }), 'ready');
ok('就绪实例可复用（重试不重复下载）', quick.reusableInstance({ status: 'stopped' }) === true);
ok('下载中的实例不可复用', quick.reusableInstance({ status: 'downloading' }) === false);

// ---------- 与 Agent 侧规则不许漂移 ----------
{
  const utilSrc = fs.readFileSync(path.join(__dirname, 'src', 'util.js'), 'utf8');
  const m = /const NAME_RE = (\/.*\/);/.exec(utilSrc);
  total++;
  const same = !!m && m[1] === quick.NAME_RE.toString();
  if (same) pass++;
  console.log(`${same ? 'PASS' : 'FAIL'} | 实例名规则与 agent/src/util.js 一致`);
}

// ---------- 错误码必须都在码表里 ----------
{
  const apiSrc = fs.readFileSync(path.join(ROOT, 'panel', 'api.js'), 'utf8');
  const quickSrc = fs.readFileSync(path.join(ROOT, 'panel', 'quick.js'), 'utf8');
  const used = new Set();
  for (const src of [apiSrc, quickSrc]) {
    for (const m of src.matchAll(/'(?:server|instance)\.quick-[a-z-]+'/g)) used.add(m[0].slice(1, -1));
  }
  const missing = [...used].filter((c) => !ERROR_CODES[c]);
  total++;
  if (!missing.length) pass++;
  console.log(
    `${missing.length ? 'FAIL' : 'PASS'} | 快速添加用到的错误码都在 error-codes 里` +
      (missing.length ? ' — 缺失: ' + missing.join(', ') : `（${used.size} 个）`),
  );

  // 码表里每条都得有中英文案（缺 en 会在英文界面显示空串）
  const badText = [...used].filter((c) => {
    const e = ERROR_CODES[c];
    return !e || !e.zh || !e.en || !Number.isInteger(e.status);
  });
  total++;
  if (!badText.length) pass++;
  console.log(
    `${badText.length ? 'FAIL' : 'PASS'} | 每条快速添加错误码都有 zh/en/status` +
      (badText.length ? ' — ' + badText.join(', ') : ''),
  );
}

// ---------- 路由存在 ----------
{
  const apiSrc = fs.readFileSync(path.join(ROOT, 'panel', 'api.js'), 'utf8');
  for (const frag of [
    "router.post('/servers/quick-create'",
    "router.post('/servers/:id/quick-setup'",
    'async function quickSetup(',
    'async function runAgentInstall(',
  ]) {
    total++;
    const ok_ = apiSrc.includes(frag);
    if (ok_) pass++;
    console.log(`${ok_ ? 'PASS' : 'FAIL'} | api.js 含 ${frag}`);
  }
  // 「安装 Agent」与「快速添加」必须共用同一条安装实现，避免两份逻辑日后分叉
  total++;
  const installUsesShared = /router\.post\('\/servers\/:id\/install'[\s\S]{0,1500}?runAgentInstall\(/.test(apiSrc);
  if (installUsesShared) pass++;
  console.log(`${installUsesShared ? 'PASS' : 'FAIL'} | /install 复用了 runAgentInstall`);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
