// 原型屏 3：实例工作台（2026-10-21 第五版）。
//
// 这一版按讨论做了 P0：
//   ① Tab 7 → 5：删「终端」（Dock 就是终端），「自动化 + 备份」合并成「维护」；
//   ② 指标条 5 → 4：最近备份移出，进「最近事件」与「维护」；
//   ③ 概览改三段：状态摘要（含错误数）→ 最近事件 | 快捷操作 + MOTD；
//   ④ 主操作随状态翻转：运行中＝停止（主）+ 重启，停止＝启动（主）；
//   ⑤ 右栏玩家取消，玩家统一进「玩家」Tab，布局不再随 Tab 跳动。

import { useState } from 'react';
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  FileCog,
  FileText,
  FolderTree,
  HardDrive,
  Play,
  Plus,
  RotateCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  Timer,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
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
import { Bar, Dot, EmptyState, Field, FormGrid, INPUT_CLASS, Panel, Pill } from '../proto-ui';
import { PageHeader, type ProtoScreen } from '../shell';

type Tab = 'overview' | 'players' | 'files' | 'config' | 'maintenance';
type CpNav = 'basic' | 'network' | 'players' | 'automation' | 'backups';

/** 状态 → 徽章颜色与文案（切换实例后头部/摘要都要跟着变） */
const STATUS: Record<
  ProtoStatus,
  { tone: 'ok' | 'warn' | 'bad' | 'idle'; key: 'proto.status.running' | 'proto.status.stopped' | 'proto.status.starting' | 'proto.status.failed' }
> = {
  running: { tone: 'ok', key: 'proto.status.running' },
  stopped: { tone: 'idle', key: 'proto.status.stopped' },
  starting: { tone: 'warn', key: 'proto.status.starting' },
  failed: { tone: 'bad', key: 'proto.status.failed' },
};

const DEFAULT_INSTANCE = MOCK_INSTANCES[0];

