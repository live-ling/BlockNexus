import { navigate } from '@/lib/router';
// 服务器设置页：连接信息 / Agent 管理 / Java 环境 / 系统信息 / 危险操作
// 路由 #/server/<serverId>/settings
//
// 信息架构（改版后）：
//   Agent 卡 ① 状态头部（图标 + 标题 + 说明 + 运行胶囊）
//            ② 版本对照区 —— 只在远端落后于面板随附版本时出现
//            ③ 动作区（灰底独立条带）—— **同一时刻只有一个实心主按钮**
//            ④ 元信息（监听地址 / 安装目录 / 实例目录）
//            + 可折叠的安装/更新日志（默认收起，结束自动收起）
//   Java 卡  ① 头部（全卡唯一说「当前使用」的地方）
//            ② 安装新版本条带（左文案右控件）
//            ③ 版本列表（每行四段，右侧动作列位完全对齐）
//
// ⚠ 关键回归点：Agent 更新入口**只**在 Agent 卡里。它一度被放在系统信息卡底部，
//   与 Agent 卡的「安装/重装」分裂成两个入口（用户不知道点哪个）——别再搬回去。

import { useCallback, useEffect, useRef, useSyncExternalStore, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Download,
  Ellipsis,
  FileText,
  KeyRound,
  Lock,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash,
  Trash2,
} from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { SettingsLayout } from '@/components/layout/settings-layout';
import { AgentStatusPill } from '@/components/layout/status';
import { SettingsCard, StateChip } from '@/components/settings-card';
import { Button } from '@/components/ui/button';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  agentVersionText,
  errText,
  fmtDiskGB,
  fmtMB,
  javaVersionText,
  latencyTone,
  listJavas,
  osLabel,
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
  // 安装/更新日志：默认收起。一次安装几百行，平铺会把卡片里其他内容全顶走
  const [logOpen, setLogOpen] = useState(false);
  // 用户手动开合过就以用户为准，直到这一次任务结束（结束后复位）
  const manualLogRef = useRef(false);

  const installLog = useSyncExternalStore(installLogStore.subscribe, () => installLogStore.get(serverId));
  const uninstallLog = useSyncExternalStore(installLogStore.subscribe, () => installLogStore.get(uninstallLogKey(serverId)));

  // 同一时刻只可能跑一个任务：卸载日志优先，其次安装/更新日志
  const activeLog = uninstallLog?.lines ? uninstallLog : installLog?.lines ? installLog : null;
  const logLines = activeLog?.lines ?? '';
  const logDone = activeLog?.done ?? null;
  const logCount = logLines ? logLines.split('\n').filter((l) => l.trim()).length : 0;

  // 任务进行中自动展开（要看进度），结束（成功或失败）后自动收起，不长期占据页面
  useEffect(() => {
    if (!logLines) return;
    if (logDone === null) {
      if (!manualLogRef.current) setLogOpen(true);
      return;
    }
    manualLogRef.current = false;
    setLogOpen(false);
  }, [logLines, logDone]);

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
      // Agent 自动/手动更新进度：就地更新状态（版本对照区的三态文案用它），
      // 日志并进同一块折叠面板；结束后重拉一次拿新的远端版本号。
      if (e.type === 'agent-update') {
        setServer((cur) => (cur ? { ...cur, agentUpdate: { state: e.state, error: e.error } } : cur));
        if (e.state === 'updating' && !installLogStore.get(serverId)) installLogStore.open(serverId);
        if (e.log) installLogStore.push(serverId, e.log);
        if (e.state !== 'updating') {
          installLogStore.markDone(serverId, e.state === 'done');
          load();
        }
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
          // 「停止本机 Agent」走的是同一类任务日志，但结果不该说成「已卸载」
          if (e.ok) success($(e.stopped ? 'serverSettings.toast.agentStopped' : 'serverSettings.toast.agentUninstalled'));
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

  /**
   * 手动触发远端 Agent 更新（正常由面板在 hi 时自动做，这里是失败/被限流后的兜底）。
   * 只发一次请求，结果经 SSE agent-update 推送——所以按钮的转圈由本地在途状态
   * 与 server.agentUpdate.state 共同决定。
   */
  const updateAgent = async () => {
    setUpdatingAgent(true);
    try {
      await api(`/servers/${serverId}/agent-update`, { method: 'POST', body: {} });
      success($('serverSettings.agentUpdate.toast.started'), $('serverSettings.agentUpdate.toast.startedDetail'));
    } catch (e) {
      error(errText(e));
    } finally {
      setUpdatingAgent(false);
    }
  };

  const tone = latencyTone(server.latency);
  const outdated = agentOutdated(server);
  const agentRunning = server.isLocal ? !!server.localAgent?.running : server.online;
  const agentPid = server.isLocal ? server.localAgent?.pid : undefined;
  // 远端版本的展示值统一从这里取（裸版本号 + 自己补 'v'）；没有版本号的旧 Agent 显示「旧版」
  const remoteVer = server.info?.agentVersion
    ? `v${agentVersionText(server.info.agentVersion)}`
    : $('serverSettings.agent.legacyVersion');
  const bundledVer = agentVersionText(server.agentBundled);
  const updating = updatingAgent || server.agentUpdate?.state === 'updating';
  // 安装前条件：面板只能确认「目标地址/用户已填」与「凭据已存」，
  // root 权限是目标机上的事实，面板无从核实 → 永远按「待确认」显示（黄问号）
  const sshReady = !!server.host && !!server.ssh.user;
  const credReady = server.ssh.auth === 'key' ? server.ssh.hasKey : server.ssh.hasPassword;
  const outbound = (server.agent.mode || 'outbound') === 'outbound';

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader
        back={onBack}
        title={$('serverSettings.title')}
        subtitle={
          <span className="inline-flex min-w-0 items-center gap-2">
            {/* 服务器名的归属在页面标题上；这里只说「连得怎么样、多久没见了」 */}
            <AgentStatusPill online={server.online} installing={server.installing} />
            {server.latency != null && (
              <span
                className={`font-mono ${
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
            <span className="truncate">
              {$('serverSettings.lastSeen', server.name, timeago(server.lastSeen))}
            </span>
          </span>
        }
      />

      <SettingsLayout
        contentClassName="max-w-[1080px]"
        sections={[
          {
            id: 'connection',
            label: $('serverSettings.connection.title'),
            heading: false,
            content: (
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
              // 连接方向只说方向：地址交给下一行，同一串地址不在这张卡里说两遍
              $('serverSettings.field.mode'),
              outbound
                ? $('serverSettings.agent.meta.outbound')
                : $('serverSettings.agent.meta.inbound'),
            ],
            [
              outbound ? $('serverSettings.agent.meta.addr') : $('serverSettings.field.panelUrl'),
              (outbound
                ? `${server.agent.host || server.host}:${server.agent.port || 3099}`
                : server.agent.panelUrl) || '—',
            ],
            // 下面三行原先在 Agent 卡底部：它们讲的是 Agent 落在哪、实例放哪，
            // 和连接信息本来就是一回事，放一起看少一次来回滚动
            [
              server.isLocal ? $('serverSettings.field.dirLabel') : $('serverSettings.agent.meta.dir'),
              (server.isLocal ? server.localAgent?.dir : server.agent.installDir) || '—',
            ],
            [
              $('serverSettings.agent.meta.instancesDir'),
              server.info?.instancesDir || server.localAgent?.instancesDir || '—',
            ],
          ]}
        />
        <p className="text-[11px] text-muted-foreground">
          {server.isLocal
            ? $('serverSettings.connection.hintLocal')
            : $('serverSettings.connection.hintRemote')}
        </p>
              </SettingsCard>
            ),
          },
          {
            id: 'agent',
            label: $('serverSettings.agent.title'),
            heading: false,
            content: (
              <SettingsCard
        title={$('serverSettings.agent.title')}
        // 装上了就讲「它是干什么的」，没装上就讲「它会怎么被装上」
        description={
          server.info
            ? $('serverSettings.agent.hint')
            : server.isLocal
              ? $('serverSettings.agent.descLocal')
              : $('serverSettings.agent.descRemote')
        }
        status={<AgentStatePill server={server} />}
      >
        {/* 版本现状：落后时由下面的对照区接管——两者占同一个位置、只显示一处，
            所以同一组版本号永远不会在同一张卡里说两遍 */}
        {server.info && !outdated && (
          <p className="text-[11px] text-muted-foreground">
            {$('serverSettings.sys.agentRemote')}{' '}
            {server.info.agentVersion ? (
              `v${agentVersionText(server.info.agentVersion)}`
            ) : (
              $('serverSettings.sys.agentLegacyVersion')
            )}{' '}
            {/* 译文是 '· 本地 v{0}'（自带 v）→ 这里只能传裸版本号，
                否则会渲染成「本地 vv0.5.0」 */}
            {$('serverSettings.sys.agentLocal', agentVersionText(server.agentBundled))}
          </p>
        )}

        {/* ② 版本对照区：只在落后时渲染，不落后就完全不出现 */}
        {outdated && (
          <div className="grid gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {$('serverSettings.agent.outdated.title')}
            </div>
            <div className="flex items-center gap-3">
              <span className="grid gap-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {$('serverSettings.agent.outdated.current')}
                </span>
                <span className="font-mono text-xs text-foreground">{remoteVer}</span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="grid gap-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {$('serverSettings.agent.outdated.bundled')}
                </span>
                {/* 译文自带 v 前缀 → 这里只能传裸版本号，否则会出现 vv0.5.0 */}
                <span className="font-mono text-xs text-foreground">{`v${bundledVer}`}</span>
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {$('serverSettings.agent.outdated.impact')}
            </p>
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {$('serverSettings.agentUpdate.remote', remoteVer)}
              {$('serverSettings.agentUpdate.behind', bundledVer)}
              {server.agentUpdate?.state === 'updating'
                ? $('serverSettings.agentUpdate.state.updating')
                : server.agentUpdate?.state === 'failed'
                  ? // 失败原因一律给出可见文本（没有原因也不能渲染成占位符）
                    $('serverSettings.agentUpdate.state.failed', server.agentUpdate.error || '—')
                  : $('serverSettings.agentUpdate.state.waiting')}
            </p>
          </div>
        )}

        {/* 未安装（远端）：装之前该确认的事。条件不都画成绿的——root 权限面板无从核实 */}
        {!server.info && !server.isLocal && !server.installing && (
          <div className="grid gap-2 rounded-lg border border-dashed px-3 py-2.5">
            <div className="text-[12.5px] font-medium">{$('serverSettings.agent.prereq.title')}</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <PrereqItem ok={sshReady}>{$('serverSettings.agent.prereq.ssh')}</PrereqItem>
              <PrereqItem ok={credReady}>{$('serverSettings.agent.prereq.credential')}</PrereqItem>
              <PrereqItem ok={false} todo>
                {$('serverSettings.agent.prereq.root')}
              </PrereqItem>
            </div>
          </div>
        )}

        {/* ⑤ 安装/更新日志：可折叠，默认收起，结束自动收起 */}
        {logLines && (
          <div className="overflow-hidden rounded-lg border">
            <button
              type="button"
              onClick={() => {
                manualLogRef.current = true;
                setLogOpen((v) => !v);
              }}
              className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', logOpen && 'rotate-90')}
              />
              <span className={cn('text-[11px] font-medium', logDone === false && 'text-destructive')}>
                {logDone === false
                  ? $('serverSettings.agent.log.failed')
                  : $('serverSettings.agent.log.title', logCount)}
              </span>
              {logDone === null && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-500 opacity-60" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
                  </span>
                  {$('serverSettings.agent.log.running')}
                </span>
              )}
            </button>
            {logOpen && <LogViewer lines={logLines} className="p-1.5" />}
          </div>
        )}

        {/* ③ 动作区：独立灰底条带。主操作只有一个 */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
          {outdated ? (
            <Button size="sm" disabled={updating || server.installing} onClick={updateAgent}>
              <RefreshCw className={cn('h-3.5 w-3.5', updating && 'animate-spin')} />
              {updating
                ? $('serverSettings.agentUpdate.btn.busy')
                : $('serverSettings.agent.btn.updateTo', bundledVer)}
            </Button>
          ) : server.info ? (
            // 已装且最新：主操作降级为 outline 的「重新安装」，不再抢占视线
            <Button variant="outline" size="sm" disabled={server.installing} onClick={startInstall}>
              <Download className="h-3.5 w-3.5" /> {$('serverSettings.agent.more.reinstall')}
            </Button>
          ) : (
            <Button size="sm" disabled={server.installing} onClick={startInstall}>
              <Download className="h-3.5 w-3.5" />
              {server.isLocal
                ? $('serverSettings.agent.install')
                : $('serverSettings.agent.installSsh')}
            </Button>
          )}

          {server.isLocal &&
            (agentRunning ? (
              <Button
                variant="outline"
                size="sm"
                disabled={server.installing}
                onClick={() => setStopOnlyOpen(true)}
              >
                <Square className="h-3.5 w-3.5" /> {$('serverSettings.agent.stop')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={server.installing} onClick={() => localTask('start')}>
                <Play className="h-3.5 w-3.5" /> {$('serverSettings.agent.start')}
              </Button>
            ))}

          {!server.info && !server.isLocal && (
            <>
              <Button variant="outline" size="sm" onClick={() => setManualOpen(true)}>
                <FileText className="h-3.5 w-3.5" /> {$('serverSettings.agent.manualInstall')}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {$('serverSettings.agent.prereq.duration')}
              </span>
            </>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={load}
              aria-label={$('serverSettings.agent.refreshAria')}
              title={$('serverSettings.agent.refreshAria')}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            {/* 「更多」：重装/手动安装/Token 与卸载的二级入口。卸载垫了分隔线 + 红字 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Ellipsis className="h-3.5 w-3.5" /> {$('serverSettings.agent.more')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem disabled={server.installing} onClick={startInstall}>
                  <Download className="h-3.5 w-3.5" />
                  {server.info
                    ? $('serverSettings.agent.more.reinstall')
                    : $('serverSettings.agent.install')}
                </DropdownMenuItem>
                {/* 本机服务器不走 SSH，手动安装指引对它没有意义 */}
                {!server.isLocal && (
                  <DropdownMenuItem onClick={() => setManualOpen(true)}>
                    <FileText className="h-3.5 w-3.5" /> {$('serverSettings.agent.manualInstall')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setTokenOpen(true)}>
                  <KeyRound className="h-3.5 w-3.5" /> {$('serverSettings.agent.more.token')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={server.installing}
                  className="text-destructive focus:text-destructive"
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash className="h-3.5 w-3.5" /> {$('serverSettings.agent.uninstall')}
                </DropdownMenuItem>
                <div className="px-1.5 pb-0.5 pt-1 text-[10.5px] leading-snug text-muted-foreground">
                  {$('serverSettings.agent.more.uninstallHint')}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* 本机专属：说明「停止/启动」到底动了什么 */}
        {server.isLocal && (
          <p className="text-[11px] text-muted-foreground">
            {agentRunning && agentPid
              ? $('serverSettings.agent.localRunning', agentPid)
              : $('serverSettings.agent.localStopped')}
          </p>
        )}
        {/* 监听地址 / 安装目录 / 实例目录已并入上面的「连接信息」卡 */}
              </SettingsCard>
            ),
          },
          {
            id: 'java',
            label: $('serverSettings.java.title'),
            heading: false,
            content: (
              <JavaCard
        server={server}
        javaBusy={javaBusy}
        javaMsg={javaMsg}
        onReload={load}
        onBusyReset={() => {
          setJavaBusy(false);
          setJavaMsg('');
        }}
              />
            ),
          },
          {
            id: 'system',
            label: $('serverSettings.sys.title'),
            heading: false,
            content: (
              <SettingsCard
        title={$('serverSettings.sys.title')}
        description={server.info ? undefined : $('serverSettings.sys.locked.hint')}
        status={
          server.info ? undefined : (
            <StateChip ok={false} okText="" badText={$('serverSettings.java.locked.badge')} />
          )
        }
      >
        {server.info ? (
          <InfoGrid
            rows={[
              [$('serverSettings.field.hostname'), server.info.hostname],
              [$('serverSettings.field.os'), `${osLabel(server.info.os)} · ${server.info.arch}`],
              ['Node', server.info.node],
              [
                // Agent 版本那行已移进「Agent 守护进程」卡（那里才是它该待的地方）
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
              // 实例目录已随另外两行一起移进「连接信息」卡，这里不再重复（分区归属
              // 由上面磁盘那行的括号说明，不需要单独一行路径）
            ]}
          />
        ) : (
          // 未安装/未上报：锁定态而不是空白（说明为什么读不到、装上能得到什么）
          <LockedNotice note={$('serverSettings.sys.locked.sysHint')} />
        )}
              </SettingsCard>
            ),
          },
          {
            id: 'danger',
            label: $('serverSettings.danger.title'),
            heading: false,
            content: (
              <section className="flex flex-wrap items-center gap-3 border-t border-destructive/30 pt-4">
        <AlertTriangle className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-destructive">{$('serverSettings.danger.title')}</div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {$('serverSettings.danger.desc')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3.5" /> {$('common.delete')}
        </Button>
              </section>
            ),
          },
        ]}
      />

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

/** Java 环境卡：① 头部（当前使用版本）② 安装新版本条带 ③ 统一行态的版本列表。
 *  安装走 Temurin JRE（版本齐全、每版本独立目录），旧版 MC（Java 8/11）到最新（25）都覆盖。
 *  导出：本仓测试环境是 node（无 jsdom），锁定态/头部文案用 renderToStaticMarkup 静态验证。 */
export function JavaCard({
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
  // 版本列表默认收起：装过五六个版本时这一列能占掉半屏。
  // 收起不丢信息——数量在计数位、当前版本在卡片头部徽章。
  const [listOpen, setListOpen] = useState(false);
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
  // Agent 没上报过系统信息 → 这一卡读不到任何数据，整个转锁定态
  const locked = !info;
  const entries: JavaEntry[] = javas ? [...javas.managed, ...(javas.system ? [javas.system] : [])] : [];
  const total = entries.length;

  return (
    <SettingsCard
      title={$('serverSettings.java.title')}
      description={locked ? $('serverSettings.java.locked.hint') : $('serverSettings.java.desc')}
      status={
        locked ? (
          <StatePill tone="idle">{$('serverSettings.java.locked.badge')}</StatePill>
        ) : liveJava?.installed ? (
          // 全卡唯一说「当前使用」的地方——列表里不再重复一遍
          // 呼吸点只在正常状态用；Java < 17 的琥珀提示不该看起来像「进行中」
          <StatePill tone={warn ? 'warn' : 'ok'} pulse={!warn}>
            {$('serverSettings.java.header', liveJava.major ?? '—')}
          </StatePill>
        ) : (
          <StatePill tone="idle">{$('serverSettings.java.none')}</StatePill>
        )
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

      {locked ? (
        <LockedNotice note={$('serverSettings.java.locked.installHint')} />
      ) : (
        <div className="grid gap-3">
          {/* ② 安装新版本：左文案右控件（不再和卡片标题抢位置） */}
          {server.online && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-2">
              <div className="min-w-0">
                <div className="text-[12.5px] font-medium">{$('serverSettings.java.install.title')}</div>
                <p className="text-[11px] text-muted-foreground">{$('serverSettings.java.install.hint')}</p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Select value={target} onValueChange={setTarget} disabled={frozen}>
                  <SelectTrigger size="sm" className="w-[186px]">
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
                <Button size="sm" disabled={frozen} onClick={install}>
                  {javaBusy ? $('serverSettings.java.btn.installing') : $('serverSettings.java.btn.install')}
                </Button>
              </div>
            </div>
          )}

          {/* ③ 版本列表：托管 Temurin + 系统包，点圆点或「设为默认」切换 */}
          {loadErr ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                {agentOutdated(server)
                  ? $(
                      'serverSettings.java.listNeedsAgent',
                      // 译文里已写 '远端 v{0} … v{1}' → 两个参数都传裸版本号
                      server.info?.agentVersion
                        ? agentVersionText(server.info.agentVersion)
                        : $('serverSettings.agent.legacyVersion'),
                      agentVersionText(server.agentBundled, '?'),
                    )
                  : $('serverSettings.java.listLoadFailed', loadErr)}
              </span>
            </div>
          ) : !javas ? (
            <p className="text-[11px] text-muted-foreground">{$('serverSettings.sys.waiting')}</p>
          ) : total === 0 ? (
            <p className="text-[11px] text-muted-foreground">{$('serverSettings.java.emptyHint')}</p>
          ) : (
            <div className="grid gap-2">
              {/* 折叠头：整行可点，箭头状态与 aria-expanded 一起给出开合状态 */}
              <button
                type="button"
                aria-expanded={listOpen}
                onClick={() => setListOpen((v) => !v)}
                className="flex items-center gap-2 rounded-md py-0.5 text-left"
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                    listOpen && 'rotate-90',
                  )}
                />
                <span className="text-[12.5px] font-medium">{$('serverSettings.java.installed')}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{total}</span>
              </button>
              {listOpen && (
                // 用 subgrid 把每行的 [圆点|名称|徽章|按钮|图标] 五列对齐，
                // 系统包的锁占位也照样占住最后一列——右侧动作列位不会随行态跳动
                <div
                  role="radiogroup"
                  aria-label={$('serverSettings.java.radiogroupAria')}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5"
                >
                  {entries.map((entry) => {
                    const sys = entry.path === 'system';
                    const ver = javaVersionText(entry);
                    const label = sys ? $('serverSettings.java.systemJava') : entry.name;
                    return (
                      <div
                        key={entry.path}
                        className={cn(
                          'col-span-5 grid grid-cols-subgrid items-center gap-x-2 rounded-lg border px-2.5 py-2',
                          entry.active && 'border-emerald-500/40 bg-emerald-500/5',
                        )}
                      >
                        <button
                          type="button"
                          role="radio"
                          aria-checked={entry.active}
                          disabled={frozen}
                          title={
                            entry.active
                              ? $('serverSettings.java.current')
                              : $('serverSettings.java.setAsDefault')
                          }
                          // 负外边距 + 内边距：把 14px 的圆点做成 30px 的可点区域，又不撑动列宽
                          className="-m-1 rounded-full p-1 disabled:pointer-events-none disabled:opacity-50"
                          onClick={() => !entry.active && setDefault(entry.path, label)}
                        >
                          <RadioDot checked={entry.active} />
                        </button>

                        <div className="grid min-w-0 gap-0.5">
                          <span className="truncate font-mono text-[13.5px] font-semibold">
                            {/* 解析不出 major 时退回目录名，绝不渲染成「Java 0」 */}
                            {sys
                              ? $('serverSettings.java.systemJava')
                              : entry.major
                                ? `Java ${entry.major}`
                                : entry.name}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {sys
                              ? ver
                                ? $('serverSettings.java.systemDetail', ver, $('serverSettings.java.systemNote'))
                                : $('serverSettings.java.systemNote')
                              : ver
                                ? $('serverSettings.java.managedDetail', ver, entry.path)
                                : entry.path}
                          </span>
                        </div>

                        {/* 徽章列：非当前版本留空占位，保证后面两列对齐 */}
                        <div className="justify-self-end">
                          {entry.active && (
                            // 「使用中」用实心绿（成功色 #10B981）——整页唯一一处实心徽章，
                            // 一眼就能在版本列表里找到当前生效的那个
                            <span className="inline-flex h-6 items-center rounded-full bg-emerald-500 px-2 text-[11px] font-medium whitespace-nowrap text-white">
                              {$('serverSettings.java.inUse')}
                            </span>
                          )}
                        </div>

                        {entry.active ? (
                          // 当前版本仍占住按钮位（灰底禁用），点了没意义但不让列位跳动
                          <Button variant="secondary" size="sm" disabled>
                            {$('serverSettings.java.setAsDefault')}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={frozen}
                            onClick={() => setDefault(entry.path, label)}
                          >
                            {$('serverSettings.java.setAsDefault')}
                          </Button>
                        )}

                        <div className="justify-self-end">
                          {sys || entry.removable === false ? (
                            // 系统包/厂商装的 JDK 归系统管：面板不卸载它，用灰色锁占位（列位不跳动）
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled
                              title={sys ? $('serverSettings.java.systemNote') : $('serverSettings.java.externalNote')}
                              aria-label={sys ? $('serverSettings.java.systemNote') : $('serverSettings.java.externalNote')}
                            >
                              <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              disabled={frozen}
                              title={$('serverSettings.agent.uninstall')}
                              aria-label={$('serverSettings.agent.uninstall')}
                              onClick={() => setConfirmTarget(entry)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
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

/** Agent 运行状态胶囊：本机看进程记录（带 PID），远端只有在线与否 */
function AgentStatePill({ server }: { server: ServerSummary }) {
  if (server.installing) return <StatePill tone="idle" pulse>{$('badge.installing')}</StatePill>;
  if (server.isLocal) {
    const pid = server.localAgent?.pid;
    return server.localAgent?.running ? (
      <StatePill tone="ok" pulse>
        {pid ? $('serverSettings.agent.running.pid', pid) : $('serverSettings.agent.running')}
      </StatePill>
    ) : (
      <StatePill tone="idle">{$('serverSettings.agent.stopped')}</StatePill>
    );
  }
  return server.online ? (
    <StatePill tone="ok" pulse>
      {$('serverSettings.agent.running')}
    </StatePill>
  ) : (
    <StatePill tone="idle">{$('badge.offline')}</StatePill>
  );
}

/** 状态胶囊：绿=运行中（呼吸圆点）/ 琥珀=需注意 / 灰=未运行、不可用 */
function StatePill({
  tone,
  pulse,
  children,
}: {
  tone: 'ok' | 'warn' | 'idle';
  pulse?: boolean;
  children: React.ReactNode;
}) {
  const box =
    tone === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'border-border bg-muted/60 text-muted-foreground';
  const dot =
    tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-muted-foreground/60';
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap',
        box,
      )}
    >
      <span className="relative flex size-1.5">
        {pulse && (
          <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', dot)} />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full', dot)} />
      </span>
      {children}
    </span>
  );
}

/** 安装前条件项：绿勾=已就绪，黄问号=面板无从核实（别把所有条件都画成绿的） */
function PrereqItem({
  ok,
  todo,
  children,
}: {
  ok: boolean;
  todo?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px]',
        ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
      )}
    >
      {ok ? (
        <CircleCheck className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <CircleQuestionMark className="h-3.5 w-3.5 shrink-0" />
      )}
      {children}
      {todo && !ok && (
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
          {$('serverSettings.agent.prereq.todo')}
        </span>
      )}
    </span>
  );
}

/** 锁定态提示：卡片头部已说明「为什么读不到」，这里给「装上能得到什么」 */
function LockedNotice({ note }: { note: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-2.5 text-[11px] text-muted-foreground">
      <Lock className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{note}</span>
    </div>
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

/** 标签/值对齐的信息网格（宽屏两列，一行一对；标签列按内容自适应） */
function InfoGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid gap-x-10 gap-y-2.5 text-[12px] sm:grid-cols-2">
      {rows.map(([label, value], i) => (
        <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4">
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">{label}</span>
          <span className="min-w-0 break-words font-mono text-foreground">{value}</span>
        </div>
      ))}
    </div>
  );
}
