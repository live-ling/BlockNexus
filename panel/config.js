'use strict';
// 配置持久化：data/config.json（原子写入）
// 注意：SSH 密码/私钥按明文保存在本地配置文件中，请保证文件权限（详见 README）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomToken } = require('./crypto');

function scryptHash(plain, salt) {
  return crypto.scryptSync(String(plain), salt, 32).toString('hex');
}

class Config {
  constructor(file) {
    this.file = file;
    this.data = {
      panel: { port: 3080, username: 'admin', passwordHash: null, authEnabled: false },
      servers: [],
      // 面板设置页：公网域名 / 管理员邮箱 / SMTP / 离线通知 / AI 日志分析
      settings: {
        domain: '',
        adminEmail: '',
        smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
        notify: { offline: true, recovery: false },
        ai: {
          enabled: false,
          baseUrl: '',
          apiKey: '',
          model: '',
        },
      },
    };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 先留一份默认值：下面 {...this.data, ...raw} 会整体替换 settings，
      // 之后的子对象合并必须以此 defaults 为底，否则老配置缺字段时新默认值（如 ai）会被冲成空对象
      const defaults = this.data.settings;
      this.data = { ...this.data, ...raw };
      this.data.panel = {
        ...{ port: 3080, username: 'admin', passwordHash: null, authEnabled: false },
        ...(raw.panel || {}),
      };
      if (!this.data.panel.username) this.data.panel.username = 'admin';
      this.data.settings = {
        ...defaults,
        ...(raw.settings || {}),
        smtp: { ...defaults.smtp, ...((raw.settings || {}).smtp || {}) },
        notify: { ...defaults.notify, ...((raw.settings || {}).notify || {}) },
        ai: { ...defaults.ai, ...((raw.settings || {}).ai || {}) },
      };
      for (const s of this.data.servers) {
        s.agent = {
          mode: 'inbound',
          host: '',
          port: 3099,
          tls: false,
          tlsFingerprint: '',
          panelUrl: '',
          installDir: '/opt/blocknexus-agent',
          ...(s.agent || {}),
        };
        if (!s.agent.mode) s.agent.mode = 'inbound'; // 老配置沿用原来的「Agent 连面板」
      }
      if (!Array.isArray(this.data.servers)) this.data.servers = [];
    } catch {
      // 首次启动，文件不存在
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 唯一临时名：并发保存（如同时改设置与服务器）用同一个 .tmp 会互相抢占，
    // 先 rename 成功的那个把文件移走后，后一个 rename 就会报 ENOENT。
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw e;
    }
  }

  // ---------- 面板登录（用户名 + 密码） ----------
  /** 写入凭据；password 为空表示只改用户名 */
  setCredentials({ username, password }) {
    if (username !== undefined) {
      this.data.panel.username = String(username).trim().slice(0, 40) || 'admin';
    }
    if (password) {
      const salt = crypto.randomBytes(16).toString('hex');
      this.data.panel.passwordHash = { salt, hash: scryptHash(password, salt) };
    }
    this.save();
  }

  // 兼容旧调用：只设置密码
  setPassword(plain) {
    this.setCredentials({ password: plain });
  }

  /** 校验用户名 + 密码（两个字段都用定长摘要比较，避免时序与长度泄露） */
  verifyCredentials(username, password) {
    const ph = this.data.panel.passwordHash;
    if (!ph) return false;
    const expected = this.data.panel.username || 'admin';
    const given = String(username ?? '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    const userOk = crypto.timingSafeEqual(a, b);
    const want = Buffer.from(ph.hash, 'hex');
    const got = Buffer.from(scryptHash(String(password ?? ''), ph.salt), 'hex');
    const passOk = want.length === got.length && crypto.timingSafeEqual(want, got);
    return userOk && passOk;
  }

  verifyPassword(plain) {
    return this.verifyCredentials(this.data.panel.username, plain);
  }

  // ---------- 服务器 ----------
  listServers() {
    return this.data.servers;
  }

  getServer(id) {
    return this.data.servers.find((s) => s.id === id) || null;
  }

  addServer(fields) {
    const server = {
      id: 'srv_' + crypto.randomBytes(6).toString('hex'),
      name: String(fields.name || '未命名').slice(0, 60),
      host: String(fields.host || '').trim(),
      token: randomToken(),
      createdAt: Date.now(),
      status: 'offline',
      lastSeen: null,
      info: null,
      installing: false,
      ssh: {
        port: Number(fields.sshPort) || 22,
        user: String(fields.sshUser || 'root').trim(),
        auth: fields.sshAuth === 'key' ? 'key' : 'password',
        password: fields.sshAuth === 'password' ? String(fields.sshPassword || '') : '',
        keyPath: fields.sshAuth === 'key' ? String(fields.sshKeyPath || '').trim() : '',
        key: fields.sshAuth === 'key' ? String(fields.sshKey || '') : '',
      },
      agent: {
        // 连接方向：'outbound' = 面板主动连 Agent（默认，适合 Agent 在公网）
        //           'inbound'  = Agent 连入面板（适合面板有公网地址）
        mode: fields.agentMode === 'inbound' ? 'inbound' : 'outbound',
        host: String(fields.agentHost || '').trim(), // 留空则用服务器地址
        port: Number(fields.agentPort) || 3099,
        tls: fields.agentTls === true || fields.agentTls === 'true', // 走 wss（自签证书 + 指纹固定）
        tlsFingerprint: '',
        panelUrl: String(fields.panelUrl || '').trim(),
        installDir: '/opt/blocknexus-agent',
      },
    };
    this.data.servers.push(server);
    this.save();
    return server;
  }

  updateServer(id, patch) {
    const s = this.getServer(id);
    if (!s) return null;
    if (patch.name !== undefined) s.name = String(patch.name).slice(0, 60);
    if (patch.host !== undefined) s.host = String(patch.host).trim();
    if (patch.panelUrl !== undefined) s.agent.panelUrl = String(patch.panelUrl).trim();
    if (patch.agentMode !== undefined) s.agent.mode = patch.agentMode === 'inbound' ? 'inbound' : 'outbound';
    if (patch.agentHost !== undefined) s.agent.host = String(patch.agentHost).trim();
    if (patch.agentPort !== undefined) s.agent.port = Number(patch.agentPort) || 3099;
    if (patch.agentTls !== undefined) s.agent.tls = patch.agentTls === true || patch.agentTls === 'true';
    if (patch.tlsFingerprint !== undefined) s.agent.tlsFingerprint = String(patch.tlsFingerprint || '');
    if (patch.status !== undefined) s.status = patch.status;
    if (patch.installing !== undefined) s.installing = !!patch.installing;
    if (patch.info !== undefined) s.info = patch.info;
    if (patch.lastSeen !== undefined) s.lastSeen = patch.lastSeen;
    if (patch.token !== undefined) s.token = patch.token;
    const ssh = patch.ssh || {};
    for (const k of ['port', 'user', 'auth', 'password', 'keyPath', 'key']) {
      if (ssh[k] !== undefined && ssh[k] !== '') s.ssh[k] = ssh[k];
    }
    this.save();
    return s;
  }

  removeServer(id) {
    const before = this.data.servers.length;
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.save();
    return this.data.servers.length < before;
  }

  // 服务器卡片排序：按给定 id 顺序重排（未出现在 ids 里的保持原相对顺序追加在后）
  reorderServers(ids) {
    const list = Array.isArray(ids) ? ids.map(String) : [];
    if (!list.length) return this.data.servers;
    const rank = new Map(list.map((id, i) => [id, i]));
    this.data.servers = [...this.data.servers].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    this.save();
    return this.data.servers;
  }
}

module.exports = { Config };
