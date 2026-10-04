// ensureBootstrapVanilla 验证：从 agent.js 源码提取方法体，用本地桩函数跑完整个流程
// （存在即跳过 / 官方源成功 / 官方失败走镜像 / 双源失败 / sha1 不符清理临时文件 / 自动建 cache 目录）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
const ms = src.indexOf('async ensureBootstrapVanilla(rec) {');
if (ms < 0) throw new Error('未找到 ensureBootstrapVanilla');
const methodSrc = src.slice(ms, src.indexOf('\n  }', ms)); // 连签名一起提取，作为对象方法
// 源码片段防漂移：镜像回退、sha1 校验、tmp 清理必须在位
for (const frag of ['withMirror', "verifyHash(tmp, dl.sha1, 'sha1')", "rmSync(tmp", 'mkdirSync', 'renameSync']) {
  if (!methodSrc.includes(frag)) throw new Error('ensureBootstrapVanilla 缺少实现细节: ' + frag);
}

// ---- 桩件 ----
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bn-bootstrap-'));
const JAR_BYTES = Buffer.from('fake vanilla jar content ' + 'x'.repeat(1024));
const GOOD_SHA1 = crypto.createHash('sha1').update(JAR_BYTES).digest('hex');
const BAD_SHA1 = '0'.repeat(40);

// 可下载的文件表：url → { bytes } 或 'FAIL'（模拟网络失败）
let files = {};
let versionJson = null; // fetchJson 的返回
let withMirrorMap = {}; // 官方 url → 镜像 url（模拟 withMirror 改写）

const fakeFetchJson = async (url) => {
  if (url === 'VJSON') return versionJson;
  throw new Error('意外请求 ' + url);
};
const fakeDownloadToFile = async (url, dest) => {
  const f = files[url];
  if (!f || f === 'FAIL') throw new Error('connect ECONNREFUSED（模拟）');
  fs.writeFileSync(dest, f);
};
const fakeVerifyHash = (file, expected, algo) => {
  const got = crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
  if (expected && got.toLowerCase() === String(expected).toLowerCase()) return Promise.resolve();
  return Promise.reject(new Error(algo + ' 校验失败'));
};
const fakeWithMirror = (url) => withMirrorMap[url] || url;
const fakeMirrorHostOf = () => 'mirror.test';

const makeManager = (consoleLines, calls) => ({
  instDir: (name) => path.join(TMP, name),
  emitConsole: (rec, text) => consoleLines.push(text),
  ensureVersions: async () => {
    calls.ensureVersions = (calls.ensureVersions || 0) + 1;
    return { versions: [{ id: '1.21.1', url: 'VJSON' }] };
  },
});
// 方法体不依赖 this 以外的闭包，通过参数注入桩件
// （methodSrc 不含方法自身的收尾 `}`，需补齐 方法 + 对象字面量 两层括号）
const obj = new Function(
  'fetchJson', 'downloadToFile', 'verifyHash', 'withMirror', 'mirrorHostOf', 'PAPERCLIP_SOURCES', 'fs', 'path',
  'return {' + methodSrc + '}}',
)(fakeFetchJson, fakeDownloadToFile, fakeVerifyHash, fakeWithMirror, fakeMirrorHostOf, new Set(['paper', 'purpur', 'folia']), fs, path);

let pass = 0, total = 0;
// want = { lines: 应出现的控制台片段[], placed: 目标文件是否应就位 }
async function case_(desc, want, check, setup) {
  total++;
  const lines = [], calls = {};
  const mgr = makeManager(lines, calls);
  const rec = { meta: { name: 'test', source: 'paper', version: '1.21.1' } };
  setup && setup(rec);
  await obj.ensureBootstrapVanilla.call(mgr, rec);
  const target = path.join(TMP, 'test', 'cache', 'mojang_1.21.1.jar');
  const placed = fs.existsSync(target) && fs.readFileSync(target).equals(JAR_BYTES);
  const tmpLeft = fs.existsSync(target + '.tmp');
  const ok =
    lines.length === want.lines.length &&
    lines.every((l, i) => l.includes(want.lines[i])) &&
    placed === !!want.placed &&
    !tmpLeft &&
    (!check || check(calls, rec));
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}\n       lines: ${JSON.stringify(lines)}`);
  fs.rmSync(path.join(TMP, 'test'), { recursive: true, force: true });
}

(async () => {
  await case_('已就位 → 跳过', { lines: [], placed: true }, (calls) => calls.ensureVersions === undefined, () => {
    fs.mkdirSync(path.join(TMP, 'test', 'cache'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'test', 'cache', 'mojang_1.21.1.jar'), JAR_BYTES);
  });
  await case_('官方源成功 → 预置并校验 sha1',
    { lines: ['正在预下载', '原版核心已就位'], placed: true }, null, () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': JAR_BYTES };
    });
  await case_('官方源失败 → 走镜像成功',
    { lines: ['正在预下载', '官方源不可达，改用镜像源下载原版核心', '原版核心已就位'], placed: true }, null, () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://mirror.test/server.jar': JAR_BYTES };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    });
  await case_('双源都失败 → 告警且不阻断（无残留 tmp）',
    { lines: ['正在预下载', '官方源不可达，改用镜像源下载原版核心', '原版核心预下载失败'], placed: false }, null, () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: GOOD_SHA1 } } };
      files = { 'http://official.test/server.jar': 'FAIL' };
      withMirrorMap = { 'http://official.test/server.jar': 'http://mirror.test/server.jar' };
    });
  await case_('sha1 不符 → 视为失败清理临时文件',
    { lines: ['正在预下载', '原版核心预下载失败'], placed: false }, null, () => {
      versionJson = { downloads: { server: { url: 'http://official.test/server.jar', sha1: BAD_SHA1 } } };
      files = { 'http://official.test/server.jar': JAR_BYTES };
    });
  await case_('清单缺下载地址 → 告警',
    { lines: ['正在预下载', '原版核心预下载失败'], placed: false }, null, () => {
      versionJson = { downloads: {} };
    });

  console.log(`\n${pass}/${total} bootstrap-vanilla cases passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
})();
