// fs.copy/move/compress/extract 验证：从 agent/src 提取方法体，在临时目录里用真实文件系统
// 与系统 tar 走完整流程（复制/移动/守卫/压缩/解压/路径越界）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 文件管理方法在 instance/fs.js，runCmd/tarCmd 在 util.js（拆分后的源码布局）
const src = fs.readFileSync(path.join(__dirname, 'src', 'instance', 'fs.js'), 'utf8');
const utilSrc = fs.readFileSync(path.join(__dirname, 'src', 'util.js'), 'utf8');

// 从模块源码提取方法定义（对象字面量成员：2 空格缩进 + 签名，收尾为 "\n  },"）；
// 只能按「行首缩进的定义」匹配，否则会命中调用点
/**
 * 从源码里取模块级常量的**值**（不是复制一份字面量）——
 * 否则改了源码上限、测试还在用旧值，就会得出「测试通过」的假结论。
 */
function srcConst(name) {
  const m = new RegExp(`^const ${name} = (.+?);$`, 'm').exec(src);
  if (!m) throw new Error('未找到常量 ' + name);
  return new Function('return ' + m[1])();
}
const MAX_EXTRACT_BYTES = srcConst('MAX_EXTRACT_BYTES');
const MAX_EXTRACT_ENTRIES = srcConst('MAX_EXTRACT_ENTRIES');
const MAX_UPLOAD_BYTES = srcConst('MAX_UPLOAD_BYTES');

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
async function extractMethod(name) {
  const m = new RegExp(`^  (?:async )?${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('未找到 ' + name);
  const body = src.slice(m.index, src.indexOf('\n  },', m.index));
  if (body.length < 40) throw new Error(name + ' 提取内容异常');
  return await AsyncFunction(
    'fs',
    'path',
    'runCmd',
    'tarCmd',
    'MAX_EXTRACT_BYTES',
    'MAX_EXTRACT_ENTRIES',
    'MAX_UPLOAD_BYTES',
    'return {' + body + '}}',
  )(fs, path, runCmd, tarCmd, MAX_EXTRACT_BYTES, MAX_EXTRACT_ENTRIES, MAX_UPLOAD_BYTES);
}

// runCmd 也从源码提取（模块级函数）——保证测试跑的就是实现本身
const rc = utilSrc.indexOf('function runCmd(cmd, args, timeoutMs = 300000) {');
if (rc < 0) throw new Error('未找到 runCmd');
const runCmd = new Function('spawn', 'return ' + utilSrc.slice(rc, utilSrc.indexOf('\n}', rc) + 2) + ';')(spawn);

// tarCmd 同样从源码提取（Windows 锁定 System32 bsdtar 的实现）
// tarCmdCache 是模块级缓存变量，测试作用域里以参数注入（每次调用重新解析，无缓存语义影响）
const tc = utilSrc.indexOf('function tarCmd() {');
if (tc < 0) throw new Error('未找到 tarCmd');
const tarCmd = new Function('path', 'process', 'fs', 'tarCmdCache', 'return ' + utilSrc.slice(tc, utilSrc.indexOf('\n}', tc) + 2) + ';')(path, process, fs, null);

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
    ...(await extractMethod('findUnsafeExtractedEntries')),
    ...(await extractMethod('mergeTreeInto')),
    ...(await extractMethod('uploadChunk')),
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

  // ---------- H1：tar 参数注入（文件名以 - 开头不得变成 tar 的选项）----------
  // runCmd 用 spawn 传参数组、不过 shell，所以这不是 shell 注入而是**参数注入**：
  // 一个名为 --checkpoint-action=exec=<命令> 的文件会被 tar 当成选项 → Agent 以 root 运行
  // → 任意命令执行。修法是 `--` 终止选项解析；下面用「该名字确实作为文件进了包」来验证。
  {
    const evil = '--checkpoint-action=exec=echo pwned';
    fs.writeFileSync(path.join(ROOT, evil), 'payload');
    await expectAsync('压缩以 -- 开头的文件名（参数注入防护）', () =>
      mgr.compressPaths('inst', [evil], 'inject.tar.gz'),
    );
    const listed = await new Promise((resolve, reject) => {
      const c = spawn(tarCmd(), ['-tzf', path.join(ROOT, 'inject.tar.gz')]);
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('tar -tzf 退出码 ' + code))));
    });
    if (!listed.split('\n').some((l) => l.trim() === evil)) {
      throw new Error('该文件名没有作为**文件**进包，说明它被 tar 当成选项吃掉了：' + JSON.stringify(listed));
    }
    console.log('PASS | `--` 生效：以 - 开头的文件名作为普通文件进包');
    total++;
    pass++;
  }

  // ---------- H2：解压逃逸软链 ----------
  // resolveSafe/isWithinPath 只做文本校验，挡不住软链；压缩包是用户上传的不可信输入。
  {
    const q = path.join(ROOT, 'quarantine-test');
    fs.mkdirSync(path.join(q, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(q, 'inner', 'ok.txt'), 'fine');

    // 干净树：不应误报
    const clean = mgr.findUnsafeExtractedEntries(ROOT, q);
    if (clean.length !== 0) throw new Error('干净树被误报：' + JSON.stringify(clean));
    console.log('PASS | 无软链的解压结果不误报');
    total++;
    pass++;

    // 逃逸软链：必须被识别（Windows 上普通文件软链需特权，用 junction 目录软链；
    // Node 对 junction 同样返回 isSymbolicLink()=true，readlink 给出绝对目标）
    let linked = false;
    try {
      fs.symlinkSync(os.tmpdir(), path.join(q, 'escape'), 'junction');
      linked = true;
    } catch (e) {
      console.log(`SKIP | 无法创建软链（${e.code}），跳过逃逸检测用例`);
    }
    if (linked) {
      const bad = mgr.findUnsafeExtractedEntries(ROOT, q);
      if (bad.length !== 1 || bad[0].kind !== 'symlink' || bad[0].rel !== path.join('quarantine-test', 'escape')) {
        throw new Error('逃逸软链未被正确识别：' + JSON.stringify(bad));
      }
      console.log('PASS | 指向实例目录之外的软链被识别（解压会被拒绝）');
      total++;
      pass++;
    }
  }

  // ---------- 压缩炸弹：解压后总量超限必须被拒 ----------
  // 用**稀疏文件**造出超大逻辑体积：truncate 只改 size 元数据、不实际写盘，
  // 所以能在毫秒级测出 2GB 以上的判定，不会真的占用磁盘。
  {
    const bomb = path.join(ROOT, 'bomb-tree');
    fs.mkdirSync(bomb, { recursive: true });
    const big = path.join(bomb, 'huge.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, MAX_EXTRACT_BYTES + 1024 * 1024);

    const bad = mgr.findUnsafeExtractedEntries(ROOT, bomb);
    if (!bad.some((b) => b.kind === 'too-large')) {
      throw new Error('解压后超量未被识别：' + JSON.stringify(bad));
    }
    console.log('PASS | 解压后总量超限被识别（压缩炸弹防护）');
    total++;
    pass++;
    fs.rmSync(bomb, { recursive: true, force: true });
  }

  // ---------- 上传上限必须按**真实累计字节**判定 ----------
  // 自报 size 可以不带或造假，所以真正的关口在 uploadChunk。
  {
    const tmp = path.join(ROOT, 'up.tmp');
    fs.writeFileSync(tmp, Buffer.alloc(0));
    const sid = 'probe-upload';
    mgr.uploads = new Map([
      [sid, { tmpPath: tmp, metaPath: tmp + '.meta', finalPath: path.join(ROOT, 'up.bin'), received: MAX_UPLOAD_BYTES - 10, seq: 0, at: Date.now() }],
    ]);

    let threw = null;
    try {
      // 10 字节刚好到顶（允许），再来 100 字节就该被拒
      mgr.uploadChunk(sid, 1, Buffer.alloc(10).toString('base64'));
      mgr.uploadChunk(sid, 2, Buffer.alloc(100).toString('base64'));
    } catch (e) {
      threw = e;
    }
    if (!threw || !/200MB/.test(threw.message)) {
      throw new Error('超出真实字节上限未被拒绝：' + (threw && threw.message));
    }
    if (mgr.uploads.get(sid).received !== MAX_UPLOAD_BYTES) {
      throw new Error('超限的分块仍被写入了：received=' + mgr.uploads.get(sid).received);
    }
    console.log('PASS | 上传按真实累计字节判定，超限被拒且未写入');
    total++;
    pass++;
  }

  console.log(`\n${pass}/${total} fs-ops cases passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
