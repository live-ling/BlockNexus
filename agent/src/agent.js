'use strict';
// BlockNexus Agent — Agent 主类（面板连接与 RPC 派发）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
const fs = require('fs');
const os = require('os');

const { AGENT_VERSION, VERSION } = require('./config.js');
const { sendEvent, setHandler } = require('./eventbus.js');
const { Sealer, Opener } = require('./crypto.js');
const { WSSocket, WSServer, runHandshake, panelWsUrl } = require('./ws.js');

class Agent {
  constructor(conf, manager) {
    this.conf = conf;
    this.manager = manager;
    this.state = 'idle';
    this.ws = null;
    this.delay = 1000;
    this.timer = null;
    this.server = null;
    // 重试失败降噪：面板长期不在线时每 ≤30s 重试一次，避免相同错误刷满日志
    this.failReason = null; // 本次尝试的失败原因（error/握手失败时记录，close 时统一输出）
    this.lastFailMsg = null; // 上一次已记录的失败原因
    this.lastFailLogAt = 0; // 上一次记录失败日志的时间
    setHandler((event, data) => this.emitEvent(event, data));
  }

  log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  /** 相同失败原因 5 分钟内只记录一次；返回 true 表示本次被抑制 */
  quietFail(msg) {
    const now = Date.now();
    const dup = msg === this.lastFailMsg && now - this.lastFailLogAt < 5 * 60e3;
    this.lastFailMsg = msg;
    if (!dup) this.lastFailLogAt = now;
    return dup;
  }

  start() {
    if (this.conf.listen) this.listen();
    else this.connect();
  }

  // ---------- 模式 A：Agent 监听端口，面板主动连入（推荐：Agent 在公网、面板在本地） ----------
  listen() {
    this.server = new WSServer({ port: this.conf.listen, path: '/agent/ws', tls: this.conf.tls });
    this.server.on('listening', () => {
      const scheme = this.conf.tls ? 'wss' : 'ws';
      this.log(
        `✓ 已监听 ${this.conf.listen} 端口${this.conf.tls ? '（TLS）' : ''}，` +
          `等待面板连接（${scheme}://<本机IP>:${this.conf.listen}/agent/ws）`,
      );
    });
    this.server.on('error', (e) => this.log('监听失败:', e.message));
    this.server.on('connection', (ws, remote) => {
      this.log(`面板接入（来自 ${remote || '未知'}），开始 token 握手`);
      this.adoptSocket(ws, 'server', remote ? String(remote) : null);
    });
    this.server.listen();
  }

