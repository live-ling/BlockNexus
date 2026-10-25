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
  AlertCircle,
  Archive,
  ArrowLeft,
  Ban,
  Check,
  ChevronRight,
  Copy,
  ChevronDown,
  Eraser,
  FolderOpen,
  Globe,
  HardDrive,
  LogOut,
  Map as MapIcon,
  MoreVertical,
  Pencil,
  Play,
  Puzzle,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import { AiLogPanel } from '@/components/ai-log-panel';
import { BackupDialog, BackupPanel } from '@/components/backup-dialog';
import { ChatLogPanel } from '@/components/chat-log-panel';
import { ConsolePanel, type ConsolePanelHandle } from '@/components/console-panel';
import { ConfirmDialog, EditInstanceDialog, ReinstallDialog } from '@/components/dialogs';
import { MapPanel } from '@/components/map-panel';
import { MaskedText } from '@/components/masked-text';
import { FileManagerView } from '@/components/file-manager';
import { BanListDialog } from '@/components/ban-list-dialog';
import { ModManagerDialog } from '@/components/mod-manager';
import { AutoRestartDialog, scheduleLabel } from '@/components/auto-restart-dialog';
import { BackupScheduleDialog } from '@/components/backup-schedule-dialog';
import { PlayerStatsDialog } from '@/components/player-stats-dialog';
import { PropertiesDialog } from '@/components/properties-dialog';
import { PluginConfigDialog } from '@/components/plugin-config-dialog';
import { SparkPanel } from '@/components/spark-panel';
import { InstanceControlPanel } from '@/components/instance-control-panel';
import { SectionHeading, Surface } from '@/components/layout/primitives';
import { LatencyBadge } from '@/components/status-badge';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  api,
  consoleLines,
  CORE_LABEL,
  errText,
  fmtMB,
  fmtUptime,
  getInstanceFrp,
  getPlayersStats,
  instanceIconUrl,
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

/** 主区页签（/proto 的 5 Tab）：AI 分析、Spark、地图、聊天按下述归属收进对应页签 */
type Tab = 'overview' | 'players' | 'files' | 'config' | 'maintenance';