export function InstanceScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [instName, setInstName] = useState(DEFAULT_INSTANCE.name);
  const [tab, setTab] = useState<Tab>('overview');
  const [dockOpen, setDockOpen] = useState(false);
  const [cpOpen, setCpOpen] = useState(false);

  const inst = MOCK_INSTANCES.find((i) => i.name === instName && i.serverId === DEFAULT_INSTANCE.serverId) ?? DEFAULT_INSTANCE;
  const server = MOCK_SERVERS.find((s) => s.id === inst.serverId);
  const siblings = MOCK_INSTANCES.filter((i) => i.serverId === inst.serverId);
  const st = STATUS[inst.status];
  const running = inst.status === 'running';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: $('proto.tab.overview') },
    { id: 'players', label: $('proto.tab.players') },
    { id: 'files', label: $('proto.tab.files') },
    { id: 'config', label: $('proto.tab.config') },
    { id: 'maintenance', label: $('proto.tab.maintenance') },
  ];

  return (
    <>
      <PageHeader
        back={() => onScreen('instances')}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40 text-muted-foreground">
              {inst.icon ? <img src={inst.icon} alt="" className="size-full object-cover" /> : <Archive className="size-3.5" />}
            </span>
            <h1 className="truncate text-[13px] font-semibold">{inst.name}</h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title={$('proto.instance.switch')}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <ChevronDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  {server?.name ?? '—'}
                </DropdownMenuLabel>
                {siblings.map((s) => (
                  <DropdownMenuItem key={s.name} onSelect={() => setInstName(s.name)}>
                    <Dot tone={STATUS[s.status].tone} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.name === inst.name && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Pill tone={st.tone}>
              <Dot tone={st.tone} />
              {$(st.key)}
            </Pill>
          </span>
        }
        subtitle={
          server && (
            <span className="hidden items-center gap-1 lg:flex">
              <span className="text-muted-foreground/60">/</span>
              {server.name}
            </span>
          )
        }
        actions={
          <>
            {running ? (
              <>
                <Button size="sm">
                  <Square className="size-3.5" />
                  {$('proto.action.stop')}
                </Button>
                <Button size="sm" variant="outline">
                  <RotateCw className="size-3.5" />
                  {$('proto.action.restart')}
                </Button>
              </>
            ) : (
              <Button size="sm">
                <Play className="size-3.5" />
                {$('proto.action.start')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setCpOpen(true)}>
              <SlidersHorizontal className="size-3.5" />
              {$('proto.action.controlPanel')}
            </Button>
            <Button size="icon-sm" variant="ghost" title={$('proto.action.more')}>
              <Ellipsis />
            </Button>
          </>
        }
      />

      <MetricStrip inst={inst} />

      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'h-8 rounded-md px-2.5 text-[12px] whitespace-nowrap transition-colors',
              tab === t.id
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'overview' && <OverviewTab inst={inst} onOpenTerminal={() => setDockOpen(true)} />}
        {tab === 'players' && <PlayersTab inst={inst} />}
        {tab === 'files' && <FilesTab />}
        {tab === 'config' && <ConfigTab />}
        {tab === 'maintenance' && <MaintenanceTab />}
      </div>

      <TerminalDock open={dockOpen} onToggle={() => setDockOpen((v) => !v)} />

      <ControlPanel open={cpOpen} onOpenChange={setCpOpen} inst={inst} serverName={server?.name ?? '—'} />
    </>
  );
}

function MetricStrip({ inst }: { inst: ProtoInstance }) {
  // 指标按内容定宽（118/项），不铺满整行；右侧留给连接地址，宽窗口也不会把数字拉开成孤岛
  const memPct = Math.round((inst.memoryMB / Math.max(1, inst.memoryMaxMB)) * 100);
  return (
    <div className="flex h-16 shrink-0 items-stretch border-b">
      <div className="flex items-stretch divide-x">
        <Metric label={$('proto.metric.players')} value={`${inst.players ?? 0} / ${inst.maxPlayers}`} hint="—" tone="ok" />
        <Metric
          label={$('proto.metric.memory')}
          value={`${(inst.memoryMB / 1024).toFixed(1)} / ${inst.memoryMaxMB / 1024}G`}
          bar={memPct}
          hint={$('proto.metric.memHint')}
        />
        <Metric label={$('proto.metric.uptime')} value={inst.uptime ?? '—'} hint={$('proto.metric.uptimeHint')} />
        <Metric label={$('proto.metric.cpu')} value="42%" bar={42} hint={$('proto.metric.cpuHint')} />
      </div>
      <div className="ml-auto flex items-center gap-1.5 px-4">
        <span className="font-mono text-[11px] text-muted-foreground">{inst.address ?? `:${inst.port}`}</span>
        <button
          type="button"
          title={$('proto.action.copy')}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  bar,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  bar?: number;
  tone?: 'ok';
}) {
  return (
    <div className="flex w-[118px] shrink-0 flex-col justify-center gap-0.5 px-4">
      <span className="text-[10.5px] text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'font-mono text-[15px] leading-none font-semibold tabular-nums',
            tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          )}
        >
          {value}
        </span>
        {bar !== undefined && <Bar value={bar} className="w-10" />}
      </span>
      <span className="truncate text-[10px] text-muted-foreground/80">{hint}</span>
    </div>
  );
}

