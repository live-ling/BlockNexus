// 模块导入完整性校验：agent/src/** 拆分后，「某模块用了别处定义的符号却忘了 require」
// 只在执行到那条分支时才抛 ReferenceError —— node --check、打包新鲜度检查都发现不了
// （本次拆分就漏过 agent.js 里 Sealer/Opener 的导入，最后靠 e2e 才暴露）。
//
// 做法（零依赖，自带词法扫描）：
//   1. 剥掉注释与字符串/模板，保留代码文本（模板里的 ${} 表达式属于代码，保留其内容）
//   2. 收集本模块的「绑定名」：各类声明、参数、解构、catch、for-of、函数/类名、require 导入、导出对象键
//   3. 收集本模块出现的「标识符引用」：排除属性访问 .x、对象字面量键 x:、方法名 x( 定义位
//   4. 自由标识符 = 引用 - 绑定 - JS 内置/Node 全局 - 标准库
//   5. 自由标识符若命中「其它模块的导出」→ 漏 import（高置信度，报错）
//      首字母大写且未定义的 → 疑似漏导入/拼错（报错）
//      其余短小写名 → 可能是扫描噪音，只提示不失败

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src');
const ENTRY = 'entry.js'; // 入口会真的启动 Agent（监听端口/连面板），只做导入名校验，不扫描引用
const FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) FILES.push(p);
  }
})(SRC_DIR);
const rel = (f) => path.relative(SRC_DIR, f).replace(/\\/g, '/');

// ---------- 词法扫描：剥注释与字符串/模板，模板保留 ${} 内容 ----------
function stripLiterals(src) {
  let out = '';
  let i = 0;
  let prev = ''; // 上一个非空白字符（判断 `/` 是正则还是除号）
  const n = src.length;
  const identChar = (c) => /[A-Za-z0-9_$]/.test(c);
  const pending = []; // 模板嵌套深度栈
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (src[i] === '\n') break;
        i++;
      }
      out += ' ';
      prev = "'";
      continue;
    }
    if (c === '`') {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 保留模板表达式内容（里面是真实代码）
          depth++;
          out += ' ';
          i += 2;
          const start = i;
          let d = 1;
          while (i < n && d > 0) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
            else if (src[i] === '`') {
              // 嵌套模板：整体跳过（内容不参与分析，避免状态机复杂化）
              i++;
              while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '`') { i++; break; }
                i++;
              }
              continue;
            }
            i++;
          }
          out += stripLiterals(src.slice(start, i - 1));
          depth--;
          continue;
        }
        if (src[i] === '`' && depth === 0) { i++; break; }
        i++;
      }
      out += ' ';
      prev = '`';
      continue;
    }
    if (c === '/' && !identChar(prev) && !')]}'.includes(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;
        i++;
      }
      while (i < n && /[a-z]/.test(src[i])) i++;
      out += ' ';
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// ---------- 绑定名收集 ----------
function bindingsOf(code) {
  const names = new Set();
  const add = (name) => { if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name); };
  const addPattern = (text) => {
    // 解构模式里的名字：{ a, b: c, d = 1, ...rest } / [a, b]
    for (const m of text.matchAll(/(?:^|[{,\[\s])(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[:,=}\],]|$)/g)) {
      add(m[1]);
    }
  };
  // const/let/var NAME  与  const/let/var { a, b } / [a, b]
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*?[}\]])\s*=/g)) addPattern(m[1]);
  // function NAME(a, b) / async function NAME(...)
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    add(m[1]);
    addPattern(m[2]);
  }
  // class NAME
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 箭头函数参数：((a, b) => / a => / ({a}) =>
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addPattern(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // catch (e)
  for (const m of code.matchAll(/\bcatch\s*\(([^)]*)\)/g)) addPattern(m[1]);
  // for (const x of ...) / for (x in ...) / for (let i = 0; ...)
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s*([{[][^=;]*?[}\]])\s+(?:of|in)\b/g)) addPattern(m[1]);
  // import 导入
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g)) addPattern(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/g)) add(m[1]);
  // 对象字面量 / 类里的方法名与属性名（它们在引用侧是键，不是自由变量）；
  // 同时把方法签名的参数登记为绑定：`name(a, b) {` / `async name(a) {` / `get name() {`
  for (const m of code.matchAll(/(?:^|[{,\n;])\s*(?:async\s+)?(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
    add(m[1]);
    addPattern(m[2]);
  }
  for (const m of code.matchAll(/(?:^|[{,\n])\s*([A-Za-z_$][\w$]*)\s*:/g)) add(m[1]);
  // 自增/赋值出的名字（累加器常见写法，例如 (acc[k] = ...) 不涉及；这里兜住 `name = ...` 顶部变量）
  return names;
}

// ---------- import / 导出名集合 ----------
/** 收集 import：`const { a, b } = require('./x.js')` 与 `const ns = require('./x.js')`
 *  （必须扫原始源码：stripLiterals 会抹掉字符串，模块路径只在原文里） */
function importsOf(src) {
  const out = new Map(); // 本地名 -> { from, named }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.set(name, { from: m[2], named: true });
    }
  }
  // 命名空间导入：const state = require('./state.js')（约束的是模块，不校验成员名）
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    out.set(m[1], { from: m[2], named: false });
  }
  return out;
}

