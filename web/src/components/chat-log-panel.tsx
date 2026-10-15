// 聊天记录页签：历史由 Agent 落盘后读取，实时由 SSE 的 chat 事件追加。
//
// 设计要点：
//   · 面板不保证长期在线 → 历史一律从 Agent 读（面板离线期间由 Agent 边收边存），
//     页签打开时先拉最新一页，再靠 SSE 实时补；
//   · 实时事件与轮询会重叠 → 统一按 chatKey 去重（player-stats.ts 的 mergeChat）；
//   · 分页游标是**字节偏移**（nextBefore），不是时间戳：同一毫秒可能有多条记录；
//   · 过滤条件同时用于「拉历史」和「渲染实时记录」，语义一致（玩家名精确、关键词纯文本）；
//   · 安全：正文只作为 React 文本子节点渲染，绝不进 innerHTML——
//     聊天内容完全由玩家控制，是典型不可信输入（见 chat-log-panel.test.tsx 的逃逸用例）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, Loader2, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ChatLine } from '@/components/chat-line';
import { clearChatLog, errText, fmtBytes, getChatLog, type ChatRecord, type PlayerStat } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { subscribeServer } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { chatKey, filterChat, mergeChat } from '@/lib/player-stats';

/** 实时事件在内存里最多留多少条（历史走分页读取，不占内存） */
const LIVE_MAX = 500;
/** 一次历史请求的条数（与 Agent 单页上限对齐） */
const PAGE_LIMIT = 100;
/** 自动刷新间隔：SSE 断过一段时的兜底（实时主要靠事件） */
const POLL_MS = 15000;
/** 关键词输入的防抖：不必每敲一个字就发一次请求 */
const KEYWORD_DEBOUNCE_MS = 400;

/**
 * 聊天记录页签的容器：工具栏 + 列表 + 清空确认。
 * 每行渲染在 chat-line.tsx（纯展示、可单测逃逸）。
 */
interface Props {
  serverId: string;
  instance: string;
  /** 面板是否可见（隐藏时暂停轮询，减少无谓请求） */
  visible: boolean;
  /** 当前实例是否运行中（未运行时只展示历史） */
  running: boolean;
  /** 实例的聊天记录开关（老版本 Agent 未返回时按开启处理） */
  trackingEnabled: boolean;
  heightClass: string;
  /** 已知玩家名（过滤下拉用；来自玩家统计） */
  players?: PlayerStat[];
}

