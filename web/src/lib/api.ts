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

/**
 * 系统名展示：把 Node 的 `os.type() + release()` 转成人能读的形式。
 *
 * Windows 的 `os.type()` 恒为 `Windows_NT`、版本是内核号（10.0.22631），直接显示
 * 会变成「Windows_NT 10.0.22631」——既不直观，看起来也像 Linux 那套系统名。
 * 按 build 号映射成 Windows 10/11 并保留 build，其余平台原样返回。
 */
export function osLabel(os: string): string {
  const s = String(os || '').trim();
  if (!s) return '—';
  if (!/^Windows_NT/i.test(s)) return s;
  const m = /^Windows_NT\s+\d+\.\d+\.(\d+)/i.exec(s);
  if (!m) return 'Windows';
  const build = Number(m[1]);
  return `Windows ${build >= 22000 ? 11 : 10} (${build})`;
}

/**
 * 版本号展示值：**只返回裸版本号**，'v' 前缀由调用方或译文负责。
 *
 * 为什么值得单独一个函数：系统信息里那行「远端 v0.5.0 · 本地 v{0}」的 'v' 由**译文**
 * 提供，而调用点又拼了一次 'v'，于是渲染成「本地 vv0.5.0」——一处纯约定型的错，
 * 静态检查与类型都拦不住。把「取值」收进一个具名函数后，调用点只可能传裸版本，
 * 顺带把远端可能自带的 'v' 前缀也剥掉（`v0.5.0` → `0.5.0`）。
 */