  // ---------- 模式 B：Agent 主动连接面板（面板有公网地址时用） ----------
  connect() {
    clearTimeout(this.timer);
    this.state = 'connecting';
    this.failReason = null;
    // 处于降噪窗口时不再重复打印「连接面板 …」
    if (!(this.lastFailMsg && Date.now() - this.lastFailLogAt < 5 * 60e3)) {
      this.log(`连接面板 ${this.conf.panel} …`);
    }
    const ws = new WSSocket('client');
    this.ws = ws;
    // 握手必须等 socket 就绪后再开始（write 在未连接时会抛错）
    ws.on('open', () => {
      this.delay = 1000;
      this.state = 'handshaking';
      this.lastFailMsg = null; // 恢复过一次，下次失败重新记录
      this.log('已建立 WebSocket，开始 token 握手');
      this.adoptSocket(ws, 'client');
    });
    ws.on('error', (e) => {
      this.failReason = e.message;
    });
    ws.on('close-info', (code, reason) => {
      if (code) this.failReason = `面板拒绝连接: code=${code}${reason ? ' reason=' + reason : ''}`;
    });
    // 断线统一在这里重连（无论握手是否完成）；失败日志在这里降噪输出
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      const prev = this.state;
      this.state = 'idle';
      this.sealer = null;
      this.opener = null;
      clearTimeout(this.timer);
      if (prev === 'secure') {
        // 已建立的通道断开是状态变化，必须记录（带上面板拒绝/错误原因）
        const why = this.failReason ? `（${this.failReason}）` : '';
        this.log(`连接断开${why}，${Math.round(this.delay / 1000)}s 后重连`);
      } else {
        const reason = this.failReason || '连接中断';
        if (!this.quietFail(reason)) {
          this.log(`连接失败（${reason}），${Math.round(this.delay / 1000)}s 后重连`);
        }
      }
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30000);
    });
    ws.connect(panelWsUrl(this.conf.panel));
  }

  // 握手 → 建立会话（两种模式共用）；同一时刻只保留最新连接
  adoptSocket(ws, role, remote) {
    const token = Buffer.from(this.conf.token, 'base64url');
    runHandshake(ws, { role, serverId: this.conf.id, token })
      .then((keys) => {
        // 踢掉上一条已建立的连接，避免多连接互抢
        if (this.ws && this.ws !== ws) {
          this.log('已有连接，替换为最新连接');
          try {
            this.ws.close();
          } catch {}
        }
        this.ws = ws;
        const wasState = this.state;
        this.state = 'secure';
        this.sealer = new Sealer(keys.kA2P); // Agent → 面板
        this.opener = new Opener(keys.kP2A); // 面板 → Agent
        this.log('✓ 加密通道已建立' + (role === 'server' ? `（面板 ${remote || ''}）` : ''));
        ws.on('message', (data, kind) => {
          try {
            if (this.state !== 'secure') return;
            if (kind !== 'binary') return;
            this.onSecureMessage(JSON.parse(this.opener.open(data).toString('utf8')));
          } catch (e) {
            this.log('消息处理失败:', e.message);
            try {
              ws.close();
            } catch {}
          }
        });
        ws.on('close', () => {
          if (this.ws !== ws) return;
          this.ws = null;
          this.sealer = null;
          this.opener = null;
          this.state = 'idle';
          if (role === 'server') this.log('连接断开，继续等待面板接入');
        });
        this.emitEvent('hi', { info: this.sysInfo(), instances: this.manager.list() });
        if (wasState === 'secure') this.log('（连接已切换）');
      })
      .catch((e) => {
        if (role === 'client') {
          // 主动连接模式：记下原因，由 close 处理器降噪后统一输出
          this.failReason = '握手失败: ' + e.message;
        } else {
          this.log('✗ 握手失败:', e.message);
        }
        try {
          ws.close(); // 关闭后由 connect() 里的 close 处理器安排重连
        } catch {}
      });
  }
  onSecureMessage(obj) {
    if (obj.t !== 'req') return;
    this.handleAction(obj.action, obj.params || {})
      .then((result) => this.sendEnc({ t: 'res', id: obj.id, ok: true, result }))
      .catch((e) => this.sendEnc({ t: 'res', id: obj.id, ok: false, error: e.message }));
  }

  sendEnc(obj) {
    if (this.state === 'secure' && this.ws) this.ws.sendBinary(this.sealer.seal(Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  emitEvent(event, data) {
    this.sendEnc({ t: 'evt', event, data });
  }

  sysInfo() {
    const java = this.manager.javaInfo();
    return {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      agentVersion: AGENT_VERSION,
      memTotalMB: Math.round(os.totalmem() / 1048576),
      dir: this.conf.dir,
      instancesDir: this.manager.dir,
      java,
    };
  }

  async handleAction(action, p) {
    const m = this.manager;
    switch (action) {
      case 'ping':
        return { pong: true, ts: Date.now() };
      case 'sys.info':
        return this.sysInfo();
      case 'sys.stats':
        return this.manager.sysStats();
      case 'instance.list':
        return m.list();
      case 'mc.versions':
        return m.getVersions();
      case 'core.catalogs':
        return m.coreCatalogs();
      case 'instance.create':
        return m.create(p);
      case 'instance.retry-install':
        return m.retryInstall(p.name);
      case 'instance.reinstall':
        return m.reinstall(p.name, {
          source: p.source,
          version: p.version,
          build: p.build,
          url: p.url,
        });
      case 'instance.start':
        return m.start(p.name);
      case 'instance.stop':
        return m.stop(p.name, !!p.force);
      case 'instance.restart':
        return m.restart(p.name);
      case 'instance.command':
        return m.command(p.name, p.cmd);
      case 'instance.console':
        return m.console(p.name, Math.min(Number(p.tail) || 200, 1000));
      case 'instance.delete':
        return m.delete(p.name, { backupFirst: !!p.backupFirst });
      case 'instance.edit':
        return m.edit(p.name, { note: p.note, address: p.address });
      case 'instance.domainCheck':
        return m.domainCheck(p.name);
      case 'instance.modsList':
        return m.modsList(p.name);
      case 'instance.modsToggle':
        return m.modsToggle(p.name, p.file, p.disable);
      case 'instance.modsDelete':
        return m.modsDelete(p.name, p.file);
      case 'instance.spark.stats':
        return m.sparkStats(p.name);
      case 'instance.spark.profiler':
        return m.sparkProfiler(p.name, p);
      case 'instance.spark.health':
        return m.sparkHealth(p.name);
      case 'instance.banList':
        return m.banList(p.name);
      case 'instance.banUnban':
        return m.banUnban(p.name, p.kind, p.target);
      case 'instance.iconGet':
        return m.iconGet(p.name);
      case 'instance.iconSet':
        return m.iconSet(p.name, p.b64);
      case 'instance.watchdog.set':
        return m.setWatchdog(p.name, p.watchdog || {});
      case 'instance.properties.get':
        return m.getProperties(p.name);
      case 'instance.properties.set':
        return m.saveProperties(p.name, p.content);
      case 'agent.prepareUninstall':
        return m.prepareUninstall({ keepBackups: !!p.keepBackups });
      case 'instance.players':
        return m.playersSnapshot();
      case 'instance.setcore':
        return m.setcore(p.name, p.filename);
      case 'instance.logLine':
        return m.logLine(p.name, p.text);
      case 'instance.panelInstall':
        return m.panelInstall(p.name, { kind: p.kind, file: p.file, build: p.build, loader: p.loader, url: p.url });
      case 'backup.create':
        m
          .backupCreate(p.name)
          .then((r) => sendEvent('backup.updated', { instance: p.name, done: true, ok: true, file: r.file }))
          .catch((e) => sendEvent('backup.updated', { instance: p.name, done: true, ok: false, error: e.message }));
        return { ok: true, started: true };
      case 'backup.list':
        return m.backupList(p.name);
      case 'backup.restore':
        m
          .backupRestore(p.name, p.file)
          .then(() => sendEvent('backup.updated', { instance: p.name, done: true, ok: true, restored: p.file }))
          .catch((e) => sendEvent('backup.updated', { instance: p.name, done: true, ok: false, error: e.message }));
        return { ok: true, started: true };
      case 'backup.delete':
        return m.backupDelete(p.name, p.file);
      case 'backup.download.begin': {
        const bp = m.backupFilePath(p.name, p.file);
        return m._downloadBeginAbs(bp);
      }
      case 'java.install':
        if (m.javaJob) return { ok: true, started: true, busy: true };
        m.startJavaInstall(Number(p.major) || 21);
        return { ok: true, started: true };
      case 'fs.list':
        return m.listFiles(p.name, p.path);
      case 'fs.read':
        return m.readFile(p.name, p.path, Math.min(Number(p.maxKB) || 512, 2048));
      case 'fs.write':
        return m.writeFile(p.name, p.path, p.content);
      case 'fs.mkdir':
        return m.mkdir(p.name, p.path);
      case 'fs.delete':
        return m.deletePath(p.name, p.path);
      case 'fs.copy':
        return m.copyMovePath(p.name, p.from, p.to, false);
      case 'fs.move':
        return m.copyMovePath(p.name, p.from, p.to, true);
      case 'fs.compress':
        return m.compressPaths(p.name, p.paths, p.out);
      case 'fs.extract':
        return m.extractArchive(p.name, p.path);
      case 'fs.upload.begin':
        return m.uploadBegin(p.name, p.dir, p.filename, p.size, p.lastModified, !!p.resume);
      case 'fs.upload.chunk':
        return m.uploadChunk(p.uploadId, p.seq, p.dataB64, p.seekTo);
      case 'fs.upload.finish':
        return m.uploadFinish(p.uploadId);
      case 'fs.upload.abort':
        return m.uploadAbort(p.uploadId);
      case 'fs.download.begin':
        return m.downloadBegin(p.name, p.path);
      case 'fs.download.chunk':
        return m.downloadChunk(p.downloadId);
      case 'fs.download.finish':
        return m.downloadFinish(p.downloadId);
      default:
        throw new Error('未知操作: ' + action);
    }
  }
}

module.exports = { Agent };
