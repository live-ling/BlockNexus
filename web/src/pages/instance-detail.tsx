// 实例详情页：顶部常驻终端，下方控制按钮与实例信息
// 路由 #/server/<serverId>/instance/<name>

import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ArrowLeft, Ban, CalendarClock, CloudDownload, FolderOpen, Globe, LogOut, MoreVertical, Pencil, Play, Puzzle, RotateCw, Settings2, ShieldCheck, ShieldOff, SlidersHorizontal, Sparkles, Square, Terminal, Trash2, Users, Activity } from 'lucide-react';
import { AiLogPanel } from '@/components/ai-log-panel';
import { BackupDialog } from '@/components/backup-dialog';
import { ConsolePanel } from '@/components/console-panel';
import { ConfirmDialog, EditInstanceDialog, ReinstallDialog } from '@/components/dialogs';
import { FileManagerDialog } from '@/components/file-manager';
import { BanListDialog } from '@/components/ban-list-dialog';
import { ModManagerDialog } from '@/components/mod-manager';
import { AutoRestartDialog } from '@/components/auto-restart-dialog';
import { BackupScheduleDialog } from '@/components/backup-schedule-dialog';
import { PropertiesDialog } from '@/components/properties-dialog';
import { PluginConfigDialog } from '@/components/plugin-config-dialog';
import { SparkPanel } from '@/components/spark-panel';
import { InstanceStatusBadge, LatencyBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  api,
  errText,
  fmtMB,
  fmtUptime,
  type Instance,
  type PlayersSnapshot,
  type ServerSummary,
} from '@/lib/api';
import { $, getLanguage } from '@/lib/i18n';
import { subscribeServer } from '@/lib/sse';
import { copyText } from '@/lib/clipboard';
import { useToastHelpers } from '@/lib/toast';

