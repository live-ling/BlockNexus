'use strict';
// 错误代码表：面板所有面向用户的错误文案的**唯一来源**。
//
// 设计目标（低耦合）：
//   1. 后端只回「code + 参数」，不再拼中文；前端按当前语言查表渲染。
//      → 文案改动不必动业务代码，后端也不需要知道用户说什么语言。
//   2. 过渡期兼容：响应里同时保留 `error` 字段（已渲染好的文案），
//      这样任何不认 code 的调用方（旧前端缓存、第三方脚本）都不会白屏。
//   3. 表是纯数据，零依赖、无副作用，可直接被测试与前端复用。
//
// 命名约定：<领域>.<问题>，kebab-case。领域取自现有路由分组：
//   auth / panel / settings / notification / ai / server / instance /
//   file / upload / config / internal
//
// params：文案里的 {name} 占位由调用方通过 params 传入。**不要**把变量拼进 code。
//
// 注意：`error` 字段的文案在此处集中维护；后端代码里不要再写裸中文错误字符串。

/**
 * @typedef {Object} ErrorCodeEntry
 * @property {number} status  建议的 HTTP 状态码
 * @property {string} zh      中文文案（{name} 为占位符）
 * @property {string} en      英文文案（占位符与中文保持一致）
 */

/** @type {Record<string, ErrorCodeEntry>} */
const ERROR_CODES = {
  // ---------- 认证 / 会话 ----------
  'auth.not-logged-in': {
    status: 401,
    zh: '未登录',
    en: 'Not signed in',
  },
  'auth.too-many-attempts': {
    status: 429,
    zh: '尝试次数过多，请 {seconds} 秒后再试',
    en: 'Too many attempts. Try again in {seconds} seconds',
  },
  'auth.too-many-attempts-minutes': {
    status: 429,
    zh: '尝试次数过多，请 {minutes} 分钟后再试',
    en: 'Too many attempts. Try again in {minutes} minutes',
  },
  'auth.login-locked': {
    status: 403,
    zh: '尝试次数过多，已锁定 {minutes} 分钟',
    en: 'Too many attempts. Locked for {minutes} minutes',
  },
  'auth.bad-credentials': {
    status: 403,
    zh: '用户名或密码错误',
    en: 'Incorrect username or password',
  },
  'auth.bad-credentials-with-left': {
    status: 403,
    zh: '用户名或密码错误（还可尝试 {left} 次）',
    en: 'Incorrect username or password ({left} attempts left)',
  },
  'auth.username-invalid': {
    status: 400,
    zh: '用户名需 3-40 位，可用字母数字与 _ . @ -',
    en: 'Username must be 3-40 characters: letters, digits and _ . @ -',
  },
  'auth.password-too-short': {
    status: 400,
    zh: '密码至少 6 位',
    en: 'Password must be at least 6 characters',
  },
  'auth.password-too-short-for-protection': {
    status: 400,
    zh: '启用密码保护需要至少 6 位的密码',
    en: 'Enabling password protection requires a password of at least 6 characters',
  },

  // ---------- 找回密码（三段式 OTP） ----------
  'auth.reset.email-format-invalid': {
    status: 400,
    zh: '邮箱格式不正确',
    en: 'Invalid email address',
  },
  'auth.reset.send-too-frequent': {
    status: 429,
    zh: '发送过于频繁，请 {minutes} 分钟后再试',
    en: 'Sending too frequently. Try again in {minutes} minutes',
  },
  'auth.reset.cooldown': {
    status: 429,
    zh: '请 {seconds} 秒后再试',
    en: 'Please wait {seconds} seconds',
  },
  // 验证码错误的**唯一**响应。
  //
  // 为什么把原先三条（code-expired / code-wrong / verify-too-many）合并成一条：
  // 它们各自都是「此刻是否有一张验证码在途」的**预言机**，而未认证攻击者
  // 可以用它反推管理员邮箱是否匹配：
  //   ① POST /forgot-password 换候选邮箱 → 只有匹配时才会生成验证码
  //   ② POST /verify-reset-code 发一个错码
  //   ③ 响应若是 code-wrong（而非 code-expired），说明**确实有码在途** → 邮箱命中
  // 同理 verify-too-many 只可能在「有码」时触发（无码时根本不会累加全局计数）。
  // 合并后三者不可区分，且有码/无码、是否已作废都收敛到同一条文案。
  // 状态码沿用改造前的 400，不借机改语义。
  'auth.reset.code-invalid': {
    status: 400,
    zh: '验证码不正确或已失效，请重新获取',
    en: 'The verification code is incorrect or has expired. Request a new one',
  },
  'auth.reset.ticket-invalid': {
    status: 400,
    zh: '验证已失效，请先获取并验证邮箱验证码',
    en: 'Verification expired. Request and verify an email code first',
  },
  'auth.reset.relock-15min': {
    status: 429,
    zh: '尝试次数过多，已锁定 15 分钟，请稍后再试',
    en: 'Too many attempts. Locked for 15 minutes',
  },

  // ---------- 面板设置 ----------
  'panel.not-local-server': {
    status: 400,
    zh: '该服务器不是本机服务器',
    en: 'This is not a local server',
  },
  'settings.smtp-incomplete': {
    status: 400,
    zh: '请先填写 SMTP 服务器、用户名与密码并保存',
    en: 'Fill in and save the SMTP host, username and password first',
  },
  'settings.admin-email-missing': {
    status: 400,
    zh: '请先在「通知设置」中填写管理员邮箱',
    en: 'Set the admin email in Notification settings first',
  },
  'settings.update-invalid': {
    status: 400,
    zh: '更新策略取值非法（只能是 off / notify / auto）',
    en: 'Invalid update policy (must be off / notify / auto)',
  },
  'settings.update-source-invalid': {
    status: 400,
    zh: '更新下载源必须是 https 地址（留空 = 直连 GitHub）',
    en: 'The update download source must be an https URL (leave empty to use GitHub directly)',
  },
  'notification.send-failed': {
    status: 502,
    zh: '邮件发送失败：{detail}',
    en: 'Failed to send email: {detail}',
  },

  // ---------- AI 日志分析 ----------
  'ai.disabled': {
    status: 400,
    zh: 'AI 日志分析未启用，请先在面板设置中开启',
    en: 'AI log analysis is disabled. Enable it in panel settings first',
  },
  'ai.config-incomplete': {
    status: 400,
    zh: '请先在面板设置中填写 AI 接口密钥与模型',
    en: 'Set the AI API key and model in panel settings first',
  },
  'ai.connection-incomplete': {
    status: 400,
    zh: '请先填写接口地址与密钥',
    en: 'Fill in the endpoint URL and API key first',
  },
  'ai.connection-incomplete-with-model': {
    status: 400,
    zh: '请先填写接口地址、密钥与模型',
    en: 'Fill in the endpoint URL, API key and model first',
  },
  'ai.url-invalid': {
    status: 400,
    zh: '接口地址需以 http:// 或 https:// 开头',
    en: 'The endpoint URL must start with http:// or https://',
  },
  'ai.no-logs': {
    status: 400,
    zh: '当前没有可分析的日志（实例可能未运行过）',
    en: 'No logs available to analyse (the instance may never have run)',
  },
  'ai.connect-failed': {
    status: 502,
    zh: '连接失败：{detail}',
    en: 'Connection failed: {detail}',
  },
  'ai.models-failed': {
    status: 502,
    zh: '查询模型失败：{detail}',
    en: 'Failed to list models: {detail}',
  },

  // ---------- 服务器 ----------
  'server.not-found': {
    status: 404,
    zh: '服务器不存在',
    en: 'Server not found',
  },
  'server.host-required': {
    status: 400,
    zh: '缺少主机地址',
    en: 'Host address is required',
  },
  'server.host-invalid': {
    status: 400,
    zh: '主机地址格式无效（需为 IP 或主机名）',
    en: 'Invalid host (must be an IP address or hostname)',
  },
  'server.panel-url-required': {
    status: 400,
    zh: '该服务器使用「Agent 回连面板」模式，需要填写面板地址',
    en: 'This server uses Agent-connects-to-panel mode, so the panel URL is required',
  },
  'server.install-in-progress': {
    status: 409,
    zh: '该服务器正在安装中',
    en: 'This server is currently being installed',
  },
  'server.install-busy': {
    status: 409,
    zh: '该服务器正在执行安装/卸载任务',
    en: 'An install or uninstall task is already running for this server',
  },
  'server.agent-offline-panel-install': {
    status: 502,
    zh: 'Agent 未连接，无法面板代下',
    en: 'Agent is offline; cannot download on behalf of the panel',
  },
  'server.agent-installing-no-panel-install': {
    status: 409,
    zh: 'Agent 正在安装中，无需面板代下',
    en: 'Agent is already installing; no panel-side download needed',
  },

  // ---------- 快速添加（添加服务器 → 装 Agent → 建实例 → 开服，一条龙） ----------
  'server.quick-credentials-required': {
    status: 400,
    zh: '快速添加远程服务器需要 SSH 密码或私钥（本机服务器请把主机填 127.0.0.1）',
    en: 'Quick add on a remote host needs an SSH password or private key (use 127.0.0.1 for the local machine)',
  },
  'server.quick-eula-required': {
    status: 400,
    zh: '请先阅读并同意 Minecraft EULA',
    en: 'You must accept the Minecraft EULA first',
  },
  'server.quick-running': {
    status: 409,
    zh: '该服务器正在执行快速添加，请等它结束',
    en: 'Quick add is already running for this server',
  },

  // ---------- 网络助手：DDNS / frp ----------
  'network.ddns-domain-invalid': {
    status: 400,
    zh: '域名格式无效（只填主机名，如 mc.example.com）',
    en: 'Invalid domain (enter a hostname only, e.g. mc.example.com)',
  },
  'network.ddns-domain-required': {
    status: 400,
    zh: '请填写要同步的域名',
    en: 'A domain to update is required',
  },
  'network.ddns-ip-family-required': {
    status: 400,
    zh: 'IPv4 与 IPv6 至少要选一项',
    en: 'Select at least one of IPv4 / IPv6',
  },
  'network.ddns-command-required': {
    status: 400,
    zh: '取址方式为「命令」时必须填写命令',
    en: 'A command is required when the IP source is "command"',
  },
  'network.ddns-url-invalid': {
    status: 400,
    zh: 'URL 必须以 http:// 或 https:// 开头',
    en: 'URL must start with http:// or https://',
  },
  'network.ddns-credentials-required': {
    status: 400,
    zh: '请先填写 {provider} 的凭据',
    en: 'Credentials for {provider} are required',
  },
  'network.frp-binary-required': {
    status: 400,
    zh: '请填写 frpc 可执行文件路径（面板不内置二进制）',
    en: 'The frpc executable path is required (the panel does not bundle it)',
  },
  'network.frp-binary-missing': {
    status: 400,
    zh: '找不到 frpc 可执行文件：{path}',
    en: 'frpc executable not found: {path}',
  },
  'network.frp-credentials-required': {
    status: 400,
    zh: '缺少 {mode} 的访问密钥',
    en: 'Access token for {mode} is required',
  },
  'network.frp-tunnels-required': {
    status: 400,
    zh: '请填写至少一个隧道 ID（逗号分隔）',
    en: 'At least one tunnel ID is required (comma separated)',
  },
  'network.frp-server-required': {
    status: 400,
    zh: '请填写 frps 服务器地址',
    en: 'The frps server address is required',
  },
  'network.frp-proxies-required': {
    status: 400,
    zh: '请至少添加一条代理（本地端口 → 远程端口）',
    en: 'Add at least one proxy (local port to remote port)',
  },
  'network.frp-proxies-too-many': {
    status: 400,
    zh: '代理数量过多（最多 50 条）',
    en: 'Too many proxies (50 at most)',
  },
  'network.frp-proxy-name-invalid': {
    status: 400,
    zh: '代理名 {name} 无效（字母数字开头，可用 _ . -，最多 64 位）',
    en: 'Invalid proxy name {name} (start with a letter/digit; _ . - allowed; up to 64 chars)',
  },
  'network.frp-port-invalid': {
    status: 400,
    zh: '端口 {port} 无效（需为 1-65535 的整数）',
    en: 'Invalid port {port} (an integer between 1 and 65535)',
  },
  'network.frp-localip-invalid': {
    status: 400,
    zh: '转发目标地址 {ip} 无效（填 IP 或主机名）',
    en: 'Invalid forward target {ip} (use an IP or hostname)',
  },
  'network.frp-busy': {
    status: 409,
    zh: 'frp 正在执行上一步操作，请稍后再试',
    en: 'frp is still processing the previous operation',
  },
  'network.frp-disabled': {
    status: 400,
    zh: '请先启用 frp 并保存配置',
    en: 'Enable frp and save the configuration first',
  },
  'network.frp-start-failed': {
    status: 500,
    zh: 'frpc 启动失败：{detail}',
    en: 'frpc failed to start: {detail}',
  },

  // ---------- 单实例 frp 端口映射 ----------
  'frp.not-local': {
    status: 400,
    zh: '该实例在远程服务器上：面板托管的 frpc 只能转发面板本机的端口',
    en: 'This instance lives on a remote server; the panel-hosted frpc can only forward ports on the panel machine',
  },
  'frp.sakura-manual': {
    status: 400,
    zh: 'SakuraFrp 模式的隧道在樱花面板里管理，不能在这里设置公网端口',
    en: 'SakuraFrp tunnels are managed in the SakuraFrp dashboard; the public port cannot be set here',
  },
  'frp.disabled': {
    status: 400,
    zh: 'frp 还没启用：请先在「面板设置 → frp 内网穿透」里启用',
    en: 'frp is not enabled yet: enable it in Panel settings → frp tunnel first',
  },
  'frp.instance-not-found': {
    status: 404,
    zh: '实例不存在或还没就绪',
    en: 'The instance does not exist or is not ready',
  },
  'frp.remote-port-invalid': {
    status: 400,
    zh: '公网端口无效（需为 1-65535 的整数）',
    en: 'Invalid public port (an integer between 1 and 65535)',
  },
  'frp.port-in-use': {
    status: 409,
    zh: '公网端口 {port} 已被其它隧道占用',
    en: 'Public port {port} is already used by another tunnel',
  },

  // ---------- 实例 ----------
  'instance.not-found': {
    status: 404,
    zh: '实例不存在',
    en: 'Instance not found',
  },
  'instance.ids-required': {
    status: 400,
    zh: '缺少 ids 数组',
    en: 'Missing the ids array',
  },
  'instance.upload-core-manual': {
    status: 400,
    zh: '上传型实例请在文件管理里直接上传 server.jar',
    en: 'For upload-based instances, upload server.jar in the file manager instead',
  },
  'instance.name-invalid': {
    status: 400,
    zh: '实例名格式无效',
    en: 'Invalid instance name',
  },
  // ---------- 实例：快速添加的参数与结果 ----------
  'instance.quick-source-invalid': {
    status: 400,
    zh: '快速添加不支持该核心类型：{source}（可选 Paper/Vanilla/Purpur/Folia/Fabric/Forge/NeoForge）',
    en: 'Quick add does not support this core type: {source} (use Paper/Vanilla/Purpur/Folia/Fabric/Forge/NeoForge)',
  },
  'instance.quick-memory-range': {
    status: 400,
    zh: '内存需在 512 - 32768 MB 之间',
    en: 'Memory must be between 512 and 32768 MB',
  },
  'instance.quick-port-range': {
    status: 400,
    zh: '端口需在 1024 - 65535 之间',
    en: 'Port must be between 1024 and 65535',
  },
  'instance.quick-catalog-missing': {
    status: 502,
    zh: '拉取 {source} 的版本清单失败，请稍后重试，或改用「新建实例」手动选版本',
    en: 'Could not fetch the {source} version list. Retry later or create the instance manually',
  },
  'instance.quick-version-invalid': {
    status: 400,
    zh: '该核心没有 {version} 这个版本',
    en: 'That core has no version {version}',
  },
  'instance.quick-timeout': {
    status: 504,
    zh: '等待实例就绪超时（{seconds} 秒），请到服务器详情页查看进度',
    en: 'Timed out waiting for the instance to become ready ({seconds}s); check the server page for progress',
  },
  'instance.quick-start-failed': {
    status: 500,
    zh: '实例已创建，但启动后立刻退出：{reason}',
    en: 'The instance was created but exited right after starting: {reason}',
  },

  // ---------- 地图（P4-1） ----------
  'map.save-invalid': {
    status: 400,
    zh: '存档名格式无效',
    en: 'Invalid save name',
  },
  'map.coord-invalid': {
    status: 400,
    zh: '区域坐标无效',
    en: 'Invalid region coordinates',
  },
  'map.save-not-found': {
    status: 404,
    zh: '该存档没有可显示的地图数据',
    en: 'No map data for this save',
  },
  'map.region-not-found': {
    status: 404,
    zh: '该区域没有地图数据',
    en: 'No map data for this region',
  },

  // ---------- 请求 / 文件 / 上传 ----------
  'request.json-required': {
    status: 415,
    zh: '需要 application/json',
    en: 'Content-Type application/json is required',
  },
  // 下面两条由 server.js 的 **app 级**错误中间件产出。
  // 必须有它们，否则畸形 body 会落到 Express 内置默认处理器，
  // 在非 production 下把完整堆栈（含安装绝对路径）回给未认证调用方。
  'request.body-invalid': {
    status: 400,
    zh: '请求体不是合法的 JSON',
    en: 'Request body is not valid JSON',
  },
  'request.body-too-large': {
    status: 413,
    zh: '请求体过大',
    en: 'Request body is too large',
  },
  'file.upload-out-of-order': {
    status: 409,
    zh: '分块乱序',
    en: 'Upload chunks arrived out of order',
  },

  // ---------- 静态资源 ----------
  'internal.license-missing': {
    status: 404,
    zh: 'LICENSE 未随面板部署',
    en: 'LICENSE was not deployed with the panel',
  },

  // ---------- Agent 通道（由集中式错误中间件产出） ----------
  'agent.offline': {
    status: 502,
    zh: 'Agent 未连接',
    en: 'Agent is offline',
  },
  'agent.timeout': {
    status: 504,
    zh: 'Agent 响应超时',
    en: 'Agent timed out',
  },
  // ---------- 面板自更新（panel/update.js 的判定 + api.js 的接口） ----------
  // 这些 code 有两个用途：接口出错时直接作为 error 文案；以及作为「为什么不能自更新 /
  // 为什么没有自动更新」的原因（前端原样显示后端渲染好的文本，避免同一批文案在两边各写一份）。
  'update.disabled-dirty': {
    status: 403,
    zh: '当前是源码工作区且有未提交改动，应用内更新已禁用（请手动 git pull 或先提交改动）',
    en: 'This is a source checkout with uncommitted changes; in-app update is disabled (use git pull, or commit first)',
  },
  'update.disabled-unknown': {
    status: 403,
    zh: '无法判断当前安装形态，应用内更新已禁用（请手动下载便携包更新）',
    en: 'Cannot determine how this copy was installed; in-app update is disabled (update manually from the portable package)',
  },
  'update.disabled-git-unknown': {
    status: 403,
    zh: '检出了 git 工作区，但无法确认它是否干净（git 不可用或被拦截），应用内更新已禁用',
    en: 'A git working tree was detected but its status could not be checked (git unavailable or blocked); in-app update is disabled',
  },
  'update.disabled-exposed': {
    status: 403,
    zh: '面板对外可访问且未开启登录保护，出于安全考虑不允许触发更新',
    en: 'The panel is reachable from the network without login protection; updating is blocked for safety',
  },
  'update.version-not-newer': {
    status: 400,
    zh: '目标版本不比当前版本新',
    en: 'The target version is not newer than the current one',
  },
  'update.confirm-mismatch': {
    status: 400,
    zh: '确认参数与目标版本不一致，更新未执行',
    en: 'The confirmation does not match the target version; nothing was updated',
  },
  'update.busy': {
    status: 409,
    zh: '有实例启停 / 备份 / 安装任务在进行，稍后再试',
    en: 'An instance operation, backup or install is in progress; try again later',
  },
  'update.no-release': {
    status: 502,
    zh: '读取 Release 信息失败（网络或 GitHub 限流），稍后再试',
    en: 'Could not read the release info (network or GitHub rate limit); try again later',
  },
  'update.meta-invalid': {
    status: 502,
    zh: '该 Release 缺少可用的更新元数据（update.json）',
    en: 'This release has no usable update metadata (update.json)',
  },
  'update.asset-missing': {
    status: 502,
    zh: '该 Release 里找不到需要的更新包',
    en: 'The required update package is missing from this release',
  },
  'update.asset-too-large': {
    status: 400,
    zh: '更新包超出大小上限（{limit} MB），已中止',
    en: 'The update package exceeds the size limit ({limit} MB); aborted',
  },
  'update.checksum-missing': {
    status: 502,
    zh: '该 Release 没有提供校验值，拒绝更新（无法验证完整性）',
    en: 'This release provides no checksum; refusing to update (integrity cannot be verified)',
  },
  'update.download-failed': {
    status: 502,
    zh: '更新包下载失败：{error}',
    en: 'Failed to download the update package: {error}',
  },
  'update.hash-mismatch': {
    status: 400,
    zh: '更新包校验值不匹配，已丢弃（可能被篡改或传输损坏）',
    en: 'Update package checksum mismatch; discarded (tampered or corrupted in transit)',
  },
  'update.unsupported-payload': {
    status: 400,
    zh: '当前安装形态不支持这种更新方式',
    en: 'This installation cannot be updated this way',
  },
  'update.stage-invalid': {
    status: 500,
    zh: '更新包内容异常（路径不安全或缺少关键文件），已中止',
    en: 'The update package is invalid (unsafe path or missing files); aborted',
  },
  'update.needs-bridge': {
    status: 400,
    zh: '跨版本差距过大，需先升级到 v{version} 再继续',
    en: 'The version gap is too large; update to v{version} first',
  },
  'update.needs-manual': {
    status: 400,
    zh: '该版本需要手动升级：下载便携包后保留 data/ 目录覆盖程序文件',
    en: 'This version needs a manual upgrade: download the portable package and replace the program files, keeping data/',
  },
  'update.needs-full-package': {
    status: 400,
    zh: '该版本改动了依赖或外壳组件，需要完整便携包（应用包不适用）',
    en: 'This version changes dependencies or the shell, so the full portable package is required',
  },
  'update.irreversible-confirm': {
    status: 400,
    zh: '该版本包含不可逆的数据迁移，需要显式确认后才能更新',
    en: 'This version includes an irreversible data migration and needs explicit confirmation',
  },
  'update.node-too-old': {
    status: 400,
    zh: '该版本需要 Node.js {version} 或更高版本',
    en: 'This version requires Node.js {version} or newer',
  },
  'update.apply-failed': {
    status: 500,
    zh: '应用更新失败：{error}',
    en: 'Failed to apply the update: {error}',
  },
  'update.rollback-no-backup': {
    status: 404,
    zh: '没有可用的回滚备份',
    en: 'No rollback backup available',
  },
  'update.rollback-refused': {
    status: 400,
    zh: '该版本包含不可逆的数据迁移，不能自动回滚（备份仍保留在 data/update/backup）',
    en: 'This version migrated data irreversibly, so rollback is not allowed (backups are kept in data/update/backup)',
  },
  'update.rollback-failed': {
    status: 500,
    zh: '回滚失败：{error}',
    en: 'Rollback failed: {error}',
  },
  // ---- 数据迁移（panel/migrate.js） ----
  'update.migrate-downgrade': {
    status: 400,
    zh: '数据 schema 比程序更新（疑似降级），拒绝迁移',
    en: 'The data schema is newer than the program (looks like a downgrade); migration refused',
  },
  'update.migrate-unsupported': {
    status: 400,
    zh: '数据 schema 过旧，超出本版迁移链的范围，请先升级到中间版本',
    en: 'The data schema is too old for this version\'s migration chain; upgrade through an intermediate version first',
  },
  'update.migrate-failed': {
    status: 500,
    zh: '数据迁移失败，已保留备份并拒绝启动（详见日志）',
    en: 'Data migration failed; a backup was kept and startup was refused (see the log)',
  },
  'internal.error': {
    status: 500,
    zh: '内部错误',
    en: 'Internal error',
  },
};

