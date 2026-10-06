import { navigate } from '@/lib/router';
// 服务器设置页：连接信息 / Agent 管理 / 系统信息 / 危险操作
// 路由 #/server/<serverId>/settings

import { useCallback, useEffect, useSyncExternalStore, useState } from 'react';
import { AlertTriangle, ArrowLeft, Download, KeyRound, Pencil, Play, RefreshCw, Square, Trash2, Trash } from 'lucide-react';
import { AgentBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ConfirmDialog,
  EditServerDialog,
  ManualInstallDialog,
  TokenDialog,
} from '@/components/dialogs';
import { UninstallDialog, uninstallLogKey } from '@/components/uninstall-dialog';
import { LogViewer } from '@/components/log-viewer';
import {
  api,
  agentOutdated,
  errText,
  fmtDiskGB,
  fmtMB,
  latencyTone,
  listJavas,
  timeago,
  switchJava,
  uninstallJava,

  type JavaEntry,
  type JavaListResult,
  type Me,
  type ServerSummary,
} from '@/lib/api';
import { installLogStore, subscribeServer } from '@/lib/sse';
import { useToastHelpers } from '@/lib/toast';
import { $ } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function ServerSettingsPage({
  serverId,
  me,
  onBack,
  onDeleted,
}: {
  serverId: string;
  me: Me;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const { success, error, info } = useToastHelpers();
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [javaBusy, setJavaBusy] = useState(false);
  const [javaMsg, setJavaMsg] = useState('');
  const [uninstallOpen, setUninstallOpen] = useState(false);
  // stopOnly 模式：复用卸载弹窗做「只停本机 Agent」
  const [stopOnlyOpen, setStopOnlyOpen] = useState(false);

  const installLog = useSyncExternalStore(installLogStore.subscribe, () => installLogStore.get(serverId));
  const uninstallLog = useSyncExternalStore(installLogStore.subscribe, () => installLogStore.get(uninstallLogKey(serverId)));

  // 刷新后重放：服务端缓存了最近一次任务的日志（SSH 装 Node 要好几分钟，
  // 用户中途刷新不该看不到进度），这里把历史灌回 store，之后 SSE 增量继续接上。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const kind of ['install', 'uninstall'] as const) {
        try {
          const key = kind === 'uninstall' ? uninstallLogKey(serverId) : serverId;
          const r = await api<{ lines: string; done: boolean | null; running: boolean }>(
            `/servers/${serverId}/task-log?kind=${kind}`,
          );
          if (cancelled || !r.lines) continue;
          // 已有内容说明浏览器一直在实时收，别用历史覆盖掉 newer 的部分
          const cur = installLogStore.get(key);
          if (cur && cur.lines) continue;
          installLogStore.open(key);
          installLogStore.push(key, r.lines);
          if (r.done !== null) installLogStore.markDone(key, !!r.done);
        } catch {
          // 拉取失败无所谓，实时推送仍然可用
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const load = useCallback(() => {
    api<ServerSummary>(`/servers/${serverId}`)
      .then(setServer)
      .catch((e) => {
        // 卸载时勾选了「同时从面板移除该服务器」→ 记录已不存在，回首页
        if ((e as { status?: number }).status === 404) {
          navigate('/');
          return;
        }
        error(errText(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return subscribeServer(serverId, (e) => {
      if (e.type === 'status' || e.type === 'latency') load();
      // Agent 接入后的系统信息快照（安装完成时 status 先到、hi 后到，必须单独刷新）
      if (e.type === 'agent-event' && e.event === 'hi') load();
      // 资源快照（内存/磁盘 30s 一次）直接就地更新，不重新拉接口
      if (e.type === 'stats') {
        setServer((cur) => (cur ? { ...cur, stats: e.stats } : cur));
        return;
      }
      if (e.type === 'install') {
        if (e.log) installLogStore.push(serverId, e.log);
        if (e.done) {
          installLogStore.markDone(serverId, !!e.ok);
          if (e.ok) success($('serverSettings.toast.agentOnline'));
          else info($('serverSettings.toast.installEnded'), $('serverSettings.toast.installEndedDetail'));
          load();
        }
      }
      if (e.type === 'agent-event' && e.event === 'install.progress' && e.data?.phase === 'java') {
        setJavaBusy(true);
        setJavaMsg(String(e.data.msg ?? ''));
        return;
      }
      if (e.type === 'agent-event' && e.event === 'java.updated') {
        setJavaBusy(false);
        setJavaMsg('');
        load();
        const d = (e.data ?? {}) as { done?: boolean; ok?: boolean; error?: string; java?: { major?: number } };
        if (d.done) {
          if (d.ok) success($('serverSettings.toast.javaReady'), d.java ? $('serverSettings.toast.javaReadyVersion', d.java.major) : undefined);
          else error($('serverSettings.toast.javaInstallFailed'), typeof d.error === 'string' ? d.error : undefined);
        }
        return;
      }
      if (e.type === 'uninstall') {
        const key = uninstallLogKey(serverId);
        if (e.log) installLogStore.push(key, e.log);
        if (e.done) {
          installLogStore.markDone(key, !!e.ok);
          if (e.ok) success($('serverSettings.toast.agentUninstalled'));
          else error($('serverSettings.error.uninstall'), typeof e.error === 'string' ? e.error : undefined);
          load();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, load]);

  if (!server) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{$('common.loading')}</div>;
  }

  const startInstall = async () => {
    installLogStore.open(serverId);
    setServer({ ...server, installing: true });
    try {
      await api(`/servers/${serverId}/install`, { method: 'POST', body: {} });
      success($('serverSettings.toast.installStarted'));
    } catch (e) {
      error($('serverSettings.error.installStart'), errText(e));
      setServer((cur) => (cur ? { ...cur, installing: false } : cur));
    }
  };

  /** 本机专属：启动/停止 Agent 进程（不走 SSH，实例数据保留） */
  const localTask = async (kind: 'start' | 'stop') => {
    setServer((cur) => (cur ? { ...cur, installing: true } : cur));
    try {
      await api(`/servers/${serverId}/local-agent/${kind}`, { method: 'POST', body: {} });
      success(kind === 'start' ? $('serverSettings.toast.localStarting') : $('serverSettings.toast.localStopping'));
    } catch (e) {
      error(kind === 'start' ? $('serverSettings.error.start') : $('serverSettings.error.stop'), errText(e));
      setServer((cur) => (cur ? { ...cur, installing: false } : cur));
    }
  };

  const tone = latencyTone(server.latency);
  const remoteAgentLabel = server.info?.agentVersion
    ? `v${server.info.agentVersion}`
    : $('serverSettings.agent.legacyVersion');

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-7">
      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label={$('common.back')} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{$('serverSettings.title')}</h2>
        <AgentBadge online={server.online} installing={server.installing} />
        {server.latency != null && (
          <span
            className={`font-mono text-xs ${
              tone === 'good'
                ? 'text-emerald-600 dark:text-emerald-400'
                : tone === 'fair'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-destructive'
            }`}
          >
            {$('badge.latency', server.latency === 0 ? '<1' : server.latency)}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {$('serverSettings.lastSeen', server.name, timeago(server.lastSeen))}
      </p>

      {/* 连接信息 */}
      <SettingsCard
        title={$('serverSettings.connection.title')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" /> {$('serverSettings.action.edit')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTokenOpen(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Token
            </Button>
          </>
        }
      >
        <InfoGrid
          rows={[
            [$('serverSettings.field.name'), server.name],
            [$('serverSettings.field.host'), server.host],
            // 本机服务器由面板直管进程，不走 SSH —— 展示凭据没有意义，也容易误导
            ...(server.isLocal
              ? []
              : ([
                  [
                    'SSH',
                    $('serverSettings.value.withDetail',
                      `${server.ssh.user}@${server.host}:${server.ssh.port}`,
                      server.ssh.auth === 'key' ? $('serverSettings.auth.key') : $('serverSettings.auth.password'),
                    ),
                  ],
                ] as [string, string][])),
            [
              $('serverSettings.field.mode'),
              (server.agent.mode || 'outbound') === 'outbound'
                ? $('serverSettings.mode.outbound', `${server.agent.host || server.host}:${server.agent.port || 3099}`)
                : $('serverSettings.mode.inbound'),
            ],
            ...((server.agent.mode || 'outbound') === 'inbound'
              ? [[$('serverSettings.field.panelUrl'), server.agent.panelUrl] as [string, string]]
              : []),
          ]}
        />
        <p className="text-[11px] text-muted-foreground">
          {server.isLocal
            ? $('serverSettings.connection.hintLocal')
            : $('serverSettings.connection.hintRemote')}
        </p>
      </SettingsCard>

      {/* Agent */}
      <SettingsCard
        title="Agent"
        description={
          server.isLocal
            ? $('serverSettings.agent.descLocal')
            : $('serverSettings.agent.descRemote')
        }
        actions={
          <>
            {server.isLocal ? (
              <>
                {server.localAgent?.running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={server.installing}
                    onClick={() => setStopOnlyOpen(true)}
                  >
                    <Square className="h-3.5 w-3.5" /> {$('serverSettings.agent.stop')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={server.installing}
                    onClick={() => localTask('start')}
                  >
                    <Play className="h-3.5 w-3.5" /> {$('serverSettings.agent.start')}
                  </Button>
                )}
                <Button size="sm" onClick={startInstall} disabled={server.installing}>
                  <Download className="h-3.5 w-3.5" />
                  {server.info ? $('serverSettings.agent.reinstall') : $('serverSettings.agent.install')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={server.installing}
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash className="h-3.5 w-3.5" /> {$('serverSettings.agent.uninstall')}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                  {$('serverSettings.agent.manualInstall')}
                </Button>
                <Button size="sm" onClick={startInstall} disabled={server.installing}>
                  <Download className="h-3.5 w-3.5" />
                  {server.info ? $('serverSettings.agent.reinstall') : $('serverSettings.agent.install')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={server.installing}
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash className="h-3.5 w-3.5" /> {$('serverSettings.agent.uninstall')}
                </Button>
              </>
            )}
            <Button variant="outline" size="icon-sm" onClick={load} aria-label={$('serverSettings.agent.refreshAria')}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      >
        {uninstallLog?.lines ? (
          <LogViewer lines={uninstallLog.lines} />
        ) : installLog?.lines ? (
          <LogViewer lines={installLog.lines} />
        ) : server.isLocal ? (
          <div className="grid gap-1.5 text-xs">
            <p className="text-muted-foreground">
              {server.localAgent?.running
                ? $('serverSettings.agent.localRunning', server.localAgent.pid)
                : $('serverSettings.agent.localStopped')}
            </p>
            {server.localAgent && (
              <dl className="grid gap-1 text-muted-foreground sm:grid-cols-[auto,1fr] sm:gap-x-3">
                <dt className="shrink-0">{$('serverSettings.field.dirLabel')}</dt>
                <dd className="break-all font-mono">{server.localAgent.dir}</dd>
                <dt className="shrink-0">{$('serverSettings.field.instancesDir')}</dt>
                <dd className="break-all font-mono">{server.localAgent.instancesDir}</dd>
              </dl>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {server.online
              ? $('serverSettings.agent.onlineHint')
              : $('serverSettings.agent.offlineHint')}
          </p>
        )}
      </SettingsCard>

      {/* Java 环境（多版本安装/切换/卸载） */}
      <JavaCard server={server} javaBusy={javaBusy} javaMsg={javaMsg} onReload={load} onBusyReset={() => { setJavaBusy(false); setJavaMsg(''); }} />

      {/* 系统信息 */}
      <SettingsCard
        title={$('serverSettings.sys.title')}
        description={server.info ? undefined : $('serverSettings.sys.noData')}
      >
        {server.info ? (
          <InfoGrid
            rows={[
              [$('serverSettings.field.hostname'), server.info.hostname],
              [$('serverSettings.field.os'), `${server.info.os} · ${server.info.arch}`],
              ['Node', server.info.node],
              [
                'Agent',
                <span
                  key="agent"
                  className={
                    agentOutdated(server) ? 'text-amber-600 dark:text-amber-400' : undefined
                  }
                >
                  {$('serverSettings.sys.agentRemote')}{' '}
                  {server.info.agentVersion ? (
                    `v${server.info.agentVersion}`
                  ) : (
                    <span className="text-muted-foreground">{$('serverSettings.sys.agentLegacyVersion')}</span>
                  )}{' '}
                  {$('serverSettings.sys.agentLocal', `v${server.agentBundled ?? '—'}`)}
                  {agentOutdated(server) ? $('serverSettings.sys.agentOutdatedSuffix') : ''}
                </span>,
              ],
              [
                $('serverSettings.field.memory'),
                server.stats
                  ? `${fmtMB(server.stats.memUsedMB)} / ${fmtMB(server.stats.memTotalMB)}`
                  : fmtMB(server.info.memTotalMB),
              ],
              [
                $('serverSettings.field.disk'),
                server.stats?.disk
                  ? fmtDiskGB(server.stats.disk.totalGB - server.stats.disk.freeGB, server.stats.disk.totalGB) +
                    $('serverSettings.sys.diskPartition', server.info.instancesDir)
                  : '—',
              ],
              [$('serverSettings.field.instancesDir'), server.info.instancesDir],
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground">{$('serverSettings.sys.waiting')}</p>
        )}
        {/* Agent 版本落后提示：正常由面板自动更新，这里给失败原因与手动重试 */}
        {agentOutdated(server) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
            <span className="min-w-0 flex-1 text-amber-600 dark:text-amber-400">
              {$('serverSettings.agentUpdate.remote', remoteAgentLabel)}
              {$('serverSettings.agentUpdate.behind', `v${server.agentBundled}`)}
              {server.agentUpdate?.state === 'updating'
                ? $('serverSettings.agentUpdate.state.updating')
                : server.agentUpdate?.state === 'failed'
                  ? $('serverSettings.agentUpdate.state.failed', server.agentUpdate.error)
                  : $('serverSettings.agentUpdate.state.waiting')}
            </span>
            {server.agentUpdate?.state !== 'updating' && (
              <Button
                size="sm"
                variant="outline"
                disabled={updatingAgent}
                onClick={async () => {
                  setUpdatingAgent(true);
                  try {
                    await api(`/servers/${serverId}/agent-update`, { method: 'POST', body: {} });
                    success($('serverSettings.agentUpdate.toast.started'), $('serverSettings.agentUpdate.toast.startedDetail'));
                  } catch (e) {
                    error(errText(e));
                  } finally {
                    setUpdatingAgent(false);
                  }
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${updatingAgent ? 'animate-spin' : ''}`} />
                {updatingAgent ? $('serverSettings.agentUpdate.btn.busy') : $('serverSettings.agentUpdate.btn.now')}
              </Button>
            )}
          </div>
        )}
      </SettingsCard>

      {/* 危险操作 */}
      <Card className="mt-4 border-destructive/40">
        <CardContent className="flex flex-wrap items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{$('serverSettings.danger.title')}</div>
            <p className="text-[11px] text-muted-foreground">
              {$('serverSettings.danger.desc')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> {$('common.delete')}
          </Button>
        </CardContent>
      </Card>

      <EditServerDialog server={server} open={editOpen} onOpenChange={setEditOpen} onSaved={load} />
      <TokenDialog server={server} open={tokenOpen} onOpenChange={setTokenOpen} />
      <ManualInstallDialog server={server} open={manualOpen} onOpenChange={setManualOpen} panelPort={me.port} />
      <UninstallDialog
        server={server}
        open={uninstallOpen}
        onOpenChange={setUninstallOpen}
        onDone={load}
      />
      {/* 本机「停止 Agent」复用同一弹窗，只走停止分支 */}
      <UninstallDialog
        server={server}
        open={stopOnlyOpen}
        onOpenChange={setStopOnlyOpen}
        onDone={load}
        stopOnly
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={$('serverSettings.delete.title', server.name)}
        description={
          server.isLocal
            ? $('serverSettings.delete.descLocal')
            : $('serverSettings.delete.descRemote')
        }
        onConfirm={async () => {
          await api(`/servers/${serverId}`, { method: 'DELETE' });
          success($('serverSettings.toast.deleted'));
          onDeleted();
        }}
      />
    </div>
  );
}

/** Java 环境卡：当前生效版本 + 托管版本列表（切换/卸载）+ 安装新版本。
 *  安装走 Temurin JRE（版本齐全、每版本独立目录），旧版 MC（Java 8/11）到最新（25）都覆盖。 */
function JavaCard({
  server,
  javaBusy,
  javaMsg,
  onReload,
  onBusyReset,
}: {
  server: ServerSummary;
  javaBusy: boolean;
  javaMsg: string;
  onReload: () => void;
  /** 切换/卸载等同步操作结束后调用：清掉可能被 install.progress 误置的安装中状态 */
  onBusyReset: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [javas, setJavas] = useState<JavaListResult | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [target, setTarget] = useState('21');
  // 切换/卸载进行中：值为给用户看的提示文案（同步 RPC，返回即结束；期间冻结整卡控件）
  const [acting, setActing] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<JavaEntry | null>(null);
  const frozen = javaBusy || !!acting;

  const refresh = useCallback(() => {
    listJavas(server.id)
      .then((r) => {
        setJavas(r);
        setLoadErr('');
      })
      .catch((e) => setLoadErr(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // java.updated → 页面 load() 刷新 server.info.java → 这里跟着重拉托管版本列表
  useEffect(() => {
    if (server.online) refresh();
  }, [refresh, server.online, server.info?.java?.raw, server.info?.java?.installed]);

  const install = async () => {
    if (frozen) return; // 已有操作在途：按钮虽已禁用，这里再兜一道防连点
    try {
      const r = await api<{ busy?: boolean }>(`/servers/${server.id}/java-install`, {
        method: 'POST',
        body: { major: Number(target) },
      });
      success(r.busy ? $('serverSettings.java.toast.busy') : $('serverSettings.java.toast.queued', target), $('serverSettings.java.toast.queuedDetail'));
    } catch (e) {
      error(errText(e));
    }
  };

  const setDefault = async (t: string, label: string) => {
    setActing($('serverSettings.java.switching', label));
    try {
      await switchJava(server.id, t);
      success($('serverSettings.java.switched', label));
      onReload();
      refresh();
    } catch (e) {
      error($('serverSettings.java.error.switch'), errText(e));
    } finally {
      setActing('');
      onBusyReset();
    }
  };

  const doUninstall = async (entry: JavaEntry) => {
    setActing($('serverSettings.java.uninstalling', entry.name));
    try {
      await uninstallJava(server.id, entry.path);
      success($('serverSettings.java.uninstalled', entry.name));
      setConfirmTarget(null);
      onReload();
      refresh();
    } catch (e) {
      error($('serverSettings.error.uninstall'), errText(e));
    } finally {
      setActing('');
      onBusyReset();
    }
  };

  const info = server.info;
  // 版本列表是切换/卸载后即时拉取的，比面板缓存的 info.java 新——「当前生效」以它为准
  const liveJava = javas?.active ?? info?.java ?? null;
  // 低于 17 意味着跑不了 1.17+ 的实例，提示但不拦启动
  const warn = !!liveJava?.installed && (liveJava.major ?? 0) < 17;

  return (
    <SettingsCard
      title={$('serverSettings.java.title')}
      description={$('serverSettings.java.desc')}
      actions={
        server.online && info ? (
          <div className="flex items-center gap-2">
            <Select value={target} onValueChange={setTarget} disabled={frozen}>
              <SelectTrigger size="sm" className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">{$('serverSettings.java.opt.25')}</SelectItem>
                <SelectItem value="21">{$('serverSettings.java.opt.21')}</SelectItem>
                <SelectItem value="17">{$('serverSettings.java.opt.17')}</SelectItem>
                <SelectItem value="11">{$('serverSettings.java.opt.11')}</SelectItem>
                <SelectItem value="8">{$('serverSettings.java.opt.8')}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="secondary" size="sm" disabled={frozen} onClick={install}>
              {javaBusy ? $('serverSettings.java.btn.installing') : $('serverSettings.java.btn.install')}
            </Button>
          </div>
        ) : null
      }
    >
      {(javaBusy || acting) && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
          {javaBusy ? (
            <>
              {$('serverSettings.java.installingProgress')} {javaMsg && <span className="font-mono">{javaMsg}</span>}
            </>
          ) : (
            acting
          )}
        </div>
      )}

      {info ? (
        <div className="grid gap-2.5">
          <InfoGrid
            rows={[
              [
                $('serverSettings.java.current'),
                <span key="java" className={warn ? 'text-amber-600 dark:text-amber-400' : undefined}>
                  {liveJava?.installed
                    ? $('serverSettings.value.withDetail', liveJava.major, liveJava.raw?.match(/"([^"]+)"/)?.[1] ?? liveJava.raw ?? '')
                    : $('serverSettings.java.notInstalled')}
                </span>,
              ],
            ]}
          />

          {/* 全部安装列表（托管 Temurin + 系统包）：勾选即生效；托管版本可卸载 */}
          {loadErr ? (
            <p className="text-[11px] text-muted-foreground">
              {agentOutdated(server)
                ? $('serverSettings.java.listNeedsAgent', server.info?.agentVersion ?? $('serverSettings.agent.legacyVersion'), server.agentBundled ?? '?')
                : $('serverSettings.java.listLoadFailed', loadErr)}
            </p>
          ) : javas && (javas.managed.length || javas.system) ? (
            <div className="grid gap-1" role="radiogroup" aria-label={$('serverSettings.java.radiogroupAria')}>
              {[...javas.managed, ...(javas.system ? [javas.system] : [])].map((entry) => {
                const sys = entry.path === 'system';
                const ver = entry.raw?.match(/"([^"]+)"/)?.[1];
                return (
                  <div
                    key={entry.path}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
                      entry.active && 'border-emerald-500/40 bg-emerald-500/5',
                    )}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={entry.active}
                      disabled={frozen}
                      title={entry.active ? $('serverSettings.java.current') : $('serverSettings.java.setAsDefault')}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => !entry.active && setDefault(entry.path, sys ? $('serverSettings.java.systemJava') : entry.name)}
                    >
                      <RadioDot checked={entry.active} />
                      <span className="min-w-0 shrink-0 font-mono">{sys ? $('serverSettings.java.systemPackageJava') : entry.name}</span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {ver ? $('serverSettings.java.versionWithRaw', entry.major, ver) : `Java ${entry.major}`}
                      </span>
                    </button>
                    {entry.active ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {$('serverSettings.java.inUse')}
                      </span>
                    ) : sys ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">/usr/bin/java</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={frozen}
                        onClick={() => setConfirmTarget(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> {$('serverSettings.agent.uninstall')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {$('serverSettings.java.emptyHint')}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{$('serverSettings.sys.waiting')}</p>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        onOpenChange={(v) => !v && setConfirmTarget(null)}
        title={$('serverSettings.java.uninstallTitle', confirmTarget?.name ?? '')}
        description={
          confirmTarget?.active
            ? $('serverSettings.java.uninstallDescActive')
            : $('serverSettings.java.uninstallDesc')
        }
        onConfirm={async () => {
          if (confirmTarget) await doUninstall(confirmTarget);
        }}
      />
    </SettingsCard>
  );
}

/** 单选圆点：完整安装列表里「勾选生效」的指示器 */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border',
        checked ? 'border-emerald-500' : 'border-muted-foreground/40',
      )}
    >
      {checked && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
    </span>
  );
}

/** 统一卡片：标题行（+ 右侧操作）+ 内容 */
function SettingsCard({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="mt-4">
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <b className="text-sm">{title}</b>
          {description && <span className="text-[11px] text-muted-foreground">{description}</span>}
          {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** 标签/值对齐的信息网格（标签列按内容自适应，值左对齐） */
function InfoGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-xs">
      {rows.map(([label, value], i) => (
        <div key={i} className="col-span-2 grid grid-cols-subgrid items-baseline gap-x-4">
          <span className="whitespace-nowrap text-muted-foreground">{label}</span>
          <span className="min-w-0 break-words font-mono text-foreground">{value}</span>
        </div>
      ))}
    </div>
  );
}
