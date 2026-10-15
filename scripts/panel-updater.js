'use strict';
// 面板自更新执行器：由 panel/api.js 以 **detached 子进程**拉起，独立于面板存活。
//
// 为什么必须是独立进程：面板要把自己替换掉，就不能由它自己动手——它得先退出，
// 释放 node 对程序文件的占用，再由这个进程换文件、重新拉起。
//
// 顺序（每一步都失败即中止，绝不"边换边看"）：
//   1. 等面板真正退出（端口探测 + PID 存活），超时则**什么都不动**直接放弃
//   2. 快照：把将要被替换的文件 + 发布方声明的数据文件 备份到 data/update/backup/<旧版本>/
//   3. 应用：payload（白名单替换）或 git（fetch tags + checkout + 依赖/前端重建）
//   4. 记录不可逆标记（若声明）
//   5. 拉起新进程（Windows: launcher --panel-only；Linux: setsid node panel/server.js）
//   6. 健康检查 /api/version 期望新版本
//   7. 失败 → 回滚程序 + 数据快照 → 拉起旧版 → 结果写 data/update/last-result.json
//
// 安全约束（与 panel/update.js 的 WRITE_DENY 一致）：
//   · 只写白名单路径，data/、root.txt、.git/、web/src/、agent/src/、docs/、desin/ 一律拒绝
//   · 预检**所有**路径后才开始写（避免写到一半才发现越界）
//   · 暂存目录里出现符号链接 → 直接判定更新包异常并中止（防"链接指向外部"）
//
// 用法（由面板生成，不要手敲）：
//   node scripts/panel-updater.js --root <应用根> --stage <暂存目录> --from <旧版本> --to <新版本>
//     --mode payload|git [--tag vX.Y.Z] [--rebuild] [--irreversible]
//     --scheme http --host 127.0.0.1 --port 3080 --pid <面板 PID>
//     [--launch panel-only|full|none] [--data-backup a,b,c]
//     [--log <日志文件>] [--result <结果文件>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const upd = require(path.join(__dirname, '..', 'panel', 'update.js'));

// ---------- 参数 ----------

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

const ROOT = path.resolve(arg('root', path.join(__dirname, '..')));
const STAGE = arg('stage') ? path.resolve(arg('stage')) : '';
const FROM = arg('from', '');
const TO = arg('to', '');
const MODE = arg('mode', 'payload');
const TAG = arg('tag', TO ? `v${TO.replace(/^v/, '')}` : '');
const REBUILD = flag('rebuild');
const BUILD_ONLY = flag('build');
const IRREVERSIBLE = flag('irreversible');
const SCHEME = arg('scheme', 'http') === 'https' ? 'https' : 'http';
const HOST = arg('host', '127.0.0.1');
const PORT = Number(arg('port', '3080')) || 3080;
const PANEL_PID = Number(arg('pid', '0')) || 0;
const LAUNCH = arg('launch', 'panel-only');
const RESTORE = arg('restore') ? path.resolve(arg('restore')) : '';
const DATA_BACKUP = arg('data-backup', '').split(',').map((s) => s.trim()).filter(Boolean);
const LAUNCHER = path.join(ROOT, 'scripts', 'blocknexus-launcher.js');
const UPDATE_DIR = path.join(ROOT, 'data', 'update');
const BACKUP_DIR = path.join(UPDATE_DIR, 'backup', FROM || 'unknown');
const LOG_FILE = arg('log') || path.join(UPDATE_DIR, 'update.log');
const RESULT_FILE = arg('result') || path.join(UPDATE_DIR, 'last-result.json');
// 超时可通过环境变量覆盖：仅用于离线演练/自动化测试（把 60s 压到几秒）
const WAIT_EXIT_MS = Number(process.env.BLOCKNEXUS_UPDATE_WAIT_MS || 60000) || 60000;
const HEALTH_MS = Number(process.env.BLOCKNEXUS_UPDATE_HEALTH_MS || 60000) || 60000;
const MAX_LOG_BYTES = 1024 * 1024;
const KEEP_BACKUPS = 3;

let logFd = null;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (logFd === null) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
      // 日志滚动：超限就先留最后一半，避免更新器日志无限增长
      try {
        const st = fs.statSync(LOG_FILE);
        if (st.size > MAX_LOG_BYTES) {
          const tail = fs.readFileSync(LOG_FILE, 'utf8').slice(-MAX_LOG_BYTES / 2);
          fs.writeFileSync(LOG_FILE, tail);
        }
      } catch {}
      logFd = fs.openSync(LOG_FILE, 'a', 0o600);
      try { fs.chmodSync(LOG_FILE, 0o600); } catch {}
    }
    fs.writeSync(logFd, line);
  } catch {}
  process.stdout.write(line);
}

