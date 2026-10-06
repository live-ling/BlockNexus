'use strict';
// AgentHub：管理远程 Agent 的加密通道，支持两个方向：
//   inbound  — Agent 主动连入面板（面板监听 /agent/ws；适合面板有公网地址/域名）
//   outbound — 面板主动连到 Agent 的端口（默认；适合 Agent 在公网、面板在本地 NAT 后）
//
// 握手（双向认证，两个方向协议一致）：
//   client → server  {t:'hello', v, serverId, ts, nonce}      明文，只含身份与随机数
//   server → client  {t:'challenge', nonce}
//   client → server  {t:'proof', proof = HMAC(kProof,'auth1'||nonceC||nonceS)}
//   server 校验后 →  {t:'ready', proof = HMAC(kProof,'auth2'||nonceC||nonceS)}，client 校验
//   之后全部为加密二进制帧；会话密钥 HKDF(token, nonceC||nonceS)，
//   Agent 用 kA2P 发 / kP2A 收，面板相反。token 本身不在网络上传输。

const { WebSocket, WebSocketServer } = require('ws');
const crypto = require('crypto');
const { deriveKeys, computeProof, Sealer, Opener, randomNonce } = require('./crypto');

const HANDSHAKE_TIMEOUT = 15000;
const MAX_CLOCK_SKEW = 5 * 60 * 1000;
const DEFAULT_AGENT_PORT = 3099;

// 重连日志降噪：长期离线的服务器每 ≤30s 重试一次，同一错误会把日志刷满。
// 相同消息 5 分钟内只记录一次；连接恢复后清空，下次失败立即记录。
const DUP_LOG_WINDOW = 5 * 60e3;
const dupLog = new Map(); // key -> { msg, at }
function logDedup(key, msg) {
  const prev = dupLog.get(key);
  if (prev && prev.msg === msg && Date.now() - prev.at < DUP_LOG_WINDOW) return;
  dupLog.set(key, { msg, at: Date.now() });
  console.error(msg);
}
function clearDedup(serverId) {
  for (const key of [...dupLog.keys()]) if (key.endsWith('|' + serverId)) dupLog.delete(key);
}

function verifyProof(keys, label, nonceC, nonceP, proofB64, who) {
  const want = computeProof(keys.kProof, label, nonceC, nonceP);
  const got = Buffer.from(String(proofB64 || ''), 'base64');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    throw new Error((who || '对端') + '未持有正确 token');
  }
}

/**
 * 驱动一次双向握手。
 * role='client'：本端发起（发 hello）；role='server'：本端等待 hello。
 * server 角色需要 resolveHello(msg) 返回 { serverId, token }（用于查出该身份对应的 token）。
 */
function runHandshake(ws, opts) {
  const { role, timeoutMs = HANDSHAKE_TIMEOUT } = opts;
  let serverId = opts.serverId;
  let token = opts.token;
  return new Promise((resolve, reject) => {
    let nonceC = null;
    let nonceP = null;
    let keys = null;
    let state = role === 'client' ? 'await-challenge' : 'await-hello';
    let settled = false;
    const timer = setTimeout(() => done(new Error('握手超时')), timeoutMs);
    const done = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(res);
    };
    const send = (obj) => ws.send(JSON.stringify(obj));

    if (role === 'client') {
      nonceC = crypto.randomBytes(16);
      send({
        t: 'hello',
        v: 1,
        panel: true,
        serverId,
        ts: Date.now(),
        nonce: nonceC.toString('base64url'),
      });
    }

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('握手阶段期望文本帧');
        const msg = JSON.parse(data.toString('utf8'));
        if (state === 'await-hello') {
          if (msg.t !== 'hello') throw new Error('期望 hello');
          const resolved = opts.resolveHello ? opts.resolveHello(msg) : null;
          if (!resolved) throw new Error('未知服务器 ' + msg.serverId);
          if (Math.abs(Date.now() - Number(msg.ts || 0)) > MAX_CLOCK_SKEW) throw new Error('时钟偏差过大');
          serverId = resolved.serverId;
          token = resolved.token;
          ws._mcpServerId = serverId;
          nonceC = Buffer.from(String(msg.nonce || ''), 'base64url');
          if (nonceC.length !== 16) throw new Error('nonce 长度错误');
          nonceP = randomNonce();
          send({ t: 'challenge', nonce: nonceP.toString('base64url') });
          state = 'await-proof';
          return;
        }
        if (state === 'await-challenge') {
          if (msg.t !== 'challenge') throw new Error('期望 challenge');
          nonceP = Buffer.from(String(msg.nonce || ''), 'base64url');
          if (nonceP.length !== 16) throw new Error('nonce 长度错误');
          keys = deriveKeys(token, nonceC, nonceP);
          send({
            t: 'proof',
            proof: computeProof(keys.kProof, 'auth1', nonceC, nonceP).toString('base64'),
          });
          state = 'await-ready';
          return;
        }
        if (state === 'await-proof') {
          if (msg.t !== 'proof') throw new Error('期望 proof');
          keys = deriveKeys(token, nonceC, nonceP);
          verifyProof(keys, 'auth1', nonceC, nonceP, msg.proof, 'Agent');
          send({
            t: 'ready',
            proof: computeProof(keys.kProof, 'auth2', nonceC, nonceP).toString('base64'),
          });
          done(null, keys);
          return;
        }
        if (state === 'await-ready') {
          if (msg.t !== 'ready') throw new Error('握手失败：' + JSON.stringify(msg).slice(0, 80));
          verifyProof(keys, 'auth2', nonceC, nonceP, msg.proof, 'Agent');
          done(null, keys);
        }
      } catch (e) {
        done(e);
      }
    });
    ws.on('close', () =>
      done(
        new Error(
          role === 'client'
            ? '握手未完成，连接被对端关闭（Agent 端 token 不匹配或已拒绝）'
            : '握手未完成，连接被对端关闭',
        ),
      ),
    );
    ws.on('error', (e) => done(e));
  });
}

