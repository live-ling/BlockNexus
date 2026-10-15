'use strict';
// BlockNexus Agent — 玩家在线时长统计与聊天记录（解析 + Agent 侧落盘）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
//
// 为什么解析与存储都在 Agent 侧：
//   这些信息只存在于 MC 服务端进程的 stdout 里。面板不保证长期在线（关掉浏览器、
//   换台机器、断网几小时都很正常），而控制台行是**流式**的——断开期间没人消费就永远
//   丢了。所以「谁玩了多久、说了什么」必须由 Agent 边收边解析边落盘，面板只负责读取。
//
// 存储位置：<实例目录>/.blocknexus-data/（与 .blocknexus-map 同级，跟着实例走）
//   · players.json — 每玩家的累计时长/会话数/首次与最近记录
//   · chat.ndjson  — 一行一条 JSON 的聊天记录（追加写 + 超限轮转）
//   ⚠ 刻意**不**从备份里排除（与地图缓存相反）：backupRestore 会先清空实例目录再解包，
//     排除了就等于「恢复一次备份丢一段历史」。这两个文件体积有硬上限（统计 ≤4MB 装载上限、
//     聊天 2MB 轮转），进备份的代价可控。
//   ⚠ 权限：目录 0700、文件 0600。聊天记录含玩家名与聊天内容（明文），
//     同机其他用户不应读到——这也是「注意安全」的落点之一。

const fs = require('fs');
const path = require('path');
const { sendEvent } = require('../eventbus.js');

// ---------- 常量（上限一律取「足够用 + 有明确边界」的档位） ----------

/** 每实例的 BlockNexus 数据目录名（根级点号目录 = 工具内部数据，文件管理器里隐藏） */
const PLAYER_DATA_DIR = '.blocknexus-data';
const STATS_FILE = 'players.json';
const CHAT_FILE = 'chat.ndjson';

/**
 * 每个实例最多跟踪多少名玩家。
 * 表满时淘汰「最近在线时间最早」的那位（与 loginFails 的「表满淘汰最旧而非拒绝服务」
 * 同一思路）。1000 人 × 每人约 200 字节 ≈ 200KB，对 80MB 内存目标可忽略。
 */
const MAX_TRACKED_PLAYERS = 1000;

/** 聊天记录文件上限；超出后在 flush 时保留最新 75% 字节（一次轮转即回到上限以下） */
const CHAT_MAX_BYTES = 2 * 1024 * 1024;
/** 单条消息最大字符数（含表情/私聊正文），防止个别超长行把文件撑爆 */
const CHAT_MAX_RECORD_CHARS = 512;
/** 内存中待落盘记录的上限：磁盘写不进去时也不能让内存无限增长 */
const CHAT_PENDING_MAX = 200;
/** 落盘 + 推送事件的时间片（同一次 flush 完成两件事，聊天延迟 ≤1.5s） */
const CHAT_FLUSH_MS = 1500;
/** 待落盘记录达到这个数量就立即 flush（高活跃服务器不必等时间片） */
const CHAT_FLUSH_MAX = 100;
/** 单次读取的字节窗口：只读文件尾部这一段，避免「文件多大就吃多少内存」 */
const CHAT_READ_WINDOW_BYTES = 512 * 1024;
/** 单页记录数（缺省 / 上限）与单页总字符预算（加密通道上的一帧别太大） */
const CHAT_PAGE_DEFAULT = 100;
const CHAT_PAGE_MAX = 300;
const CHAT_PAGE_MAX_CHARS = 96 * 1024;

/** 在线时长的落盘节拍：在线玩家的时长按分钟结算并写入（崩溃最多丢 1 分钟） */
const STATS_FLUSH_MS = 60e3;
/** players.json 的装载上限：超过按损坏处理（改名留档后从空开始） */
const STATS_LOAD_MAX_BYTES = 4 * 1024 * 1024;

/** 两类记录的默认开关（元数据里没写时用；可在「编辑实例」里分别关闭） */
const TRACKING_DEFAULT = { players: true, chat: true };