function exportsOf(src) {
  const names = new Set();
  const c = stripLiterals(src);
  for (const m of c.matchAll(/module\.exports\s*=\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = c.length;
    for (let i = open; i < c.length; i++) {
      if (c[i] === '{') depth++;
      else if (c[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = c.slice(open + 1, end);
    const flat = inner.replace(/\([^)]*\)/g, '').replace(/\{[^{}]*\}/g, '');
    for (const part of flat.split(',')) {
      const name = part.trim().replace(/^(?:async\s+)?(?:get|set)\s+/, '').split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const BUILTIN = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console', 'Buffer', 'global', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'structuredClone',
  'fetch', 'Headers', 'Request', 'Response', 'performance', 'atob', 'btoa',
  'Object', 'Array', 'Function', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'EvalError', 'ReferenceError', 'URIError', 'AggregateError', 'ArrayBuffer', 'SharedArrayBuffer',
  'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray', 'Intl', 'Atomics', 'WeakRef',
  'FinalizationRegistry', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'undefined', 'NaN', 'Infinity', 'eval', 'arguments',
  // 常见关键字残余（词法扫描后仍会出现的属性名/语句关键字）
  'if', 'else', 'for', 'while', 'do', 'return', 'function', 'class', 'const', 'let', 'var', 'new', 'typeof',
  'instanceof', 'in', 'of', 'await', 'async', 'yield', 'try', 'catch', 'finally', 'throw', 'switch', 'case',
  'default', 'break', 'continue', 'delete', 'void', 'this', 'super', 'extends', 'static', 'get', 'set', 'null',
  'true', 'false', 'case', 'export', 'import',
]);

// ---------- 每个模块：绑定 + 引用 ----------
const mods = new Map();
for (const f of FILES) {
  const src = fs.readFileSync(f, 'utf8');
  const code = stripLiterals(src);
  mods.set(rel(f), { src, code, bindings: bindingsOf(code), exports: exportsOf(src), imports: importsOf(src) });
}
const exportOwners = new Map();
for (const [r, m] of mods) {
  for (const name of m.exports) {
    if (!exportOwners.has(name)) exportOwners.set(name, []);
    exportOwners.get(name).push(r);
  }
}

// ---------- 检查 ----------
let problems = 0;
let checked = 0;
const notes = [];

// 反向检查：import 了不存在的模块 / 目标模块没导出这个名字（拼错名、引用错模块）。
// 只校验相对路径（标准库与命名空间导入不适用）。
for (const [r, m] of mods) {
  for (const [name, imp] of m.imports) {
    if (!imp.from.startsWith('.')) continue;
    checked++;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(r), imp.from));
    const t = mods.get(target);
    if (!t) {
      problems++;
      console.log(`✗ ${r}: import 了不存在的模块 ${imp.from}`);
      continue;
    }
    // 具名导入要校验目标模块确实导出该名字；命名空间导入只约束模块本身（已在上一步校验）
    if (imp.named && !t.exports.has(name)) {
      problems++;
      console.log(`✗ ${r}: 从 ${imp.from} 导入了 ${name}，但该模块并未导出它`);
    }
  }
}

for (const [r, m] of mods) {
  const refs = new Set();
  for (const mm of m.code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)/g)) refs.add(mm[1]);
  for (const name of refs) {
    if (BUILTIN.has(name) || m.bindings.has(name)) continue;
    checked++;
    if (exportOwners.has(name)) {
      problems++;
      const owners = exportOwners.get(name).filter((x) => x !== r);
      console.log(`✗ ${r}: 使用了 ${name}，但没有 import${owners.length ? `（由 ${owners.join(' / ')} 导出）` : ''}`);
    } else if (/^[A-Z][A-Za-z0-9_$]*$/.test(name)) {
      problems++;
      console.log(`✗ ${r}: 引用了未定义的 ${name}（疑似漏 import 或拼写错误）`);
    } else {
      notes.push(`${r}: 未绑定的小写标识符 ${name}`);
    }
  }
}

console.log(`扫描 ${mods.size} 个源文件，${exportOwners.size} 个跨模块导出符号`);
if (notes.length) {
  console.log(`\n低置信度提示（${notes.length} 条，可能是扫描噪音）：`);
  for (const n of notes.slice(0, 15)) console.log('  · ' + n);
}
console.log(problems ? `\n发现 ${problems} 处问题（共 ${checked} 项检查）` : `\n全部 ${checked} 项检查通过 ✓`);
process.exit(problems ? 1 : 0);
