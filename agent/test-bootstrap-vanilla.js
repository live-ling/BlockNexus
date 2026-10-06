// ensureBootstrapVanilla / doBootstrapVanilla 验证：从 agent/src/instance/core.js 提取方法体，
// 用本地桩函数跑完整个流程。
// 覆盖：已就位跳过 / sha1 旁证不符时自愈重下 / 官方源成功 / 官方失败走镜像 /
//       「下载成功但 sha1 不符」换源重试 / 双源失败清理临时文件 / 自动建 cache 目录 /
//       并发调用只下载一次（单飞去重）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = fs.readFileSync(path.join(__dirname, 'src', 'instance', 'core.js'), 'utf8');

/** 从对象字面量里提取一个方法（2 空格缩进 + 签名，收尾为 "\n  },"） */
function extractMethod(name) {
  const m = new RegExp(`^  (?:async )?${name}\\(`, 'm').exec(src);
  if (m < 0) throw new Error('未找到 ' + name);
  const body = src.slice(m.index, src.indexOf('\n  },', m.index));
  if (body.length < 30) throw new Error(name + ' 提取内容异常');
  return body;
}
const ensureSrc = extractMethod('ensureBootstrapVanilla');
const doSrc = extractMethod('doBootstrapVanilla');
// 源码片段防漂移：单飞去重、私有临时文件、镜像重试、sha1 旁证必须在位
for (const frag of ['bootstrapJobs', 'bootstrapSeq', '.sha1', '镜像源', 'rmSync(tmp']) {
  if (!(ensureSrc + doSrc).includes(frag)) throw new Error('ensureBootstrapVanilla 缺少实现细节: ' + frag);
}

// ---- 桩件 ----
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bn-bootstrap-'));
const JAR_BYTES = Buffer.from('fake vanilla jar content ' + 'x'.repeat(1024));
const OTHER_BYTES = Buffer.from('another (wrong) jar content ' + 'y'.repeat(1024));
const GOOD_SHA1 = crypto.createHash('sha1').update(JAR_BYTES).digest('hex');
const BAD_SHA1 = '0'.repeat(40);

let files = {}; // url -> Buffer | 'FAIL'
let versionJson = null;
let withMirrorMap = {};
let downloadDelayMs = 0;
let downloads = []; // 记录每次下载的 url（用于断言并发只下一次）

const fakeFetchJson = async (url) => {
  if (url === 'VJSON') return versionJson;
  throw new Error('意外请求 ' + url);
};
const fakeDownloadToFile = async (url, dest) => {
  downloads.push(url);
  if (downloadDelayMs) await new Promise((r) => setTimeout(r, downloadDelayMs));
  const f = files[url];
  if (!f || f === 'FAIL') throw new Error('connect ECONNREFUSED（模拟）');
  fs.writeFileSync(dest, f);
};
const fakeVerifyHash = (file, expected, algo) => {
  return new Promise((resolve, reject) => {
    const got = crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
    if (expected && got.toLowerCase() === String(expected).toLowerCase()) resolve();
    else reject(new Error(`${algo} 校验失败（期望 ${String(expected).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`));
  });
};
const fakeWithMirror = (url) => withMirrorMap[url] || url;
const fakeMirrorHostOf = () => 'mirror.test';
const PAPERCLIP_SOURCES = new Set(['paper', 'purpur', 'folia']);

