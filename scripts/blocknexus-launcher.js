'use strict';
// BlockNexus 一键启动器（Windows）
//
// 桌面快捷方式（指向 BlockNexus.exe）→ WebView2 桌面外壳直接渲染前端页面；
// 浏览器 --app 开窗链路已废弃（普通权限下被日常浏览器实例接管，不稳定）。
//   1) 面板没在运行 → 后台拉起 node panel/server.js（日志追加到 data/panel.log）；
//   2) 为 config.json 里的「本机服务器」（host 为 127.0.0.1/localhost）拉起本地 Agent
//      （日志追加到 data/agent.log；端口已有进程监听则跳过，远程服务器不归本机管）；
//   3) 用 Edge/Chrome 的 --app 模式打开**独立应用窗口**（无地址栏/标签页，任务栏独立图标），
//      不是普通浏览器标签页；使用独立 user-data-dir，与日常浏览器会话互不干扰。
//   4) 拉起系统托盘（BlockNexus.exe --tray，原生托盘图标 + 两项菜单：打开应用 / 退出应用）。
//
// 关闭应用窗口只是关闭界面，面板与 Agent 继续在后台运行；再次双击图标秒开。
// 其他用法：
//   node scripts/blocknexus-launcher.js --dry-run        只打印将要执行的动作
//   node scripts/blocknexus-launcher.js --stop           停止本机面板、本地 Agent 与应用窗口
//   node scripts/blocknexus-launcher.js --close-window   只关闭应用窗口（后台继续运行）
//   node scripts/blocknexus-launcher.js --exit-tray      只收掉托盘图标（后台继续运行）

const { spawn, spawnSync, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'data', 'config.json');
const DRY_RUN = process.argv.includes('--dry-run');
const STOP = process.argv.includes('--stop');
const CLOSE_WINDOW = process.argv.includes('--close-window');
const PANEL_ONLY = process.argv.includes('--panel-only');
const OPEN_WINDOW = process.argv.includes('--open-window');
const EXIT_TRAY = process.argv.includes('--exit-tray');

// ---------- 工具 ----------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const cfg = readConfig();
// BLOCKNEXUS_PORT 与 panel/server.js 的约定一致：环境变量优先，其次配置文件，默认 3080
const PANEL_PORT =
  Number(process.env.BLOCKNEXUS_PORT) || Number(cfg.panel && cfg.panel.port) || 3080;
const BASE_URL = `http://127.0.0.1:${PANEL_PORT}`;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(ROOT, 'data', 'launcher.log'), line + '\n');
  } catch {}
}

/** HTTP GET 是否可达（面板就绪探测） */
function httpOk(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 500);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** 本机端口是否已有进程监听 */
function portOpen(port, timeoutMs = 400) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 后台启动一个隐藏窗口的进程（随面板退出不影响本进程） */
function spawnDetached(cmd, args, logFile) {
  const fd = fs.openSync(path.join(ROOT, 'data', logFile), 'a');
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// ---------- 浏览器应用窗口 ----------

/** 应用窗口专用 profile（独立 user-data-dir，与日常浏览器互不干扰） */
function appProfileDir() {
  return path.join(process.env.LOCALAPPDATA || path.join(ROOT, 'data'), 'BlockNexus', 'app-profile');
}

const EDGE_HELPER = path.join(__dirname, 'blocknexus-edge.ps1');

/** 调用 Edge 辅助脚本：list / haswindow / close（PowerShell 5.1 单线程，同步执行足够快） */
function edgeHelper(action, { allowFail = true } = {}) {
  if (!fs.existsSync(EDGE_HELPER)) return null;
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        EDGE_HELPER,
        '-ProfileDir',
        appProfileDir(),
        '-Action',
        action,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
    ).trim();
  } catch (e) {
    // haswindow 用退出码 1 表示「没有窗口」，属正常分支
    if (!allowFail) throw e;
    if (e && e.stdout !== undefined) return String(e.stdout).trim();
    return action === 'haswindow' ? 'no' : null;
  }
}

/**
 * 关闭应用窗口进程组：先请窗口自己关（等同点 X），仍不退出则结束驻留进程组。
 * 这是「空白应用框」的根治手段——启动增强让 Edge 关窗后隐藏驻留，
 * 下次从驻留态恢复可能只渲染出空框，因此关窗/停止时都要真正结束进程组。
 */
