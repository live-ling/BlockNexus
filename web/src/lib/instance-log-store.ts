/**
 * 实例控制台日志 store —— **全页面唯一的日志数据源**。
 *
 * ## 为什么要有这个文件
 *
 * 改造前日志有**两个数据源**：
 *   1. 实例页常驻 5s 轮询 `GET .../console?tail=200`（喂 ERROR 计数与「最近事件」）；
 *   2. `ConsolePanel` 自己拉 `tail=300` + 自己订阅 SSE `console` 事件（喂终端显示）。
 *
 * 两条时间线意味着：计数和屏幕可能对不上、断线后两处各补各的、而且**切到别的页签
 * 那个 5s 轮询照跑不误**。本 store 把两者合并成一个数据源：
 *   - 历史：进入实例时拉一次 `tail=300`；
 *   - 实时：SSE `console` 事件（面板 → Agent → 加密通道 → SSE，见 agent/src/instance/manager.js
 *     的 `emitConsole`，300ms 批量）；
 *   - 断线补偿：SSE 从 `reconnecting` 回到 `open` 时**一次性**补拉一次尾部，合并去重。
 *
 * 消费方式与 `lib/sse.ts` 里的 `installLogStore` 一致（`useSyncExternalStore`），
 * 全仓只有这一个 store 模式，组件不再自己订阅 SSE。
 *
 * ## 约定
 *   - 按 `serverId:instance` 分键，不同实例互不干扰；
 *   - 缓冲上限 1500 行（与改造前 ConsolePanel 的 MAX_LINES 一致），超出丢弃最旧的；
 *   - 丢弃过行时计数 `dropped` > 0，UI 负责提示（不静默吞日志）；
 *   - 日志行归一化统一走 `consoleLines()`：Agent 两种形态（`string[]` 与 `{ts,text}[]`）都吃。
 */

import { api, consoleLines } from '@/lib/api';
import { sseConnection, subscribeSSE } from '@/lib/sse';

/** 缓冲上限：超过后丢弃最旧的行（计数记在 dropped 里） */
export const MAX_LINES = 1500;
/** 首次进入实例时拉取的历史行数（Agent 侧环形缓冲只有 500 行，多拉无意义） */
const INITIAL_TAIL = 300;
/** 断线补偿时拉取的尾部行数 */
const GAP_TAIL = 300;

export interface InstanceLogState {
  /** 已归一化的日志行（最新在末尾） */
  lines: string[];
  /** 实例状态；由 `instance.updated` 事件与 `/console` 响应共同更新 */
  status: string | null;
  /** 因缓冲上限被丢弃的行数（>0 时 UI 应提示） */
  dropped: number;
  /** 当前进程日志的起始下标；本次运行结束前的历史不计算 ERROR 徽章 */
  runStart: number;
  /** 是否已经拉过一次历史（false = 还没加载） */
  loaded: boolean;
}

const EMPTY: InstanceLogState = { lines: [], status: null, dropped: 0, runStart: 0, loaded: false };

const states = new Map<string, InstanceLogState>();
const listeners = new Set<() => void>();
/** 已发起过初始拉取的键（避免 StrictMode 双挂载时重复拉） */
const opened = new Set<string>();

function keyOf(serverId: string, instance: string): string {
  return `${serverId}:${instance}`;
}

function emit() {
  listeners.forEach((fn) => fn());
}

function update(key: string, patch: Partial<InstanceLogState>) {
  const cur = states.get(key) ?? EMPTY;
  states.set(key, { ...cur, ...patch });
  emit();
}

/** 追加实时行（超出上限丢最旧，累计 dropped） */
function append(key: string, incoming: string[]) {
  if (!incoming.length) return;
  const cur = states.get(key);
  // 只往「已打开」的实例追加：Agent 会为同服所有实例推 console 事件，
  // 没人看的实例不该在面板内存里堆缓冲。
  if (!cur) return;
  const next = [...cur.lines, ...incoming];
  let dropped = cur.dropped;
  let removed = 0;
  if (next.length > MAX_LINES) {
    removed = next.length - MAX_LINES;
    dropped += removed;
    next.splice(0, removed);
  }
  states.set(key, { ...cur, lines: next, dropped, runStart: Math.max(0, cur.runStart - removed) });
  emit();
}

/**
 * 合并一次补拉的历史：把 `fetched`（Agent 当前尾部）接到本地缓冲前面。
 *
 * 断线期间本地缓冲可能比 Agent 尾部多出若干行（那些行 Agent 也有，但顺序在 fetched 之后），
 * 所以这里的做法是：找到本地缓冲里第一条等于 fetched 最后一行的位置，保留其后部分；
 * 找不到（Agent 重启过、缓冲被清空）时按「fetched + 本地」拼接，绝不丢本地已有的行。
 *
 * ⚠ 刻意**不做**按内容去重：MC 日志里重复行是常态（"Saving chunks" 连着出现），
 * 去重会悄悄吃掉真实日志。
 */
function mergeTail(fetched: string[], local: string[]): string[] {
  if (!fetched.length) return local;
  if (!local.length) return fetched;
  const last = fetched[fetched.length - 1];
  const idx = local.indexOf(last);
  if (idx >= 0) return [...fetched, ...local.slice(idx + 1)];
  return [...fetched, ...local];
}

