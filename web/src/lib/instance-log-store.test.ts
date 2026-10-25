import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 实例日志 store 的行为测试。
 *
 * 重点保护三件事（都出过事故或极易出错）：
 *   1. **缓冲上限**：超过 1500 行丢最旧，并且**记 dropped 计数**（UI 要能提示，
 *      原来 ConsolePanel 直接 slice 掉，用户毫无感知）。
 *   2. **断线补偿合并**：补拉到的 Agent 尾部与本地缓冲要正确拼接，
 *      既有不丢本地行，也不重复追加同一段。
 *   3. **只往已打开的实例追加**：Agent 会为同服所有实例推 console 事件，
 *      没人看的实例不该在面板内存里堆缓冲。
 */

const apiMock = vi.fn()

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api')
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  }
})

const sseMock = {
  state: 'open' as 'idle' | 'connecting' | 'open' | 'reconnecting',
  listeners: new Set<() => void>(),
  serverListeners: new Set<(e: unknown) => void>(),
}

vi.mock('./sse', () => ({
  subscribeSSE: (fn: (e: unknown) => void) => {
    sseMock.serverListeners.add(fn)
    return () => sseMock.serverListeners.delete(fn)
  },
  subscribeServer: (fn: (e: unknown) => void) => {
    sseMock.serverListeners.add(fn)
    return () => sseMock.serverListeners.delete(fn)
  },
  sseConnection: {
    get: () => sseMock.state,
    subscribe: (fn: () => void) => {
      sseMock.listeners.add(fn)
      return () => sseMock.listeners.delete(fn)
    },
  },
}))

type Store = typeof import('./instance-log-store')['instanceLogStore']
let store: Store

beforeEach(async () => {
  apiMock.mockReset()
  sseMock.state = 'open'
  sseMock.listeners.clear()
  sseMock.serverListeners.clear()
  vi.resetModules()
  const mod = await import('./instance-log-store')
  store = mod.instanceLogStore
})

afterEach(() => {
  vi.useRealTimers()
})

/** 造一个 /console 响应（Agent 回 { lines, status }） */
function consoleRes(lines: string[], status = 'running') {
  return { lines: lines.map((text) => ({ ts: 1, text })), status }
}

describe('instanceLogStore：历史加载', () => {
  it('open 时拉一次 tail 历史，并把 {ts,text}[] 归一化成 string[]', async () => {
    apiMock.mockResolvedValue(consoleRes(['a', 'b']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').lines).toEqual(['a', 'b']))
    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(String(apiMock.mock.calls[0][0])).toContain('/console?tail=')
    expect(store.get('s1', 'survival').status).toBe('running')
  })

  it('重复 open 不会重复拉历史', async () => {
    apiMock.mockResolvedValue(consoleRes(['a']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))
    store.open('s1', 'survival')
    expect(apiMock).toHaveBeenCalledTimes(1)
  })

  it('拉取失败不抛，状态标记为已加载（Agent 离线由页面条件条表达）', async () => {
    apiMock.mockRejectedValue(new Error('offline'))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))
    expect(store.get('s1', 'survival').lines).toEqual([])
  })
})

describe('instanceLogStore：实时追加', () => {
  it('SSE console 事件追加到已打开的实例', async () => {
    apiMock.mockResolvedValue(consoleRes(['a']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: ['live-1'] },
      }),
    )
    expect(store.get('s1', 'survival').lines).toEqual(['a', 'live-1'])
  })

  it('未打开的实例不累积缓冲（Agent 会为同服所有实例推事件）', async () => {
    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'other', lines: ['x'] },
      }),
    )
    expect(store.get('s1', 'other').lines).toEqual([])
  })

  it('instance.updated 更新状态', async () => {
    apiMock.mockResolvedValue(consoleRes(['a'], 'stopped'))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))
    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'instance.updated',
        data: { instance: 'survival', status: 'running' },
      }),
    )
    expect(store.get('s1', 'survival').status).toBe('running')
  })
})

