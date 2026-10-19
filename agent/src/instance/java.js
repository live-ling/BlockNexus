'use strict';
// BlockNexus Agent — Java 运行时安装（Temurin）与多版本管理
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
//
// 两套平台策略（对上层接口一致：sys.info.java / java.list / java.install / java.use / java.uninstall）：
//   Linux   —— Temurin tar.gz 解到 /opt/blocknexus-java，用 /usr/local/bin/java 软链决定默认版本；
//   Windows —— Temurin **zip** 解到 <Agent 目录>/java，默认版本记录在 java-default.json，
//              启动实例时直接把这个 java.exe 当可执行文件用（Windows 没有全局软链的等价物）。
// 「可卸载」只限落在托管目录里的版本；系统/厂商装的 JDK 出现在列表里但只能切换过去用。

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const { HTTP_UA, downloadToFile } = require('../http.js');
const { sendEvent } = require('../eventbus.js');
const { runCmd, tarCmd } = require('../util.js');

// Temurin 兜底安装根目录（仅 Linux）：每个版本一个 jdk-* 子目录，互不覆盖，可切换/卸载
const JAVA_ROOT = '/opt/blocknexus-java';
// PATH 里指向默认版本的软链（systemd 默认 PATH 含 /usr/local/bin，优先于 /usr/bin）
const JAVA_LINK = '/usr/local/bin/java';
// 从目录名解析大版本：jdk-21.0.5+y → 21，jdk8u432-b06 → 8（Temurin 8 没有 '-'+版本段）
const jdkMajor = (name) => {
  const m = /^jdk-?(\d+)/.exec(name);
  return m ? Number(m[1]) : 0;
};

const isWin = () => process.platform === 'win32';

