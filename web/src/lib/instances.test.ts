import { describe, expect, it } from 'vitest'

import {
  buildInstanceGroups,
  instanceKey,
  playersOf,
  summarizeGroups,
  type ServerInstanceData,
} from './instances'
import type { Instance, PlayersSnapshot, ServerSummary } from './api'

/**
 * 实例总览的数据组装测试。
 *
 * 这三条是容易埋 bug 又只有脱离 React 才好测的行为：
 *   ① 服务器被卸载移除后，它的分组必须消失（不能留一张指向不存在服务器的卡片）；
 *   ② instances=null（未知）≠ []（确定没有）——两者统计与空态展示完全不同；
 *   ③ 实例名在不同服务器之间可以重复，渲染 key 必须带 serverId。
 */

function server(id: string, online = true, installing = false): ServerSummary {
  // 只填渲染与分组真正读到的字段；其余用 unknown 断言补齐形状
  return {
    id,
    name: `srv-${id}`,
    host: '10.0.0.1',
    online,
    installing,
    status: online ? 'online' : 'offline',
    lastSeen: null,
    info: null,
    latency: null,
    stats: null,
    panelHost: '127.0.0.1',
    isLocal: false,
    localAgent: null,
    agent: {
      mode: 'outbound',
      host: '',
      port: 3099,
      tls: false,
      tlsFingerprint: '',
      panelUrl: '',
      installDir: '',
    },
    ssh: { port: 22, user: 'root', auth: 'password', hasPassword: false, hasKey: false, keyPath: '' },
  } as unknown as ServerSummary
}

function inst(name: string, status: Instance['status'] = 'running'): Instance {
  return { name, status, memoryMB: 1024, maxPlayers: 20, version: '1.21', source: 'paper' } as Instance
}

describe('buildInstanceGroups', () => {
  it('按 servers 的顺序输出分组（与拖动排序的持久化顺序一致）', () => {
    const servers = [server('b'), server('a')]
    const data: Record<string, ServerInstanceData> = {
      a: { instances: [], players: {} },
      b: { instances: [], players: {} },
    }
    expect(buildInstanceGroups(servers, data).map((g) => g.server.id)).toEqual(['b', 'a'])
  })

  it('没有拉数记录的服务器输出 instances=null（未知，而非空）', () => {
    const groups = buildInstanceGroups([server('a')], {})
    expect(groups[0]!.instances).toBeNull()
    expect(groups[0]!.players).toEqual({})
  })

  it('已移除的服务器不再出现在分组里', () => {
    // 卸载时勾选「同时从面板移除」→ App 的 servers 少一项；
    // 陈旧拉数残留不该产出一张孤儿卡片
    const data: Record<string, ServerInstanceData> = {
      gone: { instances: [inst('x')], players: {} },
      a: { instances: [inst('y')], players: {} },
    }
    const groups = buildInstanceGroups([server('a')], data)
    expect(groups.map((g) => g.server.id)).toEqual(['a'])
    expect(groups[0]!.instances?.map((i) => i.name)).toEqual(['y'])
  })

  it('原样透传拉数错误', () => {
    const data: Record<string, ServerInstanceData> = {
      a: { instances: null, players: {}, error: 'boom' },
    }
    expect(buildInstanceGroups([server('a')], data)[0]!.error).toBe('boom')
  })
})

describe('summarizeGroups', () => {
  it('统计已取到清单的实例数与运行中的数量', () => {
    const data: Record<string, ServerInstanceData> = {
      a: { instances: [inst('x', 'running'), inst('y', 'stopped')], players: {} },
      b: { instances: [inst('z', 'running')], players: {} },
    }
    const s = summarizeGroups(buildInstanceGroups([server('a'), server('b')], data))
    expect(s.total).toBe(3)
    expect(s.running).toBe(2)
    expect(s.unreachable).toBe(0)
  })

  it('未知（instances=null）不计入 total，只计入 unreachable', () => {
    // 关键：把它算成 0 会让顶部摘要在 Agent 短暂离线时显示「共 0 个实例」
    const data: Record<string, ServerInstanceData> = {
      a: { instances: null, players: {} },
      b: { instances: [inst('x', 'running')], players: {} },
    }
    const s = summarizeGroups(buildInstanceGroups([server('a', false), server('b')], data))
    expect(s.total).toBe(1)
    expect(s.running).toBe(1)
    expect(s.unreachable).toBe(1)
  })

  it('starting 不算运行中（只有 running 才计）', () => {
    const data: Record<string, ServerInstanceData> = {
      a: { instances: [inst('x', 'starting')], players: {} },
    }
    const s = summarizeGroups(buildInstanceGroups([server('a')], data))
    expect(s.total).toBe(1)
    expect(s.running).toBe(0)
  })

  it('空数组有意义：确定没有实例（unreachable 为 0）', () => {
    const data: Record<string, ServerInstanceData> = { a: { instances: [], players: {} } }
    const s = summarizeGroups(buildInstanceGroups([server('a')], data))
    expect(s.total).toBe(0)
    expect(s.unreachable).toBe(0)
  })
})

describe('instanceKey', () => {
  it('带 serverId：不同服务器上的同名实例不撞 key', () => {
    expect(instanceKey('srv-a', 'lobby')).not.toBe(instanceKey('srv-b', 'lobby'))
  })

  it('同一服务器同一实例稳定（重渲染不产生新 key）', () => {
    expect(instanceKey('srv-a', 'lobby')).toBe(instanceKey('srv-a', 'lobby'))
  })
})

describe('playersOf', () => {
  const snap: PlayersSnapshot = { lobby: { online: 3, max: 20, running: true } }

  it('取到对应实例的快照', () => {
    expect(playersOf(snap, 'lobby')?.online).toBe(3)
  })

  it('没取到返回 null（调用方据此显示 —）', () => {
    expect(playersOf(snap, 'nope')).toBeNull()
    expect(playersOf(undefined, 'lobby')).toBeNull()
  })
})
