'use strict';
// 面板 REST API：供 Web UI 调用，内部经 AgentHub 加密转发到远程 Agent。
// 实时事件通过 /api/events (SSE) 推送：status / agent-event(console 等) / install。

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { installAgent, updateAgentScript, uninstallAgent, sftpUploadStream } = require('./ssh');
const localAgent = require('./localagent');
// 「快速添加」的默认值推导（内存/端口/实例名/版本）——纯函数，可单测
const quick = require('./quick');
// 网络助手：DDNS（纯逻辑 + 注入 fetch）与 frp 客户端托管
const ddns = require('./ddns');
const frp = require('./frp');
const mailTpl = require('./mail');
const { errorResponse, langOf, messageOf } = require('./error-codes');
// 自更新的纯逻辑（安装形态/元数据解析/升级计划/自动策略/写入白名单）与版本比较
// 都收在 panel/update.js：这一层必须能被单测覆盖，且不允许在 api.js 里再长出一份
// 版本比较的副本（历史坑：两套 semver 判断迟早对不上）。
const upd = require('./update');
const migrate = require('./migrate');
const { semverGreater } = upd;

const COOKIE = 'blocknexussid';const SESSION_TTL = 7 * 24 * 3600 * 1000;
// 勾选「记住我」：Cookie 与会话有效期都放宽到 30 天（滑动续期），关浏览器仍保持登录
const REMEMBER_TTL = 30 * 24 * 3600 * 1000;

// ---------- 测试钩子 ----------
// 限流表的容量上限、Cookie 的 Secure 标志这类行为，只能从实例内部观察。
// 为了不为了「可测」而对外暴露生产接口，这里放一个一次性投递箱：
// 只有测试显式注册过的实例才会写钩子，生产进程里恒为 null、无任何副作用。
let pendingTestHook = null;

/** 仅供测试：让「下一个」createApi 实例把内部状态交给 hook。生产代码不要调用。 */
function __setTestHook(hook) {
  pendingTestHook = hook;
}

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

// frp 管理器注册表：面板退出时统一停掉 frpc（只注册一个 exit 钩子）。
// 不放在 createApi 里逐实例注册：测试会反复 createApi，监听器会累积到警告。
const frpManagers = new Set();
process.once('exit', () => {
  for (const mgr of frpManagers) {
    try {
      mgr.stopSync();
    } catch {}
  }
});

// 最新版本检查：GitHub Releases（缓存 10 分钟；?refresh=1 跳过缓存）
const REPO_URL = 'https://github.com/live-ling/BlockNexus';
const LATEST_RELEASE_API = 'https://api.github.com/repos/live-ling/BlockNexus/releases/latest';
const VERSION_CACHE_MS = 10 * 60e3;
let versionCache = { at: 0, data: null };

/** 三段版本号比较：a 是否大于 b（忽略 v 前缀与后缀）——实现已上移到 panel/update.js */

/**
 * 检查更新；失败时保留旧缓存并在结果里带 error 字段。force=true 跳过缓存（?refresh=1）
 *
 * 自更新需要的额外信息也在这里取（**同一份缓存**，不额外打 GitHub API）：
 *   · assets：Release 的资产列表（挑 app/portable 包与 SHA256SUMS.txt）
 *   · meta：update.json（推荐等级、跨版本、迁移声明）——它决定"该不该升、怎么升"
 */
async function checkLatestRelease(version, force = false) {
  const fresh = Date.now() - versionCache.at < VERSION_CACHE_MS;
  if (!force && versionCache.data && fresh) return { ...versionCache.data, cached: true };
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
    const assets = Array.isArray(j.assets)
      ? j.assets.slice(0, 40).map((a) => ({
          name: String(a.name || ''),
          size: Number(a.size) || 0,
          browser_download_url: String(a.browser_download_url || ''),
        }))
      : [];
    // update.json：机器可读的发布元数据（可能没有——老 Release 都没有，按安全默认处理）
    let meta = { ...upd.META_DEFAULTS };
    let metaMissing = true;
    const metaAsset = upd.pickAsset(assets, upd.ASSET.meta);
    if (metaAsset) {
      try {
        const text = await fetchRemoteText(metaAsset.url, 128 * 1024, `BlockNexus/${version}`);
        const parsed = upd.parseUpdateMeta(text);
        meta = parsed.meta;
        metaMissing = parsed.missing || !parsed.ok;
      } catch {
        // 取不到就按"未声明"处理：不拦更新，但必须人工确认（安全默认）
      }
    }
    const data = {
      latest: tag || null,
      hasUpdate: !!tag && semverGreater(tag, version),
      releaseUrl: j.html_url || null,
      changelog: String(j.body || ''),
      checkedAt: Date.now(),
      assets,
      meta,
      metaMissing,
    };
    versionCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (versionCache.data) return { ...versionCache.data, cached: true, error: e.message || '检查失败' };
    return {
      latest: null,
      hasUpdate: false,
      releaseUrl: null,
      changelog: '',
      checkedAt: Date.now(),
      assets: [],
      meta: { ...upd.META_DEFAULTS },
      metaMissing: true,
      error: e.message || '检查失败',
    };
  }
}

/** 取远端小文本（update.json / SHA256SUMS.txt）；带上限，避免异常端点撑爆内存 */
function fetchRemoteText(url, maxBytes, ua) {
  return new Promise((resolve, reject) => {
    const u = String(url);
    const mod = u.startsWith('https') ? require('https') : require('http');
    const req = mod.get(u, { headers: { 'User-Agent': ua || 'BlockNexus', Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchRemoteText(new URL(res.headers.location, u).toString(), maxBytes, ua).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      readBodyCapped(res, req, maxBytes, '更新元数据').then((buf) => resolve(buf.toString('utf8')), reject);
    });
    req.on('error', (e) => reject(new Error(e.message || '网络错误')));
    req.setTimeout(10000, () => req.destroy(new Error('超时')));
  });
}

// langOf（从 Accept-Language 判断用哪种语言渲染 error 文案）已移到 panel/error-codes.js：
// 它和错误文案本地化是同一件事，且 http-errors.js 的 app 级兜底中间件要用同一规则
// ——放在两处迟早会出现「错误码按 A 规则判语言、兜底中间件按 B 规则判」。

/** 出站响应体上限：这些响应来自**用户可配置的地址**（AI baseUrl / 核心下载 / 更新检查），属不可信输入 */
const MAX_REMOTE_BODY = 2 * 1024 * 1024;

/**
 * 读取响应体并**限制上限**。
 *
 * 为什么必须有上限：原先各处都是 `res.on('data', c => chunks.push(c))`，没有任何限制。
 * 一个恶意/异常的端点返回超大响应就能把面板堆打爆（面板内存目标是 240MB，
 * 一个几 GB 的 body 足以 OOM）。这类响应完全由远端控制，不能信任。
 *
 * 超限时立刻销毁请求并 reject —— 不继续读、不继续累积。
 * 注意 Error 只读**已读到的长度**，不会把内容带进错误信息（避免日志里出现大量远端内容）。
 */
function readBodyCapped(res, req, maxBytes = MAX_REMOTE_BODY, label = '响应') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      if (err) {
        try {
          req.destroy();
        } catch {}
        reject(err);
        return;
      }
      resolve(buf);
    };
    res.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) {
        done(new Error(`${label}过大（超过 ${Math.round(maxBytes / 1048576)}MB），已中断`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => done(null, Buffer.concat(chunks)));
    res.on('error', (e) => done(e));
  });
}

/**
 * SSRF 防护：拒绝明显不该作为「AI 接口地址 / 下载地址」的目标。
 *
 * 为什么**只挡链路本地与云元数据**，而不挡回环/私网：
 *   · 本地面板最常见的 AI 配置就是**本机跑的 Ollama / LM Studio**（127.0.0.1:11434）
 *     或局域网内的推理机；一刀切挡掉回环/私网会直接废掉这些正当用法。
 *   · 而 169.254.169.254（AWS/GCP/Azure 实例元数据）与 fe80::/10 没有任何正当的
 *     AI / 下载用途，却是 SSRF 最典型的变现目标（窃取实例凭据）——挡它零代价。
 *
 * ⚠ 两点必须说清，别把它当成完整的 SSRF 防护：
 *   1) 这里只查**字面**主机名，不查 DNS 解析结果。攻击者用「自己域名解析到
 *      169.254.169.254」仍可绕过。要堵死必须解析后再查，且要防重绑定（解析与
 *      实际连接用同一 IP），成本明显更高——本项目的场景下不值当。
 *   2) 真正的放大器是「面板默认不开鉴权 + 反代暴露」（审计 H5）。开了鉴权时，
 *      能改 baseUrl 的人本来就已经有面板的完整权限（含以 root 读写服务器文件）。
 */
function assertRemoteTargetAllowed(u) {
  const host = String((u && u.hostname) || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!host) throw new Error('地址缺少主机名');

  // IPv4 字面量：169.254.0.0/16 = 链路本地（含云元数据 169.254.169.254）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 169 && b === 254) throw new Error('不允许访问链路本地地址（云元数据）');
    return;
  }
  // IPv6：fe80::/10 链路本地；fd00:ec2::254 是 AWS 的元数据地址
  if (/^fe[89ab][0-9a-f]:/.test(host)) throw new Error('不允许访问链路本地地址');
  if (host === 'fd00:ec2::254') throw new Error('不允许访问云元数据地址');

  // 常见元数据主机名（字面匹配；DNS 绕过见上方说明）
  const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog', 'instance-data'];
  if (METADATA_HOSTS.includes(host)) throw new Error('不允许访问云元数据地址');
}

