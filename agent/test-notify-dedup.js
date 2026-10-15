'use strict';
// 离线 / 恢复邮件通知的降噪回归测试
//
// 要钉住的行为（每一条都对应一个真实的刷屏场景）：
//   · 掉线先观察 OFFLINE_GRACE，期间**不发信**——短暂抖动不该惊动用户；
//   · 观察期内自行恢复 → 整轮静默（离线信、恢复信都不发）；
//   · 观察期到了仍离线 → 发一封，且同一次故障只发这一封；
//   · 长期离线每 24 小时补发一封（24 小时**以内**不重复打扰）；
//   · 恢复邮件只在「本次故障确实发过离线信」后才发，否则用户会收到一封
//     莫名其妙的「已恢复」（他从没被告知这台服务器掉过线）；
//   · 发信失败要退回「未通知」，让下一轮补发补上这一封，而不是永久丢掉。
//
// 为什么不真等 2 分钟：这里要测的是**判定逻辑**，不是定时器精度。
// 做法是让 maybeNotifyStatus 排好观察期定时器，测试拿到后立刻 clearTimeout，
// 再直接调用 sendOfflineMail ——等价于「观察期已过、仍离线」。
//
// 为什么必须 mock nodemailer：sendMail 会真的做 SMTP 连接（超时 15s），
// 联网会让测试变慢且不稳定。
//
// 运行：node agent/test-notify-dedup.js

const path = require('path');
const express = require('express');

// ---- 拦截发信（在 require api.js 之前替换，让 sendMail 走内存记录）----
const nodemailer = require('nodemailer');
const sent = []; // { to, subject, text, html }
let failSend = false;
nodemailer.createTransport = () => ({
  sendMail: async (msg) => {
    if (failSend) throw new Error('SMTP 连接失败（测试注入）');
    sent.push(msg);
    return { messageId: 'test' };
  },
  close() {},
});

