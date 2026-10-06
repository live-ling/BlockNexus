'use strict';
// BlockNexus Agent — InstanceManager 骨架（注册表、状态、元数据与控制台缓冲）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { execFile } = require('child_process');
const { sendEvent } = require('../eventbus.js');

class InstanceManager {
  constructor(instancesDir) {
    this.dir = instancesDir;
    this.map = new Map(); // name -> { meta, proc, startedAt, buf, pending, flushTimer, stopping }
    this.versionsCache = null;
    this.javaNetFlags = new Map(); // host -> 安装器进程的 JVM 网络参数（IPv4 不通时的 IPv6 兜底）
    this.uploads = new Map(); // uploadId -> {finalPath, tmpPath, received, seq, at}
    this.downloads = new Map(); // downloadId -> {fd, pos, size, at}
    this.javaJob = null; // Java 安装后台任务（防重复触发）
    this.bootstrapJobs = new Map(); // name|version -> 进行中的原版核心预下载（并发去重）
    fs.mkdirSync(this.dir, { recursive: true });
    this.scan();
    // 清理过期传输会话；每 30 秒检查看门狗定时重启与定时备份任务
    setInterval(() => this.gcTransferSessions(), 10 * 60e3).unref();
    setInterval(() => this.checkWatchdogSchedules(), 30e3).unref();
    setInterval(() => this.checkBackupSchedules(), 30e3).unref();
  }

  instDir(name) {
    return path.join(this.dir, name);
  }

