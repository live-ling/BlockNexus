'use strict';
// 面板 REST API：供 Web UI 调用，内部经 AgentHub 加密转发到远程 Agent。
// 实时事件通过 /api/events (SSE) 推送：status / agent-event(console 等) / install。

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { installAgent, updateAgentScript, uninstallAgent, checkSsh, sftpUploadStream } = require('./ssh');
const localAgent = require('./localagent');
const mailTpl = require('./mail');

const COOKIE = 'blocknexussid';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

// 面板版本：读 package.json（/api/me、/api/version 共用）
const APP_VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch { return '0.0.0'; }
})();

// 面板随附的 Agent 脚本版本：从 agent/agent.js 头部提取 AGENT_VERSION 常量，
// 与远端 hi 上报的 info.agentVersion 比对，不一致即自动更新
const BUNDLED_AGENT_VERSION = (() => {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
    const m = src.match(/AGENT_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch { return ''; }
})();

// 最新版本检查：GitHub Releases（缓存 10 分钟；?refresh=1 跳过缓存）
const REPO_URL = 'https://github.com/live-ling/BlockNexus';
const LATEST_RELEASE_API = 'https://api.github.com/repos/live-ling/BlockNexus/releases/latest';
const VERSION_CACHE_MS = 10 * 60e3;
let versionCache = { at: 0, data: null };

/** 三段版本号比较：a 是否大于 b（忽略 v 前缀与后缀） */
function semverGreater(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.\-+]/);
  const pb = String(b).replace(/^v/, '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const s = String(pa[i] ?? '').localeCompare(String(pb[i] ?? ''));
      if (s) return s > 0;
    } else if (na !== nb) return na > nb;
  }
  return false;
}

