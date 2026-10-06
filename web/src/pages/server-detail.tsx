import { navigate } from '@/lib/router';
// 服务器详情页：实例列表（卡片简化为信息 + 启动/停止，点击进入实例详情）
// 服务器级操作（安装/重装 Agent、编辑、Token、删除）已移至 #/server/<id>/settings

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CloudDownload, Play, Plus, RotateCw, Settings, Square } from 'lucide-react';
import { CreateInstanceDialog } from '@/components/dialogs';
import { MaskedText } from '@/components/masked-text';
import { AgentBadge, InstanceStatusBadge, LatencyBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  api,
  errText,
  fmtMB,
  fmtUptime,
  CORE_LABEL,
  type Instance,
  type PlayersSnapshot,
  type ServerSummary,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { subscribeServer } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';

export function ServerDetailPage({
  id,
  onOpenInstance,
  onOpenSettings,
}: {
  id: string;
  onOpenInstance: (name: string) => void;
  onOpenSettings: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [players, setPlayers] = useState<PlayersSnapshot>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const [, forceTick] = useState(0);
  // 让 loadInstances 能读到最新 installing 状态，又不把它列进依赖（避免回调反复重建）
  const serverRef = useRef<ServerSummary | null>(null);
  serverRef.current = server;

  const loadServer = useCallback(() => {
    api<ServerSummary>(`/servers/${id}`)
      .then(setServer)
      .catch((e) => error(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // installing 期间 Agent 尚未就绪，拿实例列表必然失败——这是预期过程而非错误，
  // 轮询也全部静默，避免安装 Node 那几分钟里反复弹「获取失败」打断用户看日志。
  const loadInstances = useCallback(
    (silent = false) => {
      const quiet = silent || Boolean(serverRef.current?.installing);
      api<Instance[]>(`/servers/${id}/instances`)
        .then(setInstances)
        .catch((e) => {
          if (!quiet) error($('server.detail.error.loadInstances'), errText(e));
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  const loadPlayers = useCallback(() => {
    api<PlayersSnapshot>(`/servers/${id}/players`)
      .then(setPlayers)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    loadServer();
    loadInstances();
    loadPlayers();
  }, [loadServer, loadInstances, loadPlayers]);

  const anyRunning = instances.some((i) => i.status === 'running');
  // 运行中：每 20 秒刷新在线人数 + 运行时长
  useEffect(() => {
    if (!anyRunning) return;
    loadPlayers();
    const t1 = window.setInterval(loadPlayers, 20000);
    const t2 = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => {
      window.clearInterval(t1);
      window.clearInterval(t2);
    };
  }, [anyRunning, loadPlayers]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => loadInstances(true), 600);
  }, [loadInstances]);

  // 订阅 SSE：状态 / 实例事件 / 下载进度 / 延迟
  useEffect(() => {
    return subscribeServer(id, (e) => {
      if (e.type === 'latency') {
        setServer((cur) => (cur ? { ...cur, latency: e.latency } : cur));
        return;
      }
      if (e.type === 'status') {
        loadServer();
        if (e.status === 'online') {
          loadInstances(true);
          loadPlayers();
        }
        return;
      }
      if (e.type !== 'agent-event') return;
      if (e.event === 'install.progress') {
        const phase = typeof e.data?.phase === 'string' ? e.data.phase : '';
        if (phase === 'download' || phase === 'transfer') {
          const inst = String(e.data?.instance ?? '');
          const pct = Number(e.data?.pct ?? 0);
          setProgress((cur) => ({ ...cur, [inst]: pct }));
        }
      }
      if (['instance.updated', 'install.progress', 'java.updated', 'hi'].includes(e.event)) {
        scheduleRefresh();
        if (e.event === 'instance.updated' || e.event === 'java.updated' || e.event === 'hi') loadServer();
        setTimeout(loadPlayers, 1500);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, scheduleRefresh, loadServer, loadPlayers]);

  const op = async (name: string, action: 'start' | 'stop') => {
    setBusyName(name);
    try {
      await api(`/servers/${id}/instances/${encodeURIComponent(name)}/${action}`, {
        method: 'POST',
        body: {},
      });
      success(action === 'start' ? $('server.detail.toast.started') : $('server.detail.toast.stopped'));
      setTimeout(() => {
        loadInstances(true);
        loadPlayers();
      }, 1200);
    } catch (e) {
      error(errText(e));
    } finally {
      setBusyName(null);
    }
  };

  /** 安装失败后重试：沿用实例记录的核心类型/版本重新下载安装 */
  const retryInstall = async (name: string) => {
    setBusyName(name);
    try {
      await api(`/servers/${id}/instances/${encodeURIComponent(name)}/retry-install`, {
        method: 'POST',
        body: {},
      });
      success($('server.detail.toast.reinstalled'), $('server.detail.toast.reinstalledDetail'));
      setProgress((cur) => ({ ...cur, [name]: 0 }));
      setTimeout(() => loadInstances(true), 800);
    } catch (e) {
      error(errText(e));
    } finally {
      setBusyName(null);
    }
  };

  /** 面板代下：服务器拉不动核心站点时，用面板的网络下载再经加密通道传过去 */
  const panelInstall = async (name: string) => {
    setBusyName(name);
    try {
      await api(`/servers/${id}/instances/${encodeURIComponent(name)}/panel-install`, {
        method: 'POST',
        body: {},
      });
      success($('server.detail.toast.panelTookOver'), $('server.detail.toast.panelTookOverDetail'));
      setProgress((cur) => ({ ...cur, [name]: 0 }));
      setTimeout(() => loadInstances(true), 800);
    } catch (e) {
      error($('server.detail.error.panelInstall'), errText(e));
    } finally {
      setBusyName(null);
    }
  };

  if (!server) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{$('common.loading')}</div>;
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 pb-24 pt-7">
      {/* 头部：只保留身份信息与设置入口 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label={$('common.back')} onClick={() => (navigate('/'))}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{server.name}</h2>
        <AgentBadge online={server.online} installing={server.installing} />
        {server.latency != null && <LatencyBadge latency={server.latency} />}
        <MaskedText value={server.host} className="text-xs text-muted-foreground" />
        <Button variant="outline" size="sm" className="ml-auto" onClick={onOpenSettings}>
          <Settings className="h-3.5 w-3.5" /> {$('server.detail.settings')}
        </Button>
      </div>

      {/* 实例 */}
      <div className="mt-6">
        <div className="flex items-center">
          <h3 className="text-[15px] font-semibold">{$('server.detail.instances')}</h3>
          <Button
            className="ml-auto"
            size="sm"
            disabled={!server.online}
            onClick={() => (server.online ? setCreateOpen(true) : error($('server.detail.error.agentOfflineCreate')))}
          >
            <Plus className="h-4 w-4" /> {$('server.detail.create')}
          </Button>
        </div>

        {!server.online ? (
          <div className="mt-4 rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            {$('server.detail.agentOffline')}
            <br />
            <span className="text-xs">{$('server.detail.agentOffline.hint')}</span>
          </div>
        ) : instances.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
            {$('server.detail.empty')}
            <br />
            <span className="text-xs">{$('server.detail.empty.hint')}</span>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
            {instances.map((inst) => {
              const p = players[inst.name];
              const onlineCount = p ? p.online : null;
              return (
                <Card
                  key={inst.name}
                  className="cursor-pointer transition-colors hover:border-muted-foreground/40"
                  onClick={() => onOpenInstance(inst.name)}
                >
                  <CardContent className="grid gap-3">
                    <div className="flex items-center gap-2.5">
                      <b className="text-[15px]">{inst.name}</b>
                      <span className="ml-auto">
                        <InstanceStatusBadge status={inst.status} />
                      </span>
                    </div>
                    {inst.note && <p className="-mt-1.5 text-xs text-muted-foreground">{inst.note}</p>}
                    {/* 信息区：4 列网格（标签列按内容自适应，不换行、不浪费宽度） */}
                    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs">
                      <CellLabel>{$('server.detail.field.core')}</CellLabel>
                      <CellValue>{CORE_LABEL[inst.source ?? 'vanilla'] ?? inst.source ?? '—'}</CellValue>
                      <CellLabel>{$('server.detail.field.version')}</CellLabel>
                      <CellValue>{inst.version}</CellValue>

                      <CellLabel>{$('server.detail.field.memory')}</CellLabel>
                      <CellValue>{fmtMB(inst.memoryMB)}</CellValue>
                      <CellLabel>{$('server.detail.field.players')}</CellLabel>
                      <CellValue
                        tone={onlineCount ? 'good' : undefined}
                      >{`${inst.status === 'running' ? (onlineCount ?? '—') : '—'}/${p?.max ?? inst.maxPlayers}`}</CellValue>

                      <CellLabel>{$('server.detail.field.uptime')}</CellLabel>
                      <CellValue className="col-span-3">
                        {inst.status === 'starting'
                          ? $('server.detail.starting')
                          : inst.status === 'running'
                            ? fmtUptime(inst.startedAt)
                            : '—'}
                      </CellValue>

                      <CellLabel>IP</CellLabel>
                      <CellValue className="col-span-3">{`${server.host}:${inst.port}`}</CellValue>
                      {inst.address && (
                        <>
                          <CellLabel>{$('server.detail.field.domain')}</CellLabel>
                          <CellValue className="col-span-3" tone="primary">{inst.address}</CellValue>
                        </>
                      )}
                    </div>
                    {inst.status === 'downloading' && (
                      <div className="grid gap-1">
                        <span className="text-xs text-muted-foreground">
                          {$('server.detail.downloading', progress[inst.name] ?? 0)}
                        </span>
                        <Progress value={progress[inst.name] ?? 0} className="h-1.5" showValue />
                      </div>
                    )}
                    {inst.status === 'failed' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="min-w-0 flex-1 text-xs text-destructive">
                          {inst.error || $('server.detail.error.installFailed')}
                        </p>
                        {inst.source !== 'upload' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyName === inst.name}
                            title={$('server.detail.panelInstall.tooltip')}
                            onClick={(e) => {
                              e.stopPropagation();
                              panelInstall(inst.name);
                            }}
                          >
                            <CloudDownload className="h-3.5 w-3.5" /> {$('server.detail.panelInstall')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyName === inst.name}
                          onClick={(e) => {
                            e.stopPropagation();
                            retryInstall(inst.name);
                          }}
                        >
                          <RotateCw className="h-3.5 w-3.5" /> {$('server.detail.retryInstall')}
                        </Button>
                      </div>
                    )}

                    {/* 右下角：启停按钮（红=停止 / 绿=启动；启动中也能停止） */}
                    <div className="flex justify-end">
                      {inst.status === 'running' || inst.status === 'starting' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-destructive/60 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={busyName === inst.name}
                          onClick={(e) => {
                            e.stopPropagation();
                            op(inst.name, 'stop');
                          }}
                        >
                          <Square className="h-3.5 w-3.5" /> {$('server.detail.stop')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-emerald-600/50 px-4 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400"
                          disabled={busyName === inst.name || inst.status !== 'stopped'}
                          onClick={(e) => {
                            e.stopPropagation();
                            op(inst.name, 'start');
                          }}
                        >
                          <Play className="h-3.5 w-3.5" /> {$('server.detail.start')}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <CreateInstanceDialog
        server={server}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          loadInstances(true);
          loadServer();
        }}
      />
    </div>
  );
}


/** 实例卡片信息区的标签/值（配合 4 列网格使用） */
function CellLabel({ children }: { children: React.ReactNode }) {
  return <span className="whitespace-nowrap text-muted-foreground">{children}</span>;
}

function CellValue({
  children,
  tone,
  className = '',
}: {
  children: React.ReactNode;
  tone?: 'good' | 'primary';
  className?: string;
}) {
  return (
    <span
      className={`min-w-0 break-words font-mono ${
        tone === 'good'
          ? 'font-medium text-emerald-600 dark:text-emerald-400'
          : tone === 'primary'
            ? 'text-primary'
            : 'text-foreground'
      } ${className}`}
    >
      {children}
    </span>
  );
}
