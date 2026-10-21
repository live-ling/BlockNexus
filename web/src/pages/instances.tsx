// 实例总览：默认落地页。所有服务器的所有游戏实例按服务器分组展示。
//
// 视觉：`/proto` 第三版（卡片网格 + 右侧筛选抽屉，见 docs/frontend-redesign-design.md）。
// 交互仍是老的：不在此处启停实例（避免在「所有实例平铺」的大视野里误操作），
// 点卡片进实例详情页。
//
// 数据：复用 GET /servers/:id/instances 与 /servers/:id/players。
// 离线/安装中的服务器不发出请求（它们一定会失败），分组小标题上挂 Agent 状态徽章。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RotateCw, Server } from 'lucide-react';
import { QuickAddDialog } from '@/components/quick-add-dialog';
import { Button } from '@/components/ui/button';
import { FilterDrawer } from '@/components/layout/filter-drawer';
import { InstanceCard } from '@/components/layout/instance-card';
import { PageBody, PageHeader } from '@/components/layout/page-header';
import { EmptyState, FilterChoices, FilterField, SearchInput, Select, Surface } from '@/components/layout/primitives';
import { AgentStatusPill } from '@/components/layout/status';
import { navigate } from '@/lib/router';
import {
  api,
  errText,
  type Instance,
  type Me,
  type PlayersSnapshot,
  type ServerSummary,
} from '@/lib/api';
import { $ } from '@/lib/i18n';
import { subscribeSSE } from '@/lib/sse';
import {
  buildInstanceGroups,
  instanceKey,
  playersOf,
  summarizeGroups,
  type InstanceGroup,
  type ServerInstanceData,
} from '@/lib/instances';


// 同时发起的拉数请求上限。超过就排队——每台服务器 2 个接口（instances + players），
// 100 台 = 200 个并发请求会瞬间打满面板事件循环和 AgentHub 的 WS 帧队列。
// 6 已经能覆盖绝大多数单机代理面板；触达上限只是轻微的等待延迟，不会让 UI 卡住。
const FETCH_CONCURRENCY = 6;

type StatusFilter = 'all' | 'running' | 'stopped' | 'failed';
type SortKey = 'name' | 'status' | 'players' | 'memory';

/** 搜索索引：实例名/备注/地址/核心/版本 + 服务器名/主机（与原型一致，一处拼装） */
function searchText(server: ServerSummary, inst: Instance): string {
  return [inst.name, inst.note, inst.address, inst.source, inst.version, server.name, server.host]
    .join(' ')
    .toLowerCase();
}

