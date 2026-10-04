'use strict';
// 本地 Agent 托管：本机（Windows / Linux / macOS）Agent 不走 SSH，由面板直接拉起/停止进程。
//
// 为什么单独一套：远程 Linux 服务器用 SSH 上传 + systemd 托管（panel/ssh.js），
// 但本机没有 SSH 服务端、也没有 systemd，强行走那条链路必然失败。
// 这里的能力：
//   · 每台本机服务器一个**专用目录**（默认 data/local-agents/<id>，含 agent.json 与日志），
//     实例也落在该目录下 —— 不再复用项目源码目录，卸载时删得干净且不碰源码；
//   · 面板 spawn node agent.js（detached + hidden），停止时先优雅 TERM 再兜底 KILL；
//   · 进程pid 记在 agent.json 旁的 runtime.json，面板重启后也能找到旧进程。
//
// 注意：detached 子进程属于面板的进程组，面板退出后仍存活（同一会话内），
// 真正的「退出即清理」由 npm stop / 托盘「退出应用」显式触发。

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const AGENT_FILE = path.join(__dirname, '..', 'agent', 'agent.js');

/** host 是否指向本机（面板所在机器） */
function isLocalHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

/** 本机服务器的专用目录：data/local-agents/<serverId>（首次访问时创建） */
function localDir(server) {
  const base = path.join(__dirname, '..', 'data', 'local-agents');
  const dir = path.join(base, String(server.id).replace(/[^A-Za-z0-9._-]/g, '_'));
  return dir;
}

function instancesDir(server) {
  return path.join(localDir(server), 'instances');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** 本机端口是否已有进程监听（判断 Agent 是否已在跑） */
function portOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Windows 用 taskkill 杀整棵进程树；POSIX 直接 kill(-pid) 杀进程组 */
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, 'SIGKILL'); // 负号 = 进程组
    return true;
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
}

/** 进程是否还活着（kill(pid, 0) 只探测不发信号） */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return process.platform === 'win32' ? undefined : false; // undefined = 探测不可用
  }
}