/**
 * **非 HTTP 错误**的文案表：更新策略的"为什么没自动更新"、升级预览警告、成功提示。
 * 与 ERROR_CODES 同形（{zh,en}），但不带 status——它们不是"出错"，只是要按当前语言
 * 渲染给用户的一段文本（接口把它们渲染好随响应返回，前端直接显示）。
 * 共用 messageOf()：同一批文案只在这一处维护。
 * @type {Record<string, {zh: string, en: string}>}
 */
const REASON_CODES = {
  'update.meta-missing': {
    zh: '该 Release 没有更新元数据（update.json），兼容性未知——按"需要人工确认"处理',
    en: 'This release has no update metadata (update.json); compatibility is unknown, so it needs manual confirmation',
  },
  'update.rollback-ok': {
    zh: '已回滚到 {version}',
    en: 'Rolled back to {version}',
  },
  'update.auto-not-declared': {
    zh: '该版本未声明可自动安装，需手动确认',
    en: 'This release is not marked as safe to auto-install; manual confirmation required',
  },
  'update.auto-severity': {
    zh: '只有安全 / 严重更新会自动安装',
    en: 'Only security or critical updates are installed automatically',
  },
  'update.auto-breaking': {
    zh: '该版本含破坏性变更，不自动安装',
    en: 'This release has breaking changes; not installed automatically',
  },
  'update.auto-agent-reinstall': {
    zh: '该版本需要手动重装部分 Agent，不自动安装',
    en: 'This release requires manually reinstalling some Agents; not installed automatically',
  },
  'update.auto-irreversible': {
    zh: '该版本含不可逆迁移，不自动安装',
    en: 'This release includes an irreversible migration; not installed automatically',
  },
  'update.auto-backoff': {
    zh: '之前连续更新失败，已暂停自动更新（可在设置页手动更新）',
    en: 'Previous automatic updates failed repeatedly; auto-update is paused (use the manual button)',
  },
  'update.auto-cooldown': {
    zh: '24 小时内已尝试过，暂不重复',
    en: 'Already attempted within the last 24 hours',
  },
  // 升级预览里给用户看的警告
  'update.warn-breaking': {
    zh: '该版本含破坏性变更',
    en: 'This release contains breaking changes',
  },
  'update.warn-irreversible': {
    zh: '该版本的数据迁移不可逆（升级后不能自动回滚）',
    en: 'Its data migration is irreversible (no automatic rollback afterwards)',
  },
  'update.warn-agent-reinstall': {
    zh: '该版本需要手动重装部分 Agent',
    en: 'Some Agents must be reinstalled manually after this update',
  },
};

