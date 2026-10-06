'use strict';
// npm 包内联能力测试（零依赖测试框架）
//
// 为什么需要它：Agent 的部署链路要求「一个文件即全部」，所以第三方依赖必须被
// agent/build.js **内联进产物**。这套解析逻辑（exports 嵌套条件、子路径、scoped 包）
// 很容易在重构中被破坏，而一旦坏掉，症状是**目标机上运行时报 Cannot find module**
// ——本地 build 却完全不报错。因此这里做成常驻回归测试。
//
// 运行：node agent/test-npm-inline.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const ENTRY = path.join(SRC, 'entry.js');
const build = require(path.join(ROOT, 'build.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${detail && !ok ? '\n       ' + detail : ''}`);
}

// ---------- 1. resolveNpm：真实包的入口解析 ----------
{
  const r = build.resolveNpm('node-cron', SRC);
  check(
    'resolveNpm 能找到 node-cron',
    !!r && fs.existsSync(r.file),
    r ? `解析结果不存在: ${r.file}` : '返回 null',
  );
  check(
    'resolveNpm 优先取 CJS 入口（package.json 的 require 条件，且能穿透嵌套的 {types,default}）',
    !!r && r.file.endsWith('.cjs'),
    r ? `实际解析到 ${path.basename(r.file)}（期望 .cjs）` : '',
  );
  check(
    'resolveNpm 能找到包内的子路径文件',
    (() => {
      const sub = build.resolveNpm('node-cron/package.json', SRC);
      return !!sub && fs.existsSync(sub.file);
    })(),
  );
  check('resolveNpm 对不存在的包返回 null（不抛异常）', build.resolveNpm('no-such-pkg-xyz', SRC) === null);
  check('isBuiltin 正确识别标准库', build.isBuiltin('fs') && build.isBuiltin('node:path') && !build.isBuiltin('node-cron'));
}

// ---------- 2. 端到端：把 npm 包内联进产物，并在无 node_modules 的目录里运行 ----------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-inline-'));
const entryBackup = fs.readFileSync(ENTRY, 'utf8');
const probeEntry = `
const cron = require('node-cron');
console.log('VALIDATE_OK=' + cron.validate('*/5 * * * *'));
console.log('VALIDATE_BAD=' + cron.validate('definitely not a cron'));
console.log('HAS_SCHEDULE=' + (typeof cron.schedule === 'function'));
`;

try {
  fs.writeFileSync(ENTRY, probeEntry);
  const { text, modules } = build.build();
  const npmModules = [...modules.values()].filter((m) => m.kind === 'npm');

  check('打包结果里确实内联了 npm 模块', npmModules.length > 0, `内联数 = ${npmModules.length}`);
  check(
    '内联模块的 id 带 npm: 前缀（与 src/** 的 id 不会冲突）',
    npmModules.every((m) => m.id.startsWith(build.NPM_PREFIX)),
  );

  // 关键：把产物放到**没有 node_modules** 的目录里跑，证明真的自包含
  const artifact = path.join(sandbox, 'agent.js');
  fs.writeFileSync(artifact, text);
  let out = '';
  let err = null;
  try {
    out = execFileSync(process.execPath, [artifact], {
      encoding: 'utf8',
      cwd: sandbox, // 沙箱目录下没有任何 node_modules
      timeout: 30000,
    });
  } catch (e) {
    err = e;
  }

  check(
    '内联产物在无 node_modules 的目录中成功运行',
    !err,
    err ? `运行失败：${err.message}\n${err.stderr || ''}` : '',
  );
  check('内联后功能正常：合法表达式校验通过', /VALIDATE_OK=true/.test(out), out.trim());
  check('内联后功能正常：非法表达式被拒', /VALIDATE_BAD=false/.test(out), out.trim());
  check('内联后功能正常：导出的 API 可用', /HAS_SCHEDULE=true/.test(out), out.trim());

  // 产物里不应残留对 npm 的裸 require（否则目标机会 Cannot find module）
  check(
    '产物里没有残留的 node-cron 裸 require',
    !/(?<![A-Za-z0-9_$])require\(\s*['"]node-cron['"]\s*\)/.test(text),
  );
} finally {
  fs.writeFileSync(ENTRY, entryBackup); // 无论成败都要还原真实入口
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// 还原是否成功也要断言——测试污染源码比测试失败更糟
check('测试已还原 agent/src/entry.js', fs.readFileSync(ENTRY, 'utf8') === entryBackup);

console.log(`\n${pass}/${total} npm-inline cases passed`);
process.exit(pass === total ? 0 : 1);
