// 实例详情页：指挥条 + 状态总览 + 三栏（实例/工具 | 终端 | 玩家）
// 路由 #/server/<serverId>/instance/<name>
//
// 布局约束（改版时定下的规矩，别随手破坏）：
//   · 整页不滚动：根容器 h-screen + overflow-hidden，指挥条/指标条永远在位；
//     需要滚动的只有终端日志、玩家名单、左栏卡片这类内部区域（各自 overflow-y-auto）。
//   · 高度一律来自这条定死的链（100vh → flex-1 → min-h-0），**不允许**让某一栏的高度
//     反过来由内容决定：之前把中栏做成「内容推高度 + 日志区 flex-1」时，日志高度与栏高
//     互相影响，实测终端高度失控、看起来一直在加载。
//   · 指标卡高度写死 h-[84px]：同样是防跳动；改大小只改 MetricCard/MetricValue/MetricHelper。
//   · 主操作按钮（启动↔停止）位置恒定：宽度也按最长文案取齐，否则右对齐的按钮组会被推走。

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  Ban,
  CalendarClock,
  ChevronRight,
  CloudDownload,
  Copy,
  Eraser,
  FolderOpen,
  Globe,
  Info,
  LogOut,
  Map as MapIcon,
  MessageSquare,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Play,
  Puzzle,
  RadioTower,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { AiLogPanel } from '@/components/ai-log-panel';
import { BackupDialog } from '@/components/backup-dialog';
import { ChatLogPanel } from '@/components/chat-log-panel';
import { ConsolePanel, type ConsolePanelHandle } from '@/components/console-panel';
import { ConfirmDialog, EditInstanceDialog, ReinstallDialog } from '@/components/dialogs';
import { MapPanel } from '@/components/map-panel';
import { MaskedText } from '@/components/masked-text';
import { FileManagerDialog } from '@/components/file-manager';
import { BanListDialog } from '@/components/ban-list-dialog';
import { ModManagerDialog } from '@/components/mod-manager';
import { AutoRestartDialog } from '@/components/auto-restart-dialog';
import { BackupScheduleDialog } from '@/components/backup-schedule-dialog';
import { PlayerStatsDialog } from '@/components/player-stats-dialog';
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
  CORE_LABEL,
  errText,
  fmtMB,
  fmtUptime,
  getInstanceFrp,
  getPlayersStats,
  instanceIconUrl,
  saveInstanceFrp,
  type Instance,
  type InstanceFrpInfo,
  type PlayersSnapshot,
  type PlayersStats,
  type ServerSummary,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { navigate } from '@/lib/router';
import { subscribeServer } from '@/lib/sse';
import { fmtDuration, sessionMs, totalWithSession } from '@/lib/player-stats';
import { copyText } from '@/lib/clipboard';
import { useToastHelpers } from '@/lib/toast';

