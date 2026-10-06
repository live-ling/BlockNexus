// spark 性能面板：TPS/CPU 实时展示、一键 profiler、报告链接列表、健康摘要
// 数据来自 Agent 解析控制台输出（面板发 spark tps 等命令，Agent 被动解析），见 agent.js trackSpark

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ExternalLink, HeartPulse, Puzzle, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, errText, timeago } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { useToastHelpers } from '@/lib/toast';

export interface SparkStats {
  tps?: number[];
  cpu?: number[];
  msptMedian?: number;
  msptP95?: number;
  ts: number;
  stale?: boolean;
}

export interface SparkReport {
  code: string;
  url: string;
  ts: number;
}

export interface SparkStatsResponse {
  installed: boolean;
  disabled?: boolean;
  version: string;
  jar?: string;
  running: boolean;
  stats: SparkStats | null;
  reports: SparkReport[];
}

/** TPS 色调：≥19 满速，≥15 尚可，更低则告警 */
function tpsTone(v: number): 'good' | 'fair' | 'bad' {
  return v >= 19 ? 'good' : v >= 15 ? 'fair' : 'bad';
}

const TONE_CLS: Record<'good' | 'fair' | 'bad', string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  fair: 'text-amber-600 dark:text-amber-400',
  bad: 'text-destructive',
};