/** 日志前缀：一个或多个 `[...]` 段 + 冒号。vanilla/Paper 是 `[时间] [线程/级别]:`，
 *  Forge 系还会多一段 `[mod/Class]:`——统一吃掉，比只认一段更耐版本差异。 */
const LOG_PREFIX_RE = /^(?:\[[^\]]*\]\s*)+:\s*/;

/** 聊天正文里的控制字符（保留 \t \n \r，随后折成空格） */
const CTRL_RE = /[\x00-\x08\x0B-\x1F\x7F]/g;

// 三种可识别的聊天形态（都作用在**剥掉日志前缀之后**的正文上）
//   普通聊天：<Steve> hello（Paper 未签名时前面还有 [Not Secure] ）
//   表情动作：* Steve waves（/me）
//   悄悄话：  Steve whispers to Alex: hi / Steve whispers to you: hi
// 正文用 [\s\S]* 而不是 .*：控制台行本该没有换行（行缓冲器已保证），但万一混进来，
// 用 .* 会整条静默丢弃；交给 cleanChatText 折成空格更符合「尽量留住记录」的取舍。
const CHAT_RE = /^<([^\s>]{1,32})>\s?([\s\S]*)$/;
const EMOTE_RE = /^\*\s+([^\s>]{1,32})\s+([\s\S]*)$/;
const WHISPER_RE = /^([^\s>]{1,32}) whispers to (?:you|[^\s:]{1,32}):\s?([\s\S]*)$/;

const NOT_SECURE_PREFIX = '[Not Secure] ';

