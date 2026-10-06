'use strict';
// BlockNexus Agent 打包器 —— 把 agent/src/** 拼成单文件 agent/agent.js。
//
// 为什么是「源码分模块 + 打包成单文件」：Agent 的部署链路（SSH 只上传一个文件、
// systemd ExecStart 指向 agent.js、热更新换单文件、面板 /agent.js 匿名下载、
// 手动 curl -o agent.js 安装）全部假设交付物是一个文件。所以源码按功能组拆开便于维护，
// 交付物仍是**单文件**——第三方依赖会被**内联进产物**，而不是要求在目标机 npm install。
//
//   node agent/build.js           # 生成 agent/agent.js
//   node agent/build.js --check   # 只校验产物是否与源码同步（CI/测试用，退出码 1 表示过期）
//
// 打包方式：每个模块包成 function (module, exports, __require, __dirname, __filename)，
// 用模块注册表 + 缓存加载；模块内的相对 require 由本脚本静态改写为注册表 id，
// Node 标准库 require 原样透传，**npm 包则递归内联**（见 resolveNpm）。
//
// ⚠ 重要限制（选库前必读）：
//   这是针对「纯 CJS、纯 JS」包设计的轻量打包器，**不是**通用 bundler。不支持：
//     · ESM（`import` / `export`）——只能内联 CJS（或带 `require` 条件的双格式包）
//     · 原生扩展（.node）、动态 require（变量拼接路径）、`import.meta`
//     · 需要构建产物之外资源的包（非 JS 文件不会被内联）
//   因此新增依赖前，**必须确认它能被内联并通过 agent/test-bundle-fresh.js 与冒烟测试**。
//
// 模块内的 __dirname/__filename 指向**产物所在目录**（与拆分前的单文件语义一致），
// 这样 Agent 读写同目录的 agent.json 等文件的行为不变。

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname);
const REPO_ROOT = path.join(ROOT, '..');
const SRC_DIR = path.join(ROOT, 'src');
const ENTRY = 'src/entry.js';
const OUT = path.join(ROOT, 'agent.js');

/** Node 标准库集合（含 'node:' 前缀的写法），这些 require 原样透传 */
const BUILTINS = new Set([
  ...Module.builtinModules,
  ...Module.builtinModules.map((m) => 'node:' + m),
]);

/** npm 模块的 id 前缀，避免与 src/** 的 id 冲突 */
const NPM_PREFIX = 'npm:';

function isBuiltin(name) {
  return BUILTINS.has(name);
}

/** 相对 id -> 规范化模块 id（始终用 / 分隔，相对 repo 的 agent/ 目录） */
function normId(fromId, rel) {
  const dir = path.posix.dirname(fromId);
  let p = path.posix.normalize(path.posix.join(dir, rel));
  if (!p.endsWith('.js')) p += '.js';
  return p;
}

/** 把绝对路径转成 npm 模块 id（相对最近的 node_modules 所在包根） */
function toNpmId(absFile, pkgRoot) {
  const rel = path.relative(pkgRoot, absFile).split(path.sep).join('/');
  const pkgName = path.basename(pkgRoot);
  // 支持 scoped 包（@scope/name）
  const parent = path.dirname(pkgRoot);
  const scope = path.basename(parent);
  const full = scope.startsWith('@') ? `${scope}/${pkgName}` : pkgName;
  return `${NPM_PREFIX}${full}/${rel}`;
}

/**
 * 解析一个 npm 裸模块名到实际入口文件（Node 的解析规则子集）。
 * 支持：普通包、scoped 包、子路径（pkg/sub）、exports 映射里的 require 条件、main 字段。
 * @param {string} request 裸模块名，如 'node-cron' 或 'lodash/get'
 * @param {string} fromDir 从哪个目录开始向上找 node_modules
 * @returns {{ file: string, pkgRoot: string } | null}
 */