/** 状态摘要：正常时一行带过，异常时置顶并给「查看日志」——概览先回答「现在有没有事」 */
function StatusSummary({ inst, onOpenLog }: { inst: ProtoInstance; onOpenLog: () => void }) {
  const failed = inst.status === 'failed';
  const running = inst.status === 'running';
  // 停止/启动中不重复「已停止」（头部徽章已经说了），改为显示备注或上次状态
  const detail = failed
    ? $('proto.instance.failedReason')
    : running
      ? `${$('proto.metric.uptime')} ${inst.uptime ?? '—'} · ${$('proto.instance.recentErrors', 3)}`
      : (inst.note ?? $(STATUS[inst.status].key));
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 text-[11.5px]',
        failed ? 'border-destructive/40 bg-destructive/5' : 'bg-card',
      )}
    >
      <Dot tone={failed ? 'bad' : 'ok'} />
      <span className="shrink-0 font-medium">
        {failed ? $('proto.instance.failedTitle') : $('proto.instance.players', inst.players ?? 0, inst.maxPlayers)}
      </span>
      <span className="truncate text-muted-foreground">{detail}</span>
      <Button size="xs" variant="outline" className="ml-auto shrink-0" onClick={onOpenLog}>
        {$('proto.action.viewLog')}
      </Button>
    </div>
  );
}