export function agentVersionText(v: string | null | undefined, fallback = '—'): string {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  return s || fallback;
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
  /**
   * 玩家在线时长统计与聊天记录的两个开关。
   * 记录发生在 Agent 侧（面板离线也照记）；老版本 Agent 不返回该字段，按「全开」处理。
   */
  tracking?: { players: boolean; chat: boolean };
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

/**
 * 单个玩家的在线时长统计（Agent 侧累计，见 agent/src/instance/playerdata.js）。
 * `totalMs` 是**已结算**的历史会话总时长，不含当前这一节；当前会话由 `onlineSince`
 * 表达，界面上把两者相加才是「累计」，避免同一段时间被算两遍。
 */
export interface PlayerStat {
  name: string;
  online: boolean;
  /** 本次会话开始时刻（毫秒）；不在线为 null */
  onlineSince: number | null;
  /** 已结算的累计时长（毫秒），不含当前会话 */
  totalMs: number;
  /** 会话次数（含当前这次） */
  sessions: number;
  /** 首次被记录到的时刻（毫秒），0 表示未知 */
  firstSeen: number;
  /** 最近一次加入/离开的时刻（毫秒），0 表示未知 */
  lastSeen: number;
}

export interface PlayersStats {
  instance: string;
  /** Agent 侧的时间（毫秒）：前端据此算时长，免受两端时钟差影响 */
  now: number;
  running: boolean;
  /** 开始统计的时刻（早于它的在线时长不在统计范围内） */
  trackedSince: number;
  /** 玩家表已达上限（更早的玩家记录会被淘汰） */
  truncated?: boolean;
  players: PlayerStat[];
}

/** 一条聊天记录（t=毫秒时间戳，k=类型，n=玩家名，m=正文） */
export interface ChatRecord {
  t: number;
  k: 'chat' | 'emote' | 'whisper' | string;
  n: string;
  m: string;
}

export interface ChatPage {
  instance: string;
  now: number;
  /** 记录文件当前字节数（0 = 还没有记录） */
  size: number;
  /** 本页记录（旧 → 新） */
  records: ChatRecord[];
  /** 本页之前还有更早的记录 */
  more: boolean;
  /** 下一页游标（字节偏移，原样回传给 before） */
  nextBefore: number;
  /** 文件被轮转/清空过，游标失效：前端应清空重载 */
  reset: boolean;
}

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

/**
 * 把 `/console` 的 `lines` 统一成 `string[]`。
 *
 * 两种形态都真实存在：老 Agent 直接回 `string[]`，现在的 Agent（见
 * `agent/src/instance/manager.js` 的 `rec.buf`）回 `{ ts, text }[]`。
 * **绝不能把原始数组直接交给 React**：渲染对象会触发 React #31
 * （objects are not valid as a React child），而 `String(obj)` 又会把整页日志
 * 变成 `[object Object]`。所以两种形态都在这里显式取文本。
 */
export function consoleLines(res: { lines?: unknown } | null | undefined): string[] {
  const raw = res && Array.isArray(res.lines) ? (res.lines as unknown[]) : [];
  return raw.map((l) => {
    if (typeof l === 'string') return l;
    if (l && typeof l === 'object' && 'text' in l) {
      const t = (l as { text?: unknown }).text;
      return typeof t === 'string' ? t : String(t ?? '');
    }
    return '';
  });
}

export interface Me {
  port: number;
  authEnabled: boolean;
  /** 面板版本（package.json） */
  version?: string;
  /**
   * 危险组合告警：面板**对外可达**（非回环监听或配了 trust proxy）却**没开鉴权**。
   * 此时任何人都能完全接管面板（改配置、经 SSH 装 Agent、以 root 读写服务器文件）。
   * 后端只做告警、不改默认行为，前端据此显示持久横幅。
   */
  exposedWithoutAuth?: boolean;
}

/**
 * 面板自更新的更新策略（GET/PUT /api/settings 的 update 字段）。
 * `source` 只影响下载地址（镜像/代理），校验值始终来自 GitHub Release。
 */
export interface PanelUpdatePolicy {
  auto: 'off' | 'notify' | 'auto';
  /** 自定义下载源模板，可用 {name} / {version} 占位符；空串=官方地址 */
  source: string;
  /** 「跳过此版本」：{ 版本号: 忽略时刻 }，后端只存不解释，判定在前端做 */
  dismissed: Record<string, number>;
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
  /** 面板自更新策略（老后端不返回该字段，前端按默认值兜底） */
  update?: PanelUpdatePolicy;
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
  /** 打包元数据缺失（自更新所需的文件信息不全，只能人工装） */
  metaMissing?: boolean;
  /** 当前安装形态：便携版 / 目录 / git 工作区干净或脏 / 未知 */
  installKind?: 'portable' | 'dir' | 'git-clean' | 'git-dirty' | 'unknown';
  canSelfUpdate?: boolean;
  /** 不能自更新的原因码 */
  updateDisabledReason?: string;
  /** 原因文案（后端已按当前语言渲染，直接显示） */
  updateDisabledText?: string;
  updatePolicy?: { auto: 'off' | 'notify' | 'auto'; source: string };
  /** 更新建议（老后端不返回；缺失时界面只显示版本对比，不给更新入口） */
  recommendation?: AppVersionRecommendation;
  /** 后端记录的更新状态（面板重启后仍存在） */
  updateState?: PanelUpdateState;
}

/** 更新建议：后端把「该不该提醒、提醒得多重、能不能自动装」都算好了 */
export interface AppVersionRecommendation {
  hasUpdate: boolean;
  latest: string;
  severity: 'security' | 'critical' | 'recommended' | 'optional';
  summary: string;
  notesUrl: string;
  /** 破坏性变更（升级前必须备份/读说明） */
  breaking: boolean;
  requiresAgentReinstall: boolean;
  /** 不可逆（无法回滚；界面必须二次确认） */
  irreversible: boolean;
  metaMissing: boolean;
  /** 本次升级要执行的迁移条数 */
  migrations: number;
  dismissed: boolean;
  dismissedAt: number;
  /** 后端为什么建议自动安装（auto 策略下才会非空） */
  autoReason: string;
  error: string;
}

export async function getVersion(refresh = false): Promise<AppVersion> {
  return api<AppVersion>(`/version${refresh ? '?refresh=1' : ''}`);
}

// ---------- 面板自更新（下载 → 校验 → 暂存 → 重启换包） ----------

/**
 * 面板自更新的实时状态（SSE `{type:'panel-update', ...}` 与
 * GET /api/panel-update/status 的公共部分）。
 *
 * 为什么 `from`/`to` 是**两个**字段：更新过程要跨重启活着，只有同时记住
 * 「从哪来、到哪去」才能在重启后判断这次更新是否真的落地（重启后进程里
 * 已经没有发起更新的那次内存状态了）。
 */
export interface PanelUpdateState {
  state: 'idle' | 'downloading' | 'verifying' | 'staging' | 'applying' | 'restarting' | 'failed';
  from: string;
  to: string;
  /** 已下载字节数（0 表示未知，界面转不确定态进度条） */
  progress: number;
  /** 总字节数（0 表示未知） */
  total: number;
  error: string;
  startedAt: number;
  mode: 'payload' | 'git' | 'rollback';
  migrations: { from: number; to: number }[];
  warnings: string[];
  requiresAgentReinstall: boolean;
  irreversible: boolean;
}

/** 上次更新的结果（重启后仍可读；成功为 ok=true） */
export interface PanelUpdateLastResult {
  at: number;
  from: string;
  to: string;
  ok: boolean;
  rolledBack: boolean;
  restored?: string;
  error?: string;
  irreversible?: boolean;
  dataBackup?: string;
}

/** 回滚可用性（不可逆更新成功后后端会关掉它） */
export interface PanelUpdateRollback {
  available: boolean;
  to: string;
  irreversible: boolean;
  reasonKey: string;
}

export type PanelUpdateStatus = PanelUpdateState & {
  /** 后端是否有一个更新正在进行（含刚提交、尚未进入 downloading 的窗口期） */
  inFlight: boolean;
  installKind: string;
  canSelfUpdate: boolean;
  lastResult: PanelUpdateLastResult | null;
  rollback: PanelUpdateRollback;
};

/** 一次更新的预览（点「立即更新」前必须拿到它：用户先看到要付什么代价） */
export interface PanelUpdatePreflight {
  from: string;
  to: string;
  latest: string;
  severity: string;
  summary: string;
  notesUrl: string;
  changelog: string;
  breaking: boolean;
  irreversible: boolean;
  requiresAgentReinstall: boolean;
  agentsToReinstall: { id: string; name: string }[];
  migrations: { from: number; to: number }[];
  /**
   * direct = 面板自己换包；bridge = 必须先经过一个中间版本（旧版本无法直接跨到最新）；
   * manual = 只能人工装（界面给下载地址，禁用应用内更新）。
   */
  mode: 'direct' | 'bridge' | 'manual';
  /** mode === 'bridge' 时的中间版本号 */
  bridgeVersion: string;
  needsFullPackage: boolean;
  fullPackageUrl: string;
  appAssetAvailable: boolean;
  downloadBytes: number;
  lockChanged: boolean;
  nodeOk: boolean;
  nodeRequired: number;
  installKind: string;
  canSelfUpdate: boolean;
  allowed: boolean;
  /** 机器可读的拒绝原因码（如 update.disabled-dirty） */
  reasonKey: string;
  /** 已按当前语言渲染好的拒绝说明，直接显示即可 */
  reasonText: string;
  /** 已本地化的警告行（text 直接显示） */
  warnings: { code: string; text: string }[];
  metaMissing: boolean;
  checkedAt: number;
  error: string;
}

/** 升级预览；`version` 缺省表示目标为后端推荐的最新版 */
export function getPanelUpdatePreflight(version?: string): Promise<PanelUpdatePreflight> {
  const q = version ? `?version=${encodeURIComponent(version)}` : '';
  return api<PanelUpdatePreflight>(`/panel-update/preflight${q}`);
}

export function getPanelUpdateStatus(): Promise<PanelUpdateStatus> {
  return api<PanelUpdateStatus>('/panel-update/status');
}

/**
 * 发起更新（后端 202 受理后异步跑，进度走 SSE / status）。
 * `confirm` 必须等于 `version`：这是「前端确实把目标版本展示给用户了」的凭据，
 * 避免旧页面（还停在别的版本上）误触发。
 * `confirmIrreversible` 只在预览标了不可逆、且用户二次确认后带上。
 */
export function applyPanelUpdate(body: {
  version: string;
  confirm: string;
  confirmIrreversible?: true;
}): Promise<{ ok: boolean; accepted: boolean; version: string; preflight: PanelUpdatePreflight }> {
  return api('/panel-update', { method: 'POST', body });
}

export function rollbackPanelUpdate(): Promise<{ ok: boolean; accepted: boolean; rollbackTo: string }> {
  return api('/panel-update/rollback', { method: 'POST', body: {} });
}

/** 下载体积展示：面板包以 MB 为主，小于 1MB 时退回 KB，未知时给占位串 */
export function fmtDownloadBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * 当前版本是否**已达到**目标版本（用于「面板重启回来了，是不是已经升上去」这一判断）。
 *
 * 为什么不直接字符串比较：`0.9.0` 与 `0.10.0` 按字典序比会得出反的结论。
 * 也不用 semver 库：本项目零依赖，而这里只需要「数字段逐个比、非数字段退回相等判断」这一种用途。
 * 目标版本取不到时返回 false —— 宁可多轮询一会儿，也不要在没升级时误刷页面。
 */
export function versionAtLeast(
  current: string | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!current || !target) return false;
  const norm = (v: string) => v.trim().replace(/^v/i, '');
  const a = norm(current);
  const b = norm(target);
  if (a === b) return true;
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    // 任一段不是纯数字（如 0.4.0-beta.1）就无法可靠比较，退回「必须完全相等」
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
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

/** 托管 Java 目录（system 项为系统包 Java；Windows 上还会列出各厂商装的 JDK） */
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
  /**
   * 是否可卸载（只有落在面板托管目录里的版本才允许删）。
   * 老 Agent 不返回该字段 → 按可卸载处理（Linux 托管列表全是它自己装的）。
   */
  removable?: boolean;
}