function createApi(config, hub, bus, limiterOpts = {}, opts = {}) {
  const router = express.Router();
  const sessions = new Map(); // sid -> expires
  const sseClients = new Set();
  const installing = new Set(); // serverId 防并发安装

  // Cookie 的 Secure 标志：TLS 直连、或显式声明强制加时开启。
  // 请求本身是否加密（req.secure）在 cookieAttrs 里另外判定——面板可能同时通过
  // http://127.0.0.1 与 https://反代域名 访问，按请求判定才能两边都正确。
  const FORCE_SECURE_COOKIE = opts.secureCookies === true;

  // 错误响应统一出口：文案来自 panel/error-codes.js，后端只给 code + 参数。
  // 过渡期同时回 `error`（按请求语言渲染好的文案）与 `code`，因此旧前端缓存照常显示。
  function fail(res, code, params, statusOverride) {
    const { status, body } = errorResponse(code, params, {
      status: statusOverride,
      lang: langOf(res.req),
    });
    return res.status(status).json(body);
  }

  /**
   * 校验主机名 / IP。用于 SSH 安装流程里把 `server.host` 拼进远端 `sh -c` 命令前，
   * 防止审计 R4 报告指出的 openssl -subj 引号嵌套命令注入。
   *
   * 判定标准：
   *  · IPv4（4 段 0–255）
   *  · IPv6（带可选的方括号）
   *  · RFC 1123 主机名（字母/数字/连字符/点，单段 ≤ 63，整体 ≤ 253）
   *
   * 注意：这是 admin 自配置服务器字段，不接受未认证调用。但 admin 也可能写错——
   * 允许任何字符就会让 `openssl req -subj "/CN=${cn}"` 的双引号被破出。
   * 「server.host 拼进远端命令」是 ssh.js 的具体场景，本校验放 api 层做集中入口拦截，
   * ssh.js 那侧再独立加一道引号转义作纵深。
   */
  const HOSTNAME_LABEL_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  function isValidHost(h) {
    if (typeof h !== 'string') return false;
    const v = h.trim();
    if (!v || v.length > 253) return false;
    // IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
      return v.split('.').every((o) => {
        const n = Number(o);
        return n >= 0 && n <= 255 && String(n) === String(Number(o));
      });
    }
    // IPv6（带或不带方括号——浏览器不会给服务器套括号，但保守放过）
    if (/^(\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+)$/.test(v) && v.includes(':')) return true;
    // 主机名（RFC 1123）
    if (v.endsWith('.')) return false; // 拒绝尾点，避免与 FQDN 写法歧义
    return v.split('.').every((l) => HOSTNAME_LABEL_RE.test(l));
  }

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

  // 离线通知降噪。要同时挡住两类噪音，缺一都会刷屏：
  //   ① 抖动（掉线几秒又连上）——用「观察期」滤掉：掉线先记下时刻，持续
  //      OFFLINE_GRACE 未恢复才算真故障，此时才发信。短暂中断完全不惊动用户。
  //   ② 长期离线期间反复触发——用「一次一封 + 定时补发」兜住：
  //      同一次故障只发一封，之后每 OFFLINE_REMIND 补发一封提醒（避免彻底沉寂），
  //      补发由定时器主动发起，不依赖下一次 offline 事件（outbound 重连失败
  //      根本不会触发 offline 事件，那样提醒永远不会到）。
  // 恢复邮件只在「本次故障确实发过离线邮件」后才发，且受最小间隔约束。
  const OFFLINE_GRACE = 2 * 60e3; // 掉线观察期：持续这么久才算故障
  const OFFLINE_MIN_GAP = 10 * 60e3; // 两封离线邮件之间的最小间隔（抖动兜底）
  const OFFLINE_REMIND = 24 * 60 * 60e3; // 长期离线的补发间隔
  /** serverId -> { since, at, notified, timer }：since=本次掉线起点，at=上次发信时刻，notified=本次故障是否已发过 */
  const offlineNotified = new Map();

  // 主动卸载后的静默窗口：用户刚把 Agent 卸掉，两分钟后再收到一封「服务器离线」纯属噪音。
  // 期间收到 offline 状态一律不排队通知；服务器重新上线（重装 / 手动拉起）时清掉。
  const UNINSTALL_QUIET_MS = 10 * 60e3;
  const uninstalledAt = new Map();

  /** 清掉某台服务器的离线跟踪与待发定时器（服务器被移除 / 恢复上线时调用） */
  function clearOfflineTracking(serverId) {
    const rec = offlineNotified.get(serverId);
    if (rec && rec.timer) clearTimeout(rec.timer);
    offlineNotified.delete(serverId);
  }

  function maybeNotifyStatus(serverId, status) {
    const st = config.data.settings;
    if (!st.adminEmail || !smtpConfigured()) return;

    if (status === 'offline') {
      // 刚被主动卸载：这不是故障，别发离线通知（重装后上线会清掉静默窗口）
      if (Date.now() - (uninstalledAt.get(serverId) || 0) < UNINSTALL_QUIET_MS) {
        clearOfflineTracking(serverId);
        return;
      }
      if (!st.notify.offline) return;
      // 已在跟踪本次掉线（重复 offline 事件，或已发过信正在等补发）：不动 since，保持计时连续
      if (offlineNotified.has(serverId)) return;
      // 观察期到了若仍处于离线，才判定为故障并发信
      const timer = setTimeout(() => {
        const cur = offlineNotified.get(serverId);
        if (cur) void sendOfflineMail(serverId, cur);
      }, OFFLINE_GRACE);
      // 不挡进程退出：这只是提醒，退出时丢掉即可
      if (timer.unref) timer.unref();
      offlineNotified.set(serverId, { since: Date.now(), at: 0, notified: false, timer });
      return;
    }

    if (status === 'online') {
      uninstalledAt.delete(serverId); // 重新上线 → 之后的掉线恢复为正常通知
      const rec = offlineNotified.get(serverId);
      if (!rec) return;
      // 抖动：观察期内就恢复了 → 本次不算故障，静默收尾（不发离线信也不发恢复信）
      clearOfflineTracking(serverId);
      // 只有本次故障确实发过离线信才通知恢复——否则用户会收到孤零零一封「已恢复」，
      // 而他从没被告知这台服务器掉过线。
      // 不用额外的冷却：观察期 + 每次故障只发一封，已经把抖动的上限压到「每 2 分钟最多一次」。
      if (!rec.notified || !st.notify.recovery) return;
      const server = config.getServer(serverId);
      const name = server ? server.name : serverId;
      const time = new Date().toLocaleString('zh-CN', { hour12: false });
      sendMail(st.adminEmail, `[BlockNexus] 服务器已恢复：${name}`, mailTpl.recoveryMail({ name, time })).catch(
        (e) => console.error('[notify] 恢复邮件发送失败:', e.message),
      );
    }
  }

  /**
   * 发离线邮件，并排下一次补发。失败会退回「未通知」，让下一轮补发重试。
   *
   * 两道闸，各自管一件事（混在一起就会漏）：
   *   · 最小间隔 OFFLINE_MIN_GAP——任意两封离线信之间至少隔这么久（全局速率上限）；
   *   · 补发节奏 OFFLINE_REMIND——已发过信后，只有过了 24 小时才补发。
   *
   * @param {boolean} viaReminder 是否由补发定时器发起（决定要不要过 24 小时这一关）
   */
  async function sendOfflineMail(serverId, rec, viaReminder = false) {
    const st = config.data.settings;
    const server = config.getServer(serverId);
    if (!server) {
      clearOfflineTracking(serverId); // 服务器已被移除，停止跟踪
      return;
    }
    // 补发定时器之外，唯一的调用者是「观察期到了」这一条路径；把节奏判定也放在这里，
    // 是为了将来若有人从别处（如状态轮询）调用，也不会退化成每次都发。
    if (viaReminder && rec.notified && Date.now() - rec.at < OFFLINE_REMIND) return;
    // 任意两封之间的最小间隔（rec.at 为上次实际发信时刻；从未发过时为 0）
    if (rec.at && Date.now() - rec.at < OFFLINE_MIN_GAP) return;

    const name = server.name;
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const since = new Date(rec.since).toLocaleString('zh-CN', { hour12: false });
    rec.notified = true; // 先置位，挡住并发路径重发
    try {
      await sendMail(
        st.adminEmail,
        `[BlockNexus] 服务器离线：${name}`,
        mailTpl.offlineMail({ name, host: server.host || '?', time, since }),
      );
      rec.at = Date.now();
    } catch (e) {
      // 发信失败就退回「未通知」：下一轮补发还能重试，否则这一封就永远丢了
      rec.notified = false;
      console.error('[notify] 离线邮件发送失败:', e.message);
    }
    scheduleOfflineRemind(serverId);
  }

  /** 排下一次补发。成功发出后隔 OFFLINE_REMIND 提醒，失败则隔较短的间隔重试。 */
  function scheduleOfflineRemind(serverId) {
    const rec = offlineNotified.get(serverId);
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    // 发信失败时（notified 被退回 false）不该让用户干等 24 小时才补上这一封，
    // 所以用较短的最小间隔重试；成功发出后才是 24 小时一次的提醒节奏。
    const wait = rec.notified ? OFFLINE_REMIND : OFFLINE_MIN_GAP;
    const timer = setTimeout(() => {
      const cur = offlineNotified.get(serverId);
      if (cur) void sendOfflineMail(serverId, cur, true);
    }, wait);
    if (timer.unref) timer.unref();
    rec.timer = timer;
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

  // 会话 Cookie 的附加属性。Secure 的判定：
  //   FORCE_SECURE_COOKIE（TLS 直连或 --secure-cookies 显式开启）→ 一定加；
  //   否则看这次请求本身是否加密（反代下依赖 trust proxy 正确配置）。
  // 为什么不只用全局开关：面板可能同时经由 http://127.0.0.1 和 https://反代域名 访问，
  // 全局判定会让其中一边漏掉 Secure——正是本次要修的洞。
  function cookieAttrs(req) {
    return FORCE_SECURE_COOKIE || (req && req.secure) ? '; Secure' : '';
  }

  // 写请求的 CSRF 纵深防御：带 body 的写请求只接受 JSON 或表单编码。
  // ⚠ 真正的防线是 SameSite=Lax Cookie + 全库无 CORS 中间件，本检查是第二层，不是主防线。
  // 跨域 HTML 表单只能发出 CORS 安全列表内的 Content-Type；PUT/PATCH/DELETE 与
  // application/json 都会触发预检，因此在浏览器里无法被跨站表单伪造。
  // ⚠ `multipart/form-data` 已**从白名单中移除**（R1/R2/R5 三份报告均指出）：
  //   浏览器允许跨站表单以 multipart/form-data 提交且**不触发预检**，于是它能绕过
  //   JSON / urlencoded 触发的预检防线。本仓库目前只有 SFTP 直传一个 multipart
  //   端点，且已用路径白名单单独放行（见下方 if 分支），所以可以安全移除。
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const CSRF_SAFE_TYPES = ['application/json', 'application/x-www-form-urlencoded'];

  /**
   * 请求是否带 body。用 content-length / transfer-encoding 判定，不依赖 Content-Type。
   * 为什么必须区分「无 body」：前端只在有 body 时才设 Content-Type
   * （web/src/lib/api.ts:571），而 DELETE /servers/:id 是无 body 的
   * （web/src/pages/server-settings.tsx:503）——若不放行无 body 请求，
   * 「删除服务器」会立刻 415 失败。
   */
  function hasRequestBody(req) {
    if (req.headers['transfer-encoding'] !== undefined) return true; // 分块传输
    return Number(req.headers['content-length'] || 0) > 0;
  }

  router.use((req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    if (!hasRequestBody(req)) return next(); // 无 body 无可伪造载荷
    if (!CSRF_SAFE_TYPES.some((t) => req.is(t))) {
      // 例外：SFTP 直传走二进制流，同样无法被跨域表单伪造
      if (req.path.endsWith('/files/upload/sftp')) return next();
      return fail(res, 'request.json-required');
    }
    next();
  });

  // 公开接口：登录 / 登出 / 面板信息
  // 登录限流：同一来源连续失败 5 次锁定 5 分钟，缓解爆破
  const LOGIN_MAX_FAILS = Number(limiterOpts.maxFails) || 5;
  const LOGIN_LOCK_MS = Number(limiterOpts.lockMs) || 5 * 60 * 1000;
  // 限流记录上限：这些表都按来源 IP 建键，公网暴露时可被外部驱动无限增长。
  // 表满时淘汰最早的记录而非拒绝请求——拒绝等于顺手做出拒绝服务。
  //
  // ⚠ 只靠下面 60s 的周期 GC 不够：GC 决定的是记录**存活时间**（发码记录约 1 小时），
  //    而在存活窗口内增长**速率**不受任何全局约束——每 IP 的配额是按桶分的，
  //    桶的数量由攻击者控制（换 IP / 反代下换 XFF 值）。
  //    所以每张表都必须另有**数量**上限。
  const LIMITER_MAX_TRACKED = Number(limiterOpts.maxTracked) || 10000;
  // loginFails 的上限名对外暴露（/api/limits 会返回它），保持不变
  const LOGIN_MAX_TRACKED = LIMITER_MAX_TRACKED;
  // sessions 表的容量上限：单用户面板正常情况不会到这儿，留点余量。
  // 真到上限时按插入顺序淘汰最旧的（与限流表「表满淘汰最旧」同思路——
  // 拒绝新会话等于顺手做出 DoS）。
  const MAX_SESSIONS = 256;
  const loginFails = new Map(); // ip -> { count, until, at }

  /** loginFails 记录是否已无用（周期 GC 与上限裁剪**共用**同一谓词，避免两处判定漂移） */
  const loginStale = (r, now) => (r.until || 0) <= now && now >= (r.at || 0) + LOGIN_LOCK_MS;

  /**
   * 给「按来源建键」的限流表兜一个**数量**上限。
   * 表满时先清过期项，仍满则淘汰最早一条（Map 保持插入序）。
   *
   * 抽成函数而不是在每处复制：三张表（loginFails / forgotSent / verifyFails）
   * 是同一个失效模式，复制三遍迟早会有一处漏改。
   *
   * @param isStale 该记录是否已无用；必须与周期 GC 用同一个谓词，
   *                否则会出现「GC 认为该留、上限认为该删」的不一致。
   */
  function capTracked(map, max, now, isStale) {
    if (map.size < max) return;
    for (const [k, r] of [...map]) if (isStale(r, now)) map.delete(k);
    while (map.size >= max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * 清掉锁定期已过、且久未再尝试的记录。
   * 判定用「最后一次尝试时刻 + 锁定窗口」而不是「现在距最后一次尝试」——
   * 后者要等到锁定结束后再等满一个窗口才清，等于最多留 2×LOCK_MS。
   * 锁定窗口是从触发锁定的那一刻起算的，所以 at + LOCK_MS 之后记录即无用。
   */
  function pruneLoginFails(now) {
    for (const [ip, r] of loginFails) {
      if (loginStale(r, now)) loginFails.delete(ip);
    }
  }

  router.post('/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rec = loginFails.get(ip);
    if (rec && rec.until > Date.now()) {
      const wait = Math.ceil((rec.until - Date.now()) / 1000);
      return fail(res, 'auth.too-many-attempts', { seconds: wait });
    }
    const { username, password, remember } = req.body || {};
    if (!config.verifyCredentials(username, password)) {
      const count = (rec && rec.until === 0 ? rec.count : 0) + 1;
      const now = Date.now();
      // 表满且是新 IP 时先腾位置（已有记录不裁剪，避免把自己刚累计的次数挤掉）
      if (!loginFails.has(ip)) capTracked(loginFails, LIMITER_MAX_TRACKED, now, loginStale);
      loginFails.set(ip, {
        count,
        until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0,
        at: now, // 供 GC 判断「最后一次尝试」的时间
      });
      if (count >= LOGIN_MAX_FAILS) {
        return fail(res, 'auth.login-locked', { minutes: Math.round(LOGIN_LOCK_MS / 60000) });
      }
      const left = LOGIN_MAX_FAILS - count;
      // 只在快用完时提示剩余次数（沿用既有行为，避免每次失败都暴露计数）
      return left <= 2
        ? fail(res, 'auth.bad-credentials-with-left', { left })
        : fail(res, 'auth.bad-credentials');
    }
    loginFails.delete(ip);
    const sid = crypto.randomBytes(24).toString('hex');
    // 「记住我」勾选 → 30 天有效期 + 持久 Cookie（关浏览器保持登录）；
    // 未勾选 → 7 天滑动有效期 + 会话 Cookie（关浏览器即失效，需重新登录）
    const rememberOn = remember !== false;
    const ttl = rememberOn ? REMEMBER_TTL : SESSION_TTL;
    sessions.set(sid, { exp: Date.now() + ttl, remember: rememberOn });
    // 容量上限：sessions 是按会话增长的表，与 loginFails/forgotSent 同样是「会话级」键空间。
    // 单用户面板没有这么多会话，但理论上伪造会话 cookie 可以堆大小，所以仍然设上限。
    // 与限流表不同——这里没有「过期判定」，GC 周期 60s 内的新会话无法依赖过期回收——
    // 所以**只按插入顺序淘汰**最旧的；GC 周期会补一刀把过期残留清掉。
    capTracked(sessions, MAX_SESSIONS, Date.now(), () => false);
    const maxAge = rememberOn ? `; Max-Age=${Math.floor(REMEMBER_TTL / 1000)}` : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/${maxAge}${cookieAttrs(req)}`);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    const sid = getSid(req);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieAttrs(req)}`);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    // 公开接口：不返回用户名等敏感信息（用户名在登录后的 /api/settings 里才有）
    res.json({
      port: config.data.panel.port,
      authEnabled: !!config.data.panel.authEnabled,
      version: APP_VERSION,
      // 危险组合告警（审计 H5）：**对外可达 + 免密** = 任何人都能完全接管面板
      // （改配置、经 SSH 装 Agent、以 root 读写服务器文件）。
      // 只做告警、不改默认行为：默认免密对「只监听本机」的单用户场景是正当设计，
      // 危险的是这个组合。前端据此显示持久横幅。
      exposedWithoutAuth: !!opts.mayBeExposed && !config.data.panel.authEnabled,
    });
  });

  // ---------- LICENSE 全文（关于页展示；公开静态文本，无敏感信息） ----------
  router.get('/license', (req, res) => {
    try {
      res.json({ text: fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8') });
    } catch {
      fail(res, 'internal.license-missing');
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

  /** 发码记录是否已无用（周期 GC 与上限裁剪共用，下同） */
  const forgotStale = (r, now) => now - r.windowStart > FORGOT_WINDOW_MS && now - r.lastAt > FORGOT_COOLDOWN_MS;
  /** 验证码试错记录是否已无用 */
  const verifyStale = (r, now) => (r.until || 0) <= now && now - r.at > VERIFY_LOCK_MS;
  const resetTickets = new Map(); // ticket -> expires（内存态：重启后需重新校验验证码）
  let codeTries = { hash: '', count: 0 }; // 当前验证码累计试错次数

  /** 常量时间比对 sha256 摘要（摘要为空/长度不符一律 false） */
  function hashEquals(hexHash, value) {
    const got = crypto.createHash('sha256').update(String(value)).digest();
    const want = Buffer.from(String(hexHash || ''), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  // 刻意不是 async：发信已改为不等待（见下方说明），避免 await 造成的时序泄露
  router.post('/forgot-password', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = forgotSent.get(ip) || { count: 0, windowStart: now, lastAt: 0 };
    if (now - rec.windowStart > FORGOT_WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    if (rec.count >= FORGOT_MAX_PER_WINDOW) {
      return fail(res, 'auth.reset.send-too-frequent', {
        minutes: Math.ceil((rec.windowStart + FORGOT_WINDOW_MS - now) / 60000),
      });
    }
    if (now - rec.lastAt < FORGOT_COOLDOWN_MS) {
      return fail(res, 'auth.reset.cooldown', {
        seconds: Math.ceil((FORGOT_COOLDOWN_MS - (now - rec.lastAt)) / 1000),
      });
    }
    // 不论邮箱是否匹配都计数：否则不匹配的请求可以无限打（拿它探测+轰炸管理员邮箱）
    rec.count += 1;
    rec.lastAt = now;
    // 这一步是**无前置条件**地按 IP 建键（不看邮箱是否匹配、不看 SMTP 是否配置），
    // 所以是新来源时必须先腾位置——否则这是唯一键洪水的直接入口。
    if (!forgotSent.has(ip)) capTracked(forgotSent, LIMITER_MAX_TRACKED, now, forgotStale);
    forgotSent.set(ip, rec);

    const email = String((req.body || {}).email || '').trim();
    const st = config.data.settings;
    const smtpReady = smtpConfigured();
    const match =
      !!email &&
      !!config.data.panel.passwordHash &&
      email.toLowerCase() === String(st.adminEmail || '').toLowerCase();

    // 响应**恒为同一形状**，且**不等待发信**完成。
    //
    // 原先的三重差异构成一个完整的「管理员邮箱枚举」通道（未认证即可用）：
    //   ① sent 字段：false = 邮箱不匹配或 SMTP 未配置，true = 匹配且发信成功
    //   ② cooldownSec 只在匹配分支出现
    //   ③ 响应耗时：不匹配立即返回，匹配要等数秒 SMTP 握手
    // 现在：匹配与否不体现在响应里。
    // `smtpReady` 可以回——它是**服务端全局**状态，对所有邮箱都一样，
    // 不含「这个邮箱是否存在」的信息，前端靠它避免「没配 SMTP 却提示已发送」的误导。
    const cooldownSec = FORGOT_COOLDOWN_MS / 1000;
    if (match && smtpReady) {
      // 6 位数字验证码：邮件里直接可读，也便于在没有域名/公网地址时手动输入
      const code = String(crypto.randomInt(100000, 1000000));
      config.data.panel.resetCode = {
        hash: crypto.createHash('sha256').update(code).digest('hex'), // 只存摘要，不存原始验证码
        expires: now + 15 * 60e3,
      };
      config.save();
      codeTries = { hash: '', count: 0 }; // 新码重新计试错
      // 刻意**不 await**：await 会让「匹配」的响应比「不匹配」慢数秒，
      // 等于把答案写在响应耗时里。验证码已在上方同步落盘，所以先回响应是安全的。
      // 失败只进服务端日志——原先把 nodemailer 原始报错（含 SMTP host/端口/认证细节）
      // 回给未认证调用方，既是信息泄露，也又一次区分了两条分支。
      sendMail(st.adminEmail, '[BlockNexus] 重置面板密码', mailTpl.resetCodeMail({ code })).catch((e) => {
        console.error('[forgot-password] 验证码邮件发送失败:', (e && e.message) || e);
      });
    }
    res.json({ ok: true, sent: true, cooldownSec, smtpReady });
  });

  /** 第 ② 步：校验验证码。通过后作废验证码并发放一次性改密票据 */
  router.post('/verify-reset-code', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = verifyFails.get(ip);
    if (rec && rec.until > now) {
      return fail(res, 'auth.too-many-attempts-minutes', { minutes: Math.ceil((rec.until - now) / 60000) });
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
        // 不回 verify-too-many：那个 code 只可能在「有码在途」时出现，
        // 等于告诉攻击者「刚才那个邮箱命中了」。作废动作照旧，只是响应不再区分。
        return fail(res, 'auth.reset.code-invalid');
      }
    }
    if (!usable || !/^\d{6}$/.test(code) || !hashEquals(rt && rt.hash, code)) {
      let count = rec && now - rec.at < VERIFY_LOCK_MS ? rec.count : 0;
      count += 1;
      const until = count >= VERIFY_MAX_FAILS ? now + VERIFY_LOCK_MS : 0;
      // 同 forgotSent：失败路径也是无前置条件地按 IP 建键，需上限保护
      if (!verifyFails.has(ip)) capTracked(verifyFails, LIMITER_MAX_TRACKED, now, verifyStale);
      verifyFails.set(ip, { count, until, at: now });
      if (until) {
        // 按本 IP 自己累计的失败次数锁定——只反映攻击者自身的行为，
        // 不泄露「有没有验证码在途」，因此可以保留这条更具体的提示。
        return fail(res, 'auth.reset.relock-15min');
      }
      // 有码但错 / 无码 / 已过期：**统一成同一条响应**。
      // 分开回 code-wrong 与 code-expired 会构成「此刻是否有码在途」的预言机，
      // 配合 /forgot-password 即可枚举管理员邮箱（详见 error-codes.js 的说明）。
      return fail(res, 'auth.reset.code-invalid');
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
      return fail(res, 'auth.password-too-short');
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
    // 兼容旧邮件里的链接 token：也按摘要比对，命中即可用。
    //
    // ⚠ 关于这条分支的准确状态（审计报告曾判它为「死代码、永远不可达」，**该判断有误**）：
    //   · 生产代码里确实**没有任何写入点**——没有哪条路径会创建 panel.resetToken；
    //   · 但 agent/e2e-reset-code.js 的 T14 会写入它并断言该路径可用，
    //     所以它是**被测试覆盖的兼容路径**，不是死代码，删掉会连带删掉 T14 与
    //     docs/blocknexus-current-state.md 里的说明。
    //   · 实际不可达性来自「没有写入点」，而不是代码本身不可执行：
    //     要激活它必须先能手改 config.json —— 那时攻击者已经拿到主机权限。
    // 结论：保留，并把状态写清楚，避免后人误以为是第二条改密通道（也避免误删）。
    if (!ok && legacy && config.data.panel.resetToken) {
      if (now <= config.data.panel.resetToken.expires && hashEquals(config.data.panel.resetToken.hash, legacy)) {
        delete config.data.panel.resetToken;
        ok = true;
      }
    }
    if (!ok) {
      return fail(res, 'auth.reset.ticket-invalid');
    }
    config.setCredentials({ password });
    config.data.panel.authEnabled = true;
    config.save();
    sessions.clear(); // 密码已泄露场景：重置后所有会话下线
    res.json({ ok: true });
  });

  // 清理过期的发码记录 / 试错记录 / 改密票据 / 登录失败记录，避免内存随访问量缓慢增长
  setInterval(() => {
    const now = Date.now();
    for (const [ip, r] of forgotSent) {
      if (forgotStale(r, now)) forgotSent.delete(ip);
    }
    for (const [ip, r] of verifyFails) {
      if (verifyStale(r, now)) verifyFails.delete(ip);
    }
    for (const [t, exp] of resetTickets) {
      if (exp <= now) resetTickets.delete(t);
    }
    // 会话表原先只有「再次出示且已过期」「登出」「改密」三个删除时机，
    // 没有后台 GC：登录后从不点登出、也再不回访的会话会**永久驻留**（每条约百字节）。
    // 量级很小，但它是本文件里唯一一张没有任何回收路径兜底的按会话增长的表，补上更整齐。
    // 注意：sessions 的值是 { exp, remember }（不是数字），且 exp 会随每次请求滑动续期，
    // 所以在跑的会话不会被这里误删。
    for (const [sid, sess] of sessions) {
      if (!sess || sess.exp <= now) sessions.delete(sid);
    }
    // loginFails 原先漏在这张清单之外：锁定到期后记录会永久驻留
    pruneLoginFails(now);
  }, 60e3).unref();

  // ---------- 测试钩子（放在所有内部状态声明之后）----------
  // 仅当测试显式注册过才生效；生产进程里 pendingTestHook 恒为 null，无任何副作用。
  if (typeof pendingTestHook === 'function') {
    const hook = pendingTestHook;
    pendingTestHook = null; // 一次性投递
    hook({
      loginFails,
      sessions,
      // 这两张表同样按来源 IP 建键，是「唯一键洪水」的直接入口，
      // 暴露给测试以便断言数量上限真的生效
      forgotSent,
      verifyFails,
      limits: { LOGIN_MAX_FAILS, LOGIN_LOCK_MS, LOGIN_MAX_TRACKED, LIMITER_MAX_TRACKED },
      pruneLoginFails,
      // 离线/恢复邮件的降噪状态与时序常量：暴露给测试以便断言「抖动不发信、
      // 长期离线只发一封」这类行为，而不必真的等 2 分钟
      notify: {
        offlineNotified,
        maybeNotifyStatus,
        clearOfflineTracking,
        sendOfflineMail,
        limits: { OFFLINE_GRACE, OFFLINE_MIN_GAP, OFFLINE_REMIND },
      },
    });
  }

  // 密码保护可开关：关闭时（默认，本地服务）其余接口直接放行；开启时需要会话
  router.use((req, res, next) => {
    if (!config.data.panel.authEnabled) return next();
    const sid = getSid(req);
    const sess = sid && sessions.get(sid);
    if (sess && sess.exp > Date.now()) {
      // 滑动续期：记住我的会话续 30 天，普通会话续 7 天（Cookie 本身的存活由浏览器管）
      sessions.set(sid, { ...sess, exp: Date.now() + (sess.remember ? REMEMBER_TTL : SESSION_TTL) });
      return next();
    }
    if (sid) sessions.delete(sid);
    fail(res, 'auth.not-logged-in');
  });

  // ---------- 版本与更新检查（登录后） ----------
  // ?refresh=1 跳过 10 分钟缓存（前端「检查更新」按钮）
  router.get('/version', async (req, res) => {
    const data = await checkLatestRelease(APP_VERSION, req.query.refresh === '1');
    const pre = upd.planUpgrade({
      localVersion: APP_VERSION,
      localSchema: migrate.readSchema(config.data),
      meta: data.meta,
    });
    res.json({
      version: APP_VERSION,
      repoUrl: REPO_URL,
      ...data,
      // 自更新相关（只增字段，老前端不受影响）
      installKind: INSTALL.kind,
      canSelfUpdate: INSTALL.canSelfUpdate,
      updateDisabledReason: INSTALL.canSelfUpdate ? '' : INSTALL.reasonKey,
      updateDisabledText: INSTALL.canSelfUpdate ? '' : text(INSTALL.reasonKey, req),
      updatePolicy: { auto: updPolicy().auto, source: updPolicy().source },
      recommendation: recommendationOf(data, pre, req),
      updateState: { ...updateState },
    });
  });

  // ============================================================
  // 面板自更新
  // ============================================================
  // 判定全在 panel/update.js（纯函数 + 单测），这里只做流程编排与状态机：
  //   检查（复用 /version 的同一份缓存）→ 预检 → 下载 → 校验 → 解压校验 → 交接更新器
  // 顺序固定：**安全门禁在最前**，任何一步不过就一个文件都不动。
  const INSTALL = opts.install || {
    kind: upd.KIND_UNKNOWN,
    canSelfUpdate: false,
    reasonKey: 'update.disabled-unknown',
    facts: {},
    markerVersion: '',
  };
  const ROOT_DIR = path.join(__dirname, '..');
  const UPDATE_ROOT = path.join(ROOT_DIR, 'data', 'update');
  const UPDATE_LOG = path.join(UPDATE_ROOT, 'update.log');
  const UPDATE_RESULT = path.join(UPDATE_ROOT, 'last-result.json');
  const UPDATER = path.join(ROOT_DIR, 'scripts', 'panel-updater.js');
  const LAUNCH_ARGS = opts.launcherArgs || { host: '127.0.0.1', port: 3080, scheme: 'http' };
  const MAX_UPDATE_BYTES = 200 * 1024 * 1024;
  const NODE_MAJOR = Number(String(process.versions.node).split('.')[0]) || 0;

  const updateState = {
    state: 'idle',
    from: APP_VERSION,
    to: '',
    progress: 0,
    total: 0,
    error: '',
    startedAt: 0,
    mode: 'payload',
    migrations: [],
    warnings: [],
    requiresAgentReinstall: false,
    irreversible: false,
  };
  let updateInFlight = false;
  let updateFails = 0; // 连续失败次数（自动更新退避，与 Agent 更新同一套思路）
  let updateLastAttemptAt = 0;
  let autoTimer = null;

  function updPolicy() {
    const u = (config.data.settings && config.data.settings.update) || {};
    return {
      auto: ['off', 'notify', 'auto'].includes(u.auto) ? u.auto : 'notify',
      source: String(u.source || ''),
      dismissed: u.dismissed && typeof u.dismissed === 'object' ? u.dismissed : {},
    };
  }

  /** 把 i18n code 渲染成当前请求语言的文本（前端直接显示，不必再维护一份映射） */
  function text(code, req, params) {
    if (!code) return '';
    return messageOf(code, langOf(req), params) || String(code);
  }

  function ensureUpdateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  function readJsonSafe(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function lastUpdateResult() {
    return readJsonSafe(UPDATE_RESULT);
  }

  function setUpdate(patch) {
    Object.assign(updateState, patch);
    bus.emit('broadcast', { type: 'panel-update', ...updateState });
  }

  /** 面板是否空闲（有实例启停 / 备份 / 安装任务时不更新） */
  function idleForUpdate() {
    for (const rec of taskLogs.values()) if (rec && rec.done === null) return false;
    for (const s of config.listServers()) if (s.installing) return false;
    return true;
  }

  /** 需要手动重装 Agent 的服务器（协议不兼容的版本会给这个列表） */
  function agentsNeedingReinstall() {
    if (!BUNDLED_AGENT_VERSION) return [];
    return config
      .listServers()
      .filter((s) => hub.isOnline(s.id) && s.info && s.info.agentVersion && s.info.agentVersion !== BUNDLED_AGENT_VERSION)
      .map((s) => ({ id: s.id, name: s.name }));
  }

  /** 下载地址：镜像只承载下载，校验值始终来自 GitHub */
  function downloadUrlFor(assetUrl, assetName, version) {
    const src = updPolicy().source.trim();
    if (!src) return assetUrl;
    try {
      if (src.includes('{name}') || src.includes('{version}')) {
        return src.replace(/\{name\}/g, assetName).replace(/\{version\}/g, `v${version}`);
      }
      return `${src.replace(/\/+$/, '')}/${assetName}`;
    } catch {
      return assetUrl;
    }
  }

  /** 组装升级预览（预检）：UI 先看这个，用户确认后才允许点更新 */
  async function buildPreflight(req, force) {
    const rel = await checkLatestRelease(APP_VERSION, !!force);
    const meta = rel.meta || { ...upd.META_DEFAULTS };
    const local = upd.computeLocalHashes(ROOT_DIR);
    const plan = upd.planUpgrade({
      localVersion: APP_VERSION,
      localSchema: migrate.readSchema(config.data),
      meta,
      currentNode: NODE_MAJOR,
    });
    const full = upd.needsFullPackage(meta, local);
    const to = meta.version || rel.latest || '';
    const appAsset = upd.pickAsset(rel.assets, upd.ASSET.app(to));
    const portAsset = upd.pickAsset(rel.assets, upd.ASSET.portable(to));
    const nodeOk = !meta.minNode || NODE_MAJOR >= meta.minNode;
    const warnings = plan.warnings.map((k) => ({ code: k, text: text(k, req) }));
    if (rel.metaMissing) warnings.push({ code: 'update.meta-missing', text: text('update.meta-missing', req) });
    let allowed = INSTALL.canSelfUpdate && plan.allowed && nodeOk && !rel.error;
    let reasonKey = '';
    // 原因按「最贴近用户疑问」的顺序给：先"根本没新版本"，再"这台机器不能自更新"，
    // 再 Node/跨版本/完整包。否则本地版本高于线上时会被形态门禁的原因盖住，读起来像出错了。
    if (!to || !upd.isNewer(to, APP_VERSION)) reasonKey = 'update.version-not-newer';
    else if (!INSTALL.canSelfUpdate) reasonKey = INSTALL.reasonKey;
    else if (!nodeOk) reasonKey = 'update.node-too-old';
    else if (!plan.allowed) reasonKey = plan.reasonKey;
    else if (full.needed) reasonKey = full.reasonKey;
    // 完整包（含外壳/依赖变化）第一版不做应用内替换：只给提示与下载地址
    if (allowed && full.needed) allowed = false;
    return {
      from: APP_VERSION,
      to,
      latest: rel.latest || '',
      severity: meta.severity,
      summary: meta.summary,
      notesUrl: meta.notesUrl || rel.releaseUrl || '',
      changelog: String(rel.changelog || '').slice(0, 4000),
      breaking: meta.breaking,
      irreversible: meta.irreversible,
      requiresAgentReinstall: meta.requiresAgentReinstall,
      agentsToReinstall: meta.requiresAgentReinstall ? agentsNeedingReinstall() : [],
      migrations: plan.migrations,
      mode: plan.mode,
      bridgeVersion: plan.bridgeVersion,
      needsFullPackage: full.needed,
      fullPackageUrl: portAsset ? portAsset.url : rel.releaseUrl || '',
      appAssetAvailable: !!appAsset,
      downloadBytes: (full.needed ? portAsset : appAsset)?.size || 0,
      lockChanged: !!(meta.lockHash && local.lockHash && meta.lockHash !== local.lockHash),
      nodeOk,
      nodeRequired: meta.minNode,
      installKind: INSTALL.kind,
      canSelfUpdate: INSTALL.canSelfUpdate,
      allowed,
      reasonKey,
      reasonText: text(reasonKey, req),
      warnings,
      metaMissing: rel.metaMissing,
      checkedAt: rel.checkedAt,
      error: rel.error || '',
    };
  }

  /** 推荐模型：等级 + 摘要 + 是否已被用户"跳过此版本" */
  function recommendationOf(rel, plan, req) {
    const meta = rel.meta || { ...upd.META_DEFAULTS };
    const policy = updPolicy();
    const dismissedAt = policy.dismissed[meta.version || rel.latest || ''] || 0;
    return {
      hasUpdate: !!rel.hasUpdate,
      latest: rel.latest || '',
      severity: meta.severity,
      summary: meta.summary,
      notesUrl: meta.notesUrl || rel.releaseUrl || '',
      breaking: meta.breaking,
      requiresAgentReinstall: meta.requiresAgentReinstall,
      irreversible: meta.irreversible,
      metaMissing: rel.metaMissing,
      migrations: plan.migrations.length,
      dismissed: !!dismissedAt,
      dismissedAt,
      // 自动更新为什么没自动：把原因也渲染好，UI 不用自己映射
      autoReason: policy.auto === 'auto' ? text(shouldAutoApplyNow(rel, plan).reasonKey, req) : '',
      error: rel.error || '',
    };
  }

  /** 自动策略的当前判定（时间/空闲/退避等上下文都在这里取） */
  function shouldAutoApplyNow(rel, plan, pre) {
    return upd.shouldAutoApply({
      meta: rel.meta,
      plan,
      ctx: {
        idle: idleForUpdate(),
        exposedWithoutAuth: !!opts.mayBeExposed && !config.data.panel.authEnabled,
        failures: updateFails,
        lastAttemptAt: updateLastAttemptAt,
        now: Date.now(),
      },
    });
  }
  void shouldAutoApplyNow;

  /** 解压到指定目录：Windows 用 PowerShell，Linux 优先 unzip、缺失退 bsdtar（与项目既有约定一致） */
  function extractArchive(zip, dest) {
    const { spawnSync } = require('child_process');
    ensureUpdateDir(dest);
    const q = (s) => String(s).replace(/'/g, "''");
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(dest)}' -Force`],
        { encoding: 'utf8', windowsHide: true, timeout: 180000 },
      );
      if (r.status !== 0) throw new Error(`解压失败：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
      return;
    }
    let r = spawnSync('unzip', ['-q', '-o', zip, '-d', dest], { encoding: 'utf8', timeout: 180000 });
    if (r.status === 0) return;
    r = spawnSync('bsdtar', ['-xf', zip, '-C', dest], { encoding: 'utf8', timeout: 180000 });
    if (r.status === 0) return;
    throw new Error(`解压失败（unzip/bsdtar 均不可用或出错）：${String(r.stderr || r.stdout || '').slice(0, 300)}`);
  }

  /** 应用包根目录：manifest.json 在根，或在唯一一层子目录里（便携包的 BlockNexus-portable/） */
  function findPayloadRoot(stageDir) {
    if (fs.existsSync(path.join(stageDir, 'manifest.json'))) return stageDir;
    for (const ent of fs.readdirSync(stageDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = path.join(stageDir, ent.name);
      if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    }
    return '';
  }

  /** 列出载荷文件；遇到符号链接直接判为异常包（防"链接指向外部"） */
  function listPayloadFiles(root) {
    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) throw new Error(text('update.stage-invalid', null));
        if (st.isDirectory()) walk(full);
        else if (st.isFile()) out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    };
    walk(root);
    return out;
  }

  function hashFileHex(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (c) => hash.update(c));
      s.on('error', reject);
      s.on('end', () => resolve(hash.digest('hex')));
    });
  }

  function spawnUpdater(args) {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [UPDATER, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT_DIR,
    });
    child.unref();
    return child.pid;
  }

  /** 停掉面板，把控制权交给更新器（更新器会等端口释放后换文件） */
  function handoffToUpdater(args) {
    spawnUpdater(args);
    setUpdate({ state: 'restarting' });
    if (typeof opts.onShutdown === 'function') {
      setTimeout(() => opts.onShutdown('panel-update'), 600);
    }
  }

  /** 更新主体（后台跑；响应已经 202 回去了）：下载 → 校验 → 解压 → 交接 */
  async function runUpdateJob(pre, req) {
    const reqLang = langOf(req);
    const t = (code, params) => messageOf(code, reqLang, params) || code;
    try {
      // 预检刚刚强制刷新过缓存，这里直接吃缓存（少打一次 GitHub API，省限流额度）
      const rel = await checkLatestRelease(APP_VERSION, false);
      const to = pre.to;
      if (pre.mode === 'git') {
        // git 形态：不下载载荷，由更新器 fetch tags + checkout + 重建前端
        const nm = path.join(ROOT_DIR, 'web', 'node_modules');
        const needsInstall = pre.lockChanged || !fs.existsSync(nm);
        const args = [
          '--root', ROOT_DIR, '--from', APP_VERSION, '--to', to, '--mode', 'git', '--tag', `v${to}`,
          ...(needsInstall ? ['--rebuild'] : ['--build']),
          '--scheme', LAUNCH_ARGS.scheme, '--host', LAUNCH_ARGS.host, '--port', String(LAUNCH_ARGS.port),
          '--pid', String(process.pid), '--launch', 'panel-only', '--log', UPDATE_LOG, '--result', UPDATE_RESULT,
        ];
        if (pre.migrations.length) args.push('--data-backup', 'data/config.json');
        if (pre.irreversible) args.push('--irreversible');
        setUpdate({ state: 'applying', to, mode: 'git', migrations: pre.migrations });
        handoffToUpdater(args);
        return;
      }

      const asset = upd.pickAsset(rel.assets, upd.ASSET.app(to));
      if (!asset) throw new Error(t('update.asset-missing'));
      const sumsAsset = upd.pickAsset(rel.assets, upd.ASSET.sums);
      const tmpDir = ensureUpdateDir(path.join(UPDATE_ROOT, 'tmp', to));
      fs.rmSync(tmpDir, { recursive: true, force: true });
      ensureUpdateDir(tmpDir);
      const zip = path.join(tmpDir, asset.name);
      setUpdate({ state: 'downloading', to, mode: 'payload', progress: 0, total: asset.size, migrations: pre.migrations, warnings: pre.warnings.map((w) => w.code) });
      await downloadFilePanel(
        downloadUrlFor(asset.url, asset.name, to),
        zip,
        (got, total) => setUpdate({ progress: got, total: total || asset.size }),
        600000,
      );
      const st = fs.statSync(zip);
      if (st.size > MAX_UPDATE_BYTES) throw new Error(t('update.asset-too-large', { limit: Math.round(MAX_UPDATE_BYTES / 1048576) }));

      // 校验：读校验值只走 GitHub 资产（镜像不在信任链上）
      setUpdate({ state: 'verifying', progress: 0, total: 0 });
      if (!sumsAsset) throw new Error(t('update.checksum-missing'));
      const sums = upd.parseChecksums(await fetchRemoteText(sumsAsset.url, 256 * 1024, `BlockNexus/${APP_VERSION}`));
      const want = upd.expectedHash(sums, asset.name);
      if (!want) throw new Error(t('update.checksum-missing'));
      const gotHash = await hashFileHex(zip);
      if (gotHash !== want) {
        fs.rmSync(zip, { force: true });
        throw new Error(t('update.hash-mismatch'));
      }

      // 解压 + 载荷校验（版本一致、路径全在白名单内、必需文件存在）
      setUpdate({ state: 'staging' });
      const stageDir = path.join(UPDATE_ROOT, 'stage', to);
      fs.rmSync(stageDir, { recursive: true, force: true });
      extractArchive(zip, stageDir);
      const payloadRoot = findPayloadRoot(stageDir);
      if (!payloadRoot) throw new Error(t('update.stage-invalid'));
      const manifest = readJsonSafe(path.join(payloadRoot, 'manifest.json')) || {};
      if (String(manifest.version || '').replace(/^v/, '') !== to) throw new Error(t('update.stage-invalid'));
      const files = listPayloadFiles(payloadRoot).filter((f) => f !== 'manifest.json');
      for (const f of files) {
        if (!upd.canWritePath(f).ok) throw new Error(t('update.stage-invalid'));
      }
      if (!files.includes('panel/server.js') || !files.includes('web/dist/index.html')) {
        throw new Error(t('update.stage-invalid'));
      }

      const args = [
        '--root', ROOT_DIR, '--stage', payloadRoot, '--from', APP_VERSION, '--to', to, '--mode', 'payload',
        '--scheme', LAUNCH_ARGS.scheme, '--host', LAUNCH_ARGS.host, '--port', String(LAUNCH_ARGS.port),
        '--pid', String(process.pid), '--launch', 'panel-only',
        '--log', UPDATE_LOG, '--result', UPDATE_RESULT,
      ];
      if (pre.migrations.length) args.push('--data-backup', 'data/config.json');
      if (pre.irreversible) args.push('--irreversible');
      setUpdate({ state: 'applying' });
      updateFails = 0;
      updateLastAttemptAt = Date.now();
      handoffToUpdater(args);
    } catch (e) {
      updateInFlight = false;
      updateFails += 1;
      updateLastAttemptAt = Date.now();
      setUpdate({ state: 'failed', error: e && e.message ? e.message : String(e) });
    }
  }

  /**
   * 升级预览（只读）：UI 在用户点「立即更新」之前先取一次，把"要迁移什么、要不要重装 Agent、
   * 是否必须走完整包"摆出来。**不改任何文件**，所以门禁只保留"对外且免密"这一条。
   */
  router.get('/panel-update/preflight', async (req, res) => {
    if (opts.mayBeExposed && !config.data.panel.authEnabled) return fail(res, 'update.disabled-exposed');
    try {
      const pre = await buildPreflight(req, String(req.query.refresh || '') === '1');
      res.json({ ...pre, requested: String(req.query.version || '').replace(/^v/i, '') });
    } catch (e) {
      return fail(res, 'update.no-release', { error: e && e.message ? e.message : String(e) });
    }
  });

  /** 手动触发更新 */
  router.post('/panel-update', async (req, res) => {
    const body = req.body || {};
    const version = String(body.version || '').trim().replace(/^v/i, '');
    const confirm = String(body.confirm || '').trim().replace(/^v/i, '');
    // 门禁顺序 = 优先级：对外免密 > 形态 > 在途 > 参数 > 版本 > 空闲
    if (opts.mayBeExposed && !config.data.panel.authEnabled) return fail(res, 'update.disabled-exposed');
    if (!INSTALL.canSelfUpdate) return fail(res, INSTALL.reasonKey || 'update.disabled-unknown');
    if (updateInFlight) return fail(res, 'update.busy');
    if (!version || confirm !== version) return fail(res, 'update.confirm-mismatch');
    if (!upd.isNewer(version, APP_VERSION)) return fail(res, 'update.version-not-newer');
    if (!idleForUpdate()) return fail(res, 'update.busy');

    let pre;
    try {
      pre = await buildPreflight(req, true);
    } catch (e) {
      return fail(res, 'update.no-release', { error: e.message });
    }
    if (!pre.to || pre.to !== version) return fail(res, 'update.no-release');
    if (!pre.allowed) return fail(res, pre.reasonKey || 'update.unsupported-payload', { version: pre.bridgeVersion });
    if (pre.irreversible && body.confirmIrreversible !== true) return fail(res, 'update.irreversible-confirm');

    updateInFlight = true;
    setUpdate({ state: 'downloading', to: version, error: '', startedAt: Date.now(), mode: pre.mode, migrations: pre.migrations, irreversible: pre.irreversible, requiresAgentReinstall: pre.requiresAgentReinstall });
    res.status(202).json({ ok: true, accepted: true, version, preflight: pre });
    runUpdateJob(pre, req).catch(() => {});
  });

  /** 更新进度 / 上次结果 / 能否回滚 */
  router.get('/panel-update/status', (req, res) => {
    const last = lastUpdateResult();
    const backupFrom = last && last.ok ? String(last.from || '') : '';
    const backupDir = backupFrom ? path.join(UPDATE_ROOT, 'backup', backupFrom) : '';
    let irreversible = false;
    try {
      const files = fs.readdirSync(UPDATE_ROOT);
      irreversible = files.some((f) => f.startsWith('irreversible-'));
    } catch {}
    const canRoll = !!backupDir && fs.existsSync(backupDir) && !irreversible;
    res.json({
      ...updateState,
      inFlight: updateInFlight,
      installKind: INSTALL.kind,
      canSelfUpdate: INSTALL.canSelfUpdate,
      lastResult: last,
      rollback: {
        available: canRoll,
        to: backupFrom,
        irreversible,
        reasonKey: canRoll ? '' : irreversible ? 'update.rollback-refused' : 'update.rollback-no-backup',
      },
    });
  });

  /** 回滚到上一次更新前的版本（不可逆迁移之后拒绝） */
  router.post('/panel-update/rollback', (req, res) => {
    if (opts.mayBeExposed && !config.data.panel.authEnabled) return fail(res, 'update.disabled-exposed');
    if (!INSTALL.canSelfUpdate) return fail(res, INSTALL.reasonKey || 'update.disabled-unknown');
    if (updateInFlight) return fail(res, 'update.busy');
    const last = lastUpdateResult();
    const target = last && last.ok ? String(last.from || '') : '';
    const backupDir = target ? path.join(UPDATE_ROOT, 'backup', target) : '';
    let irreversible = false;
    try {
      irreversible = fs.readdirSync(UPDATE_ROOT).some((f) => f.startsWith('irreversible-'));
    } catch {}
    const chk = upd.canRollback({ hasBackup: !!backupDir && fs.existsSync(backupDir), irreversible });
    if (!chk.ok) return fail(res, chk.reasonKey);
    if (!idleForUpdate()) return fail(res, 'update.busy');

    updateInFlight = true;
    setUpdate({ state: 'applying', to: target, mode: 'rollback', error: '' });
    const args = [
      '--root', ROOT_DIR, '--restore', backupDir, '--from', APP_VERSION, '--to', target, '--mode', 'rollback',
      '--scheme', LAUNCH_ARGS.scheme, '--host', LAUNCH_ARGS.host, '--port', String(LAUNCH_ARGS.port),
      '--pid', String(process.pid), '--launch', 'panel-only', '--log', UPDATE_LOG, '--result', UPDATE_RESULT,
    ];
    if (last && Array.isArray(last.dataBackup) && last.dataBackup.length) {
      args.push('--data-backup', last.dataBackup.join(','));
    }
    res.status(202).json({ ok: true, accepted: true, rollbackTo: target });
    handoffToUpdater(args);
  });

  /**
   * 自动更新：默认只提示（notify）。真正自动安装必须由发布方在 update.json 里
   * 显式声明 autoSafe + 非破坏性（见 panel/update.js 的 shouldAutoApply），
   * 因为本项目 v1.0 之前 semver 不严格，不能按"minor 就安全"猜。
   */
  async function autoUpdateTick() {
    try {
      const policy = updPolicy();
      if (policy.auto === 'off') return;
      if (updateInFlight || !INSTALL.canSelfUpdate) return;
      if (opts.mayBeExposed && !config.data.panel.authEnabled) return;
      const rel = await checkLatestRelease(APP_VERSION, false);
      if (!rel.hasUpdate) return;
      const local = upd.computeLocalHashes(ROOT_DIR);
      const plan = upd.planUpgrade({ localVersion: APP_VERSION, localSchema: migrate.readSchema(config.data), meta: rel.meta, currentNode: NODE_MAJOR });
      if (policy.dismissed && policy.dismissed[rel.latest]) return;
      if (upd.needsFullPackage(rel.meta, local).needed) return;
      if (policy.auto !== 'auto') return;
      const verdict = upd.shouldAutoApply({
        meta: rel.meta,
        plan,
        ctx: {
          idle: idleForUpdate(),
          exposedWithoutAuth: !!opts.mayBeExposed && !config.data.panel.authEnabled,
          failures: updateFails,
          lastAttemptAt: updateLastAttemptAt,
          now: Date.now(),
        },
      });
      if (!verdict.ok) return;
      const pre = await buildPreflight({ headers: { 'accept-language': 'zh' } }, false);
      if (!pre.allowed) return;
      updateInFlight = true;
      setUpdate({ state: 'downloading', to: pre.to, mode: pre.mode, migrations: pre.migrations, startedAt: Date.now() });
      runUpdateJob(pre, { headers: { 'accept-language': 'zh' } }).catch(() => {});
    } catch {
      // 自动更新是尽力而为，任何异常都不打扰用户
    }
  }
  // 启动 3 分钟后首次检查，之后每 6 小时一次（.unref() 不阻止进程退出）
  setTimeout(() => autoUpdateTick(), 3 * 60 * 1000).unref();
  autoTimer = setInterval(() => autoUpdateTick(), 6 * 60 * 60 * 1000);
  autoTimer.unref();
  void updateState;
  void autoTimer;

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
      // 面板更新策略（auto = off | notify | auto；source 为下载镜像，校验值仍来自 GitHub）
      update: { auto: updPolicy().auto, source: updPolicy().source, dismissed: { ...updPolicy().dismissed } },
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
          return fail(res, 'auth.username-invalid');
        }
        if (!hasPassword && (!b.password || String(b.password).length < 6)) {
          return fail(res, 'auth.password-too-short-for-protection');
        }
        if (b.password && String(b.password).length < 6) {
          return fail(res, 'auth.password-too-short');
        }
        config.setCredentials({ username: newUser || undefined, password: b.password || undefined });
        config.data.panel.authEnabled = true;
        config.save();
        const sid = crypto.randomBytes(24).toString('hex');
        sessions.set(sid, { exp: Date.now() + SESSION_TTL, remember: false });
        capTracked(sessions, MAX_SESSIONS, Date.now(), () => false);
        res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${cookieAttrs(req)}`);
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
        return fail(res, 'auth.reset.email-format-invalid');
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
        if (u && !/^https?:\/\//i.test(u)) return fail(res, 'ai.url-invalid');
        st.ai.baseUrl = u;
      }
      if (a.model !== undefined) st.ai.model = String(a.model).trim();
      if (a.apiKey) st.ai.apiKey = String(a.apiKey).trim();
    }

    // —— 面板更新策略 ——
    // auto: off（不检查）/ notify（只提示，默认）/ auto（允许自动安装，仍需发布方声明 autoSafe）
    // source: 下载镜像（必须 https；校验值始终来自 GitHub，镜像不在信任链上）
    // dismissed: 「跳过此版本」记录（版本号 → 时间戳），只接受合法版本号，长度封顶
    if (b.update && typeof b.update === 'object') {
      if (!st.update) st.update = { auto: 'notify', source: '', dismissed: {} };
      if (b.update.auto !== undefined) {
        const v = String(b.update.auto);
        if (!['off', 'notify', 'auto'].includes(v)) return fail(res, 'settings.update-invalid');
        st.update.auto = v;
      }
      if (b.update.source !== undefined) {
        const s = String(b.update.source).trim().replace(/\/+$/, '');
        if (s && !/^https:\/\//i.test(s)) return fail(res, 'settings.update-source-invalid');
        st.update.source = s.slice(0, 500);
      }
      if (b.update.dismissed && typeof b.update.dismissed === 'object') {
        const next = {};
        let n = 0;
        for (const [k, v] of Object.entries(b.update.dismissed)) {
          if (n++ > 50) break;
          const ver = String(k).replace(/^v/i, '').slice(0, 40);
          if (!upd.normalizeVersion(ver)) continue;
          next[ver] = Number(v) || Date.now();
        }
        st.update.dismissed = next;
      }
    }

    config.save();
    res.json({ ok: true, authEnabled: config.data.panel.authEnabled });
  });

  // SMTP 连通性测试：向管理员邮箱发一封测试邮件
  router.post('/settings/smtp-test', async (req, res) => {
    const st = config.data.settings;
    try {
      if (!smtpConfigured()) return fail(res, 'settings.smtp-incomplete');
      if (!st.adminEmail) return fail(res, 'settings.admin-email-missing');
      await sendMail(
        st.adminEmail,
        '[BlockNexus] SMTP 测试邮件',
        mailTpl.smtpTestMail(),
      );
      res.json({ ok: true });
    } catch (e) {
      fail(res, 'notification.send-failed', { detail: e.message });
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
      // 本次 Agent 连接的建立时刻（在线时长统计用；离线为 null）
      onlineSince: hub.getOnlineSince ? hub.getOnlineSince(server.id) : null,
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
      fail(res, 'server.not-found');
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

  // 服务器卡片排序（首页拖动后持久化）；返回重排后的完整列表
  router.post('/servers/reorder', (req, res) => {
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids)) return fail(res, 'instance.ids-required');
    config.reorderServers(ids);
    res.json({ ok: true });
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

  // 添加服务器（不装 Agent、不建实例的裸入口）：
  // 面板 UI 已统一走「快速添加」（/servers/quick-create），这里保留给脚本/自动化使用。
  // 原来的「安装前先验证 SSH」(/servers/ssh-check) 随「添加服务器」弹窗一起删掉了——
  // 快速添加会在安装过程中如实报错，不需要再多一次握手把耗时翻倍。
  router.post('/servers', (req, res) => {
    const b = req.body || {};
    if (!b.host) return fail(res, 'server.host-required');
    if (!isValidHost(b.host)) return fail(res, 'server.host-invalid');
    const server = config.addServer(b);
    hub.syncOutbound();
    res.json(sanitize(server, { revealToken: true }));
  });

  router.get('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const revealToken = req.query.token === '1';
    // 回凭据的响应**禁止任何缓存**：Agent token 等价于该服务器的登录凭据，
    // 一旦被浏览器/中间代理缓存，就可能被后续请求或他人取到。
    // 其余端点已经有 no-cache 之类的处理，这一条是最需要它的。
    if (revealToken) res.setHeader('Cache-Control', 'no-store');
    // 与列表接口一致：附上面板随附的 Agent 版本与自动更新状态（设置页的版本比对要用）
    res.json({
      ...sanitize(server, { revealToken }),
      agentBundled: BUNDLED_AGENT_VERSION,
      agentUpdate: agentUpdateState.get(server.id) || null,
    });
  });

  router.put('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    if (b.host !== undefined && !isValidHost(b.host)) return fail(res, 'server.host-invalid');
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
    clearOfflineTracking(server.id); // 否则待发的离线补发定时器会一路留到进程退出
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 带错误码的异常：让它一路带到任务结果的 `code` 字段，前端据此本地化 */
  function codedError(code, params) {
    const e = new Error(messageOf(code, 'zh', params));
    e.code = code;
    e.params = params;
    return e;
  }

  /**
   * 安装/重启 Agent 的公共流程（本机托管 / 远程 SSH）。
   * 「安装按钮」和「快速添加」共用它，避免两条流程各写一份、日后改一处漏一处。
   * @returns {Promise<boolean>} 是否在 waitMs 内上线
   */
  async function runAgentInstall(server, log, { waitMs = 30000 } = {}) {
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
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !hub.isOnline(server.id)) await sleep(500);
    return hub.isOnline(server.id);
  }

  router.post('/servers/:id/install', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (installing.has(server.id)) return fail(res, 'server.install-in-progress');
    if ((server.agent.mode || 'outbound') === 'inbound' && !server.agent.panelUrl) {
      return fail(res, 'server.panel-url-required');
    }
    installing.add(server.id);
    config.updateServer(server.id, { installing: true });
    res.json({ ok: true, started: true });

    // 新一轮安装：清掉上一批日志，保证用户看到的是本轮的进度
    taskLogReset(server.id, 'install');
    const log = (text) => taskLog(server.id, 'install', text);
    try {
      const isLocal = localAgent.isLocalHost(server.host);
      const ok = await runAgentInstall(server, log);
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

  // ---------- 快速添加：加服务器 → 装 Agent → 建实例 → 开服 ----------
  //
  // 为什么要有它：原来的「添加服务器 → 保存 → 进详情页点安装 → 再新建实例 → 填一堆参数」
  // 对只想开个服的人来说步骤太多，实际结果就是大家干脆把 MC 跑在面板机器/本机 Windows 上。
  // 这里把这几步串成一条后台任务：
  //   ① 安装 Agent（远程 SSH / 本机托管）→ 等上线
  //   ② 读实例列表与核心目录，补出合法默认值（名称/端口/内存/版本）
  //   ③ 创建实例、等核心下载完
  //   ④ 启动实例，等它打印 Done（真正可连）
  // 进度写进 'install' 任务日志，复用现成的 SSE 通道与日志面板。
  const QUICK_INSTALL_TIMEOUT = 15 * 60e3; // 等核心下载的最长时间（Forge 安装器可能很慢）
  const QUICK_START_TIMEOUT = 180e3; // 等服务器打印 Done 的最长时间（首次启动要生成世界）

  /** 轮询实例列表，直到核心下载完成（失败/超时抛异常） */
  async function waitInstanceReady(server, name, log) {
    const t0 = Date.now();
    let lastNote = t0;
    for (;;) {
      const list = await hub.request(server.id, 'instance.list', {}, 20000).catch(() => null);
      const rec = Array.isArray(list) ? list.find((x) => x && x.name === name) : null;
      const verdict = quick.readyVerdict(rec);
      if (verdict === 'ready') return rec;
      if (verdict === 'failed') {
        throw new Error((rec && rec.error) || '实例安装失败');
      }
      const waited = Date.now() - t0;
      if (waited > QUICK_INSTALL_TIMEOUT) {
        throw codedError('instance.quick-timeout', { seconds: Math.round(waited / 1000) });
      }
      // 每 15 秒报一次「还在装」，否则慢速网络下界面看起来像卡住了
      if (Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        log(`   …仍在下载/安装核心（已等待 ${Math.round(waited / 1000)} 秒）\n`);
      }
      await sleep(2000);
    }
  }

  /** 启动实例并等它真正可连（status 变成 running）；启动后立刻退出则抛异常并附控制台尾部 */
  async function startAndConfirm(server, name, log) {
    log('启动实例（首次启动会生成世界，通常 30-90 秒）…\n');
    await hub.request(server.id, 'instance.start', { name }, 30000);
    const t0 = Date.now();
    while (Date.now() - t0 < QUICK_START_TIMEOUT) {
      await sleep(2000);
      const list = await hub.request(server.id, 'instance.list', {}, 20000).catch(() => null);
      const rec = Array.isArray(list) ? list.find((x) => x && x.name === name) : null;
      const st = rec && rec.status;
      if (st === 'running') return true;
      if (st === 'stopped' || st === 'failed') {
        // 起来了又退出：把最后几行控制台发到任务日志里，否则用户只能自己去翻
        let reason = '进程启动后立即退出';
        try {
          const c = await hub.request(server.id, 'instance.console', { name, tail: 12 }, 15000);
          const lines = (c && Array.isArray(c.lines) ? c.lines : []).map((l) => String(l.text || l)).filter(Boolean);
          if (lines.length) {
            log('控制台尾部：\n' + lines.slice(-12).map((l) => '   | ' + l + '\n').join(''));
            reason = lines[lines.length - 1].slice(0, 300);
          }
        } catch {}
        throw codedError('instance.quick-start-failed', { reason });
      }
    }
    // 超时但没退出：服务器可能只是慢（大型整合包首次启动），不算失败，交给用户在详情页看
    log('⚠ 180 秒内还没看到启动完成的日志，服务器可能仍在启动，请到实例页确认\n');
    return false;
  }

  /**
   * 确保远端有「足够新」的 Java：没有就自动装一个（全新的 VPS 上通常一个都没有，
   * 直接启动只会看到 "java: command not found" 进控制台，对快速添加来说太隐晦）。
   * 只升不降：已装版本 >= 需要版本就跳过。
   * 装失败不阻断流程——继续启动，失败原因仍会在控制台里出现，用户可去「服务器设置 → Java」手动装。
   */
  async function ensureJava(server, log, mcVersion) {
    const need = quick.javaMajorFor(mcVersion);
    const readInfo = async () => {
      try {
        return await hub.request(server.id, 'sys.info', {}, 20000);
      } catch {
        return server.info;
      }
    };
    let info = await readInfo();
    const j = info && info.java;
    const have = j && j.installed ? Number(j.major) || 0 : 0;
    if (have && have >= need) {
      log(`   Java ${have} 已就绪（${mcVersion} 需要 ${need}+）\n`);
      return true;
    }

    log(`   安装 Java ${need}（当前${have ? ' ' + have : '未安装'}）…\n`);
    try {
      await hub.request(server.id, 'java.install', { major: need }, 30000);
    } catch (e) {
      log(`   ⚠ 自动安装 Java 失败：${e.message}\n`);
      log('     可在「服务器设置 → Java 环境」里手动安装；现在仍尝试启动\n');
      return false;
    }

    const t0 = Date.now();
    while (Date.now() - t0 < 8 * 60e3) {
      await sleep(3000);
      info = await readInfo();
      const cur = info && info.java;
      if (cur && cur.installed && Number(cur.major) >= need) {
        log(`   ✓ Java ${cur.major} 就绪\n`);
        return true;
      }
    }
    log('   ⚠ 等待 Java 安装超时，仍尝试启动（装好后可在实例页重新启动）\n');
    return false;
  }

  /**
   * 快速添加的主流程。
   * @param {object} mc 实例参数（source/version/memoryMB/port/name/onlineMode/motd）
   * @param {object} opts.install 'auto'（已在线就跳过，默认）| 'force'（强制重装）
   * @param {boolean} opts.createInstance 是否顺便建实例并开服（false = 只装 Agent）
   * @returns {Promise<{ instance: string|null, started: boolean, reused: boolean }>}
   */
  async function quickSetup(server, mc, log, { install = 'auto', createInstance = true } = {}) {
    // ⓪ 先校验参数再动手：参数写错时不该白等一次 SSH 安装
    //   （不建实例时没有参数要校验）
    let base = null;
    if (createInstance) {
      const norm = quick.normalizeOptions(mc, {
        memTotalMB: (server.info && server.info.memTotalMB) || 0,
      });
      if (norm.error) throw codedError(norm.error, norm.params);
      base = norm.params;
    }

    // ① Agent
    let online = hub.isOnline(server.id);
    if (online && install !== 'force') {
      log('① Agent 已在线，跳过安装\n');
    } else {
      log('① 安装 Agent…\n');
      online = await runAgentInstall(server, log);
      log(installDoneText(server, online, localAgent.isLocalHost(server.host)));
      if (!online) throw new Error('Agent 未上线');
    }

    // 只装 Agent：到此为止（用户没有勾「同时创建实例」）
    if (!createInstance) {
      log('✓ 完成：Agent 已就绪，未创建实例（可在服务器详情页「+ 新建实例」随时创建）\n');
      return { instance: null, started: false, reused: false };
    }

    // 用户没指定内存时，按**装好 Agent 后**拿到的物理内存重新推荐一次
    // （建服务器时还不知道目标机器的配置，早算只能按 2GB）
    if (!(Number(mc && mc.memoryMB) > 0) && server.info && server.info.memTotalMB) {
      base.memoryMB = quick.recommendMemoryMB(server.info.memTotalMB);
    }

    // ② 补默认值：名称/端口要避开已有实例
    log('② 读取实例列表与核心版本清单…\n');
    let instances = [];
    try {
      const list = await hub.request(server.id, 'instance.list', {}, 20000);
      instances = Array.isArray(list) ? list : [];
    } catch (e) {
      log('   ⚠ 读取实例列表失败，按空列表处理：' + e.message + '\n');
    }

    const nameRes = quick.pickName(instances, base.name);
    if (nameRes.error) throw codedError(nameRes.error, nameRes.params);
    const name = nameRes.name;
    const port = quick.pickPort(instances, base.port);
    if (!port) throw codedError('instance.quick-port-range');

    // 同名实例已存在 → 按状态分三种处理，都不重复建：
    //   · 就绪：直接复用（没在跑就顺手启动）
    //   · 下载中：等它装完
    //   · 失败/不完整：重跑一次安装
    // 这条分支就是「重试」的正确落点——否则重试会建出 survival-2，
    // 而半成品的 survival 永远躺在那里。
    const existing = instances.find((x) => x && x.name === name);
    if (existing) {
      const verdict = quick.readyVerdict(existing);
      if (verdict === 'ready') {
        log(`   实例 ${name} 已存在且核心已就位，复用（不重复创建）\n`);
        if (existing.status !== 'running' && existing.status !== 'starting') {
          await ensureJava(server, log, existing.version || base.version || '');
          await startAndConfirm(server, name, log);
        }
        log('✓ 完成：' + name + '\n');
        return { instance: name, started: true, reused: true };
      }
      log(`   实例 ${name} 已存在但未就绪（${existing.status || '未知'}），继续把它装完\n`);
      if (existing.status === 'failed' || existing.status === 'incomplete') {
        await hub.request(server.id, 'instance.retry-install', { name }, 30000);
      }
      log('④ 等待核心下载与安装完成…\n');
      await waitInstanceReady(server, name, log);
      log('✓ 核心已就位\n');
      await ensureJava(server, log, existing.version || base.version || '');
      const startedExisting = await startAndConfirm(server, name, log);
      if (startedExisting) log('✓ 完成：' + name + ' 已启动，可以进游戏了\n');
      return { instance: name, started: startedExisting, reused: true };
    }

    let catalogs = null;
    try {
      catalogs = await hub.request(server.id, 'core.catalogs', {}, 30000);
    } catch {
      // Agent 拉不到清单时用面板自己的网络兜底（只影响版本选择，下载仍在 Agent 侧）
      catalogs = await panelFetchCores().catch(() => null);
    }
    const verRes = quick.pickVersion(catalogs, base.source, base.version);
    if (verRes.error) throw codedError(verRes.error, verRes.params);

    // ③ 创建实例
    if (port !== base.port) log(`   端口 ${base.port} 已被其他实例占用，改用 ${port}\n`);
    log(
      `③ 创建实例 ${name}（${base.source} ${verRes.version}，端口 ${port}，` +
        `内存 ${base.memoryMB} MB，正版验证${base.onlineMode ? '开' : '关'}）…\n`,
    );
    const createBody = {
      name,
      port,
      source: base.source,
      version: verRes.version,
      memoryMB: base.memoryMB,
      onlineMode: base.onlineMode,
      motd: base.motd,
      eula: true,
    };
    if (verRes.build) createBody.build = verRes.build;
    await hub.request(server.id, 'instance.create', createBody, 30000);
    log('④ 等待核心下载与安装完成…\n');
    await waitInstanceReady(server, name, log);
    log('✓ 核心已就位\n');

    // ⑤ 开服（先确保 Java 够用，否则只会看到一句 command not found）
    await ensureJava(server, log, verRes.version);
    const started = await startAndConfirm(server, name, log);
    if (started) log('✓ 完成：' + name + ' 已启动，可以进游戏了\n');
    return { instance: name, started, reused: false };
  }

  /**
   * 后台跑快速添加，结果写进任务日志（HTTP 早已返回；前端轮询 /servers/:id/task-log
   * 读完整日志与最终结果，刷新/重开弹窗也能续上）。
   */
  function runQuickSetup(server, mc, log, opts = {}) {
    quickSetup(server, mc, log, opts)
      .then((r) => {
        taskLogDone(server.id, 'install', {
          done: true,
          ok: true,
          instance: r.instance || null,
          reused: !!r.reused,
        });
      })
      .catch((e) => {
        log('✗ 快速添加失败: ' + e.message + '\n');
        log('   服务器记录已保留：修好问题后可在服务器设置页点「安装 Agent」重试，' +
            '或在详情页手动新建实例\n');
        taskLogDone(server.id, 'install', {
          done: true,
          ok: false,
          error: e.message,
          code: e.code || null,
        });
      })
      .finally(() => {
        installing.delete(server.id);
        config.updateServer(server.id, { installing: false });
      });
  }

  /**
   * 快速添加入口：保存服务器后立刻开始上面那条链路。
   *
   * 刻意**不**先做一次 SSH 预检（/servers/ssh-check）：那要先连一次、装的时候再连一次，
   * 慢一倍；而且预检失败时用户还得重填。这里直接建记录、把安装失败写进日志——
   * 服务器记录保留，改完凭据点「重试」即可，不用从头再来。
   */
  router.post('/servers/quick-create', (req, res) => {
    const b = req.body || {};
    if (!b.host) return fail(res, 'server.host-required');
    if (!isValidHost(b.host)) return fail(res, 'server.host-invalid');
    // 「同时创建实例」是可选项：不建实例时不需要 EULA 同意
    const createInstance = b.createInstance !== false;
    if (createInstance && b.eula !== true) return fail(res, 'server.quick-eula-required');

    const host = String(b.host).trim();
    const isLocal = localAgent.isLocalHost(host);
    // 远程必须先有能用的凭据，否则记录建出来也装不上（本机不需要 SSH）
    if (!isLocal && b.sshAuth !== 'key' && !String(b.sshPassword || '')) {
      return fail(res, 'server.quick-credentials-required');
    }
    if (!isLocal && b.sshAuth === 'key' && !String(b.sshKey || '').trim() && !String(b.sshKeyPath || '').trim()) {
      return fail(res, 'server.quick-credentials-required');
    }
    if (!isLocal && b.agentMode === 'inbound' && !String(b.panelUrl || '').trim()) {
      return fail(res, 'server.panel-url-required');
    }

    const server = config.addServer({
      name: b.name || host,
      host,
      sshPort: b.sshPort,
      sshUser: b.sshUser,
      sshAuth: b.sshAuth,
      sshPassword: b.sshPassword,
      sshKey: b.sshKey,
      sshKeyPath: b.sshKeyPath,
      // 本机服务器固定 outbound：面板就在本机，直接连 127.0.0.1 最省事
      agentMode: isLocal ? 'outbound' : b.agentMode,
      agentPort: b.agentPort,
      agentTls: b.agentTls,
      panelUrl: b.panelUrl,
    });
    hub.syncOutbound();

    installing.add(server.id);
    config.updateServer(server.id, { installing: true });
    taskLogReset(server.id, 'install');
    const log = (text) => taskLog(server.id, 'install', text);
    log(`快速添加 ${server.name}（${server.host}）\n`);
    runQuickSetup(server, b.mc || {}, log, { createInstance });

    res.json({ ...sanitize(server, { revealToken: true }), quick: { started: true } });
  });

  /**
   * 对已存在的服务器重跑「快速添加」链路（失败后的重试入口，也用于给已有服务器补建实例）。
   * install: 'auto' 已在线就跳过安装（默认）| 'force' 强制重装 Agent
   * createInstance: false 只装 Agent
   */
  router.post('/servers/:id/quick-setup', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    const createInstance = b.createInstance !== false;
    if (createInstance && b.eula !== true) return fail(res, 'server.quick-eula-required');
    if (installing.has(server.id)) return fail(res, 'server.quick-running');
    if ((server.agent.mode || 'outbound') === 'inbound' && !server.agent.panelUrl) {
      return fail(res, 'server.panel-url-required');
    }
    installing.add(server.id);
    config.updateServer(server.id, { installing: true });
    taskLogReset(server.id, 'install');
    const log = (text) => taskLog(server.id, 'install', text);
    log('重试快速添加' + (b.install === 'force' ? '（强制重装 Agent）' : '') + '…\n');
    runQuickSetup(server, b.mc || {}, log, { install: b.install === 'force' ? 'force' : 'auto', createInstance });
    res.json({ ok: true, started: true });
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

  // 统一 UA：部分镜像（清华 TUNA、MSL 等）要求或不带 UA 就 403；MSL 要求 UA 含应用名。
  // 从 APP_VERSION 派生，避免像旧版那样把版本号写死在这里、升级后 UA 仍停留在旧版本。
  const HTTP_UA = `BlockNexus/${APP_VERSION}`;

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
          readBodyCapped(res, req, MAX_REMOTE_BODY, '版本清单')
            .then((buf) => resolve(JSON.parse(buf.toString('utf8'))))
            .catch(reject);        });
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
        readBodyCapped(res, req, MAX_REMOTE_BODY, '远端文本响应').then(
          (buf) => resolve(buf.toString('utf8')),
          reject,
        );
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
    if (!hub.isOnline(server.id)) return fail(res, 'server.agent-offline-panel-install');
    // 常见错误同步校验、立即报给用户；下载+传输可能要几分钟，放后台执行，进度走 SSE 与控制台
    try {
      const list = await hub.request(server.id, 'instance.list', {}, 20000);
      const inst = (Array.isArray(list) ? list : []).find((x) => x && x.name === req.params.name);
      if (!inst) return fail(res, 'instance.not-found');
      if ((inst.source || 'vanilla') === 'upload') {
        return fail(res, 'instance.upload-core-manual');
      }
      if (inst.status === 'downloading') return fail(res, 'server.agent-installing-no-panel-install');
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

  // ---------- 玩家统计与聊天记录（数据由 Agent 解析并落盘，面板只做参数规范化 + 转发） ----------
  // 面板离线期间 Agent 照常记录，重连后这里就能读到完整历史——这正是把存储放在 Agent
  // 侧的原因（面板不保证长期在线，而控制台行是流式的，断开期间没人消费就永远丢了）。
  // 参数在面板侧先规范化一遍，Agent 侧仍会独立再校验（纵深防御）。
  const CHAT_LIMIT_DEFAULT = 100;
  const CHAT_LIMIT_MAX = 300; // 与 Agent 的 CHAT_PAGE_MAX 对齐：单帧别太大
  const CHAT_FILTER_MAX = 32; // 玩家名长度上限（与 MC 用户名上限一致）
  const CHAT_KEYWORD_MAX = 64; // 关键词上限：只当纯文本用，不下发正则

  // 玩家在线时长统计（本次在线 / 累计 / 会话数 / 首次与最近记录）
  router.get('/servers/:id/instances/:name/players/stats', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.players.stats', { name: req.params.name }, 15000));
    } catch (e) {
      next(e);
    }
  });

  // 聊天记录（分页用字节游标 before，返回 nextBefore；过滤条件一律当纯文本）
  router.get('/servers/:id/instances/:name/chat', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const rawLimit = Number(req.query.limit);
    const params = {
      name: req.params.name,
      limit: Math.min(
        Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : CHAT_LIMIT_DEFAULT, 1),
        CHAT_LIMIT_MAX,
      ),
      player: String(req.query.player || '').slice(0, CHAT_FILTER_MAX),
      q: String(req.query.q || '').slice(0, CHAT_KEYWORD_MAX),
    };
    // before 是**字节偏移游标**（上一页的 nextBefore），不是时间戳：
    // 同一毫秒可能有多条记录，用时间戳做游标会漏。非有限/负数视为未给。
    const before = Number(req.query.before);
    if (Number.isFinite(before) && before >= 0) params.before = Math.floor(before);
    try {
      res.json(await agentRead(server, 'instance.chat.log', params, 20000));
    } catch (e) {
      next(e);
    }
  });

  // 清空聊天记录（不可恢复：前端必须二次确认）
  router.post('/servers/:id/instances/:name/chat/clear', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agent(server)('instance.chat.clear', { name: req.params.name }, 15000));
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

  // 启动/重启要宽容一些：Paper 系首启要先预下载原版核心（几分钟），超时太短会让面板
  // 先返回 504，而 Agent 其实还在正常启动。停止仍是即时动作，保持 60s。
  const INSTANCE_OP_TIMEOUT = { start: 300000, restart: 300000, stop: 60000 };
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
          await agent(server)(action, { name: req.params.name, ...(req.body || {}) }, INSTANCE_OP_TIMEOUT[route])
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

  // ---------- spark 性能模组：实时数据（前端轮询）/ profiler 控制 / 健康摘要 ----------
  // 数据本身由 Agent 解析控制台输出得到（spark 无外部查询接口），这里只做透传
  router.get('/servers/:id/instances/:name/spark/stats', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.spark.stats', { name: req.params.name }, 15000));
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/spark/profiler', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const body = req.body || {};
      const timeoutSec = Math.min(Math.max(Math.round(Number(body.timeoutSec) || 60), 15), 600);
      const stop = body.action === 'stop';
      // start 即时返回（报告链接由 Agent 被动捕获）；stop 等上传完成最长 45s
      const waitMs = stop ? 60000 : 20000;
      res.json(
        await agent(server)(
          'instance.spark.profiler',
          { name: req.params.name, action: stop ? 'stop' : 'start', timeoutSec },
          waitMs,
        ),
      );
    } catch (e) {
      next(e);
    }
  });

  router.get('/servers/:id/instances/:name/spark/health', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.spark.health', { name: req.params.name }, 20000));
    } catch (e) {
      next(e);
    }
  });

  // ---------- 封禁目录：查看与解封（运行中走 pardon 命令，停止时改 JSON） ----------
  router.get('/servers/:id/instances/:name/banlist', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'instance.banList', { name: req.params.name }));
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/banlist/unban', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)('instance.banUnban', { name: req.params.name, ...(req.body || {}) }, 15000),
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- server-icon：读取（PNG 二进制）/ 设置（前端压缩到 64x64 的 base64） ----------
  // 没有图标是常态（没上传过），用 204 而不是 404：`<img>` 两种都走 onError 回退到方块图标，
  // 但 404 会在 DevTools 里每次都留一条红色的「Failed to load resource」，把真正的错误埋掉。
  router.get('/servers/:id/instances/:name/icon', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const r = await agentRead(server, 'instance.iconGet', { name: req.params.name });
      if (!r || !r.ok || !r.b64) return res.status(204).end();
      res.setHeader('Content-Type', 'image/png');
      // 图标基本不变，允许浏览器/外壳短缓存
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(Buffer.from(r.b64, 'base64'));
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/instances/:name/icon', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)('instance.iconSet', { name: req.params.name, b64: String((req.body || {}).b64 || '') }, 15000),
      );
    } catch (e) {
      next(e);
    }
  });

  // ---------- 地图（P4-1d）：枚举存档 / 区域 PNG 转发 / 版本协商 ----------
  //
  // 渲染在 Agent 侧完成（见 agent/src/instance/map.js），面板只做转发。
  // 这样前端拿到的就是 PNG 二进制，浏览器原生解码，无需自研瓦片格式。
  //
  // 首帧可能很慢：Agent 要读整个 .mca（几 MB ~ 几十 MB）+ 渲染 512×512 + PNG 编码。
  // 之后走 Agent 的落盘缓存，就是纯读文件。所以超时给得比较宽。
  const MAP_TIMEOUT = 60000;

  /**
   * 存档标识只允许**一级或两级**路径段。
   * 放宽到两级是为了表达原版的多维度嵌套（`world/DIM-1`、`world/DIM1`）；
   * 每一段仍必须是安全的单段名（字母数字与 `_ . -`）且显式拒绝 `.` / `..` ——
   * **放宽的是层数，不是字符集**，`../../etc` 依旧被挡。
   */
  const MAP_SAVE_RE = /^[\w.-]+(\/[\w.-]+)*$/;
  function mapSaveOk(s) {
    const v = String(s || '');
    const segs = v.split('/');
    if (!MAP_SAVE_RE.test(v) || segs.length > 2) return false;
    return segs.every((seg) => seg !== '.' && seg !== '..');
  }

  router.get('/servers/:id/instances/:name/map', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!INST_NAME_RE.test(req.params.name)) return fail(res, 'instance.name-invalid');
    try {
      res.json(await agentRead(server, 'instance.map.saves', { name: req.params.name }, MAP_TIMEOUT));
    } catch (e) {
      next(e);
    }
  });

  router.get('/servers/:id/instances/:name/map/:save/version', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!INST_NAME_RE.test(req.params.name)) return fail(res, 'instance.name-invalid');
    if (!mapSaveOk(req.params.save)) return fail(res, 'map.save-invalid');
    try {
      // 复用 saves 接口：它已经带上每个世界的版本号，不必再开一个 Agent 动作
      const r = await agentRead(server, 'instance.map.saves', { name: req.params.name }, MAP_TIMEOUT);
      const s = (r.saves || []).find((x) => x.save === req.params.save);
      if (!s) return fail(res, 'map.save-not-found');
      res.json({ version: s.version, regions: s.regions });
    } catch (e) {
      next(e);
    }
  });

  /**
   * 清空地图缓存（强制下次重新渲染）。
   *
   * 为什么需要它：Agent 侧的缓存签名原先只看区域文件的 size+mtime，所以
   * 「渲染代码改了、世界文件没变」时旧图不会失效 —— 用户升级 Agent 后
   * 仍然看到旧渲染（例如修位布局之前那批噪点图），而当时**没有任何入口能重来**。
   * 现在签名已带上 AGENT_VERSION（升级即自动失效），这个接口用于**用户主动重来**。
   */
  router.post('/servers/:id/instances/:name/map/refresh', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!INST_NAME_RE.test(req.params.name)) return fail(res, 'instance.name-invalid');
    const b = req.body || {};
    const save = b.save === undefined || b.save === null || b.save === '' ? null : String(b.save);
    if (save !== null && !mapSaveOk(save)) return fail(res, 'map.save-invalid');
    try {
      // 递归删目录是重活，给足超时
      res.json(await agent(server)('instance.map.clearCache', { name: req.params.name, save }, MAP_TIMEOUT));
    } catch (e) {
      next(e);
    }
  });

  router.get('/servers/:id/instances/:name/map/:save/:x/:z', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!INST_NAME_RE.test(req.params.name)) return fail(res, 'instance.name-invalid');
    if (!mapSaveOk(req.params.save)) return fail(res, 'map.save-invalid');
    // `:z` 可能带 `.png` 后缀（前端按图片 URL 用，浏览器与调试都更直观）
    const zRaw = String(req.params.z).replace(/\.png$/i, '');
    const x = Number(req.params.x);
    const z = Number(zRaw);
    if (!Number.isInteger(x) || !Number.isInteger(z)) return fail(res, 'map.coord-invalid');
    try {
      const r = await agentRead(
        server,
        'instance.map.region',
        { name: req.params.name, save: req.params.save, x, z },
        MAP_TIMEOUT,
      );
      if (!r || !r.png) return fail(res, 'map.region-not-found');
      // ETag 直接用 Agent 给的区域签名（大小+mtime 派生）。世界没变 → 版本不变 → 命中 304。
      const etag = `"${r.version}"`;
      res.setHeader('ETag', etag);
      // 派生数据：允许缓存但要能协商。**不加 public**——面板可能带鉴权，不能进共享缓存。
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      // If-None-Match 可能是列表或带 W/ 前缀，用包含判断比全等稳
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && (inm.includes(etag) || inm === '*')) return res.status(304).end();
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from(r.png, 'base64'));
    } catch (e) {
      next(e);
    }
  });

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
      try {
        assertRemoteTargetAllowed(u);
      } catch (e) {
        return reject(e);
      }
      const mod = u.protocol === 'http:' ? require('http') : require('https');
      const req = mod.get(
        u,
        { headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': HTTP_UA } },
        (res) => {
          readBodyCapped(res, req, MAX_REMOTE_BODY, '模型列表响应')
            .then((buf) => {
              const text = buf.toString('utf8');
              if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`));
              }
              try {
                resolve(JSON.parse(text));
              } catch {
                reject(new Error('响应不是合法 JSON'));
              }
            })
            .catch(reject);
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
      try {
        assertRemoteTargetAllowed(u);
      } catch (e) {
        return reject(e);
      }
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
            // 错误体也要有上限：下面虽然只取 300 字符，但原先是**先累积完整 body 再截断**，
            // 一个刻意返回超大错误体的端点照样能打爆内存。
            readBodyCapped(res, req, MAX_REMOTE_BODY, 'AI 错误响应')
              .then((buf) => {
                const t = buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
                reject(new Error(`AI 接口返回 HTTP ${res.statusCode}: ${t}`));
              })
              .catch(() => reject(new Error(`AI 接口返回 HTTP ${res.statusCode}`)));
            return;
          }
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            // 上限保护：这是 SSE 流，正常情况下按行消费、buf 不会涨。
            // 但恶意端点可以**只发数据不发换行**，让 buf 无限增长直到 OOM。
            if (buf.length > MAX_REMOTE_BODY) {
              try {
                req.destroy();
              } catch {}
              reject(new Error('AI 响应过大，已中断'));
              return;
            }
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
      return fail(res, 'ai.connection-incomplete-with-model');
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
      fail(res, 'ai.connect-failed', { detail: e.message });
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
      return fail(res, 'ai.connection-incomplete');
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
      fail(res, 'ai.models-failed', { detail: e.message });
    }
  });

  // 日志分析：SSE 流式返回（POST + text/event-stream，前端用 fetch reader 读取）
  router.post('/servers/:id/instances/:name/ai-analyze', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const st = config.data.settings;
    const ai = st.ai || {};
    if (!ai.enabled) return fail(res, 'ai.disabled');
    if (!ai.apiKey || !ai.model) return fail(res, 'ai.config-incomplete');

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
      return fail(res, 'ai.no-logs');
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

  // 编辑实例元信息（备注 / 连接地址 / 最大内存 / 玩家统计与聊天记录开关）
  router.put('/servers/:id/instances/:name', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    const b = req.body || {};
    const params = { name: req.params.name, note: b.note, address: b.address, memoryMB: b.memoryMB };
    // 两个记录开关（players / chat）：记录在 Agent 侧，面板离线也照记。
    // 只在请求里真的带了 tracking 时才下发——「缺字段 = 不动原值」是 Agent 侧的约定，
    // 这里补一个 undefined 的键虽然当前也无害，但约定就该一眼看得出来。
    if (b.tracking !== undefined) params.tracking = b.tracking;
    try {
      res.json(await agent(server)('instance.edit', params, 15000));
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

  // 定时备份设置（计划任务 + 保留份数）
  router.put('/servers/:id/instances/:name/backup-schedule', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(
        await agent(server)(
          'instance.backupSchedule.set',
          { name: req.params.name, backupSchedule: req.body || {} },
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

  // Java 多版本管理：列表 / 切换默认 / 卸载（Agent 端锁定在 /opt/blocknexus-java 内）
  router.get('/servers/:id/javas', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await agentRead(server, 'java.list', {}, 20000));
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/java-use', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const r = await agent(server)('java.use', { target: (req.body || {}).target }, 60000);
      res.json(r);
      // 切换即时生效，但面板缓存里的 java 信息要等下一轮 sys.info；起轮询把缓存刷过去
      scheduleJavaRefresh(server.id);
    } catch (e) {
      next(e);
    }
  });

  router.post('/servers/:id/java-uninstall', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const r = await agent(server)('java.uninstall', { target: (req.body || {}).target }, 120000);
      res.json(r);
      scheduleJavaRefresh(server.id);
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
    if (installing.has(server.id)) return fail(res, 'server.install-busy');
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
      //    两者都会做**后置核验**：服务/进程/目录任一项没清干净就抛错，不会假报成功。
      let verdict = { alreadyGone: false };
      if (isLocal) {
        verdict =
          (await localAgent.uninstallAgent(server, log, {
            keepBackups: !!b.keepBackups,
            deleteDir: !!b.deleteInstances,
          })) || verdict;
      } else {
        verdict = (await uninstallAgent(server, log)) || verdict;
      }

      // 3) 面板侧状态收尾（无论是否移除记录都要做，否则卡片会残留旧状态）
      //    · 先标静默窗口再断连：kick 的 close 事件是异步的，先设时间戳才能保证
      //      「卸载 → socket 关闭 → offline 状态」这一串事件都被静默窗口盖住。
      //    · 断开可能还挂着的 Agent 连接：systemd 已停，但 socket 不一定立刻关，
      //      不主动断的话卡片还会显示「在线」、点啥都超时。
      //    · 清掉资源快照与版本更新状态：不要让卡片继续显示卸载前的内存/磁盘或「更新中」。
      uninstalledAt.set(server.id, Date.now());
      clearOfflineTracking(server.id);
      const conn = hub.conns.get(server.id);
      if (conn) {
        try {
          conn.kick('Agent 已卸载');
        } catch {}
      }
      statsCache.delete(server.id);
      agentUpdateState.delete(server.id);
      agentUpdateTries.delete(server.id);
      config.updateServer(server.id, { status: 'offline', info: null });

      // 4) 可选：同时从面板移除该服务器
      if (b.removeServer) {
        clearOfflineTracking(server.id);
        uninstalledAt.delete(server.id); // 记录都没了，静默窗口也不必留着
        config.removeServer(server.id);
        hub.stopOutbound(server.id); // 停掉重连循环
        hub.syncOutbound();
        log('已从面板移除该服务器\n');
      }
      taskLogDone(server.id, 'uninstall', {
        done: true,
        ok: true,
        alreadyGone: !!verdict.alreadyGone,
        removed: !!b.removeServer,
      });
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
      // 任务结果：刷新/重开弹窗后也能直接显示「成功/失败 + 实例名」，不必再听一遍 SSE
      ok: s && s.ok !== undefined ? !!s.ok : null,
      error: (s && s.error) || null,
      code: (s && s.code) || null,
      instance: (s && s.instance) || null,
      reused: s && s.reused !== undefined ? !!s.reused : null,
    });
  });

  router.post('/servers/:id/local-agent/start', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!localAgent.isLocalHost(server.host)) {
      return fail(res, 'panel.not-local-server');
    }
    if (installing.has(server.id)) return fail(res, 'server.install-busy');
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
      return fail(res, 'panel.not-local-server');
    }
    if (installing.has(server.id)) return fail(res, 'server.install-busy');
    installing.add(server.id);
    res.json({ ok: true, started: true });
    taskLogReset(server.id, 'uninstall');
    const log = (text) => taskLog(server.id, 'uninstall', text);
    try {
      log('停止本机 Agent（保留实例数据）…\n');
      const r = await localAgent.stopAgent(server, log, { agentRequest: hub.request.bind(hub) });
      // 后置判断：pid 还在就说明没停掉，不能报成功（否则界面显示「已停止」而进程仍占着端口）
      if (r && r.pid && !r.stopped) {
        throw new Error(`进程 ${r.pid} 未在超时内退出，请手动结束`);
      }
      const conn = hub.conns.get(server.id);
      if (conn) {
        try {
          conn.kick('本机 Agent 已停止');
        } catch {}
      }
      statsCache.delete(server.id);
      uninstalledAt.set(server.id, Date.now());
      clearOfflineTracking(server.id);
      config.updateServer(server.id, { status: 'offline' });
      taskLogDone(server.id, 'uninstall', { done: true, ok: true, stopped: true });
    } catch (e) {
      log('✗ 停止失败: ' + e.message + '\n');
      taskLogDone(server.id, 'uninstall', { done: true, ok: false, error: e.message });
    } finally {
      installing.delete(server.id);
      config.updateServer(server.id, { installing: false });
    }
  });

  // ---------- 网络助手：DDNS / frp（可选，默认关闭） ----------
  //
  // 两者都只服务"家里/公司电脑开服"的玩家：DDNS 让域名跟上动态公网 IP，
  // frp 让没有公网 IP 的用户也能被外网访问。实现原则：
  //   · DDNS 只做"取 IP → 变了才写 → 记状态"，纯逻辑在 panel/ddns.js（可单测）；
  //   · frp 只托管**用户自己的** frpc（不打包二进制），逻辑在 panel/frp.js；
  //   · 凭据读取一律掩码，写入时空值表示保留原值（与 SMTP 同一约定）。

  const DDNS_BACKOFF = [5 * 60e3, 10 * 60e3, 30 * 60e3];
  const ddnsState = {
    running: false,
    busy: false,
    lastAt: 0,
    nextAt: 0,
    result: '',
    error: '',
    ipv4: '',
    ipv6: '',
    fails: 0,
    log: [],
  };
  let ddnsTimer = null;
  let ddnsBootTimer = null;

  function ddnsLog(text) {
    ddnsState.log.push({ at: Date.now(), text: String(text) });
    if (ddnsState.log.length > 50) ddnsState.log.splice(0, ddnsState.log.length - 50);
  }

  function ddnsStatus() {
    return {
      running: ddnsState.running,
      busy: ddnsState.busy,
      lastAt: ddnsState.lastAt || null,
      nextAt: ddnsState.nextAt || null,
      result: ddnsState.result,
      error: ddnsState.error,
      ipv4: ddnsState.ipv4,
      ipv6: ddnsState.ipv6,
      log: ddnsState.log.slice(-20),
    };
  }

  function ddnsNextDelay() {
    const cfg = config.data.settings.ddns || {};
    const ms = ddns.clampInterval(cfg.intervalSec) * 1000;
    if (!ddnsState.fails) return ms;
    return Math.max(ms, DDNS_BACKOFF[Math.min(ddnsState.fails - 1, DDNS_BACKOFF.length - 1)]);
  }

  async function ddnsSync(reason = 'auto') {
    if (ddnsState.busy) return { busy: true, ...ddnsStatus() };
    const cfg = config.data.settings.ddns || {};
    if (!cfg.enabled) {
      ddnsState.result = 'disabled';
      return ddnsStatus();
    }
    ddnsState.busy = true;
    let failed = false;
    try {
      const families = [];
      if (cfg.ipv4) families.push(4);
      if (cfg.ipv6) families.push(6);
      if (!families.length) {
        failed = true;
        ddnsState.error = '没有选择 IPv4/IPv6';
      }
      for (const family of families) {
        const type = family === 4 ? 'A' : 'AAAA';
        const source = family === 6 ? cfg.sourceIPv6 || cfg.source : cfg.source;
        const det = await ddns.detectIp({
          family,
          source,
          sourceUrl: cfg.sourceUrl,
          command: cfg.command,
        });
        if (!det.ip) {
          failed = true;
          ddnsState.error = det.error || `未取到 IPv${family}`;
          ddnsLog(`IPv${family}: ${ddnsState.error}`);
          continue;
        }
        const last = family === 4 ? ddnsState.ipv4 : ddnsState.ipv6;
        if (!ddns.needsUpdate(last, det.ip)) {
          ddnsLog(`IPv${family}: ${det.ip} 未变化`);
          continue;
        }
        try {
          const r = await ddns.applyRecord({
            provider: cfg.provider,
            cfg,
            domain: cfg.domain,
            type,
            ip: det.ip,
            ttl: cfg.ttl,
          });
          if (family === 4) ddnsState.ipv4 = det.ip;
          else ddnsState.ipv6 = det.ip;
          ddnsLog(`IPv${family}: ${det.ip} → ${cfg.domain}（${r.action === 'created' ? '新建记录' : '更新记录'}）`);
        } catch (e) {
          failed = true;
          ddnsState.error = e.message;
          ddnsLog(`IPv${family}: 更新失败 — ${e.message}`);
        }
      }
      ddnsState.result = failed ? 'error' : 'ok';
      if (!failed) ddnsState.error = '';
    } catch (e) {
      failed = true;
      ddnsState.result = 'error';
      ddnsState.error = e.message;
      ddnsLog(`同步失败 — ${e.message}`);
    } finally {
      ddnsState.busy = false;
      ddnsState.lastAt = Date.now();
      ddnsState.fails = failed ? ddnsState.fails + 1 : 0;
      ddnsState.nextAt = Date.now() + ddnsNextDelay();
      if (reason === 'manual') ddnsLog('手动同步完成');
    }
    return ddnsStatus();
  }

  function ddnsStop() {
    if (ddnsTimer) {
      clearTimeout(ddnsTimer);
      ddnsTimer = null;
    }
    if (ddnsBootTimer) {
      clearTimeout(ddnsBootTimer);
      ddnsBootTimer = null;
    }
    ddnsState.running = false;
    ddnsState.nextAt = 0;
  }

  function ddnsSchedule() {
    ddnsStop();
    const cfg = config.data.settings.ddns || {};
    if (!cfg.enabled) return;
    ddnsState.running = true;
    const tick = () => {
      const cur = config.data.settings.ddns || {};
      if (!cur.enabled) return ddnsStop();
      void ddnsSync('auto').finally(() => {
        if (!(config.data.settings.ddns || {}).enabled) return;
        const delay = ddnsNextDelay();
        ddnsState.nextAt = Date.now() + delay;
        ddnsTimer = setTimeout(tick, delay);
        if (ddnsTimer.unref) ddnsTimer.unref();
      });
    };
    ddnsState.nextAt = Date.now() + 5000;
    ddnsBootTimer = setTimeout(tick, 5000); // 启动后 5 秒先跑一次，避免和面板启动抢资源
    if (ddnsBootTimer.unref) ddnsBootTimer.unref();
  }

  router.get('/network/ddns', (req, res) => {
    res.json({ config: ddns.publicConfig(config.data.settings.ddns || {}), status: ddnsStatus() });
  });

  router.put('/network/ddns', (req, res) => {
    const r = ddns.normalizeConfig(req.body || {}, config.data.settings.ddns || {});
    if (r.error) return fail(res, r.error, r.params);
    config.data.settings.ddns = r.config;
    config.save();
    ddnsState.fails = 0;
    ddnsSchedule();
    res.json({ ok: true, config: ddns.publicConfig(r.config), status: ddnsStatus() });
  });

  /** 只检测当前公网 IP（不写记录）；允许带临时参数，免去"先保存再测试" */
  router.post('/network/ddns/check', async (req, res, next) => {
    try {
      const b = req.body || {};
      const cur = config.data.settings.ddns || {};
      res.json(
        await ddns.detectBoth({
          ipv4: b.ipv4 !== undefined ? !!b.ipv4 : cur.ipv4 !== false,
          ipv6: b.ipv6 !== undefined ? !!b.ipv6 : !!cur.ipv6,
          source: b.source || cur.source || 'api',
          sourceUrl: b.sourceUrl !== undefined ? b.sourceUrl : cur.sourceUrl,
          sourceIPv6: b.sourceIPv6 !== undefined ? b.sourceIPv6 : cur.sourceIPv6,
          command: b.command !== undefined ? b.command : cur.command,
        }),
      );
    } catch (e) {
      next(e);
    }
  });

  router.post('/network/ddns/run', async (req, res, next) => {
    try {
      res.json(await ddnsSync('manual'));
    } catch (e) {
      next(e);
    }
  });

  // ---------- frp 客户端托管 ----------
  const frpMgr = new frp.FrpManager({
    dir: path.join(__dirname, '..', 'data', 'frp'),
    onLog: (t) => console.log('[frp] ' + t),
  });
  frpManagers.add(frpMgr);
  let frpBusy = false;

  function frpStatus() {
    return {
      ...frpMgr.status(),
      config: frp.publicConfig(config.data.settings.frp || {}),
      // 给前端「提前警示」用：保存前就能看到「代理通了面板端口但没开登录保护」
      exposure: { ...frp.exposureRisk(config.data.settings.frp || {}, frpExposureOpts()), ...frpExposureOpts() },
    };
  }

  /**
   * frp 暴露面板的风险判定参数：面板端口 + 是否可能被外部访问 + 是否已开登录保护。
   * 判定本身在 panel/frp.js 的 exposureRisk（纯函数，有单测），这里只负责取当前值。
   */
  function frpExposureOpts() {
    const panel = config.data.panel || {};
    return {
      panelPort: Number(panel.port) || 0,
      mayBeExposed: !!opts.mayBeExposed,
      authEnabled: !!panel.authEnabled,
    };
  }

  /** 命中暴露风险时返回 { error, params }，否则 null */
  function frpExposureError(cfg) {
    const risk = frp.exposureRisk(cfg, frpExposureOpts());
    return risk.risky ? { error: 'network.frp-exposes-panel', params: { port: String(risk.port) } } : null;
  }

  router.get('/network/frp', (req, res) => {
    res.json(frpStatus());
  });

  router.put('/network/frp', async (req, res) => {
    if (frpBusy) return fail(res, 'network.frp-busy');
    const r = frp.normalizeConfig(req.body || {}, config.data.settings.frp || {});
    if (r.error) return fail(res, r.error, r.params);
    // 把「面板端口」经 frp 通出去却没开登录保护 = 整台面板交给公网，保存阶段就拦
    if (r.config.enabled) {
      const ex = frpExposureError(r.config);
      if (ex) return fail(res, ex.error, ex.params);
    }
    frpBusy = true;
    try {
      const wasRunning = frpMgr.running();
      config.data.settings.frp = r.config;
      config.save();
      let started = false;
      let error = '';
      if (!r.config.enabled) {
        if (wasRunning) await frpMgr.stop();
      } else if (wasRunning) {
        // 运行中改配置：重启让新配置生效；重启失败保留"未运行"状态并把原因带回去
        try {
          await frpMgr.restart(r.config);
          started = true;
        } catch (e) {
          error = `${e.message}${e.detail ? '：' + e.detail : ''}`;
        }
      }
      res.json({ ok: true, started, error, config: frp.publicConfig(r.config), status: frpMgr.status() });
    } finally {
      frpBusy = false;
    }
  });

  // ---------- 粘贴樱花「手动配置」导入 ----------
  //
  // 樱花后台给的是一段 TOML（user + auth.token + 关 TLS + [[proxies]]）。让用户直接粘贴、
  // 面板挑字段，比对着表单手抄 6 个值可靠——而且 user / transport.tls 这两项原表单根本没有，
  // 缺了就会被樱花节点拒绝登录（实测报错 "make sure token and user was set correctly"）。
  //
  // 语义：**只覆盖 upstream 段**并把模式切到 upstream；不改 enabled；运行中就重启让新配置生效。
  router.post('/network/frp/import', async (req, res) => {
    if (frpBusy) return fail(res, 'network.frp-busy');
    const parsed = frp.parseSakuraConfig((req.body || {}).text);
    if (parsed.error) return fail(res, parsed.error, parsed.params);

    const cur = config.data.settings.frp || {};
    const next = {
      ...cur,
      mode: 'upstream',
      sakura: { ...(cur.sakura || {}) },
      upstream: {
        ...(cur.upstream || {}),
        user: parsed.value.user,
        authToken: parsed.value.authToken,
        serverAddr: parsed.value.serverAddr,
        serverPort: parsed.value.serverPort,
        // 粘贴内容里写了 transport.tls.enable 就照抄；没写 = null = 不输出，沿用 frpc 默认值
        tlsEnable: parsed.value.tlsEnable,
        proxies: parsed.value.proxies,
      },
    };
    if (parsed.value.tunnelIds.length) next.sakura.tunnels = parsed.value.tunnelIds.join(',');

    const r = frp.normalizeConfig(next, cur);
    if (r.error) return fail(res, r.error, r.params);
    const ex = r.config.enabled ? frpExposureError(r.config) : null;
    if (ex) return fail(res, ex.error, ex.params);

    frpBusy = true;
    try {
      const wasRunning = frpMgr.running();
      config.data.settings.frp = r.config;
      config.save();
      let restarted = false;
      let error = '';
      if (wasRunning && r.config.enabled) {
        try {
          await frpMgr.restart(r.config);
          restarted = true;
        } catch (e) {
          error = `${e.message}${e.detail ? '：' + e.detail : ''}`;
        }
      }
      res.json({
        ok: true,
        restarted,
        error,
        tunnelIds: parsed.value.tunnelIds,
        config: frp.publicConfig(r.config),
        status: frpMgr.status(),
      });
    } finally {
      frpBusy = false;
    }
  });

  /** 启动/停止/重启：共用一把"在途"锁，避免连点造成两个 frpc */
  async function frpAction(action, res) {
    if (frpBusy) return fail(res, 'network.frp-busy');
    const cfg = config.data.settings.frp || {};
    if (!cfg.enabled) return fail(res, 'network.frp-disabled');
    if (action !== 'stop') {
      const ex = frpExposureError(cfg);
      if (ex) return fail(res, ex.error, ex.params);
    }
    frpBusy = true;
    try {
      if (action === 'stop') {
        const r = await frpMgr.stop();
        return res.json({ ok: true, ...r, status: frpMgr.status() });
      }
      if (action === 'restart') await frpMgr.stop();
      const r = await frpMgr.start(cfg);
      return res.json({ ok: true, ...r, status: frpMgr.status() });
    } catch (e) {
      // 保留 frp.js 给出的具体错误码（二进制缺失 / 樱花模式不兼容），其余归为启动失败
      const code = e.code && String(e.code).startsWith('network.') ? e.code : 'network.frp-start-failed';
      return fail(res, code, {
        detail: String(e.detail || e.message).slice(0, 500),
      });
    } finally {
      frpBusy = false;
    }
  }

  router.post('/network/frp/start', (req, res) => frpAction('start', res));
  router.post('/network/frp/stop', (req, res) => frpAction('stop', res));
  router.post('/network/frp/restart', (req, res) => frpAction('restart', res));

  // ---------- 单实例 frp：在实例页直接绑一个公网端口 ----------
  //
  // 背景：设置里的「代理列表」要手填 `名称,本地端口,远程端口`，很容易写错/写重。
  // 这里把「给某个实例开一个公网端口」做成实例级操作：
  //   · 本地端口永远取实例当前端口（不会写错）；
  //   · 代理名自动生成，远程端口冲突在保存前就拦掉；
  //   · 改完配置后 frpc 正在运行就自动重启应用，不用再回设置页点重启。

  function frpProxyName(instanceName, proxies) {
    const base = ('mc-' + String(instanceName).replace(/[^A-Za-z0-9_.-]/g, '-')).slice(0, 60);
    const clash = (proxies || []).some((p) => p && p.name === base);
    if (!clash) return base;
    // 同名代理属于别的实例：加随机后缀，绝不覆盖别人的条目
    return (base.slice(0, 55) + '-' + Math.random().toString(36).slice(2, 6)).slice(0, 63);
  }

  async function frpInstanceInfo(server, instanceName) {
    const cfg = config.data.settings.frp || {};
    const host = String(server.host || '').trim();
    const isLocal = localAgent.isLocalHost(host);
    // 面板托管的 frpc 只能转发「面板能直连的地址」：本机 → 127.0.0.1；局域网/主机名 → 服务器地址；
    // 公网 IP → 不在这里做（那台机器本来就该直接对外，或由它自己跑 frpc）。判断集中在 frp.frpTarget。
    const target = frp.frpTarget(host, isLocal);
    const lan = target.lan;
    const info = {
      supported: false,
      reason: '',
      frpEnabled: !!cfg.enabled,
      frpcRunning: frpMgr.running(),
      mode: cfg.mode || 'sakura',
      serverAddr: String((cfg.upstream && cfg.upstream.serverAddr) || '').trim(),
      localPort: 0,
      // 目标地址：frpc 实际连接的 host（本机是 127.0.0.1，局域网是服务器内网 IP）
      targetHost: target.targetHost,
      lan,
      bound: false,
      remotePort: 0,
      publicAddress: '',
      proxyName: '',
    };
    if (!lan) {
      info.reason = 'not-local';
      return info;
    }
    try {
      const list = await agentRead(server, 'instance.list', {}, 15000);
      const arr = Array.isArray(list) ? list : (list && list.value) || [];
      const inst = arr.find((i) => i && i.name === instanceName);
      info.localPort = inst ? Number(inst.port) || 0 : 0;
    } catch {
      info.localPort = 0;
    }
    if ((cfg.mode || 'sakura') === 'sakura') {
      info.reason = 'sakura';
      return info;
    }
    info.supported = true;
    const proxies = (cfg.upstream && Array.isArray(cfg.upstream.proxies) && cfg.upstream.proxies) || [];
    const hit = proxies.find((p) => p && info.localPort > 0 && Number(p.localPort) === info.localPort);
    if (hit) {
      info.bound = true;
      info.remotePort = Number(hit.remotePort) || 0;
      info.proxyName = hit.name || '';
      info.publicAddress = info.serverAddr ? `${info.serverAddr}:${info.remotePort}` : String(info.remotePort);
    }
    return info;
  }

  router.get('/servers/:id/instances/:name/frp', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      res.json(await frpInstanceInfo(server, req.params.name));
    } catch (e) {
      next(e);
    }
  });

  router.put('/servers/:id/instances/:name/frp', async (req, res, next) => {
    const server = requireServer(req, res);
    if (!server) return;
    try {
      const cfg = config.data.settings.frp || {};
      if ((cfg.mode || 'sakura') === 'sakura') return fail(res, 'frp.sakura-manual');
      if (!cfg.enabled) return fail(res, 'frp.disabled');
      const before = await frpInstanceInfo(server, req.params.name);
      // 公网地址的远程服务器不在这里做（面板 frpc 到不了；应由那台机器自己跑 frpc）
      if (!before.lan) return fail(res, 'frp.not-local');
      if (!before.localPort) return fail(res, 'frp.instance-not-found');
      const body = req.body || {};
      const enabled = body.enabled !== false;
      cfg.upstream = cfg.upstream || {};
      const proxies = Array.isArray(cfg.upstream.proxies) ? cfg.upstream.proxies : [];
      const idx = proxies.findIndex((p) => p && Number(p.localPort) === before.localPort);

      if (!enabled) {
        if (idx >= 0) proxies.splice(idx, 1);
        cfg.upstream.proxies = proxies;
        config.data.settings.frp = cfg;
        config.save();
        let restarted = false;
        if (frpMgr.running()) {
          await frpMgr.restart(cfg);
          restarted = true;
        }
        return res.json({ ok: true, restarted, ...(await frpInstanceInfo(server, req.params.name)) });
      }

      const remotePort = Number(body.remotePort);
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
        return fail(res, 'frp.remote-port-invalid');
      }
      if (proxies.some((p, i) => i !== idx && p && Number(p.remotePort) === remotePort)) {
        return fail(res, 'frp.port-in-use', { port: remotePort });
      }
      const name = idx >= 0 ? proxies[idx].name : frpProxyName(req.params.name, proxies);
      // localIP：本机实例是 127.0.0.1；局域网实例用服务器内网地址（frpc 直接连过去）
      const entry = {
        name,
        type: 'tcp',
        localPort: before.localPort,
        remotePort,
        localIP: before.targetHost || '127.0.0.1',
      };
      if (idx >= 0) proxies[idx] = entry;
      else proxies.push(entry);
      cfg.upstream.proxies = proxies;
      config.data.settings.frp = cfg;
      config.save();

      let restarted = false;
      let error = '';
      if (frpMgr.running()) {
        try {
          await frpMgr.restart(cfg);
          restarted = true;
        } catch (e) {
          error = e.message;
        }
      }
      res.json({ ok: true, restarted, error, ...(await frpInstanceInfo(server, req.params.name)) });
    } catch (e) {
      next(e);
    }
  });


  // 启动调度：DDNS 立即按配置起；frp 若已启用则 5 秒后自动拉起（失败只记日志，不阻塞面板）
  ddnsSchedule();
  {
    const cfg = config.data.settings.frp || {};
    if (cfg.enabled && !frpMgr.running()) {
      const t = setTimeout(() => {
        const cur = config.data.settings.frp || {};
        if (!cur.enabled || frpMgr.running()) return;
        frpMgr.start(cur).catch((e) => console.error('[frp] 自动启动失败:', e.message));
      }, 5000);
      if (t.unref) t.unref();
    }
  }

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
    const lang = langOf(req);
    if (!err) return res.status(500).json(errorResponse('internal.error', undefined, { lang }).body);
    // 已知的通道故障 → 稳定 code（状态码取自码表）
    const known = err.code === 'AGENT_OFFLINE' ? 'agent.offline'
      : err.code === 'AGENT_TIMEOUT' ? 'agent.timeout'
        : null;
    if (known) {
      const { status, body } = errorResponse(known, undefined, { lang });
      // 保留 Agent 的原始说明作为 error 文案（排查时需要它），code 给前端做本地化与分支
      return res.status(status).json({ error: err.message || body.error, code: body.code });
    }
    // 其余：保留原始 message，避免丢失排查细节；code 标为 internal.error
    const fb = errorResponse('internal.error', undefined, { lang }).body;
    res.status(err.status || 500).json({ error: err.message || fb.error, code: fb.code });
  });

  return router;
}

module.exports = { createApi, __setTestHook, langOf, readBodyCapped, MAX_REMOTE_BODY, assertRemoteTargetAllowed };
