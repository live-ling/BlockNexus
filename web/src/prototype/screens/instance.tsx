// 原型屏 3：实例工作台（2026-10-21 第六版 · 亮色极简控制台）。
//
// 这一版按「方案二：Sleek Minimalist Console」重做视觉，功能与 P0/P1 保持一致：
//   ① 表面分层：亮灰底座（slate-50/70）+ 纯白卡片 + 极细边框，不再全屏铺 1px 边框；
//   ② 字号阶梯：11（元数据/大写标签）、13（正文）、15（模块标题）、24（驾驶舱大数字）；
//   ③ Hero 驾驶舱：顶部固定 4 项大数字（TPS / 内存 / CPU / 玩家），每项配一枚微趋势胶囊；
//   ④ 头部解耦：只保留当前状态的一个主操作，重启/强制停止/控制台/控制面板/删除收进「更多」；
//   ⑤ 色彩克制：主操作统一中性深色；状态色只保留在顶部呼吸灯，
//      红/黄只用于真实错误与警告，趋势/Live/在线标记一律中性灰。
//
// 五个 Tab、底部终端 Dock、控制面板都保留；概览改为
// 「状态与环境 + MOTD | 最近事件」两栏，快捷操作收进状态卡底部，不再单独占一块同权卡片。

import { useState, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  FileCog,
  FileText,
  FolderTree,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RotateCw,
  Search,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Terminal,
  Timer,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { cn } from 'cn';
import { $, getLanguage } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  MOCK_BACKUPS,
  MOCK_EVENTS,
  MOCK_INSTANCES,
  MOCK_LOG,
  MOCK_PLAYERS,
  MOCK_SERVERS,
  type ProtoInstance,
  type ProtoStatus,
} from '../mock';
import { ProtoScreenSelect, type ProtoScreen } from '../shell';

type Tab = 'overview' | 'players' | 'files' | 'config' | 'maintenance';
type CpNav = 'basic' | 'network' | 'players' | 'automation' | 'backups';
type IconType = typeof Archive;

/** 状态 → 呼吸灯 / 文案。颜色只在这一处集中定义。 */
const STATUS: Record<
  ProtoStatus,
  {
    key: 'proto.status.running' | 'proto.status.stopped' | 'proto.status.starting' | 'proto.status.failed';
    dot: string;
    ping: boolean;
  }
> = {
  running: {
    key: 'proto.status.running',
    dot: 'bg-emerald-500',
    ping: true,
  },
  stopped: {
    key: 'proto.status.stopped',
    dot: 'bg-slate-300 dark:bg-slate-600',
    ping: false,
  },
  starting: {
    key: 'proto.status.starting',
    dot: 'bg-amber-400',
    ping: true,
  },
  failed: {
    key: 'proto.status.failed',
    dot: 'bg-red-500',
    ping: false,
  },
};

// 亮色控制台的表面/文字常量：集中一处，避免每张卡片重复十几条 class。
const CARD = 'rounded-xl border border-slate-200/60 bg-white shadow-xs dark:border-slate-800/80 dark:bg-slate-900';
const HAIRLINE = 'border-slate-100 dark:border-slate-800';
const LABEL = 'text-[11px] font-medium tracking-wider text-slate-400 uppercase dark:text-slate-500';
const MUTED = 'text-slate-400 dark:text-slate-500';
const BODY_MUTED = 'text-slate-500 dark:text-slate-400';
const TITLE = 'text-[15px] font-semibold tracking-tight text-slate-900 dark:text-slate-100';
const STRONG = 'text-slate-900 dark:text-slate-100';
const INPUT =
  'h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-slate-400 disabled:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-slate-500';
const BTN_PRIMARY =
  'h-7 bg-slate-900 px-3 text-[13px] font-normal text-white shadow-xs hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200';

const DEFAULT_INSTANCE = MOCK_INSTANCES[0];

