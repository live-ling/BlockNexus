// 实例总览：默认落地页。所有服务器的所有游戏实例按服务器分组展示。
//
// 为什么不放启停按钮：保持只读，避免在「所有实例平铺」的大视野里误操作——
// 控制仍在实例详情页（每实例一组完整按钮）与服务器详情页（按服务器再分组时更稳）。
//
// 数据：复用 GET /servers/:id/instances 与 /servers/:id/players。
// 离线/安装中的服务器不发出请求（它们一定会失败），分组小标题上挂 Agent 状态徽章。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Server } from 'lucide-react';
import { AddServerDialog } from '@/components/dialogs';
import { AgentBadge, InstanceStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { navigate } from '@/lib/router';
import {
  api,
  CORE_LABEL,
  errText,
  fmtMB,
  fmtUptime,
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

export function InstancesPage({
  me,
  servers,
  onAdd,
}: {
  me: Me;
  servers: ServerSummary[];
  onAdd: (s: ServerSummary) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // 每台服务器的拉数结果。key 是 serverId；找不到就当 null（还没拉过 / 拉失败）。
  const [data, setData] = useState<Record<string, ServerInstanceData>>({});
  // 顺序：与 servers prop 完全对齐；不引入第二份排序，否则拖动排序会和总览对不上。
  const groups = buildInstanceGroups(servers, data);
  const summary = summarizeGroups(groups);
  // 强制每 30s 走一遍重渲染（让 fmtUptime 的「运行时间」走动；与 servers 页同款）
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

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

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-28 pt-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{$('instances.title')}</h2>
        {servers.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {$('instances.summary', summary.total, summary.running)}
            {summary.unreachable > 0 && (
              <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                {$('instances.unreachable', summary.unreachable)}
              </span>
            )}
          </p>
        )}
        <Button className="ml-auto" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" /> {$('instances.add')}
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          {$('instances.empty.noServers')}
          <br />
          <span className="text-xs">{$('instances.empty.noServersHint')}</span>
        </div>
      ) : summary.total === 0 && summary.unreachable === servers.length ? (
        // 全部离线：只展示「等待重连」的空态，不让离线分组的小标题铺满整页
        <div className="mt-5 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          {$('instances.empty.allOffline')}
          <br />
          <span className="text-xs">{$('instances.empty.allOfflineHint')}</span>
        </div>
      ) : summary.total === 0 ? (
        // 都在线但都还没建实例
        <div className="mt-5 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
          {$('instances.empty.noInstances')}
          <br />
          <span className="text-xs">{$('instances.empty.noInstancesHint')}</span>
        </div>
      ) : (
        <div className="mt-5 grid gap-5">
          {groups.map((g) => (
            <ServerGroup key={g.server.id} group={g} />
          ))}
        </div>
      )}

      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        panelPort={me.port}
        onCreated={(s) => {
          onAdd(s);
          // 新服务器大概率需要先去「服务器设置」装 Agent——直接跳过去
          navigate(`/server/${s.id}/settings`);
        }}
      />
    </div>
  );
}

function ServerGroup({ group }: { group: InstanceGroup }) {
  const { server, instances, players, error } = group;
  // 不可达：实例清单未知，整个分组用提示卡代替
  if (!instances) {
    return (
      <section>
        <GroupHeader server={server} instanceCount={null} />
        <div className="mt-2 rounded-xl border border-dashed bg-muted/30 px-4 py-6 text-center text-xs text-muted-foreground">
          {error
            ? $('instances.error.load', error)
            : server.installing
              ? $('servers.agent.installing')
              : $('instances.offlineNote')}
        </div>
      </section>
    );
  }
  return (
    <section>
      <GroupHeader server={server} instanceCount={instances.length} />
      {instances.length === 0 ? (
        <div className="mt-2 rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          {$('instances.empty.noInstances')}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
          {instances.map((inst) => (
            <InstanceCard
              key={instanceKey(server.id, inst.name)}
              server={server}
              inst={inst}
              players={playersOf(players, inst.name)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GroupHeader({
  server,
  instanceCount,
}: {
  server: ServerSummary;
  /** null = 该组不可达（不显示数量，避免「0 个实例」歧义） */
  instanceCount: number | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Server className="h-3.5 w-3.5 text-muted-foreground" />
      <button
        type="button"
        onClick={() => navigate(`/server/${server.id}`)}
        className="text-sm font-semibold hover:underline"
        title={server.host}
      >
        {server.name}
      </button>
      <AgentBadge online={server.online} installing={server.installing} />
      {instanceCount !== null && (
        <span className="text-xs text-muted-foreground">
          {$('instances.group.count', instanceCount)}
        </span>
      )}
    </div>
  );
}

/** 实例卡片：只读版——仿 server-detail 的 4 列信息网格，去掉启停按钮（控制仍在详情页） */
function InstanceCard({
  server,
  inst,
  players,
}: {
  server: ServerSummary;
  inst: Instance;
  players: { online: number | null; max: number; list?: string[] | null; running: boolean; unreachable?: boolean } | null;
}) {
  const online = players?.online;
  return (
    <Card
      className="group cursor-pointer border bg-card transition-colors hover:border-muted-foreground/40"
      onClick={() => navigate(`/server/${server.id}/instance/${encodeURIComponent(inst.name)}`)}
    >
      <CardContent className="grid gap-2.5 p-4">
        <div className="flex items-center gap-2">
          <b className="truncate text-sm">{inst.name}</b>
          <span className="ml-auto">
            <InstanceStatusBadge status={inst.status} />
          </span>
        </div>
        {inst.note && <p className="-mt-1 line-clamp-1 text-[11px] text-muted-foreground">{inst.note}</p>}
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">{$('server.detail.field.core')}</span>
          <span className="truncate font-mono">{CORE_LABEL[inst.source ?? 'vanilla'] ?? inst.source ?? '—'}</span>

          <span className="text-muted-foreground">{$('server.detail.field.version')}</span>
          <span className="truncate font-mono">{inst.version}</span>

          <span className="text-muted-foreground">{$('server.detail.field.memory')}</span>
          <span className="font-mono">{fmtMB(inst.memoryMB)}</span>

          <span className="text-muted-foreground">{$('server.detail.field.players')}</span>
          <span
            className={
              online
                ? 'font-mono font-medium text-emerald-600 dark:text-emerald-400'
                : 'font-mono text-muted-foreground'
            }
          >
            {inst.status === 'running' ? (online ?? '—') : '—'}/{players?.max ?? inst.maxPlayers}
          </span>

          <span className="text-muted-foreground">{$('server.detail.field.uptime')}</span>
          <span className="font-mono">
            {inst.status === 'starting'
              ? $('server.detail.starting')
              : inst.status === 'running'
                ? fmtUptime(inst.startedAt)
                : '—'}
          </span>

          <span className="text-muted-foreground">IP</span>
          <span className="truncate font-mono">
            {server.host}:{inst.port}
          </span>
          {inst.address && (
            <>
              <span className="text-muted-foreground">{$('server.detail.field.domain')}</span>
              <span className="truncate font-mono text-primary">{inst.address}</span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
