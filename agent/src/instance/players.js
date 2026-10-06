'use strict';
// BlockNexus Agent — 玩家跟踪与 SLP 查询
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const net = require('net');

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

module.exports = {
  // server.properties 里的 max-players（拿不到时默认 20）
  readMaxPlayers(rec) {
    try {
      const txt = fs.readFileSync(path.join(this.dir, rec.meta.name, 'server.properties'), 'utf8');
      const m = /^max-players=(\d+)/m.exec(txt);
      return m ? Number(m[1]) : 20;
    } catch {
      return 20;
    }
  },

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
  },

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
  },

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
  },

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
};
