// 单条聊天记录的展示。
//
// ⚠ 安全约定（本次「注意安全」的一条硬要求）：玩家名与聊天正文**只能**作为 React
//   文本子节点渲染，绝不能进 innerHTML / dangerouslySetInnerHTML。
//   聊天内容完全由玩家控制（`<img src=x onerror=...>` 之类是随手就能发的），
//   一旦拼 HTML 就是直接的 XSS 面。本文件刻意不引入任何富文本能力，
//   chat-line.test.tsx 用恶意载荷做逃逸回归。
//
// 单独成文件的原因之一就是可测：面板组件会连带引入 radix（Select/Dialog），
// 而这一个组件只依赖类型与 i18n，能在 node 环境里直接用 renderToStaticMarkup 验证。

import type { ChatRecord } from '@/lib/api';
import { chatKindLabel, fmtChatTime } from '@/lib/player-stats';

export function ChatLine({ r }: { r: ChatRecord }) {
  const kind = r.k !== 'chat' ? chatKindLabel(r.k) : '';
  return (
    <div className="flex min-w-0 items-start gap-2 px-1 py-0.5 font-mono text-xs hover:bg-muted/50">
      <span className="shrink-0 text-[10px] text-muted-foreground">{fmtChatTime(r.t)}</span>
      <span className="max-w-[10rem] shrink-0 truncate font-semibold text-foreground" title={r.n}>
        {r.n}
      </span>
      {kind && <span className="shrink-0 text-[10px] text-muted-foreground">{kind}</span>}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">{r.m}</span>
    </div>
  );
}
