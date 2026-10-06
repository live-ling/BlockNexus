// 面板 REST API 客户端与类型定义

import { $, getLanguage } from './i18n';

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
  /** Agent 脚本版本（旧版 Agent 未上报时缺省） */
  agentVersion?: string;
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
  /** 本次 Agent 连接的建立时刻（在线时长统计用；离线/旧版面板未返回时为 null） */
  onlineSince?: number | null;
  /** 最近一次资源快照（面板后台 30s 拉取；Agent 离线/未上线时为 null） */
  stats: {
    memTotalMB: number;
    memUsedMB: number;
    disk: { totalGB: number; freeGB: number } | null;
  } | null;
  /** 面板自身监听地址（127.0.0.1 表示仅本机，手工安装命令对外不可用） */
  panelHost: string;
  /** 面板随附的 Agent 脚本版本（与 info.agentVersion 比对判断远端是否落后） */
  agentBundled?: string;
  /** Agent 自动更新状态（更新中/失败时非空；成功清空） */
  agentUpdate?: { state: 'updating' | 'failed' | 'done'; error?: string } | null;
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

/** 远端 Agent 版本是否落后于面板随附版本 */
export function agentOutdated(s: Pick<ServerSummary, 'info' | 'agentBundled'>): boolean {
  const remote = s.info?.agentVersion;
  return !!s.agentBundled && remote !== s.agentBundled;
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

/** 定时备份任务（结构与 WatchdogSchedule 一致，复用同一套每日/间隔规则） */
export type BackupScheduleItem = WatchdogSchedule;

export interface BackupScheduleConfig {
  /** 定时备份总开关 */
  enabled: boolean;
  /** 保留最近 N 份备份，0 = 不限制（手动与自动一起计数） */
  keepCount: number;
  schedules: BackupScheduleItem[];
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
  /** 定时备份设置（老版本 Agent 不返回该字段） */
  backupSchedule?: BackupScheduleConfig;
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
  /** 是否装了 spark（决定实例详情页要不要显示 Spark 标签页；老版本 Agent 不返回该字段） */
  sparkInstalled?: boolean;
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

/**
 * 核心 id → 显示名；实例卡片、创建向导共用一份。
 *
 * ⚠ 可翻译的项写成 getter 而**不是**字面量：`$()` 必须在取用的那一刻求值，
 * 在模块顶层求值会把语言固化在模块加载时（切换语言后不更新）。
 * 品牌名（Paper 等）中英一致，保持字面量。
 */
export const CORE_LABEL: Record<string, string> = {
  get vanilla() {
    return $('core.label.vanilla');
  },
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  // mojang 与 vanilla 是同一核心的两种写法，共用同一个键
  get mojang() {
    return $('core.label.vanilla');
  },
  get url() {
    return $('core.label.url');
  },
  get upload() {
    return $('core.label.upload');
  },
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

// ---------- Mod 管理（实例 mods 目录） ----------

export interface ModInfo {
  /** 逻辑文件名（不含 .disabled 后缀） */
  name: string;
  /** 磁盘上的实际文件名（可能带 .disabled） */
  file: string;
  disabled: boolean;
  size: number;
  mtime: number;
}

export interface ModsList {
  /** mods 目录是否存在（false 通常意味着没装 Forge/Fabric） */
  exists: boolean;
  dir: string;
  mods: ModInfo[];
}

export function listMods(serverId: string, instance: string): Promise<ModsList> {
  return api<ModsList>(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/mods`);
}

export function toggleMod(
  serverId: string,
  instance: string,
  file: string,
  disable: boolean,
): Promise<{ ok: boolean; file: string; disabled: boolean }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/mods/toggle`, {
    method: 'POST',
    body: { file, disable },
  });
}

export function deleteMod(serverId: string, instance: string, file: string): Promise<{ ok: boolean }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/mods/delete`, {
    method: 'POST',
    body: { file },
  });
}

/** 保存实例的定时备份设置（计划任务 + 保留份数），返回保存后的完整配置 */
export function saveBackupSchedule(
  serverId: string,
  instance: string,
  cfg: BackupScheduleConfig,
): Promise<{ ok: boolean; backupSchedule: BackupScheduleConfig }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/backup-schedule`, {
    method: 'PUT',
    body: cfg,
  });
}

// ---------- Java 环境（多版本安装 / 切换 / 卸载，Temurin 落位 /opt/blocknexus-java） ----------

/** /opt/blocknexus-java 下的一个托管 Java 目录（system 项为系统包 Java） */
export interface JavaEntry {
  /** 托管目录绝对路径；系统包 Java 固定为 'system' */
  path: string;
  /** 目录名，如 jdk-21.0.5+9；系统包 Java 为 'system' */
  name: string;
  major: number;
  /** 是否为当前默认 java 指向的版本 */
  active: boolean;
  /** java -version 首行原文（仅系统包 Java 返回） */
  raw?: string;
}

export interface JavaListResult {
  active: JavaInfo;
  managed: JavaEntry[];
  /** 系统包 Java（/usr/bin/java，apt/dnf 装的）；不存在时为 null */
  system: JavaEntry | null;
}

export function listJavas(serverId: string): Promise<JavaListResult> {
  return api(`/servers/${serverId}/javas`);
}

/** target 为托管目录绝对路径，或 'system'（改用系统包 Java） */
export function switchJava(serverId: string, target: string): Promise<{ java: JavaInfo }> {
  return api(`/servers/${serverId}/java-use`, { method: 'POST', body: { target } });
}

export function uninstallJava(serverId: string, target: string): Promise<{ java: JavaInfo }> {
  return api(`/servers/${serverId}/java-uninstall`, { method: 'POST', body: { target } });
}

// ---------- 封禁目录（banned-players / banned-ips） ----------

export interface BanEntry {
  name?: string;
  ip?: string;
  uuid?: string;
  created?: string;
  source?: string;
  expires?: string;
  reason?: string;
}

export interface BanList {
  players: BanEntry[];
  ips: BanEntry[];
  /** 实例运行中（解封走 pardon 命令）；否则直接改 JSON */
  running: boolean;
}

export function getBanList(serverId: string, instance: string): Promise<BanList> {
  return api<BanList>(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/banlist`);
}

export function unbanTarget(
  serverId: string,
  instance: string,
  kind: 'player' | 'ip',
  target: string,
): Promise<{ ok: boolean; via: string }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/banlist/unban`, {
    method: 'POST',
    body: { kind, target },
  });
}

// ---------- server-icon（64x64 PNG，前端压缩） ----------

export function instanceIconUrl(serverId: string, instance: string): string {
  return `/api/servers/${serverId}/instances/${encodeURIComponent(instance)}/icon`;
}

export function setInstanceIcon(serverId: string, instance: string, b64: string): Promise<{ ok: boolean }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/icon`, {
    method: 'POST',
    body: { b64 },
  });
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
    let msg = $('common.requestFailed', res.status);
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
      } else if (payload.type === 'error') {
        throw new ApiError(502, payload.error || $('api.ai.analyzeFailed'));
      } else if (payload.type === 'done') {
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

/** 服务端错误代码；未知 code 时为 undefined（向后兼容尚未迁移的接口） */
export type ApiErrorCode = string;

export class ApiError extends Error {
  status: number;
  /** 来自后端 error-codes.js 的稳定标识，用于判断错误类型与本地化 */
  code?: ApiErrorCode;
  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      // 语言选择存在浏览器里，后端无从得知；带上它让 error 兜底文案也用当前语言。
      // 认 code 的调用方不依赖它，只是过渡期的双保险。
      'Accept-Language': getLanguage() === 'en' ? 'en' : 'zh',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    // 空响应体
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string };
    // 优先用后端文案（已按当前语言渲染）；过渡期未迁移的接口没有 code，走同一条路径
    const msg = d.error || $('common.requestFailed', res.status);
    throw new ApiError(res.status, msg, d.code);
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
  if (!ts) return $('api.time.never');
  const d = Date.now() - ts;
  if (d < 60000) return $('api.time.justNow');
  if (d < 3600e3) return $('api.time.minutesAgo', Math.floor(d / 60000));
  if (d < 86400e3) return $('api.time.hoursAgo', Math.floor(d / 3600e3));
  return new Date(ts).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
}

/** 运行时长：X时X分（不足 1 分钟显示 X秒） */
export function fmtUptime(startedAt: number | null): string {
  if (!startedAt) return '';
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return $('api.time.uptime.hm', h, m);
  if (m > 0) return $('api.time.uptime.m', m);
  return $('api.time.uptime.s', totalSec);
}

/** 延迟等级：good < 80ms，fair < 180ms，否则 poor */
export function latencyTone(ms: number | null | undefined): 'good' | 'fair' | 'poor' | null {
  if (ms == null) return null;
  if (ms < 80) return 'good';
  if (ms < 180) return 'fair';
  return 'poor';
}
