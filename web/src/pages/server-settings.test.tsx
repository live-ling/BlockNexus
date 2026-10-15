import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { JavaCard } from './server-settings'
import { javaVersionText } from '@/lib/api'
import type { JavaEntry, ServerInfo, ServerSummary } from '@/lib/api'

/**
 * 服务器设置页的两条硬约束（静态渲染即可验证，本仓测试环境是 node、没有 jsdom）。
 *
 * 为什么值得钉：
 *   ① 「未安装态 = 锁定态」是这次改版的核心交付之一——它很容易在后续迭代里
 *      被简化回一句空白或一个空列表，而空白恰恰是最难被用户理解的界面。
 *   ② 「当前使用」只准在头部徽章出现一次。列表里再写一遍就是同一件事说两遍，
 *      这正是改版要消掉的重复。
 *
 * ⚠ 静态渲染看不到列表行（版本列表是 useEffect 里拉回来的），所以行的列位对齐
 *   只能靠人眼在看板里确认；这里只覆盖不依赖网络的分支。
 */

const noop = () => {}

const INFO: ServerInfo = {
  hostname: 'mc-01',
  os: 'linux',
  arch: 'x64',
  node: 'v20.11.0',
  agentVersion: '0.6.0',
  memTotalMB: 8192,
  dir: '/opt/blocknexus-agent',
  instancesDir: '/opt/blocknexus/instances',
  java: { installed: true, major: 21, raw: 'openjdk version "21.0.5" 2024-10-15' },
}

function srv(info: ServerInfo | null, patch: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: 's1',
    name: 'mc-01',
    host: '10.0.1.24',
    createdAt: 0,
    status: info ? 'online' : 'offline',
    lastSeen: null,
    info,
    installing: false,
    online: true,
    latency: null,
    stats: null,
    panelHost: '127.0.0.1',
    agentBundled: '0.6.0',
    agentUpdate: null,
    isLocal: false,
    localAgent: null,
    agent: {
      mode: 'outbound',
      host: '',
      port: 3099,
      tls: false,
      tlsFingerprint: '',
      panelUrl: '',
      installDir: '/opt/blocknexus-agent',
    },
    ssh: { port: 22, user: 'root', auth: 'key', hasPassword: false, hasKey: true, keyPath: '' },
    ...patch,
  }
}

const render = (server: ServerSummary) =>
  renderToStaticMarkup(
    createElement(JavaCard, {
      server,
      javaBusy: false,
      javaMsg: '',
      onReload: noop,
      onBusyReset: noop,
    }),
  )

describe('Java 卡：Agent 没上报时是锁定态，不是空白', () => {
  const html = render(srv(null))

  it('说清为什么读不到', () => {
    expect(html).toContain('需要 Agent 上报后才能读取')
  })

  it('说清装上 Agent 能得到什么', () => {
    expect(html).toContain('安装 Agent 后可安装、切换与卸载 Java 版本')
  })

  it('头部标出「不可用」，且不出现安装入口（装了也没用）', () => {
    expect(html).toContain('不可用')
    expect(html).not.toContain('安装新版本')
  })
})

describe('Java 卡：Agent 已上报时给出安装入口', () => {
  const html = render(srv(INFO))

  it('安装条带自带文案（左文案右控件）', () => {
    expect(html).toContain('安装新版本')
    expect(html).toContain('安装后可在下方列表切换为默认版本')
  })

  it('版本列表还没拉回来时给出原因，不留白', () => {
    expect(html).toContain('等待 Agent 上线后自动获取。')
  })

  it('头部徽章说明当前使用版本，且全卡只说一次', () => {
    expect(html).toContain('当前使用 Java 21')
    expect(html.split('当前使用').length - 1).toBe(1)
    expect(html).not.toContain('不可用')
  })
})

describe('javaVersionText：行内版本号的解析兜底', () => {
  const entry = (patch: Partial<JavaEntry>): JavaEntry => ({
    path: '/opt/blocknexus-java/jdk-21.0.5+9-jre',
    name: 'jdk-21.0.5+9-jre',
    major: 21,
    active: false,
    ...patch,
  })

  it('系统包：取 `java -version` 首行引号里的完整版本', () => {
    expect(
      javaVersionText(
        entry({
          path: 'system',
          name: 'system',
          major: 17,
          raw: 'openjdk version "17.0.10" 2024-01-16',
        }),
      ),
    ).toBe('17.0.10')
  })

  it('托管版本：从目录名剥掉 jdk- 前缀与 -jre 后缀', () => {
    // Temurin JRE 压缩包解出来就是 jdk-21.0.5+9-jre
    expect(javaVersionText(entry({}))).toBe('21.0.5+9')
    // Temurin 8 的目录名没有 '-'+版本段
    expect(
      javaVersionText(entry({ path: '/opt/blocknexus-java/jdk8u432-b06', name: 'jdk8u432-b06', major: 8 })),
    ).toBe('8u432-b06')
  })

  it('两个来源都取不到时返回空串（调用点退回说明文案，绝不渲染成 undefined）', () => {
    expect(javaVersionText(entry({ path: 'system', name: 'system', major: 17 }))).toBe('')
  })
})
