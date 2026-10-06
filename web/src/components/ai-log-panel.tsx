// AI 日志分析面板：把实例控制台日志交给大模型分析（流式返回）
// 组件来自 beUI agents：MessageScroller / Message / PromptInput / StreamingResponse / ReasoningText

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkles, Terminal, User } from 'lucide-react';
import { Message, MessageAvatar, MessageContent } from '@/components/agents/message';
import { MessageScroller } from '@/components/agents/message-scroller';
import { PromptInput } from '@/components/agents/prompt-input';
import { ReasoningText } from '@/components/agents/loading-states/reasoning-text';
import { Markdown } from '@/components/markdown';
import { StreamingResponse } from '@/components/agents/streaming-response';
import { Button } from '@/components/ui/button';
import { aiAnalyzeStream, errText, type AiStats } from '@/lib/api';
import { $, type TranslationKey } from '@/lib/i18n';
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

/** 模块顶层只存键名（$() 在渲染期取词，避免被语言切换冻结） */
const QUICK_ACTIONS: { value: string; labelKey: TranslationKey; descKey: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'analyze',
    labelKey: 'aiLog.quick.analyze',
    descKey: 'aiLog.quick.analyze.desc',
    icon: <Terminal className="size-4" />,
  },
  {
    value: 'errors',
    labelKey: 'aiLog.quick.errors',
    descKey: 'aiLog.quick.errors.desc',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'crash',
    labelKey: 'aiLog.quick.crash',
    descKey: 'aiLog.quick.crash.desc',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'lag',
    labelKey: 'aiLog.quick.lag',
    descKey: 'aiLog.quick.lag.desc',
    icon: <Sparkles className="size-4" />,
  },
  {
    value: 'plugin',
    labelKey: 'aiLog.quick.plugin',
    descKey: 'aiLog.quick.plugin.desc',
    icon: <Sparkles className="size-4" />,
  },
];

/** 耗时展示：小于 1 秒用毫秒，否则折算成秒 */
function fmtMs(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms';
}

const ACTION_QUESTION: Record<string, TranslationKey> = {
  analyze: 'aiLog.q.analyze',
  errors: 'aiLog.q.errors',
  crash: 'aiLog.q.crash',
  lag: 'aiLog.q.lag',
  plugin: 'aiLog.q.plugin',
};

const THINKING_KEYS: TranslationKey[] = ['aiLog.thinking.read', 'aiLog.thinking.locate', 'aiLog.thinking.summarize'];

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
          patch((c) => (c.content ? c : { ...c, content: $('aiLog.stopped'), error: true }));
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
        <b className="text-sm">{$('aiLog.title')}</b>
        <span className="ml-auto text-xs text-muted-foreground">{$('aiLog.subtitle')}</span>
        {items.length > 0 && !loading && (
          <Button variant="ghost" size="xs" onClick={() => setItems([])}>
            {$('aiLog.clear')}
          </Button>
        )}
      </div>

      <MessageScroller
        className="min-h-0 flex-1"
        viewportClassName="px-3 py-3"
        contentClassName="gap-3"
        busy={loading}
        label={$('aiLog.dialogLabel')}
        viewportRef={viewportRef}
      >
        {items.length === 0 ? (
          <div className="grid place-items-center py-10 text-center">
            <div className="max-w-xs">
              <p className="text-sm text-muted-foreground">{$('aiLog.empty.hint')}</p>
              <p className="mt-1.5 text-xs text-muted-foreground/70">{$('aiLog.empty.hint2')}</p>
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
                        phrases={THINKING_KEYS.map((k) => $(k))}
                      />
                    )}
                  </StreamingResponse>
                )}
                {it.role === 'assistant' && (it.stats || it.lines) ? (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
                    {it.stats?.model && <span className="font-mono">{it.stats.model}</span>}
                    {it.lines ? (
                      <span>
                        {$('aiLog.lines', it.lines)}
                        {it.truncated && (
                          <span className="text-amber-600 dark:text-amber-400">{$('aiLog.truncated')}</span>
                        )}
                      </span>
                    ) : null}
                    {it.stats?.firstTokenMs != null && <span>{$('aiLog.firstToken', fmtMs(it.stats.firstTokenMs))}</span>}
                    {it.stats?.totalMs != null && <span>{$('aiLog.totalTime', fmtMs(it.stats.totalMs))}</span>}
                    {it.stats?.usage && (
                      <span>
                        Token{' '}
                        {it.stats.usage.totalTokens != null
                          ? it.stats.usage.totalTokens
                          : $('aiLog.tokensSplit', it.stats.usage.promptTokens ?? '—', it.stats.usage.completionTokens ?? '—')}
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
          placeholder={$('aiLog.placeholder')}
          actions={QUICK_ACTIONS.map((a) => ({ value: a.value, label: $(a.labelKey), description: $(a.descKey), icon: a.icon }))}
          onAction={(a) => {
            const qk = ACTION_QUESTION[a];
            if (qk) void ask($(qk));
          }}
          minRows={1}
          maxRows={4}
        />
      </div>
    </div>
  );
}
