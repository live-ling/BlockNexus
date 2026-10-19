'use strict';
// 「卸载 Agent」的回归测试：本机停/卸载的真实行为 + 面板与 SSH 侧的后置核验。
//
// 分两类：
//   ① 功能：真起一个本机 Agent 替身进程，走 localAgent.stopAgent / uninstallAgent，
//      确认「停掉进程」与「删掉目录」都真的发生了（不是只打了日志）；
//   ② 源码断言：面板/SSH 侧的后置判断（服务、进程、目录逐项核验 + 失败必须报错）
//      没法在 CI 上真连服务器，只能钉住实现里的关键检查存在。
// 运行：node agent/test-uninstall.js

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const localAgent = require(path.join(ROOT, 'panel', 'localagent.js'));

let pass = 0;
let total = 0;
function check(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID = `srv_uninsttest_${Math.random().toString(36).slice(2, 8)}`;
const SERVER = {
  id: ID,
  host: '127.0.0.1',
  agent: { mode: 'outbound', port: 43119, host: '', tls: false, panelUrl: '', installDir: '' },
  info: null,
  installing: false,
};
const logs = [];
const log = (t) => logs.push(String(t));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    if (process.platform !== 'win32') return false;
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true });
      return new RegExp(`\\b${pid}\\b`).test(out.stdout || '');
    } catch {
      return false;
    }
  }
}

/** 起一个「假 Agent」：只占着进程，不监听端口、不连面板 */
function spawnDummy() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function main() {
  const dir = localAgent.localDir(SERVER);
  const instDir = localAgent.instancesDir(SERVER);
  let dummy = 0;
  try {
    fs.mkdirSync(instDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ token: 't', id: ID }));

    // ---------- ① 停止：进程真的没了 ----------
    dummy = spawnDummy();
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pid: dummy, startedAt: Date.now() }));
    await sleep(300);
    check('假 Agent 进程已启动', pidAlive(dummy), `pid=${dummy}`);

    const st = localAgent.status(SERVER);
    check('status() 能读出运行中的 pid', st.pid === dummy && st.running === true);

    const stopped = await localAgent.stopAgent(SERVER, log);
    await sleep(300);
    check('stopAgent 报告已停止', stopped.stopped === true, JSON.stringify(stopped));
    check('stopAgent 之后进程确实不在了', !pidAlive(dummy), `pid=${dummy}`);
    check('runtime.json 已清理', !fs.existsSync(path.join(dir, 'runtime.json')));

    // ---------- ② 卸载：目录真的删了 ----------
    dummy = spawnDummy();
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pid: dummy, startedAt: Date.now() }));
    await sleep(200);
    const r = await localAgent.uninstallAgent(SERVER, log, { deleteDir: true });
    check('uninstallAgent 返回未保留目录', r && r.keptDir === false, JSON.stringify(r));
    check('进程已结束', !pidAlive(dummy), `pid=${dummy}`);
    check('专用目录已删除', !fs.existsSync(dir), dir);
    check('日志里有「端口已释放」或占用提示', /端口 43119/.test(logs.join('')));

    // ---------- ③ 重复卸载：幂等，不报错 ----------
    const again = await localAgent.uninstallAgent(SERVER, log, { deleteDir: true });
    check('重复卸载不抛错且标记 alreadyGone', again && again.alreadyGone === true, JSON.stringify(again));
  } finally {
    if (dummy && pidAlive(dummy)) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(dummy), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(dummy, 'SIGKILL');
        }
      } catch {}
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  // ---------- ④ 源码级：后置核验必须存在且会抛错 ----------
  {
    const ssh = fs.readFileSync(path.join(ROOT, 'panel', 'ssh.js'), 'utf8');
    check('SSH 卸载核验 systemd 服务状态', /systemctl is-active blocknexus-agent/.test(ssh));
    check('SSH 卸载核验残留进程（固定串匹配）', /grep -F "node \$\{dir\}\/agent\.js"/.test(ssh));
    check('SSH 卸载核验目录是否删净', /\[ -e \$\{dir\} \] && echo exists/.test(ssh));
    check('SSH 卸载有失败判定并抛错', /problems\.push/.test(ssh) && /卸载未完成/.test(ssh));
    check('SSH 卸载对「本来就没装」幂等', /alreadyGone: true/.test(ssh));

    const local = fs.readFileSync(path.join(ROOT, 'panel', 'localagent.js'), 'utf8');
    check('本机卸载在进程未退出时抛错', /进程仍在运行/.test(local) && /stop\.pid && !stop\.stopped/.test(local));
    check('本机卸载核验目录是否真的删掉', /专用目录仍存在/.test(local));

    const api = fs.readFileSync(path.join(ROOT, 'panel', 'api.js'), 'utf8');
    check('卸载后主动断开连接', /conn\.kick\('Agent 已卸载'\)/.test(api));
    check('卸载后清资源快照与更新状态', /statsCache\.delete\(server\.id\)/.test(api) && /agentUpdateState\.delete\(server\.id\)/.test(api));
    check('卸载后进入离线静默窗口', /uninstalledAt\.set\(server\.id, Date\.now\(\)\)/.test(api) && /UNINSTALL_QUIET_MS/.test(api));
    check('移除服务器时停掉重连循环', /hub\.stopOutbound\(server\.id\); \/\/ 停掉重连循环/.test(api) && /hub\.syncOutbound\(\)/.test(api));
    check('卸载结果带上 alreadyGone/removed', /alreadyGone: !!verdict\.alreadyGone/.test(api) && /removed: !!b\.removeServer/.test(api));
    check('本机停止同样做后置判断', /进程 \$\{r\.pid\} 未在超时内退出/.test(api));
    check(
      '本机停止的结果带 stopped 标记（区分「已停止 / 已卸载」提示）',
      /taskLogDone\(server\.id, 'uninstall', \{ done: true, ok: true, stopped: true \}\)/.test(api),
    );
  }

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error('卸载测试异常:', e);
  process.exit(1);
});