function closeAppWindow() {
  if (DRY_RUN) {
    log('[dry-run] 将关闭应用窗口（并结束 Edge 驻留进程组）');
    return;
  }
  const out = edgeHelper('close');
  if (!out || out === 'none') {
    log('应用窗口未在运行');
    return;
  }
  const m = /^closed\s+(\d+)/.exec(out);
  log(`已关闭应用窗口（结束 Edge 进程 ${m ? m[1] : '若干'} 个）`);
}

/**
 * 该 profile 关闭 Edge「启动增强」：关窗即退出，而不是隐藏驻留等下次秒开。
 * 双保险：命令行 --disable-features=msEdgeStartupBoost（进程级）+ Local State
 * startup_boost.enabled=false（兜底，供不带该开关的再次启动使用）。
 * Local State 只在进程组已退出时写入，否则会被运行中的 Edge 覆盖回去。
 */
function disableStartupBoost() {
  const stateFile = path.join(appProfileDir(), 'Local State');
  try {
    if (!fs.existsSync(stateFile)) return;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const boost = state.startup_boost || {};
    if (boost.enabled === false) return;
    state.startup_boost = { ...boost, enabled: false };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    log('已为该 profile 关闭 Edge 启动增强（关窗即退出）');
  } catch (e) {
    log('关闭 Edge 启动增强失败（不影响使用）: ' + (e && e.message ? e.message : e));
  }
}