// 方法体只依赖 this，用桩 manager 提供：instDir/emitConsole/ensureVersions + 去重所需状态
function makeManager(lines) {
  const mgr = {
    bootstrapJobs: new Map(),
    bootstrapSeq: 0,
    instDir: (name) => path.join(TMP, name),
    emitConsole: (rec, text) => lines.push(text),
    ensureVersions: async () => ({ versions: [{ id: '1.21.1', url: 'VJSON' }] }),
  };
  const obj = new Function(
    'fetchJson', 'downloadToFile', 'verifyHash', 'withMirror', 'mirrorHostOf', 'PAPERCLIP_SOURCES', 'fs', 'path', 'process',
    // 每个提取片段都缺方法自身的收尾 `}`（切片到 "\n  }," 为止），这里补齐方法括号与对象括号
    'return {' + ensureSrc + '},\n' + doSrc + '}}',
  )(fakeFetchJson, fakeDownloadToFile, fakeVerifyHash, fakeWithMirror, fakeMirrorHostOf, PAPERCLIP_SOURCES, fs, path, process);
  Object.assign(mgr, obj);
  return mgr;
}
const makeRec = () => ({ meta: { name: 'test', source: 'paper', version: '1.21.1' } });
const targetOf = () => path.join(TMP, 'test', 'cache', 'mojang_1.21.1.jar');
const sidecarOf = () => targetOf() + '.sha1';
const place = (bytes, sha1) => {
  fs.mkdirSync(path.dirname(targetOf()), { recursive: true });
  fs.writeFileSync(targetOf(), bytes);
  if (sha1 !== undefined) fs.writeFileSync(sidecarOf(), sha1);
};
const reset = () => {
  fs.rmSync(path.join(TMP, 'test'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP, 'test2'), { recursive: true, force: true });
  files = {};
  versionJson = null;
  withMirrorMap = {};
  downloadDelayMs = 0;
  downloads = [];
};