class AgentHub extends require('events').EventEmitter {
  constructor(config, bus) {
    super();
    this.config = config;
    this.bus = bus;
    this.conns = new Map(); // serverId -> AgentConn
    this.outbound = new Map(); // serverId -> { ws, timer, delay }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.wss.on('connection', (ws) => this.onInbound(ws));
    // 定期同步外向连接（配置变更/新增服务器后自动建立）
    this.syncTimer = setInterval(() => this.syncOutbound(), 15000);
    setTimeout(() => this.syncOutbound(), 500);
  }

  // ================= inbound：Agent 连入面板 =================

  handleUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/agent/ws') {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onInbound(ws));
  }

  onInbound(ws) {
    runHandshake(ws, {
      role: 'server',
      resolveHello: (msg) => {
        const server = this.config.getServer(String(msg.serverId || ''));
        if (!server) return null;
        return { serverId: server.id, token: Buffer.from(server.token, 'base64url') };
      },
    })
      .then((keys) => this.attach(ws, ws._mcpServerId, keys))
      .catch((e) => {
        const id = ws._mcpServerId || '未知身份';
        logDedup('in-hs|' + id, `[agent-inbound] ${id} 握手失败: ${e.message}`);
        try {
          ws.close(4002, 'handshake failed');
        } catch {}
      });
  }

  // ================= outbound：面板连到 Agent =================

  agentUrl(server) {
    const host = server.agent.host || server.host;
    const port = Number(server.agent.port) || DEFAULT_AGENT_PORT;
    return `${server.agent.tls ? 'wss' : 'ws'}://${host}:${port}/agent/ws`;
  }

  /**
   * 校验服务端证书指纹（自签场景）。
   * 首次安装时面板记录 openssl 输出的 SHA-256 指纹，之后每次连接都比对，
   * 不匹配即断开——避免"自签证书 + 不校验"带来的中间人风险。
   */
  checkCertPin(server, ws) {
    const pinned = (server.agent.tlsFingerprint || '').replace(/:/g, '').toUpperCase();
    if (!server.agent.tls || !pinned) return true;
    let fp = null;
    try {
      const cert = ws._socket && ws._socket.getPeerCertificate ? ws._socket.getPeerCertificate() : null;
      fp = cert && cert.fingerprint256 ? String(cert.fingerprint256).replace(/:/g, '').toUpperCase() : null;
    } catch {}
    if (!fp) {
      logDedup('out-pin|' + server.id, `[agent-outbound] ${server.id} 无法读取服务端证书指纹，已断开`);
      return false;
    }
    if (fp !== pinned) {
      logDedup('out-pin|' + server.id, `[agent-outbound] ${server.id} 证书指纹不匹配：期望 ${pinned}，实际 ${fp}`);
      return false;
    }
    return true;
  }

  /** 让外向连接集合与配置保持一致（新增/删除/改模式都会在这里收敛） */
  syncOutbound() {
    const wanted = new Set(
      this.config
        .listServers()
        .filter((s) => (s.agent.mode || 'outbound') === 'outbound')
        .map((s) => s.id),
    );
    for (const id of [...this.outbound.keys()]) if (!wanted.has(id)) this.stopOutbound(id);
    for (const id of wanted) if (!this.outbound.has(id)) this.startOutbound(id);
  }

  startOutbound(serverId) {
    if (this.outbound.has(serverId)) return;
    const st = { ws: null, timer: null, delay: 3000 };
    this.outbound.set(serverId, st);

    const attempt = () => {
      const server = this.config.getServer(serverId);
      if (!server || !this.outbound.has(serverId)) return this.stopOutbound(serverId);
      const url = this.agentUrl(server);
      const ws = new WebSocket(url, {
        handshakeTimeout: 15000,
        // 自签证书必然过不了系统信任链；安全性由 token 双向认证 + 上面的指纹固定保证
        ...(server.agent.tls ? { rejectUnauthorized: false } : {}),
      });
      st.ws = ws;

      ws.on('open', () => {
        if (!this.checkCertPin(server, ws)) {
          try {
            ws.close();
          } catch {}
          return;
        }
        runHandshake(ws, {
          role: 'client',
          serverId,
          token: Buffer.from(server.token, 'base64url'),
        })
          .then((keys) => {
            st.delay = 3000; // 成功即重置退避
            this.attach(ws, serverId, keys);
          })
          .catch((e) => {
            logDedup('out-hs|' + serverId, `[agent-outbound] ${serverId} 握手失败: ${e.message}`);
            try {
              ws.close();
            } catch {}
          });
      });
      ws.on('error', (e) => logDedup('out-err|' + serverId, `[agent-outbound] ${serverId} ${e.message}`));
      ws.on('close', () => {
        if (st.ws !== ws) return;
        st.ws = null;
        if (!this.outbound.has(serverId)) return;
        st.timer = setTimeout(attempt, st.delay);
        st.delay = Math.min(st.delay * 2, 30000);
      });
    };
    attempt();
  }

  stopOutbound(serverId) {
    const st = this.outbound.get(serverId);
    if (st) {
      clearTimeout(st.timer);
      try {
        st.ws?.close();
      } catch {}
    }
    this.outbound.delete(serverId);
  }

  // ================= 连接接管（两个方向共用） =================

  attach(ws, serverId, keys) {
    const server = this.config.getServer(serverId);
    if (!server) {
      try {
        ws.close();
      } catch {}
      return;
    }
    const old = this.conns.get(serverId);
    if (old && old.ws !== ws) old.kick('新连接接入');
    const conn = new AgentConn(this, server, ws, keys);
    this.conns.set(serverId, conn);
    clearDedup(serverId);
    this.setStatus(serverId, 'online');
    console.log(`[agent] ${serverId} 已连接（${conn.direction}）`);
  }

  // ================= 状态与请求 =================

  setStatus(serverId, status) {
    const patch = { status };
    if (status === 'online') patch.lastSeen = Date.now();
    this.config.updateServer(serverId, patch);
    this.bus.emit('broadcast', { type: 'status', serverId, status });
    this.emit('status', serverId, status);
  }

  isOnline(serverId) {
    const c = this.conns.get(serverId);
    return !!(c && c.alive);
  }

  // 面板 → Agent 的加密请求，返回 Promise
  request(serverId, action, params = {}, timeoutMs = 30000) {
    const conn = this.conns.get(serverId);
    if (!conn || !conn.alive) {
      return Promise.reject(Object.assign(new Error('Agent 未连接'), { code: 'AGENT_OFFLINE' }));
    }
    return conn.request(action, params, timeoutMs);
  }

  // 本地 → 服务器 的链路延迟（最近一次 WS ping/pong 实测 RTT，毫秒；未测到为 null）
  getLatency(serverId) {
    const conn = this.conns.get(serverId);
    return conn && conn.alive ? conn.rtt : null;
  }

  // 本次 Agent 连接的建立时刻（在线时长统计用；离线为 null）
  getOnlineSince(serverId) {
    const conn = this.conns.get(serverId);
    return conn && conn.alive ? conn.attachedAt : null;
  }
}

