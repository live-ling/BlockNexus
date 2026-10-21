// 原型屏 1：实例总览（2026-10-21 第三版）。
//
// 改动：列表/表格一律取消，只保留卡片；卡片内部不画分割线；
// 搜索/筛选/排序不再是常驻工具栏，改成右边缘竖标签打开的抽屉。

import { useMemo, useState, type ReactNode } from 'react';
import { Copy, Plus, RotateCw, Server } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { MOCK_INSTANCES, MOCK_SERVERS, type ProtoInstance, type ProtoServer, type ProtoStatus } from '../mock';
import { Bar, EmptyState, Pill, SearchInput, Select, type Tone } from '../proto-ui';
import { FilterDrawer, FilterField } from '../filter-drawer';
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

type Filter = 'all' | 'running' | 'stopped' | 'failed';
type Sort = 'name' | 'status' | 'players' | 'memory';

export function InstancesScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [serverId, setServerId] = useState('all');
  const [sort, setSort] = useState<Sort>('name');

  const running = MOCK_INSTANCES.filter((i) => i.status === 'running').length;

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return MOCK_INSTANCES.map((inst) => ({ inst, server: MOCK_SERVERS.find((s) => s.id === inst.serverId) }))
      .filter(({ inst }) => (filter === 'all' ? true : inst.status === filter))
      .filter(({ inst }) => (serverId === 'all' ? true : inst.serverId === serverId))
      .filter(({ inst, server }) =>
        !needle
          ? true
          : [inst.name, inst.note ?? '', inst.core, inst.version, inst.address ?? '', server?.name ?? '', server?.host ?? '']
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
      .sort((a, b) => {
        if (sort === 'players') return (b.inst.players ?? -1) - (a.inst.players ?? -1);
        if (sort === 'memory') return b.inst.memoryMB - a.inst.memoryMB;
        if (sort === 'status') return a.inst.status.localeCompare(b.inst.status);
        return a.inst.name.localeCompare(b.inst.name);
      });
  }, [q, filter, serverId, sort]);

  const reset = () => {
    setQ('');
    setFilter('all');
    setServerId('all');
    setSort('name');
  };

  const statusOptions: { value: Filter; label: string }[] = [
    { value: 'all', label: $('proto.filter.all') },
    { value: 'running', label: $('proto.filter.running') },
    { value: 'stopped', label: $('proto.filter.stopped') },
    { value: 'failed', label: $('proto.filter.failed') },
  ];

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.instances.title')}</h1>}
        subtitle={$('proto.instances.subtitle', MOCK_INSTANCES.length, running)}
        actions={
          <>
            <Button size="icon-sm" variant="ghost" title={$('proto.action.refresh')}>
              <RotateCw />
            </Button>
            <Button size="sm" onClick={() => onScreen('servers')}>
              <Plus className="size-3.5" />
              {$('proto.action.quickAdd')}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-5 pb-24">
        {items.length === 0 ? (
          <EmptyState
            title={$('proto.empty.noMatch')}
            hint={$('proto.empty.noMatchHint')}
            action={
              <Button size="sm" variant="outline" onClick={reset}>
                {$('proto.filter.reset')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
            {items.map(({ inst, server }) => (
              <InstanceCard
                key={`${inst.serverId}/${inst.name}`}
                inst={inst}
                server={server}
                onOpen={() => onScreen('instance')}
              />
            ))}
          </div>
        )}
      </div>

      <FilterDrawer>
        <div className="grid gap-4">
          <FilterField label={$('proto.filter.search')}>
            <SearchInput placeholder={$('proto.search.instances')} value={q} onChange={setQ} />
          </FilterField>

          <FilterField label={$('proto.col.status')}>
            <div className="grid grid-cols-2 gap-1.5">
              {statusOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setFilter(o.value)}
                  className={cn(
                    'h-8 rounded-md border text-[11.5px] transition-colors',
                    filter === o.value
                      ? 'border-foreground/20 bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </FilterField>

          <FilterField label={$('proto.col.server')}>
            <Select
              value={serverId}
              onChange={setServerId}
              className="w-full"
              options={[
                { value: 'all', label: $('proto.filter.allServers') },
                ...MOCK_SERVERS.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </FilterField>

          <FilterField label={$('proto.filter.sort')}>
            <Select
              value={sort}
              onChange={(v) => setSort(v as Sort)}
              className="w-full"
              options={[
                { value: 'name', label: $('proto.sort.name') },
                { value: 'status', label: $('proto.sort.status') },
                { value: 'players', label: $('proto.sort.players') },
                { value: 'memory', label: $('proto.sort.memory') },
              ]}
            />
          </FilterField>

          <div className="border-t pt-3">
            <Button size="sm" variant="outline" className="w-full" onClick={reset}>
              {$('proto.filter.reset')}
            </Button>
          </div>
        </div>
      </FilterDrawer>
    </>
  );
}

/** 卡片内的一行：左标签、右值；卡片内不再画分割线，靠行距分组 */
function Row({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <span className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('truncate', mono && 'font-mono')}>{children}</span>
    </span>
  );
}

/** 卡片左上角：实例图标；实例没有自定义图标时用服务器图标占位 */
function InstanceIcon({ icon }: { icon?: string }) {
  return (
    <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40 text-muted-foreground">
      {icon ? <img src={icon} alt="" className="size-full object-cover" /> : <Server className="size-3.5" />}
    </span>
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
  const memPct = Math.round((inst.memoryMB / Math.max(1, inst.memoryMaxMB)) * 100);

  return (
    <div
      onClick={onOpen}
      className="group grid cursor-pointer content-start gap-2.5 rounded-lg border bg-card p-3.5 text-left transition-colors hover:border-muted-foreground/40"
    >
      <div className="flex min-w-0 items-start gap-2">
        <InstanceIcon icon={inst.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <b className="truncate text-[13px] font-medium">{inst.name}</b>
            <Pill tone={st.tone}>{$(st.key)}</Pill>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">{inst.note ?? server?.name ?? '—'}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
        <Row label={$('proto.col.core')} mono>
          {inst.core} {inst.version}
        </Row>
        <Row label={$('proto.col.server')}>{server?.name ?? '—'}</Row>
        <Row label={$('proto.col.players')} mono>
          {inst.players ?? '—'}/{inst.maxPlayers}
        </Row>
        <Row label={$('proto.col.uptime')} mono>
          {inst.status === 'starting' ? $('proto.status.starting') : (inst.uptime ?? '—')}
        </Row>
        <Row label={$('proto.col.memory')}>
          <span className="flex items-center justify-end gap-1.5">
            <Bar value={memPct} tone={memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : 'ok'} />
            <span className="font-mono">
              {(inst.memoryMB / 1024).toFixed(1)}/{inst.memoryMaxMB / 1024}G
            </span>
          </span>
        </Row>
        <Row label={$('proto.field.port')} mono>
          {inst.port}
        </Row>
      </div>

      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span className="truncate font-mono">{inst.address ?? `${server?.host ?? ''}:${inst.port}`}</span>
        <button
          type="button"
          title={$('proto.action.copy')}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
        >
          <Copy className="size-3" />
        </button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {$('proto.action.open')}
        </Button>
      </div>
    </div>
  );
}
