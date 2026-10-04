// fs.copy/move/compress/extract 验证：从 agent.js 提取方法体，在临时目录里用真实文件系统
// 与系统 tar 走完整流程（复制/移动/守卫/压缩/解压/路径越界）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');

// 从类源码提取方法（与 trackPlayers 测试同一套路：body 不含收尾 `}`，eval 时补齐）
// 用 AsyncFunction 构造（compressPaths/extractArchive 方法体里有 await），调用返回 Promise，需 await
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function extractMethod(name) {
  let ms = src.indexOf(`${name}(`);
  if (ms < 0) throw new Error('未找到 ' + name);
  if (src.slice(ms - 6, ms) === 'async ') ms -= 6; // 连 async 前缀一起带上
  const body = src.slice(ms, src.indexOf('\n  }', ms));
  if (body.length < 40) throw new Error(name + ' 提取内容异常');
  return await AsyncFunction('fs', 'path', 'runCmd', 'tarCmd', 'return {' + body + '}}')(fs, path, runCmd, tarCmd);
}

// runCmd 也从源码提取（模块级函数）——保证测试跑的就是实现本身
const rc = src.indexOf('function runCmd(cmd, args, timeoutMs = 300000) {');
if (rc < 0) throw new Error('未找到 runCmd');
const runCmd = new Function('spawn', 'return ' + src.slice(rc, src.indexOf('\n}', rc) + 2) + ';')(spawn);

// tarCmd 同样从源码提取（Windows 锁定 System32 bsdtar 的实现）
// tarCmdCache 是模块级缓存变量，测试作用域里以参数注入（每次调用重新解析，无缓存语义影响）
const tc = src.indexOf('function tarCmd() {');
if (tc < 0) throw new Error('未找到 tarCmd');
const tarCmd = new Function('path', 'process', 'fs', 'tarCmdCache', 'return ' + src.slice(tc, src.indexOf('\n}', tc) + 2) + ';')(path, process, fs, null);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-fsops-'));

let pass = 0, total = 0;
function expect(desc, fn, wantErr) {
  total++;
  let err = null;
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') throw new Error('需用 awaitExpect 处理 Promise');
  } catch (e) {
    err = e;
  }
  const ok = wantErr ? err && err.message.includes(wantErr) : !err;
  if (ok) pass++;
  else console.log(`  !! ${err ? err.message : '期望失败但成功'}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
}
async function expectAsync(desc, fn, wantErr) {
  total++;
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  const ok = wantErr ? err && err.message.includes(wantErr) : !err;
  if (ok) pass++;
  else console.log(`  !! ${err ? err.message : '期望失败但成功'}`);
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
}

// 布景：world/a.txt + world/sub/b.txt + outside.txt
fs.mkdirSync(path.join(ROOT, 'world', 'sub'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'world', 'a.txt'), 'hello-a');
fs.writeFileSync(path.join(ROOT, 'world', 'sub', 'b.txt'), 'hello-b');
fs.writeFileSync(path.join(ROOT, 'outside.txt'), 'secret');

(async () => {
  const mgr = {
    instanceRoot: () => ROOT,
    ...(await extractMethod('resolveSafe')),
    ...(await extractMethod('isWithinPath')),
    ...(await extractMethod('copyRecursive')),
    ...(await extractMethod('copyMovePath')),
    ...(await extractMethod('compressPaths')),
    ...(await extractMethod('extractArchive')),
  };

  // 复制
  await expectAsync('复制文件', () => mgr.copyMovePath('inst', 'world/a.txt', 'a-copy.txt', false));
  await expectAsync('复制目录（递归）', () => mgr.copyMovePath('inst', 'world', 'world-copy', false));
  if (fs.readFileSync(path.join(ROOT, 'world-copy', 'sub', 'b.txt'), 'utf8') !== 'hello-b') throw new Error('递归复制内容不符');
  console.log('PASS | 递归复制内容一致');
  total++; pass++;
  await expectAsync('复制到已存在目标 → 拒绝', () => mgr.copyMovePath('inst', 'world/a.txt', 'a-copy.txt', false), '目标已存在');
  await expectAsync('复制进自己的子树 → 拒绝', () => mgr.copyMovePath('inst', 'world', 'world/inner', false), '内部');
  await expectAsync('复制实例根目录 → 拒绝', () => mgr.copyMovePath('inst', '.', 'x', false), '实例根目录');
  await expectAsync('路径越界 → 拒绝', () => mgr.copyMovePath('inst', '../outside.txt', 'stolen.txt', false), '越界');

  // 移动 = 重命名
  await expectAsync('移动（重命名）', () => mgr.copyMovePath('inst', 'world-copy', 'world-renamed', true));
  if (!fs.existsSync(path.join(ROOT, 'world-renamed', 'a.txt')) || fs.existsSync(path.join(ROOT, 'world-copy')))
    throw new Error('移动结果不符');
  console.log('PASS | 移动后源消失、目标在位');
  total++; pass++;
  await expectAsync('移动到相同路径 → 拒绝', () => mgr.copyMovePath('inst', 'world', 'world', true), '相同');

  // 压缩 → 解压（真实 tar）
  await expectAsync('压缩目录为 tar.gz', () => mgr.compressPaths('inst', ['world'], 'backup.tar.gz'));
  if (!fs.existsSync(path.join(ROOT, 'backup.tar.gz'))) throw new Error('压缩包不存在');
  console.log('PASS | 压缩包已生成');
  total++; pass++;
  await expectAsync('压缩输出到被压缩目录内部 → 拒绝', () => mgr.compressPaths('inst', ['world'], 'world/x.tar.gz'), '内部');
  await expectAsync('压缩同名覆盖 → 拒绝', () => mgr.compressPaths('inst', ['world'], 'backup.tar.gz'), '已存在');
  await expectAsync('压缩非 tar.gz 后缀 → 拒绝', () => mgr.compressPaths('inst', ['world'], 'x.zip'), 'tar.gz');

  // 把原 world 移走再解压，验证包内容完整
  await mgr.copyMovePath('inst', 'world', 'world-bak', true);
  await expectAsync('解压 tar.gz 到所在目录', () => mgr.extractArchive('inst', 'backup.tar.gz'));
  if (fs.readFileSync(path.join(ROOT, 'world', 'a.txt'), 'utf8') !== 'hello-a' || fs.readFileSync(path.join(ROOT, 'world', 'sub', 'b.txt'), 'utf8') !== 'hello-b')
    throw new Error('解压内容不符');
  console.log('PASS | 解压内容完整（含子目录）');
  total++; pass++;

  // zip 解压（Windows bsdtar 直接支持；Linux 上创建 zip 不通用，仅 Windows 跑）
  if (process.platform === 'win32') {
    // 注意：这里必须走 tarCmd()（System32 bsdtar）——PATH 上的 GNU tar 会把 C:\ 当远程主机
    await runCmd(tarCmd(), ['-a', '-cf', path.join(ROOT, 'pack.zip'), '-C', ROOT, 'world-bak']);
    await expectAsync('解压 zip', () => mgr.extractArchive('inst', 'pack.zip'));
    if (fs.readFileSync(path.join(ROOT, 'world-bak', 'a.txt'), 'utf8') !== 'hello-a') throw new Error('zip 解压内容不符');
    console.log('PASS | zip 解压内容一致');
    total++; pass++;
    await expectAsync('解压不支持的格式 → 拒绝', () => mgr.extractArchive('inst', 'world/a.txt'), '仅支持');
  }

  console.log(`\n${pass}/${total} fs-ops cases passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
