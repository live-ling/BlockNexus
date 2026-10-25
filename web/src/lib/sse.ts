// SSE 事件总线 + 安装日志 store（面板实时推送给浏览器）

export type SseEvent =
  | { type: 'hello' }
  | { type: 'status'; serverId: string; status: string }
  | { type: 'latency'; serverId: string; latency: number }
  | {
      type: 'stats';
      serverId: string;
      stats: {
        memTotalMB: number;
        memUsedMB: number;
        cpuPct?: number | null;
        disk: { totalGB: number; freeGB: number } | null;
      };
    }
  | { type: 'agent-event'; serverId: string; event: string; data: Record<string, unknown> | null }
  | {
      type: 'install';
      serverId: string;
      log?: string;
      done?: boolean;
      ok?: boolean;
      error?: string;
    }
  | {
      type: 'uninstall';
      serverId: string;
      log?: string;
      done?: boolean;
      ok?: boolean;
      error?: string;
      /** true = 只是停止本机 Agent（不是卸载），用于区分完成提示文案 */
      stopped?: boolean;
    }
  | {
      /** Agent 自动更新进度（远端版本落后时面板自动执行） */
      type: 'agent-update';
      serverId: string;
      state: 'updating' | 'failed' | 'done';
      remote?: string;
      bundled?: string;
      log?: string;
      error?: string;
    }
  | {
      /**
       * 面板自更新进度（没有 serverId：这是面板自己的事）。
       * 字段与 panel/api.js 的 updateState 一一对应；切换阶段时推一条，下载中按进度推。
       */
      type: 'panel-update';
      state: 'idle' | 'downloading' | 'verifying' | 'staging' | 'applying' | 'restarting' | 'failed';
      from: string;
      to: string;
      progress: number;
      total: number;
      error: string;
      startedAt: number;
      mode: 'payload' | 'git' | 'rollback';
      migrations: { from: number; to: number }[];
      warnings: string[];
      requiresAgentReinstall: boolean;
      irreversible: boolean;
    };

/** 带 serverId 的事件（排除 hello 心跳与面板自身的 panel-update） */
export type ServerSseEvent = Exclude<SseEvent, { type: 'hello' } | { type: 'panel-update' }>;

/**
 * 是否有 serverId —— 显式类型守卫，而不是靠 `e.serverId` 的属性访问来收窄：
 * 联合类型里既然没有 serverId 的分支（hello / panel-update），直接访问就是类型错误。
 */
function hasServerId(e: SseEvent): e is ServerSseEvent {
  return e.type !== 'hello' && e.type !== 'panel-update';
}

type Listener = (e: SseEvent) => void;

let es: EventSource | null = null;
const listeners = new Set<Listener>();

/**
 * SSE 连接状态。
 *
 * 为什么要单独建模：EventSource 断了以后浏览器会自己重连，但**页面完全不知道**
 * （`onerror` 里以前是空函数）。运维页面上「断线」和「实例没日志」必须能区分开，
 * 否则用户会把连接问题误判成服务器问题。
 *
 * - idle：从未连接 / 已关闭（面板登出等）
 * - connecting：刚建立，握手未完成
 * - open：正常
 * - reconnecting：连接断开，浏览器正在自动重连（readyState = CONNECTING）
 * - closed：连接被彻底关闭，**不会**自动重连（readyState = CLOSED）
 *
 * ⚠ 区分 reconnecting 与 closed 很关键：前者能自愈（恢复后补日志），
 * 后者要靠用户刷新页面。混为一谈会让「等一会儿就好」和「必须重来」看起来一样。
 */
export type SseConnection = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

let connection: SseConnection = 'idle';
const connectionListeners = new Set<() => void>();

function setConnection(next: SseConnection) {
  if (next === connection) return;
  connection = next;
  connectionListeners.forEach((fn) => fn());
}

export const sseConnection = {
  get: (): SseConnection => connection,
  subscribe: (fn: () => void): (() => void) => {
    connectionListeners.add(fn);
    return () => {
      connectionListeners.delete(fn);
    };
  },
};

export function connectSSE() {
  if (es) es.close();
  setConnection('connecting');
  es = new EventSource('/api/events');
  es.onopen = () => setConnection('open');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as SseEvent;
      listeners.forEach((fn) => fn(msg));
    } catch {
      // 忽略坏帧
    }
  };
  // EventSource 自带重连。readyState 决定是「正在重试」还是「彻底断了」：
  //   CONNECTING(0) = 浏览器会重连；CLOSED(2) = 不会重连了，得让用户刷新。
  es.onerror = () => {
    setConnection(es && es.readyState === 2 ? 'closed' : 'reconnecting');
  };
}

/**
 * 系统级网络状态 → SSE 状态。
 *
 * 为什么需要它：EventSource 的 `onerror` **不一定**会触发。
 * 实测（CDP `Network.emulateNetworkConditions offline`）把网断掉时，
 * 已建立的 SSE 连接不会立刻报错，界面仍然显示「实时已连接」——
 * 用户以为日志是实时的，其实已经瞎了。
 *
 * 浏览器自己的 `offline`/`online` 事件是可靠的，所以把它们也接进同一套状态机：
 *   - 断网 → reconnecting（会自动重连）
 *   - 恢复网 → connecting（等 EventSource 自己的 onopen 把它推到 open）
 */
function wireNetworkEvents() {
  if (typeof window === 'undefined') return;
  window.addEventListener('offline', () => {
    if (connection === 'open' || connection === 'connecting') setConnection('reconnecting');
  });
  window.addEventListener('online', () => {
    if (connection !== 'reconnecting') return;
    // EventSource 可能已经自己连回去了（onopen 先到）：别把已连接的状态退回去。
    if (es && es.readyState === 1) setConnection('open');
    else setConnection('connecting');
  });
}

wireNetworkEvents();

export function closeSSE() {
  es?.close();
  es = null;
  setConnection('idle');
}

export function subscribeSSE(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 订阅某台服务器的事件（自动过滤 hello / panel-update 与其他服务器） */
export function subscribeServer(serverId: string, fn: (e: ServerSseEvent) => void): () => void {
  return subscribeSSE((e) => {
    if (!hasServerId(e) || e.serverId !== serverId) return;
    fn(e);
  });
}

// ---------- 安装日志（跨页面保留，useSyncExternalStore 消费） ----------

export interface InstallLogState {
  lines: string;
  done: boolean | null;
}

const installLogs = new Map<string, InstallLogState>();
const logListeners = new Set<() => void>();
/** 最近一次活动的日志面板 key：做成 User follows Tail 的底气（见 server-settings 自动滚动） */
export const installLogAutoScroll = { key: '', enabled: true };

function emitLogChange() {
  logListeners.forEach((fn) => fn());
}

export const installLogStore = {
  get: (id: string): InstallLogState | undefined => installLogs.get(id),
  open: (id: string) => {
    installLogs.set(id, { lines: '', done: null });
    emitLogChange();
  },
  push: (id: string, text: string) => {
    const s = installLogs.get(id);
    if (!s) return;
    installLogs.set(id, { ...s, lines: s.lines + text });
    emitLogChange();
  },
  markDone: (id: string, ok: boolean) => {
    const s = installLogs.get(id);
    if (!s) return;
    installLogs.set(id, { ...s, done: ok });
    emitLogChange();
  },
  subscribe: (fn: () => void) => {
    logListeners.add(fn);
    return () => {
      logListeners.delete(fn);
    };
  },
};