export function InstancesPage({
  me,
  servers,
  onAdd,
}: {
  me: Me;
  servers: ServerSummary[];
  onAdd: (s: ServerSummary) => void;
}) {
  // 每台服务器的拉数结果。key 是 serverId；找不到就当 null（还没拉过 / 拉失败）。
  const [data, setData] = useState<Record<string, ServerInstanceData>>({});
  const [quickOpen, setQuickOpen] = useState(false);
  // 顺序：与 servers prop 完全对齐；不引入第二份排序，否则拖动排序会和总览对不上。
  const groups = buildInstanceGroups(servers, data);
  const summary = summarizeGroups(groups);
  // 强制每 30s 走一遍重渲染（让 fmtUptime 的「运行时间」走动；与 servers 页同款）
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  // 筛选（纯客户端）：原型里这些都在右侧抽屉里，不占常驻宽度
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [serverId, setServerId] = useState('all');
  const [sort, setSort] = useState<SortKey>('name');
  const filtering = !!q.trim() || status !== 'all' || serverId !== 'all';
  const resetFilters = () => {
    setQ('');
    setStatus('all');
    setServerId('all');
    setSort('name');
  };

  // 拉单台：成功写 instances + players，失败写 error 但不抛——
  // 单台失败不该让整个总览挂掉；卡片小标题里的徽章 + 错误文案足以告知用户。
  const fetchOne = useCallback(
    async (server: ServerSummary): Promise<void> => {
      if (!server.online || server.installing) {
        // 离线/安装中：不必发请求（必然 400 / 404），写 null 让 UI 显示离线态
        setData((cur) => ({ ...cur, [server.id]: { instances: null, players: {} } }));
        return;
      }
      try {
        const [instances, players] = await Promise.all([
          api<Instance[]>(`/servers/${server.id}/instances`),
          api<PlayersSnapshot>(`/servers/${server.id}/players`).catch(() => ({} as PlayersSnapshot)),
        ]);
        setData((cur) => ({ ...cur, [server.id]: { instances, players } }));
      } catch (e) {
        // 静默失败：单台拉不到不该弹 toast 打断用户——那个分组的提示卡里已经写明原因
        setData((cur) => ({
          ...cur,
          [server.id]: { instances: null, players: {}, error: errText(e) },
        }));
      }
    },
    [],
  );

  // 并发受控地拉数。整体走完才允许下一轮触发——
  // 在 useEffect 依赖里用「拉到第几台」是常见的死循环源（每次状态更新都重起一轮），
  // 这里用一个 ref 把「正在拉」的标记记下来。
  const fetchingRef = useRef<Promise<void> | null>(null);
  const fetchAll = useCallback(
    async (targets: ServerSummary[]): Promise<void> => {
      if (!targets.length) return;
      if (fetchingRef.current) {
        // 已有轮次在跑：本轮直接跟它，不重起——避免页面挂载/状态事件竞速下的重复拉数
        return fetchingRef.current;
      }
      const run = async () => {
        let cursor = 0;
        const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, targets.length) }, async () => {
          while (cursor < targets.length) {
            const s = targets[cursor++];
            if (s) await fetchOne(s);
          }
        });
        await Promise.all(workers);
      };
      const p = run().finally(() => {
        fetchingRef.current = null;
      });
      fetchingRef.current = p;
      return p;
    },
    [fetchOne],
  );

  // 读最新值但不参与依赖的 ref。
  // 为什么需要：servers 是 prop、data 是自己的 state，两者都会频繁换新身份。
  // 把它们直接放进 effect 依赖会让 SSE 订阅与 20s 定时器反复销毁重建
  // （期间到达的事件还会被漏掉、定时器甚至可能永远跑不到第一次触发）。
  // 下面几处只关心「回调真正执行的那一刻，当前是什么状态」。
  const serversRef = useRef<ServerSummary[]>(servers);
  serversRef.current = servers;
  const dataRef = useRef<Record<string, ServerInstanceData>>({});
  dataRef.current = data;
  /** 该服务器是否还需要拉实例清单：在线、非安装中，且手里没有可用清单 */
  const needsFetch = (s: ServerSummary) => s.online && !s.installing && !dataRef.current[s.id]?.instances;

  // 初次挂载 + 服务器清单变化时补拉。
  // 只拉「还没有数据的」——已在手里的不重复拉；被移除的服务器由 buildInstanceGroups
  // 按 servers 过滤掉，不需要在这里清理。
  const sig = servers.map((s) => `${s.id}:${s.online}:${s.installing}`).join('|');
  const sigRef = useRef('');
  useEffect(() => {
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    void fetchAll(servers.filter(needsFetch));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // SSE：按台增量刷新。
  //
  // ⚠ 用 serversRef 读清单而不是把 servers 放进依赖：servers 是 prop，
  //   任何一次 status/latency 推送都会给它一个新数组身份 → effect 反复退订重订，
  //   期间到达的事件会被漏掉。这里只需要「事件到达那一刻的服务器对象」。
  useEffect(() => {
    const find = (id: string) => serversRef.current.find((x) => x.id === id);
    return subscribeSSE((e) => {
      // hello 心跳与面板自更新（panel-update）都没有 serverId；带 serverId 的事件才会走到这里
      if (e.type === 'hello' || e.type === 'panel-update') return;
      const id = e.serverId;
      if (e.type === 'status') {
        const s = find(id);
        if (!s) return;
        if (e.status === 'online') void fetchOne(s);
        else setData((cur) => ({ ...cur, [id]: { instances: null, players: {} } }));
        return;
      }
      if (e.type === 'agent-event') {
        // 这几类事件都意味着「实例清单可能有变」：单台重拉即可
        if (
          e.event === 'instance.updated' ||
          e.event === 'hi' ||
          e.event === 'java.updated' ||
          e.event === 'install.progress'
        ) {
          const s = find(id);
          if (s && s.online) void fetchOne(s);
          return;
        }
      }
      if ((e.type === 'install' || e.type === 'uninstall') && e.done) {
        const s = find(id);
        if (s) void fetchOne(s);
      }
    });
  }, [fetchOne]);

  // 20 秒轮询：① 刷运行中实例的玩家数（Agent 端 SLP 查询，与 server-detail 同节奏）；
  //            ② 重试还没拿到清单的在线服务器。
  //
  // ② 是必要的：拉数失败（Agent 忙/超时）时该分组会停在错误态，
  //    而「重试」不能只靠 SSE——那台服务器之后可能一直没有任何事件，
  //    页面就会永远显示错误提示。轮询给了一个确定性的自愈路径。
  //
  // ⚠ 同理不依赖 groups：groups 每次 setData 都是新数组，放进依赖会让 interval
  //   被反复销毁重建，很可能永远跑不到第一次触发。
  useEffect(() => {
    const tick = () => {
      const retry: ServerSummary[] = [];
      for (const s of serversRef.current) {
        if (!s.online || s.installing) continue;
        if (needsFetch(s)) {
          retry.push(s); // 还没有清单（首次失败/尚未拉过）→ 重试
          continue;
        }
        // 有清单的只刷玩家数
        api<PlayersSnapshot>(`/servers/${s.id}/players`)
          .then((players) => {
            setData((cur) => {
              const curG = cur[s.id];
              // 还没拉到实例数据的别只更新 players（会渲染出玩家数但没有实例卡片）
              if (!curG || !curG.instances) return cur;
              return { ...cur, [s.id]: { ...curG, players } };
            });
          })
          .catch(() => {});
      }
      if (retry.length) void fetchAll(retry);
    };
    const t = window.setInterval(tick, 20000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手动刷新：清掉本地清单再重拉（离线/安装中的仍不发请求）
  const refresh = () => {
    setData({});
    void fetchAll(serversRef.current.filter((s) => s.online && !s.installing));
  };

  // 筛选 + 排序（客户端）。不可达分组只在完全没有筛选条件时保留，
  // 否则「筛运行中」会连带列出根本没连上的服务器。
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: InstanceGroup[] = [];
    for (const g of groups) {
      if (serverId !== 'all' && g.server.id !== serverId) continue;
      if (!g.instances) {
        if (!filtering) out.push(g);
        continue;
      }
      const list = g.instances
        .filter((i) => status === 'all' || i.status === status)
        .filter((i) => !needle || searchText(g.server, i).includes(needle));
      if (!list.length) continue;
      out.push({ ...g, instances: sortInstances(list, g.players, sort) });
    }
    return out;
    // groups 每轮 setData 都是新数组，依赖它本身没问题：这里只做纯计算
  }, [groups, q, status, serverId, sort, filtering]);

  const openInstance = (serverIdTo: string, name: string) =>
    navigate(`/server/${serverIdTo}/instance/${encodeURIComponent(name)}`);

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: $('ui.filter.all') },
    { value: 'running', label: $('ui.filter.running') },
    { value: 'stopped', label: $('ui.filter.stopped') },
    { value: 'failed', label: $('ui.filter.failed') },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <PageHeader
        title={$('instances.title')}
        subtitle={
          servers.length > 0 ? (
            <>
              {$('instances.summary', summary.total, summary.running)}
              {summary.unreachable > 0 && <span className="ml-1.5">{$('instances.unreachable', summary.unreachable)}</span>}
            </>
          ) : undefined
        }
        actions={
          <>
            <Button size="icon-sm" variant="ghost" title={$('ui.action.refresh')} onClick={refresh}>
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
          <EmptyState title={$('instances.empty.noServers')} hint={$('instances.empty.noServersHint')} />
        ) : summary.total === 0 && summary.unreachable === servers.length ? (
          // 全部离线：只展示「等待重连」的空态，不让离线分组的小标题铺满整页
          <EmptyState title={$('instances.empty.allOffline')} hint={$('instances.empty.allOfflineHint')} />
        ) : summary.total === 0 ? (
          // 都在线但都还没建实例
          <EmptyState title={$('instances.empty.noInstances')} hint={$('instances.empty.noInstancesHint')} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={$('ui.empty.noMatch')}
            hint={$('ui.empty.noMatchHint')}
            action={
              <Button size="sm" variant="outline" onClick={resetFilters}>
                {$('ui.filter.reset')}
              </Button>
            }
          />
        ) : (
          <div className="grid gap-5">
            {visible.map((g) => (
              <ServerGroup key={g.server.id} group={g} onOpen={openInstance} />
            ))}
          </div>
        )}
      </PageBody>

      <FilterDrawer>
        <div className="grid gap-4">
          <FilterField label={$('ui.filter.search')}>
            <SearchInput placeholder={$('ui.search.instances')} value={q} onChange={setQ} />
          </FilterField>

          <FilterField label={$('ui.filter.status')}>
            <FilterChoices value={status} options={statusOptions} onChange={setStatus} />
          </FilterField>

          <FilterField label={$('ui.col.server')}>
            <Select
              value={serverId}
              onChange={setServerId}
              className="w-full"
              options={[
                { value: 'all', label: $('ui.filter.allServers') },
                ...servers.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          </FilterField>

          <FilterField label={$('ui.filter.sort')}>
            <Select
              value={sort}
              onChange={(v) => setSort(v as SortKey)}
              className="w-full"
              options={[
                { value: 'name', label: $('ui.sort.name') },
                { value: 'status', label: $('ui.sort.status') },
                { value: 'players', label: $('ui.sort.players') },
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

/** 排序是纯客户端行为：不改变 groups 的顺序（服务器分组顺序仍由服务器列表决定） */
function sortInstances(
  list: Instance[],
  players: PlayersSnapshot,
  sort: SortKey,
): Instance[] {
  const arr = [...list];
  if (sort === 'players') {
    return arr.sort((a, b) => (playersOf(players, b.name)?.online ?? -1) - (playersOf(players, a.name)?.online ?? -1));
  }
  if (sort === 'memory') return arr.sort((a, b) => b.memoryMB - a.memoryMB);
  if (sort === 'status') return arr.sort((a, b) => a.status.localeCompare(b.status));
  return arr.sort((a, b) => a.name.localeCompare(b.name));
}

function ServerGroup({
  group,
  onOpen,
}: {
  group: InstanceGroup;
  onOpen: (serverId: string, name: string) => void;
}) {
  const { server, instances, players, error } = group;
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
        <button
          type="button"
          onClick={() => navigate(`/server/${server.id}`)}
          className="text-[13px] font-semibold hover:underline"
          title={server.host}
        >
          {server.name}
        </button>
        <AgentStatusPill online={server.online} installing={server.installing} />
        {instances !== null && (
          <span className="text-[11px] text-muted-foreground">{$('instances.group.count', instances.length)}</span>
        )}
      </div>

      {!instances ? (
        <Surface className="py-6 text-center text-[11.5px] text-muted-foreground">
          {error
            ? $('instances.error.load', error)
            : server.installing
              ? $('servers.agent.installing')
              : $('instances.offlineNote')}
        </Surface>
      ) : instances.length === 0 ? (
        <Surface className="py-6 text-center text-[11.5px] text-muted-foreground">
          {$('instances.empty.noInstances')}
        </Surface>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
          {instances.map((inst) => (
            <InstanceCard
              key={instanceKey(server.id, inst.name)}
              server={server}
              inst={inst}
              players={playersOf(players, inst.name)}
              onOpen={() => onOpen(server.id, inst.name)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