class AgentConn {
  constructor(hub, server, ws, keys) {
    this.hub = hub;
    this.server = server;
    this.ws = ws;
    this.alive = true;
    this.attachedAt = Date.now(); // 本次连接建立时刻（在线时长的起点）
    this.sealer = new Sealer(keys.kP2A); // 面板→Agent
    this.opener = new Opener(keys.kA2P); // Agent→面板
    this.pending = new Map();
    this.seq = 0;
    this.rtt = null; // 最近样本的最小 ping/pong 往返延迟（毫秒）
    this.rttSamples = []; // 最近 5 次原始样本（事件循环抖动会拉高单次值，取最小才反映真实链路）
    this.pingSentAt = 0;
    this.missedPongs = 0; // 连续未应答的心跳数（用于检测半开死链）
    this.direction = hub.outbound.has(server.id) ? '面板 → Agent' : 'Agent → 面板';

    ws.on('message', (data, isBinary) => {
      try {
        if (!isBinary) return; // secure 阶段只收二进制
        const obj = JSON.parse(this.opener.open(data).toString('utf8'));
        this.onMessage(obj);
      } catch (e) {
        // 解密失败等：断开重来
        this.kick('解密失败: ' + e.message);
      }
    });
    ws.on('close', () => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(Object.assign(new Error('Agent 连接断开'), { code: 'AGENT_OFFLINE' }));
      this.pending.clear();
      if (this.hub.conns.get(server.id) === this) {
        this.hub.conns.delete(server.id);
        this.hub.setStatus(server.id, 'offline');
      }
    });
    ws.on('error', () => {});
    ws.on('pong', () => this.onPong());