function writeResult(res) {
  const body = { at: Date.now(), from: FROM, to: TO, mode: MODE, ...res };
  try {
    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true, mode: 0o700 });
    const tmp = `${RESULT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, RESULT_FILE);
  } catch (e) {
    log(`写结果文件失败：${e.message}`);
  }
  return body;
}

// ---------- 小工具 ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 存在但无权限（Windows 上常见）
  }
}

function sleepSync(ms) {
  // 同步睡眠：Atomics.wait 比忙等省 CPU（退避最长 600ms，但没必要自旋）
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 退路：忙等 */ }
  }
}

/** 带重试的原子替换：先写同目录临时文件，再 rename 覆盖；Windows 上 rename 不能覆盖已存在文件 */
function replaceFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.bn-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  fs.copyFileSync(src, tmp);
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      if (process.platform === 'win32') {
        try { fs.rmSync(dest, { force: true }); } catch {}
      }
      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      lastErr = e;
      // 杀软/索引器抢锁（本项目实测过 Win32 1175）：退避后重试
      sleepSync(200 * (i + 1));
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch {}
  throw lastErr || new Error('replace failed');
}

/** 递归列出目录（跳过符号链接；遇到链接直接抛错） */
function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`暂存目录含符号链接：${rel}`);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

function copyToBackup(rel) {
  const src = path.join(ROOT, rel);
  const dest = path.join(BACKUP_DIR, rel);
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return true;
  } catch (e) {
    log(`备份失败 ${rel}：${e.message}`);
    return false;
  }
}

function pruneBackups() {
  try {
    const base = path.join(UPDATE_DIR, 'backup');
    const dirs = fs.readdirSync(base).map((n) => ({ n, t: fs.statSync(path.join(base, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(KEEP_BACKUPS)) {
      fs.rmSync(path.join(base, d.n), { recursive: true, force: true });
      log(`清理旧备份 ${d.n}`);
    }
  } catch {}
}

// ---------- 步骤 ----------

async function waitPanelExit() {
  const url = `${SCHEME}://${HOST}:${PORT}/api/version`;
  const deadline = Date.now() + WAIT_EXIT_MS;
  while (Date.now() < deadline) {
    const res = await httpGet(url, 1000);
    if (res === null && !alive(PANEL_PID)) return true;
    await sleep(500);
  }
  return false;
}

function planPayloadFiles() {
  if (!STAGE || !fs.existsSync(STAGE)) throw new Error(`暂存目录不存在：${STAGE}`);
  const files = walk(STAGE).filter((rel) => rel !== 'manifest.json');
  if (!files.length) throw new Error('暂存目录为空');
  // 预检全部路径：宁可一个都不写，也不写到一半发现越界
  for (const rel of files) {
    const chk = upd.canWritePath(rel);
    if (!chk.ok) throw new Error(`更新包含不允许写入的路径：${rel}`);
  }
  return files;
}

function applyPayload(files) {
  let replaced = 0;
  for (const rel of files) {
    replaceFile(path.join(STAGE, rel), path.join(ROOT, rel));
    replaced++;
  }
  return replaced;
}

function runGit(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (out) log(`git ${args.join(' ')}: ${out.slice(0, 2000)}`);
  return r.status === 0;
}

function applyGit() {
  // 先确认 origin 就是本项目官方仓库：否则 git 形态更新等于"从任意远端拉代码执行"
  const remote = spawnSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const url = String(remote.stdout || '').trim();
  if (remote.status !== 0 || !upd.isOfficialGitRemote(url)) {
    throw new Error(`git 远端不是官方仓库，拒绝更新：${url || '(读取失败)'}`);
  }
  if (!runGit(['fetch', '--tags', '--force', 'origin'])) throw new Error('git fetch 失败');
  const refs = [`refs/tags/${TAG}`, TAG];
  let ok = false;
  for (const ref of refs) {
    if (runGit(['checkout', '--force', ref])) { ok = true; break; }
  }
  if (!ok) throw new Error(`git checkout ${TAG} 失败`);
  if (REBUILD || BUILD_ONLY) {
    if (!runGit(['-c', 'advice.detachedHead=false', 'status'])) throw new Error('git 不可用');
    if (REBUILD) {
      const npm = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 900000, shell: process.platform === 'win32',
      });
      if (npm.status !== 0) throw new Error('npm ci 失败（依赖未安装完整）');
    }
    // web/dist 不在版本库里（构建产物），所以 git 形态每次都必须重建前端
    const build = spawnSync('npm', ['run', 'build:web'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 900000, shell: process.platform === 'win32',
    });
    if (build.status !== 0) throw new Error('npm run build:web 失败');
  }
  return 0;
}

