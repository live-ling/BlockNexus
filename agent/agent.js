'use strict';
// BlockNexus Agent —— 零依赖单文件（仅用 Node.js 标准库），由面板通过 SSH 安装到远程服务器。
//
//   node agent.js --panel ws://面板地址:3080 --token <服务器token> --id <服务器ID>
//   （也可省略参数，读取同目录 agent.json，字段: panel/token/id）
//
// 职责：主动回连面板（WebSocket）→ token 挑战握手 → AES-256-GCM 加密通道 →
//       执行面板下发的 MC 实例操作（创建/下载/启动/停止/控制台/删除）。

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns');
const { spawn, spawnSync, execFile } = require('child_process');
const { EventEmitter } = require('events');

const VERSION = 'BlockNexus/0.1.0';
// Agent 脚本版本：面板读取本文件头部的这个常量判断远端是否落后（不一致自动更新）
const AGENT_VERSION = '0.2.0';
let INSECURE_TLS = false; // 由配置载入后置位（见 loadConfig）
const FRAME_VERSION = 0x01;
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
// 版本清单镜像源：官方源不可达（超时/被墙）时依次回退；镜像返回的版本 JSON 与
// server.jar 下载地址同样指向镜像，因此创建实例的整条下载链路都会自动走可用源
const MANIFEST_MIRRORS = ['https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'];
// Mojang 的元数据/文件托管主机：镜像源可用相同路径代理（清单来自镜像时其 URL 已指向镜像）
const MOJANG_FILE_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com'];
const MANIFEST_TTL = 3600e3; // 内存/磁盘缓存有效期（1 小时）
const STALE_TTL = 7 * 24 * 3600e3; // 磁盘缓存兜底有效期（7 天）

// ============================ 配置 ============================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i]] = argv[i + 1];
  }
  return out;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  let cfg = {};
  const cfgFile = path.join(__dirname, 'agent.json');
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {}
  const listenRaw = args['--listen'] || process.env.BLOCKNEXUS_LISTEN || cfg.listen;
  const tlsCert = args['--tls-cert'] || process.env.BLOCKNEXUS_TLS_CERT || (cfg.tls && cfg.tls.cert);
  const tlsKey = args['--tls-key'] || process.env.BLOCKNEXUS_TLS_KEY || (cfg.tls && cfg.tls.key);
  const conf = {
    mode: 'connect',
    panel: args['--panel'] || process.env.BLOCKNEXUS_PANEL || cfg.panel || null,
    listen: listenRaw ? Number(listenRaw) : null,
    token: args['--token'] || process.env.BLOCKNEXUS_TOKEN || cfg.token,
    id: args['--id'] || process.env.BLOCKNEXUS_ID || cfg.id,
    dir: args['--dir'] || __dirname,
  };
  conf.tls = tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : null;
  if (conf.listen) {
    // 监听模式：Agent 在公网开放端口，由面板主动连入（推荐）
    conf.mode = 'listen';
    conf.panel = null;
    if (!Number.isInteger(conf.listen) || conf.listen < 1 || conf.listen > 65535) {
      console.error('--listen 端口不合法');
      process.exit(1);
    }
  }
  INSECURE_TLS = args['--insecure'] === undefined ? !!cfg.tlsInsecure : true;
  conf.instances = args['--instances'] || path.join(conf.dir, 'instances');
  if ((!conf.panel && !conf.listen) || !conf.token || !conf.id) {
    console.error(
      '缺少配置：需要 --token / --id，并给出 --listen <端口>（面板连入）或 --panel <面板地址>（Agent 连出）',
    );
    process.exit(1);
  }
  return conf;
}

// ============================ 加密 ============================
// 与面板 panel/crypto.js 保持一致（Agent 必须零依赖单文件，故内联一份）。

function hkdf(ikm, salt, info, length = 32) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const t = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]))
    .digest();
  return t.subarray(0, length);
}

function deriveKeys(token, nonceA, nonceP) {
  const salt = Buffer.concat([nonceA, nonceP]);
  // info 标签沿用 MCPan 时代的 'mcpan/*'：与 panel/crypto.js 两端必须一致，
  // 改名会让旧 Agent 与新面板握手失败（解密互相踢），等统一弃用旧 Agent 再换
  return {
    kA2P: hkdf(token, salt, 'mcpan/a2p'),
    kP2A: hkdf(token, salt, 'mcpan/p2a'),
    kProof: hkdf(token, salt, 'mcpan/proof'),
  };
}

function computeProof(kProof, label, nonceC, nonceP) {
  return crypto
    .createHmac('sha256', kProof)
    .update(Buffer.concat([Buffer.from(label || 'auth1', 'utf8'), nonceC, nonceP]))
    .digest();
}

function be64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

class Sealer {
  constructor(key) {
    this.key = key;
    this.prefix = crypto.randomBytes(4);
    this.seq = 0;
  }
  seal(plain) {
    const counter = ++this.seq;
    const counterBuf = be64(counter);
    const nonce = Buffer.concat([this.prefix, counterBuf]);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(counterBuf);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.from([FRAME_VERSION]), this.prefix, counterBuf, ct, c.getAuthTag()]);
  }
}

class Opener {
  constructor(key) {
    this.key = key;
    this.last = 0n;
  }
  open(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 13 + 16 || frame[0] !== FRAME_VERSION) {
      throw new Error('坏帧');
    }
    const prefix = frame.subarray(1, 5);
    const counterBuf = frame.subarray(5, 13);
    const counter = frame.readBigUInt64BE(5);
    if (counter <= this.last) throw new Error('重放帧');
    const nonce = Buffer.concat([prefix, counterBuf]);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    d.setAAD(counterBuf);
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(13, frame.length - 16)), d.final()]);
    this.last = counter;
    return plain;
  }
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
      rejectUnauthorized: process.env.BLOCKNEXUS_INSECURE || INSECURE_TLS ? false : true,
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
  if (process.env.BLOCKNEXUS_DEBUG_HANDSHAKE) {
    console.error('[dbg] label=' + label +
      ' nonceC=' + nonceC.toString('hex') +
      ' nonceP=' + nonceP.toString('hex') +
      ' kProof=' + keys.kProof.toString('hex').slice(0, 16) +
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

// 把 Mojang 托管的下载地址按原路径改写到镜像主机（BMCLAPI 支持相同路径代理）
function withMirror(urlStr, mirrorHost) {
  try {
    const u = new URL(urlStr);
    if (MOJANG_FILE_HOSTS.includes(u.host) && mirrorHost) {
      u.host = mirrorHost;
      return u.toString();
    }
  } catch {}
  return urlStr;
}

function mirrorHostOf() {
  try {
    return new URL(MANIFEST_MIRRORS[0]).host;
  } catch {
    return null;
  }
}

// ============================ 服务端核心目录 ============================
// 原版走 Mojang 清单；Paper/Purpur/Folia 有官方 API 可直接拿到 jar 直链；
// Fabric/Forge/NeoForge 没有可直连的服务端 jar，只能用官方安装器现场安装。
// 所有目录都带磁盘缓存：拉不到在线清单时退回缓存，保证建实例这一步不因网络抖动卡死。

const CORE_KINDS = [
  // api=true 表示有远端版本目录（coreVersionsFor 能给出可安装版本）
  { id: 'vanilla', label: '原版 Vanilla', api: true },
  { id: 'paper', label: 'Paper', api: true },
  { id: 'purpur', label: 'Purpur', api: true },
  { id: 'folia', label: 'Folia', api: true },
  { id: 'fabric', label: 'Fabric', api: true },
  { id: 'forge', label: 'Forge', api: true },
  { id: 'neoforge', label: 'NeoForge', api: true },
  { id: 'url', label: '自定义 URL', api: false },
  { id: 'upload', label: '上传本地核心', api: false },
];

const PAPER_API = 'https://fill.papermc.io/v3/projects'; // v2 已下线（410 sunset）
// server.jar 实为 paperclip 引导器的来源：首次启动要自己去 piston-data.mojang.com 下载
// 原版核心到 cache/，国内服务器连不上官方源会一直启动失败 —— 需要面板预置该文件
const PAPERCLIP_SOURCES = new Set(['paper', 'purpur', 'folia']);
const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';
const FABRIC_GAME_API = 'https://meta.fabricmc.net/v2/versions/game';
const FABRIC_LOADER_API = 'https://meta.fabricmc.net/v2/versions/loader';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
// Fabric 安装器版本：官方 maven 上的固定版本，只在有新特性时才手动跟进
const FABRIC_INSTALLER = '1.1.2';
const FABRIC_INSTALLER_JAR = `fabric-installer-${FABRIC_INSTALLER}.jar`;
// NeoForge 版本号与 MC 版本的对应关系没有公开 API，只能用已知的主版本段映射（新版本取最新段）
const NEOFORGE_MC_PREFIX = {
  '1.21.1': '21.1.',
  '1.21.2': '21.2.',
  '1.21.3': '21.3.',
  '1.21.4': '21.4.',
  '1.21.5': '21.5.',
  '1.21.6': '21.6.',
  '1.21.7': '21.7.',
  '1.21.8': '21.8.',
  '1.21.9': '21.9.',
  '1.21.10': '21.10.',
  '1.20.5': '20.5.',
  '1.20.6': '20.6.',
  '1.20.4': '20.4.',
  '1.20.3': '20.3.',
  '1.20.2': '20.2.',
  '1.20.1': '20.1.',
  '1.20': '20.1.',
  '1.19.4': '19.4.',
  '1.19.3': '19.3.',
  '1.19.2': '19.2.',
  '1.18.2': '18.2.',
};

/** 从 maven-metadata.xml 里抽出所有 <version> */
function mavenVersions(xml) {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

// ============================ MSL 镜像源 ============================
// MSL 开服器公共镜像（https://www.mslmc.cn，api.mslmc.cn/v4）：官方源不可用时的兜底。
// 使用要求：请求带含应用名的 User-Agent；API 有 QPS 限制，因此仅在官方源失败后才调用。
// 支持的核心名与内置来源同名：vanilla/paper/purpur/folia/forge/neoforge/fabric。
const MSL_API = 'https://api.mslmc.cn/v4';
// 可走 MSL 兜底的来源（url/upload 是用户自备的，不在此列）
const MSL_SOURCES = new Set(['vanilla', 'paper', 'purpur', 'folia', 'forge', 'neoforge', 'fabric']);

/** MSL 接口统一走 UA + 解包 {code,message,data}；code!==200 视为失败 */
async function mslFetchJson(suffix, timeoutMs = 15000) {
  const d = await fetchJson(MSL_API + suffix, timeoutMs);
  if (!d || d.code !== 200) throw new Error((d && d.message) || 'MSL 接口返回 ' + (d && d.code));
  return d.data;
}

/** sha256 校验（MSL 等源会返回 hash，下载后核对防止 CDN 缓存损坏） */
// 子进程命令（压缩/解压用系统 tar/zip）：stderr 留尾作错误信息；超时强杀
function runCmd(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('操作超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error((e.code === 'ENOENT' ? '系统缺少命令 ' + cmd + '：' : '') + (e.message || '启动失败')));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const tail = String(err).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      reject(new Error(tail || `${cmd} 退出码 ${code}`));
    });
  });
}