export function InstanceScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [instName, setInstName] = useState(DEFAULT_INSTANCE.name);
  const [statusByName, setStatusByName] = useState<Record<string, ProtoStatus>>({});
  const [tab, setTab] = useState<Tab>('overview');
  const [dockOpen, setDockOpen] = useState(false);
  const [cpOpen, setCpOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const inst = MOCK_INSTANCES.find((i) => i.name === instName && i.serverId === DEFAULT_INSTANCE.serverId) ?? DEFAULT_INSTANCE;
  const server = MOCK_SERVERS.find((s) => s.id === inst.serverId);
  const siblings = MOCK_INSTANCES.filter((i) => i.serverId === inst.serverId);
  const status = statusByName[inst.name] ?? inst.status;
  const meta = STATUS[status];
  const running = status === 'running';
  const starting = status === 'starting';
  const failed = status === 'failed';

  /** 只覆盖当前实例的状态，切换实例时各自保留 */
  const setStatus = (next: ProtoStatus) => {
    setStatusByName((prev) => ({ ...prev, [inst.name]: next }));
  };

  const start = () => {
    setStatus('starting');
    window.setTimeout(() => {
      setStatusByName((prev) => ({ ...prev, [inst.name]: 'running' }));
    }, 900);
  };

  const stop = () => setStatus('stopped');

  const restart = () => {
    setStatus('starting');
    window.setTimeout(() => {
      setStatusByName((prev) => ({ ...prev, [inst.name]: 'running' }));
    }, 1100);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: $('proto.tab.overview') },
    { id: 'players', label: $('proto.tab.players') },
    { id: 'files', label: $('proto.tab.files') },
    { id: 'config', label: $('proto.tab.config') },
    { id: 'maintenance', label: $('proto.tab.maintenance') },
  ];

  const memPct = Math.round((inst.memoryMB / Math.max(1, inst.memoryMaxMB)) * 100);
  const memoryGB = (inst.memoryMB / 1024).toFixed(1);
  const memoryMaxGB = (inst.memoryMaxMB / 1024).toFixed(1);
  const players = running ? (inst.players ?? 0) : 0;
  const tpsValue = running ? '20.0' : starting ? '—' : '0.0';
  const cpuValue = running ? '12.4%' : starting ? '8.2%' : '0.0%';
  const tpsSub = running
    ? $('proto.metric.tpsStable')
    : starting
      ? $('proto.status.starting')
      : $('proto.metric.tpsStopped');

  return (
    <>
      {/* ── 头部：状态呼吸灯 + 名称 + 实例切换｜单一主操作 + 更多 ── */}
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-slate-200/70 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => onScreen('instances')}
            title={$('proto.action.back')}
            aria-label={$('proto.action.back')}
            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="flex min-w-0 items-center gap-2">
            <span className="relative flex h-2 w-2 shrink-0">
              {meta.ping && (
                <span
                  className={cn(
                    'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none',
                    meta.dot,
                  )}
                />
              )}
              <span className={cn('relative inline-flex h-2 w-2 rounded-full', meta.dot)} />
            </span>
            <span className={cn('truncate text-[13px] font-medium tracking-tight', STRONG)}>{inst.name}</span>
            <span className={cn('hidden text-[11px] sm:inline', MUTED)}>{$(meta.key)}</span>
          </div>

          <span className="hidden text-slate-300 sm:inline dark:text-slate-600">/</span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex shrink-0 items-center gap-1 text-[13px] transition-colors',
                  BODY_MUTED,
                  'hover:text-slate-900 dark:hover:text-slate-100',
                )}
              >
                <span>{$('proto.instance.switch')}</span>
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-[11px] font-normal text-slate-400">
                {server?.name ?? '—'}
              </DropdownMenuLabel>
              {siblings.map((s) => {
                const sMeta = STATUS[statusByName[s.name] ?? s.status];
                return (
                  <DropdownMenuItem key={s.name} className="gap-2 text-[13px]" onSelect={() => setInstName(s.name)}>
                    <span className={cn('size-1.5 shrink-0 rounded-full', sMeta.dot)} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.name === inst.name && <Check className="h-3.5 w-3.5 text-slate-400" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {running ? (
            <Button size="sm" onClick={stop} className={BTN_PRIMARY}>
              <Square className="h-3.5 w-3.5 fill-current" />
              {$('proto.action.stopService')}
            </Button>
          ) : starting ? (
            <Button
              size="sm"
              disabled
              className="h-7 bg-slate-100 px-3 text-[13px] font-normal text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {$('proto.status.starting')}
            </Button>
          ) : failed ? (
            <Button size="sm" onClick={() => setDockOpen(true)} className={BTN_PRIMARY}>
              <Terminal className="h-3.5 w-3.5" />
              {$('proto.action.viewLog')}
            </Button>
          ) : (
            <Button size="sm" onClick={start} className={BTN_PRIMARY}>
              <Play className="h-3.5 w-3.5 fill-current" />
              {$('proto.action.startService')}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={$('proto.action.more')}
                className="h-7 w-7 text-slate-400 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem className="gap-2 text-[13px]" onSelect={restart}>
                <RotateCw className="h-3.5 w-3.5" />
                {$('proto.action.restart')}
              </DropdownMenuItem>
              {failed && (
                <DropdownMenuItem className="gap-2 text-[13px]" onSelect={start}>
                  <Play className="h-3.5 w-3.5" />
                  {$('proto.action.retryStart')}
                </DropdownMenuItem>
              )}
              {(running || starting) && (
                <DropdownMenuItem className="gap-2 text-[13px]" onSelect={stop}>
                  <Square className="h-3.5 w-3.5" />
                  {$('proto.action.forceStop')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setDockOpen(true)}>
                <Terminal className="h-3.5 w-3.5" />
                {$('proto.action.console')}
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2 text-[13px]" onSelect={() => setCpOpen(true)}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {$('proto.action.controlPanel')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="gap-2 text-[13px]"
                onSelect={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {$('proto.cp.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="mx-0.5 hidden h-4 w-px bg-slate-200 md:block dark:bg-slate-700" />
          <div className="hidden md:flex">
            <ProtoScreenSelect screen="instance" onScreen={onScreen} />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col bg-slate-50/70 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        {/* ── Hero 驾驶舱：四项大数字固定在最上方 ── */}
        <div className="grid shrink-0 grid-cols-2 gap-3 px-4 pt-4 pb-3 md:grid-cols-4">
          <MetricCard
            icon={<Activity className="h-4 w-4" />}
            label={$('proto.metric.tps')}
            value={tpsValue}
            sub={tpsSub}
            trend={running ? $('proto.metric.stable') : '—'}
          />
          <MetricCard
            icon={<HardDrive className="h-4 w-4" />}
            label={$('proto.metric.memory')}
            value={`${memoryGB} GB`}
            sub={$('proto.metric.memAllocated', memoryMaxGB)}
            trend={`${memPct}%`}
          />
          <MetricCard
            icon={<Cpu className="h-4 w-4" />}
            label={$('proto.metric.cpu')}
            value={cpuValue}
            sub={$('proto.metric.cpuAllocated', 4)}
            trend={running ? '-2.1%' : '—'}
          />
          <MetricCard
            icon={<Users className="h-4 w-4" />}
            label={$('proto.metric.players')}
            value={`${players} / ${inst.maxPlayers}`}
            sub={$('proto.metric.peak', 32)}
            trend={running ? $('proto.metric.today', 3) : '—'}
          />
        </div>

        {/* ── Tab：下划线式，不用灰底药丸，避免和驾驶舱抢层级 ── */}
        <div className="flex h-10 shrink-0 items-stretch gap-0.5 border-b border-slate-200/60 px-4 dark:border-slate-800">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'relative -mb-px border-b-2 px-3 text-[13px] transition-colors',
                tab === t.id
                  ? 'border-slate-900 font-medium text-slate-900 dark:border-slate-100 dark:text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={cn('min-h-0 flex-1', tab === 'files' ? 'overflow-hidden p-4' : 'overflow-y-auto p-4')}>
          {tab === 'overview' && (
            <OverviewTab
              inst={inst}
              status={status}
              onOpenLog={() => setDockOpen(true)}
              onTab={setTab}
              onRestart={restart}
            />
          )}
          {tab === 'players' && <PlayersTab inst={inst} status={status} />}
          {tab === 'files' && <FilesTab />}
          {tab === 'config' && <ConfigTab />}
          {tab === 'maintenance' && <MaintenanceTab />}
        </div>

        <TerminalDock open={dockOpen} onToggle={() => setDockOpen((v) => !v)} />
      </div>

      <ControlPanel
        open={cpOpen}
        onOpenChange={setCpOpen}
        inst={inst}
        serverName={server?.name ?? '—'}
        onDeleteRequest={() => {
          setCpOpen(false);
          setDeleteOpen(true);
        }}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(420px,92vw)] max-w-none gap-0 rounded-xl border border-slate-200/60 bg-white p-0 shadow-xl sm:max-w-none dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="flex items-start gap-3 p-5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400">
              <AlertCircle className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className={cn('text-[15px] font-semibold', STRONG)}>{$('proto.cp.delete')}</DialogTitle>
              <DialogDescription className={cn('mt-1 text-[13px] leading-relaxed', BODY_MUTED)}>
                {inst.name} · {$('proto.cp.dangerHint')}
              </DialogDescription>
            </div>
          </div>
          <div className={cn('flex justify-end gap-2 border-t px-5 py-3', HAIRLINE)}>
            <DialogClose asChild>
              <Button variant="outline" size="sm" className="h-7 text-[13px]">
                {$('proto.cp.cancel')}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-[13px]"
              onClick={() => setDeleteOpen(false)}
            >
              {$('proto.cp.delete')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 驾驶舱指标卡：24px 大数字 + 11px 元数据 + 微趋势胶囊 */
function MetricCard({
  icon,
  label,
  value,
  sub,
  trend,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  trend?: string;
}) {
  return (
    <div className={cn('flex flex-col justify-between p-4', CARD)}>
      <div className="flex items-start justify-between gap-2">
        <span className={LABEL}>{label}</span>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400 ring-1 ring-slate-200/60 dark:bg-slate-800/60 dark:text-slate-400 dark:ring-slate-700/60">
          {icon}
        </span>
      </div>
      <div className="mt-3">
        <div className={cn('text-[24px] leading-none font-semibold tracking-tight tabular-nums', STRONG)}>{value}</div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className={cn('truncate text-[11px]', MUTED)}>{sub}</span>
          {trend && (
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-slate-100 px-2 text-[11px] font-medium text-slate-500 tabular-nums dark:bg-slate-800 dark:text-slate-400">
              {trend}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 概览：左侧「状态与环境 + MOTD」，右侧「最近事件」时间轴 */
function OverviewTab({
  inst,
  status,
  onOpenLog,
  onTab,
  onRestart,
}: {
  inst: ProtoInstance;
  status: ProtoStatus;
  onOpenLog: () => void;
  onTab: (t: Tab) => void;
  onRestart: () => void;
}) {
  const meta = STATUS[status];
  const running = status === 'running';
  const starting = status === 'starting';
  const failed = status === 'failed';
  const players = running ? (inst.players ?? 0) : 0;
  const errorCount = 3;
  const uptime = running ? (inst.uptime ?? $('proto.instance.justStarted')) : starting ? $('proto.status.starting') : '—';

  const quick: { icon: IconType; label: string; onClick?: () => void }[] = [
    { icon: Archive, label: $('proto.quick.backup') },
    { icon: Timer, label: $('proto.quick.tasks'), onClick: () => onTab('maintenance') },
    { icon: Terminal, label: $('proto.quick.terminal'), onClick: onOpenLog },
    { icon: FolderTree, label: $('proto.quick.files'), onClick: () => onTab('files') },
    { icon: FileCog, label: $('proto.quick.config'), onClick: () => onTab('config') },
    { icon: RotateCw, label: $('proto.quick.restart'), onClick: onRestart },
  ];

  const summary = failed
    ? ''
    : [$(meta.key), $('proto.instance.players', players, inst.maxPlayers), running ? null : (inst.note ?? null)]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid min-h-0 flex-1 gap-3.5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3.5">
        {/* 状态与环境：只用中性表面层级，状态色收进顶部呼吸灯 */}
        <div className={cn('relative overflow-hidden p-4', CARD)}>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-slate-400/5 to-transparent dark:from-slate-500/5" />
          <div className="absolute inset-y-0 left-0 w-1 bg-slate-200 dark:bg-slate-700" />

          <div className="relative">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Server className="h-4 w-4 shrink-0 text-slate-400" />
                <h3 className={TITLE}>{$('proto.instance.envTitle')}</h3>
              </div>
              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-slate-200/70 bg-slate-50 px-2 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {inst.core} {inst.version}
              </span>
            </div>

            {failed ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-red-200/70 bg-red-50/70 px-3 py-2 text-[13px] dark:border-red-500/20 dark:bg-red-500/10">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                <span className="font-medium text-red-700 dark:text-red-300">{$('proto.instance.failedTitle')}</span>
                <span className="text-red-600/80 dark:text-red-300/80">{$('proto.instance.failedReason')}</span>
                <button
                  type="button"
                  onClick={onOpenLog}
                  className="ml-auto text-[13px] font-medium text-red-700 transition-colors hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                >
                  {$('proto.action.viewLog')}
                </button>
              </div>
            ) : (
              <p className={cn('mt-2 text-[13px] leading-relaxed text-pretty', BODY_MUTED)}>{summary}</p>
            )}

            <div className={cn('mt-4 grid grid-cols-3 gap-4 border-t pt-3', HAIRLINE)}>
              <Meta label={$('proto.metric.uptime')} value={uptime} />
              <Meta label={$('proto.instance.javaVersion')} value="OpenJDK 17.0.9" />
              <Meta label={$('proto.instance.worldSize')} value="1.42 GB" />
            </div>

            <div className={cn('mt-3 flex flex-wrap items-center gap-x-0.5 gap-y-1 border-t pt-2', HAIRLINE)}>
              <span className={cn('mr-1.5 px-1', LABEL)}>{$('proto.instance.quick')}</span>
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={q.onClick}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
                    'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
                  )}
                >
                  <q.icon className="h-3.5 w-3.5 text-slate-400" />
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* MOTD：整页唯一一块深色内容面，和底部终端呼应 */}
        <div className={cn('flex flex-1 flex-col p-4', CARD)}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className={TITLE}>{$('proto.instance.motdPreview')}</h3>
              <p className={cn('mt-0.5 text-[11px]', MUTED)}>{$('proto.instance.motdHint')}</p>
            </div>
            <button
              type="button"
              title={$('proto.action.copy')}
              aria-label={$('proto.action.copy')}
              className="grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-3 flex min-h-14 flex-1 items-center rounded-lg border border-slate-800 bg-slate-950 px-3 py-2.5 font-mono text-[13px] leading-relaxed shadow-inner">
            <span className="text-slate-100">{inst.name}</span>{' '}
            <span className="text-slate-300">{inst.note ?? $('proto.instance.motdDefault')}</span>{' '}
            <span className="text-slate-400">[{inst.version}]</span>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className={cn('text-[11px]', MUTED)}>{$('proto.instance.motdTag')}</span>
            <button
              type="button"
              onClick={() => onTab('config')}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
                'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
              )}
            >
              <FileCog className="h-3.5 w-3.5 text-slate-400" />
              {$('proto.quick.config')}
            </button>
          </div>
        </div>
      </div>

      {/* 最近事件：极简时间轴，不放边框表格 */}
      <div className={cn('flex min-h-0 flex-col p-4', CARD)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className={TITLE}>{$('proto.instance.events')}</h3>
            <p className={cn('mt-0.5 text-[11px]', MUTED)}>{$('proto.instance.eventsHint')}</p>
          </div>
          <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-slate-50 px-2 text-[11px] text-slate-500 ring-1 ring-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700/60">
            <span className="size-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
            {$('proto.instance.live')}
          </span>
        </div>

        <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {MOCK_EVENTS.map((e) => {
            const text = getLanguage() === 'en' ? e.textEn : e.text;
            return (
              <div key={e.time + e.text} className="flex items-start gap-2.5">
                <span className={cn('mt-0.5 w-9 shrink-0 text-right font-mono text-[11px]', MUTED)}>{e.time}</span>
                <span
                  className={cn(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    e.level === 'error'
                      ? 'bg-red-500'
                      : e.level === 'warn'
                        ? 'bg-slate-400 dark:bg-slate-500'
                        : 'bg-slate-300 dark:bg-slate-600',
                  )}
                />
                <p
                  className={cn(
                    'text-[13px] leading-snug text-pretty',
                    e.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-700 dark:text-slate-300',
                  )}
                >
                  {text}
                </p>
              </div>
            );
          })}
        </div>

        <div className={cn('mt-4 flex items-center justify-between gap-3 border-t pt-3', HAIRLINE)}>
          <span className={cn('text-[11px]', MUTED)}>{$('proto.instance.recentErrors', errorCount)}</span>
          <button
            type="button"
            onClick={onOpenLog}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
          >
            {$('proto.action.viewLog')}
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className={cn('mb-1 block', LABEL)}>{label}</span>
      <span className={cn('block truncate text-[13px] font-medium', STRONG)}>{value}</span>
    </div>
  );
}

/* ───────────────────────────── 玩家 ───────────────────────────── */

function PlayersTab({ inst, status }: { inst: ProtoInstance; status: ProtoStatus }) {
  const online = status === 'running' ? (inst.players ?? 0) : 0;
  const rows = MOCK_PLAYERS.slice(0, Math.min(online, MOCK_PLAYERS.length));

  return (
    <div className={cn('overflow-hidden', CARD)}>
      <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3', HAIRLINE)}>
        <div>
          <h3 className={TITLE}>{$('proto.tab.players')}</h3>
          <p className={cn('mt-0.5 text-[11px]', MUTED)}>
            {$('proto.instance.players', online, inst.maxPlayers)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="sm" className="h-7 text-[13px]">
            <Users className="h-3.5 w-3.5" />
            {$('proto.instance.stats')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-[13px]">
            <ShieldAlert className="h-3.5 w-3.5" />
            {$('proto.instance.bans')}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-10">
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title={$('proto.empty.noPlayers')}
            hint={$('proto.empty.noPlayersHint')}
          />
        </div>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((p) => (
            <PlayerRow key={p.name} player={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerRow({ player }: { player: (typeof MOCK_PLAYERS)[number] }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-100 text-[11px] font-semibold uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-300">
        {player.name.slice(0, 2)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('truncate text-[13px] font-medium', STRONG)}>{player.name}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
            <span className="size-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
            {$('proto.player.online')}
          </span>
        </div>
        <p className={cn('mt-0.5 text-[11px]', MUTED)}>{$('proto.player.session', player.minutes)}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${$('proto.action.more')} ${player.name}`}
            className="h-7 w-7 text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem className="text-[13px]">{$('proto.player.kick')}</DropdownMenuItem>
          <DropdownMenuItem className="text-[13px]">{$('proto.player.op')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" className="text-[13px]">
            {$('proto.player.ban')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-slate-50 text-slate-300 dark:bg-slate-800 dark:text-slate-600">
        {icon}
      </span>
      <p className={cn('text-[13px] font-medium', STRONG)}>{title}</p>
      {hint && <p className={cn('max-w-sm text-[11px] leading-relaxed', MUTED)}>{hint}</p>}
    </div>
  );
}

/* ───────────────────────────── 文件 ───────────────────────────── */

const FILES = ['server.properties', 'eula.txt', 'ops.json', 'config/', 'mods/', 'world/', 'logs/latest.log'];

const FILE_CONTENT: Record<string, string> = {
  'server.properties': `#Minecraft server properties
max-players=20
online-mode=true
server-port=25565
motd=\\u00a7aSurvival \\u00a77| 1.20.4
view-distance=10
simulation-distance=8
enable-command-block=true`,
  'eula.txt': `#By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA.
eula=true`,
  'ops.json': `[
  {
    "name": "Steve",
    "level": 4,
    "bypassesPlayerLimit": false
  }
]`,
  'logs/latest.log': `[12:04:31] [Server thread/INFO]: Saving chunks for level 'world'
[12:04:30] [Server thread/INFO]: Saving the game (this may take a moment!)
[12:03:58] [Server thread/INFO]: <Alex> 有人要一起挖矿吗
[12:03:11] [Server thread/INFO]: Steve joined the game`,
};

function FilesTab() {
  const [activeFile, setActiveFile] = useState('server.properties');
  const content = FILE_CONTENT[activeFile] ?? '';
  const lines = content.split('\n');

  return (
    <div className={cn('grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden', CARD)}>
      <aside className={cn('flex min-h-0 flex-col border-r bg-slate-50/60 dark:bg-slate-900/40', HAIRLINE)}>
        <div className={cn('flex h-11 shrink-0 items-center gap-2 border-b px-3', HAIRLINE)}>
          <FolderTree className="h-3.5 w-3.5 text-slate-400" />
          <span className="truncate font-mono text-[11px] text-slate-500">/survival</span>
          <button
            type="button"
            title={$('proto.action.refresh')}
            aria-label={$('proto.action.refresh')}
            className="ml-auto grid size-6 place-items-center rounded text-slate-400 transition-colors hover:bg-white hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-1.5">
          {FILES.map((f) => {
            const dir = f.endsWith('/');
            return (
              <button
                key={f}
                type="button"
                onClick={() => !dir && setActiveFile(f)}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[13px] transition-colors',
                  !dir && activeFile === f
                    ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200/60 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700/60'
                    : cn('text-slate-500 hover:bg-white/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'),
                )}
              >
                {dir ? (
                  <FolderTree className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}
                <span className="truncate">{f}</span>
              </button>
            );
          })}
        </div>

        <div className={cn('border-t p-1.5', HAIRLINE)}>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-slate-500 transition-colors hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            <Upload className="h-3.5 w-3.5" />
            {$('proto.action.upload')}
          </button>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className={cn('flex h-11 shrink-0 items-center gap-2 border-b px-3', HAIRLINE)}>
          <FileText className="h-3.5 w-3.5 text-slate-400" />
          <span className={cn('truncate font-mono text-[13px]', STRONG)}>{activeFile}</span>
          <span className={cn('text-[11px]', MUTED)}>2 KB</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 text-[13px]">
              {$('proto.action.refresh')}
            </Button>
            <Button size="sm" className="h-7 bg-slate-900 px-3 text-[13px] font-normal text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200">
              {$('proto.save.apply')}
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-auto bg-white dark:bg-slate-900">
          <div className={cn('shrink-0 border-r bg-slate-50/40 px-3 py-4 text-right font-mono text-[11px] leading-6 text-slate-300 select-none dark:bg-slate-800/30 dark:text-slate-600', HAIRLINE)}>
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <pre className="min-w-0 flex-1 overflow-x-auto p-4 font-mono text-[13px] leading-6 text-slate-700 dark:text-slate-300">
            {content}
          </pre>
        </div>
      </section>
    </div>
  );
}

/* ───────────────────────────── 配置 ───────────────────────────── */

function ConfigTab() {
  const [kind, setKind] = useState<'props' | 'plugin' | 'mods'>('props');
  const options: { id: typeof kind; label: string }[] = [
    { id: 'props', label: 'server.properties' },
    { id: 'plugin', label: $('proto.cfg.plugins') },
    { id: 'mods', label: $('proto.cfg.mods') },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <div className="inline-flex w-fit items-center gap-0.5 rounded-lg border border-slate-200/60 bg-white p-0.5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => setKind(o.id)}
            className={cn(
              'h-7 rounded-md px-3 text-[13px] transition-colors',
              kind === o.id
                ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {kind === 'props' ? (
        <div className={cn('overflow-hidden', CARD)}>
          <div className={cn('flex items-center justify-between border-b px-4 py-3', HAIRLINE)}>
            <h3 className={TITLE}>server.properties</h3>
            <Button size="sm" className="h-7 bg-slate-900 px-3 text-[13px] font-normal text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200">
              {$('proto.save.apply')}
            </Button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {[
              ['server-port', '25565'],
              ['max-players', '20'],
              ['online-mode', 'true'],
              ['motd', '§aSurvival §7| 1.20.4'],
              ['view-distance', '10'],
            ].map(([k, v]) => (
              <div
                key={k}
                className="grid grid-cols-[minmax(140px,220px)_minmax(0,1fr)] items-center gap-4 px-4 py-2.5 text-[13px]"
              >
                <span className={cn('truncate font-mono', MUTED)}>{k}</span>
                <span className={cn('truncate font-mono', STRONG)}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : kind === 'plugin' ? (
        <div className={cn('overflow-hidden', CARD)}>
          <div className={cn('border-b px-4 py-3', HAIRLINE)}>
            <h3 className={TITLE}>{$('proto.cfg.plugins')} · config.yml</h3>
          </div>
          <pre className="p-4 font-mono text-[13px] leading-6 text-slate-700 dark:text-slate-300">{`economy:
  enabled: true
  currency: "coin"
  start-balance: 100
spawn:
  world: world
  x: 0.5
  y: 64
  z: 0.5`}</pre>
        </div>
      ) : (
        <div className={cn('overflow-hidden', CARD)}>
          <div className={cn('flex items-center justify-between border-b px-4 py-3', HAIRLINE)}>
            <h3 className={TITLE}>{$('proto.cfg.mods')}</h3>
            <Button variant="outline" size="sm" className="h-7 text-[13px]">
              <Upload className="h-3.5 w-3.5" />
              {$('proto.action.upload')}
            </Button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {['fabric-api-0.96.jar', 'lithium-0.12.jar', 'carpet-1.4.jar'].map((m) => (
              <div key={m} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-400">
                  <FileText className="h-3.5 w-3.5" />
                </span>
                <span className={cn('min-w-0 flex-1 truncate font-mono text-[13px]', STRONG)}>{m}</span>
                <Switch defaultChecked size="sm" />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={$('proto.cp.delete')}
                  className="h-7 w-7 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── 维护 ───────────────────────────── */

function MaintenanceTab() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className={cn('overflow-hidden', CARD)}>
        <div className={cn('border-b px-4 py-3', HAIRLINE)}>
          <h3 className={TITLE}>{$('proto.tab.automation')}</h3>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          <MaintenanceRow
            icon={Timer}
            label={$('proto.field.autoRestart')}
            meta="04:00"
            checked
          />
          <MaintenanceRow
            icon={Archive}
            label={$('proto.field.dailyBackup')}
            meta={`0 */6 * * * · ${$('proto.auto.retain', 7)}`}
            checked
          />
          <MaintenanceRow
            icon={HardDrive}
            label={$('proto.auto.memory')}
            meta={$('proto.auto.memoryRule', 90, 5)}
          />
        </div>
      </div>

      <div className={cn('overflow-hidden', CARD)}>
        <div className={cn('flex items-center justify-between gap-3 border-b px-4 py-3', HAIRLINE)}>
          <h3 className={TITLE}>{$('proto.tab.backups')}</h3>
          <Button size="sm" className="h-7 bg-slate-900 px-3 text-[13px] font-normal text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200">
            <Archive className="h-3.5 w-3.5" />
            {$('proto.quick.backup')}
          </Button>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {MOCK_BACKUPS.map((b) => (
            <div key={b.name} className="flex items-center gap-3 px-4 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-400 dark:bg-slate-800 dark:text-slate-400">
                <Archive className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cn('truncate font-mono text-[13px]', STRONG)}>{b.name}</p>
                <p className={cn('mt-0.5 text-[11px]', MUTED)}>
                  {b.size} · {b.time}
                </p>
              </div>
              <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-slate-50 px-2 text-[11px] text-slate-500 ring-1 ring-slate-200/60 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700/60">
                {b.auto ? $('proto.backup.auto') : $('proto.backup.manual')}
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-[13px]">
                {$('proto.action.restore')}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={$('proto.cp.delete')}
                className="h-7 w-7 text-slate-400 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MaintenanceRow({
  icon: Icon,
  label,
  meta,
  checked,
}: {
  icon: IconType;
  label: string;
  meta: string;
  checked?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className="h-4 w-4 shrink-0 text-slate-400" />
      <div className="min-w-0 flex-1">
        <p className={cn('text-[13px] font-medium', STRONG)}>{label}</p>
        <p className={cn('mt-0.5 font-mono text-[11px]', MUTED)}>{meta}</p>
      </div>
      <Switch defaultChecked={checked} size="sm" />
      <Button variant="ghost" size="sm" className="h-7 text-[13px]">
        {$('proto.action.edit')}
      </Button>
    </div>
  );
}

/* ───────────────────────────── 终端 Dock ───────────────────────────── */

function TerminalDock({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="shrink-0 border-t border-slate-800 bg-slate-950 text-slate-200">
      {open && (
        <>
          <div className="flex h-9 items-center gap-2 border-b border-slate-800 px-4 text-[11px] text-slate-400">
            <Terminal className="h-3.5 w-3.5" />
            <span>{$('proto.dock.title')}</span>
            <span className="inline-flex h-5 items-center rounded-full bg-red-500/10 px-1.5 text-[11px] text-red-400">
              {$('proto.dock.errors', 3)}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <DockButton title={$('proto.dock.search')}>
                <Search className="h-3.5 w-3.5" />
              </DockButton>
              <DockButton title={$('proto.dock.clear')}>
                <Trash2 className="h-3.5 w-3.5" />
              </DockButton>
              <DockButton title={$('proto.dock.collapse')} onClick={onToggle}>
                <ChevronDown className="h-3.5 w-3.5" />
              </DockButton>
            </div>
          </div>
          <div className="h-44">
            <LogLines lines={MOCK_LOG} />
          </div>
        </>
      )}

      <div className="flex h-9 items-center gap-2 px-4">
        <button
          type="button"
          onClick={onToggle}
          title={open ? $('proto.dock.collapse') : $('proto.dock.expand')}
          aria-label={open ? $('proto.dock.collapse') : $('proto.dock.expand')}
          className="grid size-5 shrink-0 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
        {!open && (
          <>
            <span className="max-w-[38%] truncate font-mono text-[11px] text-slate-500">{MOCK_LOG[0]}</span>
            <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-red-500/10 px-1.5 text-[11px] text-red-400">
              {$('proto.dock.errors', 3)}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[11px] text-slate-500">❯</span>
        <input
          placeholder={$('proto.dock.input')}
          className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[11px] text-slate-100 outline-none placeholder:text-slate-600"
        />
        <span className="shrink-0 rounded border border-slate-800 px-1 font-mono text-[11px] text-slate-500">Ctrl+`</span>
      </div>
    </div>
  );
}

function DockButton({ title, onClick, children }: { title: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="grid size-6 place-items-center rounded text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
    >
      {children}
    </button>
  );
}

function LogLines({ lines }: { lines: string[] }) {
  return (
    <div className="h-full overflow-auto bg-slate-950 px-4 py-2 font-mono text-[11px] leading-[18px] text-slate-300">
      {lines.map((line) => (
        <div
          key={line}
          className={cn(
            'break-all whitespace-pre-wrap',
            line.includes('/ERROR') && 'text-red-400',
            line.includes('/WARN') && 'text-amber-300',
          )}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────────── 控制面板 ───────────────────────────── */

function ControlPanel({
  open,
  onOpenChange,
  inst,
  serverName,
  onDeleteRequest,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  inst: ProtoInstance;
  serverName: string;
  onDeleteRequest: () => void;
}) {
  const [nav, setNav] = useState<CpNav>('basic');
  const items: { id: CpNav; label: string; icon: IconType }[] = [
    { id: 'basic', label: $('proto.cp.basic'), icon: SlidersHorizontal },
    { id: 'network', label: $('proto.cp.network'), icon: HardDrive },
    { id: 'players', label: $('proto.cp.players'), icon: Users },
    { id: 'automation', label: $('proto.cp.automation'), icon: Timer },
    { id: 'backups', label: $('proto.cp.backups'), icon: Archive },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(760px,86vh)] w-[min(1160px,94vw)] max-w-none grid-rows-[52px_minmax(0,1fr)_56px] gap-0 overflow-hidden rounded-xl border border-slate-200/60 bg-white p-0 shadow-2xl sm:max-w-none dark:border-slate-800 dark:bg-slate-900"
      >
        <div className={cn('flex items-center gap-3 border-b px-5', HAIRLINE)}>
          <DialogTitle className={cn('text-[15px] font-semibold', STRONG)}>{$('proto.cp.title')}</DialogTitle>
          <span className={cn('font-mono text-[11px]', MUTED)}>
            {serverName} / {inst.name}
          </span>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={$('proto.cp.cancel')}
              className="ml-auto text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0">
          <nav className={cn('flex w-44 shrink-0 flex-col gap-0.5 border-r bg-slate-50/60 p-2 dark:bg-slate-900/40', HAIRLINE)}>
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setNav(it.id)}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
                  nav === it.id
                    ? 'bg-white font-medium text-slate-900 shadow-xs ring-1 ring-slate-200/60 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700/60'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100',
                )}
              >
                <it.icon className="h-3.5 w-3.5" />
                {it.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-auto bg-white p-5 dark:bg-slate-900">
            {nav === 'basic' && (
              <div className="grid gap-6">
                <FormGrid>
                  <PanelField label={$('proto.field.memoryLimit')}>
                    <input className={INPUT} defaultValue={String(inst.memoryMaxMB)} />
                  </PanelField>
                  <PanelField label={$('proto.field.port')}>
                    <input className={INPUT} defaultValue={String(inst.port)} disabled />
                  </PanelField>
                  <PanelField label={$('proto.field.note')} wide>
                    <input className={INPUT} defaultValue={inst.note ?? ''} />
                  </PanelField>
                  <PanelField label={$('proto.field.core')} hint={`${inst.core} ${inst.version}`}>
                    <input className={INPUT} defaultValue={`${inst.core.toLowerCase()}-server-launch.jar`} disabled />
                  </PanelField>
                  <PanelField label={$('proto.field.domain')}>
                    <input className={INPUT} defaultValue="mc.example.com" />
                  </PanelField>
                </FormGrid>

                <PanelSection title={$('proto.quick.config')}>
                  <Button variant="outline" size="sm" className="h-7 text-[13px]">
                    server.properties
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-[13px]">
                    {$('proto.cfg.plugins')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-[13px]">
                    {$('proto.cfg.mods')}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-[13px]">
                    {$('proto.cp.fullEdit')}
                  </Button>
                </PanelSection>

                <PanelSection title={$('proto.tab.maintenance')}>
                  <Button variant="outline" size="sm" className="h-7 text-[13px]">
                    {$('proto.cp.installPanel')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-[13px]">
                    {$('proto.cp.reinstall')}
                  </Button>
                  <Button variant="destructive" size="sm" className="h-7 text-[13px]" onClick={onDeleteRequest}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {$('proto.cp.delete')}
                  </Button>
                  <p className={cn('w-full text-[11px]', MUTED)}>{$('proto.cp.dangerHint')}</p>
                </PanelSection>
              </div>
            )}

            {nav === 'network' && (
              <FormGrid>
                <PanelField label={$('proto.field.domain')}>
                  <input className={INPUT} defaultValue="mc.example.com" />
                </PanelField>
                <PanelField label={$('proto.field.publicPort')} hint={$('proto.cp.frpHint')}>
                  <div className="flex gap-1.5">
                    <input className={INPUT} defaultValue="30001" />
                    <Button variant="outline" size="sm" className="h-8 shrink-0 text-[13px]">
                      {$('proto.action.bind')}
                    </Button>
                  </div>
                </PanelField>
                <PanelField label="frp" wide hint={$('proto.cp.frpNode')}>
                  <input className={INPUT} defaultValue="mc.example.com:30001" disabled />
                </PanelField>
              </FormGrid>
            )}

            {nav === 'players' && (
              <div className="grid max-w-[520px] gap-1.5">
                <Button variant="outline" size="sm" className="h-8 justify-start text-[13px]">
                  <Users className="h-3.5 w-3.5" />
                  {$('proto.instance.stats')}
                </Button>
                <Button variant="outline" size="sm" className="h-8 justify-start text-[13px]">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {$('proto.instance.bans')}
                </Button>
              </div>
            )}

            {nav === 'automation' && (
              <div className="grid max-w-[640px] gap-2">
                <div className={cn('flex h-10 items-center gap-3 rounded-md border px-3 text-[13px]', 'border-slate-200 dark:border-slate-700')}>
                  <span className={STRONG}>{$('proto.field.autoRestart')}</span>
                  <span className={cn('font-mono text-[11px]', MUTED)}>04:00</span>
                  <Switch defaultChecked size="sm" className="ml-auto" />
                </div>
                <div className={cn('flex h-10 items-center gap-3 rounded-md border px-3 text-[13px]', 'border-slate-200 dark:border-slate-700')}>
                  <span className={STRONG}>{$('proto.field.dailyBackup')}</span>
                  <span className={cn('font-mono text-[11px]', MUTED)}>0 */6 * * *</span>
                  <Switch defaultChecked size="sm" className="ml-auto" />
                </div>
              </div>
            )}

            {nav === 'backups' && (
              <div className="grid gap-2">
                <Button size="sm" className="h-7 w-fit bg-slate-900 px-3 text-[13px] font-normal text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200">
                  <Archive className="h-3.5 w-3.5" />
                  {$('proto.quick.backup')}
                </Button>
                <div className={cn('overflow-hidden rounded-lg border', 'border-slate-200 dark:border-slate-700')}>
                  {MOCK_BACKUPS.slice(0, 3).map((b) => (
                    <div
                      key={b.name}
                      className={cn('flex h-9 items-center gap-3 border-b px-3 text-[13px] last:border-b-0', HAIRLINE)}
                    >
                      <span className={cn('truncate font-mono', STRONG)}>{b.name}</span>
                      <span className={cn('ml-auto font-mono text-[11px]', MUTED)}>{b.size}</span>
                      <span className={cn('font-mono text-[11px]', MUTED)}>{b.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={cn('flex items-center gap-2 border-t px-5', HAIRLINE)}>
          <span className={cn('text-[11px]', MUTED)}>{$('proto.cp.hint')}</span>
          <div className="ml-auto flex items-center gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm" className="h-7 text-[13px]">
                {$('proto.cp.cancel')}
              </Button>
            </DialogClose>
            <Button size="sm" className="h-7 bg-slate-900 px-3 text-[13px] font-normal text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200">
              {$('proto.cp.save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid max-w-[620px] grid-cols-2 gap-x-4 gap-y-4">{children}</div>;
}

function PanelField({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={cn('grid min-w-0 content-start gap-1.5', wide && 'col-span-2')}>
      <span className={cn('text-[11px]', MUTED)}>{label}</span>
      {children}
      {hint && <span className={cn('text-[11px] leading-4', MUTED)}>{hint}</span>}
    </label>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid max-w-[620px] gap-2">
      <h3 className={cn('text-[13px] font-medium', STRONG)}>{title}</h3>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </section>
  );
}
