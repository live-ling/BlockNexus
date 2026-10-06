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
} as const
