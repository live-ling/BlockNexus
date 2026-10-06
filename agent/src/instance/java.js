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

  async installJava(requested = 21) {
    const before = this.javaInfo();
    if (before.installed && before.major >= requested) {
      this.emitJava(`已安装 Java ${before.major}，无需处理`);
      return { java: before, already: true };
    }

    this.emitJava('检测系统与包管理器…');
    const isRoot = !(process.getuid && process.getuid() !== 0);
    let sudo = '';
    if (!isRoot) {
      const chk = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8', timeout: 10000 });
      if (chk.status !== 0) throw new Error('需要 root 或免密 sudo 才能安装 Java');
      sudo = 'sudo ';
    }
    const which = (c) => spawnSync('sh', ['-c', 'command -v ' + c], { timeout: 10000 }).status === 0;
    const tried = [];
    let ok = false;
    // 各发行版对同版本 Java 的包名不同，逐个试；全失败还有 Temurin 镜像兜底
    const pkgLists = {
      apt: requested > 17
        ? [`openjdk-${requested}-jre-headless`, ...(requested !== 21 ? ['openjdk-21-jre-headless'] : []), 'openjdk-17-jre-headless']
        : [`openjdk-${requested}-jre-headless`],
      dnf: [`java-${requested}-openjdk-headless`, ...(requested !== 21 ? ['java-latest-openjdk-headless'] : [])],
      apk: [`openjdk${requested}-jre-headless`],
    };

    if (which('apt-get')) {
      this.emitJava('更新软件包索引（apt-get update）…');
      await this.runSh(sudo + 'apt-get update -y', sudo); // 失败也继续（缓存的索引可能够用）
      for (const pkg of pkgLists.apt) {
        this.emitJava(`尝试安装 ${pkg}…`);
        tried.push(pkg);
        const r = await this.runSh(`${sudo}apt-get install -y ${pkg}`, sudo, 900000);
        if (r.code === 0) {
          ok = true;
          break;
        }
      }
    } else if (which('dnf') || which('yum')) {
      const pm = which('dnf') ? 'dnf' : 'yum';
      for (const pkg of pkgLists.dnf) {
        this.emitJava(`尝试安装 ${pkg}…`);
        tried.push(pkg);
        const r = await this.runSh(`${sudo}${pm} install -y ${pkg}`, sudo, 900000);
        if (r.code === 0) {
          ok = true;
          break;
        }
      }
    } else if (which('apk')) {
      for (const pkg of pkgLists.apk) {
        this.emitJava(`尝试安装 ${pkg}…`);
        tried.push(pkg);
        const r = await this.runSh(`${sudo}apk add --no-cache ${pkg}`, sudo, 900000);
        if (r.code === 0) {
          ok = true;
          break;
        }
      }
    } else {
      this.emitJava('无法识别包管理器（仅支持 apt/dnf/yum/apk），改用 Temurin 镜像下载…');
    }

    let after = this.javaInfo();
    // 发行源装不到目标版本（例如 Debian 12 只有 17，而 MC 1.20.5+ 需要 21）时，
    // 从 TUNA/Adoptium 下载 Temurin JRE 兜底
    if (!after.installed || after.major < requested) {
      try {
        this.emitJava(`发行源中没有合适的 Java ${requested}，尝试下载 Temurin JRE ${requested}…`);
        await this.installTemurin(requested, sudo);
        after = this.javaInfo();
      } catch (e) {
        this.emitJava('Temurin 下载失败: ' + e.message);
      }
    }

    if (!after.installed) {
      this.emitJava('✗ Java 安装失败，已尝试: ' + tried.join(', '));
      throw new Error('Java 安装失败（已尝试: ' + (tried.join(', ') || '无可用方式') + '），请手动安装 JDK ' + requested);
    }
    if (after.major < requested) {
      this.emitJava(`⚠ 当前 Java ${after.major} 可运行 1.20.4 及更早版本；MC 1.20.5+ 需要 Java 21`);
    }
    this.emitJava(`✓ Java ${after.major} 就绪`);
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
        this.emitJava('解压到 /opt/blocknexus-java…');
        await this.runSh(`${sudo}mkdir -p /opt/blocknexus-java`, sudo, 60000);
        await this.runSh(`${sudo}tar -xzf ${tmp} -C /opt/blocknexus-java`, sudo, 300000);
        await this.runSh(`${sudo}rm -f ${tmp}`, sudo, 60000);
        const dirs = fs.readdirSync('/opt/blocknexus-java').filter((d) => d.startsWith('jdk-' + major));
        if (!dirs.length) throw new Error('解压后未找到 JDK 目录');
        const jdk = path.join('/opt/blocknexus-java', dirs[dirs.length - 1]);
        // 让 PATH 里的 java 指向新 JDK（systemd 默认 PATH 含 /usr/local/bin）
        const linkPath = '/usr/local/bin/java';
        let canLink = true;
        try {
          const cur = fs.readlinkSync(linkPath);
          // 只覆盖我们自己建的链接（含 MCPan 时代旧路径 /opt/mcpan-java）
          canLink = cur.includes('blocknexus-java') || cur.includes('mcpan-java');
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
  }
};
