// 面板 REST API 客户端与类型定义

export interface JavaInfo {
  installed: boolean;
  major?: number;
  raw?: string;
}

export interface ServerInfo {
  hostname: string;
  os: string;
  arch: string;
  node: string;
  memTotalMB: number;
  dir: string;
  instancesDir: string;
  java: JavaInfo;
}

export interface ServerSummary {
  id: string;
  name: string;
  host: string;
  token?: string;
  createdAt: number;
  status: string;
  lastSeen: number | null;
  info: ServerInfo | null;
  installing: boolean;
  online: boolean;
  /** 面板所在机器 → 该服务器 的链路延迟（毫秒），未测到为 null */
  latency: number | null;
  /** 最近一次资源快照（面板后台 30s 拉取；Agent 离线/未上线时为 null） */
  stats: {
    memTotalMB: number;
    memUsedMB: number;
    disk: { totalGB: number; freeGB: number } | null;
  } | null;
  /** 面板自身监听地址（127.0.0.1 表示仅本机，手工安装命令对外不可用） */
  panelHost: string;
  /** host 指向面板所在机器：本机服务器由面板直接托管 Agent 进程，不需要 SSH/systemd */
  isLocal: boolean;
  /** 本机 Agent 的进程状态（远程服务器为 null） */
  localAgent: {
    pid: number;
    running: boolean;
    dir: string;
    instancesDir: string;
  } | null;
  agent: {
    /** 连接方向：outbound = 面板主动连 Agent（默认）；inbound = Agent 连入面板 */
    mode: 'outbound' | 'inbound';
    /** Agent 地址（留空用服务器地址） */
    host: string;
    /** Agent 监听端口（outbound 模式） */
    port: number;
    /** 是否用 TLS（wss）连接 Agent */
    tls: boolean;
    /** 自签证书指纹（SHA-256，面板侧固定校验） */
    tlsFingerprint: string;
    /** 面板地址（inbound 模式） */
    panelUrl: string;
    installDir: string;
  };
  ssh: {
    port: number;
    user: string;
    auth: 'password' | 'key';
    hasPassword: boolean;
    hasKey: boolean;
    keyPath: string;
  };
}

/** 添加服务器前的 SSH 连接验证结果（POST /servers/ssh-check） */
export interface SshCheckResult {
  ok: boolean;
  /** 环境是否满足自动安装条件（root 或免密 sudo） */
  canInstall?: boolean;
  /** 本机服务器：面板直接托管 Agent，不走 SSH */
  local?: boolean;
  user?: string;
  isRoot?: boolean;
  sudoOk?: boolean;
  os?: string;
  arch?: string;
  node?: string;
  java?: string;
  javaMajor?: number;
  warnings?: string[];
  error?: string;
}

export type InstanceStatus =
  | 'running'
  | 'starting'
  | 'stopped'
  | 'downloading'
  | 'failed'
  | 'incomplete'
  | 'deleted';

/** 定时重启任务 */
export interface WatchdogSchedule {
  id: string;
  enabled: boolean;
  type: 'daily' | 'interval';
  /** 每日触发时间 HH:MM（type=daily） */
  time: string;
  /** 星期过滤 0=周日…6=周六，空数组=每天（type=daily） */
  days: number[];
  /** 间隔分钟数（type=interval） */
  intervalMinutes: number;
  lastFiredAt?: number;
}

export interface WatchdogConfig {
  /** 崩溃（异常退出）后自动重启 */
  autoRestart: boolean;
  /** 重启前延迟秒数 */
  restartDelaySec: number;
  schedules: WatchdogSchedule[];
}

export interface Instance {
  name: string;
  version: string;
  port: number;
  memoryMB: number;
  motd: string;
  onlineMode: boolean;
  note: string;
  address: string;
  /** server.properties 的 max-players */
  maxPlayers: number;
  watchdog: WatchdogConfig;
  status: InstanceStatus;
  pid: number | null;
  startedAt: number | null;
  createdAt: number;
  error?: string;
  /** 核心类型：vanilla / paper / purpur / folia / fabric / forge / neoforge / url / upload */
  source?: string;
  /** 构建号（Paper/Purpur）或完整版本（Forge/NeoForge） */
  build?: string;
  /** 自定义直链（source=url 时），面板代下要用它来下载 */
  url?: string;
}

/** 运行中实例的在线人数快照：{ [实例名]: { online, max, list, running } } */
export type PlayersSnapshot = Record<
  string,
  {
    online: number | null;
    max: number;
    /** 在线玩家名单（服务端状态响应提供；可能为空或缺省） */
    list?: string[] | null;
    running: boolean;
    unreachable?: boolean;
  }
>;

export interface McVersions {
  latest: string;
  versions: { id: string; releaseTime: string }[];
  /** true = 在线清单不可达，当前为缓存的兜底数据 */
  stale?: boolean;
}

/** 核心 id → 显示名；实例卡片、创建向导共用一份 */
export const CORE_LABEL: Record<string, string> = {
  vanilla: '原版 Vanilla',
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  mojang: '原版 Vanilla',
  url: '自定义 URL',
  upload: '上传核心',
};

/** 需要用官方安装器现场安装的核心（比直接下 jar 耗时更长） */
export const INSTALLER_SOURCES = new Set(['fabric', 'forge', 'neoforge']);

/** 核心市场里的一类核心（如 Paper） */
export interface CoreKind {
  id: string;
  label: string;
  /** 是否有远端版本目录；false 表示需要用户自己提供 URL 或上传 */
  api: boolean;
}

export interface CoreCatalog {
  ok: boolean;
  error?: string;
  latest: string | null;
  /** Forge/NeoForge 的 id 是 MC 版本，build 是完整 maven 版本 */
  versions: { id: string; build?: string }[];
  stale?: boolean;
}

