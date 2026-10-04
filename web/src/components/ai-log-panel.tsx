// AI 日志分析面板：把实例控制台日志交给大模型分析（流式返回）
// 组件来自 beUI agents：MessageScroller / Message / PromptInput / StreamingResponse / ReasoningText

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Terminal, User } from 'lucide-react';
import { Message, MessageAvatar, MessageContent } from '@/components/agents/message';
import { MessageScroller } from '@/components/agents/message-scroller';
import { PromptInput, type PromptAction } from '@/components/agents/prompt-input';
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text';
import { Markdown } from '@/components/markdown';
import { StreamingResponse } from '@/components/agents/streaming-response';
import { Button } from '@/components/ui/button';
import { aiAnalyzeStream, errText, type AiStats } from '@/lib/api';
import { useToastHelpers } from '@/lib/toast';

interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  /** 本次回答依据的日志行数 */
  lines?: number;
  /** 日志因字符上限被截断（只能看到更晚的部分） */
  truncated?: boolean;
  /** 模型 / 首字 / 总耗时 / Token */
  stats?: AiStats;
}

const QUICK_ACTIONS: PromptAction[] = [
  {
    value: 'analyze',
    label: '分析运行状态',
    description: '通读最近日志，指出异常与处理建议',
    icon: <Terminal className="size-4" />,
  },
  {
    value: 'errors',
    label: '只看报错',
    description: '挑出 ERROR / Exception 并解释原因',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'crash',
    label: '崩溃原因',
    description: '服务器为什么停了 / 启动失败',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'lag',
    label: '卡顿排查',
    description: 'TPS 低、卡顿、内存与 GC 相关线索',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'plugin',
    label: '插件冲突',
    description: '定位报错插件与冲突插件',
    icon: <Sparkles className="size-4" />,
  },
];

/** 耗时展示：小于 1 秒用毫秒，否则折算成秒 */
function fmtMs(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms';
}

const ACTION_QUESTION: Record<string, string> = {
  analyze: '请分析当前运行状态，重点指出报错/异常、可能原因与处理建议；若一切正常请明确说明。',
  errors: '请只挑出日志中的 ERROR / WARN / Exception 相关内容，逐条解释原因并给出处理办法。',
  crash: '请分析服务器崩溃或启动失败的原因，指出关键堆栈与对应插件/配置问题，并给出修复步骤。',
  lag: '请分析是否存在卡顿、TPS 偏低、内存不足或频繁 GC 的迹象，给出排查方向与优化建议。',
  plugin: '请定位报错涉及的插件，判断是否存在插件冲突或版本不兼容，并给出处理顺序。',
};

