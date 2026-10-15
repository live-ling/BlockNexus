import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { ChatLine } from './chat-line'
import type { ChatRecord } from '@/lib/api'

/**
 * 聊天记录的**逃逸**回归测试。
 *
 * 为什么必须有：聊天内容完全由玩家控制，是面板里最典型的不可信输入
 * （`<img src=x onerror=...>` 随手就能发）。渲染层唯一的安全前提是
 * 「只作为 React 文本子节点」——一旦有人为了加粗/颜色改成
 * dangerouslySetInnerHTML，这里就会红。
 *
 * 用 renderToStaticMarkup（node 环境即可，不需要 jsdom）直接看输出 HTML：
 * 恶意标签必须以实体形式出现，且不能出现可执行的标签本身。
 */

const rec = (patch: Partial<ChatRecord>): ChatRecord => ({
  t: new Date(2026, 0, 2, 3, 4, 5).getTime(),
  k: 'chat',
  n: 'Steve',
  m: 'hello',
  ...patch,
})

describe('ChatLine 对不可信聊天的处理', () => {
  it('正文里的 HTML/脚本被转义成实体，不产生真实标签', () => {
    const html = renderToStaticMarkup(
      createElement(ChatLine, {
        r: rec({ m: '<img src=x onerror=alert(1)> <script>alert(2)</script>' }),
      }),
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('玩家名同样被转义（名字也是玩家可控的）', () => {
    const html = renderToStaticMarkup(
      createElement(ChatLine, { r: rec({ n: '<b>evil</b>' }) }),
    )
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
  })

  it('引号与事件处理器片段不会变成可执行的属性', () => {
    const html = renderToStaticMarkup(
      createElement(ChatLine, { r: rec({ m: '" onmouseover="alert(1)' }) }),
    )
    // 属性只能用双引号闭合；正文里的引号必须被转义
    expect(html).toContain('&quot;')
    expect(html).not.toContain('onmouseover="alert')
  })

  it('正常中文/表情等文本原样保留（转义不影响可读性）', () => {
    const html = renderToStaticMarkup(
      createElement(ChatLine, { r: rec({ n: '玩家_01', m: '你好 world 🙂' }) }),
    )
    expect(html).toContain('玩家_01')
    expect(html).toContain('你好 world 🙂')
  })

  it('表情与私聊带类型标签（能一眼区分聊天/表情/私聊）', () => {
    const emote = renderToStaticMarkup(createElement(ChatLine, { r: rec({ k: 'emote', m: 'waves' }) }))
    const whisper = renderToStaticMarkup(createElement(ChatLine, { r: rec({ k: 'whisper', m: 'psst' }) }))
    expect(emote).toContain('表情')
    expect(whisper).toContain('私聊')
  })
})