export const instanceLogStore = {
  /** 读取某个实例的日志状态（useSyncExternalStore 的 getSnapshot） */
  get: (serverId: string, instance: string): InstanceLogState =>
    states.get(keyOf(serverId, instance)) ?? EMPTY,

  /** 订阅变化（useSyncExternalStore 的 subscribe） */
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /**
   * 打开一个实例的日志：首次拉一次历史，之后靠 SSE 实时追加。
   * 重复调用安全（同一实例只拉一次历史）。
   */
  open: (serverId: string, instance: string): void => {
    const key = keyOf(serverId, instance);
    if (opened.has(key)) return;
    opened.add(key);
    // 先占位（loaded=false）：占位后 append 才会被接收，
    // 否则「打开前到达的实时行」会被丢掉（Agent 推 console 事件不等人）。
    states.set(key, { ...(states.get(key) ?? EMPTY), loaded: false });
    emit();
    void instanceLogStore.reload(serverId, instance, false);
  },

  /**
   * 重新拉一次尾部。
   * @param merge true = 与本地缓冲合并（断线补偿用）；false = 覆盖（首次加载用）
   */
  reload: async (serverId: string, instance: string, merge: boolean): Promise<void> => {
    const key = keyOf(serverId, instance);
    try {
      const data = await api<{ lines?: unknown; status?: string }>(
        `/servers/${serverId}/instances/${encodeURIComponent(instance)}/console?tail=${merge ? GAP_TAIL : INITIAL_TAIL}`,
      );
      const fetched = consoleLines(data);
      const cur = states.get(key) ?? EMPTY;
      const lines = merge ? mergeTail(fetched, cur.lines) : fetched;
      // 合并可能给缓冲前面补上历史；runStart 也要同步后移，否则 ERROR 统计会错位。
      const runStart = merge ? Math.min(lines.length, cur.runStart + Math.max(0, lines.length - cur.lines.length)) : 0;
      update(key, {
        lines,
        runStart,
        status: typeof data.status === 'string' ? data.status : cur.status,
        loaded: true,
      });
    } catch {
      // 拉取失败（Agent 离线等）：保持既有内容，UI 由「Agent 离线」条件条表达
      const cur = states.get(key) ?? EMPTY;
      if (!cur.loaded) update(key, { loaded: true });
    }
  },

  /** 清屏（只清本地缓冲，不动 Agent 侧缓冲） */
  clear: (serverId: string, instance: string): void => {
    update(keyOf(serverId, instance), { lines: [], dropped: 0, runStart: 0 });
  },

  /** 关闭一个实例的日志（离开页面时调用，释放内存） */
  close: (serverId: string, instance: string): void => {
    const key = keyOf(serverId, instance);
    states.delete(key);
    opened.delete(key);
    emit();
  },
};

/* ---------------- 全局唯一的 SSE 接线（组件不再自己订阅） ---------------- */

let wired = false;

/**
 * 把 SSE 事件路由进 store。只接一次（模块级单例）。
 *
 * 事件形态（见 lib/sse.ts 的 SseEvent 与 agent/src/instance/manager.js 的 emitConsole）：
 *   - `agent-event` / `console`：data = { instance, lines: string[] }
 *   - `agent-event` / `instance.updated`：data = { instance, status }
 */
function wire() {
  if (wired) return;
  wired = true;

  subscribeSSE((e) => {
    if (e.type !== 'agent-event') return;
    const instance = typeof e.data?.instance === 'string' ? e.data.instance : '';
    if (!instance) return;
    // serverId 在 agent-event 上是必带字段
    const serverId = e.serverId;
    const key = keyOf(serverId, instance);
    if (e.event === 'console') {
      const incoming = consoleLines({ lines: e.data?.lines });
      if (incoming.length) append(key, incoming);
      return;
    }
    if (e.event === 'instance.updated' && typeof e.data?.status === 'string') {
      const cur = states.get(key);
      const startingRun = e.data.status === 'running' && cur?.status !== 'running';
      // starting 也可能发生在 watchdog 重启：必须按「新一轮日志」计，不能沿用旧错误计数。
      const startingBoot = e.data.status === 'starting' && cur?.status !== 'starting';
      update(key, {
        status: e.data.status,
        ...(startingRun || startingBoot ? { runStart: cur?.lines.length ?? 0 } : {}),
      });
    }
  });

  // 断线补偿：SSE 从「重连中」回到「已连接」时，一次性补拉尾部，合并去重。
  // 非常驻轮询——只在真的断过线时触发一次。
  let wasBroken = false;
  sseConnection.subscribe(() => {
    const state = sseConnection.get();
    if (state === 'reconnecting') {
      wasBroken = true;
      return;
    }
    if (state === 'open' && wasBroken) {
      wasBroken = false;
      for (const key of states.keys()) {
        const [serverId, instance] = key.split(':');
        if (!serverId || !instance) continue;
        void instanceLogStore.reload(serverId, instance, true);
      }
    }
  });
}

wire();
