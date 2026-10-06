'use strict';
// 找回密码「三段式 + 限流」的端到端校验：
//   ① 发码（IP 冷却 + 窗口限额，邮箱不匹配也计数，防探测/防轰炸）
//   ② 校验验证码换一次性票据（IP 错码锁定 + 单码全局试错上限防分布式爆破）
//   ③ 凭票据改密（票据一次性；旧版链接 token 仍兼容）
// 运行：node agent/e2e-reset-code.js
//
// 限流参数通过 createApi 的第 4 个参数注入成短窗口/小额度，便于在秒级验证；
// 不同阶段用不同的 X-Forwarded-For 模拟不同来源 IP（测试里 app 开了 trust proxy）。

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const { Config } = require(path.join(ROOT, 'panel', 'config'));
const { AgentHub } = require(path.join(ROOT, 'panel', 'agentlink'));
const { createApi } = require(path.join(ROOT, 'panel', 'api'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blocknexus-reset-'));
const PANEL_PORT = 3250;
const ADMIN_EMAIL = 'admin@example.com';

// 注入的限流参数（对应生产默认值：60s 冷却 / 5 次每小时 / 5 次错码锁 15 分钟 / 单码 20 次试错）
// maxCodeTries 要大于 VERIFY_MAX_FAILS(5)，否则单码试错上限会先于 IP 锁定触发，测不到锁定分支
const LIMITS = {
  cooldownMs: 300,
  windowMs: 2000,
  maxPerWindow: 3,
  lockMs: 60e3,
  maxCodeTries: 25,
};
const WRONG_CODE = '000001'; // 保证与真实验证码不同（真码为随机 6 位数，见 codeFromMail）

const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 拦截真实发信：api.js 用的是 nodemailer.createTransport，这里替换成假 transporter，
 * 把收件人与正文存下来，用来取出验证码。同时配置一份假的 SMTP，让 smtpConfigured() 为真。
 */
function captureMail(config) {
  config.data.settings.smtp = {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    user: 'panel@example.com',
    pass: 'fake',
    from: 'panel@example.com',
  };
  const nodemailer = require('nodemailer');
  const captured = [];
  const orig = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (msg) => {
      captured.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { accepted: [msg.to] };
    },
    close: () => {},
  });
  return {
    captured,
    restore: () => {
      nodemailer.createTransport = orig;
    },
  };
}

