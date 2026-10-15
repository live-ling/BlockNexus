import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ChatRecord, PlayerStat } from './api'
import {
  __resetLanguageForTest,
  setLanguage,
} from './i18n'
import {
  chatMatches,
  chatKey,
  filterChat,
  fmtChatTime,
  fmtDuration,
  mergeChat,
  sessionMs,
  sortPlayerStats,
  totalWithSession,
} from './player-stats'

/**
 * 玩家在线时长 / 聊天记录的纯逻辑测试。
 *
 * 重点不在加法，而在**口径**：
 *   · 累计时长 = 已结算历史 + 当前会话（Agent 侧刻意分开两项，避免同一段时间算两遍）；
 *   · 实时记录与历史/轮询会重叠 → 去重必须按内容键，且合并后仍按时间有序；
 *   · 过滤语义要与 Agent 侧一致（玩家名精确、关键词忽略大小写、纯文本）。
 */

beforeEach(() => __resetLanguageForTest())
afterEach(() => __resetLanguageForTest())

const T0 = 1_700_000_000_000

function stat(patch: Partial<PlayerStat> = {}): PlayerStat {
  return {
    name: 'Steve',
    online: false,
    onlineSince: null,
    totalMs: 0,
    sessions: 0,
    firstSeen: T0,
    lastSeen: T0,
    ...patch,
  }
}

function rec(patch: Partial<ChatRecord> = {}): ChatRecord {
  return { t: T0, k: 'chat', n: 'Steve', m: 'hello', ...patch }
}

describe('sessionMs / totalWithSession', () => {
  it('不在线时本次会话为 0', () => {
    expect(sessionMs(stat({ totalMs: 5000 }), T0 + 99999)).toBe(0)
  })

  it('在线时本次会话 = now - onlineSince', () => {
    expect(sessionMs(stat({ online: true, onlineSince: T0 }), T0 + 60_000)).toBe(60_000)
  })

  it('时钟倒退（now < onlineSince）不会出现负数', () => {
    expect(sessionMs(stat({ online: true, onlineSince: T0 + 10_000 }), T0)).toBe(0)
  })

  it('累计 = 已结算历史 + 当前会话', () => {
    const p = stat({ online: true, onlineSince: T0, totalMs: 3_600_000 })
    expect(totalWithSession(p, T0 + 60_000)).toBe(3_660_000)
  })
})

describe('fmtDuration', () => {
  it('按量级选择粒度（天/时/分/秒，只保留两级）', () => {
    expect(fmtDuration(0)).toBe('0 秒')
    expect(fmtDuration(30_000)).toBe('30 秒')
    expect(fmtDuration(90_000)).toBe('1 分')
    expect(fmtDuration(3 * 3600_000 + 5 * 60_000)).toBe('3 小时 5 分')
    expect(fmtDuration(2 * 86400_000 + 3 * 3600_000)).toBe('2 天 3 小时')
  })

  it('负数与 NaN 都按 0 处理（脏数据不该显示成 -1 天）', () => {
    expect(fmtDuration(-5)).toBe('0 秒')
    expect(fmtDuration(Number.NaN)).toBe('0 秒')
  })

  it('英文语言包下也成词', () => {
    setLanguage('en')
    expect(fmtDuration(2 * 86400_000 + 3 * 3600_000)).toBe('2d 3h')
    expect(fmtDuration(90_000)).toBe('1m')
  })
})

describe('sortPlayerStats', () => {
  const a = stat({ name: 'Alex', totalMs: 1000, lastSeen: T0 + 5000, sessions: 2 })
  const b = stat({ name: 'Bob', totalMs: 9000, lastSeen: T0 + 1000, sessions: 1 })
  // 在线的玩家用「本次会话起点」参与「最近在线」排序（她是最晚进服的）
  const c = stat({ name: 'Cara', online: true, onlineSince: T0 + 9000, totalMs: 0, sessions: 5, lastSeen: T0 + 9000 })

  it('按累计时长降序（在线玩家的当前会话也计入）', () => {
    expect(sortPlayerStats([a, b, c], 'total', T0 + 200).map((p) => p.name)).toEqual(['Bob', 'Alex', 'Cara'])
  })

  it('按最近在线降序（在线的用本次会话起点）', () => {
    expect(sortPlayerStats([a, b, c], 'recent', T0).map((p) => p.name)).toEqual(['Cara', 'Alex', 'Bob'])
  })
  it('按会话数降序', () => {
    expect(sortPlayerStats([a, b, c], 'sessions', T0).map((p) => p.name)).toEqual(['Cara', 'Alex', 'Bob'])
  })

  it('不修改原数组', () => {
    const list = [a, b]
    sortPlayerStats(list, 'total', T0)
    expect(list.map((p) => p.name)).toEqual(['Alex', 'Bob'])
  })
})

describe('聊天过滤与合并', () => {
  const rows = [
    rec({ t: T0 + 1, n: 'Steve', m: 'Hello there' }),
    rec({ t: T0 + 2, n: 'Alex', m: 'hi steve' }),
    rec({ t: T0 + 3, n: 'Alex', m: 'a.*b|(c)' }),
  ]

  it('玩家名精确匹配（不是包含匹配）', () => {
    expect(filterChat(rows, { player: 'Alex' }).length).toBe(2)
    expect(filterChat(rows, { player: 'Ale' }).length).toBe(0)
  })

  it('关键词忽略大小写，且在正文与玩家名里都找', () => {
    expect(filterChat(rows, { q: 'HELLO' }).length).toBe(1)
    expect(filterChat(rows, { q: 'steve' }).length).toBe(2)
  })

  it('关键词按纯文本匹配（正则元字符不当元字符用）', () => {
    expect(filterChat(rows, { q: 'a.*b' }).length).toBe(1)
    expect(filterChat(rows, { q: 'a.b' }).length).toBe(0)
    expect(chatMatches(rows[2], { q: '|' })).toBe(true)
  })

  it('两个条件同时生效（与）', () => {
    expect(filterChat(rows, { player: 'Alex', q: 'steve' }).length).toBe(1)
  })

  it('实时记录按内容键去重（同一条消息重复推送不会出现两次）', () => {
    const dup = [rows[0], rows[1], rows[0]]
    const merged = mergeChat([rows[0]], dup, 100)
    expect(merged.length).toBe(2)
    expect(merged.map((r) => r.m)).toEqual(['Hello there', 'hi steve'])
  })

  it('合并后按时间升序，并裁到上限（保留最新的）', () => {
    const many = Array.from({ length: 10 }, (_, i) => rec({ t: T0 + i, m: 'm' + i }))
    const merged = mergeChat([], many, 3)
    expect(merged.map((r) => r.m)).toEqual(['m7', 'm8', 'm9'])
  })

  it('同一条消息的 chatKey 稳定', () => {
    expect(chatKey(rec({ t: 1, n: 'a', m: 'b' }))).toBe('1|a|b')
  })
})

describe('fmtChatTime', () => {
  it('输出可排序的本地日期时间（跨天也能一眼看出）', () => {
    const s = fmtChatTime(new Date(2026, 0, 2, 3, 4, 5).getTime())
    expect(s).toBe('2026-01-02 03:04:05')
  })

  it('时间戳缺失时给占位而不是 NaN', () => {
    expect(fmtChatTime(0)).toBe('—')
  })
})
