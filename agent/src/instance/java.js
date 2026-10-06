'use strict';
// BlockNexus Agent — Java 运行时安装（Temurin）与卸载准备
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const { HTTP_UA, downloadToFile } = require('../http.js');
const { sendEvent } = require('../eventbus.js');

// Temurin 兜底安装根目录：每个版本一个 jdk-* 子目录，互不覆盖，可切换/卸载
const JAVA_ROOT = '/opt/blocknexus-java';
// PATH 里指向默认版本的软链（systemd 默认 PATH 含 /usr/local/bin，优先于 /usr/bin）
const JAVA_LINK = '/usr/local/bin/java';
// 从目录名解析大版本：jdk-21.0.5+y → 21，jdk8u432-b06 → 8（Temurin 8 没有 '-'+版本段）
const jdkMajor = (name) => {
  const m = /^jdk-?(\d+)/.exec(name);
  return m ? Number(m[1]) : 0;
};



module.exports = {
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

  // 执行 shell 命令：输出按行转成进度事件；带超时防挂死
  runSh(cmd, sudo, timeoutMs = 600000) {
    return new Promise((resolve) => {
      const full = sudo ? cmd.replace(/^([^&|;]*?)(?=( (?:\||&&|;|$)|$))/, (m) => m + ' ' + sudo) : cmd;
      const child = spawn('sh', ['-c', full], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const chk = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 10000 });
    if (chk.status !== 0) throw new Error('需要 root 或免密 sudo 才能管理 Java');
    return 'sudo ';
  },

  async installJava(requested = 21) {
    if (process.platform === 'win32') {
      throw new Error('Java 管理仅支持 Linux 服务器（Windows 请自行安装 JRE 并加入 PATH）');
    }
    requested = Number(requested) || 21;
    const before = this.javaInfo();
    if (before.installed && before.major === requested) {
      this.emitJava(`已安装并使用 Java ${requested}，无需处理`);
      return { java: before, already: true };
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
    const tmp = `/tmp/blocknexus-jre${major}.tar.gz`;
    for (const url of sources) {
      try {
        this.emitJava(`下载 Temurin JRE ${major}…`, 0);
        await downloadToFile(url, tmp, (got, total) => {
          if (total) {
            this.emitJava(
              `下载 Temurin JRE ${major}… ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`,
              Math.round((got / total) * 100),
            );
          }
        });
        this.emitJava(`解压到 ${JAVA_ROOT}…`);
        await this.runSh(`${sudo}mkdir -p ${JAVA_ROOT}`, sudo, 60000);
        await this.runSh(`${sudo}tar -xzf ${tmp} -C ${JAVA_ROOT}`, sudo, 300000);
        await this.runSh(`${sudo}rm -f ${tmp}`, sudo, 60000);
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
      }
    }
    throw lastErr || new Error('Temurin 下载失败');
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

  // 当前生效 java 的真实路径（跟进软链）；探测不到返回 null
  _realJavaPath() {
    const cmd = this.javaCmd();
    if (!cmd) return null;
    try {
      let p = cmd;
      if (!p.includes('/')) {
        const r = spawnSync('sh', ['-c', 'command -v java'], { encoding: 'utf8', timeout: 10000 });
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
      const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 15000 });
      const out = (r.stderr || '') + (r.stdout || '');
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (r.error || !m) return null;
      const major = Number(m[1]) === 1 ? Number(m[2] || 0) : Number(m[1]);
      return { major, raw: out.split('\n')[0].trim() };
    } catch {
      return null;
    }
  },

  // 列出全部可用的 Java：托管版本（/opt/blocknexus-java/jdk-*）+ 系统包 Java（/usr/bin/java），
  // active 标记当前默认 java 指向的那个；前端按单选列表渲染，勾选即切换。
  listJavas() {
    if (process.platform === 'win32') throw new Error('Java 管理仅支持 Linux 服务器');
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
    if (process.platform === 'win32') throw new Error('Java 管理仅支持 Linux 服务器');
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
    if (process.platform === 'win32') throw new Error('Java 管理仅支持 Linux 服务器');
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
