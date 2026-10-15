// 实例总览的数据组装：把「服务器列表 + 每台拉到的实例/玩家快照」折成按服务器分组的结构。
//
// 抽成独立模块（而不是写在页面里）的原因：这里是纯函数，正是最容易埋 bug 的地方——
//   ① 服务器被卸载移除后，它的分组必须从总览里消失（不能靠拉数失败才清）；
//   ② Agent 不可达时 instances 是 null（未知），不是空数组（确定没有），
//      两者的统计与空态展示完全不同；
//   ③ 实例名在**不同服务器之间可以重复**，渲染时的 key 必须带 serverId。
// 这三条都能脱离 React 单测，所以放在这里而不是页面内部。

import type { Instance, PlayersSnapshot, ServerSummary } from './api';

/** 一台服务器的实例数据；instances=null 表示「取不到」（Agent 离线/安装中），而非「没有实例」 */
export interface ServerInstanceData {
  instances: Instance[] | null;
  players: PlayersSnapshot;
  /** 拉实例清单失败时的原因文案（Agent 超时/报错）；成功时为 undefined */
  error?: string;
}

export interface InstanceGroup {
  server: ServerSummary;
  /** null = 该服务器 Agent 不可达，实例清单未知 */
  instances: Instance[] | null;
  players: PlayersSnapshot;
  /** 拉实例清单失败时的原因文案（成功时为 undefined） */
  error?: string;
}

/**
 * 组装分组。
 *
 * 只输出**当前仍在 servers 里**的分组：服务器在「服务器设置」里被勾选移除后，
 * App 的 servers 会少一项，这里随之不再输出——不需要额外的清理逻辑，
 * 也不会出现「实例卡片指向一台已经不存在的服务器」。
 *
 * 顺序沿用 servers 的顺序（面板持久化的拖动排序就在它上面），不引入第二份排序状态。
 */
export function buildInstanceGroups(
  servers: ServerSummary[],
  data: Record<string, ServerInstanceData | undefined>,
): InstanceGroup[] {
  return servers.map((server) => {
    const d = data[server.id];
    return {
      server,
      instances: d ? d.instances : null,
      players: d ? d.players : {},
      error: d?.error,
    };
  });
}

export interface InstanceSummary {
  /** 已取到清单的实例总数（不含 Agent 不可达的服务器） */
  total: number;
  /** 其中运行中的数量 */
  running: number;
  /** Agent 不可达的服务器数量（无法得知实例情况） */
  unreachable: number;
}

/**
 * 汇总统计。`instances === null` 的分组**不计入 total**——
 * 「未知」不是「零」，把它算成 0 会让顶部摘要在 Agent 短暂离线时显示「共 0 个实例」。
 */
export function summarizeGroups(groups: InstanceGroup[]): InstanceSummary {
  let total = 0;
  let running = 0;
  let unreachable = 0;
  for (const g of groups) {
    if (!g.instances) {
      unreachable += 1;
      continue;
    }
    total += g.instances.length;
    running += g.instances.filter((i) => i.status === 'running').length;
  }
  return { total, running, unreachable };
}

/** 实例卡片的稳定 key：必须带 serverId，否则同名实例在不同服务器上会撞 key */
export function instanceKey(serverId: string, name: string): string {
  return `${serverId}/${name}`;
}

/** 取某个实例的在线人数快照；没有数据时返回 null（调用方据此显示 —） */
export function playersOf(players: PlayersSnapshot | undefined, name: string) {
  if (!players) return null;
  return players[name] ?? null;
}