/** 路径是否相同（Windows 大小写不敏感、盘符大小写也常不一致） */
function samePath(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(String(a));
  const nb = path.resolve(String(b));
  return isWin() ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** Java 目录下可执行文件的路径 */
function javaExeIn(dir) {
  return path.join(dir, 'bin', isWin() ? 'java.exe' : 'java');
}



module.exports = {
  // ---------- 平台相关的路径 / 默认版本记录 ----------

  /** 托管 Java 的根目录：Linux 走 /opt/blocknexus-java，Windows 放在 Agent 目录旁（与 instances 同级） */
  javaRoot() {
    return isWin() ? path.join(path.dirname(this.dir), 'java') : JAVA_ROOT;
  },

  /** Windows：记录「面板里选中的 java.exe」的小文件（Linux 用软链，不需要它） */
  _winJavaFile() {
    return path.join(path.dirname(this.dir), 'java-default.json');
  },

  /** Windows：读当前选中的 java.exe；没选过返回 '' */
  _winJavaChosen() {
    try {
      const j = JSON.parse(fs.readFileSync(this._winJavaFile(), 'utf8'));
      return j && typeof j.path === 'string' ? j.path : '';
    } catch {
      return '';
    }
  },

  /** Windows：写入/清除选中的 java.exe（null 表示回到 PATH 里的 java） */
  _winJavaSetChosen(exe) {
    this._javaCmd = null; // 让 javaCmd() 重新探测
    try {
      if (!exe) {
        fs.rmSync(this._winJavaFile(), { force: true });
        return;
      }
      fs.writeFileSync(this._winJavaFile(), JSON.stringify({ path: exe }, null, 2));
    } catch (e) {
      throw new Error('保存 Java 选择失败: ' + e.message);
    }
  },

  /** Windows：`where java` 的第一个结果（PATH 上的 java.exe） */
  _whereJava() {
    try {
      const r = spawnSync('where', ['java'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      return first && fs.existsSync(first) ? first : '';
    } catch {
      return '';
    }
  },

  /**
   * Windows：枚举所有能找到的 Java 安装目录。
   * 顺序：托管目录 → 常见厂商目录（Program Files 下）→ JAVA_HOME → PATH 上的 java。
   * 返回 [{ dir, exe }]，按目录去重（大小写不敏感）。
   */
  _winJavaDirs() {
    const out = new Map();
    const add = (dir) => {
      if (!dir) return;
      const abs = path.resolve(dir);
      const exe = javaExeIn(abs);
      try {
        if (!fs.existsSync(exe)) return;
      } catch {
        return;
      }
      const key = abs.toLowerCase();
      if (!out.has(key)) out.set(key, { dir: abs, exe });
    };
    const addChildren = (root) => {
      add(root); // 根目录本身可能就是 JDK
      try {
        for (const d of fs.readdirSync(root)) add(path.join(root, d));
      } catch {}
    };

    // 我们自己装的（Temurin zip 解压出来是 jdk-* 目录）
    try {
      addChildren(this.javaRoot());
    } catch {}
    const pf = process.env.ProgramFiles;
    const pf86 = process.env['ProgramFiles(x86)'];
    const local = process.env.LOCALAPPDATA;
    const profile = process.env.USERPROFILE || os.homedir();
    for (const root of [
      pf && path.join(pf, 'Java'),
      pf && path.join(pf, 'Eclipse Adoptium'),
      pf && path.join(pf, 'Microsoft'),
      pf && path.join(pf, 'Zulu'),
      pf && path.join(pf, 'BellSoft'),
      pf && path.join(pf, 'Amazon Corretto'),
      pf && path.join(pf, 'Semeru'),
      pf86 && path.join(pf86, 'Java'),
      local && path.join(local, 'Programs', 'Eclipse Adoptium'),
      // IntelliJ / IDEA 下载的 JDK 默认放这里，很常见
      profile && path.join(profile, '.jdks'),
    ]) {
      if (root) addChildren(root);
    }
    if (process.env.JAVA_HOME) add(process.env.JAVA_HOME);
    const pathJava = this._whereJava();
    if (pathJava) add(path.dirname(path.dirname(pathJava)));
    return [...out.values()];
  },

  /** 该目录是否在托管根目录下（只有这些允许卸载） */
  _isManagedJavaDir(dir) {
    const root = path.resolve(this.javaRoot());
    const abs = path.resolve(String(dir || ''));
    const norm = (s) => (isWin() ? s.toLowerCase() : s);
    return norm(abs).startsWith(norm(root) + path.sep);
  },

  // ---------- 卸载前准备：停止所有实例，可选把备份打包到安装目录外 ----------
  async prepareUninstall(opts = {}) {
    const stopped = [];
    for (const rec of this.map.values()) {
      if (rec.proc) {
        this.emitConsole(rec, '[BlockNexus] 卸载 Agent：正在停止实例…');
        await this.stopAndWait(rec, 30000, false);
        stopped.push(rec.meta.name);
      }
    }

    let backupFile = null;
    if (opts.keepBackups) {
      const backupRoot = path.join(this.dir, '.backups');
      if (fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).length) {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        // 归档放在安装目录之外（卸载时删除安装目录不会波及），
        // tar 在父目录执行、参数全用相对路径：既避免把归档自身打进去，
        // 也避开 GNU tar 把 Windows 绝对路径里的盘符当成远程主机的问题
        const instAbs = path.resolve(this.dir);
        const parentDir = path.dirname(instAbs);
        const instName = path.basename(instAbs);
        const tarName = `blocknexus-backups-${stamp}.tar.gz`;
        await this.tarRun(['-czf', tarName, '-C', instName, '.backups'], parentDir);
        backupFile = path.join(parentDir, tarName);
        fs.rmSync(backupRoot, { recursive: true, force: true });
      }
    }

    return { stopped, backupFile };
  },

  // ---------- Java 安装（异步任务：立即返回，进度与结果走事件） ----------
  emitJava(msg, pct) {
    sendEvent('install.progress', { phase: 'java', msg: String(msg).slice(0, 240), pct });
  },

  /**
   * 下载进度节流：downloadToFile 是**按块**回调的，几十 MB 会产生几百次事件，
   * 全量推给面板会刷屏 SSE 与前端状态。这里按「百分比前进 ≥ 2 或整 MB 变化」节流。
   */
  _downloadProgress(label) {
    let lastPct = -1;
    let lastMB = -1;
    return (got, total) => {
      if (!total) return;
      const pct = Math.round((got / total) * 100);
      const mb = Math.floor(got / 1048576);
      if (pct - lastPct < 2 && mb === lastMB) return;
      lastPct = pct;
      lastMB = mb;
      this.emitJava(`${label} ${mb}/${Math.floor(total / 1048576)} MB`, pct);
    };
  },

  // 执行 shell 命令：输出按行转成进度事件；带超时防挂死
  runSh(cmd, sudo, timeoutMs = 600000) {
    return new Promise((resolve) => {
      const full = sudo ? cmd.replace(/^([^&|;]*?)(?=( (?:\||&&|;|$)|$))/, (m) => m + ' ' + sudo) : cmd;
      const child = spawn('sh', ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      const collect = (d) => {
        out += d.toString();
        const lines = out.split('\n');
        out = lines.pop();
        const last = lines.filter((l) => l.trim()).pop();
        if (last) this.emitJava(last.trim().slice(0, 200));
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(killer);
        resolve({ code, out });
      });
      child.on('error', (e) => {
        clearTimeout(killer);
        resolve({ code: -1, out: 'spawn 失败: ' + e.message });
      });
    });
  },

  // root 或免密 sudo 校验，返回命令前缀；不可用直接抛错
  ensureSudo() {
    const isRoot = !(process.getuid && process.getuid() !== 0);
    if (isRoot) return '';
    const chk = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (chk.status !== 0) throw new Error('需要 root 或免密 sudo 才能管理 Java');
    return 'sudo ';
  },

  async installJava(requested = 21) {
    requested = Number(requested) || 21;
    const before = this.javaInfo();
    if (before.installed && before.major === requested) {
      this.emitJava(`已安装并使用 Java ${requested}，无需处理`);
      return { java: before, already: true };
    }
    // Windows：没有 root/软链那一套，装到 Agent 目录旁的 java/ 并记为默认版本
    if (isWin()) {
      await this.installTemurinWin(requested);
      this._javaCmd = null;
      const after = this.javaInfo();
      if (!after.installed) throw new Error('Java 安装后未探测到可用的 java');
      this.emitJava(`✓ Java ${requested} 就绪`);
      return { java: after };
    }
    // 统一走 Temurin：版本齐全（8/11/17/21/25 都有）、每版本独立目录，
    // 装/切/卸都在 /opt/blocknexus-java 内闭环；系统包 Java 仍可通过「设为默认」切回
    const sudo = this.ensureSudo();
    await this.installTemurin(requested, sudo);
    this._javaCmd = null;
    const after = this.javaInfo();
    if (!after.installed) throw new Error('Java 安装后未探测到可用的 java');
    if (after.major !== requested) {
      this.emitJava(`⚠ 默认 java 仍是 ${after.major}（未覆盖非本面板创建的链接）`);
    }
    this.emitJava(`✓ Java ${requested} 就绪`);
    return { java: after };
  },

  // Temurin JRE 兜底：优先清华 TUNA 镜像（国内快），再走 Adoptium 官方 API。
  // 目录页按文件名升序列出，取最后一个匹配即最新版本。
  async installTemurin(major = 21, sudo) {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const base = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/${arch}/linux/`;
    const sources = [];
    const html = await this.httpGetText(base);
    const hits = [...html.matchAll(new RegExp('href="(OpenJDK' + major + 'U-jre_' + arch + '_linux_hotspot_[^"]+\\.tar\\.gz)"', 'g'))];
    if (hits.length) sources.push(base + hits[hits.length - 1][1]);
    // Adoptium 官方 API（302/307 → github release）
    sources.push(
      `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jre/hotspot/normal/eclipse`,
    );

    let lastErr = null;
    // ⚠ 必须用 mkdtemp 造**私有且不可预测**的目录，不能用固定的
    //   /tmp/blocknexus-jre${major}.tar.gz：/tmp 全局可写，服务器上任意本地低权限用户
    //   都能**抢先**在那个固定路径放符号链接或投毒文件。随后 Agent（通常以 root 运行）
    //   的下载会顺着链接写到任意路径，而 `tar -xzf` 更是直接以 root 执行攻击者的包
    //   = 本地提权到 root。mkdtemp 建的目录权限 700 且名字随机，别人猜不到也进不去。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocknexus-jre-'));
    const tmp = path.join(tmpDir, `jre${major}.tar.gz`);
    for (const url of sources) {
      try {
        this.emitJava(`下载 Temurin JRE ${major}…`, 0);
        await downloadToFile(url, tmp, this._downloadProgress(`下载 Temurin JRE ${major}…`));
        this.emitJava(`解压到 ${JAVA_ROOT}…`);
        await this.runSh(`${sudo}mkdir -p ${JAVA_ROOT}`, sudo, 60000);
        await this.runSh(`${sudo}tar -xzf ${tmp} -C ${JAVA_ROOT}`, sudo, 300000);
        await this.runSh(`${sudo}rm -rf ${tmpDir}`, sudo, 60000);
        const dirs = fs.readdirSync(JAVA_ROOT).filter((d) => jdkMajor(d) === major);
        if (!dirs.length) throw new Error('解压后未找到 JDK 目录');
        const jdk = path.join(JAVA_ROOT, dirs[dirs.length - 1]);
        // 让 PATH 里的 java 指向新 JDK（systemd 默认 PATH 含 /usr/local/bin）
        const linkPath = JAVA_LINK;
        let canLink = true;
        try {
          const cur = fs.readlinkSync(linkPath);
          // 只覆盖我们自己建的链接（指向本 Agent 的 JAVA_ROOT）
          canLink = cur.includes(JAVA_ROOT);
        } catch {
          canLink = true; // 不存在
        }
        if (canLink) {
          await this.runSh(`${sudo}ln -sf ${jdk}/bin/java ${linkPath}`, sudo, 60000);
          this.emitJava('已将 java 链接到 ' + jdk);
        } else {
          this.emitJava('⚠ 已存在自定义 ' + linkPath + '，未覆盖；如需使用请手动切换');
        }
        return true;
      } catch (e) {
        lastErr = e;
        this.emitJava('下载源失败: ' + e.message);
        // 该源失败也要清掉临时目录，否则每个失败的镜像源都会漏一个 ~50MB 的 tar 在 /tmp
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
    throw lastErr || new Error('Temurin 下载失败');
  },

  /**
   * Windows 版 Temurin 安装：下载 zip → 解压到 <Agent 目录>/java → 记为默认版本。
   *
   * 为什么不用安装器（.msi）而是 zip：面板是无人值守的，MSI 会弹 UAC/安装向导；
   * zip 解压即可用，和 Linux 侧「每版本一个目录」的模型完全一致（可切换、可卸载）。
   * 解压用系统自带 bsdtar（Win10 1803+ 的 tar.exe 支持 zip），失败再退回 PowerShell。
   */
  async installTemurinWin(major = 21) {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const root = this.javaRoot();
    fs.mkdirSync(root, { recursive: true });
    const sources = [];
    // 清华镜像目录页（国内快）：文件名形如 OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip
    try {
      const base = `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/${arch}/windows/`;
      const html = await this.httpGetText(base);
      const hits = [
        ...html.matchAll(new RegExp('href="(OpenJDK' + major + 'U-jre_' + arch + '_windows_hotspot_[^"]+\\.zip)"', 'g')),
      ];
      if (hits.length) sources.push(base + hits[hits.length - 1][1]);
    } catch (e) {
      this.emitJava('镜像目录不可用，改用 Adoptium 官方源: ' + e.message);
    }
    sources.push(`https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/${arch}/jre/hotspot/normal/eclipse`);

    // 临时下载目录放在 Agent 托管目录下（<Agent>/tmp），不往系统 %TEMP% 里丢东西：
    // 运行时产物都收敛在面板/Agent 目录内，便于排查与清理，也不受 %TEMP% 权限影响。
    const tmpRoot = path.join(path.dirname(root), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'jre-'));
    const tmp = path.join(tmpDir, `jre${major}.zip`);
    let lastErr = null;
    try {
      for (const url of sources) {
        try {
          this.emitJava(`下载 Temurin JRE ${major}（Windows）…`, 0);
          await downloadToFile(url, tmp, this._downloadProgress(`下载 Temurin JRE ${major}…`));
          this.emitJava(`解压到 ${root}…`);
          await this._unzipTo(tmp, root);
          const dirs = fs
            .readdirSync(root)
            .filter((d) => jdkMajor(d) === major && fs.existsSync(javaExeIn(path.join(root, d))))
            .sort();
          if (!dirs.length) throw new Error('解压后未找到 Java 目录');
          const exe = javaExeIn(path.join(root, dirs[dirs.length - 1]));
          this._winJavaSetChosen(exe);
          this.emitJava('已把默认 Java 指向 ' + exe);
          return true;
        } catch (e) {
          lastErr = e;
          this.emitJava('下载源失败: ' + e.message);
        }
      }
      throw lastErr || new Error('Temurin 下载失败');
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  },

  /** 解压 zip：优先系统 tar（bsdtar），失败退回 PowerShell Expand-Archive */
  async _unzipTo(zipFile, dir) {
    try {
      await runCmd(tarCmd(), ['-xf', zipFile, '-C', dir], 300000);
      return;
    } catch (e1) {
      const q = (s) => String(s).replace(/'/g, "''");
      try {
        await runCmd(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${q(zipFile)}' -DestinationPath '${q(dir)}' -Force`,
          ],
          300000,
        );
      } catch (e2) {
        throw new Error(`解压失败：${e1.message} / ${e2.message}`);
      }
    }
  },

  async httpGetText(urlStr, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const req = https.get(urlStr, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    });
  },

  // 后台任务包装：java.install 立即返回，进度与结果走事件（避免面板侧请求超时误报）
  startJavaInstall(requested = 21) {
    if (this.javaJob) return false;
    this.javaJob = (async () => {
      try {
        const r = await this.installJava(requested);
        sendEvent('java.updated', { done: true, ok: true, requested, java: r.java });
      } catch (e) {
        sendEvent('java.updated', { done: true, ok: false, error: e.message });
      } finally {
        this.javaJob = null;
      }
    })();
    return true;
  },

  // ---------- Java 多版本管理：列表 / 切换 / 卸载 ----------

  // 当前生效 java 的真实路径（跟进软链 / javapath shim）；探测不到返回 null
  _realJavaPath() {
    const cmd = this.javaCmd();
    if (!cmd) return null;
    try {
      if (isWin()) {
        const p = path.isAbsolute(cmd) ? cmd : this._whereJava();
        return p ? fs.realpathSync(p) : null;
      }
      let p = cmd;
      if (!p.includes('/')) {
        const r = spawnSync('sh', ['-c', 'command -v java'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        if (r.status !== 0 || !r.stdout.trim()) return null;
        p = r.stdout.trim();
      }
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  },

  // 运行指定 java 可执行文件取版本信息（javaInfo 的指定路径版）
  _javaInfoOf(cmd) {
    try {
      const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const out = (r.stderr || '') + (r.stdout || '');
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (r.error || !m) return null;
      const major = Number(m[1]) === 1 ? Number(m[2] || 0) : Number(m[1]);
      return { major, raw: out.split('\n')[0].trim() };
    } catch {
      return null;
    }
  },

  // 列出全部可用的 Java，active 标记当前生效的那个；前端按单选列表渲染，勾选即切换。
  // Linux：托管版本（/opt/blocknexus-java/jdk-*）+ 系统包（/usr/bin/java）
  // Windows：托管目录 + Program Files 下各厂商 JDK + JAVA_HOME + PATH 上的 java
  listJavas() {
    if (isWin()) {
      const activeExe = this._realJavaPath();
      const managed = [];
      const seen = new Set();
      for (const c of this._winJavaDirs()) {
        const info = this._javaInfoOf(c.exe);
        if (!info) continue;
        let realExe = c.exe;
        try {
          realExe = fs.realpathSync(c.exe);
        } catch {}
        const key = realExe.toLowerCase();
        if (seen.has(key)) continue; // javapath shim 与真实目录指向同一个 java 时只留一条
        seen.add(key);
        managed.push({
          path: c.dir,
          name: path.basename(c.dir),
          major: info.major,
          raw: info.raw,
          active: !!activeExe && samePath(realExe, activeExe),
          // 只有托管目录里的版本允许卸载（外部装的 JDK 我们不动）
          removable: this._isManagedJavaDir(c.dir),
        });
      }
      managed.sort((a, b) => a.major - b.major || a.name.localeCompare(b.name));
      return { active: this.javaInfo(), managed, system: null };
    }
    const activeReal = this._realJavaPath();
    const activeIsManaged = !!activeReal && activeReal.startsWith(JAVA_ROOT + path.sep);
    let managed = [];
    try {
      managed = fs
        .readdirSync(JAVA_ROOT)
        .map((d) => {
          const full = path.join(JAVA_ROOT, d);
          const bin = path.join(full, 'bin', 'java');
          if (!fs.existsSync(bin)) return null;
          let active = false;
          try {
            active = !!activeReal && activeReal === fs.realpathSync(bin);
          } catch {
            active = false;
          }
          return { path: full, name: d, major: jdkMajor(d), active };
        })
        .filter(Boolean)
        .sort((a, b) => a.major - b.major || a.name.localeCompare(b.name));
    } catch {
      // JAVA_ROOT 不存在 → 尚未通过面板装过
    }
    // 系统包 Java（apt/dnf/apk 装的）：面板不负责它的安装与卸载，但可以切换过去用
    let system = null;
    if (fs.existsSync('/usr/bin/java')) {
      const info = this._javaInfoOf('/usr/bin/java');
      if (info) {
        system = {
          path: 'system',
          name: 'system',
          major: info.major,
          raw: info.raw,
          active: !!activeReal && !activeIsManaged,
        };
      }
    }
    return { active: this.javaInfo(), managed, system };
  },

  // 切换默认 Java：target 为托管目录绝对路径，或 'system'（摘掉我们的软链、用回系统包）
  async switchJava(target) {
    // Windows：没有可用的全局软链，改为记录「默认 java.exe」，启动实例时直接用它
    if (isWin()) {
      if (String(target) === 'system') {
        this._winJavaSetChosen(null);
        const after = this.javaInfo();
        if (!after.installed) throw new Error('已切换为系统 Java，但 PATH 里探测不到可用的 java');
        return { java: after };
      }
      const full = path.resolve(String(target || ''));
      const exe = javaExeIn(full);
      if (!fs.existsSync(exe)) throw new Error('无效的 Java 目录');
      this._winJavaSetChosen(exe);
      const after = this.javaInfo();
      if (!after.installed) throw new Error('切换后未探测到可用的 java');
      return { java: after };
    }
    const sudo = this.ensureSudo();
    if (String(target) === 'system') {
      let cur = null;
      try {
        cur = fs.readlinkSync(JAVA_LINK);
      } catch {
        // 链接不存在 → 已在用系统 java
      }
      if (cur && cur.includes(JAVA_ROOT)) {
        await this.runSh(`${sudo}rm -f ${JAVA_LINK}`, sudo, 60000);
      }
      this._javaCmd = null;
      const after = this.javaInfo();
      if (!after.installed) throw new Error('已切换为系统 Java，但未探测到可用的 java（系统未装 OpenJDK？）');
      return { java: after };
    }
    const full = path.resolve(String(target || ''));
    if (!full.startsWith(JAVA_ROOT + path.sep) || !fs.existsSync(path.join(full, 'bin', 'java'))) {
      throw new Error('无效的 Java 目录');
    }
    await this.runSh(`${sudo}ln -sfn ${full}/bin/java ${JAVA_LINK}`, sudo, 60000);
    this._javaCmd = null;
    const after = this.javaInfo();
    if (!after.installed) throw new Error('切换后未探测到可用的 java');
    return { java: after };
  },

  // 卸载托管 Java：只允许删 /opt/blocknexus-java 下的 jdk-* 目录。
  // 若删的是正在使用的版本，先回退到其余托管版本（取最高），没有托管版本则回退系统包；
  // 两者都没有时拒绝卸载（避免服务器从此没有可用的 java）。
  async uninstallJava(target) {
    // Windows：只删托管目录下的版本；若删的是当前默认，先回退到其它版本或 PATH 上的 java
    if (isWin()) {
      const full = path.resolve(String(target || ''));
      if (!this._isManagedJavaDir(full)) throw new Error('只能卸载通过面板安装的 Java');
      if (!fs.existsSync(javaExeIn(full))) throw new Error('该目录不是有效的 Java 安装');
      const { managed } = this.listJavas();
      const isActive = managed.some((j) => samePath(j.path, full) && j.active);
      if (isActive) {
        const fallback = managed
          .filter((j) => !samePath(j.path, full))
          .sort((a, b) => b.major - a.major)[0];
        if (fallback) {
          this._winJavaSetChosen(javaExeIn(fallback.path));
          this.emitJava(`默认 Java 已切换到 ${fallback.name}`);
        } else if (this._whereJava()) {
          this._winJavaSetChosen(null); // 回退到 PATH 里的 java
        } else {
          throw new Error('这是唯一可用的 Java，卸载后将无法启动任何实例；请先安装其他版本');
        }
      }
      fs.rmSync(full, { recursive: true, force: true });
      this._javaCmd = null;
      return { java: this.javaInfo() };
    }
    const full = path.resolve(String(target || ''));
    if (!full.startsWith(JAVA_ROOT + path.sep) || !/^jdk-/.test(path.basename(full))) {
      throw new Error('只能卸载通过面板安装的 Temurin Java');
    }
    if (!fs.existsSync(path.join(full, 'bin', 'java'))) throw new Error('该目录不是有效的 Java 安装');
    const sudo = this.ensureSudo();
    const { managed } = this.listJavas();
    const isActive = managed.some((j) => j.path === full && j.active);
    if (isActive) {
      const fallback = managed
        .filter((j) => j.path !== full)
        .sort((a, b) => b.major - a.major)[0];
      if (fallback) {
        await this.runSh(`${sudo}ln -sfn ${fallback.path}/bin/java ${JAVA_LINK}`, sudo, 60000);
        this.emitJava(`默认 Java 已切换到 ${fallback.name}`);
      } else if (fs.existsSync('/usr/bin/java')) {
        await this.runSh(`${sudo}rm -f ${JAVA_LINK}`, sudo, 60000); // 回退系统包
      } else {
        throw new Error('这是唯一可用的 Java，卸载后将无法启动任何实例；请先安装其他版本');
      }
    }
    await this.runSh(`${sudo}rm -rf ${full}`, sudo, 300000);
    this._javaCmd = null;
    return { java: this.javaInfo() };
  }
};
