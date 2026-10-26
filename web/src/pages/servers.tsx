// 服务器列表页
//
// 视觉：`/proto` 第三版（卡片网格 + 右侧筛选抽屉）。卡片里的资源条只画真有的数据：
// Agent 资源快照（stats）没回来时，只显示系统信息，不拿假 CPU 占位。
//
// 交互保留原有能力：拖动排序（顺序持久化到面板）、点卡片进服务器详情、右上角快速添加。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical, Plus, RotateCw, Settings } from 'lucide-react';
import { cn } from 'cn';
import { QuickAddDialog } from '@/components/quick-add-dialog';
import { MaskedText } from '@/components/masked-text';
import { OsMark, RegionFlag } from '@/components/server-marks';
import { Button } from '@/components/ui/button';
import { FilterDrawer } from '@/components/layout/filter-drawer';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import {
  Bar,
  EmptyState,
  FilterChoices,
  FilterField,
  KV,
  SearchInput,
  Select,
  Surface,
  usageTone,
} from '@/components/layout/primitives';
import { AgentStatusPill } from '@/components/layout/status';
import { navigate } from '@/lib/router';
import {
  api,
  errText,
  fmtUptime,
  osLabel,
  timeago,
  type Me,
  type ServerSummary,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { regionLabel } from '@/lib/regions';

type OnlineFilter = 'all' | 'online' | 'offline';
type SortKey = 'manual' | 'latency' | 'memory';

export function ServersPage({
  me,
  servers,
  onAdd,
  onReorder,
}: {
  me: Me;
  servers: ServerSummary[];
  onAdd: (s: ServerSummary) => void;
  /** 拖动排序后回写全局列表（面板重启后仍保持顺序） */
  onReorder: (ids: string[]) => void;
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  // 拖动排序：draggingId 是被拖卡片，overId 是当前悬停目标（本地实时预排，松手才持久化）
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const base = order
    ? (order.map((id) => servers.find((s) => s.id === id)).filter(Boolean) as ServerSummary[])
    : servers;
  // 服务器列表在别处变化时（新增/删除）重置本地预排，避免残影
  const idsSig = servers.map((s) => s.id).join(',');
  const sigRef = useRef(idsSig);
  useEffect(() => {
    if (sigRef.current !== idsSig) {
      sigRef.current = idsSig;
      setOrder(null);
    }
  }, [idsSig]);
  // 在线时长每 30s 走动一次（仅驱动重渲染，时长本身由 onlineSince 实时计算）
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  // 筛选（纯客户端）：排序里的「手动」= 面板保存的顺序，不做任何额外排序
  const [q, setQ] = useState('');
  const [online, setOnline] = useState<OnlineFilter>('all');
  const [sort, setSort] = useState<SortKey>('manual');
  const resetFilters = () => {
    setQ('');
    setOnline('all');
    setSort('manual');
  };

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = base.filter((s) =>
      online === 'all' ? true : online === 'online' ? s.online && !s.installing : !s.online,
    );
    const matched = needle
      ? out.filter((s) =>
          [s.name, s.host, s.info?.hostname ?? '', s.info?.os ?? ''].join(' ').toLowerCase().includes(needle),
        )
      : out;
    if (sort === 'latency') {
      return [...matched].sort((a, b) => (a.latency ?? Number.MAX_SAFE_INTEGER) - (b.latency ?? Number.MAX_SAFE_INTEGER));
    }
    if (sort === 'memory') {
      const used = (s: ServerSummary) => s.stats?.memUsedMB ?? 0;
      return [...matched].sort((a, b) => used(b) - used(a));
    }
    return matched;
  }, [base, q, online, sort]);

  const move = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const ids = base.map((s) => s.id);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      setOrder(ids);
    },
    [base],
  );

  const commit = useCallback(async () => {
    if (!order) return;
    onReorder(order);
    try {
      await api('/servers/reorder', { method: 'POST', body: { ids: order } });
    } catch (e) {
      onReorder(servers.map((s) => s.id)); // 失败回滚为服务端顺序
      console.error($('servers.error.reorder') + errText(e));
    }
  }, [order, onReorder, servers]);

  const onlineCount = servers.filter((s) => s.online).length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader
        title={$('servers.title')}
        subtitle={servers.length > 0 ? $('ui.servers.subtitle', servers.length, onlineCount) : undefined}
        actions={
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              title={$('ui.action.refresh')}
              onClick={() => forceTick((n) => n + 1)}
            >
              <RotateCw />
            </Button>
            <Button size="sm" onClick={() => setQuickOpen(true)}>
              <Plus className="size-3.5" />
              {$('servers.quick')}
            </Button>
          </>
        }
      />

      <PageBody>
        {servers.length === 0 ? (
          <EmptyState title={$('servers.empty.title')} hint={$('servers.empty.hint')} />
        ) : list.length === 0 ? (
          <EmptyState
            title={$('ui.servers.noMatch')}
            hint={$('ui.servers.noMatchHint')}
            action={
              <Button size="sm" variant="outline" onClick={resetFilters}>
                {$('ui.filter.reset')}
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
            {list.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                dragging={draggingId === s.id}
                over={overId === s.id}
                onDragStart={(e) => {
                  setDraggingId(s.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // Firefox 需要 setData 才会真正开始拖拽
                  e.dataTransfer.setData('text/plain', s.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setOverId(null);
                  void commit();
                }}
                onDragOver={(e) => {
                  if (!draggingId || draggingId === s.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setOverId(s.id);
                }}
                onDragLeave={() => setOverId((cur) => (cur === s.id ? null : cur))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggingId) move(draggingId, s.id);
                  setOverId(null);
                }}
                onOpen={() => (draggingId ? undefined : navigate(`/server/${s.id}`))}
              />
            ))}
          </div>
        )}
      </PageBody>

      <FilterDrawer>
        <div className="grid gap-4">
          <FilterField label={$('ui.filter.search')}>
            <SearchInput placeholder={$('ui.search.servers')} value={q} onChange={setQ} />
          </FilterField>

          <FilterField label={$('ui.filter.status')}>
            <FilterChoices
              value={online}
              onChange={setOnline}
              columns={3}
              options={[
                { value: 'all', label: $('ui.filter.all') },
                { value: 'online', label: $('ui.filter.online') },
                { value: 'offline', label: $('ui.filter.offline') },
              ]}
            />
          </FilterField>

          <FilterField label={$('ui.filter.sort')}>
            <Select
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              className="w-full"
              options={[
                { value: 'manual', label: $('ui.sort.manual') },
                { value: 'latency', label: $('ui.sort.latency') },
                { value: 'memory', label: $('ui.sort.memory') },
              ]}
            />
          </FilterField>

          <div className="border-t pt-3">
            <Button size="sm" variant="outline" className="w-full" onClick={resetFilters}>
              {$('ui.filter.reset')}
            </Button>
          </div>
        </div>
      </FilterDrawer>

      <QuickAddDialog
        open={quickOpen}
        onOpenChange={setQuickOpen}
        panelPort={me.port}
        onCreated={(s) => onAdd(s)}
      />
    </div>
  );
}

