'use strict';
// BlockNexus Agent — 实例创建、安装/重装与面板代下
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CORE_KINDS } = require('../catalog.js');
const { NAME_RE } = require('../util.js');



module.exports = {
  async create(params) {
    const name = String(params.name || '');
    if (!NAME_RE.test(name)) throw new Error('实例名只允许字母数字-_（1-32位）');
    if (this.map.has(name) || fs.existsSync(this.instDir(name))) throw new Error('实例已存在');
    const port = Number(params.port) || 25565;
    if (!(port >= 1024 && port <= 65535)) throw new Error('端口需在 1024-65535');
    const memoryMB = Math.min(Math.max(Number(params.memoryMB) || 2048, 512), 32768);
    // mojang 是历史来源名，统一成 vanilla；新增第三方核心来源
    const legacy = { mojang: 'vanilla' };
    const rawSource = params.source || 'vanilla';
    const source = legacy[rawSource] || rawSource;
    if (!CORE_KINDS.some((k) => k.id === source)) throw new Error('未知的核心来源: ' + source);
    let version = String(params.version || '').trim();
    let customUrl = '';
    const build = String(params.build || '').trim(); // 可选：指定构建号（Paper/Purpur）或完整版本（Forge/NeoForge）
    if (source === 'url') {
      customUrl = String(params.url || '').trim();
      if (!/^https?:\/\/.+/i.test(customUrl)) throw new Error('无效的核心下载 URL');
      if (!version) version = 'custom-' + new URL(customUrl).hostname;
    } else if (source === 'upload') {
      if (!version) version = 'custom';
    }
    if (!version && source !== 'upload') throw new Error('缺少版本号');
    if (!params.eula) throw new Error('需要同意 Minecraft EULA');

    const dir = this.instDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      meta: {
        name,
        version,
        source,
        build,
        url: customUrl,
        port,
        memoryMB,
        motd: String(params.motd || 'A Minecraft Server').slice(0, 100),
        onlineMode: params.onlineMode !== false,
        note: '',
        address: '',
        watchdog: { autoRestart: false, restartDelaySec: 5, schedules: [] },
        eula: true,
        installState: 'downloading',
        createdAt: Date.now(),
      },
      proc: null,
      startedAt: null,
      buf: [],
      pending: [],
      flushTimer: null,
    };
    this.map.set(name, rec);
    this.saveMeta(rec);
    fs.writeFileSync(path.join(dir, 'eula.txt'), '# accepted via BlockNexus panel\neula=true\n');
    fs.writeFileSync(
      path.join(dir, 'server.properties'),
      [
        `server-port=${port}`,
        `motd=${rec.meta.motd}`,
        'max-players=20',
        `online-mode=${rec.meta.onlineMode}`,
        'view-distance=10',
        'spawn-protection=8',
        '',
      ].join('\n')
    );
    this.emitUpdated(rec);

    // 上传来源：先建好目录结构，等用户上传核心（server.jar）
    if (source === 'upload') {
      rec.meta.installState = 'ready';
      rec.meta.launch = { kind: 'jar', file: 'server.jar' };
      this.saveMeta(rec);
      this.emitConsole(rec, '[BlockNexus] 实例已创建，等待上传 server.jar（可在创建向导或文件管理中上传）');
      this.emitUpdated(rec);
      return { ok: true, source: 'upload' };
    }

    this.startInstall(rec, customUrl || null);
    return { ok: true, download: 'started' };
  },

  /** 后台安装核心（面板已先收到响应，进度与结果走事件）；失败时落到 installState=failed 供重试 */
  startInstall(rec, customUrl = null) {
    rec.meta.installState = 'downloading';
    delete rec.meta.error;
    this.saveMeta(rec);
    this.emitUpdated(rec);
    this.downloadJar(rec, customUrl).catch((e) => {
      rec.meta.installState = 'failed';
      rec.meta.error = e.message;
      this.saveMeta(rec);
      this.emitConsole(rec, '[BlockNexus] 安装失败: ' + e.message);
      this.emitUpdated(rec);
    });
  },

  /** 重试安装：沿用实例已记录的核心类型/版本/构建，重新走一遍下载与安装 */
  retryInstall(name) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例正在运行，请先停止');
    if (rec.meta.installState === 'downloading') throw new Error('正在安装中');
    if (rec.meta.source === 'upload') throw new Error('上传型核心无需重试，请在文件管理里上传 server.jar');
    this.emitConsole(rec, `[BlockNexus] 重试安装 ${rec.meta.source} ${rec.meta.version}`);
    this.startInstall(rec, rec.meta.source === 'url' ? rec.meta.url : null);
    return { ok: true, download: 'started' };
  },

  /**
   * 重装：清掉上次安装的残留，可选换核心类型/版本，再走一遍安装。
   * 与 retryInstall 的区别是会先删掉半成品（server.jar.tmp、安装器 jar、libraries 等），
   * 避免半成品被当成已装完，或残留文件让安装器跳过必要步骤。
   * 世界存档、server.properties 与 blocknexus.json 始终保留。
   */
  reinstall(name, opts = {}) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例正在运行，请先停止');
    if (rec.meta.installState === 'downloading') throw new Error('正在安装中');

    const dir = this.instDir(name);
    const drop = ['server.jar', 'server.jar.tmp', 'fabric-server-launch.jar', 'libraries', 'versions'];
    // 安装器本身也按类型清掉（forge/neoforge/fabric 的 installer jar 与日志）
    try {
      for (const f of fs.readdirSync(dir)) {
        const isInstaller = /^(forge|neoforge|fabric).*installer.*\.(jar|log)$/i.test(f);
        if (drop.includes(f) || isInstaller) {
          const p = path.join(dir, f);
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch {}
        }
      }
    } catch {}

    if (opts.source && CORE_KINDS.some((k) => k.id === opts.source)) rec.meta.source = opts.source;
    if (opts.version) rec.meta.version = String(opts.version);
    if (opts.build !== undefined) rec.meta.build = String(opts.build || '');
    if (opts.url) rec.meta.url = String(opts.url);
    // 启动方式要重新由安装阶段决定，旧的 launch 指向的文件已经删了
    delete rec.meta.launch;
    this.saveMeta(rec);
    this.emitConsole(rec, `[BlockNexus] 重装核心 ${rec.meta.source} ${rec.meta.version}`);
    this.startInstall(rec, rec.meta.source === 'url' ? rec.meta.url : null);
    return { ok: true, download: 'started' };
  },

  // ---------- 核心（server.jar）来源：上传后指认 ----------
  setcore(name, filename) {
    const root = this.instanceRoot(name);
    const f = this.resolveSafe(root, filename);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) throw new Error('文件不存在: ' + filename);
    fs.renameSync(f, path.join(root, 'server.jar'));
    const rec = this.get(name);
    rec.meta.installState = 'ready';
    rec.meta.launch = { kind: 'jar', file: 'server.jar' };
    delete rec.meta.error;
    this.saveMeta(rec);
    this.emitConsole(rec, `[BlockNexus] 核心已设置: ${filename} → server.jar`);
    this.emitUpdated(rec);
    return { ok: true };
  },

  // 面板往实例控制台写一行叙述（面板代下核心等跨端流程用它同步进度）
  logLine(name, text) {
    const rec = this.get(name);
    this.emitConsole(rec, String(text || '').slice(0, 500));
    return { ok: true };
  },

  /**
   * 面板代下安装：核心文件已由面板下载并经加密通道传到实例目录，
   * 这里负责落位——直连 jar 改名 server.jar 即可；安装器类要现场跑 installer。
   * installer 耗时不可控，与 startInstall 一样后台执行，结果走事件。
   */
  panelInstall(name, opts = {}) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例正在运行，请先停止');
    if (rec.meta.installState === 'downloading') throw new Error('正在安装中');
    const dir = this.instDir(name);
    const kind = String(opts.kind || 'direct');
    const file = this.resolveSafe(dir, String(opts.file || ''));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      throw new Error('面板传输的文件不存在: ' + (opts.file || '?'));
    }

    if (kind === 'direct') {
      const target = path.join(dir, 'server.jar');
      if (path.resolve(file) !== path.resolve(target)) fs.renameSync(file, target);
      rec.meta.launch = { kind: 'jar', file: 'server.jar' };
      rec.meta.installState = 'ready';
      if (opts.build) rec.meta.build = String(opts.build);
      delete rec.meta.error;
      this.saveMeta(rec);
      this.emitConsole(rec, '[BlockNexus] 面板传输的核心已就位（server.jar），可以启动了');
      this.emitUpdated(rec);
      return { ok: true, ready: true };
    }
    if (!['fabric', 'forge', 'neoforge'].includes(kind)) throw new Error('不支持的核心类型: ' + kind);

    rec.meta.installState = 'downloading';
    delete rec.meta.error;
    this.saveMeta(rec);
    this.emitUpdated(rec);
    // plan 形状与 downloadJar 用的保持一致，runInstaller 可直接消费
    const plan = {
      kind,
      url: String(opts.url || ''),
      fileName: String(opts.file || ''),
      build: opts.build ? String(opts.build) : undefined,
      loader: opts.loader ? String(opts.loader) : undefined,
      game: rec.meta.version,
    };
    (async () => {
      try {
        this.emitConsole(rec, `[BlockNexus] 开始运行 ${kind} 安装器（核心由面板侧下载传输）…`);
        const launch = await this.runInstaller(rec, plan, file);
        rec.meta.launch = launch;
        rec.meta.installState = 'ready';
        if (plan.build) rec.meta.build = plan.build;
        delete rec.meta.error;
        this.saveMeta(rec);
        this.emitConsole(rec, `[BlockNexus] ${kind} 安装完成，可以启动了`);
        this.emitUpdated(rec);
      } catch (e) {
        rec.meta.installState = 'failed';
        rec.meta.error = e.message;
        this.saveMeta(rec);
        this.emitConsole(rec, '[BlockNexus] 面板代下安装失败: ' + e.message);
        this.emitUpdated(rec);
      }
    })();
    return { ok: true, started: true };
  }
};