/** 迷你趋势线：自绘 SVG，不引入图表库 */
function Sparkline({ points, max, className }: { points: number[]; max: number; className?: string }) {
  if (points.length < 2) return null;
  const w = 300;
  const h = 40;
  const pts = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 1 - Math.max(0, Math.min(1, v / max)) * (h - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className}>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function SparkPanel({
  serverId,
  instance,
  running,
  visible,
  heightClass = 'h-[45vh] lg:h-[60vh]',
  onOpenMods,
}: {
  serverId: string;
  instance: string;
  running: boolean;
  /** 父级当前是否显示本面板（隐藏时暂停轮询，避免往控制台刷 spark 输出） */
  visible: boolean;
  heightClass?: string;
  onOpenMods: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [data, setData] = useState<SparkStatsResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tpsHist, setTpsHist] = useState<number[]>([]);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [healthLines, setHealthLines] = useState<string[] | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [dur, setDur] = useState('60');
  // profiler 进行中：endsAt 到点后拉一次 stats 让报告出现
  const [profEndsAt, setProfEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const seq = useRef(0);

  const load = useCallback(() => {
    const s = ++seq.current;
    setLoading(true);
    api<SparkStatsResponse>(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/spark/stats`)
      .then((r) => {
        if (s !== seq.current) return;
        setFailed(null);
        setData(r);
        if (r.stats && !r.stats.stale && r.stats.tps?.length) {
          setTpsHist((h) => [...h.slice(-59), r.stats!.tps![0]]);
        }
        if (r.stats && !r.stats.stale && r.stats.cpu?.length) {
          setCpuHist((h) => [...h.slice(-59), r.stats!.cpu![1] ?? r.stats!.cpu![0]]);
        }
      })
      .catch((e) => {
        if (s === seq.current) setFailed(errText(e));
      })
      .finally(() => {
        if (s === seq.current) setLoading(false);
      });
  }, [serverId, instance]);

  // 首次拉一次（拿安装检测结果与已有报告）
  useEffect(() => {
    load();
  }, [load]);

  // 运行中且面板可见：15s 轮询（隐藏时暂停，减少对控制台的打扰）
  useEffect(() => {
    if (!running || !visible) return;
    load();
    const t = window.setInterval(load, 15000);
    return () => window.clearInterval(t);
  }, [running, visible, load]);

  // 实例停止：清掉旧数据与趋势（下次启动重新积累）
  useEffect(() => {
    if (running) return;
    seq.current++;
    setData(null);
    setFailed(null);
    setTpsHist([]);
    setCpuHist([]);
    setHealthLines(null);
    setProfEndsAt(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // profiler 倒计时；到点拉一次 stats（报告应已上传）
  useEffect(() => {
    if (!profEndsAt) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= profEndsAt) {
        setProfEndsAt(null);
        load();
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [profEndsAt, load]);

  const startProfiler = async () => {
    try {
      const r = await api<{ started: boolean; timeoutSec?: number; error?: string }>(
        `/servers/${serverId}/instances/${encodeURIComponent(instance)}/spark/profiler`,
        { method: 'POST', body: { action: 'start', timeoutSec: Number(dur) } },
      );
      if (!r.started) {
        error(r.error || $('sparkPanel.error.start'));
        return;
      }
      setProfEndsAt(Date.now() + (r.timeoutSec ?? Number(dur)) * 1000);
      setNow(Date.now());
      success($('sparkPanel.toast.started'), $('sparkPanel.toast.startedDetail', r.timeoutSec ?? dur));
    } catch (e) {
      error($('sparkPanel.error.start'), errText(e));
    }
  };

  const stopProfiler = async () => {
    try {
      const r = await api<{ stopped: boolean; code?: string | null; error?: string }>(
        `/servers/${serverId}/instances/${encodeURIComponent(instance)}/spark/profiler`,
        { method: 'POST', body: { action: 'stop' } },
      );
      if (!r.stopped) {
        error(r.error || $('sparkPanel.error.stop'));
        return;
      }
      setProfEndsAt(null);
      success(
        r.code ? $('sparkPanel.toast.stopped') : $('sparkPanel.toast.stopSent'),
        r.code ? $('sparkPanel.toast.reportReady') : $('sparkPanel.toast.reportPending'),
      );
      setTimeout(load, 2500);
    } catch (e) {
      error($('sparkPanel.error.stop'), errText(e));
    }
  };

  const loadHealth = async () => {
    setHealthBusy(true);
    try {
      const r = await api<{ lines: string[] }>(
        `/servers/${serverId}/instances/${encodeURIComponent(instance)}/spark/health`,
      );
      setHealthLines(r.lines);
      if (!r.lines.length) error($('sparkPanel.error.noOutput'), $('sparkPanel.error.noOutputHint'));
    } catch (e) {
      error($('sparkPanel.error.health'), errText(e));
    } finally {
      setHealthBusy(false);
    }
  };

  const stats = data?.stats ?? null;
  const profLeftSec = profEndsAt ? Math.max(0, Math.ceil((profEndsAt - now) / 1000)) : 0;

  return (
    <div className={`flex min-w-0 flex-col overflow-y-auto rounded-xl border bg-card p-4 ${heightClass}`}>
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <b className="text-sm">{$('sparkPanel.title')}</b>
        {data?.installed && data.version && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            v{data.version}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-7 w-7 text-muted-foreground hover:text-foreground"
          disabled={loading}
          onClick={load}
          aria-label={$('sparkPanel.refresh')}
          title={$('sparkPanel.refresh')}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* 未安装 / 已禁用 / 加载失败 */}
      {failed ? (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {$('sparkPanel.error.load', failed)}
        </div>
      ) : !data ? (
        <p className="mt-6 text-center text-xs text-muted-foreground">{$('common.loading')}</p>
      ) : !data.installed ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-xs leading-relaxed text-foreground">{$('sparkPanel.notInstalled.desc')}</p>
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={onOpenMods}>
              <Puzzle className="h-3.5 w-3.5" /> {$('sparkPanel.notInstalled.openMods')}
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="https://spark.lucko.me/download" target="_blank" rel="noreferrer">
                {$('sparkPanel.notInstalled.download')} <ExternalLink className="h-3 w-3" />
              </a>
            </Button>
          </div>
        </div>
      ) : data.disabled ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
          {$('sparkPanel.disabled.pre')}
          <span className="font-mono">{data.jar}</span>
          {$('sparkPanel.disabled.post')}
        </div>
      ) : !running ? (
        <p className="mt-6 text-center text-xs text-muted-foreground">{$('sparkPanel.notRunning')}</p>
      ) : (
        <>
          {/* 实时指标 */}
          <div className="mt-3 grid grid-cols-[auto_auto_1fr] items-end gap-x-5 gap-y-2">
            <div>
              <p className="text-[11px] text-muted-foreground">{$('sparkPanel.tps1m')}</p>
              <p className={`font-mono text-3xl leading-tight ${stats?.tps ? TONE_CLS[tpsTone(stats.tps[0])] : 'text-muted-foreground'}`}>
                {stats?.tps ? stats.tps[0].toFixed(1) : '—'}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground">5m / 15m</p>
              <p className="font-mono text-lg leading-tight text-foreground">
                {stats?.tps ? `${stats.tps[1]?.toFixed(1) ?? '—'} / ${stats.tps[2]?.toFixed(1) ?? '—'}` : '— / —'}
              </p>
            </div>
            <div className="justify-self-end text-right">
              <p className="text-[11px] text-muted-foreground">{$('sparkPanel.cpu')}</p>
              <p className="font-mono text-lg leading-tight text-foreground">
                {stats?.cpu?.length ? `${stats.cpu[1] ?? stats.cpu[0]}%` : '—'}
              </p>
              {stats?.msptMedian != null && (
                <p className="font-mono text-[11px] text-muted-foreground">
                  MSPT {stats.msptMedian}ms{stats.msptP95 != null ? ` / p95 ${stats.msptP95}ms` : ''}
                </p>
              )}
            </div>
          </div>
          {stats?.stale && (
            <p className="mt-1 text-[11px] text-muted-foreground">{$('sparkPanel.stale')}</p>
          )}

          {/* 趋势（会话内积累，最多 60 个点） */}
          <div className="mt-2 grid gap-1 text-muted-foreground">
            <Sparkline points={tpsHist} max={20} className="h-8 w-full text-emerald-500/70" />
            <Sparkline points={cpuHist} max={100} className="h-6 w-full text-sky-500/60" />
            <p className="text-[10px] leading-none">{$('sparkPanel.legend')}</p>
          </div>

          {/* profiler */}
          <div className="mt-3 rounded-lg border p-2.5">
            <div className="flex items-center gap-1.5">
              {profEndsAt ? (
                <>
                  <span className="font-mono text-xs text-amber-600 dark:text-amber-400">
                    {$('sparkPanel.profilingLeft', profLeftSec)}
                  </span>
                  <Button size="sm" variant="outline" className="ml-auto" onClick={stopProfiler}>
                    <Square className="h-3 w-3" /> {$('instanceDetail.op.stop')}
                  </Button>
                </>
              ) : (
                <>
                  <Select value={dur} onValueChange={setDur}>
                    <SelectTrigger size="sm" className="w-[104px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="60">{$('sparkPanel.dur1m')}</SelectItem>
                      <SelectItem value="300">{$('sparkPanel.dur5m')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="secondary" className="ml-auto" onClick={startProfiler}>
                    <Activity className="h-3.5 w-3.5" /> {$('sparkPanel.start')}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={healthBusy}
                onClick={loadHealth}
                title={$('sparkPanel.healthTooltip')}
              >
                <HeartPulse className={`h-3.5 w-3.5 ${healthBusy ? 'animate-pulse' : ''}`} /> {$('sparkPanel.health')}
              </Button>
            </div>
            {healthLines && (
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                {healthLines.join('\n')}
              </pre>
            )}
          </div>

          {/* 报告列表 */}
          <div className="mt-3">
            <p className="text-[11px] text-muted-foreground">{$('sparkPanel.reports')}</p>
            {data.reports.length ? (
              <ul className="mt-1 grid gap-1">
                {data.reports.map((r) => (
                  <li key={r.code}>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-xs hover:bg-muted"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="font-mono text-foreground">{r.code}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{timeago(r.ts)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">{$('sparkPanel.noReports')}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