export interface JavaListResult {
  active: JavaInfo;
  managed: JavaEntry[];
  /** 系统包 Java（/usr/bin/java，apt/dnf 装的）；不存在时为 null */
  system: JavaEntry | null;
}

/**
 * 版本列表里那一行的**完整版本号**（展示值，和 agentVersionText 同一类契约）：
 *   · 系统包：raw 是 `java -version` 首行（openjdk version "17.0.10" 2024-01-16）→ 取引号里的部分
 *   · 托管版本：Agent 只回目录名（Temurin JRE 解压出来是 jdk-21.0.5+9-jre，8 是 jdk8u432-b06）
 *     → 剥掉 `jdk-` 前缀与 `-jre` 后缀
 * 两个来源都取不到时返回空串：调用点据此退回路径或说明文案，而不是渲染 undefined。
 */
export function javaVersionText(entry: Pick<JavaEntry, 'name' | 'raw'>): string {
  const quoted = entry.raw?.match(/"([^"]+)"/)?.[1];
  if (quoted) return quoted;
  const stripped = entry.name.replace(/^jdk-?/i, '').replace(/-jre$/i, '');
  return stripped !== entry.name ? stripped : '';
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

// ---------- 玩家在线时长统计 与 聊天记录（数据由 Agent 解析并落盘） ----------