// tar 可执行文件解析：Windows 锁定系统自带 bsdtar（支持 zip/tar.gz、无 GNU tar 的
// “C: 被当作远程主机”问题），避免 Git Bash/MSYS 等环境里 PATH 上的 GNU tar 抢占；
// Linux 直接用 PATH 里的 tar
let tarCmdCache = null;
function tarCmd() {
  if (tarCmdCache === null) {
    if (process.platform === 'win32') {
      const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      tarCmdCache = fs.existsSync(sys) ? sys : 'tar';
    } else {
      tarCmdCache = 'tar';
    }
  }
  return tarCmdCache;
}

function verifyHash(file, expected, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => {
      const got = hash.digest('hex');
      if (expected && got.toLowerCase() === String(expected).toLowerCase()) resolve();
      else reject(new Error(`${algo} 校验失败（期望 ${String(expected).slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`));
    });
  });
}

/** 语义化比较，用于给版本号排序（1.21.10 > 1.21.9） */
function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const s = String(pa[i] ?? '').localeCompare(String(pb[i] ?? ''));
      if (s) return s;
    } else if (na !== nb) return na - nb;
  }
  return 0;
}

// ============================ HTTP 工具 ============================

// 部分镜像源（如清华 TUNA）会对不带 User-Agent 的请求返回 403，node 默认不带，必须显式设置。
// MSL 镜像源要求 UA 含应用名，统一用同一份。
const HTTP_UA = 'BlockNexus/0.1.0';

function downloadToFile(urlStr, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('重定向过多'));
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ': ' + u));
        }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total && onProgress) onProgress(got, total);
        });
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () => resolve(dest));
      });
      req.on('error', (e) => reject(new Error((e.message || '网络错误') + ' — ' + u)));
      req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    };
    get(urlStr, 0);
  });
}

function fetchJson(urlStr, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 5) return reject(new Error('重定向过多'));
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ': ' + u));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    };
    get(urlStr, 0);
  });
}

