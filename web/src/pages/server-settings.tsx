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
          if (e.ok) success('Agent 已上线');
          else info('安装流程结束', 'Agent 未按时回连，请检查面板地址/防火墙');
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
          if (d.ok) success('Java 已就绪', d.java ? `版本 ${d.java.major}` : undefined);
          else error('Java 安装失败', typeof d.error === 'string' ? d.error : undefined);
        }
        return;
      }
      if (e.type === 'uninstall') {
        const key = uninstallLogKey(serverId);
        if (e.log) installLogStore.push(key, e.log);
        if (e.done) {
          installLogStore.markDone(key, !!e.ok);
          if (e.ok) success('Agent 已卸载');
          else error('卸载失败', typeof e.error === 'string' ? e.error : undefined);
          load();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, load]);

  if (!server) {
    return <div className="p-10 text-center text-sm text-muted-foreground">加载中…</div>;
  }

  const startInstall = async () => {
    installLogStore.open(serverId);
    setServer({ ...server, installing: true });
    try {
      await api(`/servers/${serverId}/install`, { method: 'POST', body: {} });
      success('安装任务已开始');
    } catch (e) {
      error('安装启动失败', errText(e));
      setServer((cur) => (cur ? { ...cur, installing: false } : cur));
    }
  };

  /** 本机专属：启动/停止 Agent 进程（不走 SSH，实例数据保留） */
  const localTask = async (kind: 'start' | 'stop') => {
    setServer((cur) => (cur ? { ...cur, installing: true } : cur));
    try {
      await api(`/servers/${serverId}/local-agent/${kind}`, { method: 'POST', body: {} });
      success(kind === 'start' ? '本机 Agent 正在启动' : '本机 Agent 正在停止');
    } catch (e) {
      error(kind === 'start' ? '启动失败' : '停止失败', errText(e));
      setServer((cur) => (cur ? { ...cur, installing: false } : cur));
    }
  };

  const tone = latencyTone(server.latency);

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-24 pt-7">
      {/* 页头 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="返回" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">服务器设置</h2>
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
            延迟 {server.latency === 0 ? '<1' : server.latency}ms
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {server.name} · 最近在线 {timeago(server.lastSeen)}
      </p>

      {/* 连接信息 */}
      <SettingsCard
        title="连接信息"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" /> 编辑
            </Button>
            <Button variant="outline" size="sm" onClick={() => setTokenOpen(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Token
            </Button>
          </>
        }
      >
        <InfoGrid
          rows={[
            ['名称', server.name],
            ['地址', server.host],
            // 本机服务器由面板直管进程，不走 SSH —— 展示凭据没有意义，也容易误导
            ...(server.isLocal
              ? []
              : ([
                  [
                    'SSH',
                    `${server.ssh.user}@${server.host}:${server.ssh.port}（${server.ssh.auth === 'key' ? '私钥' : '密码'}）`,
                  ],
                ] as [string, string][])),
            [
              '连接方式',
              (server.agent.mode || 'outbound') === 'outbound'
                ? `面板连接 Agent（${server.agent.host || server.host}:${server.agent.port || 3099}）`
                : 'Agent 连接面板',
            ],
            ...((server.agent.mode || 'outbound') === 'inbound'
              ? [['回连地址', server.agent.panelUrl] as [string, string]]
              : []),
          ]}
        />
        <p className="text-[11px] text-muted-foreground">
          {server.isLocal
            ? '本机服务器由面板直接托管 Agent 进程，不需要 SSH；只在服务器列表与页头对地址做脱敏展示。'
            : 'SSH 与回连地址用于安装/重装 Agent；只在服务器列表与页头对地址做脱敏展示。'}
        </p>
      </SettingsCard>

      {/* Agent */}
      <SettingsCard
        title="Agent"
        description={
          server.isLocal
            ? '本机 Agent：由面板直接托管进程（专用目录，无需 SSH / systemd）'
            : '通过 SSH 部署到远端（默认 /opt/blocknexus-agent，systemd 托管）'
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
                    <Square className="h-3.5 w-3.5" /> 停止 Agent
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={server.installing}
                    onClick={() => localTask('start')}
                  >
                    <Play className="h-3.5 w-3.5" /> 启动 Agent
                  </Button>
                )}
                <Button size="sm" onClick={startInstall} disabled={server.installing}>
                  <Download className="h-3.5 w-3.5" />
                  {server.info ? '重装' : '安装 Agent'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={server.installing}
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash className="h-3.5 w-3.5" /> 卸载
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                  手动安装
                </Button>
                <Button size="sm" onClick={startInstall} disabled={server.installing}>
                  <Download className="h-3.5 w-3.5" />
                  {server.info ? '重装' : '安装 Agent'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={server.installing}
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash className="h-3.5 w-3.5" /> 卸载
                </Button>
              </>
            )}
            <Button variant="outline" size="icon-sm" onClick={load} aria-label="刷新状态">
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
                ? `本机 Agent 进程运行中（pid ${server.localAgent.pid}）。停止只结束进程，实例与存档保留。`
                : '本机 Agent 未运行。启动后面板会自动连上（实例与存档均保留）。'}
            </p>
            {server.localAgent && (
              <dl className="grid gap-1 text-muted-foreground sm:grid-cols-[auto,1fr] sm:gap-x-3">
                <dt className="shrink-0">专用目录</dt>
                <dd className="break-all font-mono">{server.localAgent.dir}</dd>
                <dt className="shrink-0">实例目录</dt>
                <dd className="break-all font-mono">{server.localAgent.instancesDir}</dd>
              </dl>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {server.online
              ? 'Agent 在线。修改过 SSH 信息或迁移机器后可在此重装。'
              : 'Agent 离线：点击「安装 Agent」通过 SSH 自动部署，或使用「手动安装」拿到命令。'}
          </p>
        )}
      </SettingsCard>

      {/* Java 环境（多版本安装/切换/卸载） */}
      <JavaCard server={server} javaBusy={javaBusy} javaMsg={javaMsg} onReload={load} onBusyReset={() => { setJavaBusy(false); setJavaMsg(''); }} />

      {/* 系统信息 */}
      <SettingsCard
        title="系统信息"
        description={server.info ? undefined : 'Agent 离线时暂无数据'}
      >
        {server.info ? (
          <InfoGrid
            rows={[
              ['主机名', server.info.hostname],
              ['系统', `${server.info.os} · ${server.info.arch}`],
              ['Node', server.info.node],
              [
                'Agent',
                <span
                  key="agent"
                  className={
                    agentOutdated(server) ? 'text-amber-600 dark:text-amber-400' : undefined
                  }
                >
                  远端{' '}
                  {server.info.agentVersion ? (
                    `v${server.info.agentVersion}`
                  ) : (
                    <span className="text-muted-foreground">旧版（未上报版本）</span>
                  )}{' '}
                  · 本地 v{server.agentBundled ?? '—'}
                  {agentOutdated(server) ? '（待自动更新）' : ''}
                </span>,
              ],
              [
                '内存',
                server.stats
                  ? `${fmtMB(server.stats.memUsedMB)} / ${fmtMB(server.stats.memTotalMB)}`
                  : fmtMB(server.info.memTotalMB),
              ],
              [
                '磁盘',
                server.stats?.disk
                  ? fmtDiskGB(server.stats.disk.totalGB - server.stats.disk.freeGB, server.stats.disk.totalGB) +
                    `（${server.info.instancesDir} 所在分区）`
                  : '—',
              ],
              ['实例目录', server.info.instancesDir],
            ]}
          />
        ) : (
          <p className="text-xs text-muted-foreground">等待 Agent 上线后自动获取。</p>
        )}
        {/* Agent 版本落后提示：正常由面板自动更新，这里给失败原因与手动重试 */}
        {agentOutdated(server) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
            <span className="min-w-0 flex-1 text-amber-600 dark:text-amber-400">
              远端 Agent（{server.info?.agentVersion ? `v${server.info.agentVersion}` : '旧版'}）
              落后于面板（v{server.agentBundled}）
              {server.agentUpdate?.state === 'updating'
                ? '，正在自动更新…'
                : server.agentUpdate?.state === 'failed'
                  ? `——自动更新失败：${server.agentUpdate.error}`
                  : '，等待自动更新…'}
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
                    success('更新任务已下发', '结果会通过实时通知反馈');
                  } catch (e) {
                    error(errText(e));
                  } finally {
                    setUpdatingAgent(false);
                  }
                }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${updatingAgent ? 'animate-spin' : ''}`} />
                {updatingAgent ? '下发中…' : '立即更新'}
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
            <div className="text-sm font-medium">删除服务器</div>
            <p className="text-[11px] text-muted-foreground">
              仅从面板移除该服务器及其记录，远端 Agent 与 MC 实例不受影响（可手动卸载）。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" /> 删除
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
        title={`删除服务器「${server.name}」？`}
        description={
          server.isLocal
            ? '仅从面板移除，本机 Agent 进程与实例目录不受影响（可在 Agent 卡停止或卸载）。'
            : '仅从面板移除，远程 Agent 与实例不受影响（可手动卸载）。'
        }
        onConfirm={async () => {
          await api(`/servers/${serverId}`, { method: 'DELETE' });
          success('已删除');
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
      success(r.busy ? 'Java 安装已在进行中' : `Java ${target} 安装任务已下发`, '完成后自动更新状态');
    } catch (e) {
      error(errText(e));
    }
  };

  const setDefault = async (t: string, label: string) => {
    setActing(`正在切换默认 Java 到 ${label}…`);
    try {
      await switchJava(server.id, t);
      success(`默认 Java 已切换到 ${label}`);
      onReload();
      refresh();
    } catch (e) {
      error('切换失败', errText(e));
    } finally {
      setActing('');
      onBusyReset();
    }
  };

  const doUninstall = async (entry: JavaEntry) => {
    setActing(`正在卸载 ${entry.name}…`);
    try {
      await uninstallJava(server.id, entry.path);
      success(`${entry.name} 已卸载`);
      setConfirmTarget(null);
      onReload();
      refresh();
    } catch (e) {
      error('卸载失败', errText(e));
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
      title="Java 环境"
      description="Temurin JRE 多版本管理"
      actions={
        server.online && info ? (
          <div className="flex items-center gap-2">
            <Select value={target} onValueChange={setTarget} disabled={frozen}>
              <SelectTrigger size="sm" className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">Java 25（最新）</SelectItem>
                <SelectItem value="21">Java 21（推荐 · 1.20.5+）</SelectItem>
                <SelectItem value="17">Java 17（1.17 – 1.20.4）</SelectItem>
                <SelectItem value="11">Java 11（旧版备用）</SelectItem>
                <SelectItem value="8">Java 8（MC ≤ 1.16）</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="secondary" size="sm" disabled={frozen} onClick={install}>
              {javaBusy ? '安装中…' : '安装'}
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
              正在安装 Java… {javaMsg && <span className="font-mono">{javaMsg}</span>}
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
                '当前生效',
                <span key="java" className={warn ? 'text-amber-600 dark:text-amber-400' : undefined}>
                  {liveJava?.installed
                    ? `${liveJava.major}（${liveJava.raw?.match(/"([^"]+)"/)?.[1] ?? liveJava.raw ?? ''}）`
                    : '未安装（新版 MC 需 Java 21+，旧版 MC 需 8–17）'}
                </span>,
              ],
            ]}
          />

          {/* 全部安装列表（托管 Temurin + 系统包）：勾选即生效；托管版本可卸载 */}
          {loadErr ? (
            <p className="text-[11px] text-muted-foreground">
              {agentOutdated(server)
                ? `版本列表需要更新的 Agent 支持——远端 v${server.info?.agentVersion ?? '旧版'} 将自动更新到 v${server.agentBundled ?? '?'}`
                : `版本列表获取失败：${loadErr}`}
            </p>
          ) : javas && (javas.managed.length || javas.system) ? (
            <div className="grid gap-1" role="radiogroup" aria-label="默认 Java 版本">
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
                      title={entry.active ? '当前生效' : '设为默认'}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => !entry.active && setDefault(entry.path, sys ? '系统 Java' : entry.name)}
                    >
                      <RadioDot checked={entry.active} />
                      <span className="min-w-0 shrink-0 font-mono">{sys ? '系统包 Java' : entry.name}</span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {ver ? `Java ${entry.major} · ${ver}` : `Java ${entry.major}`}
                      </span>
                    </button>
                    {entry.active ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 使用中
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
                        <Trash2 className="h-3.5 w-3.5" /> 卸载
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              服务器上没有发现可用的 Java——选择版本点「安装」，会下载 Temurin JRE 到 /opt/blocknexus-java 并设为默认；各版本独立目录，可随时切换或卸载。
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">等待 Agent 上线后自动获取。</p>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        onOpenChange={(v) => !v && setConfirmTarget(null)}
        title={`卸载 ${confirmTarget?.name ?? ''}？`}
        description={
          confirmTarget?.active
            ? '这是当前默认版本，卸载时会自动切换到其余版本或系统 Java。该操作不可恢复。'
            : '将永久删除该版本的安装目录。该操作不可恢复。'
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