function OverviewTab({ inst, onOpenTerminal }: { inst: ProtoInstance; onOpenTerminal: () => void }) {
  const quick = [
    { icon: Archive, label: $('proto.quick.backup') },
    { icon: Timer, label: $('proto.quick.tasks') },
    { icon: FileText, label: $('proto.quick.terminal'), onClick: onOpenTerminal },
    { icon: FolderTree, label: $('proto.quick.files') },
    { icon: FileCog, label: $('proto.quick.config') },
    { icon: RotateCw, label: $('proto.quick.restart') },
  ];

  return (
    <div className="grid content-start gap-2 p-2">
      <StatusSummary inst={inst} onOpenLog={onOpenTerminal} />

      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2">
        <Panel title={$('proto.instance.events')} flush>
          <div className="divide-y divide-border/60">
            {MOCK_EVENTS.map((e) => (
              <div key={e.time + e.text} className="flex h-7 items-center gap-2 px-3 text-[11.5px]">
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{e.time}</span>
                <Dot tone={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'idle'} />
                <span className={cn('truncate', e.level === 'error' && 'text-destructive')}>{e.text}</span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="grid min-w-0 content-start gap-2">
          <Panel title={$('proto.instance.quick')}>
            <div className="grid grid-cols-3 gap-1.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={q.onClick}
                  className="flex h-[52px] flex-col items-center justify-center gap-1 rounded-md border bg-background text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground"
                >
                  <q.icon className="size-3.5" />
                  <span className="max-w-full truncate px-1">{q.label}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title={$('proto.instance.motd')}>
            <div className="grid gap-1.5">
              <p className="rounded-md border bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
                §a生存服 §7| §f1.20.4 §7| §e欢迎回来
              </p>
              <div className="flex gap-1.5">
                <Button size="xs" variant="outline">
                  {$('proto.quick.config')}
                </Button>
                <Button size="xs" variant="ghost">
                  {$('proto.action.copy')}
                </Button>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function LogLines({ lines }: { lines: string[] }) {
  return (
    <div className="h-full overflow-auto bg-zinc-950 px-2.5 py-1.5 font-mono text-[10.5px] leading-[17px] text-zinc-300">
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

function PlayersTab({ inst }: { inst: ProtoInstance }) {
  const online = inst.players ?? 0;
  const rows = MOCK_PLAYERS.slice(0, Math.min(online, MOCK_PLAYERS.length));
  return (
    <div className="p-2">
      <Panel
        flush
        title={$('proto.tab.players')}
        hint={`${online}/${inst.maxPlayers}`}
        actions={
          <>
            <Button size="xs" variant="outline">
              <Users className="size-3" />
              {$('proto.instance.stats')}
            </Button>
            <Button size="xs" variant="outline">
              <ShieldAlert className="size-3" />
              {$('proto.instance.bans')}
            </Button>
          </>
        }
      >
        <div className="grid h-8 grid-cols-[minmax(140px,1fr)_90px_minmax(0,1fr)] items-center gap-3 border-b px-4 text-[11px] text-muted-foreground">
          <span>{$('proto.col.players')}</span>
          <span className="text-right">{$('proto.metric.uptime')}</span>
          <span className="text-right">{$('proto.col.actions')}</span>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={$('proto.empty.noPlayers')} />
        ) : (
          rows.map((p) => (
          <div
            key={p.name}
            className="grid h-9 grid-cols-[minmax(140px,1fr)_90px_minmax(0,1fr)] items-center gap-3 border-b border-border/50 px-4 text-[12px]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid size-5 place-items-center rounded bg-muted font-mono text-[9px] text-muted-foreground">
                {p.name.slice(0, 2)}
              </span>
              <b className="truncate font-medium">{p.name}</b>
            </span>
            <span className="text-right font-mono text-[11px] text-muted-foreground">{p.minutes}</span>
            <span className="flex items-center justify-end gap-1">
              <Button size="xs" variant="ghost">
                {$('proto.player.kick')}
              </Button>
              <Button size="xs" variant="ghost">
                {$('proto.player.op')}
              </Button>
              <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive">
                {$('proto.player.ban')}
              </Button>
            </span>
          </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function FilesTab() {
  const files = ['server.properties', 'eula.txt', 'ops.json', 'config/', 'mods/', 'world/', 'logs/latest.log'];
  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground">/survival</span>
          <Button size="icon-xs" variant="ghost" className="ml-auto">
            <Plus />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {files.map((f) => (
            <button
              key={f}
              type="button"
              className="flex h-7 w-full items-center gap-1.5 rounded px-2 text-left font-mono text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              {f.endsWith('/') ? <FolderTree className="size-3.5" /> : <FileText className="size-3.5" />}
              <span className="truncate">{f}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11.5px]">
          <FileText className="size-3.5 text-muted-foreground" />
          <span className="font-mono">server.properties</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground">2 KB</span>
          <div className="ml-auto flex gap-1">
            <Button size="xs" variant="ghost">
              {$('proto.action.refresh')}
            </Button>
            <Button size="xs">{$('proto.save.apply')}</Button>
          </div>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto bg-muted/20 p-3 font-mono text-[11px] leading-[18px] text-foreground/90">{`#Minecraft server properties
max-players=20
online-mode=true
server-port=25565
motd=\\u00a7aSurvival \\u00a77| 1.20.4
view-distance=10
simulation-distance=8
enable-command-block=true`}</pre>
      </div>
    </div>
  );
}

function ConfigTab() {
  const [kind, setKind] = useState<'props' | 'plugin' | 'mods'>('props');
  return (
    <div className="grid gap-2 p-2">
      <div className="flex items-center gap-1">
        {(
          [
            ['props', 'server.properties'],
            ['plugin', $('proto.cfg.plugins')],
            ['mods', $('proto.cfg.mods')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setKind(id)}
            className={cn(
              'h-7 rounded-md px-2.5 text-[11.5px]',
              kind === id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {kind === 'props' ? (
        <Panel flush title="server.properties">
          {[
            ['server-port', '25565'],
            ['max-players', '20'],
            ['online-mode', 'true'],
            ['motd', '§aSurvival §7| 1.20.4'],
            ['view-distance', '10'],
          ].map(([k, v]) => (
            <div
              key={k}
              className="grid h-8 grid-cols-[200px_minmax(0,1fr)] items-center gap-3 border-b border-border/50 px-3 text-[11.5px]"
            >
              <span className="truncate font-mono text-muted-foreground">{k}</span>
              <span className="truncate font-mono">{v}</span>
            </div>
          ))}
        </Panel>
      ) : kind === 'plugin' ? (
        <Panel flush title={`${$('proto.cfg.plugins')} · config.yml`}>
          <pre className="p-3 font-mono text-[11px] leading-[18px]">{`economy:
  enabled: true
  currency: "coin"
  start-balance: 100
spawn:
  world: world
  x: 0.5
  y: 64
  z: 0.5`}</pre>
        </Panel>
      ) : (
        <Panel flush title={$('proto.cfg.mods')}>
          {['fabric-api-0.96.jar', 'lithium-0.12.jar', 'carpet-1.4.jar'].map((m) => (
            <div key={m} className="flex h-8 items-center gap-2 border-b border-border/50 px-3 text-[11.5px]">
              <FileText className="size-3.5 text-muted-foreground" />
              <span className="truncate font-mono">{m}</span>
              <span className="ml-auto flex items-center gap-2">
                <Switch defaultChecked size="sm" />
                <Button size="icon-xs" variant="ghost">
                  <Trash2 />
                </Button>
              </span>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

/** 维护：自动化与备份合到一起（原来两个 Tab 高度重叠，尤其「定时备份」两边都有） */
function MaintenanceTab() {
  return (
    <div className="grid content-start gap-2 p-2">
      <Panel flush title={$('proto.tab.automation')}>
        <div className="flex h-10 items-center gap-3 border-b border-border/50 px-3 text-[12px]">
          <Timer className="size-3.5 text-muted-foreground" />
          <span>{$('proto.field.autoRestart')}</span>
          <span className="font-mono text-[11px] text-muted-foreground">04:00</span>
          <span className="ml-auto flex items-center gap-2">
            <Switch defaultChecked size="sm" />
            <Button size="xs" variant="outline">
              {$('proto.action.edit')}
            </Button>
          </span>
        </div>
        <div className="flex h-10 items-center gap-3 border-b border-border/50 px-3 text-[12px]">
          <Archive className="size-3.5 text-muted-foreground" />
          <span>{$('proto.field.dailyBackup')}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            0 */6 * * * · {$('proto.auto.retain', 7)}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <Switch defaultChecked size="sm" />
            <Button size="xs" variant="outline">
              {$('proto.action.edit')}
            </Button>
          </span>
        </div>
        <div className="flex h-10 items-center gap-3 px-3 text-[12px]">
          <HardDrive className="size-3.5 text-muted-foreground" />
          <span>{$('proto.auto.memory')}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{$('proto.auto.memoryRule', 90, 5)}</span>
          <span className="ml-auto flex items-center gap-2">
            <Switch size="sm" />
          </span>
        </div>
      </Panel>

      <Panel
        flush
        title={$('proto.tab.backups')}
        actions={
          <Button size="xs">
            <Archive className="size-3" />
            {$('proto.quick.backup')}
          </Button>
        }
      >
        <div className="grid h-8 grid-cols-[minmax(220px,1fr)_80px_100px_70px_110px] items-center gap-3 border-b px-4 text-[11px] text-muted-foreground">
          <span>{$('proto.tab.backups')}</span>
          <span className="text-right">{$('proto.col.size')}</span>
          <span className="text-right">{$('proto.col.time')}</span>
          <span className="text-center">{$('proto.col.source')}</span>
          <span className="text-right">{$('proto.col.actions')}</span>
        </div>
        {MOCK_BACKUPS.map((b) => (
          <div
            key={b.name}
            className="grid h-9 grid-cols-[minmax(220px,1fr)_80px_100px_70px_110px] items-center gap-3 border-b border-border/50 px-4 text-[11.5px]"
          >
            <span className="truncate font-mono">{b.name}</span>
            <span className="text-right font-mono text-muted-foreground">{b.size}</span>
            <span className="text-right font-mono text-muted-foreground">{b.time}</span>
            <span className="flex justify-center">
              <Pill tone={b.auto ? 'info' : 'idle'}>{b.auto ? 'auto' : 'manual'}</Pill>
            </span>
            <span className="flex items-center justify-end gap-1">
              <Button size="xs" variant="ghost">
                {$('proto.action.restore')}
              </Button>
              <Button size="icon-xs" variant="ghost">
                <Trash2 />
              </Button>
            </span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function TerminalDock({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="shrink-0 border-t bg-zinc-950 text-zinc-200">
      {open && (
        <>
          <div className="flex h-9 items-center gap-2 border-b border-zinc-800 px-4 text-[11px] text-zinc-400">
            <span>{$('proto.dock.title')}</span>
            <Pill tone="bad">{$('proto.dock.errors', 3)}</Pill>
            <span className="ml-auto flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title={$('proto.dock.search')}
              >
                <Search />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title={$('proto.dock.clear')}
              >
                <Trash2 />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                title={$('proto.dock.collapse')}
                onClick={onToggle}
              >
                <ChevronDown />
              </Button>
            </span>
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
          className="grid size-5 shrink-0 place-items-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </button>
        {!open && (
          <>
            <span className="max-w-[38%] truncate font-mono text-[10.5px] text-zinc-500">{MOCK_LOG[0]}</span>
            <Pill tone="bad">{$('proto.dock.errors', 3)}</Pill>
          </>
        )}
        <span className="ml-auto font-mono text-[11px] text-zinc-500">❯</span>
        <input
          placeholder={$('proto.dock.input')}
          className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <span className="shrink-0 rounded border border-zinc-800 px-1 font-mono text-[9.5px] text-zinc-500">Ctrl+`</span>
      </div>
    </div>
  );
}

function ControlPanel({
  open,
  onOpenChange,
  inst,
  serverName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  inst: ProtoInstance;
  serverName: string;
}) {
  const [nav, setNav] = useState<CpNav>('basic');
  const items: { id: CpNav; label: string; icon: typeof Archive }[] = [
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
        className="grid h-[min(760px,86vh)] w-[min(1160px,94vw)] max-w-none grid-rows-[52px_minmax(0,1fr)_56px] gap-0 overflow-hidden rounded-xl p-0 sm:max-w-none"
      >
        <div className="flex items-center gap-2 border-b px-4">
          <DialogTitle className="text-[13px] font-semibold">{$('proto.cp.title')}</DialogTitle>
          <span className="font-mono text-[11px] text-muted-foreground">
            {serverName} / {inst.name}
          </span>
          <DialogClose asChild>
            <Button size="icon-sm" variant="ghost" className="ml-auto">
              <X />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0">
          <nav className="flex w-45 shrink-0 flex-col gap-0.5 border-r p-2">
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setNav(it.id)}
                className={cn(
                  'flex h-9 items-center gap-2 rounded-md px-2 text-[12px] transition-colors',
                  nav === it.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <it.icon className="size-3.5" />
                {it.label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-auto p-4">
            {nav === 'basic' && (
              <div className="grid gap-5">
                <FormGrid>
                  <Field label={$('proto.field.memoryLimit')}>
                    <input className={INPUT_CLASS} defaultValue={String(inst.memoryMaxMB)} />
                  </Field>
                  <Field label={$('proto.field.port')}>
                    <input className={INPUT_CLASS} defaultValue={String(inst.port)} disabled />
                  </Field>
                  <Field label={$('proto.field.note')} wide>
                    <input className={INPUT_CLASS} defaultValue={inst.note ?? ''} />
                  </Field>
                  <Field label={$('proto.field.core')} hint={`${inst.core} ${inst.version}`}>
                    <input
                      className={INPUT_CLASS}
                      defaultValue={`${inst.core.toLowerCase()}-server-launch.jar`}
                      disabled
                    />
                  </Field>
                  <Field label={$('proto.field.domain')}>
                    <input className={INPUT_CLASS} defaultValue="mc.example.com" />
                  </Field>
                </FormGrid>

                {/* 入口行（配置文件）与下面的维护动作分节，不再六个动作挤一屏底部 */}
                <div className="grid max-w-[620px] gap-2">
                  <h3 className="text-[12px] font-medium">{$('proto.quick.config')}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" variant="outline">
                      server.properties
                    </Button>
                    <Button size="xs" variant="outline">
                      {$('proto.cfg.plugins')}
                    </Button>
                    <Button size="xs" variant="outline">
                      {$('proto.cfg.mods')}
                    </Button>
                    <Button size="xs" variant="ghost">
                      {$('proto.cp.fullEdit')}
                    </Button>
                  </div>
                </div>

                {/* 维护：破坏性动作放在这里，删除就是删除 */}
                <div className="grid max-w-[620px] gap-2">
                  <h3 className="text-[12px] font-medium">{$('proto.tab.maintenance')}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" variant="outline">
                      {$('proto.cp.installPanel')}
                    </Button>
                    <Button size="xs" variant="outline">
                      {$('proto.cp.reinstall')}
                    </Button>
                    <Button size="xs" variant="destructive">
                      <Trash2 className="size-3" />
                      {$('proto.cp.delete')}
                    </Button>
                  </div>
                  <p className="text-[10.5px] text-muted-foreground">{$('proto.cp.dangerHint')}</p>
                </div>
              </div>
            )}

            {nav === 'network' && (
              <FormGrid>
                <Field label={$('proto.field.domain')}>
                  <input className={INPUT_CLASS} defaultValue="mc.example.com" />
                </Field>
                <Field label={$('proto.field.publicPort')} hint={$('proto.cp.frpHint')}>
                  <div className="flex gap-1.5">
                    <input className={INPUT_CLASS} defaultValue="30001" />
                    <Button size="sm" variant="outline">
                      {$('proto.action.bind')}
                    </Button>
                  </div>
                </Field>
                <Field label="frp" wide hint={$('proto.cp.frpNode')}>
                  <input className={INPUT_CLASS} defaultValue="mc.example.com:30001" disabled />
                </Field>
              </FormGrid>
            )}

            {nav === 'players' && (
              <div className="grid max-w-[520px] gap-1.5">
                <Button size="sm" variant="outline" className="justify-start">
                  <Users className="size-3.5" />
                  {$('proto.instance.stats')}
                </Button>
                <Button size="sm" variant="outline" className="justify-start">
                  <ShieldAlert className="size-3.5" />
                  {$('proto.instance.bans')}
                </Button>
              </div>
            )}

            {nav === 'automation' && (
              <div className="grid max-w-[640px] gap-2">
                <div className="flex h-10 items-center gap-3 rounded-md border px-3 text-[12px]">
                  <span>{$('proto.field.autoRestart')}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">04:00</span>
                  <Switch defaultChecked size="sm" className="ml-auto" />
                </div>
                <div className="flex h-10 items-center gap-3 rounded-md border px-3 text-[12px]">
                  <span>{$('proto.field.dailyBackup')}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">0 */6 * * *</span>
                  <Switch defaultChecked size="sm" className="ml-auto" />
                </div>
              </div>
            )}

            {nav === 'backups' && (
              <div className="grid gap-2">
                <Button size="sm" className="w-fit">
                  <Archive className="size-3.5" />
                  {$('proto.quick.backup')}
                </Button>
                <div className="rounded-md border">
                  {MOCK_BACKUPS.slice(0, 3).map((b) => (
                    <div key={b.name} className="flex h-8 items-center gap-3 border-b px-3 text-[11.5px] last:border-b-0">
                      <span className="truncate font-mono">{b.name}</span>
                      <span className="ml-auto font-mono text-muted-foreground">{b.size}</span>
                      <span className="font-mono text-muted-foreground">{b.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-4">
          <span className="text-[11px] text-muted-foreground">{$('proto.cp.hint')}</span>
          <div className="ml-auto flex items-center gap-2">
            <DialogClose asChild>
              <Button size="sm" variant="outline">
                {$('proto.cp.cancel')}
              </Button>
            </DialogClose>
            <Button size="sm">{$('proto.cp.save')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