export function InstanceDetailPage({
  serverId,
  instanceName,
  onBack,
}: {
  serverId: string;
  instanceName: string;
  onBack: () => void;
}) {
  const { success, error } = useToastHelpers();
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [players, setPlayers] = useState<PlayersSnapshot[string] | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupScheduleOpen, setBackupScheduleOpen] = useState(false);
  const [watchdogOpen, setWatchdogOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [plugCfgOpen, setPlugCfgOpen] = useState(false);
  // 是否存在 plugins/ 或 config/ 目录：vanilla 实例不显示「插件配置」入口
  const [hasConfigDirs, setHasConfigDirs] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reinstallOpen, setReinstallOpen] = useState(false);
  const [backupBeforeDelete, setBackupBeforeDelete] = useState(true);
  const [busy, setBusy] = useState(false);
  // 玩家快捷管理：待确认的操作（踢出/封禁/封禁 IP 统一走模态框，原因可选）
  const [playerAction, setPlayerAction] = useState<{ name: string; kind: 'kick' | 'ban' | 'ban-ip' } | null>(null);
  // 域名连通检测状态
  const [domainCheck, setDomainCheck] = useState<
    { state: 'checking' | 'done'; result?: DomainCheckResult } | null
  >(null);
  const [bansOpen, setBansOpen] = useState(false);
  // 主区视图：终端 / AI 日志分析 / spark 性能
  const [mainView, setMainView] = useState<'console' | 'ai' | 'spark'>('console');
  const [, forceTick] = useState(0);

  const loadServer = useCallback(() => {
    api<ServerSummary>(`/servers/${serverId}`)
      .then(setServer)
      .catch((e) => error(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const loadInstance = useCallback(() => {
    api<Instance[]>(`/servers/${serverId}/instances`)
      .then((list) => {
        const hit = list.find((i) => i.name === instanceName);
        if (hit) setInstance(hit);
        else setNotFound(true);
      })
      .catch((e) => error($('instanceDetail.error.load'), errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  const loadPlayers = useCallback(() => {
    api<PlayersSnapshot>(`/servers/${serverId}/players`)
      .then((snap) => setPlayers(snap[instanceName] ?? null))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  useEffect(() => {
    loadServer();
    loadInstance();
    loadPlayers();
  }, [loadServer, loadInstance, loadPlayers]);

  // 探测实例根目录有没有 plugins/ / config/（静默失败，只是入口显隐）
  useEffect(() => {
    let alive = true;
    api<{ name: string; type: 'dir' | 'file' }[]>(
      `/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/files?path=`,
    )
      .then((entries) => {
        if (alive) {
          setHasConfigDirs(entries.some((e) => e.type === 'dir' && (e.name === 'plugins' || e.name === 'config')));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [serverId, instanceName]);

  // 运行中：每 20 秒刷新在线人数；启动中不查询（服务端还没开始监听）
  const running = instance?.status === 'running';
  const starting = instance?.status === 'starting';
  const active = running || starting;
  // spark 被卸载（Mod 管理删除）时若正停留在 Spark 视图，退回终端
  useEffect(() => {
    if (instance && !instance.sparkInstalled && mainView === 'spark') setMainView('console');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.sparkInstalled]);
  useEffect(() => {
    if (!running) return;
    loadPlayers();
    const t1 = window.setInterval(loadPlayers, 20000);
    const t2 = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => {
      window.clearInterval(t1);
      window.clearInterval(t2);
    };
  }, [running, loadPlayers]);

  // 实时事件：状态/延迟变化
  useEffect(() => {
    return subscribeServer(serverId, (e) => {
      if (e.type === 'latency') {
        setServer((cur) => (cur ? { ...cur, latency: e.latency } : cur));
        return;
      }
      if (e.type === 'status') {
        loadServer();
        loadInstance();
        if (e.status === 'online') loadPlayers();
        return;
      }
      if (e.type === 'agent-event' && e.event === 'instance.updated' && e.data?.instance === instanceName) {
        loadInstance();
        setTimeout(loadPlayers, 1500);
      }
      // 定时备份的完成/失败通知（手动备份的完成提示在备份对话框里处理）
      if (
        e.type === 'agent-event' &&
        e.event === 'backup.updated' &&
        e.data?.instance === instanceName &&
        e.data?.trigger === 'schedule' &&
        e.data?.done
      ) {
        if (e.data.ok) success($('instanceDetail.backup.done'), String(e.data.file || ''));
        else error($('instanceDetail.backup.failed'), String(e.data.error || $('common.unknown')));
        loadInstance();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, instanceName]);

  /** 玩家快捷管理：向实例控制台发送指令（kick / ban / op / deop 等），返回是否成功 */
  const sendPlayerCmd = useCallback(
    async (cmd: string, okText: string) => {
      try {
        await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/command`, {
          method: 'POST',
          body: { cmd },
        });
        success(okText, $('instanceDetail.cmd.executed', cmd));
        return true;
      } catch (e) {
        error($('instanceDetail.error.cmd'), errText(e));
        return false;
      }
    },
    [serverId, instanceName, success, error],
  );

  /** 域名连通检测（Agent 侧解析 + TCP 探测）；序号防在途请求把已清空/过期的结果写回 */
  const checkSeq = useRef(0);
  const runDomainCheck = useCallback(() => {
    const seq = ++checkSeq.current;
    setDomainCheck({ state: 'checking' });
    api<DomainCheckResult>(
      `/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/domain-check`,
    )
      .then((r) => {
        if (seq === checkSeq.current) setDomainCheck({ state: 'done', result: r });
      })
      .catch((e) => {
        if (seq === checkSeq.current)
          setDomainCheck({ state: 'done', result: { error: errText(e) } as DomainCheckResult });
      });
  }, [serverId, instanceName]);

  // 只有实例运行中才自动检测（未运行时端口必然拒绝，检测只会报错）；
  // 域名改动（编辑后）或由停止转运行时重新检测，停止后清掉旧结果
  useEffect(() => {
    if (instance?.address && running) runDomainCheck();
    else {
      checkSeq.current++;
      setDomainCheck(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.address, running]);

  /** 复制到剪贴板（域名等玩家要用的地址） */
  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) success($('instanceDetail.copied'), text);
    else error($('instanceDetail.copyFailed'), $('instanceDetail.copyFailed.hint'));
  };

  const op = async (action: 'start' | 'stop' | 'restart') => {    setBusy(true);
    try {
      await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/${action}`, {
        method: 'POST',
        body: {},
      });
      success(action === 'start'
        ? $('instanceDetail.op.started')
        : action === 'stop'
          ? $('instanceDetail.op.stopped')
          : $('instanceDetail.op.restarting'));
      setTimeout(() => {
        loadInstance();
        loadPlayers();
      }, 1500);
    } catch (e) {
      error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // 面板代下：服务器侧下载核心反复失败时，由面板下载并经加密通道传过去安装
  const panelInstall = async () => {
    setBusy(true);
    try {
      await api(`/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/panel-install`, {
        method: 'POST',
        body: {},
      });
      success($('instanceDetail.panelInstall.done'), $('instanceDetail.panelInstall.doneDetail'));
      setTimeout(loadInstance, 800);
    } catch (e) {
      error($('instanceDetail.panelInstall.failed'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="mx-auto w-full max-w-5xl px-5 pt-10 text-center">
        <p className="text-sm text-muted-foreground">{$('instanceDetail.notFound')}</p>
        <Button className="mt-4" variant="outline" onClick={onBack}>
          {$('instanceDetail.backToList')}
        </Button>
      </div>
    );
  }

  if (!server || !instance) {
    return <div className="p-10 text-center text-sm text-muted-foreground">{$('common.loading')}</div>;
  }

  // 安装失败：删除时跳过备份（目录里只有半成品，备份无意义且可能卡住）
  const isFailed = instance.status === 'failed';
  // 自动重启是否已启用（按钮上显示小绿点）
  const watchdogOn = !!instance.watchdog?.autoRestart || (instance.watchdog?.schedules ?? []).some((s) => s.enabled);
  // 定时备份是否已启用（同样用小绿点指示）
  const backupOn =
    !!instance.backupSchedule?.enabled && (instance.backupSchedule?.schedules ?? []).some((s) => s.enabled);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 pb-24 pt-7">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" aria-label={$('common.back')} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-xl font-semibold">{instance.name}</h2>
        <InstanceStatusBadge status={instance.status} />
        {active && server.latency != null && <LatencyBadge latency={server.latency} />}
      </div>

      {/* 左：信息 + 控件；中：终端；右：在线玩家（运行时才占位，保证终端不被无谓压缩） */}
      <div
        className={`mt-4 grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)] ${
          running ? 'xl:grid-cols-[270px_minmax(0,1fr)_212px]' : ''
        }`}
      >
        <aside className="grid content-start gap-3 self-start">
          {/* 实例信息：备注/连接地址可点开就地修改（server-icon 在「编辑」里设置） */}
          <div className="grid content-start gap-2 rounded-xl border bg-card p-3.5">
            <InfoRow label={fmtLabel($('instanceDetail.field.note'))} value={instance.note || $('instanceDetail.value.unset')} />
            <InfoRow label={fmtLabel($('instanceDetail.field.version'))} value={instance.version} />
            <InfoRow label={fmtLabel($('instanceDetail.field.memory'))} value={fmtMB(instance.memoryMB)} />
            <InfoRow
              label={fmtLabel($('instanceDetail.field.players'))}
              value={players ? `${players.online ?? '—'}/${players.max}` : `—/${instance.maxPlayers}`}
              tone={players && players.online ? 'good' : undefined}
            />
            <InfoRow label={fmtLabel($('instanceDetail.field.address'))} value={`${server.host}:${instance.port}`} />
            <CopyRow
              label={fmtLabel($('instanceDetail.field.domain'))}
              value={instance.address}
              placeholder={$('instanceDetail.value.unset')}
              onCopy={handleCopy}
            />
            {instance.address ? (
              <div className="flex min-w-0 items-start justify-between gap-2 px-1">
                {!running ? (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {$('instanceDetail.domain.notRunning')}
                  </span>
                ) : domainCheck?.state === 'checking' ? (
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {$('instanceDetail.domain.checking')}
                  </span>
                ) : domainCheck?.result ? (
                  domainCheck.result.error ? (
                    <span className="min-w-0 break-words text-[11px] leading-snug text-destructive" title={domainCheck.result.error}>
                      ✗ {domainCheck.result.error}
                    </span>
                  ) : (
                    <span className="min-w-0 break-words text-[11px] leading-snug text-emerald-600 dark:text-emerald-400" title={`${domainCheck.result.ip}:${domainCheck.result.port}`}>
                      ✓ {domainCheck.result.ip}:{domainCheck.result.port} · TCP {domainCheck.result.latencyMs}ms
                      {domainCheck.result.srv ? ' · SRV' : ''}
                    </span>
                  )
                ) : (
                  <span className="text-[11px] leading-snug text-muted-foreground">{$('instanceDetail.domain.unchecked')}</span>
                )}
                {running && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    disabled={domainCheck?.state === 'checking'}
                    onClick={runDomainCheck}
                    aria-label={$('instanceDetail.domain.recheck')}
                    title={$('instanceDetail.domain.check')}
                  >
                    <Globe className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ) : null}
            <InfoRow label={fmtLabel($('instanceDetail.field.onlineMode'))} value={instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')} />
            {active && (
              <InfoRow
                label={fmtLabel($('instanceDetail.field.uptime'))}
                value={starting ? $('server.detail.starting') : fmtUptime(instance.startedAt)}
              />
            )}
          </div>

          {/* Java 版本选择 + 安装（缺 Java 或版本低于 21 时显示） */}
          {server.online &&
            server.info &&
            (!server.info.java.installed || (server.info.java.major ?? 0) < 21) && (
              <JavaInstallRow serverId={server.id} onDone={loadServer} />
            )}

          {/* 控件（大按钮，间距紧凑；启动中可停止，重启等就绪后再用） */}
          <div className="grid content-start gap-1.5">
            {active ? (
              <>
                <Button
                  size="lg"
                  variant="outline"
                  className="border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busy}
                  onClick={() => op('stop')}
                >
                  <Square className="h-4 w-4" /> {starting ? $('instanceDetail.op.stopStarting') : $('instanceDetail.op.stop')}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  disabled={busy || starting}
                  title={starting ? $('instanceDetail.op.restart.disabled') : undefined}
                  onClick={() => op('restart')}
                >
                  <RotateCw className="h-4 w-4" /> {$('instanceDetail.op.restart')}
                </Button>
              </>
            ) : (
              <Button size="lg" disabled={busy || instance.status !== 'stopped'} onClick={() => op('start')}>
                <Play className="h-4 w-4" /> {$('instanceDetail.op.start')}
              </Button>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="lg" variant="outline" onClick={() => setFilesOpen(true)}>
                <FolderOpen className="h-4 w-4" /> {$('instanceDetail.files')}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setBackupOpen(true)}>
                <Archive className="h-4 w-4" /> {$('instanceDetail.backups')}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setBackupScheduleOpen(true)}>
                <CalendarClock className="h-4 w-4" /> {$('instanceDetail.backupSchedule')}
                {backupOn && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setModsOpen(true)}>
                <Puzzle className="h-4 w-4" /> {$('instanceDetail.mods')}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setPropsOpen(true)}>
                <Settings2 className="h-4 w-4" /> {$('instanceDetail.serverProperties')}
              </Button>
              {hasConfigDirs && (
                <Button size="lg" variant="outline" onClick={() => setPlugCfgOpen(true)}>
                  <SlidersHorizontal className="h-4 w-4" /> {$('instanceDetail.pluginConfig')}
                </Button>
              )}
              <Button size="lg" variant="outline" onClick={() => setWatchdogOpen(true)}>
                <RotateCw className="h-4 w-4" /> {$('instanceDetail.watchdog')}
                {watchdogOn && <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </Button>
              <Button size="lg" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" /> {$('instanceDetail.edit')}
              </Button>
              {instance.status === 'failed' && (
                <>
                  {instance.source !== 'upload' && (
                    <Button
                      size="lg"
                      variant="outline"
                      disabled={busy}
                      title={$('instanceDetail.panelInstall.tooltip')}
                      onClick={panelInstall}
                    >
                      <CloudDownload className="h-4 w-4" /> {$('instanceDetail.panelInstall')}
                    </Button>
                  )}
                  <Button
                    size="lg"
                    variant="outline"
                    className="border-amber-600/60 text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-400"
                    onClick={() => setReinstallOpen(true)}
                  >
                    <RotateCw className="h-4 w-4" /> {$('instanceDetail.reinstall')}
                  </Button>
                </>
              )}
              <Button
                size="lg"
                variant="outline"
                className="col-span-2 border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" /> {$('instanceDetail.delete')}
              </Button>
            </div>
          </div>
        </aside>

        {/* 终端 / AI 日志分析（同一块区域切换，避免页面被拉得过长） */}
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1">
            <Button
              size="sm"
              variant={mainView === 'console' ? 'secondary' : 'ghost'}
              onClick={() => setMainView('console')}
            >
              <Terminal className="h-3.5 w-3.5" /> {$('instanceDetail.tab.console')}
            </Button>
            <Button
              size="sm"
              variant={mainView === 'ai' ? 'secondary' : 'ghost'}
              onClick={() => setMainView('ai')}
            >
              <Sparkles className="h-3.5 w-3.5" /> {$('instanceDetail.tab.ai')}
            </Button>
            {/* 未装 spark 不显示标签（装了之后 Mod 管理变更会刷新实例信息把它带出来） */}
            {instance.sparkInstalled && (
              <Button
                size="sm"
                variant={mainView === 'spark' ? 'secondary' : 'ghost'}
                onClick={() => setMainView('spark')}
              >
                <Activity className="h-3.5 w-3.5" /> Spark
              </Button>
            )}
          </div>
          {/* 两个面板都常驻挂载，只切换可见性：
              条件渲染会在切走时卸载组件，AI 的对话记录与进行中的流会一起丢失，
              终端也会丢掉已拉取的日志与滚动位置。用 hidden 保住两边状态。 */}
          <div className={mainView === 'console' ? '' : 'hidden'}>
            <ConsolePanel
              server={server}
              instance={instance.name}
              instanceStatus={instance.status}
              heightClass="h-[45vh] lg:h-[60vh]"
            />
          </div>
          <div className={mainView === 'ai' ? '' : 'hidden'}>
            <AiLogPanel
              serverId={server.id}
              instanceName={instance.name}
              heightClass="h-[45vh] lg:h-[60vh]"
            />
          </div>
          <div className={mainView === 'spark' ? '' : 'hidden'}>
            <SparkPanel
              serverId={server.id}
              instance={instance.name}
              running={running}
              visible={mainView === 'spark'}
              heightClass="h-[45vh] lg:h-[60vh]"
              onOpenMods={() => setModsOpen(true)}
            />
          </div>
        </div>

        {/* 在线玩家名单（仅运行时显示） */}
        {running && (
          <aside className="rounded-xl border bg-card p-3 lg:col-span-2 xl:col-span-1">
            <div className="flex items-center gap-2">
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <b className="text-sm">{$('instanceDetail.players')}</b>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {players ? `${players.online ?? '—'}/${players.max}` : `—/${instance.maxPlayers}`}
              </span>
            </div>
            <div className="mt-2 max-h-[52vh] overflow-y-auto">
              {players && players.list && players.list.length > 0 ? (
                <ul className="grid gap-1">
                  {players.list.map((name) => (
                    <li
                      key={name}
                      className="group flex min-w-0 items-center gap-1 rounded-md bg-muted/60 py-1 pl-2 pr-1 font-mono text-xs text-foreground"
                      title={name}
                    >
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                            aria-label={$('instanceDetail.player.manageAria', name)}
                            title={$('instanceDetail.player.manage')}
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40 font-sans">
                          <DropdownMenuItem onClick={() => setPlayerAction({ name, kind: 'kick' })}>
                            <LogOut className="h-3.5 w-3.5" /> {$('instanceDetail.player.kick')}
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPlayerAction({ name, kind: 'ban' })}>
                            <Ban className="h-3.5 w-3.5" /> {$('instanceDetail.player.ban')}
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPlayerAction({ name, kind: 'ban-ip' })}>
                            <Ban className="h-3.5 w-3.5" /> {$('instanceDetail.player.banIp')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void sendPlayerCmd(`op ${name}`, $('instanceDetail.player.opDone', name))}>
                            <ShieldCheck className="h-3.5 w-3.5" /> {$('instanceDetail.player.op')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void sendPlayerCmd(`deop ${name}`, $('instanceDetail.player.deopDone', name))}>
                            <ShieldOff className="h-3.5 w-3.5" /> {$('instanceDetail.player.deop')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-1 py-3 text-xs text-muted-foreground">
                  {!players
                    ? $('instanceDetail.players.querying')
                    : players.unreachable
                      ? $('instanceDetail.players.noResponse')
                      : (players.online ?? 0) > 0
                        ? $('instanceDetail.players.noList')
                        : $('instanceDetail.players.none')}
                </p>
              )}
            </div>
            <div className="mt-2 border-t pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => setBansOpen(true)}
              >
                <Ban className="h-3.5 w-3.5" /> {$('instanceDetail.banList')}
              </Button>
            </div>
          </aside>
        )}
      </div>

      <FileManagerDialog
        server={server}
        instance={instance.name}
        open={filesOpen}
        onOpenChange={setFilesOpen}
      />
      <ModManagerDialog
        serverId={server.id}
        instance={instance.name}
        open={modsOpen}
        onOpenChange={setModsOpen}
        onChanged={loadInstance}
      />
      <BackupDialog
        server={server}
        instance={instance.name}
        open={backupOpen}
        onOpenChange={setBackupOpen}
      />
      <PropertiesDialog
        server={server}
        instance={instance}
        open={propsOpen}
        onOpenChange={setPropsOpen}
        onSaved={loadInstance}
        onRestart={() => op('restart')}
      />
      <PluginConfigDialog
        server={server}
        instance={instance}
        open={plugCfgOpen}
        onOpenChange={setPlugCfgOpen}
        onRestart={() => op('restart')}
      />
      <AutoRestartDialog
        server={server}
        instance={instance}
        open={watchdogOpen}
        onOpenChange={setWatchdogOpen}
        onSaved={loadInstance}
      />
      <BackupScheduleDialog
        server={server}
        instance={instance}
        open={backupScheduleOpen}
        onOpenChange={setBackupScheduleOpen}
        onSaved={loadInstance}
      />
      <ReinstallDialog
        server={server}
        instance={instance}
        open={reinstallOpen}
        onOpenChange={setReinstallOpen}
        onStarted={loadInstance}
      />
      <EditInstanceDialog
        server={server}
        instance={instance}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={loadInstance}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={$('instanceDetail.delete.title', instance.name)}
        description={
          <div>
            {$('instanceDetail.delete.desc')}
            {isFailed ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {$('instanceDetail.delete.failedDesc')}
              </p>
            ) : (
              <label className="mt-3 flex items-center gap-2 text-sm font-normal text-foreground">
                <Checkbox
                  checked={backupBeforeDelete}
                  onCheckedChange={(v) => setBackupBeforeDelete(v === true)}
                />
                {$('instanceDetail.delete.backupFirst')}
              </label>
            )}
          </div>
        }
        onConfirm={async () => {
          await api(`/servers/${serverId}/instances/${encodeURIComponent(instance.name)}`, {
            method: 'DELETE',
            body: isFailed
              ? { backupFirst: false, force: true }
              : { backupFirst: backupBeforeDelete },
          });
          success(isFailed
            ? $('instanceDetail.delete.forced')
            : backupBeforeDelete
              ? $('instanceDetail.delete.doneBackup')
              : $('instanceDetail.delete.done'));
          onBack();
        }}
      />
      {playerAction && (
        <PlayerActionDialog
          target={playerAction}
          onClose={() => setPlayerAction(null)}
          onConfirm={sendPlayerCmd}
        />
      )}
      {server && (
        <BanListDialog
          serverId={server.id}
          instance={instance.name}
          open={bansOpen}
          onOpenChange={setBansOpen}
        />
      )}
    </div>
  );
}

/** 信息行骨架：两列 grid（标签列定宽、值列起点统一；列宽由模板决定，值列内的换行不影响对齐） */
function RowShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group grid grid-cols-[5.2em_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** 只读信息行（静态展示） */
function InfoRow({ label, value, tone }: { label: string; value: string; tone?: 'good' }) {
  return (
    <RowShell label={label}>
      <span
        className={`min-w-0 break-words font-mono ${
          tone === 'good' ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-foreground'
        }`}
      >
        {value}
      </span>
    </RowShell>
  );
}

/** 点击复制的信息行（域名等玩家要用的地址）；为空时显示占位提示 */
function CopyRow({
  label,
  value,
  placeholder,
  onCopy,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCopy: (text: string) => void;
}) {
  return (
    <RowShell label={label}>
      {value ? (
        <button
          type="button"
          onClick={() => onCopy(value)}
          title={$('instanceDetail.copied.tooltip')}
          className="min-w-0 rounded break-words px-0.5 text-left font-mono text-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-4 hover:bg-muted hover:decoration-foreground"
        >
          {value}
        </button>
      ) : (
        <span className="min-w-0 break-words px-0.5 font-mono text-muted-foreground/70">{placeholder}</span>
      )}
    </RowShell>
  );
}

/**
 * 标签格式化：加冒号；中文下不足 4 字的标题中间补空格，使各行列对齐。
 * ⚠ 分隔符必须随语言变化：中文用全角「：」，英文用 ":"（否则会渲染成 "Note：" 这种混排）。
 */
function fmtLabel(text: string): string {
  if (getLanguage() === 'en') return text + ':';
  const pad = text.length === 2 ? text[0] + ' ' + text[1] : text;
  return pad + '：';
}



/** 侧栏内：Java 版本选择 + 安装（缺 Java 或版本低于 21 时显示） */
function JavaInstallRow({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const { success, error } = useToastHelpers();
  const [busy, setBusy] = useState(false);
  const [major, setMajor] = useState('21');
  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <Select value={major} onValueChange={setMajor}>
        <SelectTrigger size="sm" className="w-[120px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="21">{$('instanceDetail.java.recommended', 21)}</SelectItem>
          <SelectItem value="17">Java 17</SelectItem>
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="secondary"
        className="ml-auto"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ busy?: boolean }>(`/servers/${serverId}/java-install`, {
              method: 'POST',
              body: { major: Number(major) },
            });
            success(r.busy
              ? $('instanceDetail.java.installing')
              : $('instanceDetail.java.queued', major), $('instanceDetail.java.queuedDetail'));
          } catch (e) {
            error(errText(e));
          } finally {
            setBusy(false);
            setTimeout(onDone, 500);
          }
        }}
      >
        {busy ? $('instanceDetail.java.installing.btn') : $('instanceDetail.java.install')}
      </Button>
    </div>
  );
}

/** 域名连通检测结果（Agent 侧解析 + TCP 探测） */
interface DomainCheckResult {
  domain: string;
  srv: { host: string; port: number } | null;
  host: string;
  ip: string | null;
  port: number | null;
  tcp: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** 玩家操作确认框：踢出 / 封禁 / 封禁 IP 统一走这里，原因可选（随指令下发给服务端） */
function PlayerActionDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: { name: string; kind: 'kick' | 'ban' | 'ban-ip' };
  onClose: () => void;
  /** 返回是否执行成功；成功后自动关闭 */
  onConfirm: (cmd: string, okText: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const meta = {
    kick: {
      title: $('instanceDetail.ban.kickTitle', target.name),
      cmd: `kick ${target.name}`,
      hint: $('instanceDetail.ban.kickHint'),
    },
    ban: {
      title: $('instanceDetail.ban.banTitle', target.name),
      cmd: `ban ${target.name}`,
      hint: $('instanceDetail.ban.banHint'),
    },
    'ban-ip': {
      title: $('instanceDetail.ban.banIpTitle', target.name),
      cmd: `ban-ip ${target.name}`,
      hint: $('instanceDetail.ban.banIpHint'),
    },
  }[target.kind];
  const cmd = reason.trim() ? `${meta.cmd} ${reason.trim()}` : meta.cmd;
  const okText =
    target.kind === 'kick'
      ? $('instanceDetail.ban.kicked', target.name)
      : target.kind === 'ban'
        ? $('instanceDetail.ban.banned', target.name)
        : $('instanceDetail.ban.bannedIp', target.name);

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await onConfirm(cmd, okText);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{meta.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{cmd}</code>
              <span className="mt-1 block">{meta.hint}</span>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={$('instanceDetail.ban.reasonPlaceholder')}
          maxLength={100}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{$('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={async (e) => {
              e.preventDefault();
              await submit();
            }}
          >
            {busy ? $('instanceDetail.busy') : $('confirm.ok')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
