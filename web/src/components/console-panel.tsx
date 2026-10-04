// 实例控制台：内嵌终端卡片（页面内联，非弹窗/抽屉），SSE 实时日志 + 指令输入
// 输入区样式参考 beUI agents/prompt-input：自增高输入 + 右下角圆形发送按钮

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eraser, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errText, type ServerSummary } from '@/lib/api';
import { subscribeSSE } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';

const MAX_LINES = 1500;
/** 历史指令最大保存条数（含合并相邻重复） */
const MAX_HISTORY = 200;
/** 输入框自增高行数范围 */
const MIN_ROWS = 1;
const MAX_ROWS = 5;
const LINE_HEIGHT = 20;

interface Props {
  server: ServerSummary;
  instance: string;
  instanceStatus: string;
  /** 传入则显示关闭按钮（用于列表页的临时控制台）；实例详情页常驻时不传 */
  onClose?: () => void;
  /** 日志区域高度类名 */
  heightClass?: string;
}

export function ConsolePanel({
  server,
  instance,
  instanceStatus,
  onClose,
  heightClass = 'h-[40vh]',
}: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [cmd, setCmd] = useState('');
  const [status, setStatus] = useState<string>(instanceStatus);
  /** 已发送过的指令（最新在末尾）；正在回显时保存未提交的草稿 */
  const [history, setHistory] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const followingRef = useRef(true);
  const { error: toastError } = useToastHelpers();

  // 自增高：用一个隐藏镜像元素量出文本高度，再写回 textarea（与 beUI prompt-input 同思路）
  const measureRef = useRef<HTMLDivElement>(null);
  const resizeInput = useCallback(() => {
    const el = inputRef.current;
    const measure = measureRef.current;
    // 面板被父级 display:none 隐藏时量到 0，此时保持原高度，等重新可见再算
    if (!el || !measure || !measure.scrollHeight) return;
    const next = Math.min(
      Math.max(measure.scrollHeight, MIN_ROWS * LINE_HEIGHT),
      MAX_ROWS * LINE_HEIGHT,
    );
    const h = `${next}px`;
    if (el.style.height !== h) el.style.height = h;
  }, []);
  useLayoutEffect(resizeInput, [cmd, resizeInput]);

  // 被父级用 display:none 切走时量不到高度，重新可见时补一次（终端/AI 面板切换）
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) resizeInput();
      },
      { threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [resizeInput]);

  // 打开/切换实例时拉取历史尾部
  useEffect(() => {
    let alive = true;
    followingRef.current = true;
    api<{ lines: { ts: number; text: string }[]; status: string }>(
      `/servers/${server.id}/instances/${encodeURIComponent(instance)}/console?tail=300`,
    )
      .then((data) => {
        if (!alive) return;
        setStatus(data.status);
        setLines(data.lines.map((l) => l.text));
      })
      .catch((e) => toastError('控制台加载失败', errText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, instance]);

  // 订阅实时输出
  useEffect(() => {
    return subscribeSSE((e) => {
      if (e.type !== 'agent-event' || e.serverId !== server.id) return;
      if (e.event === 'console' && e.data?.instance === instance) {
        const incoming = (e.data.lines as string[]) || [];
        if (!incoming.length) return;
        setLines((cur) => {
          const next = [...cur, ...incoming];
          return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
        });
      }
      if (e.event === 'instance.updated' && e.data?.instance === instance && typeof e.data.status === 'string') {
        setStatus(e.data.status);
      }
    });
  }, [server.id, instance]);

  // 自动跟随滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    setCmd('');
    setHistIndex(null);
    setDraft('');
    setHistory((cur) => {
      if (cur[cur.length - 1] === c) return cur;
      const next = [...cur, c];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    try {
      await api(`/servers/${server.id}/instances/${encodeURIComponent(instance)}/command`, {
        method: 'POST',
        body: { cmd: c },
      });
    } catch (e) {
      toastError('指令发送失败', errText(e));
    }
  };

  /** ↑/↓ 翻历史指令；Enter 发送，Shift+Enter 换行 */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
      return;
    }
    if (!history.length) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // 上翻时光标必须在首行，否则会打断多行输入
      if (e.key === 'ArrowUp' && e.currentTarget.selectionStart > 0) return;
      e.preventDefault();
      if (histIndex === null) setDraft(cmd);
      let next: number | null;
      if (e.key === 'ArrowUp') {
        next = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1);
        setCmd(history[next] ?? '');
      } else {
        if (histIndex === null) return;
        next = histIndex + 1;
        if (next >= history.length) {
          next = null;
          setCmd(draft);
        } else {
          setCmd(history[next]);
        }
      }
      setHistIndex(next);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-[#0a0d12] shadow-lg">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-[#10141c] px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/90" />
        <b className="text-xs font-semibold text-zinc-200">
          {server.name} / {instance}
        </b>
        <span className="text-xs text-zinc-500">{{ running: '运行中', starting: '启动中', stopped: '已停止', downloading: '下载中', failed: '安装失败', incomplete: '未完成' }[status] ?? status}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100"
            onClick={() => setLines([])}
          >
            <Eraser className="h-3.5 w-3.5" /> 清屏
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-100"
              aria-label="关闭控制台"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followingRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
        }}
        className={`console-scroll no-scrollbar ${heightClass} overflow-y-auto p-3 font-mono text-xs leading-relaxed text-zinc-300`}
      >
        {lines.map((text, i) => (
          <div key={i} className={text.startsWith('[BlockNexus]') ? 'text-emerald-400/90' : undefined}>
            {text}
          </div>
        ))}
        {!lines.length && <div className="text-zinc-600">（暂无输出）</div>}
      </div>
      {/* 指令输入：自增高 + 右下角圆形发送（参考 beUI prompt-input） */}
      <div className="border-t border-zinc-800 bg-[#10141c] p-2">
        <div className="flex items-start gap-2 rounded-xl border border-zinc-700/60 bg-[#0a0d12] px-2.5 py-1.5 transition-colors focus-within:border-zinc-600">
          <span aria-hidden className="select-none font-mono text-xs leading-5 text-emerald-500/80">
            &gt;
          </span>
          <div className="relative min-w-0 flex-1">
            {/* 隐藏镜像：与 textarea 同宽同字号，用于量出自增高高度 */}
            <div
              ref={measureRef}
              aria-hidden
              className="pointer-events-none invisible absolute inset-x-0 top-0 whitespace-pre-wrap font-mono text-xs leading-5 [overflow-wrap:break-word]"
            >
              {`${cmd}\u200b`}
            </div>
            <textarea
              ref={inputRef}
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={onKeyDown}
              rows={MIN_ROWS}
              spellCheck={false}
              autoComplete="off"
              aria-label="控制台指令"
              placeholder="输入指令，如 list / say hello（回车发送，↑↓ 翻历史）"
              className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent font-mono text-xs leading-5 text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>
          <Button
            size="icon"
            onClick={() => void send()}
            disabled={!cmd.trim()}
            aria-label="发送指令"
            title="发送（Enter）"
            className="size-7 shrink-0 rounded-full"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
