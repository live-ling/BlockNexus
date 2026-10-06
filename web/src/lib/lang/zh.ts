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
} as const