  scan() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => {
        try {
          return fs.statSync(path.join(this.dir, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {}
    for (const name of names) {
      if (this.map.has(name)) continue;
      const metaFile = path.join(this.dir, name, 'blocknexus.json');
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        this.map.set(name, { meta, proc: null, startedAt: null, buf: [], pending: [], flushTimer: null });
      } catch {}
    }
  }

  statusOf(rec) {
    // 进程起来了但还没打印「Done (x.xxxs)!」就绪信号 → 启动中（MC 服务端要十几秒~数分钟才可连接）
    if (rec.proc) return rec.ready === false ? 'starting' : 'running';
    // 启动已受理但还在等（Paper 系要先预下载原版核心，可能好几分钟）：同样算启动中。
    // 否则界面显示「已停止」，用户会再点一次启动 —— 那正是重复起 java 进程的来源。
    if (rec.startJob) return 'starting';
    const st = rec.meta.installState;
    if (st === 'downloading') return 'downloading';
    if (st === 'failed') return 'failed';
    if (!this.coreInstalled(rec)) return 'incomplete';
    return 'stopped';
  }

  /** 核心是否就位：按安装阶段写入的 launch 描述判断（模组端没有 server.jar） */
  coreInstalled(rec) {
    const launch = rec.meta.launch || { kind: 'jar', file: 'server.jar' };
    const target = launch.kind === 'argsfile' ? launch.argsFile : launch.file;
    return fs.existsSync(path.join(this.dir, rec.meta.name, target));
  }

  // 系统资源快照（服务器卡片：内存当前占用 + 实例目录所在磁盘用量）
  // 全程异步：同步版（statfsSync/df spawnSync）会阻塞事件循环几十毫秒，
  // 恰好和 30s 一次的延迟探测撞车，把本机 Agent 的 RTT 读数污染成几十毫秒。
  // Linux 的 os.freemem() 不含可回收页缓存，会把"实际可用"报得偏低 → 优先读 MemAvailable
  async sysStats() {
    const total = os.totalmem();
    let avail = os.freemem();
    try {
      const mi = await fs.promises.readFile('/proc/meminfo', 'utf8');
      const m = /^MemAvailable:\s*(\d+)\s*kB$/m.exec(mi);
      if (m) avail = Number(m[1]) * 1024;
    } catch {}
    const stats = {
      memTotalMB: Math.round(total / 1048576),
      memUsedMB: Math.max(0, Math.round((total - avail) / 1048576)),
      disk: null,
    };
    const gb = (n) => Math.round((n / 1073741824) * 10) / 10;
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(this.dir);
        stats.disk = { totalGB: gb(s.blocks * s.bsize), freeGB: gb(s.bfree * s.bsize) };
      }
    } catch {}
    if (!stats.disk) {
      // 老版本 Node 没有 fs.statfs，回退 df -k -P（POSIX 统一格式，异步执行）
      await new Promise((resolve) => {
        try {
          execFile('df', ['-k', '-P', this.dir], { timeout: 5000 }, (err, stdout) => {
            if (!err) {
              const line = String(stdout).trim().split('\n').pop();
              const cols = line && line.split(/\s+/);
              if (cols && cols.length >= 4 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[3])) {
                stats.disk = { totalGB: gb(Number(cols[1]) * 1024), freeGB: gb(Number(cols[3]) * 1024) };
              }
            }
            resolve();
          });
        } catch {
          resolve();
        }
      });
    }
    return stats;
  }

  list() {
    this.scan();
    return [...this.map.values()].map((rec) => ({
      name: rec.meta.name,
      version: rec.meta.version,
      // 核心类型与构建号：前端卡片要显示「Paper / Forge 1.20.1-47.2.0」这类信息
      source: rec.meta.source || 'vanilla',
      build: rec.meta.build || '',
      url: rec.meta.url || '',
      port: rec.meta.port,
      memoryMB: rec.meta.memoryMB,
      motd: rec.meta.motd,
      onlineMode: rec.meta.onlineMode,
      note: rec.meta.note || '',
      address: rec.meta.address || '',
      maxPlayers: this.readMaxPlayers(rec),
      watchdog: rec.meta.watchdog || { autoRestart: false, restartDelaySec: 5, schedules: [] },
      backupSchedule: rec.meta.backupSchedule || this.defaultBackupSchedule(),
      status: this.statusOf(rec),
      pid: rec.proc ? rec.proc.pid : null,
      startedAt: rec.startedAt,
      createdAt: rec.meta.createdAt,
      // 安装失败的原因（重试入口要展示给用户）
      error: rec.meta.error || '',
      // 是否装了 spark（决定前端要不要显示 Spark 标签页；老版本 Agent 无此字段，前端按未装处理）
      sparkInstalled: this.sparkDetect(rec).installed,
    }));
  }

  // 编辑实例元信息：备注（note）与连接地址（address，仅面板展示用）
  edit(name, patch = {}) {
    const rec = this.get(name);
    if (patch.note !== undefined) rec.meta.note = String(patch.note).slice(0, 200);
    if (patch.address !== undefined) rec.meta.address = String(patch.address).trim().slice(0, 200);
    // 内存：与创建时同一区间（512 - 32768 MB），改动在下一次启动时生效
    if (patch.memoryMB !== undefined) {
      const mb = Number(patch.memoryMB);
      if (!Number.isFinite(mb) || mb < 512 || mb > 32768) {
        throw new Error('内存需在 512 - 32768 MB 之间');
      }
      rec.meta.memoryMB = Math.round(mb);
    }
    this.saveMeta(rec);
    this.emitUpdated(rec);
    return { ok: true, memoryMB: rec.meta.memoryMB, running: !!rec.proc };
  }

  get(name) {
    const rec = this.map.get(name);
    if (!rec) throw new Error('实例不存在: ' + name);
    return rec;
  }

  saveMeta(rec) {
    fs.writeFileSync(
      path.join(this.dir, rec.meta.name, 'blocknexus.json'),
      JSON.stringify(rec.meta, null, 2)
    );
  }

  emitConsole(rec, text) {
    this.trackPlayers(rec, text);
    // spark 命令输出不进面板控制台：数据已被 trackSpark 解析进 Spark 面板，
    // 而 spark tps 一次要打十来行，留着会把手动看控制台彻底刷屏
    if (this.trackSpark(rec, text)) return;
    rec.buf.push({ ts: Date.now(), text });
    if (rec.buf.length > 500) rec.buf.splice(0, rec.buf.length - 500);
    rec.pending.push(text);
    if (!rec.flushTimer) {
      rec.flushTimer = setTimeout(() => {
        rec.flushTimer = null;
        if (rec.pending.length) {
          const lines = rec.pending.splice(0, rec.pending.length);
          sendEvent('console', { instance: rec.meta.name, lines });
        }
      }, 300);
    }
  }

  emitUpdated(rec) {
    sendEvent('instance.updated', { instance: rec.meta.name, status: this.statusOf(rec) });
  }
}

// 其余方法按功能组分散在同目录模块里，加载时挂到原型（方法体逐字搬移，未改逻辑）
Object.assign(
  InstanceManager.prototype,
  require('./lifecycle.js'),
  require('./install.js'),
  require('./core.js'),
  require('./catalog-cache.js'),
  require('./players.js'),
  require('./watchdog.js'),
  require('./backup-schedule.js'),
  require('./fs.js'),
  require('./backups.js'),
  require('./serverinfo.js'),
  require('./spark.js'),
  require('./java.js'),
);

module.exports = { InstanceManager };
