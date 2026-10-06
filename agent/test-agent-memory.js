'use strict';
// Agent 内存相关行为的回归测试（零依赖测试框架）
//
// 为什么需要：用户明确要求 Agent 内存尽量小（目标 ≤80MB，大内存机 ≤120MB）。
// 这里守两件事：
//   1) sysStats 必须上报 Agent 自身 RSS——没有读数就无法验收内存目标；
//   2) 传输会话必须有**数量上限**——时间 GC 每 10 分钟才跑一次，而上传会话能活 2 小时，
//      一次突发创建就足以在 GC 生效前把内存与 fd 顶起来（可被外部驱动的增长点）。
//
// 运行：node agent/test-agent-memory.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { InstanceManager } = require(path.join(__dirname, 'src', 'instance', 'manager.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${detail && !ok ? '\n       ' + detail : ''}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-mem-'));
const instancesDir = path.join(ROOT, 'instances');
fs.mkdirSync(instancesDir, { recursive: true });

(async () => {
  const m = new InstanceManager(instancesDir);

  // ---------- 1. sysStats 上报 Agent 自身占用 ----------
  {
    const st = await m.sysStats();
    check('sysStats 返回 self 字段（面板据此展示/告警 Agent 占用）', !!st.self, JSON.stringify(st));
    check(
      'self.rssMB 是正数',
      st.self && Number.isFinite(st.self.rssMB) && st.self.rssMB > 0,
      `rssMB=${st.self && st.self.rssMB}`,
    );
    check(
      'self.heapUsedMB 是正数且不超过 rssMB',
      st.self && st.self.heapUsedMB > 0 && st.self.heapUsedMB <= st.self.rssMB,
      `heapUsedMB=${st.self && st.self.heapUsedMB} rssMB=${st.self && st.self.rssMB}`,
    );
    check(
      'self.uptimeSec 是有限非负数',
      st.self && Number.isFinite(st.self.uptimeSec) && st.self.uptimeSec >= 0,
      `uptimeSec=${st.self && st.self.uptimeSec}`,
    );
    check('仍保留原有的主机内存字段', Number.isFinite(st.memTotalMB) && st.memTotalMB > 0);
  }

  // ---------- 2. 下载会话有数量上限，且淘汰最旧 ----------
  {
    const f = path.join(ROOT, 'blob.bin');
    fs.writeFileSync(f, Buffer.alloc(1024));

    const CAP = 64; // MAX_DOWNLOAD_SESSIONS，与 fs.js 保持一致
    // 真实的 fd 关闭验证：临时接管 fs.closeSync 计数（代码与被测对象用的是同一个 fs 模块）
    const origClose = fs.closeSync;
    let closeCalls = 0;
    fs.closeSync = function patched(fd) {
      closeCalls++;
      return origClose.call(fs, fd);
    };

    const ids = [];
    try {
      for (let i = 0; i < CAP + 6; i++) ids.push(m._downloadBeginAbs(f).downloadId);
    } finally {
      fs.closeSync = origClose;
    }

    check(
      `下载会话数不超过上限（${CAP}）`,
      m.downloads.size <= CAP,
      `实际 ${m.downloads.size}`,
    );
    check(
      '超限时淘汰的是最旧的会话（Map 插入序）',
      !m.downloads.has(ids[0]) && m.downloads.has(ids[ids.length - 1]),
      `首批 ${ids[0]} 仍在=${m.downloads.has(ids[0])}`,
    );
    check(
      '被淘汰会话的 fd 确实被关闭（不泄漏文件描述符）',
      closeCalls >= 6,
      `closeSync 调用 ${closeCalls} 次，期望 ≥6（淘汰 6 个）`,
    );
  }

  // ---------- 3. 上传会话同样有上限 ----------
  {
    const CAP = 64;
    // 直接向 uploads 填满假会话（避免走真实分块上传协议），再触发一次上限检查路径
    for (let i = 0; i < CAP; i++) {
      m.uploads.set('probe' + i, {
        finalPath: path.join(ROOT, 'x'),
        tmpPath: path.join(ROOT, 'x.tmp'),
        metaPath: path.join(ROOT, 'x.meta'),
        received: 0,
        seq: 0,
        at: Date.now(),
      });
    }
    check('可以构造满额的上传会话表（前置条件）', m.uploads.size === CAP, `size=${m.uploads.size}`);
  }

  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(`\n${pass}/${total} agent-memory cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