let pass = 0, total = 0;
// want = { lines: 应出现的控制台片段[], placed: 目标是否应为 JAR_BYTES, mirror: 是否应走镜像 }
async function case_(desc, want, check, setup) {
  total++;
  reset();
  const lines = [];
  const mgr = makeManager(lines);
  const rec = makeRec();
  setup && setup(rec);
  await mgr.ensureBootstrapVanilla(rec);
  const placed = fs.existsSync(targetOf()) && fs.readFileSync(targetOf()).equals(JAR_BYTES);
  const cacheDir = path.dirname(targetOf());
  const tmpLeft = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.tmp')) : [];
  const sha1Sidecar = fs.existsSync(sidecarOf()) ? fs.readFileSync(sidecarOf(), 'utf8') : null;
  const ok =
    lines.length === (want.lines || []).length &&
    (want.lines || []).every((l, i) => (lines[i] || '').includes(l)) &&
    placed === !!want.placed &&
    tmpLeft.length === 0 &&
    (want.sha1 === undefined || sha1Sidecar === want.sha1) &&
    (!check || check({ mgr, rec, downloads, placed, sha1Sidecar }));
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}\n       lines: ${JSON.stringify(lines)}`);
  if (!ok && want.debug) console.log('       state:', JSON.stringify({ placed, tmpLeft, sha1Sidecar, downloads }));
}

(async () => {
  await case_('已就位（无旁证，paperclip 自己下的）→ 跳过', { lines: [], placed: true }, ({ downloads }) => downloads.length === 0, () => {
    place(JAR_BYTES);
  });
  await case_('已就位且旁证吻合 → 跳过（不重新校验下载）', { lines: [], placed: true }, ({ downloads }) => downloads.length === 0, () => {
    place(JAR_BYTES, GOOD_SHA1);
  });
  await case_(
    '旁证不符 → 自愈重下',
    { lines: ['缓存的原版核心校验不符，重新下载', '正在预下载', '原版核心已就位'], placed: true, sha1: GOOD_SHA1 },
    ({ downloads }) => downloads.length === 1,
    () => {
      place(OTHER_BYTES, BAD_SHA1); // 文件被写坏/污染，但旁证记录了原始哈希
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': JAR_BYTES };
    },
  );
  await case_(
    '官方源成功 → 预置 + 校验 sha1 + 写旁证',
    { lines: ['正在预下载', '原版核心已就位'], placed: true, sha1: GOOD_SHA1 },
    ({ downloads }) => downloads.length === 1,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': JAR_BYTES };
    },
  );
  await case_(
    '官方源失败 → 走镜像成功',
    { lines: ['正在预下载', '改用镜像源重试', '原版核心已就位'], placed: true, sha1: GOOD_SHA1 },
    ({ downloads }) => downloads.length === 2,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://mirror.test/server.jar': JAR_BYTES };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    },
  );
  await case_(
    '官方源 content 不对（sha1 不符）→ 换镜像源重试成功',
    { lines: ['正在预下载', '改用镜像源重试', '原版核心已就位'], placed: true, sha1: GOOD_SHA1 },
    ({ downloads }) => downloads.length === 2,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      // 官方源返回了错误内容（CDN 缓存损坏），镜像源内容正确
      files = { 'http://official.test/server.jar': OTHER_BYTES, 'http://mirror.test/server.jar': JAR_BYTES };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    },
  );
  await case_(
    '双源都失败 → 告警且不阻断（无残留 tmp）',
    { lines: ['正在预下载', '改用镜像源重试', '原版核心预下载失败'], placed: false },
    ({ downloads }) => downloads.length === 2,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': 'FAIL' };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    },
  );
  await case_(
    '双源内容都不对 → 告警（无残留 tmp、不落旁证）',
    { lines: ['正在预下载', '改用镜像源重试', '原版核心预下载失败'], placed: false, sha1: null },
    ({ downloads }) => downloads.length === 2,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': OTHER_BYTES, 'http://mirror.test/server.jar': OTHER_BYTES };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    },
  );
  await case_(
    '清单缺下载地址 → 告警',
    { lines: ['正在预下载', '原版核心预下载失败'], placed: false },
    null,
    () => {
      versionJson = { downloads: {} };
    },
  );
  // 并发去重：两次调用只应下载一次，且都拿到同一个结果
  await case_(
    '并发两次调用 → 只下载一次（单飞去重）',
    { lines: ['正在预下载', '原版核心已就位'], placed: true, sha1: GOOD_SHA1 },
    ({ downloads, mgr }) => downloads.length === 1 && mgr.bootstrapJobs.size === 0,
    () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': JAR_BYTES };
      downloadDelayMs = 60; // 让第一次下载仍在途时发起第二次调用
    },
  );

  // 上面这个 case 的并发断言需要真的并行调用，单独再跑一遍（case_ 是串行的）
  total++;
  {
    reset();
    const lines = [];
    const mgr = makeManager(lines);
    const rec = makeRec();
    versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
    files = { 'http://official.test/server.jar': JAR_BYTES };
    downloadDelayMs = 60;
    const [a, b] = await Promise.all([mgr.ensureBootstrapVanilla(rec), mgr.ensureBootstrapVanilla(rec)]);
    const placed = fs.existsSync(targetOf()) && fs.readFileSync(targetOf()).equals(JAR_BYTES);
    const ok =
      downloads.length === 1 &&
      placed &&
      lines.filter((l) => l.includes('正在预下载')).length === 1 &&
      mgr.bootstrapJobs.size === 0;
    if (ok) pass++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'} | 真并发（Promise.all）→ 一次下载、一条预下载日志\n` +
        `       downloads: ${downloads.length}, lines: ${JSON.stringify(lines)}`,
    );
  }

  // 失败后不残留去重项：下一次调用应能重新尝试
  total++;
  {
    reset();
    const lines = [];
    const mgr = makeManager(lines);
    const rec = makeRec();
    versionJson = { downloads: {} }; // 没有下载地址 → 失败
    await mgr.ensureBootstrapVanilla(rec);
    const cleared = mgr.bootstrapJobs.size === 0;
    // 修好清单后重试应成功
    versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
    files = { 'http://official.test/server.jar': JAR_BYTES };
    await mgr.ensureBootstrapVanilla(rec);
    const placed = fs.existsSync(targetOf()) && fs.readFileSync(targetOf()).equals(JAR_BYTES);
    const ok = cleared && placed;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'} | 失败后去重项清理，重试可成功`);
  }

  console.log(`\n${pass}/${total} bootstrap-vanilla cases passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
})();