    this.pingTimer = setInterval(() => this.measureLatency(), 30000);
    ws.on('close', () => clearInterval(this.pingTimer));
    // 首次测速（等握手后的连接稳定一拍再发）
    setTimeout(() => this.measureLatency(), 800);
  }

  // WS ping/pong：既测 RTT，也做死链检测——TCP 半开（对端掉电/NAT 超时）时
  // close 事件不会到来，若连续 2 次心跳无应答则主动断开，走重连并立即释放挂起请求
  measureLatency() {
    if (!this.alive) return;
    if (this.pingSentAt) {
      this.missedPongs += 1;
      if (this.missedPongs >= 2) {
        this.kick(`心跳超时（${2 * 30}s 无应答），主动断开以触发重连`);
        return;
      }
    }
    this.pingSentAt = Date.now();
    try {
      this.ws.ping();
    } catch {}
  }

  onPong() {
    if (!this.pingSentAt) return;
    const sample = Date.now() - this.pingSentAt;
    this.pingSentAt = 0;
    this.missedPongs = 0;
    // 事件循环调度抖动（节流唤醒、同步 IO）只会拉高单次样本，最小值才接近真实链路延迟
    this.rttSamples.push(sample);
    if (this.rttSamples.length > 5) this.rttSamples.shift();
    this.rtt = Math.min(...this.rttSamples);
    this.hub.bus.emit('broadcast', {
      type: 'latency',
      serverId: this.server.id,
      latency: this.rtt,
    });
  }

  kick(reason) {
    console.error(`[agent-kick] ${this.server ? this.server.id : '?'}: ${reason}`);
    try {
      this.ws.close(4003, reason);
    } catch {}
    try {
      this.ws.terminate();
    } catch {}
  }

  send(obj) {
    if (!this.alive) return;
    this.ws.send(this.sealer.seal(Buffer.from(JSON.stringify(obj), 'utf8')));
  }

  request(action, params, timeoutMs = 30000) {
    const id = 'r' + ++this.seq + '_' + crypto.randomBytes(4).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Agent 响应超时: ' + action), { code: 'AGENT_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ t: 'req', id, action, params });
    });
  }

  onMessage(obj) {
    if (obj.t === 'res') {
      const p = this.pending.get(obj.id);
      if (!p) return;
      this.pending.delete(obj.id);
      if (obj.ok) p.resolve(obj.result);
      else p.reject(Object.assign(new Error(obj.error || 'Agent 返回错误'), { code: 'AGENT_ERROR' }));
      return;
    }
    if (obj.t === 'evt') {
      // Agent 主动事件：hi（上线信息）、console、instance.updated、install.progress、java.updated
      if (obj.event === 'hi' && obj.data && obj.data.info) {
        this.hub.config.updateServer(this.server.id, {
          info: obj.data.info,
          lastSeen: Date.now(),
        });
      }
      // Java 装完后 Agent 会上报新的 java 信息；这里必须落到面板缓存的 server.info，
      // 否则卡片仍显示旧的「未安装」——只有重装 Agent 触发 hi 才会刷新，那是个 bug。
      if (obj.event === 'java.updated' && obj.data && obj.data.done && obj.data.ok && obj.data.java) {
        const cur = this.hub.config.getServer(this.server.id);
        if (cur) {
          this.hub.config.updateServer(this.server.id, {
            info: { ...(cur.info || {}), java: obj.data.java },
          });
        }
      }
      this.hub.bus.emit('broadcast', {
        type: 'agent-event',
        serverId: this.server.id,
        event: obj.event,
        data: obj.data === undefined ? null : obj.data,
      });
    }
  }
}

module.exports = { AgentHub };
