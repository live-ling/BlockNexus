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