// ============================ 实例管理 ============================

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function fmtSize(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** exp).toFixed(exp ? 1 : 0)} ${units[exp]}`;
}

// ---------- Minecraft 服务器列表查询（SLP，Server List Ping）----------
// 纯协议实现：TCP 连本机实例端口，按 Minecraft 协议握手 + 状态请求，读回 JSON。

function mcVarint(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function mcPing(host, port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try {
        socket.destroy();
      } catch {}
      err ? reject(err) : resolve(data);
    };
    // 硬性总超时：连接卡在建连/读数据时也要按时结束（面板侧请求不能久等）
    const deadline = setTimeout(() => finish(new Error('查询超时')), timeoutMs + 500);
    socket.setTimeout(timeoutMs, () => finish(new Error('连接超时')));
    socket.on('error', (e) => finish(e));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = Buffer.concat([
        mcVarint(0x00),
        mcVarint(765), // 协议版本（状态查询不校验，随便填一个较新的值）
        mcVarint(hostBuf.length),
        hostBuf,
        portBuf,
        mcVarint(1), // next state = status
      ]);
      socket.write(
        Buffer.concat([
          mcVarint(handshake.length),
          handshake,
          mcVarint(1),
          mcVarint(0x00), // status request
        ]),
      );
    });
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let off = 0;
      const readVarint = () => {
        let result = 0;
        let shift = 0;
        for (;;) {
          if (off >= buf.length) throw new Error('数据不完整');
          const b = buf[off++];
          result |= (b & 0x7f) << shift;
          if (!(b & 0x80)) break;
          shift += 7;
          if (shift > 35) throw new Error('varint 过长');
        }
        return result >>> 0;
      };
      try {
        const packetLen = readVarint();
        if (buf.length < off + packetLen) return; // 还没收齐
        readVarint(); // packetId
        const strLen = readVarint();
        if (buf.length < off + strLen) return;
        const json = buf.subarray(off, off + strLen).toString('utf8');
        const data = JSON.parse(json);
        finish(null, {
          online: data.players ? data.players.online : null,
          max: data.players ? data.players.max : null,
          // 状态响应里的玩家名单（原版服务端通常给出全部或前 12 名）
          players:
            data.players && Array.isArray(data.players.sample)
              ? data.players.sample.map((p) => p && p.name).filter(Boolean)
              : null,
          motd: typeof data.description === 'string' ? data.description : data.description && data.description.text,
          version: data.version && data.version.name,
        });
      } catch {
        // 数据还没到齐，等下一批
      }
    });
  });
}

class InstanceManager {
  constructor(instancesDir) {
    this.dir = instancesDir;
    this.map = new Map(); // name -> { meta, proc, startedAt, buf, pending, flushTimer, stopping }
    this.versionsCache = null;
    this.javaNetFlags = new Map(); // host -> 安装器进程的 JVM 网络参数（IPv4 不通时的 IPv6 兜底）
    this.uploads = new Map(); // uploadId -> {finalPath, tmpPath, received, seq, at}
    this.downloads = new Map(); // downloadId -> {fd, pos, size, at}
    this.javaJob = null; // Java 安装后台任务（防重复触发）
    fs.mkdirSync(this.dir, { recursive: true });
    this.scan();
    // 清理过期传输会话；每 30 秒检查看门狗的定时重启任务
    setInterval(() => this.gcTransferSessions(), 10 * 60e3).unref();
    setInterval(() => this.checkWatchdogSchedules(), 30e3).unref();
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
      // 更名迁移：MCPan 时代的实例元数据叫 mcpan.json，首次扫到时改名升级
      if (!fs.existsSync(metaFile)) {
        const legacy = path.join(this.dir, name, 'mcpan.json');
        try {
          if (fs.existsSync(legacy)) fs.renameSync(legacy, metaFile);
        } catch {}
      }
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        this.map.set(name, { meta, proc: null, startedAt: null, buf: [], pending: [], flushTimer: null });
      } catch {}
    }
  }

  statusOf(rec) {
    // 进程起来了但还没打印「Done (x.xxxs)!」就绪信号 → 启动中（MC 服务端要十几秒~数分钟才可连接）
    if (rec.proc) return rec.ready === false ? 'starting' : 'running';
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
      status: this.statusOf(rec),
      pid: rec.proc ? rec.proc.pid : null,
      startedAt: rec.startedAt,
      createdAt: rec.meta.createdAt,
      // 安装失败的原因（重试入口要展示给用户）
      error: rec.meta.error || '',
    }));
  }

  // ---------- 看门狗：崩溃自动重启 + 定时重启 ----------
  defaultWatchdog() {
    return { autoRestart: false, restartDelaySec: 5, schedules: [] };
  }

  setWatchdog(name, cfg = {}) {
    const rec = this.get(name);
    const cur = rec.meta.watchdog || this.defaultWatchdog();
    const next = { ...cur };
    if (cfg.autoRestart !== undefined) next.autoRestart = !!cfg.autoRestart;
    if (cfg.restartDelaySec !== undefined) {
      next.restartDelaySec = Math.min(Math.max(Number(cfg.restartDelaySec) || 5, 1), 300);
    }
    if (Array.isArray(cfg.schedules)) {
      next.schedules = cfg.schedules.slice(0, 10).map((s) => {
        const prev = (cur.schedules || []).find((x) => x.id === s.id);
        return {
          id: String(s.id || crypto.randomBytes(4).toString('hex')),
          enabled: s.enabled !== false,
          type: s.type === 'interval' ? 'interval' : 'daily',
          time: /^\d{1,2}:\d{2}$/.test(s.time || '') ? s.time : '04:00',
          days: Array.isArray(s.days) ? s.days.filter((d) => d >= 0 && d <= 6) : [],
          intervalMinutes: Math.min(Math.max(Number(s.intervalMinutes) || 360, 5), 10080),
          // 新任务从现在开始计时，避免保存后立刻触发；老任务保留上次触发时间
          lastFiredAt: prev ? prev.lastFiredAt : Date.now(),
        };
      });
    }
    rec.meta.watchdog = next;
    this.saveMeta(rec);
    this.emitUpdated(rec);
    return next;
  }

  // 某个定时任务此刻是否到期
  scheduleDue(s, now) {
    const last = s.lastFiredAt || 0;
    if (s.type === 'daily') {
      if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.getDay())) return false;
      const [h, m] = String(s.time || '04:00').split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return false;
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      const diffMin = (now.getTime() - target.getTime()) / 60000;
      // 到点后 2 分钟窗口内触发一次；20 小时内不重复
      return diffMin >= 0 && diffMin < 2 && now.getTime() - last > 20 * 3600e3;
    }
    if (s.type === 'interval') {
      const mins = Math.min(Math.max(Number(s.intervalMinutes) || 360, 5), 10080);
      return now.getTime() - last >= mins * 60000;
    }
    return false;
  }

  // 每 30 秒检查一次各实例的定时重启任务
  checkWatchdogSchedules() {
    const now = new Date();
    for (const rec of this.map.values()) {
      const wd = rec.meta.watchdog;
      if (!wd || !Array.isArray(wd.schedules) || !wd.schedules.length) continue;
      for (const s of wd.schedules) {
        if (!s.enabled || !this.scheduleDue(s, now)) continue;
        s.lastFiredAt = Date.now();
        this.saveMeta(rec);
        const label = s.type === 'daily' ? `每日 ${s.time}` : `每 ${s.intervalMinutes} 分钟`;
        this.emitConsole(rec, `[BlockNexus] 定时重启触发（${label}）`);
        sendEvent('watchdog.fired', { instance: rec.meta.name, scheduleId: s.id, label });
        if (rec.proc) {
          this.restart(rec.meta.name).catch((e) =>
            this.emitConsole(rec, '[BlockNexus] 定时重启失败: ' + e.message),
          );
        } else {
          this.emitConsole(rec, '[BlockNexus] 定时任务：实例未在运行，已跳过本次重启');
        }
      }
    }
  }

  // 崩溃后延迟自动重启（连续崩溃时逐步退避，最长 60 秒）
  scheduleAutoRestart(rec, code, signal) {
    const wd = rec.meta.watchdog;
    if (!wd || !wd.autoRestart) return;
    const now = Date.now();
    rec.crashTimes = (rec.crashTimes || []).filter((t) => now - t < 10 * 60e3);
    rec.crashTimes.push(now);
    const base = Math.min(Math.max(Number(wd.restartDelaySec) || 5, 1), 300);
    const delay = Math.min(base * rec.crashTimes.length, 60);
    this.emitConsole(
      rec,
      `[BlockNexus] 检测到异常退出 (code=${code}${signal ? ' signal=' + signal : ''})，${delay} 秒后自动重启` +
        (rec.crashTimes.length > 1 ? `（10 分钟内第 ${rec.crashTimes.length} 次）` : ''),
    );
    sendEvent('watchdog.restarting', {
      instance: rec.meta.name,
      code,
      signal: signal || null,
      delay,
      attempt: rec.crashTimes.length,
    });
    clearTimeout(rec.restartTimer);
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = null;
      // 实例可能已被删除/已手动启动，需再确认
      if (this.map.get(rec.meta.name) !== rec || rec.proc) return;
      this.start(rec.meta.name).catch((e) =>
        this.emitConsole(rec, '[BlockNexus] 自动重启失败: ' + e.message),
      );
    }, delay * 1000);
  }

  // server.properties 里的 max-players（拿不到时默认 20）
  readMaxPlayers(rec) {
    try {
      const txt = fs.readFileSync(path.join(this.dir, rec.meta.name, 'server.properties'), 'utf8');
      const m = /^max-players=(\d+)/m.exec(txt);
      return m ? Number(m[1]) : 20;
    } catch {
      return 20;
    }
  }

  // server.properties 里的 server-ip（服务端绑定的网卡地址；空/0.0.0.0 表示全部网卡）
  readServerIp(rec) {
    try {
      const txt = fs.readFileSync(path.join(this.dir, rec.meta.name, 'server.properties'), 'utf8');
      const m = /^server-ip=(.*)$/m.exec(txt);
      const ip = m ? m[1].trim() : '';
      return ip && ip !== '0.0.0.0' ? ip : '';
    } catch {
      return '';
    }
  }

  // 批量查询运行中实例的在线人数与玩家名单
  // 人数/上限优先用 SLP 实测；名单 = SLP sample ∪ 控制台跟踪（原版 sample 上限 12 条，
  // 且 hide-online-players 时为空），SLP 不通时退回跟踪结果并标 unreachable
  async playersSnapshot() {
    const out = {};
    await Promise.all(
      [...this.map.values()]
        .filter((rec) => rec.proc)
        .map(async (rec) => {
          const tracked = rec.players ? [...rec.players] : [];
          const max = this.readMaxPlayers(rec);
          // 服务端只监听指定网卡时 127.0.0.1 连不上，优先查 server-ip，再兜底回环
          const bound = this.readServerIp(rec);
          const hosts = [...new Set(bound ? [bound, '127.0.0.1'] : ['127.0.0.1'])];
          const port = rec.runtimePort ?? rec.meta.port;
          let r = null;
          for (const host of hosts) {
            try {
              r = await mcPing(host, port, 1500);
              break;
            } catch {
              // 换下一个候选地址
            }
          }
          if (!r) {
            out[rec.meta.name] = {
              // SLP 不通时人数用跟踪结果兜底（enable-status=false 的服也能显示在线数）
              online: tracked.length || null,
              max,
              list: tracked.length ? tracked : null,
              running: true,
              unreachable: true,
            };
            return;
          }
          let list = tracked;
          if (r.players && r.players.length) {
            list = [...new Set([...r.players, ...tracked])];
          }
          if (r.online === 0) {
            list = [];
            if (rec.players) rec.players.clear(); // SLP 实测无人：清掉跟踪集里可能过期的鬼影
          }
          out[rec.meta.name] = {
            // 个别服务端/代理的状态响应不带 players 对象：用跟踪数兜底
            online: r.online ?? (tracked.length || null),
            max: r.max ?? max,
            list,
            running: true,
          };
        }),
    );
    return out;
  }

  // ---------- 封禁目录：banned-players.json / banned-ips.json 的查看与解封 ----------
  // 运行中走控制台 pardon 命令（服务器内存里的封禁表才是真相源）；停止时直接改 JSON 文件
  banList(name) {
    const rec = this.get(name);
    const dir = this.instDir(name);
    const readJson = (file) => {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) return [];
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    };
    const st = this.statusOf(rec);
    return {
      players: readJson('banned-players.json'),
      ips: readJson('banned-ips.json'),
      running: st === 'running' || st === 'starting',
    };
  }

  banUnban(name, kind, target) {
    const rec = this.get(name);
    const t = String(target || '').trim();
    if (!t) throw new Error('缺少解封目标');
    const st = this.statusOf(rec);
    if (st === 'running' || st === 'starting') {
      const cmd = kind === 'ip' ? `pardon-ip ${t}` : `pardon ${t}`;
      this.command(name, cmd);
      return { ok: true, via: 'console' };
    }
    // 停止状态：服务器不在运行，直接从 JSON 里移除该条目
    const file = kind === 'ip' ? 'banned-ips.json' : 'banned-players.json';
    const p = path.join(this.instDir(name), file);
    if (!fs.existsSync(p)) return { ok: true, via: 'file' };
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      throw new Error(file + ' 不是合法 JSON，请用文件管理器检查');
    }
    const filtered = arr.filter((e) => e && (kind === 'ip' ? e.ip : e.name) !== t);
    fs.writeFileSync(p, JSON.stringify(filtered, null, 2));
    return { ok: true, via: 'file' };
  }

  // ---------- server-icon：64x64 PNG（前端压缩后以 base64 上传） ----------
  iconPath(name) {
    return path.join(this.instDir(name), 'server-icon.png');
  }

  iconGet(name) {
    const p = this.iconPath(name);
    if (!fs.existsSync(p)) return { ok: false };
    return { ok: true, b64: fs.readFileSync(p).toString('base64') };
  }

  iconSet(name, b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length || buf.length > 200 * 1024) throw new Error('图片数据无效（64x64 PNG 应远小于 200KB）');
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      throw new Error('仅支持 PNG 格式');
    }
    fs.writeFileSync(this.iconPath(name), buf);
    return { ok: true };
  }

  // 域名连通检测：解析实例「域名」并 TCP 探测实例端口。
  // 先查 Minecraft SRV 记录（_minecraft._tcp.<域名>，命中则用 SRV 的目标与端口），
  // 无 SRV 回退 A 记录 + meta 端口；探测对象是解析出的 IP，玩家视角的连通性。
  async domainCheck(name) {
    const rec = this.get(name);
    const raw = String(rec.meta.address || '').trim();
    if (!raw) throw new Error('该实例未设置域名');
    const dns = require('dns').promises;
    const net = require('net');
    // 地址允许手滑带协议头或端口，统一剥干净
    let domain = raw.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    let explicitPort = null;
    const pm = domain.match(/^(.+):(\d+)$/);
    if (pm && !net.isIP(pm[1])) {
      domain = pm[1];
      explicitPort = Number(pm[2]);
    }
    const out = {
      domain,
      srv: null,
      host: domain,
      ip: null,
      port: explicitPort ?? rec.runtimePort ?? rec.meta.port,
      tcp: false,
      latencyMs: null,
      error: null,
    };
    try {
      try {
        const records = await dns.resolveSrv('_minecraft._tcp.' + domain);
        if (records && records.length) {
          records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
          out.srv = { host: records[0].name, port: records[0].port };
          out.host = records[0].name;
          out.port = records[0].port;
        }
      } catch {} // 无 SRV 是常态，走 A 记录
      const addrs = await dns.resolve4(out.host).catch(() => null);
      out.ip = addrs ? addrs[0] : (await dns.lookup(out.host)).address;
      const t0 = Date.now();
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: out.ip, port: out.port }, () => {
          out.tcp = true;
          out.latencyMs = Date.now() - t0;
          sock.destroy();
          resolve();
        });
        sock.setTimeout(3000, () => {
          sock.destroy();
          reject(new Error('TCP 连接超时（3 秒）'));
        });
        sock.on('error', (e) => reject(new Error('TCP 连接失败: ' + e.message)));
      });
    } catch (e) {
      out.error = e.message || '检测失败';
    }
    return out;
  }

  // ---------- Mod 管理：实例 mods 目录的列表 / 启停（.disabled 后缀约定）/ 删除 ----------
  // 全部路径锁定在 instances/<name>/mods 内；禁用 = 改名加 .disabled（Forge/Fabric 通用约定）
  modsDir(name) {
    return path.join(this.instDir(name), 'mods');
  }

  modsList(name) {
    const rec = this.get(name);
    const dir = this.modsDir(name);
    const out = [];
    let exists = true;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        let file = ent.name;
        let disabled = false;
        if (file.toLowerCase().endsWith('.disabled')) {
          disabled = true;
          file = ent.name.slice(0, -'.disabled'.length);
        }
        if (!/\.jar$/i.test(file)) continue;
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(dir, ent.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch {}
        out.push({ name: file, file: ent.name, disabled, size, mtime });
      }
    } catch (e) {
      if (e.code === 'ENOENT') exists = false;
      else throw e;
    }
    out.sort((a, b) => a.disabled - b.disabled || a.name.localeCompare(b.name));
    return { exists, dir, mods: out };
  }

  modsToggle(name, file, disable) {
    const dir = path.resolve(this.modsDir(name));
    const base = String(file || '');
    if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) {
      throw new Error('非法文件名');
    }
    const from = path.resolve(dir, base);
    if (!from.startsWith(dir + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(from)) throw new Error('文件不存在');
    let to;
    if (disable) {
      if (!/\.jar$/i.test(base)) throw new Error('仅 .jar 文件可禁用');
      to = from + '.disabled';
    } else {
      if (!/\.disabled$/i.test(base)) throw new Error('该文件未处于禁用状态');
      to = from.replace(/\.disabled$/i, '');
    }
    if (fs.existsSync(to)) throw new Error('目标文件已存在: ' + path.basename(to));
    fs.renameSync(from, to);
    return { ok: true, file: path.basename(to), disabled: !!disable };
  }

  modsDelete(name, file) {
    const dir = path.resolve(this.modsDir(name));
    const base = String(file || '');
    if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) {
      throw new Error('非法文件名');
    }
    const target = path.resolve(dir, base);
    if (!target.startsWith(dir + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(target)) throw new Error('文件不存在');
    fs.rmSync(target, { force: true });
    return { ok: true };
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

  /**
   * 行缓冲读取器：管道的 data chunk 不保证按行对齐（高负载/长行时会从中间截断），
   * 直接按 chunk split 会把日志行撕成两半——控制台乱行，join/left 跟踪丢事件，
   * 中文等多字节字符还可能从 UTF-8 序列中间切开变乱码。这里按 0x0A 聚齐完整行再解码。
   * 返回的函数带 flush()：流结束时调用，吐出最后一段没有换行符的残留行。
   * @param {(text: string) => void} onLine 收到完整行（已去 \r）时回调；空行不回调
   */
  makeLineSplitter(onLine) {
    const MAX_REST = 1024 * 1024; // 超长无换行输出的保护阀，防止内存无限增长
    let rest = null;
    const emit = (buf) => {
      const text = buf.toString('utf8').replace(/\r$/, '');
      if (text.trim()) onLine(text);
    };
    const feed = (chunk) => {
      let buf = rest ? Buffer.concat([rest, chunk]) : chunk;
      for (;;) {
        const i = buf.indexOf(0x0a);
        if (i < 0) break;
        const line = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        emit(line);
      }
      if (buf.length > MAX_REST) {
        // 阀值兜底：把积压当一行吐出去，避免恶意/异常输出吃内存
        emit(buf);
        rest = null;
      } else {
        rest = buf.length ? Buffer.from(buf) : null;
      }
    };
    feed.flush = () => {
      if (rest) {
        emit(rest);
        rest = null;
      }
    };
    return feed;
  }

  // 从控制台日志跟踪在线玩家（原版 SLP 无人在线时不返回名单，这里作为可靠兜底）
  //   加入：  Steve joined the game
  //   离开：  Steve left the game / Steve lost connection: ...
  //   名单：  There are 2 of a max of 20 players online: Steve, Alex
  trackPlayers(rec, line) {
    if (!rec.players) rec.players = new Set();
    const name = '([^\\s]{1,32})';
    let m = new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${name} joined the game\\s*$`).exec(line);
    if (m) {
      rec.players.add(m[1]);
      return;
    }
    m = new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${name} left the game\\s*$`).exec(line);
    if (m) {
      rec.players.delete(m[1]);
      return;
    }
    m = new RegExp(`^\\S*\\s*\\[[^\\]]*\\]:\\s*${name} lost connection`).exec(line);
    if (m) {
      rec.players.delete(m[1]);
      return;
    }
    m = /There are (\d+) of a max of (\d+) players online:?\s*(.*)$/.exec(line);
    if (m) {
      rec.players = new Set(
        (m[3] || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }

  emitUpdated(rec) {
    sendEvent('instance.updated', { instance: rec.meta.name, status: this.statusOf(rec) });
  }

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
  }

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
  }

  /** 重试安装：沿用实例已记录的核心类型/版本/构建，重新走一遍下载与安装 */
  retryInstall(name) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例正在运行，请先停止');
    if (rec.meta.installState === 'downloading') throw new Error('正在安装中');
    if (rec.meta.source === 'upload') throw new Error('上传型核心无需重试，请在文件管理里上传 server.jar');
    this.emitConsole(rec, `[BlockNexus] 重试安装 ${rec.meta.source} ${rec.meta.version}`);
    this.startInstall(rec, rec.meta.source === 'url' ? rec.meta.url : null);
    return { ok: true, download: 'started' };
  }

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
  }

  // ---------- 核心安装 ----------
  // 三类产物形态：
  //   1) 直连 jar（vanilla / paper / purpur / folia / url）→ 下载成 server.jar，直接 -jar 启动
  //   2) 安装器生成的启动脚本（forge / neoforge）→ java @user_jvm_args.txt @libraries/.../args.txt
  //   3) 安装器生成的小启动器（fabric）→ 仍是 -jar，但入口是 fabric-server-launch.jar
  // 后两类没有 server.jar，所以 meta.launch 记录了启动方式，start() 按它拼命令。

  /**
   * 把「核心类型 + 版本（+可选构建号）」解析成一个可下载/可执行的安装计划。
   * 官方源失败时走 MSL 镜像兜底（见 mslResolvePlan）。
   */
  async resolveCorePlan(rec) {
    const { source, version, build } = rec.meta;
    try {
      return await this.resolveCorePlanOfficial(rec);
    } catch (officialErr) {
      if (!MSL_SOURCES.has(source)) throw officialErr;
      try {
        const plan = await this.mslResolvePlan(source, version, build);
        this.emitConsole(rec, `[BlockNexus] 官方源不可用（${officialErr.message}），改用 MSL 镜像源`);
        return plan;
      } catch (mslErr) {
        this.emitConsole(rec, `[BlockNexus] MSL 镜像也不可用: ${mslErr.message}`);
        throw officialErr; // 镜像失败时保留官方错误（更接近根因）
      }
    }
  }

  /**
   * MSL 镜像兜底：来源+版本（+可选构建）→ 下载计划。
   * paper/purpur/folia/vanilla 返回直连 jar；forge/neoforge 返回官方安装器 jar（现场安装）；
   * fabric 返回官方 server jar（自带启动器，可直接 -jar，首启再拉依赖库）。
   * 部分下载返回 sha256，plan 带上供下载后校验。
   */
  async mslResolvePlan(source, version, build) {
    if (!MSL_SOURCES.has(source)) throw new Error('MSL 不支持该核心类型: ' + source);
    const q = build ? '?build=' + encodeURIComponent(build) : '';
    const d = await mslFetchJson(
      '/download/server/' + encodeURIComponent(source) + '/' + encodeURIComponent(version) + q,
      20000,
    );
    if (!d || !d.url) throw new Error('MSL 未返回下载地址');
    let fileName = 'server.jar';
    try { fileName = decodeURIComponent(new URL(d.url).pathname.split('/').pop()) || fileName; } catch {}
    const plan = { url: d.url, fileName };
    if (d.sha256) plan.sha256 = d.sha256;
    if (source === 'forge' || source === 'neoforge') {
      const m = new RegExp('^' + source + '-(.+)-installer\\.jar$').exec(fileName);
      plan.kind = source;
      plan.build = (m && m[1]) || (build ? String(build) : undefined);
    } else if (source === 'fabric') {
      plan.kind = 'direct'; // fabric server jar 可直接 -jar 启动
      plan.fileName = 'server.jar';
    } else {
      plan.kind = 'direct';
      if (build) plan.build = String(build);
    }
    return plan;
  }

  /** 官方源解析（resolveCorePlan 主体） */
  async resolveCorePlanOfficial(rec) {
    const { source, version, build } = rec.meta;
    const meta = rec.meta;

    if (source === 'url') {
      return { kind: 'direct', url: meta.url, fileName: 'server.jar' };
    }
    if (source === 'paper' || source === 'folia') {
      // 注意：/versions/{v} 里的 builds 只是构建号数组；完整对象（含下载链接）在 /versions/{v}/builds
      const d = await fetchJson(
        `${PAPER_API}/${source}/versions/${encodeURIComponent(version)}/builds`,
        15000,
      );
      const builds = Array.isArray(d.builds) ? d.builds : Array.isArray(d) ? d : [];
      if (!builds.length) throw new Error(`${source} ${version} 没有可用构建`);
      // 构建号是纯数字递增，取最大的即该 MC 版本的最新构建
      const latest = builds.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
      const pick = build ? builds.find((b) => String(b.id) === String(build)) : latest;
      if (!pick) throw new Error(`构建 #${build} 不存在`);
      const dl = pick.downloads && pick.downloads['server:default'];
      if (!dl || !dl.url) throw new Error('该构建没有服务端下载');
      return { kind: 'direct', url: dl.url, fileName: dl.name || 'server.jar', build: String(pick.id) };
    }
    if (source === 'purpur') {
      const d = await fetchJson(`${PURPUR_API}/${encodeURIComponent(version)}`, 15000);
      const builds = d.builds || {};
      const id = build || builds.latest;
      if (!id) throw new Error(`purpur ${version} 没有可用构建`);
      return {
        kind: 'direct',
        url: `${PURPUR_API}/${encodeURIComponent(version)}/${id}/download`,
        fileName: `purpur-${version}-${id}.jar`,
        build: id,
      };
    }
    if (source === 'fabric') {
      const loaders = await fetchJson(FABRIC_LOADER_API, 15000);
      const loader = Array.isArray(loaders) ? loaders[0] : null;
      if (!loader) throw new Error('未取到 Fabric Loader 版本');
      return {
        kind: 'fabric',
        url: `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${FABRIC_INSTALLER}/${FABRIC_INSTALLER_JAR}`,
        fileName: 'fabric-installer.jar',
        loader: loader.version,
        game: version,
      };
    }
    if (source === 'forge') {
      // build 里存的是完整 maven 版本（如 1.20.1-47.2.0），没带就现查该 MC 版本的最新
      let full = build;
      if (!full) {
        const xml = await this.httpGetText(FORGE_MAVEN, 20000);
        let best = null;
        for (const v of mavenVersions(xml)) {
          const m = new RegExp(`^${version.replace(/\./g, '\\.')}-(.+)$`).exec(v);
          if (m && (!best || cmpVersion(m[1], best.build) > 0)) best = { build: m[1], full: v };
        }
        if (!best) throw new Error(`Forge 没有 ${version} 的版本`);
        full = best.full;
      }
      return {
        kind: 'forge',
        url: `${FORGE_MAVEN_BASE}/${full}/forge-${full}-installer.jar`,
        fileName: `forge-${full}-installer.jar`,
        build: full,
      };
    }
    if (source === 'neoforge') {
      let full = build;
      if (!full) {
        const xml = await this.httpGetText(NEOFORGE_MAVEN, 20000);
        const prefix = NEOFORGE_MC_PREFIX[version];
        if (!prefix) throw new Error(`NeoForge 暂不支持 ${version}（版本映射未知）`);
        let best = null;
        for (const v of mavenVersions(xml)) {
          if (!v.startsWith(prefix)) continue;
          if (!best || cmpVersion(v, best) > 0) best = v;
        }
        if (!best) throw new Error(`NeoForge 没有 ${version} 的版本`);
        full = best;
      }
      return {
        kind: 'neoforge',
        url: `${NEOFORGE_MAVEN_BASE}/${full}/neoforge-${full}-installer.jar`,
        fileName: `neoforge-${full}-installer.jar`,
        build: full,
      };
    }
    // vanilla
    const data = await this.ensureVersions();
    const v = data.versions.find((x) => x.id === version);
    if (!v) throw new Error('版本不存在: ' + version);
    const mirror = mirrorHostOf();
    let vjson;
    try {
      vjson = await fetchJson(v.url);
    } catch (e) {
      if (!mirror || v.url.includes(mirror)) throw e;
      vjson = await fetchJson(withMirror(v.url, mirror));
    }
    const url = vjson.downloads && vjson.downloads.server && vjson.downloads.server.url;
    if (!url) throw new Error('该版本没有服务端下载（可能是快照/旧版）');
    return { kind: 'direct', url, fileName: 'server.jar' };
  }

  async downloadJar(rec, customUrl = null) {
    const { name, version, source } = rec.meta;
    const dir = this.instDir(name);
    const progress = (phase, pct) => sendEvent('install.progress', { instance: name, phase, pct });
    const onPct = (got, total) => {
      if (!total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct % 5 === 0) progress('download', pct);
    };

    progress('download', 0);
    const plan = customUrl
      ? { kind: 'direct', url: customUrl, fileName: 'server.jar' }
      : await this.resolveCorePlan(rec);

    // ---- 安装器类：下载 installer → 现场安装 → 记录启动方式 ----
    if (plan.kind === 'fabric' || plan.kind === 'forge' || plan.kind === 'neoforge') {
      const tmp = path.join(dir, plan.fileName);
      try {
        await downloadToFile(plan.url, tmp, onPct);
        if (plan.sha256) await verifyHash(tmp, plan.sha256, 'sha256');
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw new Error(`${plan.kind} 安装器下载失败: ${e.message}`);
      }
      progress('install', 0);
      const launch = await this.runInstaller(rec, plan, tmp);
      rec.meta.launch = launch;
      rec.meta.installState = 'ready';
      rec.meta.build = plan.build || rec.meta.build;
      delete rec.meta.error;
      this.saveMeta(rec);
      this.emitConsole(rec, `[BlockNexus] ${source} ${version} 安装完成，可以启动了`);
      this.emitUpdated(rec);
      return;
    }

    // ---- 直连 jar：官方源 → 镜像兜底 ----
    const tmp = path.join(dir, 'server.jar.tmp');
    const mirror = customUrl ? null : mirrorHostOf();
    try {
      await downloadToFile(plan.url, tmp, onPct);
    } catch (e) {
      const mirrored = withMirror(plan.url, mirror);
      if (!mirror || mirrored === plan.url) throw e;
      progress('download', 0);
      this.emitConsole(rec, `[BlockNexus] 官方源下载失败（${e.message}），改用镜像源重试`);
      await downloadToFile(mirrored, tmp, onPct);
    }
    if (plan.sha256) {
      try {
        await verifyHash(tmp, plan.sha256, 'sha256');
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw e;
      }
    }
    fs.renameSync(tmp, path.join(dir, 'server.jar'));
    rec.meta.launch = { kind: 'jar', file: 'server.jar' };
    rec.meta.installState = 'ready';
    rec.meta.build = plan.build || rec.meta.build;
    delete rec.meta.error;
    this.saveMeta(rec);
    if (PAPERCLIP_SOURCES.has(source)) await this.ensureBootstrapVanilla(rec);
    this.emitConsole(rec, `[BlockNexus] server.jar (${version}) 下载完成，可以启动了`);
    this.emitUpdated(rec);
  }

  /**
   * 预置 paperclip 首启需要的原版核心（Paper/Purpur/Folia）：
   * server.jar 只是 paperclip 引导器，首次启动它会自己连 piston-data.mojang.com 下载
   * 原版 jar 到 cache/mojang_<版本>.jar —— 国内服务器连不上官方源就会一直启动失败。
   * 这里用「官方源 → BMCLAPI 镜像」提前把文件放好并按清单 sha1 校验，
   * paperclip 检测到文件存在且哈希匹配就会跳过下载。
   * 任何失败只告警不阻断启动（paperclip 仍会自行尝试，行为与旧版一致）。
   */
  async ensureBootstrapVanilla(rec) {
    const version = rec.meta.version;
    if (!version) return;
    const target = path.join(this.instDir(rec.meta.name), 'cache', `mojang_${version}.jar`);
    if (fs.existsSync(target)) return; // 已就位（首启补丁完成后此文件保留，后续启动直接跳过）
    this.emitConsole(rec, `[BlockNexus] ${rec.meta.source} 首次启动需要原版核心 ${version}，正在预下载（避免 paperclip 直连官方源超时）…`);
    const tmp = target + '.tmp';
    try {
      const data = await this.ensureVersions();
      const v = data.versions.find((x) => x.id === version);
      if (!v) throw new Error('版本清单里没有 ' + version);
      const mirror = mirrorHostOf();
      let vjson;
      try {
        vjson = await fetchJson(v.url, 15000);
      } catch (e) {
        if (!mirror || v.url.includes(mirror)) throw e;
        vjson = await fetchJson(withMirror(v.url, mirror), 15000);
      }
      const dl = vjson.downloads && vjson.downloads.server;
      if (!dl || !dl.url) throw new Error('版本清单缺少原版服务端下载地址');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        await downloadToFile(dl.url, tmp);
      } catch (e) {
        const mirrored = withMirror(dl.url, mirror);
        if (!mirror || mirrored === dl.url) throw e;
        this.emitConsole(rec, '[BlockNexus] 官方源不可达，改用镜像源下载原版核心');
        await downloadToFile(mirrored, tmp);
      }
      if (dl.sha1) await verifyHash(tmp, dl.sha1, 'sha1');
      fs.renameSync(tmp, target);
      this.emitConsole(rec, `[BlockNexus] 原版核心已就位（cache/mojang_${version}.jar）`);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      this.emitConsole(rec, `[BlockNexus] 原版核心预下载失败（${e.message}），交由启动流程自行处理`);
    }
  }

  /**
   * 决定安装器进程要不要强制优先 IPv6。
   * Java 解析双栈域名时逐个 A/AAAA 记录串行重试，且只按 preferIPv4Stack 排序，
   * 没有 Node 那样的 Happy Eyeballs：在国内这类网络里会先撞上不通的 IPv4 记录，
   * 每条耗掉整个连接超时（默认几十秒），最终安装器假死或报超时。
   * 只在「该域名的 A 记录全不通、AAAA 有通」时才追加 -Djava.net.preferIPv6Addresses=true，
   * 纯 IPv4 环境不加，避免反向把它搞坏。探测结果按域名缓存。
   */
  async javaNetFlagFor(host) {
    if (!host) return [];
    if (this.javaNetFlags.has(host)) return this.javaNetFlags.get(host);
    let flag = [];
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      const v4 = addrs.filter((a) => a.family === 4);
      const v6 = addrs.filter((a) => a.family === 6);
      if (v4.length && v6.length) {
        const reachable = (a, ms) =>
          new Promise((resolve) => {
            const sock = new net.Socket();
            const done = (ok) => {
              sock.destroy();
              resolve(ok);
            };
            sock.setTimeout(ms);
            sock.once('connect', () => done(true));
            sock.once('timeout', () => done(false));
            sock.once('error', () => done(false));
            sock.connect(443, a.address);
          });
        const v4ok = (await Promise.all(v4.slice(0, 2).map((a) => reachable(a, 4000)))).some(Boolean);
        if (!v4ok) {
          const v6ok = (await Promise.all(v6.slice(0, 2).map((a) => reachable(a, 4000)))).some(Boolean);
          if (v6ok) flag = ['-Djava.net.preferIPv6Addresses=true'];
        }
      }
    } catch {}
    this.javaNetFlags.set(host, flag);
    return flag;
  }

  /**
   * 运行官方安装器（无头模式），把安装过程中的输出实时落到实例控制台。
   * 返回启动描述 { kind, file?, argsFile? }，供 start() 使用。
   */
  async runInstaller(rec, plan, installerPath) {
    const dir = this.instDir(rec.meta.name);
    const java = this.javaInfo();
    if (!java.installed) throw new Error('未检测到 Java，无法运行安装器');
    // 安装器自己在 Java 里下载依赖（Fabric 拉 maven、Forge/NeoForge 拉 maven + Mojang），
    // 所以按它要访问的域名决定是否强制 IPv6
    const host = new URL(plan.url).host;
    const netFlag = await this.javaNetFlagFor(host);
    if (netFlag.length) {
      this.emitConsole(rec, `[BlockNexus] ${host} 的 IPv4 不可达，安装器改用 IPv6 优先`);
    }
    let args;
    if (plan.kind === 'fabric') {
      args = [
        ...netFlag,
        '-jar',
        installerPath,
        'server',
        '-mcversion',
        plan.game,
        '-loader',
        plan.loader,
        '-downloadMinecraft',
      ];
    } else {
      // Forge / NeoForge：--installServer 会在当前目录生成 run.sh + libraries
      args = [...netFlag, '-jar', installerPath, '--installServer', '.'];
    }
    this.emitConsole(rec, `[BlockNexus] 运行 ${plan.kind} 安装器: java ${args.join(' ')}`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(this.javaCmd() || 'java', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const feed = this.makeLineSplitter((t) => this.emitConsole(rec, t));
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('close', () => feed.flush());
      child.on('error', reject);
      child.on('exit', (c) => resolve(c));
    });
    if (code !== 0) throw new Error(`${plan.kind} 安装器退出码 ${code}，详见控制台`);

    if (plan.kind === 'fabric') {
      if (!fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))) {
        throw new Error('安装器未生成 fabric-server-launch.jar');
      }
      return { kind: 'jar', file: 'fabric-server-launch.jar' };
    }
    // Forge / NeoForge：定位 libraries/**/unix|win_args.txt
    const argsFile = this.findModdedArgsFile(dir);
    if (!argsFile) throw new Error('安装器未生成启动参数文件，请查看控制台');
    return { kind: 'argsfile', argsFile };
  }

  /** 在 libraries 下递归找 forge/neoforge 生成的启动参数文件 */
  findModdedArgsFile(dir) {
    const want = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const libs = path.join(dir, 'libraries');
    const walk = (d, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        return null;
      }
      for (const n of names) {
        const p = path.join(d, n);
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth >= 6) continue;
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        } else if (n === want) {
          return path.relative(dir, p).split(path.sep).join('/');
        }
      }
      return null;
    };
    return walk(libs, 0);
  }

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
  }

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
  }

  async start(name) {
    const rec = this.get(name);
    if (rec.proc) throw new Error('实例已在运行');
    if (rec.meta.installState === 'downloading') throw new Error('核心还在下载/安装中');
    if (rec.meta.installState === 'failed') throw new Error('上次安装失败，请点「重试安装」');
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
  }

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
  }

  async stop(name, force = false) {
    const rec = this.get(name);
    if (!rec.proc) throw new Error('实例未在运行');
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
  }

  async restart(name) {
    const rec = this.get(name);
    if (rec.proc) await this.stopAndWait(rec, 45000);
    return this.start(name);
  }

  command(name, cmd) {
    const rec = this.get(name);
    if (!rec.proc) throw new Error('实例未在运行');
    if (!cmd) throw new Error('空指令');
    rec.proc.stdin.write(cmd + '\n');
    return { ok: true };
  }

  console(name, tail = 200) {
    const rec = this.get(name);
    return { lines: rec.buf.slice(-tail), status: this.statusOf(rec) };
  }

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

  // 版本清单获取（带磁盘缓存兜底）：官方源 → 镜像源逐个尝试，全部失败时
  // 回退到最近 7 天内的磁盘缓存（返回 stale 标记），避免服务器网络抖动导致建不了实例
  versionsCacheFile() {
    return path.join(this.dir, '.blocknexus-versions-cache.json');
  }

  async ensureVersions() {
    if (this.versionsCache && Date.now() - this.versionsCache.at <= MANIFEST_TTL) {
      return this.versionsCache.data;
    }
    const errs = [];
    for (const url of [MANIFEST_URL, ...MANIFEST_MIRRORS]) {
      try {
        const data = await fetchJson(url, 12000);
        if (!data || !Array.isArray(data.versions)) throw new Error('清单格式异常');
        this.versionsCache = { at: Date.now(), data };
        try {
          fs.writeFileSync(
            this.versionsCacheFile(),
            JSON.stringify({ at: Date.now(), data }),
          );
        } catch {}
        return data;
      } catch (e) {
        errs.push(`${new URL(url).host}: ${e.message}`);
      }
    }
    try {
      const cached = JSON.parse(fs.readFileSync(this.versionsCacheFile(), 'utf8'));
      if (cached && cached.data && Date.now() - cached.at <= STALE_TTL) {
        this.versionsCache = { at: Date.now(), data: cached.data };
        return { ...cached.data, stale: true };
      }
    } catch {}
    throw new Error('版本清单获取失败（' + errs.join('；') + '），请检查服务器网络');
  }

  async getVersions() {
    const data = await this.ensureVersions();
    return {
      latest: data.latest.release,
      versions: data.versions
        .filter((v) => v.type === 'release')
        .slice(0, 80)
        .map((v) => ({ id: v.id, releaseTime: v.releaseTime })),
      stale: !!data.stale,
    };
  }

  // ---------- 服务端核心目录 ----------
  // 每个第三方核心一份磁盘缓存（1 小时新鲜 / 7 天过期兜底），结构与版本清单一致。

  coresCacheFile() {
    return path.join(this.dir, '.blocknexus-cores-cache.json');
  }

  readCoresCache() {
    try {
      const c = JSON.parse(fs.readFileSync(this.coresCacheFile(), 'utf8'));
      if (c && c.data && Date.now() - c.at <= STALE_TTL) return { at: c.at, data: c.data };
    } catch {}
    return null;
  }

  writeCoresCache(data) {
    try {
      fs.writeFileSync(this.coresCacheFile(), JSON.stringify({ at: Date.now(), data }));
    } catch {}
  }

  /** 官方源取某个核心可安装的 MC 版本列表；kind 决定数据源，api=false 的核心没有远端目录 */
  async coreVersionsForOfficial(kind) {
    if (kind === 'vanilla') {
      const data = await this.ensureVersions();
      return {
        versions: data.versions
          .filter((v) => v.type === 'release')
          .slice(0, 80)
          .map((v) => ({ id: v.id })),
        latest: data.latest.release,
        stale: !!data.stale,
      };
    }
    if (kind === 'paper' || kind === 'folia') {
      const d = await fetchJson(`${PAPER_API}/${kind}`, 15000);
      const list = Object.keys(d.versions || {}).sort((a, b) => cmpVersion(b, a));
      return { versions: list.map((id) => ({ id })), latest: list[0] || null };
    }
    if (kind === 'purpur') {
      const d = await fetchJson(PURPUR_API, 15000);
      // 该接口按发布时间升序返回，倒过来才是「新版本在前」
      const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
      return { versions: list.map((id) => ({ id })), latest: list[0] || null };
    }
    if (kind === 'fabric') {
      const g = await fetchJson(FABRIC_GAME_API, 15000);
      const stable = (Array.isArray(g) ? g : []).filter((v) => v.stable);
      return {
        versions: stable.slice(0, 40).map((v) => ({ id: v.version })),
        latest: stable[0] && stable[0].version,
      };
    }
    if (kind === 'forge') {
      const xml = await this.httpGetText(FORGE_MAVEN, 20000);
      // forge 版本号形如 1.20.1-47.2.0；取每个 MC 版本的最新构建
      const byMc = new Map();
      for (const v of mavenVersions(xml)) {
        const m = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(v);
        if (!m) continue;
        const cur = byMc.get(m[1]);
        if (!cur || cmpVersion(m[2], cur.build) > 0) byMc.set(m[1], { mc: m[1], build: m[2], full: v });
      }
      const list = [...byMc.values()].sort((a, b) => cmpVersion(b.mc, a.mc));
      return {
        versions: list.map((x) => ({ id: x.mc, build: x.full })),
        latest: list[0] && list[0].mc,
      };
    }
    if (kind === 'neoforge') {
      const xml = await this.httpGetText(NEOFORGE_MAVEN, 20000);
      const byMc = new Map();
      for (const v of mavenVersions(xml)) {
        if (!/^\d+\.\d+\.\d+/.test(v)) continue; // 跳过 0.25w14craftmine 这类快照
        const mc = Object.keys(NEOFORGE_MC_PREFIX).find((k) => v.startsWith(NEOFORGE_MC_PREFIX[k]));
        if (!mc) continue;
        const cur = byMc.get(mc);
        if (!cur || cmpVersion(v, cur) > 0) byMc.set(mc, v);
      }
      const list = [...byMc.entries()]
        .map(([mc, v]) => ({ id: mc, build: v }))
        .sort((a, b) => cmpVersion(b.id, a.id));
      return { versions: list, latest: list[0] && list[0].id };
    }
    throw new Error('未知核心类型: ' + kind);
  }

  /** MSL 镜像的版本目录兜底（官方源不可用时） */
  async mslVersionsFor(kind) {
    if (!MSL_SOURCES.has(kind)) throw new Error('MSL 不支持该核心类型: ' + kind);
    const d = await mslFetchJson('/mirrors/' + encodeURIComponent(kind), 15000);
    const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
    const versions = list.map((id) => ({ id }));
    if (!versions.length) throw new Error('MSL 版本目录为空');
    return { versions, latest: versions[0].id };
  }

  /** 取某个核心可安装的 MC 版本列表：官方源 → MSL 镜像兜底 */
  async coreVersionsFor(kind) {
    try {
      return await this.coreVersionsForOfficial(kind);
    } catch (officialErr) {
      try {
        return await this.mslVersionsFor(kind);
      } catch {
        throw officialErr; // 镜像也失败时保留官方错误（更接近根因）
      }
    }
  }

  /** 汇总所有核心的目录（各自失败不影响其他核心，失败项返回 error） */
  async coreCatalogs() {
    const out = { kinds: CORE_KINDS, catalogs: {} };
    const entries = await Promise.all(
      CORE_KINDS.filter((k) => k.api).map(async (k) => {
        try {
          const r = await this.coreVersionsFor(k.id);
          return [k.id, { ...r, ok: true }];
        } catch (e) {
          return [k.id, { ok: false, error: e.message, versions: [] }];
        }
      }),
    );
    for (const [id, r] of entries) out.catalogs[id] = r;
    // 任一核心成功就刷新缓存；全部失败时读旧缓存兜底
    const anyOk = entries.some(([, r]) => r.ok);
    if (anyOk) {
      this.writeCoresCache(out.catalogs);
      out.stale = false;
    } else {
      const cached = this.readCoresCache();
      if (cached) {
        out.catalogs = cached.data;
        out.stale = true;
      } else {
        out.stale = true;
      }
    }
    return out;
  }

  // ======================= 文件管理（作用域锁定在实例目录内） =======================

  instanceRoot(name) {
    this.get(name);
    return path.resolve(this.dir, name);
  }

  resolveSafe(root, rel) {
    const cleaned = String(rel || '').replace(/^\/+/, '').replace(/\\/g, '/');
    const resolved = path.resolve(root, cleaned);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('路径越界');
    }
    return resolved;
  }

  listFiles(name, rel) {
    const root = this.instanceRoot(name);
    const dir = this.resolveSafe(root, rel);
    if (!fs.existsSync(dir)) throw new Error('目录不存在');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        try {
          size = e.isDirectory() ? 0 : fs.statSync(full).size;
        } catch {}
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
          mtime: (() => {
            try {
              return fs.statSync(full).mtimeMs;
            } catch {
              return 0;
            }
          })(),
        };
      })
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
  }

  readFile(name, rel, maxKB = 512) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    const st = fs.statSync(file);
    if (st.isDirectory()) throw new Error('目标是目录');
    if (st.size > maxKB * 1024) throw new Error(`文件超过 ${maxKB}KB，不支持在线查看`);
    const head = Buffer.alloc(Math.min(st.size, 8192));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (head.includes(0)) throw new Error('二进制文件不支持在线查看');
    return { content: fs.readFileSync(file, 'utf8'), size: st.size, mtime: st.mtimeMs };
  }

  writeFile(name, rel, content) {
    if (Buffer.byteLength(String(content), 'utf8') > 2 * 1024 * 1024) {
      throw new Error('内容超过 2MB，请用上传功能');
    }
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    fs.writeFileSync(file, String(content), 'utf8');
    return { ok: true, size: Buffer.byteLength(String(content), 'utf8') };
  }

  mkdir(name, rel) {
    const root = this.instanceRoot(name);
    const dir = this.resolveSafe(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  }

  deletePath(name, rel) {
    const root = this.instanceRoot(name);
    if (!rel || String(rel).replace(/^\/+|\/+$/g, '') === '') {
      throw new Error('不能删除实例根目录');
    }
    const target = this.resolveSafe(root, rel);
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  }

  // ---------- 复制 / 移动 / 压缩 / 解压 ----------
  // 全部经 resolveSafe 锁定在实例目录内；目标已存在一律报错（前端负责自动改名去重），
  // 避免“粘贴覆盖”静默毁掉服务器文件。

  /** child 是否等于 parent 或位于 parent 内部 */
  isWithinPath(parent, child) {
    return child === parent || child.startsWith(parent + path.sep);
  }

  /** 递归复制（不依赖 fs.cpSync，兼容旧 Node；软链接按普通文件复制内容） */
  copyRecursive(src, dst) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src)) this.copyRecursive(path.join(src, e), path.join(dst, e));
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  copyMovePath(name, from, to, move) {
    const root = this.instanceRoot(name);
    if (!from || !to) throw new Error('缺少源/目标路径');
    const src = this.resolveSafe(root, from);
    const dst = this.resolveSafe(root, to);
    if (src === root) throw new Error('不能对实例根目录操作');
    if (!fs.existsSync(src)) throw new Error('源不存在');
    if (dst === src) throw new Error(move ? '源与目标相同' : '目标与源相同');
    // 移动/复制进自己的子树会造成递归环（mv /world /world/backup），必须拒绝
    if (this.isWithinPath(src, dst)) throw new Error('目标不能在源目录内部');
    if (fs.existsSync(dst)) throw new Error('目标已存在：' + path.basename(dst));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!move) {
      this.copyRecursive(src, dst);
    } else {
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        // 跨盘/跨文件系统 rename 会报 EXDEV：退回复制+删除
        if (e.code !== 'EXDEV') throw e;
        this.copyRecursive(src, dst);
        fs.rmSync(src, { recursive: true, force: true });
      }
    }
    return { ok: true };
  }

  /** 压缩为 .tar.gz（系统 tar，Windows 自带 bsdtar、Linux 常见 GNU tar 均支持） */
  async compressPaths(name, paths, out) {
    const root = this.instanceRoot(name);
    if (!Array.isArray(paths) || !paths.length) throw new Error('未选择要压缩的文件');
    if (!/\.(tar\.gz|tgz)$/i.test(String(out || ''))) throw new Error('压缩包只支持 .tar.gz 格式');
    const outFile = this.resolveSafe(root, out);
    if (fs.existsSync(outFile)) throw new Error('同名压缩包已存在：' + path.basename(outFile));
    const entries = paths.map((p) => {
      const abs = this.resolveSafe(root, p);
      if (abs === root) throw new Error('不能压缩实例根目录');
      if (this.isWithinPath(abs, outFile)) throw new Error('压缩包不能放在被压缩的目录内部');
      return path.relative(root, abs).split(path.sep).join('/');
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await runCmd(tarCmd(), ['-czf', outFile, '-C', root, ...entries]);
    return { ok: true };
  }

  /** 解压 .zip / .tar.gz / .tgz / .tar 到压缩包所在目录（同名覆盖） */
  async extractArchive(name, rel) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new Error('文件不存在');
    }
    if (!st.isFile()) throw new Error('不是文件');
    const destDir = path.dirname(file);
    if (/\.zip$/i.test(file)) {
      if (process.platform === 'win32') {
        // Windows 自带 bsdtar，可直接解 zip
        await runCmd(tarCmd(), ['-xf', file, '-C', destDir]);
      } else {
        // Linux：优先 unzip，缺失再试 bsdtar
        try {
          await runCmd('unzip', ['-o', file, '-d', destDir]);
        } catch (e) {
          if (!/ENOENT|缺少命令/.test(e.message)) throw e;
          await runCmd('bsdtar', ['-xf', file, '-C', destDir]);
        }
      }
    } else if (/\.(tar\.gz|tgz|tar)$/i.test(file)) {
      await runCmd(tarCmd(), ['-xf', file, '-C', destDir]);
    } else {
      throw new Error('仅支持 .zip / .tar.gz / .tgz / .tar');
    }
    return { ok: true };
  }

  // 分块上传：begin → chunk* → finish（写入 <final>.blocknexus-upload，完成后改名）
  // 支持断点续传：begin 带 resume 时优先接续已存在的 .blocknexus-upload 半成品；
  // 用 <final>.blocknexus-upload.meta 记录 {size,lastModified} 指纹，避免同名不同文件误续传。
  // 会话是纯内存的（Agent 重启后丢），但 tmp 文件在磁盘上，resume 按 size 接力。
  uploadBegin(name, dir, filename, size, lastModified, resume) {
    const root = this.instanceRoot(name);
    const dirAbs = this.resolveSafe(root, dir);
    const finalPath = this.resolveSafe(root, path.posix.join(String(dir || '').replace(/^\/+/, ''), filename));
    if (!finalPath.startsWith(root + path.sep)) throw new Error('路径越界');
    if (typeof size === 'number' && size > 200 * 1024 * 1024) throw new Error('单文件上限 200MB');
    const tmpPath = finalPath + '.blocknexus-upload';
    const metaPath = tmpPath + '.meta';
    const chunk = 512 * 1024;

    // 同一路径已有进行中的会话（如上一块 ACK 丢失后浏览器重试）：指纹一致才续用，
    // 并把 seq 清零——续传约定是「begin 之后 seq 从 1 重新计，以 received 为字节准绳」。
    // 指纹不符（同名换文件）必须作废旧会话，否则两份内容会拼在一起。
    for (const [id, up] of this.uploads) {
      if (up.tmpPath !== tmpPath) continue;
      if (resume) {
        const sameFingerprint =
          (typeof size !== 'number' || up.size === size) &&
          (lastModified === undefined || up.lastModified === undefined || up.lastModified === lastModified);
        if (sameFingerprint) {
          up.seq = 0;
          up.at = Date.now();
          return { uploadId: id, chunk, received: up.received, resumed: true };
        }
      }
      this.uploads.delete(id); // 全新上传或换了文件：作废旧会话，tmp 交给下面的续传判定
    }

    let received = 0;
    let resumed = false;
    const metaOk = (() => {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return (
          m.final === path.basename(finalPath) &&
          (m.size === size || typeof size !== 'number') &&
          (lastModified === undefined || m.lastModified === lastModified)
        );
      } catch {
        return false;
      }
    })();
    if (resume && metaOk && fs.existsSync(tmpPath)) {
      const st = fs.statSync(tmpPath);
      // 半成品比目标还大（多半是别的文件残留）→ 不敢续，重来
      if (typeof size === 'number' && st.size > size) {
        fs.rmSync(tmpPath, { force: true });
        fs.rmSync(metaPath, { force: true });
      } else {
        received = st.size;
        resumed = received > 0;
      }
    }
    if (!resumed) {
      fs.writeFileSync(tmpPath, Buffer.alloc(0));
      try {
        fs.writeFileSync(
          metaPath,
          JSON.stringify({ final: path.basename(finalPath), size, lastModified, at: Date.now() }),
        );
      } catch {}
    } else {
      // 刷新时间戳，避免续传中途被 GC 清掉
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        m.at = Date.now();
        fs.writeFileSync(metaPath, JSON.stringify(m));
      } catch {}
    }
    const uploadId = crypto.randomBytes(8).toString('hex');
    this.uploads.set(uploadId, {
      finalPath,
      tmpPath,
      metaPath,
      received,
      seq: 0,
      at: Date.now(),
      size: typeof size === 'number' ? size : undefined,
      lastModified,
    });
    return { uploadId, chunk, received, resumed };
  }

  uploadChunk(uploadId, seq, dataB64, seekTo) {
    const up = this.uploads.get(uploadId);
    if (!up) throw new Error('上传会话不存在或已过期（可重新 begin 续传）');
    // seekTo：续传对齐用。断电/重启可能留下半块，浏览器按 chunk 对齐后截断再续
    if (seekTo !== undefined && seekTo !== null) {
      const pos = Number(seekTo);
      if (!Number.isInteger(pos) || pos < 0 || pos > up.received) throw new Error('续传偏移非法');
      fs.truncateSync(up.tmpPath, pos);
      up.received = pos;
    }
    if (Number(seq) !== up.seq + 1) {
      const e = new Error(`分块乱序 (期望 ${up.seq + 1})`);
      e.received = up.received; // 浏览器据此重新 begin 对齐
      throw e;
    }
    const buf = Buffer.from(String(dataB64 || ''), 'base64');
    fs.appendFileSync(up.tmpPath, buf);
    up.received += buf.length;
    up.seq = Number(seq);
    up.at = Date.now();
    return { received: up.received };
  }

  uploadFinish(uploadId) {
    const up = this.uploads.get(uploadId);
    if (!up) throw new Error('上传会话不存在或已过期');
    fs.renameSync(up.tmpPath, up.finalPath);
    try {
      fs.rmSync(up.metaPath, { force: true });
    } catch {}
    this.uploads.delete(uploadId);
    return { ok: true, size: up.received };
  }

  uploadAbort(uploadId) {
    const up = this.uploads.get(uploadId);
    if (up) {
      try {
        fs.rmSync(up.tmpPath, { force: true });
      } catch {}
      try {
        fs.rmSync(up.metaPath, { force: true });
      } catch {}
      this.uploads.delete(uploadId);
    }
    return { ok: true };
  }

  // 分块下载：begin → chunk*（拉取式）→ finish
  _downloadBeginAbs(absPath) {
    const st = fs.statSync(absPath);
    if (st.isDirectory()) throw new Error('不能下载目录（请先压缩）');
    const fd = fs.openSync(absPath, 'r');
    const downloadId = crypto.randomBytes(8).toString('hex');
    this.downloads.set(downloadId, { fd, pos: 0, size: st.size, at: Date.now() });
    return { downloadId, size: st.size, chunk: 512 * 1024 };
  }

  downloadBegin(name, rel) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    return this._downloadBeginAbs(file);
  }

  downloadChunk(downloadId) {
    const dl = this.downloads.get(downloadId);
    if (!dl) throw new Error('下载会话不存在或已过期');
    const len = Math.min(512 * 1024, dl.size - dl.pos);
    const buf = Buffer.alloc(len);
    fs.readSync(dl.fd, buf, 0, len, dl.pos);
    dl.pos += len;
    dl.at = Date.now();
    return { dataB64: buf.toString('base64'), eof: dl.pos >= dl.size };
  }

  downloadFinish(downloadId) {
    const dl = this.downloads.get(downloadId);
    if (dl) {
      try {
        fs.closeSync(dl.fd);
      } catch {}
      this.downloads.delete(downloadId);
    }
    return { ok: true };
  }

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
  }

  // 面板往实例控制台写一行叙述（面板代下核心等跨端流程用它同步进度）
  logLine(name, text) {
    const rec = this.get(name);
    this.emitConsole(rec, String(text || '').slice(0, 500));
    return { ok: true };
  }

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

  // ---------- 备份（系统 tar 打包到 <instances>/.backups/<name>/） ----------
  backupsDir(name) {
    return path.join(this.dir, '.backups', name);
  }

  backupFilePath(name, file) {
    if (!/^[\w.-]+\.tar\.gz$/i.test(String(file || ''))) throw new Error('非法备份文件名');
    const root = path.resolve(this.backupsDir(name));
    const p = path.join(root, file);
    if (!p.startsWith(root + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(p)) throw new Error('备份不存在');
    return p;
  }

  tarRun(args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.on('error', (e) => reject(new Error('系统缺少 tar 命令: ' + e.message)));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('tar 执行失败: ' + err.slice(-400))),
      );
    });
  }

  async backupCreate(name) {
    this.get(name);
    const dir = this.backupsDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = `${name}-${stamp}.tar.gz`;
    const instDir = this.instanceRoot(name);
    const backupAbs = path.join(dir, file);
    // 相对路径（相对实例目录），避免 GNU tar 把 Windows 盘符 "D:" 误判为远程主机
    const rel = path.relative(instDir, backupAbs).split(path.sep).join('/');
    await this.tarRun(['-czf', rel, '.'], instDir);
    return { file, size: fs.statSync(backupAbs).size };
  }

  backupList(name) {
    const dir = this.backupsDir(name);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.tar\.gz$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  async backupRestore(name, file) {
    const rec = this.get(name);
    const bp = this.backupFilePath(name, file);
    if (rec.proc) await this.stopAndWait(rec, 30000, true);
    const instDir = this.instanceRoot(name);
    for (const child of fs.readdirSync(instDir)) {
      fs.rmSync(path.join(instDir, child), { recursive: true, force: true });
    }
    const rel = path.relative(instDir, bp).split(path.sep).join('/');
    await this.tarRun(['-xzf', rel], instDir);
    this.scan();
    this.emitConsole(rec, '[BlockNexus] 备份已恢复: ' + file);
    return { ok: true };
  }

  backupDelete(name, file) {
    fs.rmSync(this.backupFilePath(name, file), { force: true });
    return { ok: true };
  }

  gcTransferSessions() {
    const now = Date.now();
    // 上传会话放慢到 2h：会话虽在内存里，tmp 半成品支持断点续传，过期即删（resume 就没了）
    for (const [id, up] of this.uploads) {
      if (now - up.at > 2 * 3600e3) {
        try {
          fs.rmSync(up.tmpPath, { force: true });
        } catch {}
        try {
          fs.rmSync(up.metaPath, { force: true });
        } catch {}
        this.uploads.delete(id);
      }
    }
    for (const [id, dl] of this.downloads) {
      if (now - dl.at > 30 * 60e3) {
        try {
          fs.closeSync(dl.fd);
        } catch {}
        this.downloads.delete(id);
      }
    }
  }

  // ---------- server.properties 读写（面板做可视化配置用） ----------
  propertiesPath(name) {
    return path.join(this.instanceRoot(name), 'server.properties');
  }

  getProperties(name) {
    this.get(name);
    const file = this.propertiesPath(name);
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = '#Minecraft server properties\n';
    }
    return { content };
  }

  // 写回配置：只改值、保留注释与顺序；写完同步面板侧元信息
  saveProperties(name, content) {
    const rec = this.get(name);
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new Error('配置内容过大');
    const lines = text.split(/\r?\n/);
    const bad = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (!/^[A-Za-z0-9_.\-]+\s*=/.test(t)) bad.push(t.slice(0, 60));
    }
    if (bad.length) throw new Error('存在非法配置行（应为 key=value）：' + bad.slice(0, 3).join(' / '));

    fs.writeFileSync(this.propertiesPath(name), text, 'utf8');

    // 同步面板展示与服务端查询会用到的字段
    const props = {};
    for (const line of lines) {
      const m = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
      if (m) props[m[1]] = m[2];
    }
    let changed = false;
    const port = Number(props['server-port']);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== rec.meta.port) {
      rec.meta.port = port;
      changed = true;
    }
    if (props.motd !== undefined && props.motd !== rec.meta.motd) {
      rec.meta.motd = props.motd;
      changed = true;
    }
    if (props['online-mode'] !== undefined) {
      const on = props['online-mode'] === 'true';
      if (on !== rec.meta.onlineMode) {
        rec.meta.onlineMode = on;
        changed = true;
      }
    }
    if (changed) this.saveMeta(rec);
    this.emitConsole(rec, '[BlockNexus] server.properties 已更新' + (rec.proc ? '（需重启实例后生效）' : ''));
    this.emitUpdated(rec);
    return { ok: true, metaSynced: changed };
  }

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
  }

  // ---------- Java 安装（异步任务：立即返回，进度与结果走事件） ----------
  emitJava(msg, pct) {
    sendEvent('install.progress', { phase: 'java', msg: String(msg).slice(0, 240), pct });
  }

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
  }

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
  }

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
  }

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
  }

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
}