/**
 * 渲染文案：把 {name} 占位换成 params 里的值。
 * 缺失的参数保留原占位符（可见即知缺哪个参数，便于排查）。
 * @param {string} template
 * @param {Record<string, unknown>} [params]
 */
function renderTemplate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const v = params[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** 该 code 是否在错误表中 */
function hasErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, String(code));
}

/** 该 code 是否在「非错误文案」表中（更新策略原因 / 警告 / 成功提示） */
function hasReasonCode(code) {
  return Object.prototype.hasOwnProperty.call(REASON_CODES, String(code));
}

/** 取建议状态码；未知 code 回退 500（REASON_CODES 不是错误，不参与状态码） */
function statusOf(code, fallback) {
  const e = ERROR_CODES[code];
  return (e && e.status) || fallback || 500;
}

/**
 * 取指定语言的文案；未知 code 返回 null（让调用方决定回退策略）。
 * 两张表共用：ERROR_CODES（HTTP 错误）与 REASON_CODES（非错误的原因/警告/成功提示）。
 * @param {string} code
 * @param {'zh'|'en'} [lang]
 * @param {Record<string, unknown>} [params]
 */
function messageOf(code, lang, params) {
  const e = ERROR_CODES[code] || REASON_CODES[code];
  if (!e) return null;
  const template = lang === 'en' ? e.en : e.zh;
  return renderTemplate(template, params);
}

