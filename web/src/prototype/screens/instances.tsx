// 原型屏 1：实例总览。密集表格 + 分组标题行；卡片视图作为备选。
// 这里只验证排版与信息层级，不做任何请求。

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Ellipsis, LayoutGrid, Plus, RotateCw, Table2 } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { MOCK_INSTANCES, MOCK_SERVERS, type ProtoInstance, type ProtoServer, type ProtoStatus } from '../mock';
import { Bar, Dot, EmptyState, Pill, SearchInput, Segmented, Select, Toolbar, type Tone } from '../proto-ui';
import { PageHeader, type ProtoScreen } from '../shell';

const STATUS: Record<
  ProtoStatus,
  { tone: Tone; key: 'proto.status.running' | 'proto.status.stopped' | 'proto.status.starting' | 'proto.status.failed' }
> = {
  running: { tone: 'ok', key: 'proto.status.running' },
  stopped: { tone: 'idle', key: 'proto.status.stopped' },
  starting: { tone: 'warn', key: 'proto.status.starting' },
  failed: { tone: 'bad', key: 'proto.status.failed' },
};

// 列模板：窄窗口（<1280）先隐藏「核心」「地址」两列，避免 960×640 的外壳最小尺寸出现横向滚动。
// 这与设计稿「横屏优先、窄屏做减法」一致——不是把列压窄，而是少给信息。
const COLS =
  'grid grid-cols-[14px_minmax(120px,1.3fr)_minmax(88px,0.8fr)_60px_104px_76px_80px] items-center gap-2 px-3 xl:grid-cols-[14px_minmax(140px,1.3fr)_minmax(96px,0.8fr)_minmax(118px,1fr)_64px_112px_76px_minmax(112px,0.9fr)_84px] xl:gap-3';

type Filter = 'all' | 'running' | 'stopped' | 'failed';
type Sort = 'name' | 'status' | 'players' | 'memory';