export function getPlayersStats(serverId: string, instance: string): Promise<PlayersStats> {
  return api<PlayersStats>(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/players/stats`);
}

/**
 * 读取聊天记录。
 * `before` 是**字节偏移游标**（上一页返回的 nextBefore），不是时间戳——
 * 同一毫秒可能有多条记录，用时间戳做游标会漏记录。
 * `player` / `q` 都是纯文本过滤（Agent 侧用 includes 匹配，不构造正则）。
 */
export function getChatLog(
  serverId: string,
  instance: string,
  opts: { limit?: number; before?: number; player?: string; q?: string } = {},
): Promise<ChatPage> {
  const p = new URLSearchParams();
  if (opts.limit) p.set('limit', String(opts.limit));
  if (opts.before) p.set('before', String(opts.before));
  if (opts.player) p.set('player', opts.player);
  if (opts.q) p.set('q', opts.q);
  const qs = p.toString();
  return api<ChatPage>(
    `/servers/${serverId}/instances/${encodeURIComponent(instance)}/chat${qs ? '?' + qs : ''}`,
  );
}

/** 清空聊天记录（不可恢复：调用方必须先二次确认） */
export function clearChatLog(serverId: string, instance: string): Promise<{ ok: boolean; removedBytes: number }> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/chat/clear`, {
    method: 'POST',
    body: {},
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

// ---------- 网络助手：DDNS / frp（实验功能，后端默认关闭） ----------

export type DdnsProvider = 'cloudflare' | 'dnspod' | 'duckdns' | 'callback';
export type DdnsSource = 'api' | 'nic' | 'command';

/** GET /api/network/ddns 的 config（凭据只回 has*，不回明文） */
export interface DdnsConfig {
  enabled: boolean;
  provider: DdnsProvider;
  domain: string;
  ttl: number;
  intervalSec: number;
  ipv4: boolean;
  ipv6: boolean;
  source: DdnsSource;
  sourceUrl: string;
  sourceIPv6: string;
  command: string;
  cloudflare: { zoneId: string; hasToken: boolean };
  dnspod: { id: string; root: string; line: string; hasToken: boolean };
  duckdns: { hasToken: boolean };
  callback: { url: string; body: string };
}

export interface DdnsLogLine {
  at: number;
  text: string;
}

export interface DdnsStatus {
  running: boolean;
  busy: boolean;
  lastAt: number | null;
  nextAt: number | null;
  result: '' | 'ok' | 'error' | 'disabled';
  error: string;
  ipv4: string;
  ipv6: string;
  log: DdnsLogLine[];
}

/** 单次取址结果（ip 为空时 error 说明原因，例如 NAT/CGNAT） */
export interface DdnsIpResult {
  ip: string;
  source: string;
  detail?: string;
  error?: string;
}

export interface DdnsCheckResult {
  ipv4: DdnsIpResult | null;
  ipv6: DdnsIpResult | null;
}

export function getDdns(): Promise<{ config: DdnsConfig; status: DdnsStatus }> {
  return api('/network/ddns');
}

export function saveDdns(body: Record<string, unknown>): Promise<{
  ok: boolean;
  config: DdnsConfig;
  status: DdnsStatus;
}> {
  return api('/network/ddns', { method: 'PUT', body });
}

export function checkDdnsIp(body: Record<string, unknown> = {}): Promise<DdnsCheckResult> {
  return api('/network/ddns/check', { method: 'POST', body });
}

export function runDdns(): Promise<DdnsStatus> {
  return api('/network/ddns/run', { method: 'POST', body: {} });
}

export type FrpMode = 'sakura' | 'upstream';

export interface FrpProxy {
  name: string;
  type: 'tcp' | 'udp';
  localPort: number;
  remotePort: number;
  /** frpc 转发目标：默认 127.0.0.1；局域网实例为那台机器的内网地址 */
  localIP?: string;
}

export interface FrpConfig {
  enabled: boolean;
  mode: FrpMode;
  binaryPath: string;
  sakura: { hasToken: boolean; tunnels: string };
  upstream: {
    serverAddr: string;
    serverPort: number;
    hasToken: boolean;
    /** 樱花访问密钥是否已设置（不回原文） */
    hasUser: boolean;
    /** null = 未显式设置（沿用 frpc 默认 true）；false = 生成配置里写死关 TLS（樱花节点要求） */
    tlsEnable: boolean | null;
    proxies: FrpProxy[];
  };
}

export interface FrpStatus {
  running: boolean;
  pid: number;
  startedAt: number | null;
  mode: string;
  log: string[];
  config: FrpConfig;
  /** running / restarting（退避重连中）/ stopped */
  state: 'running' | 'restarting' | 'stopped';
  /** 本次生命周期内的异常重连次数（稳定运行 30 秒后清零） */
  restarts: number;
  /** 最近一次异常退出（面板重启后仍能说清上次为什么挂的） */
  lastExit: { code: number; signal: string; at: number } | null;
  /** 保存前的提前警示：代理通了面板端口但没开登录保护。PUT/POST 的 status 字段可能不带它 */
  exposure?: {
    panelPort: number;
    mayBeExposed: boolean;
    authEnabled: boolean;
    risky: boolean;
    proxy?: string;
  };
}

export function getFrp(): Promise<FrpStatus> {
  return api('/network/frp');
}

export function saveFrp(body: Record<string, unknown>): Promise<{
  ok: boolean;
  started: boolean;
  error: string;
  config: FrpConfig;
  status: Omit<FrpStatus, 'config'>;
}> {
  return api('/network/frp', { method: 'PUT', body });
}

export function frpAction(action: 'start' | 'stop' | 'restart'): Promise<{ ok: boolean }> {
  return api(`/network/frp/${action}`, { method: 'POST', body: {} });
}

/**
 * 粘贴樱花后台「手动配置」的整段 TOML → 解析并保存进 upstream 段。
 * 只覆盖 upstream，不改 enabled；frpc 正在运行时后端会自动重启应用新配置。
 */
export function importSakuraFrp(text: string): Promise<{
  ok: boolean;
  restarted: boolean;
  error: string;
  tunnelIds: string[];
  config: FrpConfig;
  status: Omit<FrpStatus, 'config'>;
}> {
  return api('/network/frp/import', { method: 'POST', body: { text } });
}

/**
 * 单实例的 frp 端口映射状态（GET /servers/:id/instances/:name/frp）。
 * supported=false 时 reason 说明原因：not-local（远程实例）/ sakura（樱花面板管理）。
 */
export interface InstanceFrpInfo {
  supported: boolean;
  reason: '' | 'not-local' | 'sakura';
  frpEnabled: boolean;
  frpcRunning: boolean;
  mode: string;
  serverAddr: string;
  localPort: number;
  /** frpc 实际连接的目标地址（本机 127.0.0.1；局域网实例为服务器内网 IP） */
  targetHost: string;
  /** 服务器是否在面板可直连的范围（本机/局域网/主机名） */
  lan: boolean;
  bound: boolean;
  remotePort: number;
  publicAddress: string;
  proxyName: string;
}

export function getInstanceFrp(serverId: string, name: string): Promise<InstanceFrpInfo> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(name)}/frp`);
}

/** 保存/解除单实例映射；enabled=false 时忽略 remotePort */
export function saveInstanceFrp(
  serverId: string,
  name: string,
  body: { enabled: boolean; remotePort?: number },
): Promise<{ ok: boolean; restarted: boolean; error?: string } & InstanceFrpInfo> {
  return api(`/servers/${serverId}/instances/${encodeURIComponent(name)}/frp`, {
    method: 'PUT',
    body,
  });
}