/** 资源一行：标签 + 细条 + 数值 */
function Resource({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="flex items-center gap-2 text-[10.5px]">
      <span className="w-8 shrink-0 tracking-wide text-muted-foreground">{label}</span>
      <Bar value={pct} tone={usageTone(pct)} className="min-w-0 flex-1" />
      <span className="w-[86px] shrink-0 text-right font-mono whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}

function ServerCard({
  server: s,
  dragging,
  over,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  server: ServerSummary;
  dragging: boolean;
  over: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  const memPct = s.stats?.memTotalMB
    ? Math.round((s.stats.memUsedMB / s.stats.memTotalMB) * 100)
    : 0;
  const diskPct = s.stats?.disk ? Math.round(((s.stats.disk.totalGB - s.stats.disk.freeGB) / Math.max(1, s.stats.disk.totalGB)) * 100) : 0;

  return (
    <Surface
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onOpen}
      className={cn(
        'group grid cursor-pointer content-start gap-3 transition-colors hover:border-muted-foreground/40',
        dragging && 'opacity-50',
        over && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <OsMark distro={s.info?.distro} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <b className="truncate text-[13px] font-medium">{s.name}</b>
            {s.region && <RegionFlag region={s.region} title={regionLabel(s.region)} />}
            <span
              className="shrink-0 cursor-grab text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
              title={$('servers.drag.tooltip')}
              aria-hidden
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className="size-3.5" />
            </span>
          </div>
          <p className="truncate font-mono text-[10.5px] text-muted-foreground">
            <MaskedText value={s.host} />
            {s.info ? ` · ${s.info.distro?.name ?? osLabel(s.info.os)}` : ''}
          </p>
        </div>
        <AgentStatusPill online={s.online} installing={s.installing} />
      </div>

      {s.stats ? (
        <div className="grid gap-1.5">
          {/* CPU：老 Agent 没有这个字段时显示「—」，不拿 0% 冒充 */}
          <Resource
            label="CPU"
            value={typeof s.stats.cpuPct === 'number' ? `${s.stats.cpuPct}%` : '—'}
            pct={typeof s.stats.cpuPct === 'number' ? s.stats.cpuPct : 0}
          />
          <Resource
            label="MEM"
            value={`${(s.stats.memUsedMB / 1024).toFixed(1)}/${(s.stats.memTotalMB / 1024).toFixed(1)} GB`}
            pct={memPct}
          />
          {s.stats.disk && (
            <Resource
              label="DISK"
              value={`${(s.stats.disk.totalGB - s.stats.disk.freeGB).toFixed(0)}/${s.stats.disk.totalGB.toFixed(0)} GB`}
              pct={diskPct}
            />
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
          <KV label={$('servers.field.hostname')} mono>
            {s.info?.hostname ?? '—'}
          </KV>
          <KV label="Java" mono>
            {s.info ? (s.info.java.installed ? s.info.java.major : $('servers.java.notInstalled')) : '—'}
          </KV>
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{s.latency == null ? '—' : `${s.latency}ms`}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="truncate font-mono">
          {s.info ? `Java ${s.info.java.installed ? s.info.java.major : '—'}` : $('servers.agent.offline')}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <span className="truncate">
            {s.online && s.onlineSince
              ? $('servers.uptime', fmtUptime(s.onlineSince))
              : s.lastSeen
                ? $('servers.lastSeen', timeago(s.lastSeen))
                : $('servers.neverOnline')}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            title={$('ui.action.settings')}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/server/${s.id}/settings`);
            }}
          >
            <Settings />
          </Button>
        </span>
      </div>
    </Surface>
  );
}
