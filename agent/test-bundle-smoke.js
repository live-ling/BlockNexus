// 交付产物冒烟测试：真的把 agent/agent.js 当独立程序跑起来（拆分 + 打包后最容易坏的就是
// 模块注册表 / 相对 require 改写 / 入口执行顺序），因此这里不做任何源码切片，只黑盒验证：
//   · 用 --listen 启动 → 打印启动横幅 → 监听端口可用 → SIGTERM 干净退出（exit 0）
//   · 缺配置时打印中文提示并退出（配置校验仍在入口执行）
//
// 不连面板、不跑 java，纯本地进程级验证。

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const AGENT = path.join(__dirname, 'agent.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-bundle-smoke-'));
const PORT = 45911;

let pass = 0, total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${detail && !ok ? '\n       ' + detail : ''}`);
}

function waitPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = opts.killAfterMs
      ? setTimeout(() => child.kill('SIGTERM'), opts.killAfterMs)
      : null;
    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, out });
    });
  });
}

(async () => {
  // 1) 缺配置：打印中文提示并退出
  {
    const r = await run(['--id', 'smoke', '--token', 't']);
    check('缺配置时给出中文提示并退出', r.out.includes('缺少配置'), `输出: ${JSON.stringify(r.out.slice(0, 120))}`);
  }

  // 2) 监听模式启动：横幅 + 端口就绪 + SIGTERM 干净退出
  {
    const child = spawn(
      process.execPath,
      [AGENT, '--listen', String(PORT), '--token', 'smoke', '--id', 'smoke', '--instances', path.join(TMP, 'instances')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const listening = await waitPort(PORT);
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    check('产物能启动并打印版本横幅', out.includes('BlockNexus/'), `输出: ${JSON.stringify(out.slice(0, 160))}`);
    check('监听模式端口可用（模块打包后入口仍完整执行）', listening, `端口 ${PORT} 未监听`);
    check('实例目录按 --instances 生效', out.includes(path.join(TMP, 'instances')), `输出: ${JSON.stringify(out.slice(0, 200))}`);
    // POSIX 下走优雅退出（exit 0）；Windows 不支持 SIGTERM，kill 即结束进程（code=null, signal=SIGTERM）
    const clean =
      process.platform === 'win32' ? signal === 'SIGTERM' || code === 0 : code === 0;
    check('收到终止信号后干净结束', clean, `退出码 ${code} / 信号 ${signal}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass}/${total} bundle-smoke cases passed`);
  process.exit(pass === total ? 0 : 1);
})();