/**
 * 构造错误响应体。**过渡期形状**：同时给出 code 与传统 error 字符串，
 * 因此不认 code 的调用方仍能正常显示文案。
 *
 * 只回 code（不回 params）：前端拿到 code 后能自行本地化，
 * 参数已渲染进 error 文案里 —— 再回一份 params 只会让每个错误响应体积翻倍。
 *
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @param {{ status?: number, lang?: 'zh'|'en' }} [opts]
 * @returns {{ status: number, body: { error: string, code: string } }}
 */
function errorResponse(code, params, opts = {}) {
  const known = hasErrorCode(code);
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const status = opts.status || statusOf(code, 500);
  // 未知 code：直接把 code 当作文案返回，绝不返回空白——可见即知缺哪个 code
  const text = known ? messageOf(code, lang, params) : String(code);
  return { status, body: { error: text, code: String(code) } };
}

/**
 * 从 Accept-Language 判断用哪种语言渲染 error 文案。
 *
 * 面板的语言设置存在浏览器 localStorage，后端无从得知，因此由前端把它作为请求头带上来。
 * 不做内容协商的复杂处理（q 值、通配符）：只认「是否以 en 开头」，其余一律中文。
 *
 * 放在本模块而不是 api.js：它与「code → 本地化文案」是同一件事，
 * 且 panel/http-errors.js 的 app 级兜底中间件也要用**同一个**规则
 * ——分两处迟早会出现「错误码按 A 规则判语言、兜底中间件按 B 规则判」。
 *
 * 注意：`error` 只是**给不认 code 的调用方的兜底文案**；
 * 认 code 的调用方应当自行本地化，那时 error 文案是什么语言都无所谓。
 */
function langOf(req) {
  const al = String((req && req.headers && req.headers['accept-language']) || '');
  return /^\s*en\b/i.test(al) ? 'en' : 'zh';
}

module.exports = {
  ERROR_CODES,
  REASON_CODES,
  renderTemplate,
  hasErrorCode,
  hasReasonCode,
  statusOf,
  messageOf,
  errorResponse,
  langOf,
};