const { createApi, __setTestHook } = require(path.join(__dirname, '..', 'panel', 'api.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const fakeHub = {
  on() {},
  request: async () => ({}),
  status: () => 'offline',
  isOnline: () => false,
  getLatency: () => null,
  getOnlineSince: () => null,
  conns: new Map(),
  stopOutbound() {},
  syncOutbound() {},
};
const fakeBus = { on() {}, emit() {} };

function makeConfig({
  notify = { offline: true, recovery: true },
  adminEmail = 'admin@example.com',
  smtpReady = true,
} = {}) {
  const data = {
    panel: { port: 0, username: 'admin', passwordHash: { salt: '', hash: '' }, authEnabled: false },
    servers: [
      {
        id: 'srv1',
        name: '我的服务器',
        host: '10.0.0.9',
        token: 'T',
        ssh: { port: 22, user: 'root', auth: 'password' },
        agent: { mode: 'outbound', host: '', port: 3099 },
        status: 'offline',
      },
    ],
    settings: {
      domain: '',
      adminEmail,
      smtp: smtpReady
        ? { host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: '' }
        : { host: '', port: 465, secure: true, user: '', pass: '', from: '' },
      notify,
      ai: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    },
  };
  return {
    data,
    save() {},
    verifyCredentials: () => false,
    listServers: () => data.servers,
    getServer: (id) => data.servers.find((s) => s.id === id) || null,
    removeServer: (id) => {
      const before = data.servers.length;
      data.servers = data.servers.filter((s) => s.id !== id);
      return data.servers.length < before;
    },
    updateServer: () => null,
  };
}

/** 造一个不监听端口的 router 实例（本测试只调内部函数，不发 HTTP） */
function makePanel(configOpts = {}) {
  const config = makeConfig(configOpts);
  let internal = null;
  __setTestHook((i) => {
    internal = i;
  });
  const router = express.Router();
  router.use(createApi(config, fakeHub, fakeBus, {}, {}));
  return { notify: internal.notify, config };
}

/** 去掉观察期定时器，等价于「2 分钟已过、仍然离线」 */
function expireGrace(notify, serverId) {
  const rec = notify.offlineNotified.get(serverId);
  if (rec && rec.timer) clearTimeout(rec.timer);
  return rec;
}

/** 完整走一轮「掉线 → 观察期结束」；返回跟踪记录 */
async function goOffline(notify, serverId) {
  notify.maybeNotifyStatus(serverId, 'offline');
  const rec = expireGrace(notify, serverId);
  if (rec) await notify.sendOfflineMail(serverId, rec);
  return rec;
}

/** 模拟补发定时器到点（viaReminder=true 才是补发路径，会过 24 小时这一关） */
async function fireReminder(notify, serverId) {
  const rec = notify.offlineNotified.get(serverId);
  if (!rec) return null;
  if (rec.timer) clearTimeout(rec.timer);
  await notify.sendOfflineMail(serverId, rec, true);
  return rec;
}

const nOffline = () => sent.filter((m) => m.subject.includes('服务器离线')).length;
const nRecovery = () => sent.filter((m) => m.subject.includes('服务器已恢复')).length;

(async () => {
  const panels = [];

  // ================= 1. 抖动：掉线后很快自己连上 =================
  {
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');

    check('掉线瞬间不发信（进入观察期）', sent.length === 0, `实际发了 ${sent.length} 封`);
    check('掉线后开始跟踪本次故障', n.offlineNotified.has('srv1'));
    check('尚未标记为已通知', n.offlineNotified.get('srv1').notified === false);

    // 观察期内恢复：整轮静默
    n.maybeNotifyStatus('srv1', 'online');
    check('观察期内恢复 → 不发离线信也不发恢复信', sent.length === 0, `实际发了 ${sent.length} 封`);
    check('观察期内恢复 → 清除跟踪（下次掉线重新计时）', !n.offlineNotified.has('srv1'));

    // 连续抖动 5 次，一封都不该发
    for (let i = 0; i < 5; i++) {
      n.maybeNotifyStatus('srv1', 'offline');
      expireGrace(n, 'srv1');
      n.maybeNotifyStatus('srv1', 'online');
    }
    check('连续 5 次抖动 → 仍然一封不发', sent.length === 0, `实际发了 ${sent.length} 封`);
  }

  // ================= 2. 真故障：观察期过了仍离线 =================
  {
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    const rec = await goOffline(n, 'srv1');

    check('观察期过了仍离线 → 发一封离线信', nOffline() === 1, `实际 ${nOffline()} 封`);
    check('离线信收件人是管理员邮箱', sent[0] && sent[0].to === 'admin@example.com', sent[0] && sent[0].to);
    check('离线信标题含服务器名', sent[0] && sent[0].subject.includes('我的服务器'), sent[0] && sent[0].subject);
    check('标记为本次故障已通知', rec.notified === true);

    // 正文中同时给出「断开时间」与「判定离线时间」——用户能一眼看出不是瞬时抖动
    check('离线信正文含断开时间', /断开时间/.test(sent[0].text || ''), (sent[0].text || '').slice(0, 200));
    check('离线信正文含判定离线时间', /判定离线/.test(sent[0].text || ''), (sent[0].text || '').slice(0, 200));
    check(
      '离线信 HTML 版与文本版一致给出两个时间',
      /断开时间/.test(sent[0].html || '') && /判定离线/.test(sent[0].html || ''),
    );

    // 同一故障重复触发（例如又来一个 offline 事件）不再发
    n.maybeNotifyStatus('srv1', 'offline');
    await n.sendOfflineMail('srv1', n.offlineNotified.get('srv1'));
    check('同一次故障重复触发 → 不重复发信', nOffline() === 1, `实际 ${nOffline()} 封`);
  }

  // ================= 3. 长期离线的补发节奏 =================
  {
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    const rec = await goOffline(n, 'srv1');
    check('首次故障发送 1 封', nOffline() === 1, `实际 ${nOffline()} 封`);

    // 距上次发信 23 小时：不打扰
    rec.at = Date.now() - 23 * 60 * 60e3;
    await fireReminder(n, 'srv1');
    check('距上次发信 23 小时 → 不补发', nOffline() === 1, `实际 ${nOffline()} 封`);

    // 超过 24 小时：补发一封
    rec.at = Date.now() - 25 * 60 * 60e3;
    await fireReminder(n, 'srv1');
    check('距上次发信 25 小时 → 补发一封', nOffline() === 2, `实际 ${nOffline()} 封`);

    // 补发过之后立刻再来一次（模拟定时器被重复触发）不该再发
    await fireReminder(n, 'srv1');
    check('刚补发过 → 立即再触发不重复发', nOffline() === 2, `实际 ${nOffline()} 封`);
  }

  // ================= 4. 恢复邮件 =================
  {
    // 4a. 本次故障发过离线信 → 恢复时通知
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    await goOffline(n, 'srv1');
    check('前置：已发 1 封离线信', nOffline() === 1);

    n.maybeNotifyStatus('srv1', 'online');
    check('发过离线信后恢复 → 发恢复信', nRecovery() === 1, `实际 ${nRecovery()} 封`);
    check('恢复 → 不再有新的离线信', nOffline() === 1, `实际 ${nOffline()} 封`);

    // 恢复后再次掉线再恢复：应当重新走一轮（离线 2 + 恢复 2）
    await goOffline(n, 'srv1');
    n.maybeNotifyStatus('srv1', 'online');
    check('再次故障并恢复 → 各发第 2 封', nOffline() === 2 && nRecovery() === 2, `离线 ${nOffline()} 恢复 ${nRecovery()}`);
  }

  {
    // 4b. 没发过离线信（抖动后恢复）→ 不发恢复信
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');
    expireGrace(n, 'srv1'); // 观察期结束但**没有**触发发信
    n.maybeNotifyStatus('srv1', 'online');
    check('未发过离线信就恢复 → 不发恢复信', sent.length === 0, `实际发了 ${sent.length} 封`);
  }

  {
    // 4c. 关掉恢复通知 → 只发离线信
    sent.length = 0;
    const p = makePanel({ notify: { offline: true, recovery: false } });
    panels.push(p);
    const n = p.notify;
    await goOffline(n, 'srv1');
    n.maybeNotifyStatus('srv1', 'online');
    check('关闭恢复通知 → 只发离线信', nOffline() === 1 && nRecovery() === 0, `离线 ${nOffline()} 恢复 ${nRecovery()}`);
  }

  // ================= 5. 开关与前置条件 =================
  {
    sent.length = 0;
    const p = makePanel({ notify: { offline: false, recovery: true } });
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');
    check('关闭离线通知 → 掉线不进入跟踪', !n.offlineNotified.has('srv1'));
    n.maybeNotifyStatus('srv1', 'online');
    check('关闭离线通知 → 全程不发信', sent.length === 0, `实际发了 ${sent.length} 封`);
  }

  {
    // 未填邮箱：不进入跟踪，因此手动走一遍「观察期结束」也不会发信
    sent.length = 0;
    const p = makePanel({ adminEmail: '' });
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');
    check('未填管理员邮箱 → 掉线不进入跟踪', !n.offlineNotified.has('srv1'));
    n.maybeNotifyStatus('srv1', 'online');
    check('未填管理员邮箱 → 不发信', sent.length === 0, `实际发了 ${sent.length} 封`);
  }

  {
    sent.length = 0;
    const p = makePanel({ smtpReady: false });
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');
    check('未配置 SMTP → 掉线不进入跟踪', !n.offlineNotified.has('srv1'));
    n.maybeNotifyStatus('srv1', 'online');
    check('未配置 SMTP → 不发信', sent.length === 0, `实际发了 ${sent.length} 封`);
  }

  // ================= 6. 发信失败要能补上 =================
  {
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    n.maybeNotifyStatus('srv1', 'offline');
    const rec = expireGrace(n, 'srv1');

    failSend = true;
    try {
      await n.sendOfflineMail('srv1', rec);
      check('SMTP 失败时不抛异常（内部已兜住）', true);
      check('SMTP 失败 → 没有邮件发出', sent.length === 0, `实际 ${sent.length} 封`);
      check('SMTP 失败 → 退回「未通知」，保留重试机会', rec.notified === false);
    } finally {
      failSend = false;
    }

    await n.sendOfflineMail('srv1', rec);
    check('SMTP 恢复后 → 这一封补上了', nOffline() === 1, `实际 ${nOffline()} 封`);
    check('补发成功后标记为已通知', rec.notified === true);
  }

  // ================= 7. 服务器被移除后停止跟踪 =================
  {
    sent.length = 0;
    const p = makePanel();
    panels.push(p);
    const n = p.notify;
    await goOffline(n, 'srv1');
    check('前置：已发 1 封离线信', nOffline() === 1);

    p.config.removeServer('srv1');
    await n.sendOfflineMail('srv1', n.offlineNotified.get('srv1'));
    check('服务器已移除 → 补发时停止跟踪', !n.offlineNotified.has('srv1'));
    check('服务器已移除 → 不再发信', nOffline() === 1, `实际 ${nOffline()} 封`);

    // 移除后即便还收到状态事件也不该重建跟踪
    n.maybeNotifyStatus('srv1', 'offline');
    n.maybeNotifyStatus('srv1', 'online');
    check('服务器已移除 → 状态事件不再产生邮件', sent.length === 1, `实际发了 ${sent.length} 封`);
  }

  // 收尾：清掉所有待发定时器，避免进程挂着
  for (const p of panels) {
    for (const id of [...p.notify.offlineNotified.keys()]) p.notify.clearOfflineTracking(id);
  }

  console.log(`\n${pass}/${total} notify-dedup cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
