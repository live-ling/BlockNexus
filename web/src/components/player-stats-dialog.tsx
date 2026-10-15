// 玩家统计：该实例所有被记录过的玩家（在线/离线），按累计时长、最近在线或会话数排序。
//
// 数据来源是 Agent 侧落盘的统计文件（见 agent/src/instance/playerdata.js）：
// 面板离线期间 Agent 照记，所以这里看到的是**完整历史**，而不是「面板开着的那一段」。
// 唯一的时间口径来自 Agent 返回的 now——两端时钟不同步时，用浏览器时间算时长会得到
// 负数或虚高的结果，因此一律用 Agent 的时间为基准（每秒自增一次，让「本次在线」走字）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errText, getPlayersStats, type PlayersStats } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { fmtDuration, sessionMs, sortPlayerStats, totalWithSession, type PlayerSortKey } from '@/lib/player-stats';

/**
 * 每秒自增的秒计数器（enabled=false 时停表）+ 归零函数。
 * 用它而不是在渲染里直接读 `Date.now()`：渲染必须是纯的，而且每次拉取数据后
 * 都要把计数归零并与 Agent 给的时间重新对齐（否则两次数据叠加会把时长越算越多）。
 */
function useTickSeconds(enabled: boolean): [number, () => void] {
  const [n, setN] = useState(0);
  const reset = useCallback(() => setN(0), []);
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setN((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, [enabled]);
  return [n, reset];
}

interface Props {
  serverId: string;
  instance: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function PlayerStatsDialog({ serverId, instance, open, onOpenChange }: Props) {
  const [data, setData] = useState<PlayersStats | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // loading 不额外维护：首屏「还没有数据且没报错」就是加载中，刷新中的转圈由
  // 按钮自己的 refreshing 表达（避免在 effect 里同步 setState 触发级联渲染）
  const [refreshing, setRefreshing] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<PlayerSortKey>('total');
  // 以 Agent 的 now 为基准，加上本地每秒走一格 —— 两端时钟不同步也不会算出负数/虚高
  const [tick, resetTick] = useTickSeconds(open);

  /** 拉一次统计（自身不做同步 setState：effect 里调用它是安全的） */
  const load = useCallback(
    () =>
      getPlayersStats(serverId, instance)
        .then((r) => {
          setData(r);
          resetTick(); // 换新基准，计时从 0 重新走
          setFailed(null);
        })
        .catch((e) => setFailed(errText(e))),
    [serverId, instance, resetTick],
  );

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const manualRefresh = () => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  };

  // 当前时刻 = Agent 时间 + 本地已过秒数
  const now = data ? data.now + tick * 1000 : 0;

  const rows = useMemo(() => {
    const list = sortPlayerStats(data?.players ?? [], sort, now);
    const kw = keyword.trim().toLowerCase();
    return kw ? list.filter((p) => p.name.toLowerCase().includes(kw)) : list;
  }, [data, sort, now, keyword]);

  const onlineCount = (data?.players ?? []).filter((p) => p.online).length;
  const loading = refreshing || (!data && !failed);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> {$('instanceDetail.playerStats.title')}
            <span className="font-mono text-xs font-normal text-muted-foreground">{instance}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7"
              onClick={manualRefresh}
              title={$('sparkPanel.refresh')}
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </DialogTitle>
          <DialogDescription>
            {data ? $('instanceDetail.playerStats.hint', new Date(data.trackedSince).toLocaleString()) : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={sort} onValueChange={(v) => setSort(v as PlayerSortKey)}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="total">{$('instanceDetail.playerStats.sort.total')}</SelectItem>
              <SelectItem value="recent">{$('instanceDetail.playerStats.sort.recent')}</SelectItem>
              <SelectItem value="sessions">{$('instanceDetail.playerStats.sort.sessions')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative min-w-[10rem] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-7 text-xs"
              value={keyword}
              placeholder={$('instanceDetail.playerStats.search')}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {onlineCount}/{data?.players.length ?? 0}
          </span>
        </div>

        <div className="scrollbar-hide -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {failed ? (
            // 旧版本 Agent 会回「未知操作」：给出「请更新 Agent」而不是一个干巴巴的报错
            <p className="px-1 py-3 text-xs text-destructive">
              {failed}
              {/未知操作|unknown action|instance\.players\.stats/i.test(failed) && (
                <span className="mt-1 block text-muted-foreground">
                  {$('instanceDetail.playerStats.unsupported')}
                </span>
              )}
            </p>
          ) : rows.length === 0 ? (
            <p className="px-1 py-3 text-xs text-muted-foreground">
              {loading ? $('instanceDetail.playerStats.loading') : $('instanceDetail.playerStats.empty')}
            </p>
          ) : (
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 font-medium">{$('instanceDetail.playerStats.col.name')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.online')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.session')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.total')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.sessions')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.firstSeen')}</th>
                  <th className="px-2 py-1.5 font-medium">{$('instanceDetail.playerStats.col.lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const sess = sessionMs(p, now);
                  return (
                    <tr key={p.name} className="border-b border-border/50 hover:bg-muted/40">
                      <td className="max-w-[12rem] truncate py-1.5 pr-2 font-mono" title={p.name}>
                        {p.name}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <span
                          className={
                            p.online
                              ? 'rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400'
                              : 'text-[10px] text-muted-foreground'
                          }
                        >
                          {p.online ? $('instanceDetail.playerStats.online') : $('instanceDetail.playerStats.offline')}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                        {p.online ? fmtDuration(sess) : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono">{fmtDuration(totalWithSession(p, now))}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono">{p.sessions}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                        {p.firstSeen ? new Date(p.firstSeen).toLocaleString() : '—'}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
                        {p.lastSeen ? new Date(p.lastSeen).toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {data?.truncated && (
          <p className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">
            {$('instanceDetail.playerStats.truncated')}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