/** 数字兜底：任何非有限值都当 0（文件可能被人改坏，绝不让 NaN 传播进统计） */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = {
  // ---------- 路径（唯一的目录/文件拼接点，实例名先经 get() 校验存在） ----------

  playerDataDir(name) {
    return path.join(this.instanceRoot(name), PLAYER_DATA_DIR);
  },

  statsFile(name) {
    return path.join(this.playerDataDir(name), STATS_FILE);
  },

  chatFile(name) {
    return path.join(this.playerDataDir(name), CHAT_FILE);
  },

  /** 目录 0700 / 文件 0600 的纠正（POSIX 有效；Windows 上 statSync 的 mode 无意义，直接跳过） */
  securePath(p, mode) {
    if (process.platform === 'win32') return;
    try {
      const cur = fs.statSync(p).mode & 0o777;
      if (cur & (mode === 0o700 ? 0o077 : 0o177)) fs.chmodSync(p, mode);
    } catch {}
  },

  /** 可注入时钟：测试用 _nowOverride 步进时间，避免 sleep */
  agentsNow() {
    return typeof this._nowOverride === 'number' ? this._nowOverride : Date.now();
  },

  /** 该实例的两类记录开关（缺省全开；老实例元数据里没有 tracking 字段） */
  trackingCfg(rec) {
    const t = (rec && rec.meta && rec.meta.tracking) || {};
    return {
      players: t.players === undefined ? TRACKING_DEFAULT.players : !!t.players,
      chat: t.chat === undefined ? TRACKING_DEFAULT.chat : !!t.chat,
    };
  },

  /** 写盘失败/文件损坏的提示：同一实例 5 分钟最多一行，避免刷屏控制台 */
  dataWarn(rec, label, e) {
    const now = Date.now();
    if (rec.dataWarnAt && now - rec.dataWarnAt < 300e3 && rec.dataWarnMsg === label) return;
    rec.dataWarnAt = now;
    rec.dataWarnMsg = label;
    try {
      this.emitConsole(rec, `[BlockNexus] ${label} 失败: ${e && e.message ? e.message : e}`);
    } catch {}
  },

  // ---------- 聊天记录：解析 ----------

  /** 剥掉日志前缀（`[12:34:56] [Server thread/INFO]: `）——玩家跟踪与聊天解析共用 */
  stripLogPrefix(line) {
    const s = String(line == null ? '' : line);
    const m = LOG_PREFIX_RE.exec(s);
    return m ? s.slice(m[0].length) : s;
  },

  /** 正文清洗：去控制字符、折行、截断。返回值可能为空串（调用方据此丢弃） */
  cleanChatText(text) {
    return String(text == null ? '' : text)
      .replace(CTRL_RE, '')
      .replace(/[\t\r\n]+/g, ' ')
      .trim()
      .slice(0, CHAT_MAX_RECORD_CHARS);
  },

  /**
   * 组装一条聊天记录（名字与正文都要非空；名字不能是纯 `*`——
   * 否则 `* * * Server overloaded * * *` 这类插件行会被当成表情动作）。
   */
  chatRecord(kind, name, text) {
    const n = this.cleanChatText(name).slice(0, 32);
    const m = this.cleanChatText(text);
    if (!n || !m || /^\*+$/.test(n)) return null;
    return { k: kind, n, m };
  },

  /**
   * 解析一行控制台输出里的聊天（纯函数，便于表驱动测试）。
   * 只认玩家聊天 / 表情 两类；私聊见 parseWhisperLine。
   * 加入离开、成就死亡、插件日志、BlockNexus 自身提示一律返回 null ——
   * 用户明确要求「不存系统消息」。
   * @returns {{k:'chat'|'emote', n:string, m:string} | null}
   */
  parseChatLine(line) {
    if (typeof line !== 'string' || !line) return null;
    let s = this.stripLogPrefix(line).trim();
    if (!s) return null;
    if (s.startsWith(NOT_SECURE_PREFIX)) s = s.slice(NOT_SECURE_PREFIX.length).trim();
    let m = CHAT_RE.exec(s);
    if (m) return this.chatRecord('chat', m[1], m[2]);
    m = EMOTE_RE.exec(s);
    if (m) return this.chatRecord('emote', m[1], m[2]);
    return null;
  },

  /** 私聊单独判（正文里没有尖括号，与上面两条互斥，顺序无关） */
  parseWhisperLine(line) {
    if (typeof line !== 'string' || !line) return null;
    const s = this.stripLogPrefix(line).trim();
    const m = WHISPER_RE.exec(s);
    if (!m) return null;
    return this.chatRecord('whisper', m[1], m[2]);
  },

  // ---------- 聊天记录：写入 ----------

  /**
   * 从控制台行收一条聊天（emitConsole 调用）。
   * 不匹配就什么都不做；写了也只是进内存缓冲，由定时器批量落盘。
   */
  recordChat(rec, line) {
    if (!this.trackingCfg(rec).chat) return;
    const parsed = this.parseChatLine(line) || this.parseWhisperLine(line);
    if (!parsed) return;
    if (!rec.chatPending) rec.chatPending = [];
    rec.chatPending.push({ t: this.agentsNow(), k: parsed.k, n: parsed.n, m: parsed.m });
    // 磁盘写不进去时缓冲也不能无限涨：超限丢最旧的
    if (rec.chatPending.length > CHAT_PENDING_MAX) {
      rec.chatPending.splice(0, rec.chatPending.length - CHAT_PENDING_MAX);
    }
    if (rec.chatPending.length >= CHAT_FLUSH_MAX) {
      this.flushChat(rec);
      return;
    }
    if (!rec.chatTimer) {
      rec.chatTimer = setTimeout(() => {
        rec.chatTimer = null;
        this.flushChat(rec);
      }, CHAT_FLUSH_MS);
      // 定时器不该拖住进程退出
      if (rec.chatTimer.unref) rec.chatTimer.unref();
    }
  },

  /** 缓冲超过上限时轮转：保留最新 75% 的完整行（tmp + rename 原子替换） */
  rotateChatFile(file, incomingBytes) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 文件还不存在，无需轮转
    }
    if (size + incomingBytes <= CHAT_MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = Math.floor(lines.length * 0.75);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep > 0 ? lines.slice(lines.length - keep).join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, file);
  },

  /**
   * 把待落盘的聊天记录追加进 chat.ndjson，并把这一批推给面板（实时显示走事件，
   * 历史读取走 chatLog）。写盘失败不影响推送——面板仍能实时看到，只是不落历史。
   */
  flushChat(rec) {
    const pending = rec.chatPending;
    if (!pending || !pending.length) return;
    rec.chatPending = [];
    let text = '';
    for (const r of pending) text += JSON.stringify(r) + '\n';
    try {
      const dir = this.playerDataDir(rec.meta.name);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = this.chatFile(rec.meta.name);
      this.rotateChatFile(file, Buffer.byteLength(text, 'utf8'));
      fs.appendFileSync(file, text, { mode: 0o600 });
      this.securePath(file, 0o600);
      this.securePath(dir, 0o700);
    } catch (e) {
      this.dataWarn(rec, '写入聊天记录', e);
    }
    sendEvent('chat', { instance: rec.meta.name, records: pending });
  },

  /**
   * 读取聊天记录（分页 + 过滤）。
   *
   * 分页用**字节偏移游标**而不是时间戳：同一毫秒可能有多条记录，用时间戳做
   * `t < before` 会跳过同毫秒的其余记录。响应里的 nextBefore 直接来自行偏移，
   * 精确、无重、无漏。
   *
   * 只读文件尾部 512KB 的窗口 —— 内存占用与文件大小无关。
   * 文件被轮转或清空过（before > 当前 size）时回 reset=true + 最新一页，
   * 前端据此清空重载，而不是显示错位记录。
   */
  chatLog(name, opts = {}) {
    const p = this.chatFile(name);
    const out = {
      instance: name,
      now: this.agentsNow(),
      size: 0,
      records: [],
      more: false,
      nextBefore: 0,
      reset: false,
    };
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      return out; // 还没有记录
    }
    out.size = size;

    const limitRaw = Math.round(Number(opts.limit));
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : CHAT_PAGE_DEFAULT, 1), CHAT_PAGE_MAX);
    // 过滤条件一律当**字面量**处理（不构造 RegExp：用户输入不该有能力触发 ReDoS）
    const player = typeof opts.player === 'string' ? opts.player.trim().slice(0, 32) : '';
    const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, 64) : '';

    let end = Number(opts.before);
    if (!Number.isFinite(end) || end < 0) end = size;
    if (end > size) {
      out.reset = true; // 文件变小过（轮转/清空）→ 游标失效
      end = size;
    }
    end = Math.floor(end);
    const start = Math.max(0, end - CHAT_READ_WINDOW_BYTES);

    let buf;
    try {
      const len = end - start;
      buf = Buffer.alloc(len);
      const fd = fs.openSync(p, 'r');
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return out;
    }

    const lines = buf.toString('utf8').split('\n');
    // start>0 时首行是从中间截断的残段：丢掉，否则会解析出半条记录
    const firstIdx = start > 0 ? 1 : 0;
    const rows = [];
    let cursor = start;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const off = cursor;
      cursor += Buffer.byteLength(raw, 'utf8') + 1; // +1 = 换行符
      if (i < firstIdx || !raw) continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue; // 坏行跳过，绝不让一行脏数据把接口打挂
      }
      if (!obj || typeof obj !== 'object' || typeof obj.m !== 'string') continue;
      const n = String(obj.n == null ? '' : obj.n);
      if (player && n !== player) continue;
      if (q && !obj.m.toLowerCase().includes(q.toLowerCase()) && !n.toLowerCase().includes(q.toLowerCase())) continue;
      rows.push({ off, t: num(obj.t) || this.agentsNow(), k: String(obj.k || 'chat'), n, m: obj.m });
    }

    // 从最新往回取：先满足条数，再满足总字符预算（至少给 1 条，保证翻页能前进）
    const picked = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const cost = r.m.length + r.n.length + 48;
      if (picked.length >= limit) break;
      if (picked.length && chars + cost > CHAT_PAGE_MAX_CHARS) break;
      chars += cost;
      picked.push(r);
    }
    picked.reverse();
    out.records = picked.map((r) => ({ t: r.t, k: r.k, n: r.n, m: r.m }));
    out.nextBefore = picked.length ? picked[0].off : start;
    out.more = out.nextBefore > 0;
    return out;
  },

  /** 清空某实例的聊天记录（含内存缓冲与未落盘的定时器） */
  chatClear(name) {
    const rec = this.get(name);
    if (rec.chatTimer) {
      clearTimeout(rec.chatTimer);
      rec.chatTimer = null;
    }
    rec.chatPending = [];
    const file = this.chatFile(name);
    let removedBytes = 0;
    try {
      removedBytes = fs.statSync(file).size;
    } catch {}
    try {
      fs.rmSync(file, { force: true });
    } catch (e) {
      throw new Error('清空聊天记录失败: ' + e.message);
    }
    return { ok: true, removedBytes };
  },

  // ---------- 玩家在线时长：内存模型 + 落盘 ----------

  /**
   * 懒装载统计表（首次用到才读盘：面板从不看统计的实例不花这份 IO）。
   * 文件损坏或超过装载上限时改名留档（players.json.corrupt-<ts>）后从空开始——
   * 静默吞掉用户数据是不可接受的，但也不能因为一个坏文件就让接口一直报错。
   */
  ensurePlayerStats(rec) {
    if (rec.pstats) return rec.pstats;
    const st = { trackedSince: this.agentsNow(), players: new Map(), dirty: false };
    rec.pstats = st;
    const file = this.statsFile(rec.meta.name);
    let raw = null;
    try {
      const size = fs.statSync(file).size;
      if (size > STATS_LOAD_MAX_BYTES) throw new Error(`统计文件过大（${size} 字节）`);
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') this.quarantineStats(rec, file, e);
      return st;
    }
    try {
      const data = JSON.parse(raw);
      const players = data && data.players;
      if (players && typeof players === 'object') {
        for (const [name, p] of Object.entries(players)) {
          if (!name || !p || typeof p !== 'object') continue;
          const totalMs = num(p.totalMs);
          const openSince = num(p.openSince);
          // Agent 上次是被硬杀的话，会话还开着：按最后一次心跳结算。
          // 心跳每次只推进 hb、从不改 totalMs（见 playerStatsTick），所以
          // 「totalMs 已含到 hb 为止」这一前提不成立，这里补上 [openSince, hb]。
          // 宁可少算（最多丢一个落盘节拍）也不多算——多算会凭空造出在线时长。
          const hb = num(p.hb) || openSince;
          st.players.set(name.slice(0, 32), {
            firstSeen: num(p.firstSeen),
            lastSeen: num(p.lastSeen),
            totalMs: openSince ? totalMs + Math.max(0, hb - openSince) : totalMs,
            sessions: Math.max(0, Math.round(num(p.sessions))),
            onlineSince: null,
            hb: null,
          });
        }
      }
      if (Number.isFinite(Number(data && data.trackedSince)) && Number(data.trackedSince) > 0) {
        st.trackedSince = Number(data.trackedSince);
      }
    } catch (e) {
      this.quarantineStats(rec, file, e);
    }
    return st;
  },

  /** 损坏的统计文件改名留档（只留最近一份，避免反复损坏时堆积） */
  quarantineStats(rec, file, e) {
    const dest = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, dest);
      for (const f of fs.readdirSync(path.dirname(file))) {
        if (f.startsWith(`${STATS_FILE}.corrupt-`) && path.join(path.dirname(file), f) !== dest) {
          try {
            fs.rmSync(path.join(path.dirname(file), f), { force: true });
          } catch {}
        }
      }
    } catch {}
    this.dataWarn(rec, '读取玩家统计（已改名留档并重新开始）', e);
  },

  /** 取（或新建）某玩家的记录；表满时淘汰最近在线最早的那位 */
  playerEntry(st, name) {
    let e = st.players.get(name);
    if (e) return e;
    if (st.players.size >= MAX_TRACKED_PLAYERS) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of st.players) {
        const at = v.lastSeen || v.firstSeen || 0;
        if (at < oldestAt) {
          oldestAt = at;
          oldestKey = k;
        }
      }
      if (oldestKey != null) st.players.delete(oldestKey);
    }
    e = { firstSeen: 0, lastSeen: 0, totalMs: 0, sessions: 0, onlineSince: null, hb: null };
    st.players.set(name, e);
    return e;
  },

  openPlayerSession(st, name, now) {
    const e = this.playerEntry(st, name);
    e.sessions += 1;
    e.lastSeen = now;
    if (!e.firstSeen) e.firstSeen = now;
    if (e.onlineSince == null) {
      e.onlineSince = now;
      e.hb = now;
    }
    st.dirty = true;
  },

  closePlayerSession(st, name, now) {
    const e = st.players.get(name);
    if (!e || e.onlineSince == null) return;
    e.totalMs += Math.max(0, now - (e.hb || e.onlineSince));
    e.onlineSince = null;
    e.hb = null;
    e.lastSeen = now;
    st.dirty = true;
  },

  /** 收控制台跟踪出来的事件（见 players.js 的 trackPlayers 返回值） */
  applyPlayerEvent(rec, ev) {
    if (!ev) return;
    const needsName = ev.type === 'join' || ev.type === 'leave';
    if (needsName && !ev.name) return;
    if (!this.trackingCfg(rec).players) return;
    const st = this.ensurePlayerStats(rec);
    const now = this.agentsNow();
    if (ev.type === 'join') return this.openPlayerSession(st, ev.name, now);
    if (ev.type === 'leave') return this.closePlayerSession(st, ev.name, now);
    if (ev.type === 'list') {
      // 控制台 `list` / 服务端周期播报：以此校准在线集合（开新、关旧）
      const set = new Set((ev.names || []).filter(Boolean));
      for (const n of set) {
        const e = st.players.get(n);
        if (!e || e.onlineSince == null) this.openPlayerSession(st, n, now);
      }
      for (const [n, e] of st.players) {
        if (e.onlineSince != null && !set.has(n)) this.closePlayerSession(st, n, now);
      }
    }
  },

  /**
   * 由 SLP 名单补开会话：Agent 中途重启、或某玩家在 Agent 开始跟踪前就已在服里时，
   * 没有 join 事件可听。此时以「第一次看到他在线」为起点计时（少算但不错算），
   * 面板上也因此可能看到「本次在线 + 累计」比真实值小——已知且刻意接受的边界。
   */
  playerSeenOnline(rec, names) {
    if (!names || !names.length) return;
    if (!this.trackingCfg(rec).players) return;
    const st = this.ensurePlayerStats(rec);
    const now = this.agentsNow();
    for (const name of names) {
      const n = this.cleanChatText(name).slice(0, 32);
      if (!n) continue;
      const e = st.players.get(n);
      if (!e || e.onlineSince == null) this.openPlayerSession(st, n, now);
    }
  },

  /** 实例进程退出/被停：把仍在线的会话全部结算（否则会一直挂在 openSince 上） */
  closeAllPlayerSessions(rec) {
    const st = rec.pstats;
    if (!st) return;
    const now = this.agentsNow();
    for (const [n, e] of st.players) {
      if (e.onlineSince != null) this.closePlayerSession(st, n, now);
    }
  },

  /** 把统计表写盘（tmp + rename 原子替换，0600） */
  writePlayerStats(rec, st) {
    const file = this.statsFile(rec.meta.name);
    const out = { v: 1, trackedSince: st.trackedSince, players: {} };
    for (const [name, e] of st.players) {
      out.players[name] = {
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        totalMs: e.totalMs,
        sessions: e.sessions,
        openSince: e.onlineSince,
        hb: e.hb,
      };
    }
    const tmp = file + '.tmp';
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.securePath(file, 0o600);
      this.securePath(dir, 0o700);
    } catch (e) {
      this.dataWarn(rec, '写入玩家统计', e);
    }
  },

  /**
   * 立即把统计表落盘（忽略 dirty）。
   * 用在「进程退出 / 实例即将被删除」这类节点上：这一刻的结算是最后一份有效数据，
   * 等不到 60 秒的节拍——晚一步写，文件就已经被删了或 Agent 已经退出了。
   */
  flushPlayerStatsNow(rec) {
    const st = rec.pstats;
    if (!st) return;
    this.writePlayerStats(rec, st);
    st.dirty = false;
  },

  /**
   * 每 60 秒的结算节拍：为在线玩家推进心跳点并落盘。
   *
   * ⚠ 刻意**不**在这里累加 totalMs：totalMs 的语义始终是「已结算的历史会话」，
   * 当前会话整体由 onlineSince 表达。若节拍顺手累加，同一段时间就会在界面上
   * 被算两遍（累计里一段 + 本次在线一段），且「累计不含当前会话」这条约定会随
   * 心跳时刻漂移。心跳只负责一件事：Agent 被硬杀时能按最后已知时刻结算
   * （见 ensurePlayerStats 的装载逻辑，那里做唯一一次补偿性累加）。
   */
  playerStatsTick() {
    for (const rec of this.map.values()) {
      const st = rec.pstats;
      if (!st) continue;
      const now = this.agentsNow();
      let dirty = st.dirty;
      for (const e of st.players.values()) {
        if (e.onlineSince == null) continue;
        if (now > (e.hb || e.onlineSince)) {
          e.hb = now;
          dirty = true;
        }
      }
      if (dirty) this.writePlayerStats(rec, st);
      st.dirty = false;
    }
  },

  /**
   * 玩家统计快照（面板「玩家统计」与侧栏「本次在线」用）。
   * totalMs 是**已结算**的累计时长，不含当前这一节（当前会话由 onlineSince 表达）；
   * now 由 Agent 给出，前端算时长不受两端时钟差影响。
   */
  playersStats(name) {
    const rec = this.get(name);
    const st = this.ensurePlayerStats(rec);
    const players = [];
    for (const [n, e] of st.players) {
      players.push({
        name: n,
        online: e.onlineSince != null,
        onlineSince: e.onlineSince,
        totalMs: e.totalMs,
        sessions: e.sessions,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
      });
    }
    players.sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));
    return {
      instance: name,
      now: this.agentsNow(),
      running: !!rec.proc,
      trackedSince: st.trackedSince,
      truncated: st.players.size >= MAX_TRACKED_PLAYERS,
      players,
    };
  },

  /** 实例被删除时清掉内存态与定时器（文件随实例目录一起删） */
  dropPlayerData(rec) {
    if (rec.chatTimer) {
      clearTimeout(rec.chatTimer);
      rec.chatTimer = null;
    }
    rec.chatPending = [];
    rec.pstats = null;
  },

  /**
   * 常量表：随方法一起挂到原型上（`m.PLAYER_DATA.CHAT_MAX_BYTES`）。
   * 目的是让测试直接引用这些名字，而不是在测试里再抄一遍数字——
   * 数字抄两遍就一定会漂移，上限类断言也就失去了意义。
   */
  PLAYER_DATA: {
    PLAYER_DATA_DIR,
    STATS_FILE,
    CHAT_FILE,
    MAX_TRACKED_PLAYERS,
    CHAT_MAX_BYTES,
    CHAT_MAX_RECORD_CHARS,
    CHAT_PENDING_MAX,
    CHAT_FLUSH_MS,
    CHAT_FLUSH_MAX,
    CHAT_READ_WINDOW_BYTES,
    CHAT_PAGE_DEFAULT,
    CHAT_PAGE_MAX,
    CHAT_PAGE_MAX_CHARS,
    STATS_FLUSH_MS,
    TRACKING_DEFAULT,
  },
};
