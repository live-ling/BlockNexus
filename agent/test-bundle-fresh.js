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
// 依赖相关的两条断言（2026-10-06 修订）：
// 旧约束是「产物零依赖」。现已允许 Agent 使用第三方依赖，但要求**全部内联进产物**——
// 因为部署链路依赖「一个文件即全部」（SSH 只传一个文件、curl 一行安装、面板匿名分发）。
// 因此改为两条更强的断言：②依赖必须已内联；③不允许有漏网的裸模块名。
const npmModules = [...modules.values()].filter((m) => m.kind === 'npm');

check(
  '内联的 npm 包都已写进产物注册表',
  npmModules.every((m) => text.includes(`__modules[${JSON.stringify(m.id)}]`)),
  `未进产物的 npm 模块: ${npmModules.filter((m) => !text.includes(`__modules[${JSON.stringify(m.id)}]`)).map((m) => m.id).join(', ')}`,
);
check(
  '产物里没有未内联的裸模块名（第三方依赖必须全部内联）',
  (() => {
    const builtin = new Set(require('module').builtinModules);
    const bad = [];
    for (const m of current.matchAll(/(?<![A-Za-z0-9_$])require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const raw = m[1];
      const name = raw.startsWith('node:') ? raw.slice(5) : raw;
      if (builtin.has(name)) continue; // Node 标准库：允许原样保留
      if (raw.startsWith('.')) { bad.push(`相对路径未改写: ${raw}`); continue; }
      bad.push(raw); // 既非标准库又非相对路径 → 运行时在目标机会解析失败
    }
    return bad.length === 0;
  })(),
  '产物中出现了未内联的裸模块名——目标机没有 node_modules，运行时会报「Cannot find module」',
);
check(
  '产物保留 AGENT_VERSION 常量（面板靠它判断远端版本）',
  /AGENT_VERSION\s*=\s*'[^']+'/.test(current),
  '面板从产物文本提取 AGENT_VERSION 的正则会失效',
);

console.log(`\n${pass}/${total} bundle-fresh cases passed`);
process.exit(pass === total ? 0 : 1);