export function ChatLogPanel({
  serverId,
  instance,
  visible,
  running,
  trackingEnabled,
  heightClass,
  players,
}: Props) {
  const { success, error } = useToastHelpers();
  // 历史页（可能已经翻了多页）与实时记录分开存：历史的装载/翻页语义清晰，
  // 渲染时统一合并去重，避免「翻页把实时记录冲掉」这种别扭行为。
  const [history, setHistory] = useState<ChatRecord[]>([]);
  const [live, setLive] = useState<ChatRecord[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [size, setSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [player, setPlayer] = useState('');
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [follow, setFollow] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // 序号防在途请求把过期结果写回（改过滤条件、清空、切实例都会让旧请求失效）
  const seq = useRef(0);

  const filter = useMemo(() => ({ player, q: debounced }), [player, debounced]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [keyword]);

  /** 拉最新一页（reset=true 时替换历史，否则只补实时记录） */
  const loadLatest = useCallback(() => {
    const s = ++seq.current;
    setLoading(true);
    getChatLog(serverId, instance, { limit: PAGE_LIMIT, player, q: debounced })
      .then((page) => {
        if (s !== seq.current) return;
        setFailed(null);
        setSize(page.size);
        setCursor(page.nextBefore);
        setMore(page.more);
        setHistory(page.records);
      })
      .catch((e) => {
        if (s === seq.current) setFailed(errText(e));
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, [serverId, instance, player, debounced]);

  /** 用游标继续往回翻（更早的记录） */
  const loadOlder = useCallback(() => {
    if (!cursor) return;
    const s = seq.current;
    setLoadingMore(true);
    getChatLog(serverId, instance, { limit: PAGE_LIMIT, before: cursor, player, q: debounced })
      .then((page) => {
        if (s !== seq.current) return;
        // 文件被轮转/清空过：游标失效 → 直接以最新一页为准
        if (page.reset) {
          setHistory(page.records);
        } else {
          setHistory((prev) => mergeChat(prev, page.records, 5000));
        }
        setCursor(page.nextBefore);
        setMore(page.more);
        setSize(page.size);
      })
      .catch((e) => error($('instanceDetail.chat.loadFailed'), errText(e)))
      .finally(() => {
        if (s === seq.current) setLoadingMore(false);
      });
  }, [serverId, instance, cursor, player, debounced, error]);

  // 首次 / 过滤条件变化 / 切换实例：重置为最新一页
  useEffect(() => {
    setLive([]);
    loadLatest();
  }, [loadLatest]);

  // 实时：Agent 收到聊天就推 chat 事件（面板侧只做去重与过滤）
  useEffect(() => {
    return subscribeServer(serverId, (e) => {
      if (e.type !== 'agent-event' || e.event !== 'chat') return;
      const data = e.data as { instance?: unknown; records?: unknown } | null;
      if (!data || data.instance !== instance || !Array.isArray(data.records)) return;
      setLive((prev) => mergeChat(prev, data.records as ChatRecord[], LIVE_MAX));
    });
  }, [serverId, instance]);

  // 页签从隐藏切回可见时补一次最新一页（隐藏期间只靠 SSE，可能断过）
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) loadLatest();
    wasVisible.current = visible;
  }, [visible, loadLatest]);

  // 运行中且页签可见：兜底轮询（SSE 断线期间漏掉的事件靠它补上）
  useEffect(() => {
    if (!visible || !running || !follow) return;
    const t = window.setInterval(loadLatest, POLL_MS);
    return () => window.clearInterval(t);
  }, [visible, running, follow, loadLatest]);

  // 渲染用的合并结果：历史（可能已翻多页）+ 实时，再去重与过滤
  const rows = useMemo(
    () => filterChat(mergeChat(history, live, 6000), filter),
    [history, live, filter],
  );

  // 贴底时自动滚到最新：用户往回翻看不该被强行拉走
  useEffect(() => {
    const el = listRef.current;
    if (!el || !follow) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, follow]);

  const doClear = async () => {
    setClearing(true);
    try {
      await clearChatLog(serverId, instance);
      seq.current++;
      setHistory([]);
      setLive([]);
      setCursor(0);
      setMore(false);
      setSize(0);
      success($('instanceDetail.chat.cleared'), instance);
      setClearOpen(false);
    } catch (e) {
      error($('instanceDetail.chat.clearFailed'), errText(e));
    } finally {
      setClearing(false);
    }
  };

  const playerOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of players ?? []) set.add(p.name);
    for (const r of rows) set.add(r.n);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [players, rows]);

  return (
    <div className={`flex flex-col rounded-xl border bg-card ${heightClass}`}>
      <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
        <Select value={player || '__all__'} onValueChange={(v) => setPlayer(v === '__all__' ? '' : v)}>
          <SelectTrigger className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__all__">{$('instanceDetail.chat.allPlayers')}</SelectItem>
            {playerOptions.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 pl-7 pr-7 text-xs"
            value={keyword}
            placeholder={$('instanceDetail.chat.keyword')}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setKeyword('')}
              aria-label={$('instanceDetail.chat.keyword')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch checked={follow} onCheckedChange={setFollow} />
          {$('instanceDetail.chat.follow')}
        </label>
        <Button variant="ghost" size="icon" className="h-7 w-7" title={$('instanceDetail.chat.loadMore')} onClick={loadLatest}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          title={$('instanceDetail.chat.clear')}
          onClick={() => setClearOpen(true)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* 运行状态 / 开关 / 隐私提示：三件都影响「你看到的记录为什么长这样」 */}
      <div className="grid gap-0.5 border-b bg-muted/20 px-2 py-1 text-[11px] leading-snug text-muted-foreground">
        {!trackingEnabled && <p>{$('instanceDetail.chat.disabled')}</p>}
        {!running && <p>{$('instanceDetail.chat.notRunning')}</p>}
        <p>{$('instanceDetail.chat.hint')}</p>
        <p>{$('instanceDetail.chat.privacy')}</p>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {failed ? (
          <p className="px-2 py-3 text-xs text-destructive">{failed}</p>
        ) : rows.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            {loading ? $('instanceDetail.chat.loading') : $('instanceDetail.chat.empty')}
          </p>
        ) : (
          <>
            {more && (
              <div className="flex justify-center py-1">
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" disabled={loadingMore} onClick={loadOlder}>
                  {loadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronUp className="h-3 w-3" />}
                  {$('instanceDetail.chat.loadMore')}
                </Button>
              </div>
            )}
            {rows.map((r, i) => (
              <ChatLine key={`${chatKey(r)}#${i}`} r={r} />
            ))}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-2 py-1 text-[11px] text-muted-foreground">
        <span>{$('instanceDetail.chat.stats', rows.length, fmtBytes(size))}</span>
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{$('instanceDetail.chat.clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {$('instanceDetail.chat.clearDesc', fmtBytes(size))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>{$('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={clearing}
              onClick={(e) => {
                e.preventDefault();
                void doClear();
              }}
            >
              {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              {$('instanceDetail.chat.clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
