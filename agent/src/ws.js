'use strict';
// BlockNexus Agent — WebSocket（RFC6455 客户端/服务端）与面板握手
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { EventEmitter } = require('events');
const { VERSION } = require('./config.js');
const { computeProof, deriveKeys } = require('./crypto.js');
const state = require('./state.js');

/**
 * 读布尔型环境变量。
 *
 * 为什么不能直接 `if (process.env.X)`：那样**任何非空字符串都为真**，
 * 于是 `BLOCKNEXUS_INSECURE=0`、`=false`、`=no` 都会被当成「开启」——
 * 用户越是明确地写 false 想关掉它，越是把它打开了（与意图完全相反）。
 * 只认这几个明确的肯定值，其余（含 '0'/'false'/空串）一律为 false。
 */
function envFlag(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ======================= WebSocket（客户端 + 服务端，RFC6455 子集） =======================
// 同一套帧编解码，两种角色：
//   role='client'：主动连接对端，发送的帧必须掩码
//   role='server'：接受对端连接，发送的帧禁止掩码（客户端帧带掩码，接收侧自动解掩码）
// 支持分片重组、ping/pong、close。

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSSocket extends EventEmitter {
  constructor(role) {
    super();
    this.role = role; // 'client' | 'server'
    this.socket = null;
    this.acc = Buffer.alloc(0);
    this.frags = null;
    this.fragOp = 0;
    this.byUs = false;
    this.finished = false;
  }

  // 绑定一条已建立/已升级的 TCP 连接
  attach(socket, head) {
    this.socket = socket;
    socket.setNoDelay(true);
    if (head && head.length) this.feed(head);
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.onClose());
    socket.on('end', () => this.onClose());
    socket.on('error', (e) => this.emit('error', e));
    this.emit('open');
  }

  // 作为客户端主动连接（url 用原始路径，不做任何拼接）
  connect(url) {
    const u = new URL(url);
    const secure = u.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');
    const req = (secure ? https : http).request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        Host: u.host,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      // 自签证书的面板：Agent 侧可用 --insecure / BLOCKNEXUS_INSECURE=1 / agent.json {tlsInsecure} 放行
      // ⚠ 用 envFlag 而不是直接读环境变量：`process.env.X` 对**任何非空字符串**都为真，
      //    于是 BLOCKNEXUS_INSECURE=0 / =false 反而会**关掉** TLS 校验——与写它的人意图完全相反。
      rejectUnauthorized: envFlag('BLOCKNEXUS_INSECURE') || state.insecureTls ? false : true,
    });
    req.setTimeout(15000, () => req.destroy(new Error('连接超时')));
    req.on('upgrade', (res, socket, head) => {
      const expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        this.emit('error', new Error('WS 握手校验失败'));
        return;
      }
      this.attach(socket, head);
    });
    req.on('response', (res) => {
      this.emit('error', new Error('WS 升级被拒绝 (HTTP ' + res.statusCode + ')'));
      req.destroy();
      this.onClose();
    });
    req.on('error', (e) => {
      this.emit('error', e);
      if (!this.socket) this.onClose();
    });
    req.end();
  }

  onClose() {
    if (this.finished) return;
    this.finished = true;
    this.socket = null;
    this.acc = Buffer.alloc(0);
    this.frags = null;
    this.emit('close');
  }

  close() {
    this.byUs = true;
    try {
      this.sendRaw(Buffer.alloc(0), 0x08);
    } catch {}
    if (this.socket) this.socket.end();
    setTimeout(() => {
      if (this.socket) this.socket.destroy();
    }, 500);
  }

  feed(buf) {
    this.acc = Buffer.concat([this.acc, buf]);
    for (;;) {
      if (this.acc.length < 2) return;
      const b0 = this.acc[0];
      const b1 = this.acc[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.acc.length < 4) return;
        len = this.acc.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.acc.length < 10) return;
        const big = this.acc.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) {
          this.close();
          return;
        }
        len = Number(big);
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.acc.length < off + 4) return;
        maskKey = this.acc.subarray(off, off + 4);
        off += 4;
      }
      if (this.acc.length < off + len) return;
      const payload = Buffer.from(this.acc.subarray(off, off + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      this.acc = this.acc.subarray(off + len);
      this.onFrame(fin, opcode, payload);
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x09) {
      this.sendRaw(payload, 0x0a); // ping → pong
      return;
    }
    if (opcode === 0x0a) return;
    if (opcode === 0x08) {
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        const reason = payload.slice(2).toString('utf8');
        this.emit('close-info', code, reason);
      }
      if (!this.byUs) {
        try {
          this.sendRaw(Buffer.alloc(0), 0x08);
        } catch {}
      }
      this.onClose();
      return;
    }
    if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
      if (opcode !== 0x00) {
        this.frags = payload;
        this.fragOp = opcode;
      } else {
        if (this.frags === null) return;
        this.frags = Buffer.concat([this.frags, payload]);
      }
      if (fin && this.frags !== null) {
        const full = this.frags;
        const op = this.fragOp;
        this.frags = null;
        this.emit('message', op === 0x01 ? full.toString('utf8') : full, op === 0x01 ? 'text' : 'binary');
      }
    }
  }

  sendRaw(payload, opcode) {
    if (!this.socket) throw new Error('未连接');
    const needMask = this.role === 'client';
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, (needMask ? 0x80 : 0) | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = (needMask ? 0x80 : 0) | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = (needMask ? 0x80 : 0) | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    if (!needMask) {
      this.socket.write(Buffer.concat([header, payload]));
      return;
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendText(s) {
    this.sendRaw(Buffer.from(s, 'utf8'), 0x01);
  }

  sendBinary(b) {
    this.sendRaw(b, 0x02);
  }
}

// WS 服务端：供“面板主动连接 Agent”模式使用（Agent 监听端口）
class WSServer extends EventEmitter {
  constructor({ port, host = '0.0.0.0', path: wsPath = '/agent/ws', tls = null }) {
    super();
    this.port = port;
    this.host = host;
    this.path = wsPath;
    this.tls = tls; // { cert, key } → 走 wss://（自签证书即可，面板侧固定指纹）
    this.server = null;
  }

  listen() {
    if (this.tls) {
      // TLS：用 https server 的 upgrade 事件（Node 已解析请求头，这里只校验路径并回 101）
      this.server = https.createServer({
        cert: fs.readFileSync(this.tls.cert),
        key: fs.readFileSync(this.tls.key),
      });
      this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    } else {
      this.server = net.createServer((socket) => this.onSocket(socket));
    }
    this.server.on('error', (e) => this.emit('error', e));
    this.server.listen(this.port, this.host, () => this.emit('listening', this.port));
  }

  wsAccept(key) {
    return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  }

  pathOk(urlPath) {
    return urlPath === this.path || urlPath === this.path + '/';
  }

  onUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const urlPath = String(req.url || '').split('?')[0];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || !this.pathOk(urlPath)) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${this.wsAccept(key)}\r\n\r\n`,
    );
    const ws = new WSSocket('server');
    ws.attach(socket, head);
    this.emit('connection', ws, (req.socket && req.socket.remoteAddress) || '');
  }

  close() {
    if (this.server) this.server.close();
  }

  onSocket(socket) {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16 * 1024) socket.destroy();
        return;
      }
      socket.removeListener('data', onData);
      const head = buf.subarray(0, idx).toString('utf8');
      const rest = buf.subarray(idx + 4);
      const lines = head.split('\r\n');
      const m = /^GET\s+(\S+)\s+HTTP\/1\.1$/.exec(lines[0] || '');
      const hdrs = {};
      for (const line of lines.slice(1)) {
        const k = line.indexOf(':');
        if (k > 0) hdrs[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
      }
      const reqPath = m ? m[1].split('?')[0] : '';
      const ok =
        m &&
        (hdrs.upgrade || '').toLowerCase() === 'websocket' &&
        hdrs['sec-websocket-key'] &&
        this.pathOk(reqPath);
      if (!ok) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = this.wsAccept(hdrs['sec-websocket-key']);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const ws = new WSSocket('server');
      ws.attach(socket, rest);
      this.emit('connection', ws, socket.remoteAddress);
    };
    socket.on('data', onData);
    socket.on('error', () => {});
    socket.on('close', () => socket.removeListener('data', onData));
  }
}

// 面板地址允许只给到根路径（如 ws://host:3080），Agent 端点固定为 <base>/agent/ws
function panelWsUrl(base) {
  const u = new URL(String(base));
  const prefix = u.pathname === '/' || u.pathname === '' ? '' : u.pathname.replace(/\/$/, '');
  u.pathname = prefix + '/agent/ws';
  return u.toString();
}

// ---------- 握手（双向认证） ----------
// client 发 hello → server 回 challenge → client 发 proof(auth1) → server 校验并回 ready(proof=auth2)
// 任一侧未持有正确 token 都会被对方拒绝；token 本身不在网络上传输。
// 会话密钥：HKDF(token, salt = nonceClient || nonceServer)，agent 用 kA2P 发、kP2A 收。
function verifyProof(keys, label, nonceC, nonceP, proofB64, who) {
  const want = computeProof(keys.kProof, label, nonceC, nonceP);
  const got = Buffer.from(String(proofB64 || ''), 'base64');
  if (envFlag('BLOCKNEXUS_DEBUG_HANDSHAKE')) {
    // ⚠ 刻意**不打印 kProof**：它是 HKDF 从 token 派生的**密钥本身**，
    // 打前 64 bit 就等于把密钥的一部分写进日志；而这行调试输出本来是长期留在
    // 服务器上的（systemd journal），泄露面是持续的。
    // 诊断握手不匹配并不需要它——对比 want/got 前缀已经足够定位「哪一侧的 proof 不对」。
    // nonce 是握手时明文传输的公开值，want/got 是 HMAC 输出，泄露它们不揭示密钥。
    console.error('[dbg] label=' + label +
      ' nonceC=' + nonceC.toString('hex') +
      ' nonceP=' + nonceP.toString('hex') +
      ' want=' + want.toString('hex').slice(0, 16) +
      ' got=' + got.toString('hex').slice(0, 16));
  }
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    throw new Error((who || '对端') + '未持有正确 token');
  }
}

function runHandshake(ws, opts) {
  const { role, timeoutMs = 15000 } = opts;
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
    const send = (obj) => ws.sendText(JSON.stringify(obj));

    if (role === 'client') {
      nonceC = crypto.randomBytes(16);
      send({
        t: 'hello',
        v: 1,
        agent: VERSION,
        serverId,
        ts: Date.now(),
        nonce: nonceC.toString('base64url'),
      });
    }

    ws.on('message', (data, kind) => {
      try {
        if (kind !== 'text') throw new Error('握手阶段期望文本帧');
        const msg = JSON.parse(String(data));
        if (state === 'await-hello') {
          if (msg.t !== 'hello') throw new Error('期望 hello');
          if (opts.resolveHello) {
            const resolved = opts.resolveHello(msg);
            if (!resolved) throw new Error('未知服务器 ' + msg.serverId);
            serverId = resolved.serverId;
            token = resolved.token;
          } else if (String(msg.serverId) !== String(serverId)) {
            // 监听模式：本机只服务一个身份，校验 hello 里的 id 是否匹配
            throw new Error('服务器 ID 不匹配');
          }
          if (Math.abs(Date.now() - Number(msg.ts || 0)) > 5 * 60e3) throw new Error('时钟偏差过大');
          nonceC = Buffer.from(String(msg.nonce || ''), 'base64url');
          if (nonceC.length !== 16) throw new Error('nonce 长度错误');
          nonceP = crypto.randomBytes(16);
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
          verifyProof(keys, 'auth1', nonceC, nonceP, msg.proof, '面板');
          send({
            t: 'ready',
            proof: computeProof(keys.kProof, 'auth2', nonceC, nonceP).toString('base64'),
          });
          done(null, keys);
          return;
        }
        if (state === 'await-ready') {
          if (msg.t !== 'ready') throw new Error('握手失败：' + JSON.stringify(msg).slice(0, 80));
          verifyProof(keys, 'auth2', nonceC, nonceP, msg.proof, '面板');
          done(null, keys);
        }
      } catch (e) {
        done(e);
      }
    });
    ws.on('close', () => done(new Error('连接在握手期间关闭')));
    ws.on('error', (e) => done(e));
  });
}

module.exports = { WS_GUID, WSSocket, WSServer, panelWsUrl, verifyProof, runHandshake, envFlag };