function findBrowser() {
  const candidates = [
    [process.env['ProgramFiles(x86)'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    [process.env['ProgramFiles'], 'Microsoft\\Edge\\Application\\msedge.exe'],
    [process.env['ProgramFiles'], 'Google\\Chrome\\Application\\chrome.exe'],
    [process.env['ProgramFiles(x86)'], 'Google\\Chrome\\Application\\chrome.exe'],
    [process.env['LOCALAPPDATA'], 'Google\\Chrome\\Application\\chrome.exe'],
  ];
  for (const [base, rest] of candidates) {
    if (!base) continue;
    const p = path.join(base, rest);
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function openAppWindow() {
  const browser = findBrowser();
  if (browser) {
    const profile = appProfileDir();
    if (!DRY_RUN) fs.mkdirSync(profile, { recursive: true });
    const args = [
      // --user-data-dir 必须在 --app 之前：Edge 是单实例，若先解析到 --app 而 profile
      // 还没生效，请求会被已运行的默认 profile 实例接管，面板就被开成普通标签页。
      `--user-data-dir=${profile}`,
      // 与托盘保持一致：明确 profile 目录，确保新建独立进程组而非被默认实例接管
      '--profile-directory=Default',
      `--app=${BASE_URL}/`,
      '--window-size=1300,880',
      '--no-first-run',
      '--no-default-browser-check',
      // 关窗即退出，不驻留后台（该 feature 名未公开，失效时 Local State 兜底）
      '--disable-features=msEdgeStartupBoost',
    ];
    if (DRY_RUN) {
      log('[dry-run] 将打开应用窗口，并在启动前关闭无窗口的驻留进程组');
      return `应用窗口 (${path.basename(browser)})`;
    }

    const resident = edgeHelper('list');
    if (resident && edgeHelper('haswindow') === 'yes') {
      // 已有可见窗口：再发一次启动命令，Edge 会把该窗口带到前台（不是重开）
      log('应用窗口已在运行，聚焦已有窗口');
    } else if (resident) {
      // 只有隐藏的驻留进程组（启动增强关窗后遗留）：结束它，
      // 否则再次唤起可能从驻留态恢复出一个无内容的空白框
      log(`发现 ${resident.split('\n').filter(Boolean).length} 个无窗口的残留 Edge 进程，先结束`);
      closeAppWindow();
      disableStartupBoost();
    } else {
      // 没有进程占用 profile，此时写 Local State 才不会被运行中的 Edge 覆盖
      disableStartupBoost();
    }
    // 经 cmd 的 start（ShellExecute）打开，不能直接 spawn 浏览器：
    // 直接 spawn 时 Chromium 会继承父进程（隐藏的 cmd/node）的显示状态，
    // 窗口要么 SW_HIDE（存在但从不显示，即「空白应用框」），要么最小化。
    // start 走 ShellExecute，显示状态由系统按 SW_SHOWNORMAL 给出，稳定可见。
    // cmd 自身仍隐藏窗口（windowsHide），避免黑框一闪。
    spawn('cmd.exe', ['/c', 'start', '', browser, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return `应用窗口 (${path.basename(browser)})`;
  }
  // 找不到 Edge/Chrome：退回默认浏览器打开（仍可用，只是普通标签页）
  if (!DRY_RUN)
    spawn('cmd.exe', ['/s', '/c', 'start', '', `${BASE_URL}/`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  return '默认浏览器';
}

// ---------- 面板 / 本地 Agent ----------

async function ensurePanel() {
  if (await httpOk(`${BASE_URL}/api/me`)) {
    log(`面板已在运行（${BASE_URL}）`);
    return true;
  }
  if (DRY_RUN) {
    log(`[dry-run] 将后台启动面板: node panel/server.js（端口 ${PANEL_PORT}）`);
    return false;
  }
  log(`启动面板（端口 ${PANEL_PORT}）…`);
  spawnDetached(process.execPath, [path.join(ROOT, 'panel', 'server.js')], 'panel.log');
  for (let i = 0; i < 60; i++) {
    if (await httpOk(`${BASE_URL}/api/me`, 1200)) {
      log('面板已就绪');
      return true;
    }
    await sleep(300);
  }
  log('面板 20 秒内未就绪，仍继续打开窗口（详情见 data/panel.log）');
  return false;
}

const { localInstancesDir } = (() => {
  // 本地 Agent 的实例目录：与 panel/localagent.js 保持一致的专用目录
  // data/local-agents/<serverId>/instances —— 不再用项目根 data/instances，卸载时删得干净
  const dir = path.join(ROOT, 'data', 'local-agents');
  return {
    localInstancesDir: (id) =>
      path.join(dir, String(id).replace(/[^A-Za-z0-9._-]/g, '_'), 'instances'),
  };
})();

/**
 * 拉起本机 Agent。只处理 config.json 中 host 为本机的服务器（远程服务器由各自机器运行 Agent）。
 * listen 模式（默认）：按 Agent 端口去重 + 端口探测，避免重复拉起；
 * inbound 模式：没有本地端口可探测，只在「面板是本次启动」时拉起（面板早已在跑则假定 Agent 已在跑）。
 * 进程与日志由面板托管的同一套专用目录管理（面板已在跑时跳过，交给面板 / 上面的 hint）。
 */
async function startLocalAgents(panelWasRunning) {
  const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
  const seenPorts = new Set();
  for (const s of servers) {
    const host = String(s.host || '').toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') continue;
    const mode = (s.agent && s.agent.mode) || 'outbound';
    const args = ['--token', String(s.token || ''), '--id', String(s.id || '')];
    if (mode === 'inbound') {
      if (panelWasRunning) continue;
      const panelUrl = (s.agent && s.agent.panelUrl) || `ws://127.0.0.1:${PANEL_PORT}`;
      args.unshift('--panel', panelUrl);
    } else {
      const port = Number(s.agent && s.agent.port) || 3099;
      if (seenPorts.has(port)) continue;
      seenPorts.add(port);
      if (await portOpen(port)) {
        log(`Agent 已在监听 ${port} 端口（${s.name || s.id}），跳过`);
        continue;
      }
      if (DRY_RUN) {
        log(`[dry-run] 将启动本地 Agent: ${s.name || s.id} 监听 ${port}`);
        continue;
      }
      args.unshift('--listen', String(port));
    }
    if (DRY_RUN) {
      log(`[dry-run] 将启动本地 Agent: ${s.name || s.id} (${mode})`);
      continue;
    }
    const instDir = localInstancesDir(s.id);
    fs.mkdirSync(instDir, { recursive: true });
    const pid = spawnDetached(
      process.execPath,
      [path.join(ROOT, 'agent', 'agent.js'), '--instances', instDir, ...args],
      'agent.log',
    );
    log(`本地 Agent 已启动（${s.name || s.id}，pid ${pid}，实例目录 ${instDir}）`);
    // 记 pid 到与面板托管同一份 runtime.json：面板侧的停止/卸载能直接接管这个进程
    try {
      const agentDir = path.dirname(instDir);
      const cfgFile = path.join(agentDir, 'agent.json');
      const prev = fs.existsSync(cfgFile)
        ? JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
        : {};
      fs.writeFileSync(
        path.join(agentDir, 'runtime.json'),
        JSON.stringify(
          { pid, startedAt: Date.now(), node: process.execPath, source: 'launcher' },
          null,
          2,
        ),
      );
      if (!prev.instances) {
        fs.writeFileSync(
          cfgFile,
          JSON.stringify({ ...prev, instances: instDir, token: s.token, id: s.id }, null, 2),
        );
      }
    } catch (e) {
      log('写入 Agent 运行态失败（不影响启动）: ' + (e && e.message ? e.message : e));
    }
  }
}

// ---------- 托盘（原生 exe） ----------

/** 托盘 exe：BlockNexus.exe（scripts/build-exe.ps1 用系统自带 csc 编译，图标已内嵌）。
 *  优先用与项目分离的外壳目录（build-exe.ps1 同步维护，root.txt 指回项目根）——
 *  Win11 25H2 上项目文件夹内可能整树托盘注册异常，分离目录可绕开；否则回退项目根。 */
const TRAY_EXE = fs.existsSync(path.join(path.dirname(ROOT), 'BlockNexus', 'BlockNexus.exe'))
  ? path.join(path.dirname(ROOT), 'BlockNexus', 'BlockNexus.exe')
  : path.join(ROOT, 'BlockNexus.exe');

/** 拉起系统托盘图标（exe 内有互斥量，重复启动只会再检测一次，很轻） */
function startTray() {
  if (DRY_RUN) {
    log('[dry-run] 将拉起系统托盘（BlockNexus.exe --tray）');
    return;
  }
  if (!fs.existsSync(TRAY_EXE)) {
    log('未找到 BlockNexus.exe，跳过托盘（运行 scripts\\build-exe.ps1 生成）');
    return;
  }
  try {
    spawn(TRAY_EXE, ['--tray'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    log('托盘启动失败: ' + (e && e.message ? e.message : e));
  }
}

/** 收掉托盘图标（named event 通知已在运行的托盘优雅退出） */
function exitTray() {
  if (DRY_RUN) {
    log('[dry-run] 将退出系统托盘（BlockNexus.exe --exit-tray）');
    return;
  }
  if (!fs.existsSync(TRAY_EXE)) return;
  try {
    spawnSync(TRAY_EXE, ['--exit-tray'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch {}
}

// ---------- 停止 ----------

/** 找出监听指定端口的 PID（netstat -ano） */
function pidsOnPort(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const pids = new Set();
    for (const raw of out.split('\n')) {
      // 形如: TCP  127.0.0.1:3080  0.0.0.0:0  LISTENING  29168
      const cols = raw.trim().split(/\s+/);
      if (cols.length >= 5 && /^LISTENING$/i.test(cols[3]) && cols[1].endsWith(`:${port}`)) {
        pids.add(cols[4]);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function stopAll() {
  closeAppWindow();

  const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
  const ports = [PANEL_PORT];
  for (const s of servers) {
    const host = String(s.host || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      ports.push(Number(s.agent && s.agent.port) || 3099);
    }
  }
  const killed = new Set();
  for (const port of ports) {
    for (const pid of pidsOnPort(port)) {
      if (killed.has(pid)) continue;
      killed.add(pid);
      if (!DRY_RUN) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch {}
      }
      log(`已停止进程 ${pid}（端口 ${port}）`);
    }
  }
  if (!killed.size) log('没有发现正在运行的面板/本地 Agent');

  // 托盘：走 exe 的命名事件优雅退出（没有 panel 运行时也能收掉图标；上面 pids 逻辑没覆盖 GUI 进程）
  exitTray();
}

// ---------- 主流程 ----------

(async () => {
  if (EXIT_TRAY) {
    exitTray();
    return;
  }
  // --close-window / --open-window：浏览器开窗职责已移交 BlockNexus.exe（WebView2 桌面窗口）。
  // 参数保留兼容旧脚本，但不再负责打开/关闭浏览器窗口。
  if (CLOSE_WINDOW || OPEN_WINDOW) {
    log('[window] 应用窗口由 BlockNexus.exe 桌面程序管理，无需处理');
    return;
  }
  if (STOP) {
    stopAll();
    return;
  }
  if (PANEL_ONLY) {
    // BlockNexus.exe（WebView2 桌面外壳）专用：只拉面板 + 本地 Agent，绝不开浏览器窗口
    log('===== 启动 BlockNexus 后台（panel-only，面板端口 ' + PANEL_PORT + '）=====');
    const panelWasRunning = await ensurePanel();
    await startLocalAgents(panelWasRunning);
    return;
  }
  // 直接 node launcher（开发模式）：后台拉起 + 系统默认浏览器打开页面
  log(`===== 启动 BlockNexus（${DRY_RUN ? 'dry-run' : '面板端口 ' + PANEL_PORT}）=====`);
  const panelWasRunning = await ensurePanel();
  await startLocalAgents(panelWasRunning);
  if (DRY_RUN) return;
  log('由系统默认浏览器打开 ' + `${BASE_URL}/`);
  spawn('cmd.exe', ['/s', '/c', 'start', '', `${BASE_URL}/`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
})().catch((e) => {
  log('启动失败: ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