/** 主区视图：终端 / AI 日志分析 / spark 性能 / 地图 / 聊天记录 */
type MainView = 'console' | 'ai' | 'spark' | 'map' | 'chat';

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
  // 实例详情卡：主机地址 / 正版验证 / 备注 折叠（次要信息不全部平铺）
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 终端日志关键字（页签栏右侧搜索框；只影响显示，不动缓冲区）
  const [logQuery, setLogQuery] = useState('');
  const consoleRef = useRef<ConsolePanelHandle>(null);
  // 玩家快捷管理：待确认的操作（踢出/封禁/封禁 IP 统一走模态框，原因可选）
  const [playerAction, setPlayerAction] = useState<{ name: string; kind: 'kick' | 'ban' | 'ban-ip' } | null>(null);
  // 域名连通检测状态
  const [domainCheck, setDomainCheck] = useState<
    { state: 'checking' | 'done'; result?: DomainCheckResult } | null
  >(null);
  const [bansOpen, setBansOpen] = useState(false);
  // frp 端口映射（仅本机实例；远程实例的 frpc 不在面板这台机器上）
  const [frpOpen, setFrpOpen] = useState(false);
  const [frpInfo, setFrpInfo] = useState<InstanceFrpInfo | null>(null);
  // 玩家统计（在线时长）与聊天记录页签
  const [statsOpen, setStatsOpen] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayersStats | null>(null);
  // 主区视图
  const [mainView, setMainView] = useState<MainView>('console');
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

  // 玩家在线时长统计（Agent 侧累计）：侧栏的「本次在线」与统计对话框共用。
  // 同时记下本地取回时刻：Agent 的 now 是那一刻的快照，界面用「Agent 时间 + 本地已过时间」
  // 推算当前时刻，这样时长会随时间走动，又不受两端时钟差影响。
  const [statsAt, setStatsAt] = useState(0);
  const loadStats = useCallback(() => {
    getPlayersStats(serverId, instanceName)
      .then((r) => {
        setPlayerStats(r);
        setStatsAt(Date.now());
      })
      .catch(() => {}); // 老版本 Agent / 实例不存在时静默降级（页面上仍有名单）
  }, [serverId, instanceName]);

  useEffect(() => {
    loadServer();
    loadInstance();
    loadPlayers();
    loadStats();
  }, [loadServer, loadInstance, loadPlayers, loadStats]);

  // frp 映射状态：只对本机实例查（远程实例由服务器上的 frpc 负责，面板查不到）
  // 依赖 frpOpen：对话框关闭/保存后重新拉一次，左栏状态才能跟上
  useEffect(() => {
    if (!server?.isLocal) {
      setFrpInfo(null);
      return;
    }
    let alive = true;
    getInstanceFrp(serverId, instanceName)
      .then((r) => {
        if (alive) setFrpInfo(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [server?.isLocal, serverId, instanceName, frpOpen]);

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
  // 是否装了 spark（决定 Spark 页签显隐；老版本 Agent 不返回该字段）
  const sparkInstalled = instance?.sparkInstalled;
  // 依赖运行时的页签（AI 分析 / Spark）在停止后消失：正停留在其上时退回终端，
  // spark 被卸载（Mod 管理删除）时同理。
  useEffect(() => {
    if (!sparkInstalled && mainView === 'spark') setMainView('console');
    if (!active && (mainView === 'ai' || mainView === 'spark')) setMainView('console');
  }, [sparkInstalled, active, mainView]);
  useEffect(() => {
    if (!running) return;
    loadPlayers();
    // 玩家统计走 60 秒：它是累计值，不需要跟在线人数一样勤（少一次往返）
    loadStats();
    const t1 = window.setInterval(loadPlayers, 20000);
    const t2 = window.setInterval(() => forceTick((n) => n + 1), 30000);
    const t3 = window.setInterval(loadStats, 60000);
    return () => {
      window.clearInterval(t1);
      window.clearInterval(t2);
      window.clearInterval(t3);
    };
  }, [running, loadPlayers, loadStats]);

  // 实时事件：状态/延迟/资源快照变化
  useEffect(() => {
    return subscribeServer(serverId, (e) => {
      if (e.type === 'latency') {
        setServer((cur) => (cur ? { ...cur, latency: e.latency } : cur));
        return;
      }
      // 主机内存快照（面板后台 30s 拉一次）：指标条的「主机已用」要用它，别让数值停在打开页面那一刻
      if (e.type === 'stats') {
        setServer((cur) => (cur ? { ...cur, stats: e.stats } : cur));
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
        setTimeout(loadStats, 1500);
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
  // 自动重启是否已启用（在「更多管理」里显示小绿点）
  const watchdogOn = !!instance.watchdog?.autoRestart || (instance.watchdog?.schedules ?? []).some((s) => s.enabled);
  // 定时备份是否已启用（同样用小绿点指示）
  const backupOn =
    !!instance.backupSchedule?.enabled && (instance.backupSchedule?.schedules ?? []).some((s) => s.enabled);
  // 「更多管理」里的项数随「插件配置」入口显隐变化
  const moreCount = 3 + (hasConfigDirs ? 1 : 0);

  // ---------- 状态总览条：全部取自既有接口，不编造数值 ----------
  // 在线人数只认运行态：停止后即便列表里还残留着上一次的快照，也不能显示成「在线」
  const playersOnline = active ? (players?.online ?? null) : null;
  const playersMax = players?.max ?? instance.maxPlayers;
  const hostTotalMB = server.stats?.memTotalMB ?? null;
  const hostUsedMB = server.stats?.memUsedMB ?? null;
  // 玩家平均单次在线时长 = 累计时长之和 / 会话次数（Agent 侧累计，含当前会话）
  const nowMs = playerStats ? playerStats.now + (Date.now() - statsAt) : Date.now();
  const statList = playerStats?.players ?? [];
  const sessionCount = statList.reduce((sum, p) => sum + p.sessions, 0);
  const totalMsSum = statList.reduce((sum, p) => sum + totalWithSession(p, nowMs), 0);
  const avgSessionMs = sessionCount > 0 ? totalMsSum / sessionCount : null;
  const uptimeText = running && instance.startedAt ? fmtUptime(instance.startedAt) : null;
  // 连接地址：没配域名就用主机地址，两者都是玩家真能用的地址（不显示空值）
  const connectAddress = instance.address || `${server.host}:${instance.port}`;
  const onlineReason = !active
    ? $('instanceDetail.metric.idle')
    : starting
      ? $('server.detail.starting')
      : !players
        ? $('instanceDetail.players.querying')
        : players.unreachable
          ? $('instanceDetail.players.noResponse')
          : $('instanceDetail.players.noList');
  const playersTone = !active ? 'bg-zinc-400' : players?.unreachable ? 'bg-amber-500' : 'bg-emerald-500';
  // 核心：Paper 1.21.4（构建号/完整版本有就带上）
  const coreText = `${CORE_LABEL[instance.source ?? 'vanilla'] ?? instance.source ?? '—'} ${instance.build || instance.version}`;

  // 依赖运行时的页签在停止时收敛为 终端 / 地图 / 聊天
  const tabs: { key: MainView; icon: LucideIcon; label: string }[] = [
    { key: 'console', icon: Terminal, label: $('instanceDetail.tab.console') },
    ...(active
      ? [{ key: 'ai' as MainView, icon: Sparkles, label: $('instanceDetail.tab.ai') }]
      : []),
    ...(active && sparkInstalled
      ? [{ key: 'spark' as MainView, icon: Activity, label: 'Spark' }]
      : []),
    { key: 'map', icon: MapIcon, label: $('instanceDetail.tab.map') },
    { key: 'chat', icon: MessageSquare, label: $('instanceDetail.tab.chat') },
  ];

  return (
    // 整页不滚动（h-screen + overflow-hidden）：指挥条与指标条永远留在原位，
    // 只有终端日志、玩家名单这类内部区域自己滚。之前是 min-h-screen（文档可滚），
    // 滚轮会把整页内容推上推下。
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ---------- 指挥条：高度与主操作位恒定，不随状态跳动 ---------- */}
      <header className="h-14 shrink-0 border-b bg-card">
        <div className="mx-auto flex h-full w-full max-w-[1600px] items-center gap-3 px-5">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            aria-label={$('common.back')}
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <InstanceIcon serverId={server.id} instance={instance.name} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[19px] font-semibold leading-tight">{instance.name}</h1>
              <InstanceStatusBadge status={instance.status} />
              {active && server.latency != null && <LatencyBadge latency={server.latency} />}
            </div>
            <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] leading-none text-muted-foreground">
              <span className="min-w-0 truncate">{server.name}</span>
              <span className="shrink-0">·</span>
              {/* 与服务器列表/详情页一致：主机地址默认脱敏，点击才显示 */}
              <MaskedText value={server.host} dots={8} className="shrink-0" />
              <span className="shrink-0">·</span>
              <span className="min-w-0 truncate">
                {server.online ? $('instanceDetail.agent.online') : $('server.detail.agentOffline')}
              </span>
            </p>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* 更多：与左栏「更多管理」同一批入口，顺手可及 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-[34px] w-[34px] rounded-lg"
                  aria-label={$('instanceDetail.more')}
                  title={$('instanceDetail.more')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {/* 启用状态的绿点只出现在左栏「更多管理」卡里，这里不再重复 */}
                <DropdownMenuItem onClick={() => setBackupScheduleOpen(true)}>
                  <CalendarClock className="h-3.5 w-3.5" /> {$('instanceDetail.backupSchedule')}
                </DropdownMenuItem>
                {hasConfigDirs && (
                  <DropdownMenuItem onClick={() => setPlugCfgOpen(true)}>
                    <SlidersHorizontal className="h-3.5 w-3.5" /> {$('instanceDetail.pluginConfig')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setWatchdogOpen(true)}>
                  <RotateCw className="h-3.5 w-3.5" /> {$('instanceDetail.watchdog')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setEditOpen(true)}>
                  <Pencil className="h-3.5 w-3.5" /> {$('instanceDetail.edit')}
                </DropdownMenuItem>
                {isFailed && (
                  <>
                    <DropdownMenuSeparator />
                    {instance.source !== 'upload' && (
                      <DropdownMenuItem
                        disabled={busy}
                        title={$('instanceDetail.panelInstall.tooltip')}
                        onClick={panelInstall}
                      >
                        <CloudDownload className="h-3.5 w-3.5" /> {$('instanceDetail.panelInstall')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => setReinstallOpen(true)}>
                      <RotateCw className="h-3.5 w-3.5" /> {$('instanceDetail.reinstall')}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" /> {$('instanceDetail.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 重启：非运行态禁用（无 hover 反馈），位置恒定 */}
            <Button
              variant="outline"
              size="sm"
              className="h-[34px] px-3 text-xs disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={busy || !active}
              title={starting ? $('instanceDetail.op.restart.disabled') : undefined}
              onClick={() => op('restart')}
            >
              <RotateCw className="h-3.5 w-3.5" /> {$('instanceDetail.op.restart')}
            </Button>

            {/* 主操作位：只换内容不换位置（运行中=停止，启动中=停止启动，否则=启动）。
                min-w 按最长文案（en「Stop starting」）取齐：否则按钮宽度随状态变化，
                右对齐的按钮组会把左边的「更多」「重启」一起推走 */}
            {active ? (
              <Button
                size="sm"
                className="h-[34px] min-w-[136px] bg-foreground px-3.5 text-xs text-background hover:bg-foreground/90"
                disabled={busy}
                onClick={() => op('stop')}
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                {starting ? $('instanceDetail.op.stopStarting') : $('instanceDetail.op.stop')}
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-[34px] min-w-[136px] bg-foreground px-3.5 text-xs text-background hover:bg-foreground/90"
                disabled={busy || instance.status !== 'stopped'}
                onClick={() => op('start')}
              >
                <Play className="h-3.5 w-3.5 fill-current" /> {$('instanceDetail.op.start')}
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col px-4 pt-4">
        {/* ---------- 状态总览条：5 张等高指标卡（h-[84px] 写死，改大小只动 MetricCard） ---------- */}
        <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {/* 在线玩家 */}
          <MetricCard label={$('instanceDetail.field.players')}>
            {playersOnline != null ? (
              <>
                <MetricValue value={String(playersOnline)} suffix={`/ ${playersMax}`} />
                <MetricBar ratio={playersMax > 0 ? playersOnline / playersMax : 0} tone={playersTone} />
              </>
            ) : (
              <>
                <MetricValue value="—" />
                {/* 原因文案可能较长（如「服务器尚未响应（启动中？）」），必须能收缩+截断，
                    否则在 sm 双列宽度下会顶破 16px 的辅助行 */}
                <MetricHelper>
                  <span className="min-w-0 truncate">{onlineReason}</span>
                </MetricHelper>
              </>
            )}
          </MetricCard>

          {/* 运行时长（停止时标题改「上次运行」） */}
          <MetricCard label={active ? $('instanceDetail.metric.uptime') : $('instanceDetail.idle.lastRun')}>
            {uptimeText ? (
              <>
                <MetricValue value={uptimeText} />
                <MetricHelper>
                  <Dot />
                  <span className="text-emerald-600 dark:text-emerald-400">{$('console.status.running')}</span>
                </MetricHelper>
              </>
            ) : (
              <>
                <MetricValue value="—" />
                <MetricHelper>
                  {starting ? (
                    <span className="min-w-0 truncate">{$('server.detail.starting')}</span>
                  ) : isFailed && instance.error ? (
                    <span className="min-w-0 truncate text-destructive" title={instance.error}>
                      {instance.error}
                    </span>
                  ) : (
                    <span className="min-w-0 truncate">{$('instanceDetail.idle.normalStop')}</span>
                  )}
                </MetricHelper>
              </>
            )}
          </MetricCard>

          {/* 内存上限（实例级实时占用后端没有数据源，不编造）：
              大号数值 = 本实例上限；条形图与其右侧数值都是**主机内存已用/总量**（两者同源，不再互相打脸） */}
          <MetricCard label={$('instanceDetail.field.memoryLimit')}>
            <MetricValue value={active ? fmtMB(instance.memoryMB) : '—'} />
            {!active ? (
              <MetricHelper>
                <span className="min-w-0 truncate">
                  {$('instanceDetail.memory.limit', fmtMB(instance.memoryMB))} · {$('instanceDetail.idle.released')}
                </span>
              </MetricHelper>
            ) : hostTotalMB ? (
              <MetricBar
                ratio={hostUsedMB != null ? hostUsedMB / hostTotalMB : 0}
                tone="bg-sky-500"
                trailing={hostUsedMB != null ? `${fmtMB(hostUsedMB)} / ${fmtMB(hostTotalMB)}` : undefined}
                title={$(
                  'instanceDetail.memory.host',
                  hostUsedMB != null ? fmtMB(hostUsedMB) : '—',
                  fmtMB(hostTotalMB),
                )}
              />
            ) : (
              <MetricHelper>
                <span className="min-w-0 truncate">{$('instanceDetail.value.nodata')}</span>
              </MetricHelper>
            )}
          </MetricCard>

          {/* 玩家平均在线时长：替换设计稿里的 CPU 卡（实例级 CPU 无数据源，服务器级 stats 也不含 CPU） */}
          <MetricCard label={$('instanceDetail.metric.avgSession')}>
            {avgSessionMs != null ? (
              <>
                <MetricValue value={fmtDuration(avgSessionMs)} />
                <MetricHelper>
                  <span className="min-w-0 truncate">
                    {$('instanceDetail.metric.avgSession.hint', statList.length, sessionCount)}
                  </span>
                </MetricHelper>
              </>
            ) : (
              <>
                <MetricValue value="—" />
                <MetricHelper>
                  <span className="min-w-0 truncate">{$('instanceDetail.value.nodata')}</span>
                </MetricHelper>
              </>
            )}
          </MetricCard>

          {/* 连接地址 */}
          <MetricCard label={$('instanceDetail.field.address')}>
            <div className="flex h-[26px] shrink-0 items-center gap-1.5 overflow-hidden">
              <span className="min-w-0 flex-1 truncate font-mono text-[17px] font-semibold leading-none" title={connectAddress}>
                {connectAddress}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(connectAddress)}
                title={$('instanceDetail.copied.tooltip')}
                aria-label={$('instanceDetail.copied.tooltip')}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <MetricHelper>
              {!instance.address ? (
                <span className="min-w-0 truncate">{$('instanceDetail.domain.none')}</span>
              ) : !active ? (
                <span className="min-w-0 truncate">{$('instanceDetail.domain.notRunning')}</span>
              ) : domainCheck?.state === 'checking' ? (
                <span className="min-w-0 truncate">{$('instanceDetail.domain.checking')}</span>
              ) : domainCheck?.result?.error ? (
                <span className="min-w-0 truncate text-destructive" title={domainCheck.result.error}>
                  {domainCheck.result.error}
                </span>
              ) : domainCheck?.result ? (
                <>
                  <Dot />
                  <span
                    className="min-w-0 truncate font-mono text-emerald-600 dark:text-emerald-400"
                    title={`${domainCheck.result.ip}:${domainCheck.result.port}`}
                  >
                    {domainCheck.result.ip}:{domainCheck.result.port}
                    {domainCheck.result.latencyMs != null ? ` · TCP ${domainCheck.result.latencyMs}ms` : ''}
                    {domainCheck.result.srv ? ' · SRV' : ''}
                  </span>
                  <button
                    type="button"
                    onClick={runDomainCheck}
                    title={$('instanceDetail.domain.check')}
                    aria-label={$('instanceDetail.domain.recheck')}
                    className="ml-auto grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <Globe className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <span className="min-w-0 truncate">{$('instanceDetail.domain.unchecked')}</span>
              )}
            </MetricHelper>
          </MetricCard>
        </div>

        {/* ---------- 三栏：页面本身不滚（见文件头约束），三栏在剩余高度里排布 ----------
            终端页签下三栏都恰好等于这一行的高度，这一行不会出现滚动条；
            只有切到自带固定高度（45/60vh）的 AI/地图/聊天面板、且窗口很矮时，
            这一行才会内部滚一下——否则那些面板的底部会被裁掉、反而够不着。 */}
        <div className="mt-4 flex min-h-0 flex-1 items-stretch gap-4 overflow-y-auto pb-4">
          <aside className="flex w-[264px] shrink-0 flex-col gap-3 overflow-y-auto pr-0.5">
            {/* Java 版本提示（缺 Java 或版本低于 21 时才出现） */}
            {server.online &&
              server.info &&
              (!server.info.java.installed || (server.info.java.major ?? 0) < 21) && (
                <JavaInstallRow serverId={server.id} onDone={loadServer} />
              )}

            {/* ① 实例详情：参数行 → MOTD → 折叠的次要信息（顺序与停止态完全一致） */}
            <section className="rounded-xl border bg-card p-3.5">
              <div className="flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <b className="text-[13px] font-semibold">{$('instanceDetail.info.title')}</b>
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="h-3 w-3" /> {$('instanceDetail.edit')}
                </Button>
              </div>

              <div className="mt-3 flex flex-col gap-2">
                <DetailRow label={$('instanceDetail.field.core')} value={coreText} />
                <DetailRow label={$('instanceDetail.field.memoryLimit')} value={fmtMB(instance.memoryMB)} />
                <DetailRow label={$('instanceDetail.field.port')} value={String(instance.port)} />

                {/* MOTD 放在参数行之后：先配置后描述的阅读顺序 */}
                <div className="rounded-lg bg-muted p-2.5">
                  <p className="text-[10.5px] leading-[15px] text-muted-foreground">
                    {$('instanceDetail.motd.label')}
                  </p>
                  <p className="mt-1 break-words text-xs leading-[17px] text-foreground">
                    {instance.motd || $('instanceDetail.value.unset')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-expanded={detailsOpen}
                  className="flex w-full items-center gap-1 rounded-md py-0.5 text-left text-[11px] leading-4 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform ${detailsOpen ? 'rotate-90' : ''}`}
                  />
                  <span className="truncate">
                    {detailsOpen ? $('instanceDetail.collapse') : $('instanceDetail.expandMore')}
                  </span>
                </button>

                {detailsOpen && (
                  <div className="flex flex-col gap-2 border-t pt-2">
                    <DetailRow
                      label={$('instanceDetail.field.hostAddr')}
                      value={`${server.host}:${instance.port}`}
                    />
                    <DetailRow
                      label={$('instanceDetail.field.onlineMode')}
                      value={instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')}
                    />
                    <DetailRow
                      label={$('instanceDetail.field.note')}
                      value={instance.note || $('instanceDetail.value.unset')}
                    />
                  </div>
                )}
              </div>
            </section>

            {/* frp 穿透：本机实例才有（frpc 跑在面板这台机器上）。
                单独一卡而不是塞进参数行——端口映射是「对外」能力，值得一个显眼入口 */}
            {server.isLocal && (
              <section className="rounded-xl border bg-card p-3.5">
                <div className="flex items-center gap-1.5">
                  <RadioTower className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <b className="text-[13px] font-semibold">{$('instanceDetail.frp.title')}</b>
                  <span
                    className={`ml-auto rounded-full px-2 py-[1px] text-[10.5px] ${
                      frpInfo?.bound
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {frpInfo?.bound ? $('instanceDetail.frp.bound') : $('instanceDetail.frp.unbound')}
                  </span>
                </div>

                {frpInfo?.bound ? (
                  <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[12px]"
                      title={frpInfo.publicAddress}
                    >
                      {frpInfo.publicAddress}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(frpInfo.publicAddress)}
                      title={$('instanceDetail.copied.tooltip')}
                      aria-label={$('instanceDetail.copied.tooltip')}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {frpInfo && !frpInfo.supported
                      ? frpInfo.reason === 'sakura'
                        ? $('instanceDetail.frp.sakura')
                        : $('instanceDetail.frp.notLocal')
                      : $('instanceDetail.frp.unboundHint')}
                  </p>
                )}

                <Button
                  size="sm"
                  variant={frpInfo?.bound ? 'outline' : 'default'}
                  className="mt-2 h-7 w-full text-[11px]"
                  disabled={!!frpInfo && !frpInfo.supported}
                  onClick={() => setFrpOpen(true)}
                >
                  {frpInfo?.bound ? $('instanceDetail.frp.manage') : $('instanceDetail.frp.enable')}
                </Button>
              </section>
            )}

            {/* ② 常用工具：2×2，高度统一（整卡 ~194px → ~156px：格子 h-16→h-12，图标/文字同步收一档；
                卡片内边距保持 p-3.5 与同列的有边框卡一致，否则标题左边线会和上下卡错开 2px） */}
            <section className="rounded-xl border bg-card p-3.5">
              <div className="flex items-center gap-1.5">
                <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <b className="text-[13px] font-semibold">{$('instanceDetail.tools')}</b>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <ToolTile
                  icon={FolderOpen}
                  label={$('instanceDetail.tools.files')}
                  onClick={() => setFilesOpen(true)}
                />
                <ToolTile
                  icon={Settings2}
                  label={$('instanceDetail.serverProperties')}
                  onClick={() => setPropsOpen(true)}
                />
                <ToolTile icon={Archive} label={$('instanceDetail.backups')} onClick={() => setBackupOpen(true)} />
                <ToolTile icon={Puzzle} label={$('instanceDetail.mods')} onClick={() => setModsOpen(true)} />
              </div>
            </section>

            {/* ③ 更多管理：四项收进这里，绿点也只在这里出现 */}
            <section className="rounded-lg bg-muted p-3">
              <div className="flex items-center gap-1.5">
                <MoreHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <b className="text-[13px] font-semibold">{$('instanceDetail.more')}</b>
                <span
                  className="ml-auto rounded-full bg-background px-2 py-[1px] text-[10.5px] text-muted-foreground"
                  title={$('instanceDetail.more.items')}
                >
                  {$('instanceDetail.more.count', moreCount)}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-4">
                <MoreChip
                  label={$('instanceDetail.backupSchedule')}
                  on={backupOn}
                  onClick={() => setBackupScheduleOpen(true)}
                />
                <span className="text-muted-foreground/50">·</span>
                {hasConfigDirs && (
                  <>
                    <MoreChip
                      label={$('instanceDetail.pluginConfig')}
                      onClick={() => setPlugCfgOpen(true)}
                    />
                    <span className="text-muted-foreground/50">·</span>
                  </>
                )}
                <MoreChip
                  label={$('instanceDetail.watchdog')}
                  on={watchdogOn}
                  onClick={() => setWatchdogOpen(true)}
                />
                <span className="text-muted-foreground/50">·</span>
                <MoreChip label={$('instanceDetail.edit')} onClick={() => setEditOpen(true)} />
              </div>
            </section>

            {/* ④ 危险操作：独立红卡，与日常操作物理隔离 */}
            <section className="rounded-xl border border-red-200 bg-red-50 p-3.5 dark:border-red-900 dark:bg-red-950/30">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-700 dark:text-red-400" />
                <b className="text-[13px] font-semibold text-red-700 dark:text-red-400">
                  {$('instanceDetail.delete')}
                </b>
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                {$('instanceDetail.delete.cardDesc')}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2.5 w-full border-red-300 bg-card text-red-600 hover:bg-red-100 hover:text-red-600 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" /> {$('instanceDetail.delete.action')}
              </Button>
            </section>
          </aside>

          {/* ---------- 中区：终端（主角） ---------- */}
          <section
            className={`flex min-w-[380px] flex-1 flex-col overflow-hidden rounded-xl ${
              // 深色只属于终端：AI/地图/聊天面板自带浅色配色，塞进黑底里会变成黑框白卡。
              // 终端页签撑满整行（整行高度由 h-screen 链定死，不是内容推出来的，所以
              // 日志区 flex-1 在这里是安全的）。其余面板自带固定高度，保持内容高即可。
              mainView === 'console' ? 'self-stretch bg-[#0B0B0F]' : 'self-start bg-card'
            }`}
          >
            {/* 页签栏：搜索框与清空只作用于终端。
                导航底色跟着当前页签走——深色是终端专属的，切到 AI/Spark/地图/聊天后
                整条栏必须转浅色，否则白卡顶端会留一条黑带（那一版看起来像没切干净）。 */}
            <div
              className={`flex h-[46px] shrink-0 items-center gap-1 px-2.5 ${
                mainView === 'console' ? 'bg-[#131318]' : 'border-b bg-card'
              }`}
            >
              {tabs.map((t) => (
                <ViewTab
                  key={t.key}
                  icon={t.icon}
                  label={t.label}
                  active={mainView === t.key}
                  dark={mainView === 'console'}
                  onClick={() => setMainView(t.key)}
                />
              ))}
              {mainView === 'console' && (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                    <input
                      value={logQuery}
                      onChange={(e) => setLogQuery(e.target.value)}
                      placeholder={$('console.search')}
                      aria-label={$('console.search')}
                      spellCheck={false}
                      className="h-8 w-[150px] rounded-lg border border-zinc-800 bg-[#1C1C21] pl-7 pr-2 font-mono text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100"
                    title={$('console.clear')}
                    aria-label={$('console.clear')}
                    onClick={() => consoleRef.current?.clear()}
                  >
                    <Eraser className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
            {/* 各面板都常驻挂载，只切换可见性：
                条件渲染会在切走时卸载组件，AI 的对话记录与进行中的流会一起丢失，
                终端也会丢掉已拉取的日志与滚动位置，聊天则要重新拉历史。用 hidden 保住状态。 */}
            <div className={mainView === 'console' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
              <ConsolePanel
                ref={consoleRef}
                server={server}
                instance={instance.name}
                instanceStatus={instance.status}
                embedded
                query={logQuery}
                // 高度由整页 h-screen 链定死，这里只负责填满；min-h 是极矮窗口时的下限
                heightClass="min-h-[200px] flex-1"
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
            {/* 地图用 visible 而非条件渲染：切回来时要重画（隐藏期间画布尺寸为 0） */}
            <div className={mainView === 'map' ? '' : 'hidden'}>
              <MapPanel
                serverId={server.id}
                instance={instance.name}
                visible={mainView === 'map'}
                heightClass="h-[45vh] lg:h-[60vh]"
              />
            </div>
            {/* 聊天记录同样常驻挂载：切回来不必重新拉历史，实时事件也不会漏 */}
            <div className={mainView === 'chat' ? '' : 'hidden'}>
              <ChatLogPanel
                serverId={server.id}
                instance={instance.name}
                visible={mainView === 'chat'}
                running={running}
                trackingEnabled={instance.tracking?.chat !== false}
                players={playerStats?.players}
                heightClass="h-[45vh] lg:h-[60vh]"
              />
            </div>
          </section>

          {/* ---------- 右栏：玩家（self-stretch 让卡片底部与终端对齐） ---------- */}
          <aside className="flex w-[248px] shrink-0 flex-col gap-3 self-stretch">
            <section className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card p-3">
              <div className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <b className="text-[13px] font-semibold">{$('instanceDetail.players')}</b>
                <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-[1px] font-mono text-[11px] text-muted-foreground">
                  {playersOnline != null ? `${playersOnline} / ${playersMax}` : `— / ${instance.maxPlayers}`}
                </span>
              </div>
              <div className="mt-2 shrink-0">
                <MetricBar
                  ratio={playersOnline != null && playersMax > 0 ? playersOnline / playersMax : 0}
                  tone={playersTone}
                />
              </div>

              <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
                {running && players?.list && players.list.length > 0 ? (
                  <ul className="flex flex-col gap-0.5">
                    {players.list.map((name) => {
                      // 该玩家的统计（可能还没有记录：统计从功能启用后开始）
                      const stat = playerStats?.players.find((p) => p.name === name);
                      // Agent 时间 + 本地已过时间 = 当前时刻（免受两端时钟差影响）
                      const sess = stat ? sessionMs(stat, nowMs) : 0;
                      const total = stat ? totalWithSession(stat, nowMs) : 0;
                      return (
                        <li
                          key={name}
                          className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60"
                          title={name}
                        >
                          {/* 头像：玩家名首字母 + 按名字取色（不用 emoji，同一玩家恒定一色） */}
                          <span
                            aria-hidden
                            className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white ${avatarTone(name)}`}
                          >
                            {name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate font-mono text-[12.5px] leading-4">{name}</span>
                            <span className="truncate text-[10.5px] leading-4 text-muted-foreground">
                              {stat
                                ? `${$('instanceDetail.playerStats.session.now', fmtDuration(sess))} · ${$(
                                    'instanceDetail.playerStats.total.now',
                                    fmtDuration(total),
                                  )}`
                                : $('instanceDetail.value.nodata')}
                            </span>
                          </span>
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
                      );
                    })}
                  </ul>
                ) : (
                  // 停止态是「不查询」而不是「没人」：给图示 + 原因，不留白
                  <div className="grid place-items-center px-2 py-6 text-center">
                    <Users className="h-6 w-6 text-muted-foreground/40" />
                    <p className="mt-2 text-xs text-muted-foreground">
                      {!active ? $('instanceDetail.players.none') : onlineReason}
                    </p>
                    {!active && (
                      <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground/80">
                        {$('instanceDetail.players.empty.hint')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-2 flex shrink-0 flex-col gap-1 border-t pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={() => setStatsOpen(true)}
                >
                  <Users className="h-3.5 w-3.5" /> {$('instanceDetail.playerStats')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={() => setBansOpen(true)}
                >
                  <Ban className="h-3.5 w-3.5" /> {$('instanceDetail.banList')}
                </Button>
                <p className="px-1 pt-0.5 text-[10.5px] leading-4 text-muted-foreground/80">
                  {$('instanceDetail.players.hint')}
                </p>
              </div>
            </section>
          </aside>
        </div>
      </div>

      <PlayerStatsDialog
        serverId={serverId}
        instance={instanceName}
        open={statsOpen}
        onOpenChange={setStatsOpen}
      />
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
      {server?.isLocal && (
        <InstanceFrpDialog
          open={frpOpen}
          onOpenChange={setFrpOpen}
          serverId={serverId}
          instanceName={instanceName}
          onSaved={setFrpInfo}
        />
      )}
    </div>
  );
}

/* ---------------- 局部组件（只服务本页，不改动通用组件） ---------------- */

/**
 * 指标卡外壳：高度写死 84px，内部固定三段（标签 16 / 数值 26 / 辅助 14，间距 4、上下内边距 10）。
 * 高度写死是为了运行态/停止态切换时卡片不跳动；84 是视觉上收紧过的一档
 * （最初按设计稿做的 104px 实测太占地方，终端被压得不够高）。
 */
function MetricCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-[84px] flex-col gap-1 rounded-xl border bg-card px-3.5 py-2.5">
      <p className="h-4 shrink-0 truncate text-[11.5px] leading-4 text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** 数值行：22px mono + 小字号后缀 */
function MetricValue({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <div className="flex h-[26px] shrink-0 items-center gap-1 overflow-hidden">
      <span className="truncate font-mono text-[22px] font-semibold leading-none tabular-nums">{value}</span>
      {suffix && <span className="shrink-0 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** 辅助行：文字/绿点/进度条都装在 h-3.5 里，保证文字型与条型辅助行等高 */
function MetricHelper({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div
      className="flex h-3.5 shrink-0 items-center gap-1.5 text-[10.5px] leading-[14px] text-muted-foreground"
      title={title}
    >
      {children}
    </div>
  );
}

/** 进度条型辅助行（ratio 0~1；trailing 是右侧的小号数值说明） */
function MetricBar({
  ratio,
  tone,
  trailing,
  title,
}: {
  ratio: number;
  tone: string;
  trailing?: string;
  title?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100);
  return (
    <MetricHelper title={title}>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {trailing && <span className="shrink-0 font-mono text-[10px] leading-[14px]">{trailing}</span>}
    </MetricHelper>
  );
}

function Dot({ tone = 'bg-emerald-500' }: { tone?: string }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
}

/** 实例详情卡的一行：标签在左、等宽值在右 */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

/** 常用工具格子：文字容器必须 w-full text-center，否则字数不同的标签会视觉偏移。
 *  h-12 = 48px（触控目标下限），再矮就不好点了——要压整卡高度请先动间距而不是这里。 */
function ToolTile({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-12 flex-col items-center justify-center gap-1 rounded-lg border bg-card px-1 transition-colors hover:bg-muted"
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="w-full truncate text-center text-[11px] leading-none">{label}</span>
    </button>
  );
}

/** 更多管理里的一项（可点开对应对话框；启用中的功能带绿点） */
function MoreChip({ label, on, onClick }: { label: string; on?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground"
    >
      {label}
      {on && <Dot />}
    </button>
  );
}

/** 主区页签（终端卡内深色 / 其余卡片浅色，两套配色由 dark 决定） */
function ViewTab({
  icon: Icon,
  label,
  active,
  dark,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  /** 所在页签栏是不是深色（= 当前在终端页签）：文字/悬停色必须跟着栏底走 */
  dark: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors ${
        dark
          ? active
            ? 'bg-zinc-800 text-white'
            : 'text-zinc-400 hover:bg-zinc-800/50'
          : active
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:bg-muted/60'
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}

/**
 * 实例图标：优先用游戏内的 server-icon（编辑里上传的 64×64 PNG），
 * 没有则回退到等距立方体方块（38×38 圆角）。
 */
function InstanceIcon({ serverId, instance }: { serverId: string; instance: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div className="grid h-[38px] w-[38px] shrink-0 place-items-center overflow-hidden rounded-[10px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
      {missing ? (
        <CubeGlyph className="h-5 w-5" />
      ) : (
        <img
          src={instanceIconUrl(serverId, instance)}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setMissing(true)}
        />
      )}
    </div>
  );
}

/** 等距立方体（服务器图标占位/回退图形） */
function CubeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M12 2.4 21 7.2v9.6L12 21.6 3 16.8V7.2z" fill="currentColor" opacity="0.16" />
      <path d="M12 2.4 21 7.2 12 12 3 7.2z" fill="currentColor" opacity="0.9" />
      <path d="M12 12v9.6L3 16.8V7.2z" fill="currentColor" opacity="0.5" />
      <path d="M21 7.2v9.6L12 21.6V12z" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

/** 玩家名 → 头像底色（同名恒定；用 Tailwind 调色板类，不引入新 token） */
const AVATAR_TONES = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-indigo-500',
];

function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100003;
  return AVATAR_TONES[h % AVATAR_TONES.length];
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

/**
 * 单实例 frp 端口映射对话框。
 *
 * 为什么要做成实例级：面板设置里的「代理列表」要求手填 `名称,本地端口,远程端口`，
 * 本地端口写错/远程端口撞车都只能等 frpc 启动失败才发现。这里本地端口直接取实例端口，
 * 远程端口在保存前做冲突检查，保存后自动重启 frpc 应用。
 */
function InstanceFrpDialog({
  open,
  onOpenChange,
  serverId,
  instanceName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  serverId: string;
  instanceName: string;
  onSaved: (info: InstanceFrpInfo) => void;
}) {
  const { success, error } = useToastHelpers();
  const [info, setInfo] = useState<InstanceFrpInfo | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInfo(null);
    getInstanceFrp(serverId, instanceName)
      .then((r) => {
        setInfo(r);
        setPort(String(r.remotePort || r.localPort || ''));
      })
      .catch((e) => error($('instanceDetail.frp.title'), errText(e)));
  }, [open, serverId, instanceName]);

  const save = async (enabled: boolean) => {
    if (!info) return;
    setBusy(true);
    try {
      const r = await saveInstanceFrp(serverId, instanceName, {
        enabled,
        remotePort: Number(port) || 0,
      });
      if (r.error) {
        error($('instanceDetail.frp.title'), r.error);
      } else {
        success(enabled ? $('instanceDetail.frp.saved') : $('instanceDetail.frp.unboundToast'));
      }
      setInfo(r);
      onSaved(r);
      if (enabled) onOpenChange(false);
    } catch (e) {
      error($('instanceDetail.frp.title'), errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{$('instanceDetail.frp.title')}</AlertDialogTitle>
          <AlertDialogDescription>{$('instanceDetail.frp.desc')}</AlertDialogDescription>
        </AlertDialogHeader>

        {!info ? (
          <p className="text-xs text-muted-foreground">{$('common.loading')}</p>
        ) : !info.supported ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {info.reason === 'sakura' ? $('instanceDetail.frp.sakura') : $('instanceDetail.frp.notLocal')}
          </p>
        ) : !info.frpEnabled ? (
          <div className="grid gap-2">
            <p className="text-xs leading-relaxed text-muted-foreground">{$('instanceDetail.frp.notEnabled')}</p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => {
                onOpenChange(false);
                navigate('/settings');
              }}
            >
              {$('instanceDetail.frp.goSettings')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">{$('instanceDetail.frp.localPort')}</span>
              <Input value={String(info.localPort)} disabled readOnly className="font-mono" />
            </label>
            <label className="grid gap-1 text-xs">
              <span className="text-muted-foreground">{$('instanceDetail.frp.remotePort')}</span>
              <Input
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={String(info.localPort)}
                disabled={busy}
                className="font-mono"
              />
              <span className="text-[11px] text-muted-foreground">{$('instanceDetail.frp.remotePortHint')}</span>
            </label>
            <div className="rounded-md bg-muted px-3 py-2 text-xs">
              <span className="text-muted-foreground">{$('instanceDetail.frp.publicAddress')}：</span>
              <span className="font-mono">
                {info.serverAddr ? `${info.serverAddr}:${port || info.localPort}` : '—'}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {info.frpcRunning ? $('instanceDetail.frp.frpcRunning') : $('instanceDetail.frp.frpcStopped')}
            </p>
          </div>
        )}

        <AlertDialogFooter>
          {info?.supported && info.frpEnabled && info.bound && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => save(false)}>
              {$('instanceDetail.frp.unbind')}
            </Button>
          )}
          <AlertDialogCancel disabled={busy}>{$('common.cancel')}</AlertDialogCancel>
          {info?.supported && info.frpEnabled && (
            <AlertDialogAction
              disabled={busy || !port}
              onClick={(e) => {
                e.preventDefault();
                void save(true);
              }}
            >
              {$('common.save')}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