/**
 * 回滚模式：把某个备份目录里的文件原样贴回去。
 * 与 payload 模式的白名单差别：允许恢复**发布方声明过**的数据文件（--data-backup），
 * 因为迁移可能改了 data/config.json，回滚必须连数据一起回；其余 data/ 路径仍然拒绝。
 * 特别注意排除 data/update/ 自身——否则会把备份目录写回自己。
 */
function planRollbackFiles() {
  if (!RESTORE || !fs.existsSync(RESTORE)) throw new Error(`备份目录不存在：${RESTORE}`);
  const allowData = new Set(DATA_BACKUP);
  const files = walk(RESTORE);
  if (!files.length) throw new Error('备份目录为空');
  for (const rel of files) {
    if (rel.startsWith('data/update/')) throw new Error(`备份里不应包含 data/update/：${rel}`);
    const ok = upd.canWritePath(rel).ok || allowData.has(rel);
    if (!ok) throw new Error(`备份里含不允许恢复的路径：${rel}`);
  }
  return files;
}

function applyRollback(files) {
  let restored = 0;
  for (const rel of files) {
    replaceFile(path.join(RESTORE, rel), path.join(ROOT, rel));
    restored++;
  }
  return restored;
}

function restoreFromBackup() {
  let restored = 0;
  if (!fs.existsSync(BACKUP_DIR)) return restored;
  for (const rel of walk(BACKUP_DIR)) {
    replaceFile(path.join(BACKUP_DIR, rel), path.join(ROOT, rel));
    restored++;
  }
  return restored;
}

function launchPanel() {
  if (LAUNCH === 'none') return;
  const node = process.execPath;
  if (process.platform === 'win32') {
    const args = [LAUNCHER];
    if (LAUNCH === 'panel-only') args.push('--panel-only');
    const child = spawn(node, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT });
    child.unref();
    log(`已拉起面板（${LAUNCH}，pid ${child.pid}）`);
    return;
  }
  // Linux：systemd 托管时由调用方先等它自己重启，等不到才会走到这里补一个
  const out = fs.openSync(path.join(ROOT, 'data', 'panel.log'), 'a');
  const child = spawn(node, [path.join(ROOT, 'panel', 'server.js'), '--host', HOST, '--port', String(PORT)], {
    detached: true, stdio: ['ignore', out, out], cwd: ROOT,
  });
  child.unref();
  log(`已拉起面板（node panel/server.js，pid ${child.pid}）`);
}