/** 检查更新；失败时保留旧缓存并在结果里带 error 字段 */
async function checkLatestRelease(version) {
  const fresh = Date.now() - versionCache.at < VERSION_CACHE_MS;
  if (versionCache.data && fresh) return { ...versionCache.data, cached: true };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(LATEST_RELEASE_API, {
      signal: ctrl.signal,
      headers: { 'User-Agent': `BlockNexus/${version}`, Accept: 'application/vnd.github+json' },
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const j = await r.json();
    const tag = String(j.tag_name || '').replace(/^v/, '');
    const data = {
      latest: tag || null,
      hasUpdate: !!tag && semverGreater(tag, version),
      releaseUrl: j.html_url || null,
      changelog: String(j.body || ''),
      checkedAt: Date.now(),
    };
    versionCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (versionCache.data) return { ...versionCache.data, cached: true, error: e.message || '检查失败' };
    return { latest: null, hasUpdate: false, releaseUrl: null, changelog: '', checkedAt: Date.now(), error: e.message || '检查失败' };
  }
}

function createApi(config, hub, bus, limiterOpts = {}) {
  const router = express.Router();
  const sessions = new Map(); // sid -> expires
  const sseClients = new Set();
  const installing = new Set(); // serverId 防并发安装

  // ---------- 任务日志：留存最近一批，供页面刷新后重放 ----------
  // 纯广播的日志一刷新就丢，而 SSH 装 Node 动辄几分钟，用户很可能中途刷新，
  // 因此在服务端按 (serverId, 任务类型) 缓存日志与完成状态。
  // 上限保护：单个 key 超 MAX_TASK_LOG 字符后从头截断，避免长时间安装撑爆内存。
  const taskLogs = new Map(); // key: `${serverId}:${kind}` -> { lines, done, updatedAt }
  const MAX_TASK_LOG = 256 * 1024;

  function taskLogKey(serverId, kind) {
    return `${serverId}:${kind}`;
  }

  function taskLogGet(serverId, kind) {
    return taskLogs.get(taskLogKey(serverId, kind)) || null;
  }

  function taskLogReset(serverId, kind) {
    taskLogs.set(taskLogKey(serverId, kind), { lines: '', done: null, updatedAt: Date.now() });
  }

  /** 追加一行日志：广播给在线页面的同时写入缓存 */
  function taskLog(serverId, kind, text) {
    const key = taskLogKey(serverId, kind);
    const cur = taskLogs.get(key) || { lines: '', done: null, updatedAt: 0 };
    let lines = cur.lines + String(text);
    if (lines.length > MAX_TASK_LOG) lines = lines.slice(lines.length - MAX_TASK_LOG);
    taskLogs.set(key, { lines, done: cur.done, updatedAt: Date.now() });
    bus.emit('broadcast', { type: kind, serverId, log: String(text) });
  }

  function taskLogDone(serverId, kind, payload) {
    const key = taskLogKey(serverId, kind);
    const cur = taskLogs.get(key) || { lines: '', done: null, updatedAt: 0 };
    taskLogs.set(key, { ...cur, ...payload, updatedAt: Date.now() });
    bus.emit('broadcast', { type: kind, serverId, ...payload });
  }

  // ---------- SSE 广播 ----------
  bus.on('broadcast', (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(line);
      } catch {}
    }
  });
  setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(':hb\n\n');
      } catch {}
    }
  }, 25000).unref();

  // ---------- 服务器资源快照（内存占用 / 磁盘用量） ----------
  // 后台每 30s 向在线 Agent 拉一次 sys.stats，缓存并经 SSE 广播；
  // /api/servers 把最近一次快照附在 stats 字段上（离线时显示旧值，Agent 太旧没这能力时为 null）
  const statsCache = new Map(); // serverId -> { data, at }
  async function refreshStats(serverId) {
    if (!hub.isOnline(serverId)) return;
    try {
      const data = await hub.request(serverId, 'sys.stats', {}, 8000);
      statsCache.set(serverId, { data, at: Date.now() });
      bus.emit('broadcast', { type: 'stats', serverId, stats: data });
    } catch {}
  }
  setInterval(() => {
    for (const s of config.listServers()) refreshStats(s.id);
  }, 30000).unref();

  // ---------- 邮件（SMTP）与离线/恢复通知 ----------
  function smtpConfigured() {
    const s = config.data.settings.smtp;
    return !!(s.host && s.user && s.pass);
  }

  /**
   * 发信：正文同时给 html 与 text 两个版本。
   * 优先用 mailTpl 的模板（{ text, html }），旧调用点传纯字符串时降级为纯文本邮件。
   * @param {string} to
   * @param {string} subject
   * @param {string|{text:string, html:string}} body
   */
  async function sendMail(to, subject, body) {
    const s = config.data.settings.smtp;
    if (!s.host) throw new Error('未配置 SMTP 服务器');
    
    // from 必须能解析出纯邮箱地址，否则降级为 SMTP 用户名
    let fromAddr = s.from;
    if (fromAddr) {
      const m = fromAddr.match(/<[^\s@]+@[^\s@]+\.[^\s@]+>$/);
      fromAddr = m ? m[0].slice(1, -1) : fromAddr.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddr)) fromAddr = s.user;
    } else {
      fromAddr = s.user;
    }
    
    const transporter = nodemailer.createTransport({
      host: s.host,
      port: Number(s.port) || (s.secure ? 465 : 587),
      secure: !!s.secure,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    const text = typeof body === 'string' ? body : body.text;
    const html = typeof body === 'string' ? undefined : body.html;
    try {
      await transporter.sendMail({ from: fromAddr, to, subject, text, html });
    } finally {
      transporter.close();
    }
  }

  // 离线通知降噪：同一次离线只发一封（24 小时后补发一封提醒，避免彻底沉寂）；
  // 恢复在线后重新武装（下次离线再发）。抖动重连由 10 分钟最小间隔兜底。
  const offlineNotified = new Map(); // serverId -> { at: 上次发信时间, open: 本次离线是否已发过 }
  const OFFLINE_MIN_GAP = 10 * 60e3;
  const OFFLINE_REMIND = 24 * 60 * 60e3;
  function maybeNotifyStatus(serverId, status) {
    const st = config.data.settings;
    if (!st.adminEmail || !smtpConfigured()) return;
    const server = config.getServer(serverId);
    const name = server ? server.name : serverId;
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    if (status === 'offline' && st.notify.offline) {
      const rec = offlineNotified.get(serverId);
      const gapOk = Date.now() - (rec ? rec.at : 0) >= OFFLINE_MIN_GAP;
      const remindDue = rec && rec.open && Date.now() - rec.at >= OFFLINE_REMIND;
      if (gapOk && (!rec || !rec.open || remindDue)) {
        offlineNotified.set(serverId, { at: Date.now(), open: true });
        sendMail(
          st.adminEmail,
          `[BlockNexus] 服务器离线：${name}`,
          mailTpl.offlineMail({ name, host: server ? server.host : '?', time: now }),
        ).catch((e) => console.error('[notify] 离线邮件发送失败:', e.message));
      }
    }
    if (status === 'online' && offlineNotified.has(serverId)) {
      // 保留 at（抖动时离线邮件仍受最小间隔约束），只解除「本次离线已通知」标记
      offlineNotified.set(serverId, { at: offlineNotified.get(serverId).at, open: false });
      if (st.notify.recovery) {
        sendMail(
          st.adminEmail,
          `[BlockNexus] 服务器已恢复：${name}`,
          mailTpl.recoveryMail({ name, time: now }),
        ).catch((e) => console.error('[notify] 恢复邮件发送失败:', e.message));
      }
    }
  }

  // ---------- Agent 版本一致性：远端落后自动更新 ----------
  // hi 上报 info.agentVersion ≠ 随附版本时：SSH 服务器走 updateAgentScript（换脚本+重启 systemd），
  // 本机 Agent 走 localagent 重装（跑的就是随附脚本，重启即新版）。
  // 失败退避：同一台连续失败 3 次或 10 分钟内刚试过就不再自动重试，转手动按钮。
  const agentUpdateState = new Map(); // serverId -> { state: 'updating'|'failed'|'done', error?, at }
  const agentUpdateTries = new Map(); // serverId -> 连续失败次数

  async function syncAgentVersion(serverId, info) {
    const server = config.getServer(serverId);
    if (!server || !BUNDLED_AGENT_VERSION) return;
    const remote = info && info.agentVersion ? String(info.agentVersion) : '';
    if (remote === BUNDLED_AGENT_VERSION) {
      agentUpdateState.delete(serverId);
      agentUpdateTries.delete(serverId);
      return;
    }
    const st = agentUpdateState.get(serverId);
    if (st && st.state === 'updating') return;
    // 刚试过（无论成败）先静默 10 分钟，防止「成功但没换掉」的死循环与失败风暴
    if (st && Date.now() - st.at < 10 * 60e3) return;
    const fails = agentUpdateTries.get(serverId) || 0;
    if (fails >= 3) return;
    agentUpdateState.set(serverId, { state: 'updating', at: Date.now() });
    const emit = (extra) =>
      bus.emit('broadcast', { type: 'agent-update', serverId, remote, bundled: BUNDLED_AGENT_VERSION, ...extra });
    emit({ state: 'updating' });
    const log = (line) => emit({ state: 'updating', log: String(line) });
    try {
      if (localAgent.isLocalHost(server.host)) {
        await localAgent.stopAgent(server, () => {});
        await localAgent.installAgent(server, log);
      } else {
        const sshOk =
          server.ssh && (server.ssh.auth === 'key' ? !!(server.ssh.key || server.ssh.keyPath) : !!server.ssh.password);
        if (!sshOk) {
          throw new Error('未保存可用的 SSH 凭据，无法自动更新；请在服务器设置页补全凭据或手动重装 Agent');
        }
        await updateAgentScript(server, log);
      }
      agentUpdateTries.delete(serverId);
      agentUpdateState.set(serverId, { state: 'done', at: Date.now() });
      emit({ state: 'done' });
    } catch (e) {
      const error = e.message || String(e);
      agentUpdateTries.set(serverId, fails + 1);
      agentUpdateState.set(serverId, { state: 'failed', error, at: Date.now() });
      emit({ state: 'failed', error });
    }
  }

  bus.on('broadcast', (e) => {
    if (e && e.type === 'agent-event' && e.event === 'hi') {
      void syncAgentVersion(e.serverId, e.data && e.data.info);
    }
  });

  hub.on('status', (serverId, status) => {
    maybeNotifyStatus(serverId, status);
    if (status === 'online') setTimeout(() => refreshStats(serverId), 1500);
  });

  // ---------- 鉴权 ----------
  function getSid(req) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }

  // 简单 CSRF 防护：所有 POST 必须是 application/json（跨域表单无法伪造）
  // 例外：SFTP 直传走二进制流（application/octet-stream），同样无法被跨域表单伪造
  router.use((req, res, next) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      if (req.path.endsWith('/files/upload/sftp')) return next();
      return res.status(415).json({ error: '需要 application/json' });
    }
    next();
  });

  // 公开接口：登录 / 登出 / 面板信息
  // 登录限流：同一来源连续失败 5 次锁定 5 分钟，缓解爆破
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 5 * 60 * 1000;
  const loginFails = new Map(); // ip -> { count, until }

  router.post('/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rec = loginFails.get(ip);
    if (rec && rec.until > Date.now()) {
      const wait = Math.ceil((rec.until - Date.now()) / 1000);
      return res.status(429).json({ error: `尝试次数过多，请 ${wait} 秒后再试` });
    }
    const { username, password } = req.body || {};
    if (!config.verifyCredentials(username, password)) {
      const count = (rec && rec.until === 0 ? rec.count : 0) + 1;
      loginFails.set(ip, {
        count,
        until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0,
      });
      const left = LOGIN_MAX_FAILS - count;
      return res.status(403).json({
        error: count >= LOGIN_MAX_FAILS ? '尝试次数过多，已锁定 5 分钟' : `用户名或密码错误${left <= 2 ? `（还可尝试 ${left} 次）` : ''}`,
      });
    }
    loginFails.delete(ip);
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, Date.now() + SESSION_TTL);
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const sid = getSid(req);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    // 公开接口：不返回用户名等敏感信息（用户名在登录后的 /api/settings 里才有）
    res.json({
      port: config.data.panel.port,
      authEnabled: !!config.data.panel.authEnabled,
      version: APP_VERSION,
    });
  });

  // ---------- LICENSE 全文（关于页展示；公开静态文本，无敏感信息） ----------
  router.get('/license', (req, res) => {
    try {
      res.json({ text: fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8') });
    } catch {
      res.status(404).json({ error: 'LICENSE 未随面板部署' });
    }
  });

  // ---------- 忘记密码 / 重置密码（公开接口，置于鉴权之前） ----------
  // 三段式：① 发码（限流）→ ② 校验验证码换一次性票据（限流）→ ③ 凭票据改密
  // 密码只在第 ③ 步提交，且必须持有第 ② 步的票据，验证码本身不能再直接改密
  // 第 4 个参数仅供回归测试注入更短的窗口/更小的额度（生产不传）
  const FORGOT_COOLDOWN_MS = limiterOpts.cooldownMs ?? 60e3; // 同一 IP 两次发码的最小间隔
  const FORGOT_WINDOW_MS = limiterOpts.windowMs ?? 3600e3; // 发码限额窗口
  const FORGOT_MAX_PER_WINDOW = limiterOpts.maxPerWindow ?? 5; // 每 IP 每窗口最多发 5 封
  const VERIFY_MAX_FAILS = 5; // 同一 IP 连续错 5 次锁定
  const VERIFY_LOCK_MS = limiterOpts.lockMs ?? 15 * 60e3; // 锁定时长（与验证码有效期一致）
  const VERIFY_MAX_GLOBAL = limiterOpts.maxCodeTries ?? 20; // 单个验证码的全局试错上限（跨 IP 防分布式爆破 6 位数字）
  const TICKET_TTL = 10 * 60e3; // 校验通过后改密票据的有效期

  const forgotSent = new Map(); // ip -> { count, windowStart, lastAt }
  const verifyFails = new Map(); // ip -> { count, until, at }
  const resetTickets = new Map(); // ticket -> expires（内存态：重启后需重新校验验证码）
  let codeTries = { hash: '', count: 0 }; // 当前验证码累计试错次数

  /** 常量时间比对 sha256 摘要（摘要为空/长度不符一律 false） */
  function hashEquals(hexHash, value) {
    const got = crypto.createHash('sha256').update(String(value)).digest();
    const want = Buffer.from(String(hexHash || ''), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  router.post('/forgot-password', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = forgotSent.get(ip) || { count: 0, windowStart: now, lastAt: 0 };
    if (now - rec.windowStart > FORGOT_WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    if (rec.count >= FORGOT_MAX_PER_WINDOW) {
      return res.status(429).json({
        error: `发送过于频繁，请 ${Math.ceil((rec.windowStart + FORGOT_WINDOW_MS - now) / 60000)} 分钟后再试`,
      });
    }
    if (now - rec.lastAt < FORGOT_COOLDOWN_MS) {
      return res.status(429).json({
        error: `请 ${Math.ceil((FORGOT_COOLDOWN_MS - (now - rec.lastAt)) / 1000)} 秒后再试`,
      });
    }
    // 不论邮箱是否匹配都计数：否则不匹配的请求可以无限打（拿它探测+轰炸管理员邮箱）
    rec.count += 1;
    rec.lastAt = now;
    forgotSent.set(ip, rec);

    const email = String((req.body || {}).email || '').trim();
    const st = config.data.settings;
    const match =
      !!email &&
      !!config.data.panel.passwordHash &&
      email.toLowerCase() === String(st.adminEmail || '').toLowerCase();
    // 邮箱不匹配/未配置也返回成功，避免被用来探测管理员邮箱
    if (!match || !smtpConfigured()) return res.json({ ok: true, sent: false });
    // 6 位数字验证码：邮件里直接可读，也便于在没有域名/公网地址时手动输入
    const code = String(crypto.randomInt(100000, 1000000));
    config.data.panel.resetCode = {
      hash: crypto.createHash('sha256').update(code).digest('hex'), // 只存摘要，不存原始验证码
      expires: now + 15 * 60e3,
    };
    config.save();
    codeTries = { hash: '', count: 0 }; // 新码重新计试错
    try {
      await sendMail(
        st.adminEmail,
        '[BlockNexus] 重置面板密码',
        mailTpl.resetCodeMail({ code }),
      );
    } catch (e) {
      return res.status(502).json({ error: '邮件发送失败: ' + e.message });
    }
    res.json({ ok: true, sent: true, cooldownSec: FORGOT_COOLDOWN_MS / 1000 });
  });

  /** 第 ② 步：校验验证码。通过后作废验证码并发放一次性改密票据 */
  router.post('/verify-reset-code', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = verifyFails.get(ip);
    if (rec && rec.until > now) {
      return res.status(429).json({
        error: `尝试次数过多，请 ${Math.ceil((rec.until - now) / 60000)} 分钟后再试`,
      });
    }
    const code = String((req.body || {}).code || '').trim();
    const rt = config.data.panel.resetCode;
    const usable = !!rt && now <= rt.expires;
    // 全局试错上限：单个验证码被猜太多次就整码作废，防多 IP 分布式爆破
    if (usable) {
      if (codeTries.hash !== rt.hash) codeTries = { hash: rt.hash, count: 0 };
      codeTries.count += 1;
      if (codeTries.count > VERIFY_MAX_GLOBAL) {
        delete config.data.panel.resetCode;
        config.save();
        return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
      }
    }
    if (!usable || !/^\d{6}$/.test(code) || !hashEquals(rt && rt.hash, code)) {
      let count = rec && now - rec.at < VERIFY_LOCK_MS ? rec.count : 0;
      count += 1;
      const until = count >= VERIFY_MAX_FAILS ? now + VERIFY_LOCK_MS : 0;
      verifyFails.set(ip, { count, until, at: now });
      if (until) {
        return res.status(429).json({ error: '尝试次数过多，已锁定 15 分钟，请稍后再试' });
      }
      return res.status(400).json({
        error: usable ? `验证码不正确（还可尝试 ${VERIFY_MAX_FAILS - count} 次）` : '验证码已过期，请重新获取',
      });
    }
    // 通过：验证码一次性作废（防止同码二次使用），换一张短时改密票据
    verifyFails.delete(ip);
    delete config.data.panel.resetCode;
    config.save();
    const ticket = crypto.randomBytes(24).toString('hex');
    resetTickets.set(ticket, now + TICKET_TTL);
    res.json({ ok: true, ticket, expiresInSec: TICKET_TTL / 1000 });
  });

  /** 第 ③ 步：凭票据（或旧版邮件链接 token）设置新密码 */
  router.post('/reset-password', (req, res) => {
    const b = req.body || {};
    const password = String(b.password ?? '');
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }
    const now = Date.now();
    const ticket = String(b.ticket || '');
    const legacy = String(b.token || '');
    let ok = false;
    if (ticket) {
      const exp = resetTickets.get(ticket);
      if (exp && exp > now) {
        resetTickets.delete(ticket); // 一次性：用过即废
        ok = true;
      }
    }
    // 兼容旧邮件里的链接 token：也按摘要比对，命中即可用
    if (!ok && legacy && config.data.panel.resetToken) {
      if (now <= config.data.panel.resetToken.expires && hashEquals(config.data.panel.resetToken.hash, legacy)) {
        delete config.data.panel.resetToken;
        ok = true;
      }
    }
    if (!ok) {
      return res.status(400).json({ error: '验证已失效，请先获取并验证邮箱验证码' });
    }
    config.setCredentials({ password });
    config.data.panel.authEnabled = true;
    config.save();
    sessions.clear(); // 密码已泄露场景：重置后所有会话下线
    res.json({ ok: true });
  });

  // 清理过期的发码记录 / 试错记录 / 改密票据，避免内存随访问量缓慢增长
  setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of forgotSent) {
      if (now - r.windowStart > FORGOT_WINDOW_MS && now - r.lastAt > FORGOT_COOLDOWN_MS) forgotSent.delete(ip);
    }
    for (const [ip, r] of verifyFails) {
      if ((r.until || 0) <= now && now - r.at > VERIFY_LOCK_MS) verifyFails.delete(ip);
    }
    for (const [t, exp] of resetTickets) {
      if (exp <= now) resetTickets.delete(t);
    }
  }, 60e3).unref();

  // 密码保护可开关：关闭时（默认，本地服务）其余接口直接放行；开启时需要会话
  router.use((req, res, next) => {
    if (!config.data.panel.authEnabled) return next();
    const sid = getSid(req);
    const exp = sid && sessions.get(sid);
    if (exp && exp > Date.now()) {
      sessions.set(sid, Date.now() + SESSION_TTL);
      return next();
    }
    if (sid) sessions.delete(sid);
    res.status(401).json({ error: '未登录' });
  });

  // ---------- 版本与更新检查（登录后） ----------
  router.get('/version', async (req, res) => {
    const data = await checkLatestRelease(APP_VERSION);
    res.json({ version: APP_VERSION, repoUrl: REPO_URL, ...data });
  });

  // ---------- 面板设置（登录后可读写） ----------
  // GET 返回 SMTP 密码之外的全体字段；PUT 支持部分更新——只处理请求里出现的字段
  router.get('/settings', (req, res) => {
    const st = config.data.settings;
    res.json({
      authEnabled: !!config.data.panel.authEnabled,
      username: config.data.panel.username || 'admin',
      domain: st.domain || '',
      adminEmail: st.adminEmail || '',
      smtp: {
        host: st.smtp.host || '',
        port: st.smtp.port || 465,
        secure: !!st.smtp.secure,
        user: st.smtp.user || '',
        from: st.smtp.from || '',
        hasPass: !!st.smtp.pass,
      },
      notify: { offline: !!st.notify.offline, recovery: !!st.notify.recovery },
      smtpReady: smtpConfigured() && !!st.adminEmail,
      ai: {
        enabled: !!st.ai.enabled,
        baseUrl: st.ai.baseUrl || '',
        model: st.ai.model || '',
        hasKey: !!st.ai.apiKey,
      },
    });
  });

  router.put('/settings', (req, res) => {
    const b = req.body || {};
    const st = config.data.settings;

    // —— 登录保护开关（仅当请求携带 authEnabled 时处理）——
    if (b.authEnabled !== undefined) {
      const hasPassword = !!config.data.panel.passwordHash;
      if (b.authEnabled) {
        const newUser = String(b.username ?? '').trim();
        if (newUser && !/^[A-Za-z0-9_.@-]{3,40}$/.test(newUser)) {
          return res.status(400).json({ error: '用户名需 3-40 位，可用字母数字与 _ . @ -' });
        }
        if (!hasPassword && (!b.password || String(b.password).length < 6)) {
          return res.status(400).json({ error: '启用密码保护需要至少 6 位的密码' });
        }
        if (b.password && String(b.password).length < 6) {
          return res.status(400).json({ error: '密码至少 6 位' });
        }
        config.setCredentials({ username: newUser || undefined, password: b.password || undefined });
        config.data.panel.authEnabled = true;
        config.save();
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.set(sid, Date.now() + SESSION_TTL);
        res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`);
      } else {
        // 关闭登录时也允许顺带改用户名（面板此时本身免密，无泄露面）
        if (b.username !== undefined && String(b.username).trim()) {
          config.setCredentials({ username: String(b.username).trim() });
        }
        config.data.panel.authEnabled = false;
        delete config.data.panel.resetCode; // 免密模式下已发出的验证码立即失效
        delete config.data.panel.resetToken;
        resetTickets.clear();
        config.save();
        sessions.clear();
      }
    }

    // —— 公网域名（用于找回密码链接与邮件里的面板地址；SSL 由 nginx 等反代负责）——
    if (b.domain !== undefined) {
      st.domain = String(b.domain).trim().replace(/\/+$/, '');
    }

    // —— 管理员邮箱 ——
    if (b.adminEmail !== undefined) {
      const e = String(b.adminEmail).trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
        return res.status(400).json({ error: '邮箱格式不正确' });
      }
      st.adminEmail = e;
    }

    // —— SMTP（pass 留空 = 不修改）——
    if (b.smtp && typeof b.smtp === 'object') {
      const s = b.smtp;
      if (s.host !== undefined) st.smtp.host = String(s.host).trim();
      if (s.port !== undefined) st.smtp.port = Math.min(Math.max(Number(s.port) || 465, 1), 65535);
      if (s.secure !== undefined) st.smtp.secure = !!s.secure;
      if (s.user !== undefined) st.smtp.user = String(s.user).trim();
      if (s.pass) st.smtp.pass = String(s.pass);
      if (s.from !== undefined) st.smtp.from = String(s.from).trim();
    }

    // —— 通知开关 ——
    if (b.notify && typeof b.notify === 'object') {
      if (b.notify.offline !== undefined) st.notify.offline = !!b.notify.offline;
      if (b.notify.recovery !== undefined) st.notify.recovery = !!b.notify.recovery;
    }

    // —— AI 日志分析（apiKey 留空 = 不修改）——
    if (b.ai && typeof b.ai === 'object') {
      const a = b.ai;
      if (a.enabled !== undefined) st.ai.enabled = !!a.enabled;
      if (a.baseUrl !== undefined) {
        const u = String(a.baseUrl).trim().replace(/\/+$/, '');
        if (u && !/^https?:\/\//i.test(u)) return res.status(400).json({ error: '接口地址需以 http:// 或 https:// 开头' });
        st.ai.baseUrl = u;
      }
      if (a.model !== undefined) st.ai.model = String(a.model).trim();
      if (a.apiKey) st.ai.apiKey = String(a.apiKey).trim();
    }

    config.save();
    res.json({ ok: true, authEnabled: config.data.panel.authEnabled });
  });

  // SMTP 连通性测试：向管理员邮箱发一封测试邮件
  router.post('/settings/smtp-test', async (req, res) => {
    const st = config.data.settings;
    try {
      if (!smtpConfigured()) return res.status(400).json({ error: '请先填写 SMTP 服务器、用户名与密码并保存' });
      if (!st.adminEmail) return res.status(400).json({ error: '请先在「通知设置」中填写管理员邮箱' });
      await sendMail(
        st.adminEmail,
        '[BlockNexus] SMTP 测试邮件',
        mailTpl.smtpTestMail(),
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(502).json({ error: '发送失败: ' + e.message });
    }
  });

  // agent.js 下载（手动安装用）——放在鉴权后还是前？放在鉴权前更方便 curl，但它不含密钥，安全
  // 说明：为方便手动安装，agent.js 开放匿名下载。

  // ---------- 服务器 ----------
  function sanitize(server, { revealToken = false } = {}) {
    const { ssh, ...rest } = server;
    const isLocal = localAgent.isLocalHost(server.host);
    const lst = isLocal ? localAgent.status(server) : null;
    return {
      ...rest,
      online: hub.isOnline(server.id),
      latency: hub.getLatency(server.id),
      // 最近一次资源快照（后台 30s 拉取；Agent 未上线或太旧时为 null）
      stats: statsCache.get(server.id)?.data ?? null,
      // 面板自身监听范围（前端据此提示手工安装命令是否可用）
      panelHost: config.data.panel.host || '127.0.0.1',
      // 本机服务器：由面板直接托管进程，不需要 SSH/systemd（前端据此切换文案与按钮）
      isLocal,
      localAgent: lst ? { pid: lst.pid, running: lst.running, dir: lst.dir, instancesDir: lst.instancesDir } : null,
      ssh: {
        port: ssh.port,
        user: ssh.user,
        auth: ssh.auth,
        hasPassword: !!ssh.password,
        hasKey: !!ssh.key || !!ssh.keyPath,
        keyPath: ssh.keyPath || '',
      },
      token: revealToken ? server.token : undefined,
    };
  }

  function requireServer(req, res) {
    const server = config.getServer(req.params.id);
    if (!server) {
      res.status(404).json({ error: '服务器不存在' });
      return null;
    }
    return server;
  }

  router.get('/servers', (req, res) => {
    res.json(
      config.listServers().map((s) => ({
        ...sanitize(s),
        agentBundled: BUNDLED_AGENT_VERSION,
        agentUpdate: agentUpdateState.get(s.id) || null,
      })),
    );
  });

  // 手动触发 Agent 更新（自动更新失败/被限流后的兜底入口）；结果经 SSE agent-update 推送
  router.post('/servers/:id/agent-update', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    agentUpdateTries.delete(server.id);
    agentUpdateState.delete(server.id);
    void syncAgentVersion(server.id, server.info).catch((e) => next(e));
    res.json({ ok: true, started: true });
  });

  // ---------- 添加服务器前：验证 SSH 连接（不落盘） ----------
  // 用前端填的主机/账号直连一次：确认凭据可用并预检安装环境（系统/Node/Java/sudo）。
  // 连接失败返回 400 + error；本机地址不走 SSH，由面板直接托管 Agent。
  router.post('/servers/ssh-check', async (req, res, next) => {
    const b = req.body || {};
    if (!b.host) return res.status(400).json({ error: '缺少主机地址' });
    if (localAgent.isLocalHost(b.host)) {
      return res.json({
        ok: true,
        canInstall: true,
        local: true,
        os: `${require('os').type()} ${require('os').arch()}`,
        warnings: ['本机服务器：保存后由面板直接托管 Agent 进程，无需 SSH 与 systemd'],
      });
    }
    const server = {
      host: String(b.host).trim(),
      ssh: {
        port: Number(b.sshPort) || 22,
        user: String(b.sshUser || 'root').trim(),
        auth: b.sshAuth === 'key' ? 'key' : 'password',
        password: String(b.sshPassword || ''),
        keyPath: String(b.sshKeyPath || '').trim(),
        key: String(b.sshKey || ''),
      },
    };
    try {
      res.json(await checkSsh(server));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  router.post('/servers', (req, res) => {
    const b = req.body || {};
    if (!b.host) return res.status(400).json({ error: '缺少主机地址' });
    const server = config.addServer(b);
    hub.syncOutbound();
    res.json(sanitize(server, { revealToken: true }));
  });

  router.get('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(sanitize(server, { revealToken: req.query.token === '1' }));
  });

  router.put('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    const patch = {
      name: b.name,
      host: b.host,
      panelUrl: b.panelUrl,
      agentMode: b.agentMode,
      agentHost: b.agentHost,
      agentPort: b.agentPort,
      agentTls: b.agentTls,
      ssh: {},
    };
    for (const k of ['port', 'user', 'auth', 'password', 'keyPath', 'key']) {
      if (b['ssh' + k[0].toUpperCase() + k.slice(1)] !== undefined) {
        patch.ssh[k] = b['ssh' + k[0].toUpperCase() + k.slice(1)];
      }
    }
    // 连接方式/地址/端口变了要重建外向连接（否则会继续用旧连接）
    const before = config.getServer(server.id).agent;
    // TLS 开关与证书指纹变化同样要重建连接（重装后指纹会更新）
    const sig = (a) => `${a.mode}|${a.host}|${a.port}|${a.tls ? 1 : 0}|${a.tlsFingerprint || ''}`;
    const beforeSig = sig(before);
    config.updateServer(server.id, patch);
    if (sig(config.getServer(server.id).agent) !== beforeSig) {
      hub.stopOutbound(server.id);
    }
    hub.syncOutbound();
    res.json(sanitize(config.getServer(server.id)));
  });

  router.delete('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const conn = hub.conns.get(server.id);
    if (conn) conn.kick('面板侧移除');
    config.removeServer(server.id);
    hub.syncOutbound();
    res.json({ ok: true });
  });

  router.post('/servers/:id/token/rotate', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const { randomToken } = require('./crypto');
    config.updateServer(server.id, { token: randomToken() });
    hub.stopOutbound(server.id);
    hub.syncOutbound();
    res.json({ ok: true, token: config.getServer(server.id).token });
  });

  // ---------- SSH 安装 Agent（本机服务器改由面板直接托管进程） ----------
  /** 安装收尾文案：本机不谈防火墙/安全组，远程沿用原来的排查提示 */
  function installDoneText(server, ok, isLocal) {
    if (ok) return '✓ Agent 已上线\n';
    const mode = server.agent.mode || 'outbound';
    if (isLocal) {
      return mode === 'inbound'
        ? '⚠ 本机 Agent 已启动，但未在 30 秒内回连面板，请检查面板地址是否正确\n'
        : `⚠ 本机 Agent 已启动，但面板连不上 127.0.0.1:${server.agent.port || 3099}，` +
            `请检查该端口是否被其他进程占用（详情见专用目录 agent.log）\n`;
    }
    return mode === 'inbound'
      ? '⚠ 安装流程结束，但 Agent 未在 30 秒内回连，请检查面板地址/防火墙\n'
      : `⚠ 安装流程结束，但面板连不上 ${server.agent.host || server.host}:${server.agent.port || 3099}，` +
          '请检查服务器安全组/防火墙是否放行该端口\n';
  }
  router.post('/servers/:id/install', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (installing.has(server.id)) return res.status(409).json({ error: '该服务器正在安装中' });
    if ((server.agent.mode || 'outbound') === 'inbound' && !server.agent.panelUrl) {
      return res.status(400).json({ error: '该服务器使用「Agent 回连面板」模式，需要填写面板地址' });
    }
    installing.add(server.id);
    config.updateServer(server.id, { installing: true });
    res.json({ ok: true, started: true });

    // 新一轮安装：清掉上一批日志，保证用户看到的是本轮的进度
    taskLogReset(server.id, 'install');
    const log = (text) => taskLog(server.id, 'install', text);
    try {
      const isLocal = localAgent.isLocalHost(server.host);
      if (isLocal) {
        // 本机：面板直接托管 Agent 进程（专用目录，不走 SSH/systemd）
        log('检测到本机服务器，由面板直接托管 Agent 进程…\n');
        await localAgent.installAgent(server, log);
      } else {
        const installResult = await installAgent(server, log);
        if (installResult && installResult.tlsFingerprint) {
          config.updateServer(server.id, { tlsFingerprint: installResult.tlsFingerprint });
        }
      }
      hub.stopOutbound(server.id); // 先断旧连接
      hub.syncOutbound(); // outbound 模式：面板立刻尝试连入
      // 等待连接就绪
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !hub.isOnline(server.id)) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const ok = hub.isOnline(server.id);
      log(installDoneText(server, ok, isLocal));
      taskLogDone(server.id, 'install', { done: true, ok });
    } catch (e) {
      log('✗ 安装失败: ' + e.message + '\n');
      taskLogDone(server.id, 'install', { done: true, ok: false, error: e.message });
    } finally {
      installing.delete(server.id);
      config.updateServer(server.id, { installing: false });
    }
  });

  // ---------- 经 Agent 的操作 ----------
  function agent(server) {
    return hub.request.bind(hub, server.id);
  }

  router.get('/servers/:id/instances', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.list', {}, 15000));
    } catch (e) {
      next(e);
    }
  });

  // 只读请求自动重试：连接刚好在重连窗口（AGENT_OFFLINE）时等待短暂重试一次，
  // 响应超时（AGENT_TIMEOUT）也重试一次——读操作幂等，能显著降低瞬时抖动导致的页面报错
  const READ_TIMEOUT_DEFAULT = 15000;
  async function waitOnline(serverId, waitMs) {
    const deadline = Date.now() + waitMs;
    while (!hub.isOnline(serverId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return hub.isOnline(serverId);
  }
  async function agentRead(server, action, params = {}, timeoutMs = READ_TIMEOUT_DEFAULT) {
    try {
      return await hub.request(server.id, action, params, timeoutMs);
    } catch (e) {
      if (e.code === 'AGENT_OFFLINE') {
        if (!(await waitOnline(server.id, 5000))) throw e;
      } else if (e.code !== 'AGENT_TIMEOUT') {
        throw e;
      }
      return hub.request(server.id, action, params, timeoutMs);
    }
  }

  // ---------- 版本清单：Agent 获取失败时由面板兜底（官方源 → 镜像源 → 磁盘缓存） ----------
  const VERSIONS_CACHE_FILE = path.join(__dirname, '..', 'data', 'mc-versions-cache.json');
  const VERSIONS_TTL = 3600e3;
  const VERSIONS_STALE_TTL = 7 * 24 * 3600e3;
  const MANIFEST_URLS = [
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  ];
  let panelVersionsCache = null;

  // 统一 UA：部分镜像（清华 TUNA、MSL 等）要求或不带 UA 就 403；MSL 要求 UA 含应用名
  const HTTP_UA = 'BlockNexus/0.1.0';

  function fetchJsonPanel(urlStr, timeoutMs) {
    return new Promise((resolve, reject) => {
      const get = (u, redirects) => {
        const mod = u.startsWith('https') ? require('https') : require('http');
        const req = mod.get(u, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects > 5) return reject(new Error('重定向过多'));
            return get(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + res.statusCode));
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

  function normalizeVersions(data) {
    return {
      latest: data.latest.release,
      versions: data.versions
        .filter((v) => v.type === 'release')
        .slice(0, 80)
        .map((v) => ({ id: v.id, releaseTime: v.releaseTime, url: v.url })),
    };
  }

  async function panelFetchVersions() {
    if (panelVersionsCache && Date.now() - panelVersionsCache.at <= VERSIONS_TTL) {
      return panelVersionsCache.data;
    }
    const errs = [];
    for (const url of MANIFEST_URLS) {
      try {
        const data = await fetchJsonPanel(url, 12000);
        const normalized = normalizeVersions(data);
        panelVersionsCache = { at: Date.now(), data: normalized };
        try {
          require('fs').writeFileSync(
            VERSIONS_CACHE_FILE,
            JSON.stringify({ at: Date.now(), data: normalized }),
          );
        } catch {}
        return normalized;
      } catch (e) {
        errs.push(`${new URL(url).host}: ${e.message}`);
      }
    }
    try {
      const cached = JSON.parse(require('fs').readFileSync(VERSIONS_CACHE_FILE, 'utf8'));
      if (cached && cached.data && Date.now() - cached.at <= VERSIONS_STALE_TTL) {
        return { ...cached.data, stale: true };
      }
    } catch {}
    throw new Error('版本清单获取失败（' + errs.join('；') + '）');
  }

  // ---------- 服务端核心目录：Agent 拉不到时由面板用自己的网络兜底 ----------
  // 目录里的 MC 版本清单和下载源无关（下载动作仍在 Agent 侧执行），
  // 所以面板代拉只是「让页面有得选」，不会改变实际安装链路。
  // 与 Agent 端 CORE_KINDS 保持一致，仅用于面板兜底时告诉前端有哪些核心可选
  const CORE_KINDS_PANEL = [
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
  const CORES_CACHE_FILE = path.join(__dirname, '..', 'data', 'mc-cores-cache.json');
  const PAPER_API = 'https://fill.papermc.io/v3/projects';
  const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';
  const FABRIC_GAME_API = 'https://meta.fabricmc.net/v2/versions/game';
  const NEOFORGE_MC_PREFIX = {
    '1.21.1': '21.1.', '1.21.2': '21.2.', '1.21.3': '21.3.', '1.21.4': '21.4.',
    '1.21.5': '21.5.', '1.21.6': '21.6.', '1.21.7': '21.7.', '1.21.8': '21.8.',
    '1.21.9': '21.9.', '1.21.10': '21.10.', '1.20.5': '20.5.', '1.20.6': '20.6.',
    '1.20.4': '20.4.', '1.20.3': '20.3.', '1.20.2': '20.2.', '1.20.1': '20.1.',
    '1.20': '20.1.', '1.19.4': '19.4.', '1.19.3': '19.3.', '1.19.2': '19.2.',
    '1.18.2': '18.2.',
  };

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

  function httpGetText(urlStr, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const mod = urlStr.startsWith('https') ? require('https') : require('http');
      const req = mod.get(urlStr, { headers: { 'User-Agent': HTTP_UA } }, (res) => {
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

  /** 官方源按核心类型拉版本列表；实现与 Agent 端保持一致，失败就抛 */
  async function panelCoreVersionsOfficial(kind) {
    if (kind === 'vanilla') return panelFetchVersions();
    if (kind === 'paper' || kind === 'folia') {
      const d = await fetchJsonPanel(`${PAPER_API}/${kind}`, 15000);
      return { versions: Object.keys(d.versions || {}).map((id) => ({ id })), latest: null };
    }
    if (kind === 'purpur') {
      const d = await fetchJsonPanel(PURPUR_API, 15000);
      // 该接口按发布时间升序返回，倒过来才是「新版本在前」
      const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
      return { versions: list.map((id) => ({ id })), latest: list[0] || null };
    }
    if (kind === 'fabric') {
      const g = await fetchJsonPanel(FABRIC_GAME_API, 15000);
      const stable = (Array.isArray(g) ? g : []).filter((v) => v.stable);
      return {
        versions: stable.slice(0, 40).map((v) => ({ id: v.version })),
        latest: stable[0] && stable[0].version,
      };
    }
    if (kind === 'forge') {
      const xml = await httpGetText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
      const byMc = new Map();
      for (const m of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
        const mm = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(m[1]);
        if (!mm) continue;
        const cur = byMc.get(mm[1]);
        if (!cur || cmpVersion(mm[2], cur.build) > 0) byMc.set(mm[1], { mc: mm[1], build: mm[2], full: m[1] });
      }
      const list = [...byMc.values()].sort((a, b) => cmpVersion(b.mc, a.mc));
      return { versions: list.map((x) => ({ id: x.mc, build: x.full })), latest: list[0] && list[0].mc };
    }
    if (kind === 'neoforge') {
      const xml = await httpGetText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const byMc = new Map();
      for (const m of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
        const v = m[1];
        if (!/^\d+\.\d+\.\d+/.test(v)) continue;
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

  // ---------- MSL 镜像源（https://www.mslmc.cn，官方源失败后的兜底） ----------
  // 要求：请求带含应用名的 UA（统一 HTTP_UA）；API 有 QPS 限制，仅在官方源失败后调用。
  const MSL_API = 'https://api.mslmc.cn/v4';
  const MSL_SOURCES = new Set(['vanilla', 'paper', 'purpur', 'folia', 'forge', 'neoforge', 'fabric']);

  /** MSL 接口统一解包 {code,message,data}；code!==200 视为失败 */
  async function mslFetchJson(suffix, timeoutMs = 15000) {
    const d = await fetchJsonPanel(MSL_API + suffix, timeoutMs);
    if (!d || d.code !== 200) throw new Error((d && d.message) || 'MSL 接口返回 ' + (d && d.code));
    return d.data;
  }

  /** MSL 镜像的版本目录兜底 */
  async function mslVersionsFor(kind) {
    if (!MSL_SOURCES.has(kind)) throw new Error('MSL 不支持该核心类型: ' + kind);
    const d = await mslFetchJson('/mirrors/' + encodeURIComponent(kind), 15000);
    const list = [...(d.versions || [])].sort((a, b) => cmpVersion(b, a));
    const versions = list.map((id) => ({ id }));
    if (!versions.length) throw new Error('MSL 版本目录为空');
    return { versions, latest: versions[0].id };
  }

  /** 面板侧按核心类型拉版本列表：官方源 → MSL 镜像兜底 */
  async function panelCoreVersions(kind) {
    try {
      return await panelCoreVersionsOfficial(kind);
    } catch (officialErr) {
      try {
        return await mslVersionsFor(kind);
      } catch {
        throw officialErr; // 镜像也失败时保留官方错误（更接近根因）
      }
    }
  }

  /** 面板侧兜底：逐个核心并行拉取，至少一个成功就写缓存；全部失败退回磁盘缓存 */
  async function panelFetchCores() {
    const KINDS = ['vanilla', 'paper', 'purpur', 'folia', 'fabric', 'forge', 'neoforge'];
    const entries = await Promise.all(
      KINDS.map(async (kind) => {
        try {
          return [kind, { ...(await panelCoreVersions(kind)), ok: true }];
        } catch (e) {
          return [kind, { ok: false, error: e.message, versions: [] }];
        }
      }),
    );
    const catalogs = Object.fromEntries(entries);
    if (entries.some(([, r]) => r.ok)) {
      try {
        require('fs').writeFileSync(
          CORES_CACHE_FILE,
          JSON.stringify({ at: Date.now(), data: catalogs }),
        );
      } catch {}
      return catalogs;
    }
    try {
      const cached = JSON.parse(require('fs').readFileSync(CORES_CACHE_FILE, 'utf8'));
      if (cached && cached.data && Date.now() - cached.at <= VERSIONS_STALE_TTL) return cached.data;
    } catch {}
    throw new Error('核心目录获取失败（Agent 与面板均不可达）');
  }

  // ---------- 面板代下核心：Agent 侧网络受限（核心列表 404/下载超时）时， ----------
  // 由面板用自己的网络下载核心，再经加密通道推送到服务器落位安装。
  // 触发：Agent 安装失败（instance.updated status=failed）后自动兜底（10 分钟冷却防循环），
  // 也可在实例卡片手动点「面板代下」。

  const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
  const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
  const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
  const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
  const FABRIC_LOADER_API = 'https://meta.fabricmc.net/v2/versions/loader';
  const FABRIC_INSTALLER = '1.1.2';
  const FABRIC_INSTALLER_JAR = `fabric-installer-${FABRIC_INSTALLER}.jar`;
  // 与 Agent 端一致：Mojang 托管的下载可按原路径改写到 BMCLAPI 镜像
  const MOJANG_FILE_HOSTS = ['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com'];
  const PANEL_MIRROR_HOST = 'bmclapi2.bangbang93.com';

  function withPanelMirror(urlStr) {
    try {
      const u = new URL(urlStr);
      if (MOJANG_FILE_HOSTS.includes(u.host)) {
        u.host = PANEL_MIRROR_HOST;
        return u.toString();
      }
    } catch {}
    return null;
  }

  /**
   * 面板侧把「核心类型 + 版本（+构建）」解析成可下载计划，与 Agent 端 resolveCorePlan 等价。
   * Agent 自己拉不到这些 API 时（正是需要兜底的场景），解析必须完全在面板侧完成。
   * 官方源失败时走 MSL 镜像兜底（mslResolvePlan）。
   */
  async function panelResolvePlan(args) {
    try {
      return await panelResolvePlanOfficial(args);
    } catch (officialErr) {
      const { source, version, build } = args;
      if (!MSL_SOURCES.has(source)) throw officialErr;
      try {
        return await mslResolvePlan(source, version, build);
      } catch {
        throw officialErr; // 镜像也失败时保留官方错误（更接近根因）
      }
    }
  }

  /** MSL 镜像兜底：来源+版本（+可选构建）→ 下载计划（与 Agent 端 mslResolvePlan 等价） */
  async function mslResolvePlan(source, version, build) {
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

  /** 官方源解析（panelResolvePlan 主体） */
  async function panelResolvePlanOfficial({ source, version, build, url }) {
    if (source === 'url') {
      if (!/^https?:\/\/.+/i.test(String(url || ''))) throw new Error('无效的核心下载 URL');
      return { kind: 'direct', url: String(url), fileName: 'server.jar' };
    }
    if (source === 'paper' || source === 'folia') {
      const d = await fetchJsonPanel(`${PAPER_API}/${source}/versions/${encodeURIComponent(version)}/builds`, 15000);
      const builds = Array.isArray(d.builds) ? d.builds : Array.isArray(d) ? d : [];
      if (!builds.length) throw new Error(`${source} ${version} 没有可用构建`);
      const latest = builds.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
      const pick = build ? builds.find((b) => String(b.id) === String(build)) : latest;
      if (!pick) throw new Error(`构建 #${build} 不存在`);
      const dl = pick.downloads && pick.downloads['server:default'];
      if (!dl || !dl.url) throw new Error('该构建没有服务端下载');
      return { kind: 'direct', url: dl.url, fileName: dl.name || 'server.jar', build: String(pick.id) };
    }
    if (source === 'purpur') {
      const d = await fetchJsonPanel(`${PURPUR_API}/${encodeURIComponent(version)}`, 15000);
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
      const loaders = await fetchJsonPanel(FABRIC_LOADER_API, 15000);
      const loader = Array.isArray(loaders) ? loaders[0] : null;
      if (!loader) throw new Error('未取到 Fabric Loader 版本');
      return {
        kind: 'fabric',
        url: `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${FABRIC_INSTALLER}/${FABRIC_INSTALLER_JAR}`,
        fileName: 'fabric-installer.jar',
        loader: loader.version,
      };
    }
    if (source === 'forge' || source === 'neoforge') {
      let full = build;
      if (!full) {
        const xml = await httpGetText(source === 'forge' ? FORGE_MAVEN : NEOFORGE_MAVEN, 20000);
        if (source === 'forge') {
          let best = null;
          for (const m of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
            const mm = new RegExp(`^${version.replace(/\./g, '\\.')}-(.+)$`).exec(m[1]);
            if (mm && (!best || cmpVersion(mm[1], best.build) > 0)) best = { build: mm[1], full: m[1] };
          }
          if (!best) throw new Error(`Forge 没有 ${version} 的版本`);
          full = best.full;
        } else {
          const prefix = NEOFORGE_MC_PREFIX[version];
          if (!prefix) throw new Error(`NeoForge 暂不支持 ${version}（版本映射未知）`);
          let best = null;
          for (const m of String(xml).matchAll(/<version>([^<]+)<\/version>/g)) {
            const v = m[1];
            if (!v.startsWith(prefix)) continue;
            if (!best || cmpVersion(v, best) > 0) best = v;
          }
          if (!best) throw new Error(`NeoForge 没有 ${version} 的版本`);
          full = best;
        }
      }
      return source === 'forge'
        ? {
            kind: 'forge',
            url: `${FORGE_MAVEN_BASE}/${full}/forge-${full}-installer.jar`,
            fileName: `forge-${full}-installer.jar`,
            build: full,
          }
        : {
            kind: 'neoforge',
            url: `${NEOFORGE_MAVEN_BASE}/${full}/neoforge-${full}-installer.jar`,
            fileName: `neoforge-${full}-installer.jar`,
            build: full,
          };
    }
    // vanilla（mojang 是历史来源名）
    if (source === 'vanilla' || source === 'mojang') {
      let v = null;
      try {
        const data = await panelFetchVersions();
        v = (data.versions || []).find((x) => x.id === version);
      } catch {}
      if (!v || !v.url) {
        // 磁盘缓存可能是旧格式（没有 url 字段），直接现拉一次清单
        v = null;
        for (const u of MANIFEST_URLS) {
          try {
            const data = await fetchJsonPanel(u, 12000);
            v = (data.versions || []).find((x) => x.id === version);
            if (v) break;
          } catch {}
        }
      }
      if (!v) throw new Error('版本不存在: ' + version);
      let vjson;
      try {
        vjson = await fetchJsonPanel(v.url, 20000);
      } catch (e) {
        const mirrored = withPanelMirror(v.url);
        if (!mirrored) throw e;
        vjson = await fetchJsonPanel(mirrored, 20000);
      }
      const dlUrl = vjson.downloads && vjson.downloads.server && vjson.downloads.server.url;
      if (!dlUrl) throw new Error('该版本没有服务端下载（可能是快照/旧版）');
      return { kind: 'direct', url: dlUrl, fileName: 'server.jar' };
    }
    throw new Error('未知核心类型: ' + source);
  }

  /** 面板侧流式下载（带重定向与 UA），与 Agent 端 downloadToFile 等价 */
  function downloadFilePanel(urlStr, dest, onProgress, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const get = (u, redirects) => {
        const mod = u.startsWith('https') ? require('https') : require('http');
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
          const out = require('fs').createWriteStream(dest);
          res.on('data', (c) => {
            got += c.length;
            if (total && onProgress) onProgress(got, total);
          });
          res.pipe(out);
          out.on('error', reject);
          out.on('finish', () => resolve(dest));
        });
        req.on('error', (e) => reject(new Error((e.message || '网络错误') + ' — ' + u)));
        req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
      };
      get(urlStr, 0);
    });
  }

  /**
   * 经加密通道把面板本地文件推到实例目录（复用 Agent 的分块上传协议）。
   * 同样支持断点续传：分块失败后重新 begin（resume），Agent 返回 received，
   * 对齐到整块（必要时 seekTo 截掉半块）后继续，最多恢复 6 次。
   */
  async function pushFileToAgent(server, name, filePath, remoteName, onProgress) {
    const req = hub.request.bind(hub, server.id);
    const fs = require('fs');
    const st = fs.statSync(filePath);
    const beginOpts = { name, dir: '', filename: remoteName, size: st.size, resume: true };
    let begin = await req('fs.upload.begin', beginOpts, 30000);
    const chunkSize = begin.chunk || 512 * 1024;
    let offset = Math.floor((begin.received || 0) / chunkSize) * chunkSize;
    let seq = 0;
    let pendingSeek = offset !== (begin.received || 0);
    let recoveries = 0;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(chunkSize);
      while (offset < st.size) {
        const len = Math.min(chunkSize, st.size - offset);
        fs.readSync(fd, buf, 0, len, offset);
        try {
          await req(
            'fs.upload.chunk',
            {
              uploadId: begin.uploadId,
              seq: ++seq,
              dataB64: buf.slice(0, len).toString('base64'),
              ...(pendingSeek ? { seekTo: offset } : {}),
            },
            60000,
          );
          pendingSeek = false;
        } catch (e) {
          if (++recoveries > 6) throw e;
          // 会话过期/序号错位：重新 begin 接续，Agent 返回的 received 是字节准绳
          begin = await req('fs.upload.begin', beginOpts, 30000);
          const aligned = Math.floor((begin.received || 0) / chunkSize) * chunkSize;
          if (aligned >= st.size) break; // 已全部收完，只剩 finish
          offset = aligned;
          seq = 0;
          pendingSeek = aligned !== (begin.received || 0);
          continue;
        }
        offset += len;
        if (onProgress) onProgress(offset, st.size);
      }
      await req('fs.upload.finish', { uploadId: begin.uploadId }, 60000);
    } catch (e) {
      req('fs.upload.abort', { uploadId: begin.uploadId }, 15000).catch(() => {});
      throw e;
    } finally {
      fs.closeSync(fd);
    }
  }

  const panelInstalls = new Set(); // `${serverId}:${instance}` 防并发
  const panelFallbackAt = new Map(); // 自动兜底冷却：key -> ts

  /** 面板代下编排：解析计划 → 面板下载 → 加密通道推送 → Agent 落位安装 */
  async function runPanelInstall(server, name, { auto = false } = {}) {
    const key = `${server.id}:${name}`;
    if (panelInstalls.has(key)) throw new Error('该实例的面板代下已在进行中');
    panelInstalls.add(key);
    const fs = require('fs');
    const tmpDir = path.join(__dirname, '..', 'data', 'panel-core-tmp');
    const tmpFile = path.join(tmpDir, `${server.id}-${name}-${Date.now()}.part`);
    const req = hub.request.bind(hub, server.id);
    // 叙述写进实例控制台，用户在实例页能看到完整链路
    const log = (text) => req('instance.logLine', { name, text }, 15000).catch(() => {});
    const progress = (phase) => (got, total) => {
      if (!total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct % 5 === 0) {
        bus.emit('broadcast', {
          type: 'agent-event',
          serverId: server.id,
          event: 'install.progress',
          data: { instance: name, phase, pct },
        });
      }
    };
    try {
      const list = await req('instance.list', {}, 20000);
      const inst = (Array.isArray(list) ? list : []).find((x) => x && x.name === name);
      if (!inst) throw new Error('实例不存在');
      const source = inst.source || 'vanilla';
      if (source === 'upload') throw new Error('上传型实例请在文件管理里直接上传 server.jar');
      if (inst.status === 'downloading') throw new Error('Agent 正在安装中，无需面板代下');
      await log(
        `[BlockNexus] ${auto ? '服务器侧下载失败，自动改由' : '手动触发'}面板侧下载 ${
          source === 'url' ? '自定义直链核心' : `${source} ${inst.version}`
        } …`,
      );

      const plan = await panelResolvePlan({ source, version: inst.version, build: inst.build, url: inst.url });
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        await log(`[BlockNexus] 面板开始下载: ${plan.url}`);
        await downloadFilePanel(plan.url, tmpFile, progress('download'));
      } catch (e) {
        const mirrored = withPanelMirror(plan.url);
        if (!mirrored) throw e;
        await log(`[BlockNexus] 官方源下载失败（${e.message}），改用镜像源重试`);
        await downloadFilePanel(mirrored, tmpFile, progress('download'));
      }
      // 源带 sha256（如 MSL）时先校验再传输，防止损坏文件传到服务器
      if (plan.sha256) {
        await log('[BlockNexus] 正在核对文件 sha256 …');
        await new Promise((resolve, reject) => {
          const crypto = require('crypto');
          const hash = crypto.createHash('sha256');
          const stream = fs.createReadStream(tmpFile);
          stream.on('data', (c) => hash.update(c));
          stream.on('error', reject);
          stream.on('end', () => {
            const got = hash.digest('hex');
            if (got.toLowerCase() === String(plan.sha256).toLowerCase()) resolve();
            else reject(new Error('sha256 校验失败（期望 ' + String(plan.sha256).slice(0, 12) + '…，实际 ' + got.slice(0, 12) + '…）'));
          });
        });
      }
      // 下载产物可能是安装器（fabric/forge/neoforge）或 server.jar，按 plan.fileName 落位
      const finalLocal = path.join(tmpDir, `${server.id}-${name}-${Date.now()}-${plan.fileName}`);
      fs.renameSync(tmpFile, finalLocal);
      try {
        await log(`[BlockNexus] 下载完成（${(fs.statSync(finalLocal).size / 1048576).toFixed(1)} MB），经加密通道传输到服务器…`);
        await pushFileToAgent(server, name, finalLocal, plan.fileName, progress('transfer'));
        await log('[BlockNexus] 传输完成，开始落位安装…');
        const r = await req(
          'instance.panelInstall',
          { name, kind: plan.kind, file: plan.fileName, build: plan.build, loader: plan.loader, url: plan.url },
          30000,
        );
        await log(
          r && r.started
            ? '[BlockNexus] 面板代下完成，安装器正在服务器上运行，请留意控制台'
            : '[BlockNexus] 面板代下完成，核心已就位',
        );
        return r;
      } finally {
        fs.rmSync(finalLocal, { force: true });
      }
    } catch (e) {
      await log('[BlockNexus] 面板代下失败: ' + e.message);
      throw e;
    } finally {
      panelInstalls.delete(key);
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {}
    }
  }

  // 自动兜底：Agent 侧安装失败（网络受限）时面板主动接手，10 分钟冷却防失败循环
  bus.on('broadcast', (msg) => {
    if (msg.type !== 'agent-event' || msg.event !== 'instance.updated') return;
    const d = msg.data || {};
    if (d.status !== 'failed' || !d.instance) return;
    const key = `${msg.serverId}:${d.instance}`;
    const last = panelFallbackAt.get(key) || 0;
    if (Date.now() - last < 10 * 60e3) return;
    const server = config.getServer(msg.serverId);
    if (!server || !hub.isOnline(server.id)) return;
    panelFallbackAt.set(key, Date.now());
    runPanelInstall(server, d.instance, { auto: true }).catch((e) => {
      console.error(`[panel-install] ${msg.serverId}/${d.instance} 自动兜底失败: ${e.message}`);
    });
  });

  router.get('/servers/:id/mcversions', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('mc.versions', {}, 30000));
    } catch (agentErr) {
      // Agent 端拉不到清单（离线/网络受限）时，用面板自己的网络兜底，保证页面可用
      try {
        res.json(await panelFetchVersions());
      } catch {
        next(agentErr);
      }
    }
  });

  // 手动触发：面板代下核心并推送安装（Agent 侧下载反复失败时的兜底入口）
  router.post('/servers/:id/instances/:name/panel-install', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!hub.isOnline(server.id)) return res.status(502).json({ error: 'Agent 未连接，无法面板代下' });
    // 常见错误同步校验、立即报给用户；下载+传输可能要几分钟，放后台执行，进度走 SSE 与控制台
    try {
      const list = await hub.request(server.id, 'instance.list', {}, 20000);
      const inst = (Array.isArray(list) ? list : []).find((x) => x && x.name === req.params.name);
      if (!inst) return res.status(404).json({ error: '实例不存在' });
      if ((inst.source || 'vanilla') === 'upload') {
        return res.status(400).json({ error: '上传型实例请在文件管理里直接上传 server.jar' });
      }
      if (inst.status === 'downloading') return res.status(409).json({ error: 'Agent 正在安装中，无需面板代下' });
    } catch (e) {
      return next(e);
    }
    runPanelInstall(server, req.params.name, { auto: false }).catch((e) => {
      console.error(`[panel-install] ${server.id}/${req.params.name} 面板代下失败: ${e.message}`);
    });
    res.json({ ok: true, started: true });
  });

  // 运行中实例的在线人数（Agent 端 SLP 并行查询）
  router.get('/servers/:id/players', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.players', {}, 15000));
    } catch (e) {
      next(e);
    }
  });

  // 核心目录：优先问 Agent（它和最终下载同一条网络），失败再由面板代拉
  router.get('/servers/:id/cores', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('core.catalogs', {}, 30000));
      return;
    } catch (agentErr) {
      try {
        const catalogs = await panelFetchCores();
        res.json({ kinds: CORE_KINDS_PANEL, catalogs, stale: true });
        return;
      } catch {
        next(agentErr);
      }
    }
  });

  router.post('/servers/:id/instances', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('instance.create', req.body || {}, 30000));
    } catch (e) {
      next(e);
    }
  });

  // 安装失败后重试（沿用实例记录的核心类型/版本/构建）
  router.post('/servers/:id/instances/:name/retry-install', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('instance.retry-install', { name: req.params.name }, 30000));
    } catch (e) {
      next(e);
    }
  });

  // 重装：清掉安装残留后重新装（可选换核心类型/版本/构建）
  router.post('/servers/:id/instances/:name/reinstall', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    try {
      res.json(
        await agent(server)(
          'instance.reinstall',
          {
            name: req.params.name,
            source: b.source,
            version: b.version,
            build: b.build,
            url: b.url,
          },
          30000,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  for (const [route, action] of [
    ['start', 'instance.start'],
    ['stop', 'instance.stop'],
    ['restart', 'instance.restart'],
  ]) {
    router.post(`/servers/:id/instances/:name/${route}`, async (req, res, next) => {
      const server = requireServer(req, res);
      if (!server) return;
      try {
        res.json(
          await agent(server)(action, { name: req.params.name, ...(req.body || {}) }, 60000)
        );
      } catch (e) {
        next(e);
      }
    });
  }

  router.post('/servers/:id/instances/:name/command', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)('instance.command', { name: req.params.name, cmd: String((req.body || {}).cmd || '') }, 15000)
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- Mod 管理：列表 / 启停（.disabled 约定）/ 删除，路径由 Agent 锁定在 mods 目录 ----------
  router.get('/servers/:id/instances/:name/mods', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.modsList', { name: req.params.name }));
    } catch (e) {
      next(e);
    }
  });

  for (const [route, action] of [
    ['mods/toggle', 'instance.modsToggle'],
    ['mods/delete', 'instance.modsDelete'],
  ]) {
    router.post(`/servers/:id/instances/:name/${route}`, async (req, res, next) => {
      const server = requireServer(req, res);
      if (!server) return;
      try {
        res.json(
          await agent(server)(action, { name: req.params.name, ...(req.body || {}) }, 30000),
        );
      } catch (e) {
        next(e);
      }
    });
  }

  // 域名连通检测：Agent 侧解析（含 _minecraft._tcp SRV）+ TCP 探测实例端口
  router.get('/servers/:id/instances/:name/domain-check', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.domainCheck', { name: req.params.name }));
    } catch (e) {
      next(e);
    }
  });

  router.get('/servers/:id/instances/:name/console', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agentRead(
          server,
          'instance.console',
          { name: req.params.name, tail: Math.min(Number(req.query.tail) || 200, 1000) },
          15000
        )
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- AI 日志分析（面板代调 OpenAI 兼容接口，流式回推） ----------
  // 日志取自 Agent 加密通道的最近若干行，不落盘；密钥明文保存在 data/config.json（见 README 安全注意事项）。
  // 满 500 行日志 ≈ 3 万字符，再叠加推理模型的思考时间，120s 会不够用
  const AI_TIMEOUT_MS = 300000;
  // Agent 环形缓冲上限就是 500 行，取再多也没有；字符上限要能装下满 500 行
  // （实测 458 行 ≈ 29k 字符），否则「取 500 行」会被字符截断悄悄砍回一半。
  const AI_MAX_LOG_CHARS = 48000;
  const AI_LOG_TAIL_DEFAULT = 500;
  const AI_LOG_TAIL_MAX = 500;
  const AI_SYSTEM_PROMPT = [
    '你是 Minecraft 服务器运维助手，负责分析服务器运行日志与报错日志。',
    '请只依据给出的日志内容作答，日志没有体现的信息不要臆测，直接说明「日志中未体现」。',
    '回答用中文，结构化输出：先一句结论，再列「原因」「影响」「处理建议」，必要时给出具体命令或配置改动。',
    '日志里可能出现插件名、异常堆栈、玩家名、IP；引用关键行时原样摘录，但不要复述完整 IP。',
  ].join('\n');

  function aiEndpoint(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
    return base + '/v1/chat/completions';
  }

  /** 由 chat 地址推出 /models 地址：剥掉 /chat/completions，补 /v1（已有版本号则沿用） */
  function aiModelsUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    const root = base.replace(/\/chat\/completions$/i, '');
    return /\/v\d+$/i.test(root) ? root + '/models' : root + '/v1/models';
  }

  /** 列出服务商可用模型（OpenAI 兼容的 GET /models） */
  function aiListModels({ url, apiKey, timeoutMs = 20000 }) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(url);
      } catch {
        return reject(new Error('AI 接口地址无效'));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('AI 接口地址需为 http(s)'));
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      const req = mod.get(
        u,
        { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': HTTP_UA } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new Error(`HTTP ${res.statusCode}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`));
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error('响应不是合法 JSON'));
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('查询超时')));
      req.on('error', reject);
    });
  }

  /**
   * 调用 OpenAI 兼容的 /chat/completions（stream: true），逐段回调 delta，
   * 结束时给出文本与用量统计：首字耗时 / 总耗时 / Token。
   */
  function aiChat({ endpoint, apiKey, model, messages, timeoutMs = 30000, signal, onDelta, maxTokens }) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(endpoint);
      } catch {
        return reject(new Error('AI 接口地址无效'));
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('AI 接口地址需为 http(s)'));
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      const body = { model, messages, stream: true, temperature: 0.2, stream_options: { include_usage: true } };
      if (maxTokens) body.max_tokens = maxTokens;
      const payload = JSON.stringify(body);

      const startedAt = Date.now();
      let firstTokenMs = null;
      let text = '';
      let reasoning = '';
      let usage = null;
      let respModel = model;

      const req = mod.request(
        u,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': HTTP_UA,
            Accept: 'text/event-stream',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const t = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
              reject(new Error(`AI 接口返回 HTTP ${res.statusCode}: ${t}`));
            });
            return;
          }
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const json = JSON.parse(data);
                if (json.model) respModel = json.model;
                // 开了 include_usage 后，最后一个分片只有 usage、choices 为空
                if (json.usage) usage = json.usage;
                const choice = json.choices && json.choices[0];
                const delta = choice && choice.delta;
                const piece = delta && (delta.content || delta.message);
                // 推理模型（如 glm-5.3-flash）把思考过程放在 reasoning_content，
                // 正文 content 可能整段为空——思考单独收集，正文为空时用它兜底
                const think = delta && delta.reasoning_content;
                if (think) reasoning += String(think);
                if (piece) {
                  if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
                  text += String(piece);
                  onDelta?.(String(piece));
                }
              } catch {
                // 单个分片解析失败不影响整体流
              }
            }
          });
          res.on('end', () => {
            const totalMs = Date.now() - startedAt;
            // 正文为空但拿到了思考过程（纯推理模型或 max_tokens 太小被截断）：用思考兜底，避免显示空白
            if (!text.trim() && reasoning.trim()) text = reasoning;
            resolve({
              text,
              reasoning: reasoning.trim() || undefined,
              model: respModel,
              usage,
              firstTokenMs: firstTokenMs === null ? totalMs : firstTokenMs,
              totalMs,
            });
          });
          res.on('error', reject);
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('AI 接口请求超时')));
      req.on('error', reject);
      if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
      req.end(payload);
    });
  }

  // 连接测试：设置页填完密钥后可先验证再启用。
  // 返回模型、状态、首字/总耗时、Token 用量，便于判断服务商与模型是否真的可用。
  router.post('/settings/ai-test', async (req, res) => {
    const st = config.data.settings;
    const b = req.body || {};
    const baseUrl = b.baseUrl !== undefined ? String(b.baseUrl).trim() : st.ai.baseUrl;
    const model = b.model !== undefined ? String(b.model).trim() : st.ai.model;
    // 允许前端传新密钥测试（不落盘）；否则用已保存的
    const apiKey = b.apiKey ? String(b.apiKey).trim() : st.ai.apiKey;
    const endpoint = aiEndpoint(baseUrl);
    if (!endpoint || !apiKey || !model) {
      return res.status(400).json({ error: '请先填写接口地址、密钥与模型' });
    }
    try {
      const r = await aiChat({
        endpoint,
        apiKey,
        model,
        messages: [{ role: 'user', content: '回复两个字：正常' }],
        timeoutMs: 60000,
        // 推理模型会先输出一大段思考，64 token 只够思考、正文被截断，故放宽
        maxTokens: 512,
      });
      res.json({
        ok: true,
        reply: r.text.slice(0, 200),
        model: r.model,
        status: 200,
        firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs,
        usage: r.usage
          ? {
              promptTokens: r.usage.prompt_tokens ?? null,
              completionTokens: r.usage.completion_tokens ?? null,
              totalTokens: r.usage.total_tokens ?? null,
            }
          : null,
      });
    } catch (e) {
      res.status(502).json({ error: '连接失败: ' + e.message });
    }
  });

  // 拉取服务商可用模型列表（GET /models），用于设置页模型下拉
  router.post('/settings/ai-models', async (req, res) => {
    const st = config.data.settings;
    const b = req.body || {};
    const baseUrl = b.baseUrl !== undefined ? String(b.baseUrl).trim() : st.ai.baseUrl;
    const apiKey = b.apiKey ? String(b.apiKey).trim() : st.ai.apiKey;
    const url = aiModelsUrl(baseUrl);
    if (!url || !apiKey) {
      return res.status(400).json({ error: '请先填写接口地址与密钥' });
    }
    try {
      const data = await aiListModels({ url, apiKey });
      const ids = (Array.isArray(data.data) ? data.data : [])
        .map((m) => (typeof m === 'string' ? m : m && m.id))
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim());
      // 去重后按「聊天模型优先、再字典序」排：列表里常混着 embedding / tts 等不可用模型
      const seen = new Set();
      const uniq = ids.filter((id) => !seen.has(id) && seen.add(id));
      uniq.sort((a, b2) => {
        const chat = (s) => (/embed|tts|whisper|moderation|rerank|image|dall/i.test(s) ? 1 : 0);
        return chat(a) - chat(b2) || a.localeCompare(b2);
      });
      res.json({ ok: true, models: uniq });
    } catch (e) {
      res.status(502).json({ error: '查询模型失败: ' + e.message });
    }
  });

  // 日志分析：SSE 流式返回（POST + text/event-stream，前端用 fetch reader 读取）
  router.post('/servers/:id/instances/:name/ai-analyze', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const st = config.data.settings;
    const ai = st.ai || {};
    if (!ai.enabled) return res.status(400).json({ error: 'AI 日志分析未启用，请先在面板设置中开启' });
    if (!ai.apiKey || !ai.model) return res.status(400).json({ error: '请先在面板设置中填写 AI 接口密钥与模型' });

    const b = req.body || {};
    const question = String(b.question || '').trim().slice(0, 2000);
    const history = Array.isArray(b.history)
      ? b.history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
          .slice(-8)
          .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 4000) }))
      : [];

    // 先取日志再开流：取不到就走普通 JSON 错误，前端能直接提示
    let logText = '';
    let logLines = 0;
    let logTruncated = false;
    let instStatus = '';
    try {
      const tail = Math.min(Math.max(Number(b.tail) || AI_LOG_TAIL_DEFAULT, 20), AI_LOG_TAIL_MAX);
      const c = await agentRead(server, 'instance.console', { name: req.params.name, tail }, 15000);
      const lines = Array.isArray(c && c.lines) ? c.lines : [];
      instStatus = (c && c.status) || '';
      logLines = lines.length;
      logText = lines.map((l) => l.text).join('\n');
      if (logText.length > AI_MAX_LOG_CHARS) {
        logText = logText.slice(logText.length - AI_MAX_LOG_CHARS);
        logText = '…（更早日志已截断）\n' + logText;
        logTruncated = true;
      }
    } catch (e) {
      return next(e);
    }
    if (!logText.trim()) {
      return res.status(400).json({ error: '当前没有可分析的日志（实例可能未运行过）' });
    }

    const messages = [
      { role: 'system', content: AI_SYSTEM_PROMPT },
      ...history,
      {
        role: 'user',
        content:
          `以下是实例「${req.params.name}」（服务器：${server.name}）的最近 ${logLines} 行控制台日志：\n` +
          '```log\n' + logText + '\n```\n\n' +
          (question ? `问题：${question}` : '请分析当前运行状态，重点指出报错/异常、可能原因与处理建议；若一切正常请明确说明。'),
      },
    ];

    const ac = new AbortController();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'meta', lines: logLines, status: instStatus, model: ai.model, truncated: logTruncated });
    res.on('close', () => ac.abort());

    try {
      const r = await aiChat({
        endpoint: aiEndpoint(ai.baseUrl),
        apiKey: ai.apiKey,
        model: ai.model,
        messages,
        timeoutMs: AI_TIMEOUT_MS,
        signal: ac.signal,
        onDelta: (text) => send({ type: 'delta', text }),
      });
      send({
        type: 'done',
        model: r.model,
        firstTokenMs: r.firstTokenMs,
        totalMs: r.totalMs,
        usage: r.usage
          ? {
              promptTokens: r.usage.prompt_tokens ?? null,
              completionTokens: r.usage.completion_tokens ?? null,
              totalTokens: r.usage.total_tokens ?? null,
            }
          : null,
      });
    } catch (e) {
      if (!ac.signal.aborted) send({ type: 'error', error: e.message });
    }
    try {
      res.end();
    } catch {}
  });

  router.delete('/servers/:id/instances/:name', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)(
          'instance.delete',
          { name: req.params.name, backupFirst: !!(req.body || {}).backupFirst, force: !!(req.body || {}).force },
          240000,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/setcore', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)('instance.setcore', { name: req.params.name, filename: (req.body || {}).filename }, 30000),
      );
    } catch (e) {
      next(e);
    }
  });

  // 编辑实例元信息（备注 / 连接地址 / 最大内存）
  router.put('/servers/:id/instances/:name', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    try {
      res.json(
        await agent(server)(
          'instance.edit',
          { name: req.params.name, note: b.note, address: b.address, memoryMB: b.memoryMB },
          15000,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  // 看门狗设置（崩溃自动重启 + 定时重启任务）
  router.put('/servers/:id/instances/:name/watchdog', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)(
          'instance.watchdog.set',
          { name: req.params.name, watchdog: req.body || {} },
          15000,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  // server.properties 可视化配置
  router.get('/servers/:id/instances/:name/properties', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.properties.get', { name: req.params.name }, 15000));
    } catch (e) {
      next(e);
    }
  });

  router.put('/servers/:id/instances/:name/properties', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)(
          'instance.properties.set',
          { name: req.params.name, content: (req.body || {}).content },
          20000,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- 实例备份（Agent 用系统 tar 打包到 .backups/<instance>/） ----------
  router.get('/servers/:id/instances/:name/backups', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'backup.list', { name: req.params.name }, 30000));
    } catch (e) {
      next(e);
    }
  });

  for (const [route, action] of [
    ['create', 'backup.create'],
    ['restore', 'backup.restore'],
    ['delete', 'backup.delete'],
  ]) {
    router.post(`/servers/:id/instances/:name/backups/${route}`, async (req, res, next) => {
      const server = requireServer(req, res);
      if (!server) return;
      try {
        res.json(await agent(server)(action, { name: req.params.name, file: (req.body || {}).file }, 60000));
      } catch (e) {
        next(e);
      }
    });
  }

  router.get('/servers/:id/instances/:name/backups/download', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const meta = await agent(server)(
        'backup.download.begin',
        { name: req.params.name, file: String(req.query.file || '') },
        30000,
      );
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.query.file)}`);
      if (meta.size) res.setHeader('Content-Length', String(meta.size));
      try {
        for (;;) {
          const chunk = await agent(server)('fs.download.chunk', { downloadId: meta.downloadId }, 60000);
          res.write(Buffer.from(chunk.dataB64, 'base64'));
          if (chunk.eof) break;
        }
      } finally {
        agent(server)('fs.download.finish', { downloadId: meta.downloadId }, 10000).catch(() => {});
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) next(e);
      else res.destroy();
    }
  });

  router.post('/servers/:id/java-install', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      // 走 agentRead：连接处于重连窗口时会自动等待，避免抖动导致误报 502
      const r = await agentRead(server, 'java.install', { major: (req.body || {}).major }, 30000);
      res.json(r);
      // 安装是后台任务，这里只是「已受理」。真正装完由 Agent 的 java.updated 事件通知，
      // 同时起轮询兜底把最新的 sys.info 落到缓存，卡片就能立刻显示新版本。
      if (r && r.started) scheduleJavaRefresh(server.id);
    } catch (e) {
      next(e);
    }
  });

  /**
   * Java 安装是异步的：面板只知道「已开始」，真正装完由 Agent 的 java.updated 事件通知。
   * 这里起一个轮询兜底——收到事件或在超时前拿到 installed 就停，
   * 避免事件丢失时卡片一直显示旧的「未安装」。
   */
  const javaRefreshing = new Set();
  function scheduleJavaRefresh(serverId) {
    if (javaRefreshing.has(serverId)) return;
    javaRefreshing.add(serverId);
    const deadline = Date.now() + 15 * 60 * 1000; // apt 装 JDK 可能很慢，给足 15 分钟
    const tick = async () => {
      try {
        const cur = config.getServer(serverId);
        if (!cur || !hub.isOnline(serverId)) return;
        const info = await hub.request(serverId, 'sys.info', {}, 15000);
        const java = info && info.java;
        if (java) {
          const prev = cur.info && cur.info.java;
          const changed =
            !prev ||
            prev.installed !== java.installed ||
            prev.major !== java.major ||
            prev.raw !== java.raw;
          if (changed) {
            config.updateServer(serverId, { info: { ...(cur.info || {}), ...info } });
            bus.emit('broadcast', { type: 'agent-event', serverId, event: 'java.updated', data: { done: true, ok: true, java } });
          }
          // 装好了就收工
          if (java.installed) return;
        }
      } catch {
        // Agent 忙/离线，继续等下一轮
      }
      if (Date.now() < deadline && javaRefreshing.has(serverId)) {
        setTimeout(tick, 15000);
      } else {
        javaRefreshing.delete(serverId);
      }
    };
    setTimeout(tick, 15000);
  }

  router.get('/servers/:id/info', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'sys.info', {}, 15000));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 文件管理（Agent 端已锁定在实例目录内） ----------
  const FILES_TIMEOUT = 30000;

  router.get('/servers/:id/instances/:name/files', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'fs.list', { name: req.params.name, path: req.query.path || '' }, FILES_TIMEOUT));
    } catch (e) {
      next(e);
    }
  });

  router.get('/servers/:id/instances/:name/files/content', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agentRead(
          server,
          'fs.read',
          { name: req.params.name, path: req.query.path || '', maxKB: Math.min(Number(req.query.maxKB) || 512, 2048) },
          FILES_TIMEOUT,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.put('/servers/:id/instances/:name/files/content', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)(
          'fs.write',
          { name: req.params.name, path: (req.body || {}).path, content: (req.body || {}).content },
          FILES_TIMEOUT,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/files/mkdir', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('fs.mkdir', { name: req.params.name, path: (req.body || {}).path }, FILES_TIMEOUT));
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/files/delete', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('fs.delete', { name: req.params.name, path: (req.body || {}).path }, FILES_TIMEOUT));
    } catch (e) {
      next(e);
    }
  });

  // 复制/移动/压缩/解压可能处理几百 MB 的存档，30s 的 FILES_TIMEOUT 不够用
  const FILES_ARCHIVE_TIMEOUT = 180000;

  for (const [route, action, keys] of [
    ['copy', 'fs.copy', ['from', 'to']],
    ['move', 'fs.move', ['from', 'to']],
  ]) {
    router.post(`/servers/:id/instances/:name/files/${route}`, async (req, res, next) => {
      const server = requireServer(req, res);
      if (!server) return;
      const b = req.body || {};
      try {
        res.json(
          await agent(server)(
            action,
            { name: req.params.name, from: b[keys[0]], to: b[keys[1]] },
            FILES_ARCHIVE_TIMEOUT,
          ),
        );
      } catch (e) {
        next(e);
      }
    });
  }

  router.post('/servers/:id/instances/:name/files/compress', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    try {
      res.json(
        await agent(server)('fs.compress', { name: req.params.name, paths: b.paths, out: b.out }, FILES_ARCHIVE_TIMEOUT),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/files/extract', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)('fs.extract', { name: req.params.name, path: (req.body || {}).path }, FILES_ARCHIVE_TIMEOUT),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/files/upload/begin', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    try {
      res.json(
        await agent(server)(
          'fs.upload.begin',
          {
            name: req.params.name,
            dir: b.dir,
            filename: b.filename,
            size: b.size,
            lastModified: b.lastModified,
            resume: !!b.resume,
          },
          FILES_TIMEOUT,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/files/upload/chunk', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    try {
      res.json(
        await agent(server)('fs.upload.chunk', { uploadId: b.uploadId, seq: b.seq, dataB64: b.dataB64, seekTo: b.seekTo }, 60000)
      );
    } catch (e) {
      next(e);
    }
  });

  for (const [route, action] of [
    ['finish', 'fs.upload.finish'],
    ['abort', 'fs.upload.abort'],
  ]) {
    router.post(`/servers/:id/instances/:name/files/upload/${route}`, async (req, res, next) => {
      const server = requireServer(req, res);
      if (!server) return;
      try {
        res.json(await agent(server)(action, { uploadId: (req.body || {}).uploadId }, FILES_TIMEOUT));
      } catch (e) {
        next(e);
      }
    });
  }

  // ---------- SFTP 直传：浏览器 → 面板 →（SSH/SFTP）→ 实例目录 ----------
  // 大文件（整合包/核心）跳过加密通道分块；用安装 Agent 时保存的 SSH 凭据。
  // 实例名/路径在面板侧同样做白名单与越界校验，远端只写入该实例目录内。
  const INST_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

  function sanitizeRelDir(dir) {
    const cleaned = String(dir || '').replace(/^\/+|\/+$/g, '');
    if (!cleaned) return '';
    const segs = cleaned.split('/');
    if (segs.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) {
      throw new Error('路径非法');
    }
    return segs.join('/');
  }

  function sanitizeFilename(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    if (!base || base === '.' || base === '..') throw new Error('文件名非法');
    return base;
  }

  router.post('/servers/:id/instances/:name/files/upload/sftp', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      if (!INST_NAME_RE.test(req.params.name)) throw new Error('实例名非法');
      if (!server.ssh || (!server.ssh.password && !server.ssh.key && !server.ssh.keyPath)) {
        throw new Error('该服务器未配置 SSH 凭据，无法使用 SFTP 直传');
      }
      const instancesDir = server.info && server.info.instancesDir;
      if (!instancesDir || !path.isAbsolute(instancesDir)) {
        throw new Error('实例目录未知或不是绝对路径（需 Agent 至少上线过一次），无法 SFTP 直传');
      }
      const dir = sanitizeRelDir(req.query.dir);
      const filename = sanitizeFilename(req.query.filename);
      const remotePath = [instancesDir.replace(/\/+$/, ''), req.params.name, dir, filename]
        .filter(Boolean)
        .join('/');
      const size = await sftpUploadStream(server, remotePath, req);
      res.json({ ok: true, size, via: 'sftp' });
    } catch (e) {
      if (!res.headersSent) next(e);
      else res.destroy();
    }
  });

  // 下载：面板从 Agent 分块拉取，流式回给浏览器
  router.get('/servers/:id/instances/:name/files/download', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const rel = String(req.query.path || '');
    try {
      const meta = await agent(server)('fs.download.begin', { name: req.params.name, path: rel }, FILES_TIMEOUT);
      const filename = rel.split('/').pop() || 'download.bin';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      if (meta.size) res.setHeader('Content-Length', String(meta.size));
      try {
        for (;;) {
          const chunk = await agent(server)('fs.download.chunk', { downloadId: meta.downloadId }, 60000);
          res.write(Buffer.from(chunk.dataB64, 'base64'));
          if (chunk.eof) break;
        }
      } finally {
        agent(server)('fs.download.finish', { downloadId: meta.downloadId }, 10000).catch(() => {});
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) next(e);
      else res.destroy();
    }
  });

  // ---------- SSH 卸载 Agent（含递归删除实例与备份） ----------
  router.post('/servers/:id/uninstall', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (installing.has(server.id)) return res.status(409).json({ error: '该服务器正在执行安装/卸载任务' });
    installing.add(server.id);
    res.json({ ok: true, started: true });

    const b = req.body || {};
    const isLocal = localAgent.isLocalHost(server.host);
    // 新一轮卸载：清掉上一批日志
    taskLogReset(server.id, 'uninstall');
    const log = (text) => taskLog(server.id, 'uninstall', text);

    try {
      // 1) Agent 在线时先优雅收尾：停实例 + 可选打包备份
      if (hub.isOnline(server.id)) {
        log('通知 Agent 停止实例并准备卸载…\n');
        const prep = await hub.request(
          server.id,
          'agent.prepareUninstall',
          // 本机不打包 tar.gz（Windows 无 tar 时也能跑版除外，且实例目录用户自己可直接查看）
          { keepBackups: !!b.keepBackups && !isLocal },
          180000,
        );
        if (prep.stopped && prep.stopped.length) log(`已停止实例：${prep.stopped.join('、')}\n`);
        else log('没有运行中的实例\n');
        if (prep.backupFile) log(`备份已打包到：${prep.backupFile}\n`);
      } else {
        log('Agent 当前离线，跳过优雅收尾（运行中的实例会随进程一并结束）\n');
      }

      // 2) 停服务并清理：本机由面板直接管进程，远程走 SSH/systemd（递归删安装目录）
      if (isLocal) {
        await localAgent.uninstallAgent(server, log, {
          keepBackups: !!b.keepBackups,
          deleteDir: !!b.deleteInstances,
        });
      } else {
        await uninstallAgent(server, log);
      }

      // 3) 可选：同时从面板移除该服务器
      if (b.removeServer) {
        config.removeServer(server.id);
        log('已从面板移除该服务器\n');
      }
      // 卸载成功：清掉面板缓存的系统信息（Agent 已不存在）
      config.updateServer(server.id, { status: 'offline', info: null });
      taskLogDone(server.id, 'uninstall', { done: true, ok: true });
    } catch (e) {
      log('✗ 卸载失败: ' + e.message + '\n');
      taskLogDone(server.id, 'uninstall', { done: true, ok: false, error: e.message });
    } finally {
      installing.delete(server.id);
      config.updateServer(server.id, { installing: false });
    }
  });

  // ---------- 本机 Agent 进程控制（不走 SSH，面板直管） ----------

  /**
   * 拉取最近一次任务的日志，供页面刷新 / 新开标签页后重放。
   * kind: install（安装、本机启动） | uninstall（卸载、本机停止）
   * 顺带回 installing 标记，前端据此判断任务是否仍在进行。
   */
  router.get('/servers/:id/task-log', (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const kind = req.query.kind === 'uninstall' ? 'uninstall' : 'install';
    const s = taskLogGet(server.id, kind);
    res.json({
      lines: s ? s.lines : '',
      done: s ? s.done : null,
      running: installing.has(server.id),
      updatedAt: s ? s.updatedAt : null,
    });
  });

  router.post('/servers/:id/local-agent/start', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!localAgent.isLocalHost(server.host)) {
      return res.status(400).json({ error: '该服务器不是本机服务器' });
    }
    if (installing.has(server.id)) return res.status(409).json({ error: '该服务器正在执行安装/卸载任务' });
    installing.add(server.id);
    config.updateServer(server.id, { installing: true });
    res.json({ ok: true, started: true });
    // 本机启停也算一轮任务日志，同样支持刷新后重放
    taskLogReset(server.id, 'install');
    const log = (text) => taskLog(server.id, 'install', text);
    try {
      await localAgent.installAgent(server, log);
      hub.stopOutbound(server.id);
      hub.syncOutbound();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !hub.isOnline(server.id)) {
        await new Promise((r) => setTimeout(r, 500));
      }
      taskLogDone(server.id, 'install', { done: true, ok: hub.isOnline(server.id) });
    } catch (e) {
      log('✗ 启动失败: ' + e.message + '\n');
      taskLogDone(server.id, 'install', { done: true, ok: false, error: e.message });
    } finally {
      installing.delete(server.id);
      config.updateServer(server.id, { installing: false });
    }
  });

  router.post('/servers/:id/local-agent/stop', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!localAgent.isLocalHost(server.host)) {
      return res.status(400).json({ error: '该服务器不是本机服务器' });
    }
    if (installing.has(server.id)) return res.status(409).json({ error: '该服务器正在执行安装/卸载任务' });
    installing.add(server.id);
    res.json({ ok: true, started: true });
    taskLogReset(server.id, 'uninstall');
    const log = (text) => taskLog(server.id, 'uninstall', text);
    try {
      log('停止本机 Agent（保留实例数据）…\n');
      await localAgent.stopAgent(server, log, { agentRequest: hub.request.bind(hub) });
      config.updateServer(server.id, { status: 'offline' });
      taskLogDone(server.id, 'uninstall', { done: true, ok: true });
    } catch (e) {
      log('✗ 停止失败: ' + e.message + '\n');
      taskLogDone(server.id, 'uninstall', { done: true, ok: false, error: e.message });
    } finally {
      installing.delete(server.id);
      config.updateServer(server.id, { installing: false });
    }
  });

  // ---------- agent.js 匿名下载（手动安装用，文件不含密钥） ----------
  router.get('/agent.js', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'agent', 'agent.js'));
  });

  // ---------- SSE ----------
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"hello"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---------- 错误处理 ----------
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const code = err.code === 'AGENT_OFFLINE' ? 502 : err.code === 'AGENT_TIMEOUT' ? 504 : 500;
    res.status(err.status || code).json({ error: err.message });
  });

  return router;
}

module.exports = { createApi };
