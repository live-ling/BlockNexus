'use strict';
// Agent 命令行/环境变量解析的回归测试。
//
// 为什么值得单独测：这两处都是「开关看起来生效、其实没生效或反着生效」的经典坑，
// 而且都不会报错——不看日志根本发现不了。
//
// 运行：node agent/test-config-flags.js

const path = require('path');
const { parseArgs } = require(path.join(__dirname, 'src', 'config.js'));
const { envFlag } = require(path.join(__dirname, 'src', 'ws.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

// ---------- parseArgs：布尔开关 ----------
// 原先 `out[argv[i]] = argv[i+1]`：布尔开关放在**末位**会写成 undefined，
// 而调用方用 `!== undefined` 判断 → 开关**静默失效**（--insecure 就这么废掉的）。
check('布尔开关在末位 → true（不再静默失效）', parseArgs(['--insecure'])['--insecure'] === true,
  JSON.stringify(parseArgs(['--insecure'])));

check(
  '布尔开关后面紧跟另一个选项 → true，且不影响后者解析',
  (() => {
    const a = parseArgs(['--insecure', '--panel', 'ws://x']);
    return a['--insecure'] === true && a['--panel'] === 'ws://x';
  })(),
  JSON.stringify(parseArgs(['--insecure', '--panel', 'ws://x'])),
);

check('带值的普通选项照旧', parseArgs(['--panel', 'ws://x'])['--panel'] === 'ws://x');

check(
  '多个开关混排',
  (() => {
    const a = parseArgs(['--panel', 'ws://x', '--token', 't', '--insecure']);
    return a['--panel'] === 'ws://x' && a['--token'] === 't' && a['--insecure'] === true;
  })(),
);

// ---------- envFlag：布尔型环境变量 ----------
// 直接 `if (process.env.X)` 对**任何非空字符串**都为真，
// 于是 BLOCKNEXUS_INSECURE=0 / =false 反而会**关掉** TLS 校验——与意图完全相反。
const withEnv = (v) => {
  const old = process.env.BN_TEST_FLAG;
  if (v === undefined) delete process.env.BN_TEST_FLAG;
  else process.env.BN_TEST_FLAG = v;
  const r = envFlag('BN_TEST_FLAG');
  if (old === undefined) delete process.env.BN_TEST_FLAG;
  else process.env.BN_TEST_FLAG = old;
  return r;
};

check('envFlag: "1" → true', withEnv('1') === true);
check('envFlag: "true" → true', withEnv('true') === true);
check('envFlag: "TRUE" → true（大小写不敏感）', withEnv('TRUE') === true);
check('envFlag: "yes" / "on" → true', withEnv('yes') === true && withEnv('on') === true);
// 这四条是关键：写 0/false/no 的人是**想关掉它**，不能被当成开启
check('envFlag: "0" → false（关键：不能反着生效）', withEnv('0') === false);
check('envFlag: "false" → false（关键：不能反着生效）', withEnv('false') === false);
check('envFlag: "no" → false', withEnv('no') === false);
check('envFlag: 未设置 / 空串 → false', withEnv(undefined) === false && withEnv('') === false);

console.log(`\n${pass}/${total} config-flags cases passed`);
process.exit(pass === total ? 0 : 1);
