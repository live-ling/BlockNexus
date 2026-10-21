// 原型屏 2：服务器列表（2026-10-21 第三版）。取消行式列表，只保留卡片；
// 筛选同样收进右侧抽屉；卡片里能放下 CPU/MEM/DISK 三条，就不再为了列宽裁掉磁盘。

import { useMemo, useState } from 'react';
import { Ellipsis, Plus, RotateCw, Settings } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { MOCK_SERVERS, type ProtoServer } from '../mock';
import { Bar, Dot, EmptyState, Pill, SearchInput, Select } from '../proto-ui';
import { FilterDrawer, FilterField } from '../filter-drawer';
import { PageHeader, type ProtoScreen } from '../shell';

type Sort = 'manual' | 'latency' | 'cpu';
type Online = 'all' | 'online' | 'offline';

export function ServersScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [q, setQ] = useState('');
  const [online, setOnline] = useState<Online>('all');
  const [sort, setSort] = useState<Sort>('manual');

  const onlineCount = MOCK_SERVERS.filter((s) => s.online).length;

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = MOCK_SERVERS.filter((s) => (online === 'all' ? true : online === 'online' ? s.online : !s.online)).filter(
      (s) => (!needle ? true : `${s.name} ${s.host} ${s.system}`.toLowerCase().includes(needle)),
    );
    if (sort === 'latency') return [...out].sort((a, b) => (a.latency ?? 9999) - (b.latency ?? 9999));
    if (sort === 'cpu') return [...out].sort((a, b) => b.cpu - a.cpu);
    return out;
  }, [q, online, sort]);

  const reset = () => {
    setQ('');
    setOnline('all');
    setSort('manual');
  };

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.servers.title')}</h1>}
        subtitle={$('proto.servers.subtitle', MOCK_SERVERS.length, onlineCount)}
        actions={
          <>
            <Button size="icon-sm" variant="ghost" title={$('proto.action.refresh')}>
              <RotateCw />
            </Button>
            <Button size="sm">
              <Plus className="size-3.5" />
              {$('proto.action.quickAdd')}
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-5 pb-24">
        {list.length === 0 ? (
          <EmptyState
            title={$('proto.empty.noServers')}
            hint={$('proto.empty.noServersHint')}
            action={
              <Button size="sm" variant="outline" onClick={reset}>
                {$('proto.filter.reset')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
            {list.map((s) => (
              <ServerCard key={s.id} server={s} onOpen={() => onScreen('server-settings')} />
            ))}
          </div>
        )}
      </div>

      <FilterDrawer>
        <div className="grid gap-4">
          <FilterField label={$('proto.filter.search')}>
            <SearchInput placeholder={$('proto.search.servers')} value={q} onChange={setQ} />
          </FilterField>

          <FilterField label={$('proto.col.status')}>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  ['all', $('proto.filter.all')],
                  ['online', $('proto.filter.online')],
                  ['offline', $('proto.filter.offline')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setOnline(value)}
                  className={cn(
                    'h-8 rounded-md border text-[11.5px] transition-colors',
                    online === value
                      ? 'border-foreground/20 bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </FilterField>

          <FilterField label={$('proto.filter.sort')}>
            <Select
              value={sort}
              onChange={(v) => setSort(v as Sort)}
              className="w-full"
              options={[
                { value: 'manual', label: $('proto.sort.manual') },
                { value: 'latency', label: $('proto.sort.latency') },
                { value: 'cpu', label: $('proto.sort.cpu') },
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

function AgentPill({ server }: { server: ProtoServer }) {
  if (server.installing !== undefined) {
    return <Pill tone="warn">{$('proto.group.installing', server.installing)}</Pill>;
  }
  return (
    <Pill tone={server.online ? 'ok' : 'idle'}>
      <Dot tone={server.online ? 'ok' : 'idle'} />
      {server.online ? `Agent ${server.agent}` : $('proto.filter.offline')}
    </Pill>
  );
}

/** 资源一行：标签 + 细条 + 数值，三行垂直排列（并排时三个进度条都太短，看不出差别） */
function Resource({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span className="w-8 shrink-0 tracking-wide text-muted-foreground">{label}</span>
      <Bar value={pct} tone={pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok'} className="min-w-0 flex-1" />
      <span className="w-14 shrink-0 text-right font-mono tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function ServerCard({ server, onOpen }: { server: ProtoServer; onOpen: () => void }) {
  const memPct = server.memTotal ? Math.round((server.memUsed / server.memTotal) * 100) : 0;

  return (
    <div
      onClick={onOpen}
      className="group grid cursor-pointer content-start gap-3 rounded-lg border bg-card p-3.5 text-left transition-colors hover:border-muted-foreground/40"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Dot tone={server.online ? 'ok' : 'idle'} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <b className="truncate text-[13px] font-medium">{server.name}</b>
            <AgentPill server={server} />
          </div>
          <p className="truncate font-mono text-[10.5px] text-muted-foreground">
            {server.host} · {server.system}
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Resource label="CPU" value={`${server.cpu}%`} pct={server.cpu} />
        <Resource label="MEM" value={`${server.memUsed}/${server.memTotal}G`} pct={memPct} />
        <Resource label="DISK" value={`${server.disk}%`} pct={server.disk} />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{$('proto.col.instances')} {server.instances}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="font-mono">{server.latency === null ? '—' : `${server.latency}ms`}</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="font-mono">Java {server.java}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
          >
            {$('proto.row.details')}
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={(e) => e.stopPropagation()} title={$('proto.row.settings')}>
            <Settings />
          </Button>
          <Button size="icon-xs" variant="ghost" onClick={(e) => e.stopPropagation()} title={$('proto.action.more')}>
            <Ellipsis />
          </Button>
        </span>
      </div>
    </div>
  );
}
