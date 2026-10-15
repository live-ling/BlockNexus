/**
 * 玩家在线时长 / 聊天记录的纯逻辑（不依赖 React，可单测）。
 *
 * 这里刻意把「怎么算」和「怎么显示」从组件里抽出来：
 *   · 累计时长的口径（已结算历史 + 当前会话）只有一处定义，组件不再各算一遍；
 *   · 前端过滤与 Agent 侧过滤的语义必须一致（玩家名精确、关键词忽略大小写、按纯文本匹配），
 *     否则「实时追加的记录」和「翻页拉到的记录」会表现不一致。
 */
import { $ } from './i18n'
import type { ChatRecord, PlayerStat } from './api'

/** 当前会话已进行的时长（毫秒）；不在线为 0 */
export function sessionMs(p: PlayerStat, now: number): number {
  if (p.onlineSince == null) return 0
  return Math.max(0, now - p.onlineSince)
}

/**
 * 界面上展示的「累计时长」= 已结算历史 + 当前这次会话。
 * Agent 侧刻意把两项分开（totalMs 不含当前会话），这样同一段时间不会被算两遍；
 * 合成展示是前端的责任。
 */
export function totalWithSession(p: PlayerStat, now: number): number {
  return p.totalMs + sessionMs(p, now)
}

/** 时长的可读形式：天/时/分/秒，只保留两级（「2天3小时」比「2天3小时14分」更好读） */
export function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return $('playerStats.duration.dh', d, h)
  if (h > 0) return $('playerStats.duration.hm', h, m)
  if (m > 0) return $('playerStats.duration.m', m)
  return $('playerStats.duration.s', sec % 60)
}

export type PlayerSortKey = 'total' | 'recent' | 'sessions'

/** 排序（副本，不改原数组）：一律降序，同名再按玩家名升序保证稳定 */
export function sortPlayerStats(list: readonly PlayerStat[], key: PlayerSortKey, now: number): PlayerStat[] {
  const at = (p: PlayerStat): number => {
    if (key === 'total') return totalWithSession(p, now)
    if (key === 'sessions') return p.sessions
    // 最近在线：在线的用本次会话起点，否则用最后一次离开时刻
    return p.onlineSince ?? p.lastSeen
  }
  return [...list].sort((a, b) => at(b) - at(a) || a.name.localeCompare(b.name))
}

/** 时间戳 → 本地日期时间（记录列表用；同一天也在每行显示时间，便于连读） */
export function fmtChatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 实时追加时用的去重键（同一毫秒同一玩家同一句话只留一条） */
export function chatKey(r: ChatRecord): string {
  return `${r.t}|${r.n}|${r.m}`
}

/**
 * 过滤一条记录是否命中（与服务端 chatLog 的过滤语义保持一致）：
 * 玩家名精确匹配；关键词忽略大小写、按**纯文本**在正文或玩家名里查找。
 */
export function chatMatches(r: ChatRecord, filter: { player?: string; q?: string }): boolean {
  if (filter.player && r.n !== filter.player) return false
  if (filter.q) {
    const q = filter.q.toLowerCase()
    if (!r.m.toLowerCase().includes(q) && !r.n.toLowerCase().includes(q)) return false
  }
  return true
}

/** 过滤一批记录（新→旧或旧→新都保持原顺序） */
export function filterChat(
  records: readonly ChatRecord[],
  filter: { player?: string; q?: string },
): ChatRecord[] {
  return records.filter((r) => chatMatches(r, filter))
}

/**
 * 把实时记录并进已有列表：去重（按 chatKey）、按时间升序、只保留最近 max 条。
 * 实时事件与轮询/翻页拿到的记录可能重叠，去重是必须的，否则同一条消息会出现两次。
 */
export function mergeChat(
  prev: readonly ChatRecord[],
  incoming: readonly ChatRecord[],
  max: number,
): ChatRecord[] {
  if (!incoming.length) return prev as ChatRecord[]
  const seen = new Set(prev.map(chatKey))
  const out = [...prev]
  for (const r of incoming) {
    const k = chatKey(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  out.sort((a, b) => a.t - b.t)
  return out.length > max ? out.slice(out.length - max) : out
}

/** 聊天类型 → 界面标签（表情/私聊要能一眼区分） */
export function chatKindLabel(k: string): string {
  if (k === 'emote') return $('instanceDetail.chat.kind.emote')
  if (k === 'whisper') return $('instanceDetail.chat.kind.whisper')
  return $('instanceDetail.chat.kind.chat')
}
