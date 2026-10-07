'use strict';
// Agent 监听模式（WSServer）的升级前超时防护测试。
//
// 背景：Agent 通常以 root 运行、端口对外。客户端连上后**什么都不发**时，
// onData 永远不触发，socket 被无限期挂住 → 未认证即可反复建连耗尽 fd/内存。
// （同处已有的 16KB 上限只管「发了一半的头」，完全不管「一个字都不发」。）
//
// ⚠ 本测试需要真等超时（常量 10s），所以约 22 秒。它守的是一条真防线，
//   且**两侧都要测**——只测「空闲会被断开」不够，误杀合法连接是更严重的回归。
//
// 运行：node agent/test-ws-server-guard.js

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { WSServer } = require(path.join(__dirname, 'src', 'ws.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const WAIT = 12000; // 比 10s 常量多留 2s 余量

function startServer() {
  return new Promise((resolve) => {
    const srv = new WSServer({ port: 0, host: '127.0.0.1' });
    srv.on('listening', () => resolve({ srv, port: srv.server.address().port }));
    srv.listen();
  });
}

(async () => {
  // ---------- 1) 连上但不发任何数据 → 必须被断开 ----------
  {
    const { srv, port } = await startServer();
    const closed = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {});
      const t0 = Date.now();
      s.on('close', () => resolve(Date.now() - t0));
      s.on('error', () => {});
      setTimeout(() => resolve(null), WAIT);
    });
    check(
      '空闲连接被升级前超时断开（不再无限挂住）',
      closed !== null && closed < WAIT,
      closed === null ? `${WAIT}ms 内仍未被断开` : `${closed}ms 才断开`,
    );
    srv.close();
  }

  // ---------- 2) 完成升级的合法连接 → 不得被同一超时误杀 ----------
  {
    const { srv, port } = await startServer();
    const r = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        const key = crypto.randomBytes(16).toString('base64');
        s.write(
          'GET /agent/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n' +
            'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let upgraded = false;
      let closedEarly = false;
      s.on('data', (d) => {
        if (String(d).includes('101')) upgraded = true;
      });
      s.on('close', () => {
        if (!upgraded) closedEarly = true;
      });
      s.on('error', () => {});
      // 等过超时点后判定
      setTimeout(() => {
        const ok = upgraded && !closedEarly;
        s.destroy();
        resolve(ok);
      }, WAIT);
    });
    check('升级成功的连接未被误杀（超时已清除）', r, '合法连接在超时点后被断开');
    srv.close();
  }

  console.log(`\n${pass}/${total} ws-server-guard cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