function aliveWin(pid) {
  try {
    const out = require('child_process').execFileSync('tasklist', ['/FI', `PID eq ${pid}`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return new RegExp(`\\b${pid}\\b`).test(out);
  } catch {
    return false;
  }
}

function isAlive(pid) {
  const r = alive(pid);
  if (r === true || r === false) return r;
  return aliveWin(pid);
}

/** 读取本机 Agent 运行态：{ pid, running, dir, instancesDir } */
function status(server) {
  const dir = localDir(server);
  const rt = readJson(path.join(dir, 'runtime.json')) || {};
  const pid = Number(rt.pid) || 0;
  return {
    dir,
    instancesDir: instancesDir(server),
    pid,
    running: pid ? !!isAlive(pid) : false,
    startedAt: rt.startedAt || null,
  };
}

/**
 * 安装/重装本机 Agent：
 *   1) 建专用目录 data/local-agents/<id>（含 instances/）；
 *   2) 写 agent.json（与普通安装一致的结构：listen / token / id / instances）；
 *   3) 已在运行则先停（重装场景），再 detached 拉起 node agent.js（日志追加到该目录 agent.log）。
 * 返回 { pid, dir, instancesDir }
 */
async function installAgent(server, log) {
  if (!fs.existsSync(AGENT_FILE)) throw new Error('找不到 agent/agent.js');
  const mode = server.agent.mode || 'outbound';
  const dir = localDir(server);
  const instDir = instancesDir(server);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(instDir, { recursive: true });

  log(`本机 Agent 专用目录：${dir}\n`);
  log(`实例目录：${instDir}\n`);

  // 已在运行 → 先停，保证重装用的是新配置（与新 token/端口一致）
  const before = status(server);
  if (before.running) {
    log('检测到本机 Agent 已在运行，先停止…\n');
    await stopAgent(server, log);
  }

  const cfg =
    mode === 'inbound'
      ? { panel: server.agent.panelUrl, token: server.token, id: server.id, instances: instDir }
      : {
          listen: server.agent.port || 3099,
          token: server.token,
          id: server.id,
          instances: instDir,
        };
  // agent.json 供手动排查/复用（Agent 实际以命令行参数为主，两者保持一致便于人工核对）
  writeJson(path.join(dir, 'agent.json'), cfg);
  log(`已写入 ${path.join(dir, 'agent.json')}\n`);

  // outbound 模式下端口被别的进程占用 → 直接失败，避免拉起后立刻 EADDRINUSE 退出
  if (mode !== 'inbound') {
    const port = server.agent.port || 3099;
    if (await portOpen(port)) {
      throw new Error(`本机 ${port} 端口已被占用，请先停止占用该端口的进程，或改用其他端口`);
    }
  }

  const logFile = path.join(dir, 'agent.log');
  const fd = fs.openSync(logFile, 'a');
  // token / id 必须显式给：agent.js 的 loadConfig 只从命令行读这两个字段
  // （agent.json 只承载 listen/panel/tls/instances 这类可被目录决定的配置）
  const args = [
    AGENT_FILE,
    '--dir',
    dir,
    '--instances',
    instDir,
    '--token',
    String(server.token),
    '--id',
    String(server.id),
  ];
  if (mode === 'inbound' && server.agent.panelUrl) args.push('--panel', server.agent.panelUrl);
  if (mode !== 'inbound') args.push('--listen', String(server.agent.port || 3099));

  const child = spawn(process.execPath, args, {
    cwd: dir,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: { ...process.env, BLOCKNEXUS_DIR: dir },
  });
  child.unref();
  try {
    fs.closeSync(fd);
  } catch {}

  const pid = child.pid;
  writeJson(path.join(dir, 'runtime.json'), {
    pid,
    startedAt: Date.now(),
    args,
    node: process.execPath,
  });
  log(`本机 Agent 已启动（pid ${pid}）\n`);
  log(`日志: ${logFile}\n`);
  if (mode === 'inbound') log('等待 Agent 回连面板…\n');
  else log(`Agent 正在本机监听 ${server.agent.port || 3099} 端口\n`);

  return { pid, dir, instancesDir: instDir };
}

/** 停止本机 Agent：优先请 Agent 自己收尾（在线时停实例），再 TERM → KILL */
async function stopAgent(server, log, { agentRequest } = {}) {
  const dir = localDir(server);
  const st = status(server);
  if (!st.pid) {
    log('本机 Agent 未在运行\n');
    return { stopped: false };
  }
  if (!st.running) {
    log(`记录中的本机 Agent 进程 ${st.pid} 已不存在，清理运行态\n`);
    try {
      fs.rmSync(path.join(dir, 'runtime.json'), { force: true });
    } catch {}
    return { stopped: false };
  }

  log(`停止本机 Agent（pid ${st.pid}）…\n`);

  // Agent 在线时先让它优雅停 实例（与普通卸载流程一致），避免 MC 进程变成孤儿
  if (agentRequest) {
    try {
      const prep = await agentRequest(server.id, 'agent.prepareUninstall', { keepBackups: false }, 30000);
      if (prep && prep.stopped && prep.stopped.length) {
        log(`已停止实例：${prep.stopped.join('、')}\n`);
      }
    } catch {
      // 收尾失败不影响继续：下面会直接结束进程
    }
  }

  // Windows 没有 POSIX 信号语义：先温和 TERM（Node 能处理），等一小会儿再强制杀树
  let graceful = true;
  try {
    if (process.platform === 'win32') {
      require('child_process').execFileSync('taskkill', ['/PID', String(st.pid), '/T'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(st.pid, 'SIGTERM');
    }
  } catch {
    graceful = false;
  }
  if (graceful) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && isAlive(st.pid)) await sleep(300);
  }
  if (isAlive(st.pid)) {
    log('进程未在 10 秒内退出，强制结束…\n');
    killTree(st.pid);
    await sleep(500);
  }

  const gone = !isAlive(st.pid);
  try {
    fs.rmSync(path.join(dir, 'runtime.json'), { force: true });
  } catch {}
  log(gone ? '✓ 本机 Agent 已停止\n' : '⚠ 进程仍在运行，请手动结束\n');
  return { stopped: gone, pid: st.pid };
}

/**
 * 卸载本机 Agent：停进程（+可选优雅收尾），可选删除专用目录（含实例与备份）。
 * 注意：删的是 data/local-agents/<id> 这个专用目录，**不会**碰到项目源码或 agent.js。
 */
async function uninstallAgent(server, log, { keepBackups = false, deleteDir = true, agentRequest } = {}) {
  await stopAgent(server, log, { agentRequest });

  const dir = localDir(server);
  if (keepBackups) {
    const backups = path.join(instancesDir(server), '.backups');
    try {
      if (fs.existsSync(backups) && fs.readdirSync(backups).length) {
        log('已保留备份目录 .backups（不会被打包，仅保留在本机）\n');
      }
    } catch {}
  }

  if (deleteDir) {
    log(`删除专用目录 ${dir}（含实例与存档）…\n`);
    await sleep(300); // 给进程退出留一点时间日志句柄释放完
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`删除目录失败: ${e.message}`);
    }
    const gone = !fs.existsSync(dir);
    log(gone ? '✓ 专用目录已删除\n' : '⚠ 目录仍存在，请手动检查\n');
  } else {
    log('已保留专用目录（实例与存档未删除）\n');
  }
  log('✓ 本机 Agent 已卸载\n');
}

module.exports = {
  isLocalHost,
  localDir,
  instancesDir,
  status,
  installAgent,
  stopAgent,
  uninstallAgent,
  portOpen,
};
