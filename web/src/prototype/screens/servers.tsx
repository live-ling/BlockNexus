// 原型屏 2：服务器列表。行式布局，资源用细条内联，拖动柄保留（手动排序）。
import { useMemo, useState } from 'react';
import { Ellipsis, GripVertical, LayoutGrid, Plus, RotateCw, Settings, Table2 } from 'lucide-react';
import { cn } from 'cn';
import { $ } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { MOCK_SERVERS, type ProtoServer } from '../mock';
import { Bar, Dot, EmptyState, Pill, SearchInput, Segmented, Select, Toolbar } from '../proto-ui';
import { PageHeader, type ProtoScreen } from '../shell';

// 窄窗口隐藏「系统」「延迟」两列（同上：少给信息，而不是把列压成窄条）
const COLS =
  'grid grid-cols-[16px_minmax(140px,1.2fr)_minmax(100px,0.85fr)_minmax(170px,1.3fr)_52px_80px] items-center gap-2 px-3 xl:grid-cols-[16px_minmax(150px,1.2fr)_minmax(104px,0.85fr)_minmax(140px,1fr)_minmax(196px,1.3fr)_60px_52px_80px] xl:gap-3';

type Sort = 'manual' | 'latency' | 'cpu';

export function ServersScreen({ onScreen }: { onScreen: (s: ProtoScreen) => void }) {
  const [q, setQ] = useState('');
  const [online, setOnline] = useState<'all' | 'online' | 'offline'>('all');
  const [sort, setSort] = useState<Sort>('manual');
  const [view, setView] = useState<'table' | 'cards'>('table');

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = MOCK_SERVERS.filter((s) => (online === 'all' ? true : online === 'online' ? s.online : !s.online)).filter(
      (s) => (!needle ? true : `${s.name} ${s.host} ${s.system}`.toLowerCase().includes(needle)),
    );
    if (sort === 'latency') return [...out].sort((a, b) => (a.latency ?? 9999) - (b.latency ?? 9999));
    if (sort === 'cpu') return [...out].sort((a, b) => b.cpu - a.cpu);
    return out;
  }, [q, online, sort]);

  const onlineCount = MOCK_SERVERS.filter((s) => s.online).length;

  return (
    <>
      <PageHeader
        title={<h1 className="truncate text-[13px] font-semibold">{$('proto.servers.title')}</h1>}
        subtitle={$('proto.servers.subtitle', MOCK_SERVERS.length, onlineCount)}
        actions={
          <Button size="sm">
            <Plus className="size-3.5" />
            {$('proto.action.quickAdd')}
          </Button>
        }
      />

      <Toolbar>
        <SearchInput className="w-60" placeholder={$('proto.search.servers')} value={q} onChange={setQ} />
        <Segmented<'all' | 'online' | 'offline'>
          value={online}
          onChange={setOnline}
          options={[
            { value: 'all', label: $('proto.filter.all') },
            { value: 'online', label: $('proto.filter.online') },
            { value: 'offline', label: $('proto.filter.offline') },
          ]}
        />
        <Select
          ariaLabel={$('proto.sort.manual')}
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          options={[
            { value: 'manual', label: $('proto.sort.manual') },
            { value: 'latency', label: $('proto.sort.latency') },
            { value: 'cpu', label: $('proto.sort.cpu') },
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
        {list.length === 0 ? (
          <EmptyState title={$('proto.empty.noServers')} hint={$('proto.empty.noServersHint')} />
        ) : view === 'table' ? (
          <div>
            <div className={cn(COLS, 'sticky top-0 z-10 h-7 border-b bg-background/95 text-[11px] text-muted-foreground backdrop-blur')}>
              <span />
              <span>{$('proto.col.server')}</span>
              <span>{$('proto.col.agent')}</span>
              <span className="hidden xl:block">{$('proto.col.system')}</span>
              <span>{$('proto.col.resources')}</span>
              <span className="hidden text-right xl:block">{$('proto.col.latency')}</span>
              <span className="text-right">{$('proto.col.instances')}</span>
              <span className="text-right">{$('proto.col.actions')}</span>
            </div>
            {list.map((s) => (
              <ServerRow key={s.id} server={s} onOpen={() => onScreen('server-settings')} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2 p-3">
            {list.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onScreen('server-settings')}
                className="grid gap-1.5 rounded-lg border bg-card p-2.5 text-left hover:border-muted-foreground/40"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Dot tone={s.online ? 'ok' : 'idle'} />
                  <b className="truncate text-[12.5px] font-medium">{s.name}</b>
                  <span className="ml-auto">
                    <AgentPill server={s} />
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
                  <span className="truncate">{s.host}</span>
                  <span className="truncate text-right">{s.system}</span>
                  <span>CPU {s.cpu}%</span>
                  <span className="text-right">
                    {s.memUsed}/{s.memTotal}G
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function AgentPill({ server }: { server: ProtoServer }) {
  if (server.installing !== undefined) {
    return (
      <Pill tone="warn">
        {$('proto.group.installing', server.installing)}
      </Pill>
    );
  }
  return (
    <Pill tone={server.online ? 'ok' : 'idle'}>
      <Dot tone={server.online ? 'ok' : 'idle'} />
      {server.online ? `Agent ${server.agent}` : $('proto.filter.offline')}
    </Pill>
  );
}

function ServerRow({ server, onOpen }: { server: ProtoServer; onOpen: () => void }) {
  const memPct = server.memTotal ? Math.round((server.memUsed / server.memTotal) * 100) : 0;
  return (
    <div
      onClick={onOpen}
      className={cn(COLS, 'group h-[34px] cursor-pointer border-b border-border/50 text-[12px] hover:bg-muted/40')}
    >
      <span className="flex justify-center text-muted-foreground/50">
        <GripVertical className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col justify-center leading-tight">
        <span className="flex min-w-0 items-center gap-1.5">
          <b className="truncate font-medium">{server.name}</b>
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">{server.host}</span>
      </span>
      <span>
        <AgentPill server={server} />
      </span>
      <span className="hidden truncate text-[11.5px] text-muted-foreground xl:block">{server.system}</span>
      <span className="flex items-center gap-3 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="text-[9.5px] tracking-wide">CPU</span>
          <Bar value={server.cpu} tone={server.cpu > 85 ? 'bad' : server.cpu > 65 ? 'warn' : 'ok'} className="w-7" />
          <span className="w-6 text-right font-mono tabular-nums text-foreground">{server.cpu}%</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9.5px] tracking-wide">MEM</span>
          <Bar value={memPct} tone={memPct > 85 ? 'bad' : memPct > 65 ? 'warn' : 'ok'} className="w-7" />
          <span className="font-mono tabular-nums text-foreground">
            {server.memUsed}/{server.memTotal}G
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9.5px] tracking-wide">DISK</span>
          <Bar value={server.disk} tone={server.disk > 90 ? 'bad' : server.disk > 75 ? 'warn' : 'ok'} className="w-7" />
          <span className="w-6 text-right font-mono tabular-nums text-foreground">{server.disk}%</span>
        </span>
      </span>
      <span className="hidden text-right font-mono text-[11px] tabular-nums text-muted-foreground xl:block">
        {server.latency === null ? '—' : `${server.latency}ms`}
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{server.instances}</span>
      <span className="flex items-center justify-end gap-1">
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
  );
}