export interface CoreCatalogs {
  kinds: CoreKind[];
  catalogs: Record<string, CoreCatalog>;
  stale?: boolean;
}

export interface ConsoleLine {
  ts: number;
  text: string;
}

export interface Me {
  port: number;
  authEnabled: boolean;
  /** 面板版本（package.json） */
  version?: string;
}

/** 面板设置（GET /api/settings；SMTP 密码不回传，只给 hasPass） */
export interface PanelSettings {
  authEnabled: boolean;
  username: string;
  domain: string;
  adminEmail: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from: string;
    hasPass: boolean;
  };
  notify: { offline: boolean; recovery: boolean };
  smtpReady: boolean;
  /** AI 日志分析（密钥不回传，只给 hasKey） */
  ai: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    hasKey: boolean;
  };
}

/** AI 单次调用的用量与耗时统计 */
export interface AiStats {
  /** 实际响应的模型名（服务商可能改写） */
  model?: string;
  /** 首字延迟（毫秒） */
  firstTokenMs?: number;
  /** 总耗时（毫秒） */
  totalMs?: number;
  usage?: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

export interface AiTestResult extends AiStats {
  ok: boolean;
  reply?: string;
  status?: number;
}

/** 用当前接口地址与密钥查询服务商可用模型（GET /models） */
export async function aiListModels(body: { baseUrl?: string; apiKey?: string }): Promise<string[]> {
  const r = await api<{ ok: boolean; models: string[] }>('/settings/ai-models', {
    method: 'POST',
    body,
  });
  return r.models || [];
}

/** 连接测试：返回模型、状态、首字/总耗时、Token 用量 */
export async function aiTest(body: { baseUrl?: string; model?: string; apiKey?: string }): Promise<AiTestResult> {
  return api<AiTestResult>('/settings/ai-test', { method: 'POST', body });
}

/** 版本与更新信息（设置页「版本」卡） */
export interface AppVersion {
  /** 当前面板版本（package.json） */
  version: string;
  /** GitHub 最新 Release 版本号；拉取失败为 null */
  latest: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  /** 仓库源码地址 */
  repoUrl: string;
  /** 最新 Release 的更新日志（Markdown） */
  changelog: string;
  checkedAt: number;
  /** 命中 10 分钟缓存 */
  cached?: boolean;
  error?: string;
}

export async function getVersion(refresh = false): Promise<AppVersion> {
  return api<AppVersion>(`/version${refresh ? '?refresh=1' : ''}`);
}

/** AI 分析：POST + SSE 流（fetch + reader，因为 EventSource 不支持 POST） */
export interface AiStreamHandlers {
  onMeta?: (meta: { lines: number; status: string; model: string; truncated?: boolean }) => void;
  onDelta: (text: string) => void;
  /** 结束时带回模型/耗时/Token 统计 */
  onDone?: (stats: AiStats) => void;
  signal?: AbortSignal;
}

export async function aiAnalyzeStream(
  serverId: string,
  instanceName: string,
  body: { question?: string; tail?: number; history?: { role: 'user' | 'assistant'; content: string }[] },
  handlers: AiStreamHandlers,
): Promise<void> {
  const res = await fetch(
    `/api/servers/${encodeURIComponent(serverId)}/instances/${encodeURIComponent(instanceName)}/ai-analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: handlers.signal,
    },
  );
  if (!res.ok || !res.body) {
    let msg = `请求失败 ${res.status}`;
    try {
      const d = (await res.json()) as { error?: string };
      if (d.error) msg = d.error;
    } catch {
      // 无 JSON 响应体
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame
        .split('\n')
        .find((l) => l.startsWith('data:'));
      if (!line) continue;
      let payload: {
        type?: string;
        text?: string;
        error?: string;
        lines?: number;
        status?: string;
        model?: string;
        truncated?: boolean;
        firstTokenMs?: number;
        totalMs?: number;
        usage?: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
      };
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (payload.type === 'delta' && payload.text) handlers.onDelta(payload.text);
      else if (payload.type === 'meta') {
        handlers.onMeta?.({
          lines: payload.lines || 0,
          status: payload.status || '',
          model: payload.model || '',
          truncated: payload.truncated,
        });
      } else if (payload.type === 'error') throw new ApiError(502, payload.error || 'AI 分析失败');
      else if (payload.type === 'done') {
        handlers.onDone?.({
          model: payload.model,
          firstTokenMs: payload.firstTokenMs,
          totalMs: payload.totalMs,
          usage: payload.usage,
        });
      }
    }
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    // 空响应体
  }
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `请求失败 ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function fmtMB(mb: number): string {
  return mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB' : mb + ' MB';
}

/** 磁盘用量：128 / 200 GB（≥100GB 不显示小数位） */
export function fmtDiskGB(usedGB: number, totalGB: number): string {
  const f = (n: number) => (n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  return `${f(usedGB)} / ${f(totalGB)} GB`;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** exp;
  return `${v >= 10 || exp === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[exp]}`;
}

export function timeago(ts: number | null): string {
  if (!ts) return '从未';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 运行时长：X时X分（不足 1 分钟显示 X秒） */
export function fmtUptime(startedAt: number | null): string {
  if (!startedAt) return '';
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分`;
  return `${totalSec}秒`;
}

/** 延迟等级：good < 80ms，fair < 180ms，否则 poor */
export function latencyTone(ms: number | null | undefined): 'good' | 'fair' | 'poor' | null {
  if (ms == null) return null;
  if (ms < 80) return 'good';
  if (ms < 180) return 'fair';
  return 'poor';
}