// 极简 cookie jar：让 PUT /settings 这类需要会话的接口带上登录态
let cookie = '';
async function api(method, p, body, ip) {
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function codeFromMail(mails) {
  const body = mails[mails.length - 1].text;
  const m = body.match(/\n(\d{6})\n/);
  if (!m) throw new Error('邮件正文里没找到 6 位验证码:\n' + body);
  return m[1];
}

async function main() {
  const config = new Config(path.join(TMP, 'config.json'));
  const mail = captureMail(config);
  config.data.settings.adminEmail = ADMIN_EMAIL;
  config.setCredentials({ username: 'admin', password: 'old-password' });
  config.data.panel.authEnabled = true;
  config.save();

  const bus = new EventEmitter();
  const hub = new AgentHub(config, bus);
  const app = express();
  app.set('trust proxy', true); // 测试用 X-Forwarded-For 模拟不同来源 IP
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createApi(config, hub, bus, LIMITS));
  const panelSrv = app.listen(PANEL_PORT, '127.0.0.1');
  await sleep(200);

  const IP_MAIN = '10.0.0.1'; // 正常流程
  const IP_TRIES = '10.0.0.2'; // 单码全局试错（轮换 IP）
  const IP_LOCK = '10.0.0.3'; // IP 错码锁定
  const IP_EXP = '10.0.0.6'; // 验证码过期
  const IP_OFF = '10.0.0.7'; // 关闭登录保护后失效
  const IP_RATE = '10.0.0.4'; // 发码限流
  const IP_MISC = '10.0.0.5'; // 其余（探活/登录/旧 token）

  /**
   * 等邮件到达（最多 timeoutMs）。
   *
   * 为什么需要它：/forgot-password **刻意不再 await 发信**——await 会让
   * 「邮箱命中」的响应比「不命中」慢数秒 SMTP 握手，等于把答案写在响应耗时里，
   * 构成管理员邮箱枚举通道。发信改为异步后，断言邮件就必须等它落地，
   * 否则是**时序竞态**（时快时慢，本地通过、CI 偶发失败）。
   */
  async function waitForMail(n, timeoutMs = 4000) {
    const t0 = Date.now();
    while (mail.captured.length < n && Date.now() - t0 < timeoutMs) await sleep(25);
    return mail.captured.length >= n;
  }

  /** 发一封新验证码并返回 code（自动等过冷却） */
  async function freshCode(ip) {
    await sleep(LIMITS.cooldownMs + 80);
    const want = mail.captured.length + 1;
    const r = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, ip);
    if (r.data.sent !== true) throw new Error('发码失败: ' + JSON.stringify(r.data));
    if (!(await waitForMail(want))) throw new Error('等待验证码邮件超时');
    return codeFromMail(mail.captured);
  }

  try {
    // T0 登录保护开启时，未登录访问受保护接口应 401
    {
      const r = await api('GET', '/servers', undefined, IP_MISC);
      report('T0 未登录访问受保护接口返回 401', r.status === 401, `status=${r.status}`);
    }

    // T1 邮箱不匹配时**响应与命中时完全一致**（sent 恒为 true），但实际不发信。
    // 这正是防「管理员邮箱枚举」的关键：若 sent 在两条分支上取值不同，
    // 未认证攻击者换个 email 打几次就能确认哪个是管理员邮箱。
    // （旧断言是 sent===false —— 那本身就构成了枚举通道，已随之修正。）
    {
      const r = await api('POST', '/forgot-password', { email: 'nobody@example.com' }, IP_MISC);
      report(
        'T1 邮箱不匹配：响应与命中时一致（sent 恒 true）但不发信',
        r.status === 200 && r.data.sent === true && r.data.smtpReady === true && mail.captured.length === 0,
        `sent=${r.data.sent} smtpReady=${r.data.smtpReady} mails=${mail.captured.length}`,
      );
    }

    // T2 正确邮箱 → 发信，正文含 6 位验证码、不含 URL
    let code;
    {
      const r = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_MAIN);
      await waitForMail(1); // 发信是异步的（见 waitForMail 的说明），必须等它落地
      const ok = r.status === 200 && r.data.sent === true && mail.captured.length === 1;
      if (!ok) {
        report('T2 发送验证码邮件', false, JSON.stringify(r.data));
        return;
      }
      const m = mail.captured[0];
      code = codeFromMail(mail.captured);
      const digitsOnly = /^\d{6}$/.test(code);
      const noLink = !m.text.includes('#/reset');
      // HTML 版：验证码以六格卡片呈现，且六格顺序拼起来就是验证码；纯文本版仍要能单独读到
      const cells = [...String(m.html || '').matchAll(/font-size:26px[^>]*>(\d)</g)].map((x) => x[1]);
      const htmlOk = cells.join('') === code && (m.html || '').includes('logo');
      report(
        'T2 发送验证码邮件（收件人正确、6 位纯数字、无链接）',
        m.to === ADMIN_EMAIL && digitsOnly && noLink,
        `to=${m.to} code=${code} hasLink=${!noLink}`,
      );
      report(
        'T2b 邮件带 HTML 版且验证码六格与明文一致',
        htmlOk,
        `html=${!!m.html} cells=${cells.join('')}`,
      );
    }

    // T3 配置里只存摘要，不存明文验证码
    {
      const raw = fs.readFileSync(path.join(TMP, 'config.json'), 'utf8');
      const stored = JSON.parse(raw).panel.resetCode;
      const hash = crypto.createHash('sha256').update(code).digest('hex');
      report(
        'T3 配置只落 sha256 摘要，无明文验证码',
        !!stored && stored.hash === hash && !raw.includes(code),
        `hasResetCode=${!!stored}`,
      );
    }

    // T4 错误验证码被拒，且不消耗（正确码仍可用）
    {
      const wrong = String((Number(code) % 1000000 + 1) % 1000000).padStart(6, '0');
      const r = await api('POST', '/verify-reset-code', { code: wrong }, IP_MAIN);
      report(
        'T4 错误验证码被拒且不消耗',
        r.status === 400 && /不正确/.test(r.data.error || ''),
        r.data.error,
      );
    }

    // T5 验证码不能直接改密：不带票据的 /reset-password 一律拒绝
    {
      const r = await api('POST', '/reset-password', { code, password: 'new-pass-123' }, IP_MAIN);
      report(
        'T5 验证码不能直接改密（必须先换票据）',
        r.status === 400 && /验证已失效/.test(r.data.error || ''),
        r.data.error,
      );
    }

    // T6 正确验证码 → 换到一次性票据，验证码同时作废
    let ticket;
    {
      const r = await api('POST', '/verify-reset-code', { code }, IP_MAIN);
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      ticket = r.data.ticket;
      report(
        'T6 校验通过发放票据且验证码立即作废',
        r.status === 200 && typeof ticket === 'string' && ticket.length >= 32 && cfg.panel.resetCode === undefined,
        `status=${r.status} hasTicket=${!!ticket} codeStored=${cfg.panel.resetCode !== undefined}`,
      );
      const again = await api('POST', '/verify-reset-code', { code }, IP_MAIN);
      report('T6b 同一验证码二次校验失败（已作废）', again.status === 400, again.data.error);
    }

    // T7 票据 + 短密码被拒
    {
      const r = await api('POST', '/reset-password', { ticket, password: '123' }, IP_MAIN);
      report('T7 密码少于 6 位被拒', r.status === 400, r.data.error);
    }

    // T8 票据 + 合法密码 → 重置成功
    {
      const r = await api('POST', '/reset-password', { ticket, password: 'new-pass-123' }, IP_MAIN);
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      report('T8 凭票据重置成功', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
      report('T8b 重置后仍为开启登录保护', cfg.panel.authEnabled === true);
    }

    // T9 票据一次性：重放失败
    {
      const r = await api('POST', '/reset-password', { ticket, password: 'replay-pass-123' }, IP_MAIN);
      report('T9 票据一次性，重放失效', r.status === 400, r.data.error);
    }

    // T10 老密码失效、新密码可登录
    {
      const bad = await api('POST', '/login', { username: 'admin', password: 'old-password' }, IP_MISC);
      const good = await api('POST', '/login', { username: 'admin', password: 'new-pass-123' }, IP_MISC);
      // 密码错误时 /login 返回 403（区别于未登录的 401）
      report(
        'T10 老密码失效 / 新密码可登录',
        bad.status === 403 && good.status === 200,
        `old=${bad.status} new=${good.status}`,
      );
    }

    // T11 单码全局试错上限：轮换来源 IP（每个 IP 只错 4 次，不触发 5 次 IP 锁定）
    // 把同一个验证码错够上限后整码作废——分布式爆破（多 IP 猜同一码）的兜底
    {
      const c = await freshCode(IP_TRIES);
      const wrongs = [];
      for (let i = 0; i < LIMITS.maxCodeTries; i++) {
        const ip = `10.9.${Math.floor(i / 4)}.${(i % 4) + 1}`;
        wrongs.push(await api('POST', '/verify-reset-code', { code: WRONG_CODE }, ip));
      }
      const blocked = await api('POST', '/verify-reset-code', { code: c }, '10.9.9.9');
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      report(
        'T11 单码试错超限后作废（正确码也不再可用）',
        // 断言重点在**行为**：错码一律 400、正确码也被拒、resetCode 已被删除。
        // 文案已统一为 code-invalid（不再有 verify-too-many）——那条 code 本身就是
        // 「此刻是否有码在途」的预言机，可被用来反推管理员邮箱。
        wrongs.every((w) => w.status === 400 && /不正确或已失效/.test(w.data.error || '')) &&
          blocked.status === 400 &&
          /不正确或已失效/.test(blocked.data.error || '') &&
          cfg.panel.resetCode === undefined,
        `last=${wrongs[wrongs.length - 1].data.error} blocked=${blocked.data.error}`,
      );
    }

    // T12 验证码过期后拒绝
    {
      const c = await freshCode(IP_EXP);
      config.data.panel.resetCode.expires = Date.now() - 1000;
      config.save();
      const r = await api('POST', '/verify-reset-code', { code: c }, IP_EXP);
      report(
        'T12 过期验证码被拒',
        // 文案与「错码」「已作废」统一（不再单独回 code-expired，
        // 否则可据它区分「有没有码在途」）
        r.status === 400 && /不正确或已失效/.test(r.data.error || ''),
        r.data.error,
      );
    }

    // T13 关闭登录保护时，已发出的验证码与票据立即失效
    {
      const c = await freshCode(IP_OFF);
      const v = await api('POST', '/verify-reset-code', { code: c }, IP_OFF);
      const t = v.data.ticket;
      await api('PUT', '/settings', { authEnabled: false }, IP_MISC);
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      const r = await api('POST', '/reset-password', { ticket: t, password: 'whatever-123' }, IP_OFF);
      report(
        'T13 关闭登录保护后票据立即失效',
        cfg.panel.resetCode === undefined && r.status === 400,
        `stored=${cfg.panel.resetCode !== undefined} status=${r.status}`,
      );
      await api('PUT', '/settings', { authEnabled: true }, IP_MISC);
    }

    // T14 旧版链接 token 仍被接受（兼容已发出的邮件）
    {
      const token = crypto.randomBytes(24).toString('hex');
      config.data.panel.resetToken = {
        hash: crypto.createHash('sha256').update(token).digest('hex'),
        expires: Date.now() + 15 * 60e3,
      };
      config.save();
      const r = await api('POST', '/reset-password', { token, password: 'legacy-pass-123' }, IP_MISC);
      const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
      report(
        'T14 旧链接 token 兼容可用且用后即删',
        r.status === 200 && cfg.panel.resetToken === undefined,
        JSON.stringify(r.data),
      );
    }

    // T15 发码限流：冷却期内直接 429，且不发第二封信
    {
      await sleep(LIMITS.cooldownMs + 80);
      const before = mail.captured.length;
      const first = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      const burst = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      await waitForMail(before + 1); // first 的信是异步发的，等它落地再断言
      report(
        'T15 冷却期内重复发码被限流且不再发信',
        first.data.sent === true &&
          burst.status === 429 &&
          mail.captured.length === before + 1,
        `burst=${burst.status} ${burst.data.error || ''} mails=${mail.captured.length - before}`,
      );
      // 冷却过后继续发，直到触达窗口额度（maxPerWindow=3，已用 1 次）
      await sleep(LIMITS.cooldownMs + 80);
      await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      await sleep(LIMITS.cooldownMs + 80);
      const third = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      await sleep(LIMITS.cooldownMs + 80);
      const over = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      report(
        'T16 窗口内超过发码额度被限流',
        third.data.sent === true && over.status === 429,
        `third=${JSON.stringify(third.data)} over=${over.status} ${over.data.error || ''}`,
      );
      // 窗口滑过后恢复
      await sleep(LIMITS.windowMs + 200);
      const after = await api('POST', '/forgot-password', { email: ADMIN_EMAIL }, IP_RATE);
      report('T17 窗口滑过后发码恢复', after.status === 200 && after.data.sent === true, JSON.stringify(after.data));
    }

    // T18 错码连续 5 次锁定该 IP（每次只错 5 次，少于单码试错上限 25），锁定期内正确码也不再受理
    {
      const c = await freshCode(IP_LOCK);
      let last;
      for (let i = 0; i < 4; i++) {
        last = await api('POST', '/verify-reset-code', { code: WRONG_CODE }, IP_LOCK);
      }
      const fifth = await api('POST', '/verify-reset-code', { code: WRONG_CODE }, IP_LOCK);
      const locked = await api('POST', '/verify-reset-code', { code: c }, IP_LOCK);
      report(
        'T18 错码 5 次锁定 IP，锁定期内正确码也拒绝',
        // 断言重点在**锁定行为**：第 4 次仍 400，第 5 次触发锁定 429，
        // 锁定期内连正确码也 429。不再断言「还可尝试 N 次」文案——
        // 那个计数提示随 code-invalid 统一去掉了（它同样是「有码在途」的弱信号）。
        last.status === 400 &&
          /不正确或已失效/.test(last.data.error || '') &&
          fifth.status === 429 &&
          locked.status === 429,
        `4th=${last.data.error} 5th=${fifth.status} lockedCorrect=${locked.status}`,
      );
    }
  } finally {
    mail.restore();
    panelSrv.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败：\n' + failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exitCode = 1;
});
