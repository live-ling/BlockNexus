// 玩家跟踪解析验证：从 agent.js 源码中提取 trackPlayers 里的正则，逐条喂日志行
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
const start = src.indexOf('trackPlayers(rec, line) {');
if (start < 0) throw new Error('未找到 trackPlayers');
const body = src.slice(start, src.indexOf('\n  }', start));

// 复刻方法中的四条规则（与 agent.js 保持一致的正则字符串）
const NAME = '([^\\s]{1,32})';
const rules = [
  { re: new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${NAME} joined the game\\s*$`), act: 'add' },
  { re: new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${NAME} left the game\\s*$`), act: 'del' },
  { re: new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${NAME} lost connection`), act: 'del' },
  { re: /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/, act: 'set' },
];

function track(set, line) {
  for (const { re, act } of rules) {
    const m = re.exec(line);
    if (!m) continue;
    if (act === 'add') return set.add(m[1]), `add:${m[1]}`;
    if (act === 'del') return set.delete(m[1]), `del:${m[1]}`;
    set.clear();
    (m[3] || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => set.add(n));
    return `set:${[...set].join('|')}`;
  }
  return null;
}

// 断言：源码里确实包含这四条规则（防止测试与实现漂移）
for (const frag of [' joined the game', ' left the game', ' lost connection', 'players online']) {
  if (!body.includes(frag)) throw new Error('agent.js 中缺少规则: ' + frag);
}

const set = new Set();
const tests = [
  ['[22:24:17] [Server thread/INFO]: Steve joined the game', 'add:Steve'],
  ['[22:24:18] [Server thread/INFO]: Alex joined the game', 'add:Alex'],
  ['[22:24:19] [Server thread/INFO]: 玩家_01 joined the game', 'add:玩家_01'],
  ['[22:24:20] [Server thread/INFO]: Steve left the game', 'del:Steve'],
  ['[22:24:22] [Server thread/INFO]: Alex lost connection: Disconnected', 'del:Alex'],
  ['[22:24:30] [Server thread/INFO]: There are 2 of a max of 20 players online: Alice, Bob_99', 'set:Alice|Bob_99'],
  ['[22:24:35] [Server thread/INFO]: Done (1.9s)! For help, type "help"', null],
  ['[22:24:40] [Server thread/INFO]: <Steve> hello', null],
  ['[22:24:45] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?', null],
];

let pass = 0;
for (const [line, want] of tests) {
  const got = track(set, line);
  const ok = got === want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${line.slice(25, 78)}  →  ${got}`);
}
console.log(`\n${pass}/${tests.length} passed | final: ${JSON.stringify([...set])}`);

// ---------- makeLineSplitter 验证：从源码提取方法体直接调用 ----------
const ms = src.indexOf('makeLineSplitter(onLine) {');
if (ms < 0) throw new Error('未找到 makeLineSplitter');
const splitterBody = src.slice(src.indexOf('{', ms) + 1, src.indexOf('\n  }', ms));
// 源码片段防漂移：关键实现细节必须在位
for (const frag of ['0x0a', 'Buffer.concat', 'MAX_REST', "\\r$"]) {
  if (!splitterBody.includes(frag)) throw new Error('makeLineSplitter 缺少实现细节: ' + frag);
}
// 方法体不依赖 this，可直接作为函数体实例化
const makeLineSplitter = new Function('onLine', splitterBody);

let sp = 0;
let spTotal = 0;
function runSplitterCase(desc, chunks, want) {
  spTotal++;
  const got = [];
  const feed = makeLineSplitter((t) => got.push(t));
  for (const c of chunks) feed(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
  feed.flush(); // 与真实用法一致：流结束时吐出残留行
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) sp++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc} → ${JSON.stringify(got)}`);
}

const VANILLA_JOIN = '[12:34:56] [Server thread/INFO]: 玩家_01 joined the game';
const joinAt = (buf, byte) => [buf.subarray(0, byte), buf.subarray(byte)]; // 在第 byte 字节处撕裂

// 1) 行中间撕裂（切在 UTF-8 中文字节内）也要拼回完整行
{
  const [a, b] = joinAt(Buffer.from(VANILLA_JOIN, 'utf8'), Buffer.byteLength('[12:34:56] [Server thread/INFO]: 玩'));
  runSplitterCase('中文处撕裂', [a, b], [VANILLA_JOIN]);
}
// 2) 无换行尾巴保持 pending，下一个 chunk 补齐
{
  const [a, b] = joinAt(Buffer.from(VANILLA_JOIN + '\n', 'utf8'), 20);
  runSplitterCase('跨 chunk 拼行', [a, b], [VANILLA_JOIN]);
}
// 3) 一个 chunk 多行 + \r\n
runSplitterCase('多行与\\r\\n', ['[a] [x/INFO]: A joined the game\r\n[b] [x/INFO]: B joined the game\n'], [
  '[a] [x/INFO]: A joined the game',
  '[b] [x/INFO]: B joined the game',
]);
// 4) 空行不回调；末尾无换行的残留行在下一次输入后吐出
runSplitterCase('空行与残留', ['line1\n\n', 'line2\nline3'], ['line1', 'line2', 'line3']);

console.log(`${sp}/${spTotal} splitter cases passed`);
process.exit(pass === tests.length && sp === spTotal ? 0 : 1);
