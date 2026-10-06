'use strict';
// BlockNexus Agent — 实例生命周期（启动/停止/重启/删除/控制台指令）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { spawnSync } = require('child_process');
const { PAPERCLIP_SOURCES } = require('../catalog.js');
const { fmtSize } = require('../util.js');
const { sendEvent } = require('../eventbus.js');



module.exports = {
  // java 可执行文件：优先 PATH 里的 java，找不到再看 /usr/local/bin（Temurin 兜底安装位置）。
  // 只缓存命中的结果；都没命中时返回 null（装好 Java 后下次调用会重新探测）。
  javaCmd() {
    if (this._javaCmd) return this._javaCmd;
    const probe = (c) => {
      const r = spawnSync(c, ['-version'], { encoding: 'utf8', timeout: 15000 });
      return !r.error && /version "/.test((r.stderr || '') + (r.stdout || ''));
    };
    if (probe('java')) this._javaCmd = 'java';
    else if (probe('/usr/local/bin/java')) this._javaCmd = '/usr/local/bin/java';
    return this._javaCmd || null;
  },

  javaInfo() {
    try {
      const cmd = this.javaCmd();
      if (!cmd) return { installed: false };
      const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', timeout: 15000 });
      const out = (r.stderr || '') + (r.stdout || '');
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      if (r.error || !m) return { installed: false };
      const major = Number(m[1]) === 1 ? Number(m[2] || 0) : Number(m[1]);
      return { installed: true, major, raw: out.split('\n')[0].trim() };
    } catch {
      return { installed: false };
    }
  },

  /**
   * 启动实例。
   * 并发去重：Paper 系（Paper/Purpur/Folia）在 spawn 之前要先等原版核心预下载，
   * 这个 await 期间 rec.proc 还是空，若不加锁，第二次启动请求会再走一遍并 spawn
   * 出第二个 java 进程，两个进程抢同一个 world → session.lock 崩溃。
   * 因此第二个请求直接复用第一个的进行中任务（返回同一个结果，不做二次启动）。
   */
  start(name) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例已在运行');
    if (rec.startJob) return rec.startJob; // 启动进行中 → 复用同一结果
    if (rec.meta.installState === 'downloading') throw new Error('核心还在下载/安装中');
    if (rec.meta.installState === 'failed') throw new Error('上次安装失败，请点「重试安装」');
    // 上次启动留下的取消标记不能影响这一次（例如上次在读完配置前就因别的错误失败了）
    rec.startCancelled = false;
    const job = this.doStart(name, rec).finally(() => {
      if (rec.startJob === job) rec.startJob = null;
    });
    rec.startJob = job;
    // statusOf 据此把状态判定为「启动中」，避免预下载期间界面显示已停止又被点一次启动
    this.emitUpdated(rec);
    return job;
  },

  async doStart(name, rec) {
    const dir = path.join(this.dir, name);
    // 启动方式由安装阶段写入 meta.launch：直连 jar / 安装器产物（Fabric 启动器 jar、Forge 参数文件）
    const launch = rec.meta.launch || { kind: 'jar', file: 'server.jar' };
    if (launch.kind === 'jar') {
      if (!fs.existsSync(path.join(dir, launch.file))) {
        throw new Error(`${launch.file} 不存在，请重新安装核心`);
      }
    } else if (launch.kind === 'argsfile') {
      if (!fs.existsSync(path.join(dir, launch.argsFile))) {
        throw new Error('启动参数文件缺失，请重新安装核心');
      }
    }
    const java = this.javaInfo();
    if (!java.installed) throw new Error('未检测到 Java，请先在面板执行"安装 Java"或在服务器手动安装 JDK 17+');
    if (java.major < 16) throw new Error(`Java 版本过低 (${java.major})，Minecraft 1.17+ 需要 Java 16+`);

    // paperclip 引导器（Paper/Purpur/Folia）首启需要原版核心：安装时已预置过，
    // 这里再兜底一次（覆盖面板代下、旧版本装的实例、或安装时预下载失败的情况）
    if (launch.kind === 'jar' && launch.file === 'server.jar' && PAPERCLIP_SOURCES.has(rec.meta.source)) {
      await this.ensureBootstrapVanilla(rec);
    }

    // 等预下载期间世界可能已变：实例被删除 / 被别的启动抢先 / 用户点了停止，
    // spawn 之前必须重新确认一次
    if (this.map.get(name) !== rec) throw new Error('实例已被删除');
    if (rec.proc) throw new Error('实例已在运行');
    if (rec.startCancelled) {
      rec.startCancelled = false;
      throw new Error('启动已取消');
    }
    // 预下载失败时 paperclip 仍会自己尝试下载，所以这里只提示不阻断（与旧行为一致）
    if (launch.kind === 'jar' && !fs.existsSync(path.join(dir, launch.file))) {
      throw new Error(`${launch.file} 不存在，请重新安装核心`);
    }

    const mem = [
      '-Xms' + Math.min(rec.meta.memoryMB, 1024) + 'M',
      '-Xmx' + rec.meta.memoryMB + 'M',
      '-XX:+UseG1GC',
    ];
    // Forge/NeoForge：java @user_jvm_args.txt @libraries/.../unix_args.txt nogui
    // 内存参数必须放在最前（会被 args.txt 里 @file 之后的内容追加，但 -Xmx 先出现才生效）；
    // user_jvm_args.txt 里默认全是注释，不会冲突。
    const args =
      launch.kind === 'argsfile'
        ? [...mem, '@user_jvm_args.txt', '@' + launch.argsFile, 'nogui']
        : [...mem, '-jar', launch.file, 'nogui'];
    const child = spawn(this.javaCmd() || 'java', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    rec.proc = child;
    rec.startedAt = Date.now();
    rec.ready = false; // 等控制台的「Done (x.xxxs)」就绪信号，期间状态为启动中
    rec.players = new Set(); // 玩家跟踪从空集开始（日志中的 joined/left 会持续更新）
    rec.runtimePort = rec.meta.port; // 本次进程实际监听的端口（properties 改端口要重启才生效）
    clearTimeout(rec.readyTimer);
    rec.readyTimer = setTimeout(() => {
      // 兜底：部分服务端/模组包不打标准就绪行，超时后按运行中处理（避免一直卡在启动中）
      if (rec.proc && rec.ready === false) {
        rec.ready = true;
        this.emitConsole(rec, '[BlockNexus] 未检测到就绪信号，已按运行中处理');
        this.emitUpdated(rec);
      }
    }, 300000);
    this.emitConsole(rec, `[BlockNexus] 启动: java ${args.join(' ')} (pid ${child.pid})`);
    this.emitUpdated(rec);

    // stdout/stderr 共用一个行缓冲读取器：聚齐完整行再进控制台与玩家跟踪
    const feed = this.makeLineSplitter((text) => {
      if (rec.proc !== child) return; // 旧进程的残留输出（切换过实例进程）不再影响当前状态
      this.emitConsole(rec, text);
      // 就绪信号：原版/Paper/Forge 均为「Done (x.xxxs)!」（Forge 老版无叹号）
      if (rec.ready === false && /Done \([\d.]+s\)/i.test(text)) {
        rec.ready = true;
        clearTimeout(rec.readyTimer);
        rec.readyTimer = null;
        this.emitConsole(rec, '[BlockNexus] 服务器已就绪（启动完成）');
        this.emitUpdated(rec);
      }
    });
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('close', () => feed.flush()); // 吐出最后没有换行符的残留行
    child.on('error', (e) => {
      this.emitConsole(rec, '[BlockNexus] 进程错误: ' + e.message);
    });
    child.on('exit', (code, signal) => {
      // 只有「当前进程」退出才改状态：否则一个已经退出的旧进程会把新起的进程
      // 从注册表里抹掉（rec.proc = null），使界面显示已停止并让下一次启动再起一个 java
      if (rec.proc !== child) return;
      const wasStopping = rec.stopping === true; // 主动停止（stop/重启/删除）不算崩溃
      rec.stopping = false;
      rec.proc = null;
      rec.ready = false;
      clearTimeout(rec.readyTimer);
      rec.readyTimer = null;
      this.emitConsole(rec, `[BlockNexus] 进程退出 (code=${code}${signal ? ' signal=' + signal : ''})`);
      this.emitUpdated(rec);
      // 异常退出（非主动停止且非 0 退出码）→ 交给看门狗
      if (!wasStopping && code !== 0) this.scheduleAutoRestart(rec, code, signal);
    });
    return { ok: true, pid: child.pid };
  },

  stopAndWait(rec, timeoutMs = 45000, force = false) {
    return new Promise((resolve) => {
      if (!rec.proc) return resolve(true);
      rec.stopping = true; // 标记为主动停止，避免触发看门狗
      const child = rec.proc;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve(!rec.proc);
        }
      };
      child.once('exit', finish);
      if (force) {
        try {
          child.kill('SIGKILL');
        } catch {}
        setTimeout(finish, 5000);
      } else {
        try {
          rec.proc.stdin.write('stop\n');
        } catch {}
        setTimeout(() => {
          if (!done && rec.proc) {
            try {
              rec.proc.kill('SIGKILL');
            } catch {}
          }
        }, timeoutMs);
        setTimeout(finish, timeoutMs + 8000);
      }
    });
  },

  async stop(name, force = false) {
    const rec = this.get(name);
    // 启动中（预下载/等待 spawn，尚无 java 进程）：标记取消，由 doStart 在 spawn 前消费。
    // 界面上的「停止启动」按钮因此真正可用，而不是回一句「实例未在运行」。
    if (!rec.proc) {
      if (rec.startJob) {
        rec.startCancelled = true;
        this.emitConsole(rec, '[BlockNexus] 已请求取消本次启动');
        return { ok: true, cancelled: true };
      }
      throw new Error('实例未在运行');
    }
    if (force) {
      try {
        rec.proc.kill('SIGKILL');
      } catch {}
      return { ok: true, forced: true };
    }
    rec.stopping = true;
    this.emitConsole(rec, '[BlockNexus] 发送 stop 指令…');
    try {
      rec.proc.stdin.write('stop\n');
    } catch {}
    return { ok: true, stopping: true };
  },

  async restart(name) {
    const rec = this.get(name);
    // 启动进行中（预下载/等 spawn）：先取消，再等这次启动收尾，避免两个启动流程并行
    if (!rec.proc && rec.startJob) {
      rec.startCancelled = true;
      try {
        await rec.startJob;
      } catch {}
    }
    if (rec.proc) await this.stopAndWait(rec, 45000);
    return this.start(name);
  },

  command(name, cmd) {
    const rec = this.get(name);
    if (!rec.proc) throw new Error('实例未在运行');
    if (!cmd) throw new Error('空指令');
    rec.proc.stdin.write(cmd + '\n');
    return { ok: true };
  },

  console(name, tail = 200) {
    const rec = this.get(name);
    return { lines: rec.buf.slice(-tail), status: this.statusOf(rec) };
  },

  async delete(name, opts = {}) {
    const rec = this.get(name);
    if (rec.proc) await this.stopAndWait(rec, 30000, true);
    clearTimeout(rec.restartTimer); // 取消待执行的自动重启
    rec.restartTimer = null;
    // 安装失败的实例目录里往往只有半成品/安装器残留，备份没意义且 tar 可能失败；
    // force=true 时跳过备份直接删（面板对 failed 实例默认走这条）
    const skipBackup = opts.force === true;
    if (opts.backupFirst && !skipBackup) {
      try {
        const b = await this.backupCreate(name);
        this.emitConsole(rec, `[BlockNexus] 删除前已创建备份: ${b.file} (${fmtSize(b.size)})`);
      } catch (e) {
        throw new Error('删除前备份失败，已中止删除: ' + e.message);
      }
    }
    fs.rmSync(this.instDir(name), { recursive: true, force: true });
    this.map.delete(name);
    sendEvent('instance.updated', { instance: name, status: 'deleted' });
    return { ok: true };
  }
};