/** 状态 → 呼吸灯色（头部与「切换实例」下拉共用；颜色只在这里定义） */
function statusDotClass(status: string): string {
  if (status === 'running') return 'bg-emerald-500';
  if (status === 'starting') return 'bg-amber-400';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-muted-foreground/40';
}

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
  // 同服务器的实例清单（头部「切换实例」下拉；与当前实例同一份响应，不额外请求）
  const [siblings, setSiblings] = useState<Instance[]>([]);
  const [players, setPlayers] = useState<PlayersSnapshot[string] | null>(null);
  const [notFound, setNotFound] = useState(false);
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
  // 入口只在控制面板「网络」组 —— 页面里不再有第二个 frp 对话框（旧的 InstanceFrpDialog 已删）
  const [frpInfo, setFrpInfo] = useState<InstanceFrpInfo | null>(null);
  // 概览终端与「最近事件」共用：控制台尾部（错误计数、事件筛选）
  const [tailLines, setTailLines] = useState<string[]>([]);
  // 实例控制面板：设置/自动化/备份/危险操作的唯一入口
  const [panelOpen, setPanelOpen] = useState(false);
  // 玩家统计（在线时长）与聊天记录页签
  const [statsOpen, setStatsOpen] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayersStats | null>(null);
  // 主区页签（/proto 的 5 Tab）：默认「概览」
  const [tab, setTab] = useState<Tab>('overview');
  // 概览里的世界地图：默认收起，点「地图」就地展开
  const [mapOpen, setMapOpen] = useState(false);
  // 维护页的诊断面板：AI 日志分析 / Spark 性能
  const [diag, setDiag] = useState<'none' | 'ai' | 'spark'>('none');
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
        // 同服务器的其它实例：头部「切换实例」下拉用（不额外发请求，列表本来就在手）
        setSiblings(list);
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
  }, [server?.isLocal, serverId, instanceName]);

  // 控制台尾部：每 5 秒拉一次（概览的「最近事件」与终端头部的 ERROR 计数共用）
  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ lines?: unknown }>(
        `/servers/${serverId}/instances/${encodeURIComponent(instanceName)}/console?tail=200`,
      )
        .then((r) => {
          // 必须归一化：Agent 回的是 { ts, text }[]，直接渲染对象会整页白屏（React #31）
          if (alive) setTailLines(consoleLines(r));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [serverId, instanceName]);

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
  // 是否装了 spark（决定维护页的「性能」诊断入口；老版本 Agent 不返回该字段）
  const sparkInstalled = instance?.sparkInstalled;
  // AI / Spark 的诊断面板：同一时间只展开一个；离开运行态或 Spark 被卸载时收起
  useEffect(() => {
    if (!sparkInstalled && diag === 'spark') setDiag('none');
    if (!active && diag !== 'none') setDiag('none');
  }, [sparkInstalled, active, diag]);
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

  /** 控制面板里点具体项：先关面板，再打开原来的对话框（避免两个 Dialog 抢焦点） */
  const openFromPanel = useCallback((fn: () => void) => {
    setPanelOpen(false);
    // 留出对话框关闭动画/焦点归还的时间，避免两个 Dialog 抢焦点
    window.setTimeout(fn, 160);
  }, []);

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
  // 控制面板里的「已启用」指示
  const watchdogOn = !!instance.watchdog?.autoRestart || (instance.watchdog?.schedules ?? []).some((s) => s.enabled);
  const backupOn =
    !!instance.backupSchedule?.enabled && (instance.backupSchedule?.schedules ?? []).some((s) => s.enabled);

  // ---------- 状态总览条：全部取自既有接口，不编造数值 ----------
  // 在线人数只认运行态：停止后即便列表里还残留着上一次的快照，也不能显示成「在线」
  const playersOnline = active ? (players?.online ?? null) : null;
  const playersMax = players?.max ?? instance.maxPlayers;
  const hostTotalMB = server.stats?.memTotalMB ?? null;
  const hostUsedMB = server.stats?.memUsedMB ?? null;
  // 玩家会话时刻：Agent 时间 + 本地已过时间（免受两端时钟差影响）
  const nowMs = playerStats ? playerStats.now + (Date.now() - statsAt) : Date.now();
  const uptimeText = running && instance.startedAt ? fmtUptime(instance.startedAt) : null;
  // 连接地址：没配域名就用主机地址，两者都是玩家真能用的地址（不显示空值）
  const connectAddress = instance.address || `${server.host}:${instance.port}`;

  // 概览的「最近事件」：从控制台尾部挑出值得看的行（错误、上下线、备份、启动完成）
  const overviewEvents = tailLines
    .filter((l) => /ERROR|Exception|Caused by|joined the game|left the game|Done \(|备份|Backup/i.test(l))
    .slice(-8)
    .reverse();
  // 终端头部的 ERROR 计数（概览终端卡片 + 事件卡底部共用）
  const dockErrCount = tailLines.filter((l) => /ERROR|Exception|Caused by/.test(l)).length;

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
  // 核心：Paper 1.21.4（构建号/完整版本有就带上）。
  // 版本串常常自带核心名（"Fabric-1.21.1"），别再拼一次，否则显示成「Fabric Fabric-1.21.1」。
  const coreLabel = CORE_LABEL[instance.source ?? 'vanilla'] ?? instance.source ?? '—';
  const coreVersion = instance.build || instance.version;
  const coreText = coreVersion.toLowerCase().startsWith(coreLabel.toLowerCase())
    ? coreVersion
    : `${coreLabel} ${coreVersion}`;

  // 头部呼吸灯 / 状态文案：颜色只在这一处按状态取（其余地方一律中性色）
  const statusDotTone = running
    ? 'bg-emerald-500'
    : starting
      ? 'bg-amber-400'
      : isFailed
        ? 'bg-red-500'
        : 'bg-muted-foreground/40';
  const instanceStatusText = isFailed
    ? $('console.status.failed')
    : running
      ? $('console.status.running')
      : starting
        ? $('console.status.starting')
        : instance.status === 'downloading'
          ? $('console.status.downloading')
          : instance.status === 'incomplete'
            ? $('console.status.incomplete')
            : $('console.status.stopped');

  // 5 个页签固定存在（不随运行态增删，避免停止时布局跳动）
  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: $('instanceDetail.tab.overview') },
    { key: 'players', label: $('instanceDetail.tab.players') },
    { key: 'files', label: $('instanceDetail.tab.files') },
    { key: 'config', label: $('instanceDetail.tab.config') },
    { key: 'maintenance', label: $('instanceDetail.tab.maintenance') },
  ];

  // 维护页的两行摘要：没有计划时退回「崩溃后自动拉起 / 未启用」
  const wd = instance.watchdog;
  const wdSchedules = (wd?.schedules ?? []).filter((s) => s.enabled);
  const watchdogText = wdSchedules.length
    ? wdSchedules.map((s) => scheduleLabel(s)).join(' · ')
    : wd?.autoRestart
      ? $('autoRestart.autoRestart.label')
      : $('instanceDetail.maintenance.off');
  const bs = instance.backupSchedule;
  const bsSchedules = (bs?.schedules ?? []).filter((s) => s.enabled);
  const backupScheduleText =
    bs?.enabled && bsSchedules.length
      ? bsSchedules.map((s) => scheduleLabel(s)).join(' · ')
      : $('instanceDetail.maintenance.off');

  return (
    // 整页不滚动（h-screen + overflow-hidden）：指挥条与指标条永远留在原位，
    // 只有终端日志、玩家名单这类内部区域自己滚。之前是 min-h-screen（文档可滚），
    // 滚轮会把整页内容推上推下。
    <div className="flex h-screen flex-col overflow-hidden bg-muted/30">
      {/* ---------- 头部：状态呼吸灯 + 名称 + 详情｜单一主操作 + 更多（/proto 第六版） ---------- */}
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/70 bg-background px-4">
        <button
          type="button"
          onClick={onBack}
          title={$('common.back')}
          aria-label={$('common.back')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <InstanceIcon serverId={server.id} instance={instance.name} />

        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              {(running || starting) && (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none ${statusDotTone}`}
                />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${statusDotTone}`} />
            </span>
            <h1 className="truncate text-[13px] font-medium tracking-tight">{instance.name}</h1>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
              {instanceStatusText}
            </span>
            {active && server.latency != null && <LatencyBadge latency={server.latency} />}

            {/* 切换实例：同一服务器的其它实例直接跳转（列表来自 loadInstance 的同一份响应） */}
            {siblings.length > 1 && (
              <>
                <span className="shrink-0 text-muted-foreground/40">/</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {$('instanceDetail.switch')}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                      {server.name}
                    </DropdownMenuLabel>
                    {siblings.map((s) => (
                      <DropdownMenuItem
                        key={s.name}
                        className="gap-2 text-[13px]"
                        onSelect={() => navigate(`/server/${server.id}/instance/${encodeURIComponent(s.name)}`)}
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass(s.status)}`} />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        {s.name === instance.name && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
          <p className="flex min-w-0 items-center gap-1 text-[10.5px] leading-4 text-muted-foreground">
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

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* 主操作位：只换内容不换位置（运行中=停止，启动中=停止启动，否则=启动）。
              min-w 按最长文案（en「Stop starting」）取齐：否则按钮宽度随状态变化，
              右对齐的按钮组会把左边的「更多」一起推走 */}
          {active ? (
            <Button
              size="sm"
              className="h-7 min-w-[124px] bg-foreground px-3 text-[13px] font-normal text-background hover:bg-foreground/85"
              disabled={busy}
              onClick={() => op('stop')}
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              {starting ? $('instanceDetail.op.stopStarting') : $('instanceDetail.op.stop')}
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 min-w-[124px] bg-foreground px-3 text-[13px] font-normal text-background hover:bg-foreground/85"
              disabled={busy || instance.status !== 'stopped'}
              onClick={() => op('start')}
            >
              <Play className="h-3.5 w-3.5 fill-current" /> {$('instanceDetail.op.start')}
            </Button>
          )}

          {/* 重启 / 控制面板 / 备份收进「更多」：头部只留一个主操作 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={$('ui.action.more')}
                title={$('ui.action.more')}
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="gap-2 text-[13px]"
                disabled={busy || !active}
                onSelect={() => op('restart')}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {$('instanceDetail.op.restart')}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setPanelOpen(true)}>
                <Settings2 className="h-3.5 w-3.5" />
                {$('instanceDetail.panel.open')}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setBackupOpen(true)}>
                <Archive className="h-3.5 w-3.5" />
                {$('instanceDetail.backups')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* ---------- 页签：概览 / 玩家 / 文件 / 配置 / 维护（/proto 的 5 Tab） ---------- */}
        <div className="flex h-10 shrink-0 items-stretch gap-0.5 border-b border-border/60 px-4">
          {tabs.map((t) => (
            <ViewTab key={t.key} label={t.label} active={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {/* ============ 概览 ============ */}
          <div className={tab === 'overview' ? 'h-full min-h-0 p-4' : 'hidden'}>
            {/*
              整页固定高（不滚）：终端日志区 flex-1 需要一条**定值**高度链才能被约束住。
              之前这里是 overflow-y-auto + min-h-full，日志内容把 flex-1 撑成内容高（7500px+），
              看起来就是「终端无限加载」。滚动交给终端/事件自己的内部滚动区。
            */}
            <div className="flex h-full min-h-0 flex-col gap-3.5">
              {/*
                指标条：只属于概览（玩家/时长/内存是「这个实例现在怎么样」的答案，
                切到文件/配置页签时没有理由继续占一整条）。72px 分段 strip，
                高度写死防跳动；不再常驻页签上方，其它页签的内容区整体多出 96px。
              */}
              <MetricStrip>
                <MetricCell icon={<Users />} label={$('instanceDetail.field.players')}>
                  {playersOnline != null ? (
                    <>
                      <MetricValue value={String(playersOnline)} suffix={`/ ${playersMax}`} />
                      <MetricBar ratio={playersMax > 0 ? playersOnline / playersMax : 0} tone={playersTone} />
                    </>
                  ) : (
                    <>
                      <MetricValue value="—" />
                      <MetricHelper>
                        <span className="min-w-0 truncate">{onlineReason}</span>
                      </MetricHelper>
                    </>
                  )}
                </MetricCell>

                <MetricCell
                  icon={<Activity />}
                  label={active ? $('instanceDetail.metric.uptime') : $('instanceDetail.idle.lastRun')}
                >
                  {uptimeText ? (
                    <>
                      <MetricValue value={uptimeText} />
                      <MetricHelper>
                        <MetricTrend>{$('console.status.running')}</MetricTrend>
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
                </MetricCell>

                <MetricCell icon={<HardDrive />} label={$('instanceDetail.field.memoryLimit')}>
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
                      tone="bg-muted-foreground/40"
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
                </MetricCell>
              </MetricStrip>

              {/* 条件条：失败 / Java 缺失才出现，正常时零高度（不再和地址抢同一张卡） */}
              {isFailed && instance.error && (
                <div className="flex shrink-0 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[12px]">
                  <AlertCircle className="size-3.5 shrink-0 text-destructive" />
                  <span className="shrink-0 font-medium text-destructive">{$('console.status.failed')}</span>
                  <span className="min-w-0 truncate text-muted-foreground" title={instance.error}>
                    {instance.error}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTab('overview')}
                    className="ml-auto shrink-0 text-[12px] font-medium text-destructive hover:underline"
                  >
                    {$('console.title')}
                  </button>
                </div>
              )}
              {server.online &&
                server.info &&
                (!server.info.java.installed || (server.info.java.major ?? 0) < 21) && (
                  <JavaInstallRow serverId={server.id} onDone={loadServer} />
                )}

              {/* 连接地址：概览第一高频信息，独占一行；核心/时长/Java/端口降为下方 caption */}
              <Surface className="flex shrink-0 flex-col gap-1 px-3.5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-[12.5px] font-medium" title={connectAddress}>
                    {connectAddress}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopy(connectAddress)}
                    title={$('instanceDetail.copied.tooltip')}
                    aria-label={$('instanceDetail.copied.tooltip')}
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Copy className="size-3.5" />
                  </button>
                  {frpInfo?.bound && (
                    <span
                      className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-[1px] text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                      title={frpInfo.publicAddress}
                    >
                      frp
                    </span>
                  )}
                  <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    {!instance.address ? (
                      <span className="truncate">{$('instanceDetail.domain.none')}</span>
                    ) : !active ? (
                      <span className="truncate">{$('instanceDetail.domain.notRunning')}</span>
                    ) : domainCheck?.state === 'checking' ? (
                      <span className="truncate">{$('instanceDetail.domain.checking')}</span>
                    ) : domainCheck?.result?.error ? (
                      <span className="max-w-[180px] truncate text-destructive" title={domainCheck.result.error}>
                        {domainCheck.result.error}
                      </span>
                    ) : domainCheck?.result ? (
                      <>
                        <Dot />
                        <span
                          className="max-w-[180px] truncate font-mono text-emerald-600 dark:text-emerald-400"
                          title={`${domainCheck.result.ip}:${domainCheck.result.port}`}
                        >
                          {domainCheck.result.ip}:{domainCheck.result.port}
                          {domainCheck.result.latencyMs != null ? ` · TCP ${domainCheck.result.latencyMs}ms` : ''}
                          {domainCheck.result.srv ? ' · SRV' : ''}
                        </span>
                      </>
                    ) : (
                      <span className="truncate">{$('instanceDetail.domain.unchecked')}</span>
                    )}
                    {instance.address && active && (
                      <button
                        type="button"
                        onClick={runDomainCheck}
                        title={$('instanceDetail.domain.check')}
                        aria-label={$('instanceDetail.domain.recheck')}
                        className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
                      >
                        <Globe className="size-3" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted-foreground">
                  <span className="truncate">{coreText}</span>
                  <span aria-hidden>·</span>
                  <span className="truncate">
                    {$('instanceDetail.metric.uptime')} {uptimeText ?? '—'}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="truncate">
                    Java{' '}
                    {server.info?.java.installed
                      ? String(server.info.java.major ?? '—')
                      : $('servers.java.notInstalled')}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="truncate">
                    {$('instanceDetail.field.port')} {instance.port}
                  </span>
                  {instance.note && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="min-w-0 truncate" title={instance.note}>
                        {instance.note}
                      </span>
                    </>
                  )}
                </div>
              </Surface>

              <div className="grid min-h-0 flex-1 gap-3.5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="flex min-h-0 min-w-0 flex-col gap-3.5">
                  {/* 快捷操作：只留 4 个高频动作（备份/终端/文件/重启），低频的进 ⋮ */}
                  <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                    <span className="mr-1.5 px-1 text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase">
                      {$('instanceDetail.overview.actions')}
                    </span>
                    {[
                      {
                        icon: Archive,
                        label: $('instanceDetail.overview.backupNow'),
                        onClick: () => setBackupOpen(true),
                      },
                      {
                        icon: FolderOpen,
                        label: $('instanceDetail.tools.files'),
                        onClick: () => setTab('files'),
                      },
                      {
                        icon: RotateCw,
                        label: $('instanceDetail.op.restart'),
                        onClick: () => void op('restart'),
                      },
                    ].map((q) => (
                      <button
                        key={q.label}
                        type="button"
                        onClick={q.onClick}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <q.icon className="size-3.5 text-muted-foreground/70" />
                        {q.label}
                      </button>
                    ))}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={$('ui.action.more')}
                          title={$('ui.action.more')}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setMapOpen(true)}>
                          <MapIcon className="size-3.5" />
                          {$('instanceDetail.tab.map')}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setPropsOpen(true)}>
                          <Settings2 className="size-3.5" />
                          {$('instanceDetail.serverProperties')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                {/* 终端：概览的主内容面（原 MOTD 预览块 + 底部 Dock 合并于此）。
                    深色卡片自带轻头部（状态 + ERROR + 清空 + 搜索），日志区 flex-1 填满。 */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#0B0B0F] shadow-xs">
                  <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 px-3 text-[11px] text-zinc-400">
                    <Terminal className="size-3.5 shrink-0" />
                    <span className="shrink-0">{$('instanceDetail.dock.title')}</span>
                    <span className="shrink-0 text-zinc-500">{instanceStatusText}</span>
                    {dockErrCount > 0 && (
                      <span className="shrink-0 rounded bg-red-500/15 px-1.5 py-[1px] text-[10px] font-medium text-red-400">
                        {dockErrCount} ERROR
                      </span>
                    )}
                    <div className="relative ml-auto hidden shrink-0 sm:block">
                      <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-zinc-500" />
                      <input
                        value={logQuery}
                        onChange={(e) => setLogQuery(e.target.value)}
                        placeholder={$('console.search')}
                        aria-label={$('console.search')}
                        spellCheck={false}
                        className="h-6 w-[130px] rounded border border-zinc-800 bg-[#1C1C21] pr-2 pl-6 font-mono text-[10.5px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-700"
                      />
                    </div>
                    <button
                      type="button"
                      title={$('console.clear')}
                      aria-label={$('console.clear')}
                      onClick={() => consoleRef.current?.clear()}
                      className="grid size-6 shrink-0 place-items-center rounded text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
                    >
                      <Eraser className="size-3" />
                    </button>
                  </div>
                  <ConsolePanel
                    ref={consoleRef}
                    server={server}
                    instance={instance.name}
                    instanceStatus={instance.status}
                    embedded
                    query={logQuery}
                    heightClass="flex-1"
                  />
                </div>
              </div>

              {/* 最近事件：极简时间轴，不放边框表格 */}
              <Surface className="flex min-h-[220px] flex-col p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-semibold tracking-tight">{$('instanceDetail.overview.events')}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{$('instanceDetail.overview.eventsHint')}</p>
                  </div>
                  <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-muted/60 px-2 text-[11px] text-muted-foreground">
                    <span className={`size-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
                    {instanceStatusText}
                  </span>
                </div>

                <div className="mt-2.5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {overviewEvents.length ? (
                    overviewEvents.map((line, i) => (
                      <div key={i} className="flex items-start gap-2 text-[12px] leading-snug">
                        <span
                          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                            /ERROR|Exception|Caused by/.test(line) ? 'bg-destructive' : 'bg-muted-foreground/40'
                          }`}
                        />
                        <p
                          className={`min-w-0 break-words ${
                            /ERROR|Exception|Caused by/.test(line)
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                          }`}
                          title={line}
                        >
                          {line}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-[11.5px] text-muted-foreground">{$('instanceDetail.overview.noEvents')}</p>
                  )}
                </div>

                <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                  <span className="text-[11px] text-muted-foreground">
                    {dockErrCount > 0 ? `${dockErrCount} ERROR` : '—'}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                    {$('instanceDetail.dock.title')}
                    <ChevronRight className="size-3" />
                  </span>
                </div>
              </Surface>
              </div>
            </div>
          </div>

          {/* ============ 玩家 ============ */}
          <div className={tab === 'players' ? 'flex h-full min-h-0 gap-3.5 p-4' : 'hidden'}>
            <Surface className="flex min-h-0 w-[320px] shrink-0 flex-col p-4">
              <div className="flex items-center gap-2">
                <Users className="size-4 shrink-0 text-muted-foreground" />
                <h3 className="text-[13px] font-semibold">{$('instanceDetail.players')}</h3>
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
                      const stat = playerStats?.players.find((p) => p.name === name);
                      const sess = stat ? sessionMs(stat, nowMs) : 0;
                      const total = stat ? totalWithSession(stat, nowMs) : 0;
                      return (
                        <li
                          key={name}
                          className="group flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60"
                          title={name}
                        >
                          <span
                            aria-hidden
                            className={`grid size-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold text-white ${avatarTone(name)}`}
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
                                className="size-6 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus:opacity-100"
                                aria-label={$('instanceDetail.player.manageAria', name)}
                                title={$('instanceDetail.player.manage')}
                              >
                                <MoreVertical className="size-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40 font-sans">
                              <DropdownMenuItem onClick={() => setPlayerAction({ name, kind: 'kick' })}>
                                <LogOut className="size-3.5" /> {$('instanceDetail.player.kick')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setPlayerAction({ name, kind: 'ban' })}
                              >
                                <Ban className="size-3.5" /> {$('instanceDetail.player.ban')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setPlayerAction({ name, kind: 'ban-ip' })}
                              >
                                <Ban className="size-3.5" /> {$('instanceDetail.player.banIp')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => void sendPlayerCmd(`op ${name}`, $('instanceDetail.player.opDone', name))}
                              >
                                <ShieldCheck className="size-3.5" /> {$('instanceDetail.player.op')}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  void sendPlayerCmd(`deop ${name}`, $('instanceDetail.player.deopDone', name))
                                }
                              >
                                <ShieldOff className="size-3.5" /> {$('instanceDetail.player.deop')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="grid place-items-center px-2 py-6 text-center">
                    <Users className="size-6 text-muted-foreground/40" />
                    <p className="mt-2 text-[12px] text-muted-foreground">
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

              <div className="mt-2 flex shrink-0 flex-col gap-1 border-t border-border/60 pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={() => setStatsOpen(true)}
                >
                  <Users className="size-3.5" /> {$('instanceDetail.playerStats')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-foreground"
                  onClick={() => setBansOpen(true)}
                >
                  <Ban className="size-3.5" /> {$('instanceDetail.banList')}
                </Button>
              </div>
            </Surface>

            <div className="min-h-0 min-w-0 flex-1">
              <ChatLogPanel
                serverId={server.id}
                instance={instance.name}
                visible={tab === 'players'}
                running={running}
                trackingEnabled={instance.tracking?.chat !== false}
                players={playerStats?.players}
                heightClass="h-full"
              />
            </div>
          </div>

          {/* ============ 文件 ============ */}
          <div className={tab === 'files' ? 'flex h-full min-h-0 flex-col p-4' : 'hidden'}>
            <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border/70 bg-card p-3 shadow-xs">
              <FileManagerView server={server} instance={instance.name} active={tab === 'files'} />
            </div>
          </div>

          {/* ============ 配置 ============ */}
          <div className={tab === 'config' ? 'h-full overflow-y-auto p-4' : 'hidden'}>
            {/* 行式列表：每行一个入口，比 2×2 卡片网格省一半高度，加条目也不挤 */}
            <Surface flush className="max-w-[820px] divide-y divide-border/60">
              <ConfigRow
                icon={Settings2}
                title={$('instanceDetail.serverProperties')}
                hint={$('instanceDetail.config.propsDesc')}
                value={`${instance.port} · ${instance.maxPlayers} · ${
                  instance.onlineMode ? $('instanceDetail.value.on') : $('instanceDetail.value.off')
                }`}
                action={$('instanceDetail.config.open')}
                onOpen={() => setPropsOpen(true)}
              />
              <ConfigRow
                icon={Puzzle}
                title={$('instanceDetail.pluginConfig')}
                hint={hasConfigDirs ? $('instanceDetail.config.pluginsHint') : $('instanceDetail.config.noPlugins')}
                action={$('instanceDetail.config.open')}
                disabled={!hasConfigDirs}
                onOpen={() => setPlugCfgOpen(true)}
              />
              <ConfigRow
                icon={Puzzle}
                title={$('instanceDetail.mods')}
                hint={`${$('instanceDetail.config.modsHint')}${
                  sparkInstalled ? ` · Spark ${$('instanceDetail.value.installed')}` : ''
                }`}
                action={$('instanceDetail.config.open')}
                onOpen={() => setModsOpen(true)}
              />
              <ConfigRow
                icon={Pencil}
                title={$('instanceDetail.edit')}
                hint={$('instanceDetail.config.instanceDesc')}
                value={`${coreText} · ${fmtMB(instance.memoryMB)}`}
                action={$('instanceDetail.edit')}
                onOpen={() => setEditOpen(true)}
              />
            </Surface>
          </div>

          {/* ============ 维护 ============ */}
          <div className={tab === 'maintenance' ? 'h-full overflow-y-auto p-4' : 'hidden'}>
            <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Surface className="flex flex-col gap-3 p-3.5">
                <SectionHeading
                  title={$('instanceDetail.panel.tab.automation')}
                  hint={$('instanceDetail.panel.watchdog.desc')}
                />
                <div className="divide-y divide-border/60">
                  <div className="flex items-center gap-3 py-2.5">
                    <RotateCw className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{$('instanceDetail.watchdog')}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{watchdogText}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[12.5px]"
                      onClick={() => setWatchdogOpen(true)}
                    >
                      {$('instanceDetail.edit')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-3 py-2.5">
                    <Archive className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium">{$('instanceDetail.backupSchedule')}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{backupScheduleText}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-[12.5px]"
                      onClick={() => setBackupScheduleOpen(true)}
                    >
                      {$('instanceDetail.edit')}
                    </Button>
                  </div>
                </div>
              </Surface>

              <Surface className="flex min-h-[280px] flex-col gap-3 p-3.5">
                <SectionHeading
                  title={$('instanceDetail.backups')}
                  hint={$('instanceDetail.maintenance.backupHint')}
                />
                <BackupPanel server={server} instance={instance.name} active={tab === 'maintenance'} />
              </Surface>

              {/* 诊断：只是两个入口，结果在全屏浮层里看（46vh 就地展开会把备份列表挤没） */}
              <Surface className="flex flex-col gap-2 p-3.5 xl:col-span-2">
                <SectionHeading
                  title={$('instanceDetail.maintenance.diagnostics')}
                  hint={$('instanceDetail.maintenance.diagnosticsHint')}
                />
                <div className="divide-y divide-border/60">
                  <DiagRow
                    icon={Sparkles}
                    title={$('instanceDetail.tab.ai')}
                    desc={$('instanceDetail.maintenance.diagnosticsReady')}
                    disabled={!active}
                    onOpen={() => setDiag('ai')}
                  />
                  {sparkInstalled && (
                    <DiagRow
                      icon={Activity}
                      title="Spark"
                      desc={$('instanceDetail.maintenance.diagnosticsReady')}
                      disabled={!active}
                      onOpen={() => setDiag('spark')}
                    />
                  )}
                </div>
              </Surface>
            </div>
          </div>
        </div>

        {/* 全屏浮层：地图 / 诊断结果这类重内容，盖住页面专注看，Esc 关闭（不挤压当前页签） */}
        <FullScreenOverlay open={mapOpen} title={$('instanceDetail.tab.map')} onClose={() => setMapOpen(false)}>
          <MapPanel serverId={server.id} instance={instance.name} visible={mapOpen} heightClass="h-full" />
        </FullScreenOverlay>
        <FullScreenOverlay open={diag === 'ai'} title={$('instanceDetail.tab.ai')} onClose={() => setDiag('none')}>
          <AiLogPanel serverId={server.id} instanceName={instance.name} heightClass="h-full" />
        </FullScreenOverlay>
        <FullScreenOverlay open={diag === 'spark'} title="Spark" onClose={() => setDiag('none')}>
          <SparkPanel
            serverId={server.id}
            instance={instance.name}
            running={running}
            visible={diag === 'spark'}
            heightClass="h-full"
            onOpenMods={() => setModsOpen(true)}
          />
        </FullScreenOverlay>

      </div>

      <InstanceControlPanel
        open={panelOpen}
        onOpenChange={setPanelOpen}
        server={server}
        instance={instance}
        active={active}
        busy={busy}
        frpInfo={frpInfo}
        watchdogOn={watchdogOn}
        backupOn={backupOn}
        onCopy={handleCopy}
        onWatchdog={() => openFromPanel(() => setWatchdogOpen(true))}
        onBackupSchedule={() => openFromPanel(() => setBackupScheduleOpen(true))}
        onReinstall={() => openFromPanel(() => setReinstallOpen(true))}
        onPanelInstall={() => openFromPanel(() => void panelInstall())}
        onDelete={() => openFromPanel(() => setDeleteOpen(true))}
        onSaved={loadInstance}
        onFrpChanged={setFrpInfo}
      />
      <PlayerStatsDialog
        serverId={serverId}
        instance={instanceName}
        open={statsOpen}
        onOpenChange={setStatsOpen}
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

/* ---------------- 局部组件（只服务本页，不改动通用组件） ---------------- */

/**
 * 指标条：一条 72px 的分段 strip，取代三张各自带卡壳的 104px 卡——
 * 省掉卡与卡之间的间距/圆角空耗，把 36px 竖向空间还给内容区。
 * 高度写死仍然是为了防跳动；分段之间用 1px 发丝线，不用分割卡片。
 */
function MetricStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0 px-4 pt-3 pb-3">
      <div className="grid h-[72px] grid-cols-3 overflow-hidden rounded-lg border border-border/70 bg-card shadow-xs sm:divide-x sm:divide-border/60">
        {children}
      </div>
    </div>
  );
}

/** 指标条的一格：10.5px 大写标签 + 20px 大数字 + 辅助行 */
function MetricCell({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1.5 px-3.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate text-[10.5px] font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
        {icon && <span className="ml-auto shrink-0 text-muted-foreground/60 [&_svg]:size-3">{icon}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

/** 数值行：20px mono + 小字号后缀（strip 里没有卡壳撑场，字号略收一档） */
function MetricValue({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <div className="flex h-5 shrink-0 items-baseline gap-1 overflow-hidden">
      <span className="truncate text-[20px] leading-none font-semibold tracking-tight tabular-nums">{value}</span>
      {suffix && <span className="shrink-0 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** 辅助行：文字/进度条都装在 h-4 里，保证文字型与条型辅助行等高 */
function MetricHelper({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="flex h-4 shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" title={title}>
      {children}
    </div>
  );
}

/** 趋势/状态胶囊（中性灰，不用状态色——颜色留给头部呼吸灯） */
function MetricTrend({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
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

/** 配置页的一行入口：icon + 标题 + 说明 + 当前值摘要 + 打开按钮 */
function ConfigRow({
  icon: Icon,
  title,
  hint,
  value,
  action,
  disabled,
  onOpen,
}: {
  icon: typeof Settings2;
  title: string;
  hint: string;
  value?: string;
  action: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
      {value && (
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:block">{value}</span>
      )}
      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={disabled} onClick={onOpen}>
        {action}
      </Button>
    </div>
  );
}

/** 维护页诊断的一行入口 */
function DiagRow({
  icon: Icon,
  title,
  desc,
  disabled,
  onOpen,
}: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{desc}</p>
      </div>
      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={disabled} onClick={onOpen}>
        {$('instanceDetail.config.open')}
      </Button>
    </div>
  );
}

/**
 * 全屏浮层：地图 / AI 分析 / Spark 这类重内容的家。
 * 为什么是全屏而不是 46vh 就地展开：就地展开会把当前页签挤成残废；
 * 为什么不是抽屉：这些内容本身就占满一屏（地图/长文结果），抽屉反而窄。
 * Esc / 右上角关闭；fixed 定位不受页面 overflow-hidden 影响。
 */
function FullScreenOverlay({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <h2 className="truncate text-[13px] font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          title={$('common.close')}
          aria-label={$('common.close')}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </div>
  );
}

/** 主区页签：下划线式（与 /proto 一致），不用灰底药丸，避免和驾驶舱抢层级 */
function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative -mb-px flex h-10 shrink-0 items-center border-b-2 px-3 text-[13px] transition-colors ${
        active
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
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