/** systemd 是否在托管面板（它在的话优先让它自己重启，避免双启抢端口） */
function underSystemd() {
  return process.platform !== 'win32' && !!(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

async function healthCheck(expectVersion, timeoutMs = HEALTH_MS) {
  const url = `${SCHEME}://${HOST}:${PORT}/api/version`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpGet(url, 2000);
    if (res && res.status === 200) {
      try {
        const j = JSON.parse(res.body);
        if (!expectVersion || String(j.version) === String(expectVersion)) return true;
        log(`健康检查：面板已起来但版本仍是 ${j.version}（期望 ${expectVersion}）`);
      } catch {}
    }
    await sleep(1000);
  }
  return false;
}

/** 拉起并做健康检查：systemd 场景先等它自己重启，等不到再补一个 */
async function launchAndCheck(expectVersion) {
  if (underSystemd()) {
    log('检测到 systemd 托管：先等它自动重启面板（最多 15s）');
    if (await healthCheck(expectVersion, 15000)) return true;
    log('systemd 没有把面板拉起来，由更新器补一个');
  }
  launchPanel();
  return healthCheck(expectVersion);
}

// ---------- 主流程 ----------

async function main() {
  if (!TO || !FROM) throw new Error('缺少 --to / --from');
  if (!['payload', 'git', 'rollback'].includes(MODE)) throw new Error(`未知 --mode ${MODE}`);
  log(`=== ${MODE === 'rollback' ? '回滚' : '更新'} ${FROM} → ${TO}（mode=${MODE}, root=${ROOT}）===`);

  const exited = await waitPanelExit();
  if (!exited) throw new Error('等待面板退出超时（未做任何改动）');
  log('面板已退出，开始应用');

  // ---------- 回滚模式：把备份贴回去（含声明过的数据文件） ----------
  if (MODE === 'rollback') {
    const rfiles = planRollbackFiles();
    let restored = 0;
    try {
      restored = applyRollback(rfiles);
    } catch (e) {
      // 回滚到一半失败：不再叠加第二次尝试（避免半新半旧），如实记录并尽量把面板拉起来
      launchPanel();
      const res = writeResult({ ok: false, rolledBack: false, restored, error: `回滚失败：${e.message}` });
      log(`回滚失败（已恢复 ${restored} 个文件）：${JSON.stringify(res)}`);
      return 1;
    }
    const ok = await launchAndCheck(TO);
    writeResult({ ok, rolledBack: true, restored, oldVersionHealthy: ok, error: ok ? '' : '回滚后健康检查失败' });
    pruneBackups();
    log(ok ? `回滚完成：v${TO} 已就绪` : `回滚完成但健康检查未通过（v${TO}）`);
    return ok ? 0 : 1;
  }

  const files = MODE === 'payload' ? planPayloadFiles() : [];
  // 快照：将被替换的程序文件 + 发布方声明的数据文件（迁移可能改它们）
  let backed = 0;
  for (const rel of files) if (copyToBackup(rel)) backed++;
  for (const rel of DATA_BACKUP) if (copyToBackup(rel)) backed++;
  if (MODE === 'git') copyToBackup('package-lock.json');
  log(`已备份 ${backed} 个文件到 ${path.relative(ROOT, BACKUP_DIR)}`);

  let replaced = 0;
  let irreversibleMarked = false;
  try {
    replaced = MODE === 'payload' ? applyPayload(files) : applyGit();
    if (IRREVERSIBLE) {
      fs.writeFileSync(
        path.join(UPDATE_DIR, `irreversible-${TO}.json`),
        JSON.stringify({ version: TO, from: FROM, at: Date.now() }, null, 2),
        { mode: 0o600 },
      );
      irreversibleMarked = true;
      log('已记录不可逆迁移标记（此后不允许自动回滚）');
    }
  } catch (e) {
    log(`应用失败：${e.message}，开始回滚`);
    const restored = restoreFromBackup();
    launchPanel();
    const res = writeResult({ ok: false, rolledBack: restored > 0, restored, error: e.message, irreversible: irreversibleMarked });
    log(`已回滚 ${restored} 个文件；结果：${JSON.stringify(res)}`);
    pruneBackups();
    return 1;
  }

  const healthy = await launchAndCheck(TO);
  if (healthy) {
    log(`健康检查通过：v${TO} 已就绪`);
    writeResult({
      ok: true,
      rolledBack: false,
      replaced,
      backup: path.relative(ROOT, BACKUP_DIR).replace(/\\/g, '/'),
      // 记下"迁移可能改过哪些数据文件"：手动回滚时要按同一份清单恢复数据
      dataBackup: DATA_BACKUP,
    });
    try { if (STAGE) fs.rmSync(STAGE, { recursive: true, force: true }); } catch {}
    pruneBackups();
    return 0;
  }

  // 新版没起来：不可逆迁移之后不允许程序回滚（只保留备份供手动恢复）
  if (irreversibleMarked) {
    const res = writeResult({ ok: false, rolledBack: false, irreversible: true, error: '新版本健康检查失败；因含不可逆迁移未自动回滚' });
    log(`健康检查失败；因不可逆迁移拒绝回滚。结果：${JSON.stringify(res)}`);
    return 1;
  }
  log('健康检查失败，回滚到旧版本');
  const restored = restoreFromBackup();
  const oldOk = await launchAndCheck(FROM);
  const res = writeResult({ ok: false, rolledBack: restored > 0, restored, oldVersionHealthy: oldOk, error: '新版本健康检查失败，已回滚' });
  log(`回滚完成（${restored} 个文件，旧版健康=${oldOk}）。结果：${JSON.stringify(res)}`);
  pruneBackups();
  return 1;
}

main()
  .then((code) => {
    try { if (logFd !== null) fs.closeSync(logFd); } catch {}
    process.exit(code);
  })
  .catch((e) => {
    log(`更新失败（未完成）：${e.message}`);
    writeResult({ ok: false, rolledBack: false, error: e.message });
    try { if (logFd !== null) fs.closeSync(logFd); } catch {}
    process.exit(1);
  });
