// 服务器详情页：实例列表（卡片简化为信息 + 启动/停止，点击进入实例详情）
// 服务器级操作（安装/重装 Agent、编辑、Token、删除）已移至 #/server/<id>/settings
//
// 视觉：与实例总览同一张 InstanceCard（见 components/layout/instance-card.tsx），
// 区别只是页脚放启停按钮、失败/下载中时多一块附加区。

import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudDownload, Play, Plus, RotateCw, Settings, Square } from 'lucide-react';
import { CreateInstanceDialog } from '@/components/dialogs';
import { MaskedText } from '@/components/masked-text';
import { InstanceCard } from '@/components/layout/instance-card';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { AgentStatusPill } from '@/components/layout/status';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { api, errText, osLabel, type Instance, type PlayersSnapshot, type ServerSummary } from '@/lib/api';
import { $ } from '@/lib/i18n';
import { navigate } from '@/lib/router';
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
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader
        back={() => navigate('/')}
        title={server.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <AgentStatusPill online={server.online} installing={server.installing} />
            <MaskedText value={server.host} className="font-mono" />
            {server.info && <span className="hidden sm:inline">· {osLabel(server.info.os)}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onOpenSettings}>
              <Settings className="size-3.5" /> {$('server.detail.settings')}
            </Button>
            <Button
              size="sm"
              disabled={!server.online}
              onClick={() => (server.online ? setCreateOpen(true) : error($('server.detail.error.agentOfflineCreate')))}
            >
              <Plus className="size-3.5" /> {$('server.detail.create')}
            </Button>
          </>
        }
      />

      <PageBody>
        {!server.online ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-[12.5px] text-muted-foreground">
            {$('server.detail.agentOffline')}
            <br />
            <span className="text-[11px]">{$('server.detail.agentOffline.hint')}</span>
          </div>
        ) : instances.length === 0 ? (
          <div className="rounded-xl border border-dashed py-12 text-center text-[12.5px] text-muted-foreground">
            {$('server.detail.empty')}
            <br />
            <span className="text-[11px]">{$('server.detail.empty.hint')}</span>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {instances.map((inst) => {
              const p = players[inst.name] ?? null;
              const runningOrStarting = inst.status === 'running' || inst.status === 'starting';
              return (
                <InstanceCard
                  key={inst.name}
                  server={server}
                  inst={inst}
                  players={p}
                  onOpen={() => onOpenInstance(inst.name)}
                  actions={
                    runningOrStarting ? (
                      <Button
                        size="xs"
                        variant="outline"
                        className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={busyName === inst.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          op(inst.name, 'stop');
                        }}
                      >
                        <Square className="size-3" /> {$('server.detail.stop')}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busyName === inst.name || inst.status !== 'stopped'}
                        onClick={(e) => {
                          e.stopPropagation();
                          op(inst.name, 'start');
                        }}
                      >
                        <Play className="size-3" /> {$('server.detail.start')}
                      </Button>
                    )
                  }
                  extra={
                    inst.status === 'downloading' ? (
                      <div className="grid gap-1">
                        <span className="text-[10.5px] text-muted-foreground">
                          {$('server.detail.downloading', progress[inst.name] ?? 0)}
                        </span>
                        <Progress value={progress[inst.name] ?? 0} className="h-1" />
                      </div>
                    ) : inst.status === 'failed' ? (
                      <div className="grid gap-2">
                        <p className="text-[10.5px] text-destructive">
                          {inst.error || $('server.detail.error.installFailed')}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {inst.source !== 'upload' && (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busyName === inst.name}
                              title={$('server.detail.panelInstall.tooltip')}
                              onClick={(e) => {
                                e.stopPropagation();
                                panelInstall(inst.name);
                              }}
                            >
                              <CloudDownload className="size-3" /> {$('server.detail.panelInstall')}
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busyName === inst.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              retryInstall(inst.name);
                            }}
                          >
                            <RotateCw className="size-3" /> {$('server.detail.retryInstall')}
                          </Button>
                        </div>
                      </div>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </PageBody>

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