function resolveNpm(request, fromDir) {
  const parts = request.split('/');
  const pkgName = request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subPath = request.slice(pkgName.length).replace(/^\//, '');

  // 向上逐级找 node_modules
  let dir = fromDir;
  for (;;) {
    const pkgRoot = path.join(dir, 'node_modules', pkgName);
    if (fs.existsSync(path.join(pkgRoot, 'package.json'))) {
      const file = resolvePackageEntry(pkgRoot, subPath);
      if (file) return { file, pkgRoot };
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 把 exports 字段里的一项「降级」成文件路径字符串。
 * 需要**递归**：常见的嵌套条件是
 *   exports['.'].require = { types: '…d.cts', default: '…cjs' }
 * 直接对 require 取字符串会拿到一个对象，必须继续往里取 default。
 * 优先级：require（我们要 CJS）→ default → node。
 */
function pickExportPath(value, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  for (const key of ['require', 'default', 'node']) {
    if (key in value) {
      const hit = pickExportPath(value[key], depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 在包内解析入口文件：支持 exports 的 require 条件（可嵌套）、main、以及子路径直取 */
function resolvePackageEntry(pkgRoot, subPath) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }

  const tryFile = (p) => {
    if (typeof p !== 'string' || !p) return null;
    const abs = path.join(pkgRoot, p);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    // 目录 / 无扩展名时补 .js 与 /index.js
    for (const cand of [abs + '.js', path.join(abs, 'index.js')]) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
  };

  if (subPath) {
    // 子路径：优先看 exports（可能是嵌套条件），再直取文件
    const ex = pkg.exports;
    if (ex && typeof ex === 'object') {
      const hit = pickExportPath(ex['./' + subPath]);
      const f = tryFile(hit);
      if (f) return f;
    }
    return tryFile(subPath) || tryFile(subPath + '.js');
  }

  // 包根：exports['.']（可嵌套）→ main → index.js
  if (pkg.exports) {
    const root = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.'] ?? pkg.exports;
    const f = tryFile(pickExportPath(root));
    if (f) return f;
  }
  if (pkg.main) {
    const f = tryFile(pkg.main);
    if (f) return f;
  }
  return tryFile('index.js');
}

/** 收集入口可达的全部模块（深度优先，按引用顺序稳定输出），含递归内联的 npm 包 */
function collectModules() {
  // id -> { id, file, source, requires: Map(requestKey -> targetId), kind }
  const modules = new Map();
  const localRequires = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

  const visit = (id, file, kind, pkgRoot) => {
    if (modules.has(id)) return;
    if (!fs.existsSync(file)) throw new Error('模块不存在: ' + file);
    const source = fs.readFileSync(file, 'utf8');
    const requires = new Map();
    modules.set(id, { id, file, source, requires, kind, pkgRoot });

    for (const m of source.matchAll(localRequires)) {
      const req = m[2];
      // 1) Node 标准库：原样透传，不打包
      if (isBuiltin(req)) continue;

      // 2) 相对路径：同一命名空间内解析
      if (req.startsWith('.')) {
        if (kind === 'src') {
          const target = normId(id, req);
          requires.set(req, target);
          visit(target, path.join(ROOT, target), 'src', null);
        } else {
          const abs = path.resolve(path.dirname(file), req);
          const hit = fspick(abs);
          if (!hit) throw new Error(`${id} 中无法解析的相对依赖: ${req}`);
          const target = toNpmId(hit, pkgRoot);
          requires.set(req, target);
          visit(target, hit, 'npm', pkgRoot);
        }
        continue;
      }

      // 3) 裸模块名：从「当前文件所在目录」向上找 node_modules
      const resolved = resolveNpm(req, path.dirname(file));
      if (!resolved) {
        throw new Error(
          `${id} 中的依赖 "${req}" 无法内联：未找到该包，或它不是纯 CJS 包。\n` +
          '  提示：agent/build.js 只支持纯 CJS 且无原生扩展/无动态 require 的包。',
        );
      }
      const target = toNpmId(resolved.file, resolved.pkgRoot);
      requires.set(req, target);
      visit(target, resolved.file, 'npm', resolved.pkgRoot);
    }
  };

  /** 补全无扩展名 / 目录形式的相对路径 */
  function fspick(abs) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    for (const cand of [abs + '.js', path.join(abs, 'index.js'), abs + '.json']) {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
  }

  visit(ENTRY, path.join(ROOT, ENTRY), 'src', null);
  return modules;
}

/** 把模块源码里的 require 替换成注册表调用（标准库不动；相对依赖与裸依赖都走注册表） */
function rewriteRequires(mod) {
  return mod.source.replace(
    /require\(\s*(['"])([^'"]+)\1\s*\)/g,
    (all, q, req) => {
      if (isBuiltin(req)) return all; // 标准库原样保留
      const id = mod.requires.get(req);
      if (!id) throw new Error(`${mod.id} 中未解析的 require: ${req}`);
      return `__require(${JSON.stringify(id)})`;
    },
  );
}

/** 产物里出现 ESM 语法时给出明确报错，而不是让 agent.js 在运行期崩 */
function assertCjs(mod) {
  // 只看行首的 import/export，避免误伤字符串或注释里的内容
  const bad = /^\s*(?:import\s[\s\S]*?from\s|import\s*\(|export\s+(?:default|const|function|class|\{))/m.exec(mod.source);
  if (bad) {
    throw new Error(
      `模块 ${mod.id} 使用了 ESM 语法（${bad[0].trim().slice(0, 40)}…），本打包器只支持 CJS。\n` +
      '  提示：请选择提供 CJS 构建（package.json 的 require 条件或 main 指向 .cjs/.js）的包。',
    );
  }
}

function build() {
  const modules = collectModules();
  for (const mod of modules.values()) {
    if (mod.kind === 'npm') assertCjs(mod);
  }

  const out = [];
  out.push('#!/usr/bin/env node');
  out.push("'use strict';");
  out.push('// BlockNexus Agent —— 单文件，由面板通过 SSH 安装到远程服务器。');
  out.push('//');
  out.push('//   node agent.js --panel ws://面板地址:3080 --token <服务器token> --id <服务器ID>');
  out.push('//   （也可省略参数，读取同目录 agent.json，字段: panel/token/id）');
  out.push('//');
  out.push('// 职责：主动回连面板（WebSocket）→ token 挑战握手 → AES-256-GCM 加密通道 →');
  out.push('//       执行面板下发的 MC 实例操作（创建/下载/启动/停止/控制台/删除）。');
  out.push('//');
  out.push('// 依赖说明：第三方依赖已**内联**在本文件中，目标机无需 npm install；');
  out.push('//          运行时只 require Node 标准库。');
  out.push('//');
  out.push('// ⚠ 本文件由 agent/build.js 从 agent/src/** 生成，请勿直接编辑：');
  out.push('//   改源码后运行 `npm run build:agent` 重新打包。');
  out.push('');
  out.push('// ============================ 模块注册表 ============================');
  out.push('');
  out.push('const __modules = {};');
  out.push('const __cache = {};');
  out.push('');
  out.push('// 加载已打包模块：相对/裸 require 已被 build.js 改写为 __require(<模块 id>)');
  out.push('function __require(id) {');
  out.push('  const cached = __cache[id];');
  out.push('  if (cached) return cached.exports;');
  out.push('  const factory = __modules[id];');
  out.push("  if (!factory) throw new Error('未打包的模块: ' + id);");
  out.push('  const mod = { exports: {} };');
  out.push('  __cache[id] = mod;');
  // 与原单文件语义一致：模块内的 __dirname/__filename 指向产物所在目录
  out.push('  factory(mod, mod.exports, __require, __dirname, __filename);');
  out.push('  return mod.exports;');
  out.push('}');
  out.push('');
  for (const mod of modules.values()) {
    const body = rewriteRequires(mod)
      .replace(/^#![^\n]*\n/, '') // 模块自带 shebang 时去掉（产物只保留一个）
      .replace(/\s*$/, '');
    out.push(`// ---------------------------- ${mod.id} ----------------------------`);
    out.push(`__modules[${JSON.stringify(mod.id)}] = function (module, exports, __require, __dirname, __filename) {`);
    out.push(body);
    out.push('};');
    out.push('');
  }
  out.push('// ============================ 启动 ============================');
  out.push('');
  out.push(`__require(${JSON.stringify(ENTRY)});`);
  out.push('');
  return { text: out.join('\n'), modules };
}

function main() {
  const check = process.argv.includes('--check');
  const { text, modules } = build();
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const same = current === text;
  const npmCount = [...modules.values()].filter((m) => m.kind === 'npm').length;
  const summary = `${modules.size} 个模块（含内联 npm ${npmCount} 个），${text.split('\n').length} 行`;
  if (check) {
    if (same) {
      console.log(`agent.js 与源码同步（${summary}）`);
      return 0;
    }
    console.error('agent.js 与 agent/src 不同步：请运行 `npm run build:agent` 重新生成');
    return 1;
  }
  if (same) {
    console.log(`agent.js 已是最新（${summary}）`);
    return 0;
  }
  fs.writeFileSync(OUT, text);
  console.log(`已生成 agent/agent.js：${summary}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { build, collectModules, normId, resolveNpm, isBuiltin, NPM_PREFIX };
