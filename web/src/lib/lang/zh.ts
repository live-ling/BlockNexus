/**
 * 中文语言包 —— **键集的事实来源**。
 *
 * 新增文案的流程：
 *   1. 先在这里加键（命名规范见 docs/iteration-roadmap.md P1-9）
 *   2. 再去 `en.ts` 补同名键 —— 漏了 `tsc` 会报错
 *
 * 命名规范：`<页面>.[<组件>].<部件>`，全部 kebab-case。
 *   · 通用文案放 `common.*`
 *   · 错误提示的组件位固定用 `error`
 *   · 命名的深层含义：它保证「子键一定以父键 + '.' 开头」
 *
 * `{0}` / `{1}` 为占位符，中英两包的占位符名称与顺序必须一致
 * （由 agent/test-error-codes.js 同款思路的守卫在测试里校验）。
 */
export const zh = {
  // ---------- 语言自称（语言选择器用） ----------
  '$lang': '简体中文',

  // ---------- 通用 ----------
  'common.save': '保存',
  'common.saved': '已保存',
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.delete': '删除',
  'common.close': '关闭',
  'common.back': '返回',
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.unknown': '未知',
  'common.language': '语言',

  // ---------- 导航 ----------
  'nav.servers': '服务器',
  'nav.settings': '设置',
  'nav.logout': '退出',

  // ---------- 登录页 ----------
  'login.title': 'BlockNexus',
  'login.subtitle': 'Minecraft 服务器管理面板',
  'login.username': '用户名',
  'login.username.placeholder': '管理员账号',
  'login.password': '密码',
  'login.remember': '记住我',
  'login.remember.tooltip': '记住账号并在关闭浏览器后保持登录',
  'login.submit': '登 录',
  'login.submitting': '登录中…',
  'login.forgot': '忘记密码？',
  'login.error.unauthorized': '用户名或密码错误',

  // ---------- 忘记密码（三段式） ----------
  'login.forgot.title': '重置面板密码',
  'login.forgot.email': '管理员邮箱',
  'login.forgot.email.placeholder': '面板设置中填写的管理员邮箱',
  'login.forgot.send': '发送验证码',
  'login.forgot.resend': '重新发送',
  'login.forgot.resend.countdown': '重新发送（{0}s）',
  // 邮箱不匹配或未配 SMTP 时后端也返回成功（防探测），因此这里措辞不能断言"已发送"
  'login.forgot.sent': '若该邮箱与管理员邮箱一致，验证码已发送，请查收',
  'login.forgot.code': '验证码',
  'login.forgot.code.placeholder': '6 位数字验证码',
  'login.forgot.code.verify': '验证',
  'login.forgot.code.verifying': '校验中…',
  'login.forgot.newPassword': '新密码',
  'login.forgot.newPassword.placeholder': '至少 6 位',
  'login.forgot.reset': '重置密码',
  'login.forgot.reset.busy': '重置中…',
  'login.forgot.done': '密码已重置，请用新密码登录',
  'login.forgot.back': '返回登录',

  // ---------- 控制台 ----------
  'console.title': '控制台',
  'console.status.running': '运行中',
  'console.status.starting': '启动中',
  'console.status.stopped': '已停止',
  'console.status.downloading': '下载中',
  'console.status.failed': '安装失败',
  'console.status.incomplete': '未完成',
  'console.input.placeholder': '输入指令，如 list / say hello（回车发送，↑↓ 翻历史）',
  'console.input.aria': '控制台指令',
  'console.send': '发送指令',
  'console.send.tooltip': '发送（Enter）',
  'console.clear': '清屏',
  'console.empty': '（暂无输出）',
  'console.error.load': '控制台加载失败',
  'console.error.send': '指令发送失败',

  // ---------- 关于页 ----------
  'about.title': '关于',

  // ---------- 服务器列表页 ----------
  'servers.title': '我的服务器',
  'servers.add': '添加服务器',
  'servers.empty.title': '还没有服务器',
  'servers.empty.hint': '点击右上角「添加服务器」，面板会通过 SSH 自动安装 Agent',
  'servers.drag.tooltip': '拖动排序',
  'servers.field.hostname': '主机',
  'servers.field.system': '系统',
  'servers.field.memory': '内存',
  'servers.field.disk': '磁盘',
  'servers.field.online': '在线',
  'servers.java.notInstalled': '未安装',
  'servers.uptime': '已在线 {0}',
  'servers.lastSeen': '最近活跃 {0}',
  'servers.neverOnline': '从未上线',
  'servers.agent.installing': 'Agent 安装中…',
  'servers.agent.offline': 'Agent 离线，暂无系统信息',
  'servers.error.reorder': '排序保存失败：',

  // ---------- 状态徽章 ----------
  'badge.installing': '安装中',
  'badge.agent.online': 'Agent 在线',
  'badge.offline': '离线',
  'badge.online': '在线',
  'badge.latency.tooltip': '面板 → 服务器 实测往返延迟',
  'badge.latency': '延迟 {0}ms',

  // ---------- App 级事件提示 ----------
  'app.agentUpdate.failed': 'Agent 自动更新失败',
  'app.agentUpdate.done': 'Agent 已自动更新',
  'app.agentUpdate.doneDetail': '远端 Agent 现在与面板版本一致',

  // ---------- 服务器详情页 ----------
  'server.detail.settings': '服务器设置',
  'server.detail.instances': 'MC 实例',
  'server.detail.create': '新建实例',
  'server.detail.agentOffline': 'Agent 未连接',
  'server.detail.agentOffline.hint': '请到「服务器设置」安装或重装 Agent',
  'server.detail.empty': '还没有 MC 实例',
  'server.detail.empty.hint': '点击「新建实例」，Agent 会自动从官方源下载对应版本服务端',
  'server.detail.field.core': '核心',
  'server.detail.field.version': '版本',
  'server.detail.field.memory': '内存',
  'server.detail.field.players': '玩家',
  'server.detail.field.uptime': '运行时间',
  'server.detail.field.domain': '域名',
  'server.detail.starting': '启动中…',
  'server.detail.downloading': '正在下载 server.jar… {0}%',
  'server.detail.panelInstall': '面板代下',
  'server.detail.panelInstall.tooltip': '服务器拉不动核心站点时，由面板下载后经加密通道传到服务器',
  'server.detail.retryInstall': '重试安装',
  'server.detail.start': '启动',
  'server.detail.stop': '停止',
  'server.detail.toast.started': '启动指令已发送',
  'server.detail.toast.stopped': '停止指令已发送',
  'server.detail.toast.reinstalled': '已重新开始安装',
  'server.detail.toast.reinstalledDetail': '进度见下方卡片与实例控制台',
  'server.detail.toast.panelTookOver': '面板已接手下载',
  'server.detail.toast.panelTookOverDetail': '面板下载核心后自动传输安装，进度见卡片',
  'server.detail.error.loadInstances': '实例列表获取失败',
  'server.detail.error.agentOfflineCreate': 'Agent 未连接，无法创建实例',
  'server.detail.error.panelInstall': '面板代下失败',
  'server.detail.error.installFailed': '安装失败',

  // ---------- 对话框通用 ----------
  'dialog.cannotConnect': '无法连接',
  'dialog.unknown': '未知',
  'dialog.notInstalled': '未安装',
  'dialog.unnamed': '未命名',

  // ---------- 添加服务器 ----------
  'addServer.title': '添加服务器',
  'addServer.description': '填好主机与 SSH 账号后先点「验证连接」，通过后再保存；保存后进入详情页可一键安装 Agent。',
  'addServer.name': '名称',
  'addServer.name.placeholder': '例如：香港 1 号机',
  'addServer.sshHost': 'SSH 主机',
  'addServer.sshPort': 'SSH 端口',
  'addServer.sshUser': 'SSH 用户（建议 root）',
  'addServer.auth': '认证方式',
  'addServer.auth.password': '密码',
  'addServer.auth.key': '私钥',
  'addServer.sshPassword': 'SSH 密码',
  'addServer.keyPath': '私钥路径（本机文件）或直接粘贴私钥内容',
  'addServer.keyPath.placeholder': 'C:\\Users\\you\\.ssh\\id_ed25519 或 -----BEGIN OPENSSH PRIVATE KEY-----',
  'addServer.check.failed': '✗ 验证失败：{0}',
  'addServer.check.local': '✓ 本机服务器：保存后由面板直接托管 Agent，无需 SSH',
  'addServer.check.ok': '✓ SSH 连接成功（{0}）',
  'addServer.check.system': '系统：{0} · {1}',
  'addServer.check.privilege': '权限：{0}',
  'addServer.check.root': 'root',
  'addServer.check.sudo': '普通用户（免密 sudo）',
  'addServer.check.user': '普通用户',
  'addServer.check.node': 'Node：{0}',
  'addServer.check.java': 'Java：{0}',
  'addServer.mode': '连接方式',
  'addServer.mode.outbound': '面板连接 Agent（推荐，Agent 在公网）',
  'addServer.mode.inbound': 'Agent 连接面板（面板有公网地址时）',
  'addServer.agentPort': 'Agent 端口',
  'addServer.agentPort.hint': 'Agent 会在服务器上监听该端口，面板主动连入；请在服务器安全组/防火墙放行此端口（TCP）。',
  'addServer.tls': '使用 TLS 加密（wss）',
  'addServer.tls.hint': '安装时在服务器上用 openssl 生成自签证书，面板固定其指纹防中间人；应用层本身已有 token 加密，此项用于隐藏传输元数据。',
  'addServer.panelUrl': '面板地址（Agent 回连用）',
  'addServer.panelUrl.hint': '⚠ 必须是远程服务器能访问到本面板的地址；面板在 NAT 后时请填公网地址（frp / Tailscale 等）。',
  'addServer.verify': '验证连接',
  'addServer.verifying': '验证中…',
  'addServer.reverify': '重新验证',
  'addServer.verify.first': '请先通过「验证连接」',
  'addServer.error.hostRequired': '请填写 SSH 主机',
  'addServer.error.passwordRequired': '请填写 SSH 密码',
  'addServer.error.keyRequired': '请填写私钥路径或私钥内容',
  'addServer.error.addFailed': '添加失败',

  // ---------- 编辑服务器 ----------
  'editServer.title': '编辑服务器',
  'editServer.sshPassword': 'SSH 密码（留空不修改）',
  'editServer.mode.outbound': '面板连接 Agent',
  'editServer.mode.inbound': 'Agent 连接面板',
  'editServer.mode.hint': '连接方式建好后不可改；如需更换请删除后重新添加。',
  'editServer.tls.hint': '改动后需重新安装 Agent 才会生效（安装时生成证书并记录指纹）。',
  'editServer.error.saveFailed': '保存失败',

  // ---------- Token ----------
  'token.title': '服务器 Token',
  'token.description': 'Agent 与面板加密通道的共享密钥，请妥善保管。',
  'token.hint': '如怀疑泄露，可在「编辑」旁重置 token（需重新安装/更新远程 agent.json 后生效）。',

  // ---------- 手动安装 Agent ----------
  'manualInstall.title': '手动安装 Agent',
  'manualInstall.description': '适用于 SSH 自动安装失败、或无 root 权限的环境。在目标服务器上执行：',
  'manualInstall.loadFailed': '加载失败：{0}',
  'manualInstall.localOnly.warn': '⚠ 面板当前只监听本机（127.0.0.1），上面第一条 curl 命令在远程服务器上无法访问面板。',
  'manualInstall.localOnly.fix.pre': '请改用「安装 Agent（SSH）」自动部署，或把面板以 ',
  'manualInstall.localOnly.fix.post': ' 启动后再用手工命令。',
  'manualInstall.tls.warn.pre': 'TLS 已启用：请把安装时生成的 ',
  'manualInstall.tls.warn.mid': ' / ',
  'manualInstall.tls.warn.post': ' 放到工作目录，或用自动安装流程。',
  'manualInstall.tokenWarn': 'token 等于服务器控制权，请勿泄露。生产环境建议用 systemd 托管（自动安装流程会自动配置）。',

  // ---------- MSL 署名（MSL 使用条款要求注明来源） ----------
  'msl.credit.pre': '部分核心镜像下载由 ',
  'msl.credit.name': 'MSL 开服器',
  'msl.credit.post': ' 提供（mslmc.cn）',
} as const