export function AiLogPanel({
  serverId,
  instanceName,
  heightClass = 'h-[64vh]',
}: {
  serverId: string;
  instanceName: string;
  heightClass?: string;
}) {
  const { error: toastError } = useToastHelpers();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement>(null);

  // 本面板被父级用 display:none 隐藏时尺寸为 0，MessageScroller 测不到滚动高度。
  // 重新可见时补一次滚动到底，避免切回来停在中间（流式进行中它会自己跟随，这里兜底已结束的情况）。
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        const vp = viewportRef.current;
        if (vp) requestAnimationFrame(() => (vp.scrollTop = vp.scrollHeight));
      },
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      if (loading) return;
      const q = question.trim();
      if (!q) return;
      seqRef.current += 1;
      const userMsg: ChatItem = { id: `u${seqRef.current}`, role: 'user', content: q };
      const aid = `a${seqRef.current}`;
      setItems((cur) => [...cur, userMsg, { id: aid, role: 'assistant', content: '' }]);
      setLoading(true);

      const ac = new AbortController();
      abortRef.current = ac;
      const patch = (fn: (c: ChatItem) => ChatItem) =>
        setItems((cur) => cur.map((it) => (it.id === aid ? fn(it) : it)));

      try {
        await aiAnalyzeStream(
          serverId,
          instanceName,
          {
            question: q,
            // 取满 Agent 环形缓冲（上限 500 行），让分析看到尽可能完整的上下文
            tail: 500,
            history: items
              .filter((it) => !it.error && it.content)
              .slice(-6)
              .map((it) => ({ role: it.role, content: it.content })),
          },
          {
            signal: ac.signal,
            onMeta: (meta) => patch((c) => ({ ...c, lines: meta.lines, truncated: meta.truncated })),
            onDelta: (text) => patch((c) => ({ ...c, content: c.content + text })),
            onDone: (stats) => patch((c) => ({ ...c, stats })),
          },
        );
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          patch((c) => (c.content ? c : { ...c, content: '（已停止）', error: true }));
        } else {
          const msg = errText(e);
          toastError(msg);
          patch((c) => ({ ...c, content: msg, error: true }));
        }
      } finally {
        abortRef.current = null;
        setLoading(false);
      }
    },
    [instanceName, items, loading, serverId, toastError],
  );

  return (
    <div ref={rootRef} className={`flex min-w-0 flex-col rounded-xl border bg-card ${heightClass}`}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
        <b className="text-sm">AI 日志分析</b>
        <span className="ml-auto text-xs text-muted-foreground">基于最近 500 行控制台日志</span>
        {items.length > 0 && !loading && (
          <Button variant="ghost" size="xs" onClick={() => setItems([])}>
            清空
          </Button>
        )}
      </div>

      <MessageScroller
        className="min-h-0 flex-1"
        viewportClassName="px-3 py-3"
        contentClassName="gap-3"
        busy={loading}
        label="AI 日志分析对话"
        viewportRef={viewportRef}
      >
        {items.length === 0 ? (
          <div className="grid place-items-center py-10 text-center">
            <div className="max-w-xs">
              <p className="text-sm text-muted-foreground">
                点下方「分析运行状态」快速开始，或直接输入你的问题。
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground/70">
                分析会把最近日志发给已配置的模型，请先在面板设置中启用并配置 AI。
              </p>
            </div>
          </div>
        ) : (
          items.map((it, idx) => (
            <Message key={it.id} from={it.role === 'user' ? 'user' : 'assistant'}>
              <MessageAvatar>
                {it.role === 'user' ? <User /> : <Sparkles />}
              </MessageAvatar>
              <MessageContent>
                {it.role === 'user' ? (
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-muted px-3 py-2 text-sm">
                    {it.content}
                  </div>
                ) : (
                  <StreamingResponse
                    status={it.error ? 'error' : loading && !it.content ? 'streaming' : 'complete'}
                    copyText={it.content}
                    className="w-full"
                  >
                    {it.content ? (
                      <Markdown
                        content={it.content}
                        // 只在「整轮请求尚未结束且这是最后一条」时算流式，代码块才跟随滚动
                        streaming={loading && idx === items.length - 1}
                      />
                    ) : (
                      <ReasoningText
                        className="text-sm"
                        phrases={['正在读取日志', '正在定位异常', '正在整理建议']}
                      />
                    )}
                  </StreamingResponse>
                )}
                {it.role === 'assistant' && (it.stats || it.lines) ? (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                    {it.stats?.model && <span className="font-mono">{it.stats.model}</span>}
                    {it.lines ? (
                      <span>
                        参考日志 {it.lines} 行
                        {it.truncated && (
                          <span className="text-amber-600 dark:text-amber-400">（过长已截断）</span>
                        )}
                      </span>
                    ) : null}
                    {it.stats?.firstTokenMs != null && <span>首字 {fmtMs(it.stats.firstTokenMs)}</span>}
                    {it.stats?.totalMs != null && <span>总耗时 {fmtMs(it.stats.totalMs)}</span>}
                    {it.stats?.usage && (
                      <span>
                        Token{' '}
                        {it.stats.usage.totalTokens != null
                          ? it.stats.usage.totalTokens
                          : `提示 ${it.stats.usage.promptTokens ?? '—'} / 补全 ${it.stats.usage.completionTokens ?? '—'}`}
                      </span>
                    )}
                  </div>
                ) : null}
              </MessageContent>
            </Message>
          ))
        )}
      </MessageScroller>

      <div className="border-t p-2">
        <PromptInput
          value={value}
          onValueChange={setValue}
          onSubmit={(v) => {
            setValue('');
            void ask(v);
          }}
          loading={loading}
          onStop={stop}
          placeholder="询问日志问题，或点 + 选择快捷分析…"
          actions={QUICK_ACTIONS}
          onAction={(a) => {
            const q = ACTION_QUESTION[a];
            if (q) void ask(q);
          }}
          minRows={1}
          maxRows={4}
        />
      </div>
    </div>
  );
}
