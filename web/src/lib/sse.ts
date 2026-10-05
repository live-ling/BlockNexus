// SSE 事件总线 + 安装日志 store（面板实时推送给浏览器）

export type SseEvent =
  | { type: 'hello' }
  | { type: 'status'; serverId: string; status: string }
  | { type: 'latency'; serverId: string; latency: number }
  | {
      type: 'stats';
      serverId: string;
      stats: { memTotalMB: number; memUsedMB: number; disk: { totalGB: number; freeGB: number } | null };
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
    };

/** 带 serverId 的事件（排除 hello 心跳） */
export type ServerSseEvent = Exclude<SseEvent, { type: 'hello' }>;

type Listener = (e: SseEvent) => void;

let es: EventSource | null = null;
const listeners = new Set<Listener>();

export function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as SseEvent;
      listeners.forEach((fn) => fn(msg));
    } catch {
      // 忽略坏帧
    }
  };
  es.onerror = () => {}; // EventSource 自带重连
}

export function closeSSE() {
  es?.close();
  es = null;
}

export function subscribeSSE(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 订阅某台服务器的事件（自动过滤 hello 与其他服务器） */
export function subscribeServer(serverId: string, fn: (e: ServerSseEvent) => void): () => void {
  return subscribeSSE((e) => {
    if (e.type === 'hello' || e.serverId !== serverId) return;
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