// ============================ Agent 主类 ============================

let sendEvent = () => {};

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
    sendEvent = (event, data) => this.emitEvent(event, data);
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

// ============================ 启动 ============================

const conf = loadConfig();
const manager = new InstanceManager(conf.instances);
const agent = new Agent(conf, manager);
agent.start();

console.log(`${VERSION}`);
console.log(`实例目录: ${manager.dir}`);
console.log(
  conf.mode === 'listen'
    ? `运行模式: 监听端口 ${conf.listen}${conf.tls ? '（TLS）' : ''}（等待面板连入 ${conf.tls ? 'wss' : 'ws'}://<本机IP>:${conf.listen}/agent/ws）`
    : `运行模式: 主动连接面板 ${conf.panel}`,
);

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));

// 优雅退出：面板停止本机 Agent / 系统关机时，先把运行中的 MC 实例停掉，避免 java 变孤儿进程。
// Windows 的 taskkill（不带 /F）会给控制台进程发 CTRL_CLOSE_EVENT，
// Ctrl 事件与 POSIX 信号都统一走这里；超时后由 Node 默认行为强制退出。
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.log(`\n[BlockNexus] 收到退出信号（${reason}），正在停止实例…`);
    const stopped = [];
    for (const rec of manager.map.values()) {
      if (rec.proc) {
        await manager.stopAndWait(rec, 20000, false);
        stopped.push(rec.meta.name);
      }
    }
    console.log(stopped.length ? `[BlockNexus] 已停止实例：${stopped.join('、')}` : '[BlockNexus] 无运行中的实例');
  } catch (e) {
    console.error('[BlockNexus] 优雅退出时出错: ' + (e && e.message ? e.message : e));
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    gracefulShutdown(sig).catch(() => process.exit(0));
  });
}
if (process.platform === 'win32') {
  // Windows 控制台 Ctrl 事件（面板 taskkill / 关闭控制台窗口都走这条）
  try {
    // 零依赖：用 Node 内置 libuv 忽略 stdio，仅绑定信号处理即可，无需额外模块
    process.on('SIGBREAK', () => {
      gracefulShutdown('CTRL_BREAK').catch(() => process.exit(0));
    });
  } catch {}
}
