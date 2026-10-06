// 交付产物新鲜度验证：agent/agent.js 必须与 agent/src/** 的当前源码一致。
// Agent 的交付物是单文件（SSH 只上传一个文件、systemd 直接跑它），源码拆分后
// 若忘记重新打包，线上跑的就会是旧代码——这个测试专门守住这一点。
//
// 失败时运行：npm run build:agent

const path = require('path');
const { build } = require(path.join(__dirname, 'build.js'));
const fs = require('fs');

const OUT = path.join(__dirname, 'agent.js');
const { text, modules } = build();
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

let pass = 0, total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${detail && !ok ? '\n       ' + detail : ''}`);
}

check('agent/agent.js 已生成', current.length > 0, '产物不存在，请运行 npm run build:agent');
check(
  '产物与 agent/src 源码同步（未过期）',
  current === text,
  `不一致：请运行 npm run build:agent 重新打包（当前 ${current.split('\n').length} 行，应为 ${text.split('\n').length} 行）`,
);
check(
  '打包包含全部模块',
  [...modules.keys()].every((id) => text.includes(`__modules[${JSON.stringify(id)}]`)),
  '有模块未进入产物',
);
check(
  '产物仍是零依赖（只 require Node 标准库）',
  (() => {
    const builtin = new Set(require('module').builtinModules);
    const bad = [];
    for (const m of current.matchAll(/(?<![A-Za-z0-9_$])require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const name = m[1].startsWith('node:') ? m[1].slice(5) : m[1];
      if (!builtin.has(name) && !name.startsWith('.')) bad.push(m[1]);
    }
    return bad.length === 0;
  })(),
  '产物里出现了非标准库 require',
);
check(
  '产物保留 AGENT_VERSION 常量（面板靠它判断远端版本）',
  /AGENT_VERSION\s*=\s*'[^']+'/.test(current),
  '面板从产物文本提取 AGENT_VERSION 的正则会失效',
);

console.log(`\n${pass}/${total} bundle-fresh cases passed`);
process.exit(pass === total ? 0 : 1);