describe('instanceLogStore：缓冲上限', () => {
  it('超过上限丢最旧并累计 dropped 计数（不静默吞日志）', async () => {
    apiMock.mockResolvedValue(consoleRes(['a']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    const many = Array.from({ length: 1600 }, (_, i) => `l${i}`)
    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: many },
      }),
    )
    const st = store.get('s1', 'survival')
    expect(st.lines.length).toBe(1500)
    expect(st.lines[st.lines.length - 1]).toBe('l1599')
    expect(st.dropped).toBe(101) // 1 行历史 + 1600 行 = 1601，超出 1500 的部分
  })

  it('清屏把缓冲与 dropped 一起清零', async () => {
    apiMock.mockResolvedValue(consoleRes(['a']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))
    store.clear('s1', 'survival')
    expect(store.get('s1', 'survival').lines).toEqual([])
    expect(store.get('s1', 'survival').dropped).toBe(0)
  })
})

describe('instanceLogStore：断线补偿', () => {
  it('SSE 断开再恢复时补拉一次尾部，并与本地缓冲正确拼接（不重复、不丢行）', async () => {
    apiMock.mockResolvedValue(consoleRes(['a', 'b']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    // 断线期间本地又收到两行（Agent 侧也有这两行）
    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: ['c'] },
      }),
    )
    // Agent 的尾部现在包含 a,b,c（补偿拉到的内容）
    apiMock.mockResolvedValue(consoleRes(['a', 'b', 'c']))

    sseMock.state = 'reconnecting'
    sseMock.listeners.forEach((fn) => fn())
    sseMock.state = 'open'
    sseMock.listeners.forEach((fn) => fn())

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.get('s1', 'survival').lines).toEqual(['a', 'b', 'c']))
  })

  it('Agent 侧缓冲被清空（重启过）时，本地已有的行不能丢', async () => {
    apiMock.mockResolvedValue(consoleRes(['a']))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: ['local-only'] },
      }),
    )
    // Agent 侧现在只有一行（与本地没有共同尾行）
    apiMock.mockResolvedValue(consoleRes(['fresh']))

    sseMock.state = 'reconnecting'
    sseMock.listeners.forEach((fn) => fn())
    sseMock.state = 'open'
    sseMock.listeners.forEach((fn) => fn())

    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      const lines = store.get('s1', 'survival').lines
      expect(lines).toContain('local-only')
      expect(lines).toContain('fresh')
    })
  })
})

describe('instanceLogStore：当前运行周期（ERROR 徽章只算本次）', () => {
  it('从 running 直接重新 starting（重启）时也会开启新一轮计数', async () => {
    apiMock.mockResolvedValue(consoleRes(['old-error-1', 'old-error-2'], 'running'))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))
    expect(store.get('s1', 'survival').runStart).toBe(0)

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'instance.updated',
        data: { instance: 'survival', status: 'starting' },
      }),
    )
    // 重启也是一轮新运行：旧错误归零，runStart 落在当前末尾
    expect(store.get('s1', 'survival').runStart).toBe(2)
  })

  it('停止后重新 starting：旧错误不再计入本次运行', async () => {
    apiMock.mockResolvedValue(consoleRes(['old-error'], 'stopped'))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'instance.updated',
        data: { instance: 'survival', status: 'starting' },
      }),
    )
    const st = store.get('s1', 'survival')
    // runStart 指向旧日志之后：页面用它切掉历史错误
    expect(st.runStart).toBe(1)

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: ['new-error'] },
      }),
    )
    const after = store.get('s1', 'survival')
    expect(after.lines.slice(after.runStart)).toEqual(['new-error'])
  })

  it('缓冲裁剪时 runStart 同步左移，不会把上个周期算进本次', async () => {
    apiMock.mockResolvedValue(consoleRes(['a', 'b'], 'stopped'))
    store.open('s1', 'survival')
    await vi.waitFor(() => expect(store.get('s1', 'survival').loaded).toBe(true))

    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'instance.updated',
        data: { instance: 'survival', status: 'starting' },
      }),
    )
    expect(store.get('s1', 'survival').runStart).toBe(2)

    const many = Array.from({ length: 1600 }, (_, i) => `l${i}`)
    sseMock.serverListeners.forEach((fn) =>
      fn({
        type: 'agent-event',
        serverId: 's1',
        event: 'console',
        data: { instance: 'survival', lines: many },
      }),
    )
    const st = store.get('s1', 'survival')
    // 2 + 1600 - 1500 = 102 行被裁掉，runStart 从 2 变成 0
    expect(st.lines.length).toBe(1500)
    expect(st.runStart).toBe(0)
  })
})
