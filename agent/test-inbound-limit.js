'use strict';
// 面板入站 /agent/ws 的并发握手上限测试。
//
// 背景：/agent/ws 的凭据在**握手 proof 里**，所以升级阶段必须放行未认证连接；
// 而握手最长 15 秒。面板对外暴露时，攻击者可持续开连接、每条挂满 15 秒来堆积 fd/内存。
//
// 运行：node agent/test-inbound-limit.js

const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { AgentHub } = require(path.join(__dirname, '..', 'panel', 'agentlink.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const CAP = 32; // 与 panel/agentlink.js 的 MAX_INFLIGHT_HANDSHAKES 一致

const config = {
  data: { panel: { port: 0 }, servers: [], settings: {} },
  getServer: () => null,
  listServers: () => [],
  save() {},
};
const hub = new AgentHub(config, { on() {}, emit() {} });

const srv = http.createServer();
srv.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

/** 开一条只连不发（握手永远不完成）的连接，返回它收到的 HTTP 状态（若被拒） */
function connectIdle(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/ws`);
    let settled = false;
    ws.on('open', () => {
      if (!settled) {
        settled = true;
        resolve({ ws, status: 101 });
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      if (!settled) {
        settled = true;
        resolve({ ws: null, status: res.statusCode });
      }
    });
    ws.on('error', () => {
      if (!settled) {
        settled = true;
        resolve({ ws: null, status: 0 });
      }
    });
  });
}

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  // 1) 占满名额：这些连接只建立、不发 hello，握手会一直挂着
  const held = [];
  for (let i = 0; i < CAP; i++) held.push(await connectIdle(port));
  check(
    `可以建立 ${CAP} 条握手中的连接（上限之内）`,
    held.every((h) => h.status === 101),
    held.map((h) => h.status).join(','),
  );
  check('计数与上限一致', hub.inflight === CAP, `inflight=${hub.inflight}`);

  // 2) 超出的连接必须被明确拒绝（503，而不是静默断开）
  const over = await connectIdle(port);
  check('超出上限的连接被拒（HTTP 503）', over.status === 503, `status=${over.status}`);

  // 3) 释放后应能重新接入——证明名额会归还，不会被一次失败永久吃掉
  for (const h of held) {
    try {
      h.ws.terminate();
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 400));
  check('断开后名额被归还', hub.inflight === 0, `inflight=${hub.inflight}`);

  const again = await connectIdle(port);
  check('名额归还后可再次建立连接', again.status === 101, `status=${again.status}`);
  try {
    again.ws && again.ws.terminate();
  } catch {}

  srv.close();
  console.log(`\n${pass}/${total} inbound-limit cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
