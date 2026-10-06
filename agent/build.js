'use strict';
// BlockNexus Agent 打包器 —— 把 agent/src/** 拼成单文件 agent/agent.js。
//
// 为什么是「源码分模块 + 打包成单文件」：Agent 的部署链路（SSH 只上传一个文件、
// systemd ExecStart 指向 agent.js、热更新换单文件、面板 /agent.js 匿名下载、
// 手动 curl -o agent.js 安装）全部假设交付物是一个文件。所以源码按功能组拆开便于维护，
// 交付物仍是零依赖单文件（只用 Node 标准库）。
//
//   node agent/build.js           # 生成 agent/agent.js
//   node agent/build.js --check   # 只校验产物是否与源码同步（CI/测试用，退出码 1 表示过期）
//
// 打包方式：每个模块包成 function (module, exports, __require)，用模块注册表 + 缓存加载；
// 模块内的相对 require 由本脚本静态改写为注册表 id，标准库 require 原样透传。
// 模块里的 __dirname/__filename 指向产物所在目录（与拆分前的单文件语义一致）。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname);
const SRC_DIR = path.join(ROOT, 'src');
const ENTRY = 'src/entry.js';
const OUT = path.join(ROOT, 'agent.js');

/** 收集入口可达的全部模块（深度优先，按引用顺序稳定输出） */
function collectModules() {
  const modules = new Map(); // id -> { id, file, source, requires: Map(relPath -> id) }
  const visit = (id) => {
    if (modules.has(id)) return;
    const file = path.join(ROOT, id);
    if (!fs.existsSync(file)) throw new Error('模块不存在: ' + id);
    const source = fs.readFileSync(file, 'utf8');
    const requires = new Map();
    modules.set(id, { id, file, source, requires });
    // 只认相对路径 require（'./x.js' / '../x.js'），标准库或其它裸模块名原样保留
    const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
    for (const m of source.matchAll(re)) {
      const rel = m[2];
      const target = normId(id, rel);
      requires.set(rel, target);
      visit(target);
    }
  };
  visit(ENTRY);
  return modules;
}

/** 相对 id -> 规范化模块 id（始终用 / 分隔，相对 repo 的 agent/ 目录） */
function normId(fromId, rel) {
  const dir = path.posix.dirname(fromId);
  let p = path.posix.normalize(path.posix.join(dir, rel));
  if (!p.endsWith('.js')) p += '.js';
  return p;
}

/** 把模块源码里的相对 require 替换成注册表调用（标准库 require 不动） */
function rewriteRequires(mod) {
  return mod.source.replace(/require\(\s*(['"])(\.[^'"]+)\1\s*\)/g, (all, q, rel) => {
    const id = mod.requires.get(rel);
    if (!id) throw new Error(`${mod.id} 中未解析的 require: ${rel}`);
    return `__require(${JSON.stringify(id)})`;
  });
}

function build() {
  const modules = collectModules();
  const out = [];
  out.push('#!/usr/bin/env node');
  out.push("'use strict';");
  out.push('// BlockNexus Agent —— 零依赖单文件（仅用 Node.js 标准库），由面板通过 SSH 安装到远程服务器。');
  out.push('//');
  out.push('//   node agent.js --panel ws://面板地址:3080 --token <服务器token> --id <服务器ID>');
  out.push('//   （也可省略参数，读取同目录 agent.json，字段: panel/token/id）');
  out.push('//');
  out.push('// 职责：主动回连面板（WebSocket）→ token 挑战握手 → AES-256-GCM 加密通道 →');
  out.push('//       执行面板下发的 MC 实例操作（创建/下载/启动/停止/控制台/删除）。');
  out.push('//');
  out.push('// ⚠ 本文件由 agent/build.js 从 agent/src/** 生成，请勿直接编辑：');
  out.push('//   改源码后运行 `npm run build:agent` 重新打包。');
  out.push('');
  out.push('// ============================ 模块注册表 ============================');
  out.push('');
  out.push('const __modules = {};');
  out.push('const __cache = {};');
  out.push('');
  out.push('// 加载已打包模块：相对 require 已被 build.js 改写为 __require(<模块 id>)');
  out.push('function __require(id) {');
  out.push('  const cached = __cache[id];');
  out.push('  if (cached) return cached.exports;');
  out.push('  const factory = __modules[id];');
  out.push("  if (!factory) throw new Error('未打包的模块: ' + id);");
  out.push('  const mod = { exports: {} };');
  out.push('  __cache[id] = mod;');
  out.push('  factory(mod, mod.exports, __require);');
  out.push('  return mod.exports;');
  out.push('}');
  out.push('');
  for (const mod of modules.values()) {
    const body = rewriteRequires(mod)
      .replace(/^#![^\n]*\n/, '') // 模块自带 shebang 时去掉（产物只保留一个）
      .replace(/\s*$/, '');
    out.push(`// ---------------------------- ${mod.id} ----------------------------`);
    out.push(`__modules[${JSON.stringify(mod.id)}] = function (module, exports, __require) {`);
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
  if (check) {
    if (same) {
      console.log(`agent.js 与源码同步（${modules.size} 个模块，${text.split('\n').length} 行）`);
      return 0;
    }
    console.error('agent.js 与 agent/src 不同步：请运行 `npm run build:agent` 重新生成');
    return 1;
  }
  if (same) {
    console.log(`agent.js 已是最新（${modules.size} 个模块，${text.split('\n').length} 行）`);
    return 0;
  }
  fs.writeFileSync(OUT, text);
  console.log(`已生成 agent/agent.js：${modules.size} 个模块，${text.split('\n').length} 行`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { build, collectModules, normId };