export function InstancesScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [serverFilter, setServerFilter] = useState('all');
  const [sort, setSort] = useState<Sort>('name');
  const [view, setView] = useState<'table' | 'cards'>('table');
  const [collapsed, setCollapsed] = useState<string[]>([]);

  const total = MOCK_INSTANCES.length;
  const running = MOCK_INSTANCES.filter((i) => i.status === 'running').length;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return MOCK_SERVERS.map((server) => {
      const all = MOCK_INSTANCES.filter((i) => i.serverId === server.id);
      const list = all
        .filter((i) => (filter === 'all' ? true : i.status === filter))
        .filter((i) => (serverFilter === 'all' ? true : i.serverId === serverFilter))
        .filter((i) =>
          !needle
            ? true
            : [i.name, i.note ?? '', i.core, i.version, i.address ?? '', server.name, server.host]
                .join(' ')
                .toLowerCase()
                .includes(needle),
        )
        .sort((a, b) => {
          if (sort === 'players') return (b.players ?? -1) - (a.players ?? -1);
          if (sort === 'memory') return b.memoryMB - a.memoryMB;
          if (sort === 'status') return a.status.localeCompare(b.status);
          return a.name.localeCompare(b.name);
        });
      return { server, list, total: all.length };
    }).filter((g) => (g.server.online ? g.list.length > 0 : filter === 'all' && !needle));
  }, [q, filter, serverFilter, sort]);

  const toggle = (id: string) =>
    setCollapsed((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.instances.title')}</h1>}
        subtitle={$('proto.instances.subtitle', total, running)}
        actions={
          <Button size="sm" onClick={() => onScreen('servers')}>
            <Plus className="size-3.5" />
            {$('proto.action.quickAdd')}
          </Button>
        }
      />

      <Toolbar>
        <SearchInput className="w-64" placeholder={$('proto.search.instances')} value={q} onChange={setQ} />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: $('proto.filter.all') },
            { value: 'running', label: $('proto.filter.running') },
            { value: 'stopped', label: $('proto.filter.stopped') },
            { value: 'failed', label: $('proto.filter.failed') },
          ]}
        />
        <Select
          ariaLabel={$('proto.filter.allServers')}
          value={serverFilter}
          onChange={setServerFilter}
          options={[
            { value: 'all', label: $('proto.filter.allServers') },
            ...MOCK_SERVERS.map((s) => ({ value: s.id, label: s.name })),
          ]}
        />
        <Select
          ariaLabel={$('proto.sort.name')}
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          options={[
            { value: 'name', label: $('proto.sort.name') },
            { value: 'status', label: $('proto.sort.status') },
            { value: 'players', label: $('proto.sort.players') },
            { value: 'memory', label: $('proto.sort.memory') },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <Segmented<'table' | 'cards'>
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: $('proto.view.table'), icon: <Table2 className="size-3.5" /> },
              { value: 'cards', label: $('proto.view.cards'), icon: <LayoutGrid className="size-3.5" /> },
            ]}
          />
          <Button size="icon-xs" variant="ghost" title={$('proto.action.refresh')}>
            <RotateCw />
          </Button>
        </div>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <EmptyState
            title={$('proto.empty.noMatch')}
            hint={$('proto.empty.noMatchHint')}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setQ('');
                  setFilter('all');
                  setServerFilter('all');
                }}
              >
                {$('proto.filter.all')}
              </Button>
            }
          />
        ) : view === 'table' ? (
          <div>
            <div
              className={cn(
                COLS,
                'sticky top-0 z-10 h-7 border-b bg-background/95 text-[11px] text-muted-foreground backdrop-blur',
              )}
            >
              <span />
              <span>{$('proto.col.instance')}</span>
              <span>{$('proto.col.server')}</span>
              <span className="hidden xl:block">{$('proto.col.core')}</span>
              <span className="text-right">{$('proto.col.players')}</span>
              <span>{$('proto.col.memory')}</span>
              <span className="text-right">{$('proto.col.uptime')}</span>
              <span className="hidden xl:block">{$('proto.col.address')}</span>
              <span className="text-right">{$('proto.col.actions')}</span>
            </div>

            {groups.map(({ server, list }) => {
              const open = !collapsed.includes(server.id);
              return (
                <section key={server.id}>
                  <GroupRow server={server} count={list.length} open={open} onToggle={() => toggle(server.id)} />
                  {open &&
                    (server.online ? (
                      list.map((inst) => (
                        <InstanceRow
                          key={`${inst.serverId}/${inst.name}`}
                          inst={inst}
                          server={server}
                          onOpen={() => onScreen('instance')}
                        />
                      ))
                    ) : (
                      <div className="flex h-[30px] items-center gap-2 border-b border-border/50 px-3 pl-9 text-[11.5px] text-muted-foreground">
                        <Dot tone="idle" />
                        {server.installing !== undefined
                          ? $('proto.group.installing', server.installing)
                          : $('proto.group.waiting')}
                      </div>
                    ))}
                </section>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-2 p-3">
            {groups.flatMap(({ list }) =>
              list.map((inst) => (
                <InstanceCard
                  key={`${inst.serverId}/${inst.name}`}
                  inst={inst}
                  server={MOCK_SERVERS.find((s) => s.id === inst.serverId)}
                  onOpen={() => onScreen('instance')}
                />
              )),
            )}
          </div>
        )}
      </div>
    </>
  );
}

function GroupRow({
  server,
  count,
  open,
  onToggle,
}: {
  server: ProtoServer;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-2 border-b border-border/60 bg-muted/30 px-3">
      <button
        type="button"
        onClick={onToggle}
        className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      <span className="truncate text-[12px] font-medium">{server.name}</span>
      <Pill tone={server.online ? 'ok' : 'idle'}>
        <Dot tone={server.online ? 'ok' : 'idle'} />
        {server.online ? `Agent ${server.agent}` : $('proto.group.offline')}
      </Pill>
      <span className="font-mono text-[10.5px] text-muted-foreground">{server.host}</span>
      <span className="ml-auto text-[10.5px] text-muted-foreground">{$('proto.group.count', count)}</span>
    </div>
  );
}

function InstanceRow({
  inst,
  server,
  onOpen,
}: {
  inst: ProtoInstance;
  server: ProtoServer;
  onOpen: () => void;
}) {
  const st = STATUS[inst.status];
  const memPct = Math.round((inst.memoryMB / Math.max(1, inst.memoryMaxMB)) * 100);
  return (
    <div
      onClick={onOpen}
      className={cn(COLS, 'group h-[30px] cursor-pointer border-b border-border/50 text-[12px] hover:bg-muted/40')}
    >
      <span className="flex justify-center">
        <Dot tone={st.tone} />
      </span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <b className="truncate font-medium">{inst.name}</b>
        {inst.note && <span className="truncate text-[10.5px] text-muted-foreground/80">{inst.note}</span>}
      </span>
      <span className="truncate text-[11.5px] text-muted-foreground">{server.name}</span>
      <span className="hidden truncate font-mono text-[11px] text-muted-foreground xl:block">
        {inst.core} {inst.version}
      </span>
      <span
        className={cn(
          'text-right font-mono text-[11.5px] tabular-nums',
          inst.status === 'running' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        )}
      >
        {inst.players ?? '—'}/{inst.maxPlayers}
      </span>
      <span className="flex items-center gap-1.5">
        <Bar value={memPct} tone={memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : 'ok'} />
        <span className="font-mono text-[11px] tabular-nums">
          {(inst.memoryMB / 1024).toFixed(1)}/{inst.memoryMaxMB / 1024}G
        </span>
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {inst.status === 'starting' ? $('proto.status.starting') : (inst.uptime ?? '—')}
      </span>
      <span className="hidden min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground xl:flex">
        <span className="truncate">{inst.address ?? `:${inst.port}`}</span>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title={$('proto.action.copy')}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Copy className="size-3" />
        </button>
      </span>
      <span className="flex items-center justify-end gap-1">
        <Button
          size="xs"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {$('proto.action.open')}
        </Button>
        <Button size="icon-xs" variant="ghost" onClick={(e) => e.stopPropagation()} title={$('proto.action.more')}>
          <Ellipsis />
        </Button>
      </span>
    </div>
  );
}

function InstanceCard({
  inst,
  server,
  onOpen,
}: {
  inst: ProtoInstance;
  server?: ProtoServer;
  onOpen: () => void;
}) {
  const st = STATUS[inst.status];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid gap-1.5 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-muted-foreground/40"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Dot tone={st.tone} />
        <b className="truncate text-[12.5px] font-medium">{inst.name}</b>
        <span className="ml-auto">
          <Pill tone={st.tone}>{$(st.key)}</Pill>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <span className="truncate text-muted-foreground">{server?.name}</span>
        <span className="truncate text-right font-mono">
          {inst.core} {inst.version}
        </span>
        <span className="font-mono tabular-nums">
          {inst.players ?? '—'}/{inst.maxPlayers}
        </span>
        <span className="truncate text-right font-mono text-muted-foreground">{inst.uptime ?? '—'}</span>
      </div>
      <div className="flex items-center gap-2 border-t pt-1.5 font-mono text-[10.5px] text-muted-foreground">
        <span className="truncate">{inst.address ?? `:${inst.port}`}</span>
        <span className="ml-auto shrink-0">{inst.memoryMB / 1024}G</span>
      </div>
    </button>
  );
}
