/**
 * 英文语言包。
 *
 * 漏翻任何一个 zh 里存在的键，`i18n.ts` 里的
 * `Record<TranslationKey, string>` 会让 `tsc` 报错。
 * 因此这里**不要**偷懒留中文，也**不要**加 zh 里没有的键。
 */
export const en = {
  // ---------- 语言自称 ----------
  '$lang': 'English',

  // ---------- 通用 ----------
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.back': 'Back',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.unknown': 'Unknown',
  'common.language': 'Language',

  // ---------- 导航 ----------
  'nav.servers': 'Servers',
  'nav.settings': 'Settings',
  'nav.logout': 'Sign out',

  // ---------- 登录页 ----------
  'login.title': 'BlockNexus',
  'login.subtitle': 'Minecraft server management panel',
  'login.username': 'Username',
  'login.username.placeholder': 'Admin account',
  'login.password': 'Password',
  'login.remember': 'Remember me',
  'login.remember.tooltip': 'Remember this account and stay signed in after closing the browser',
  'login.submit': 'Sign in',
  'login.submitting': 'Signing in…',
  'login.forgot': 'Forgot password?',
  'login.error.unauthorized': 'Incorrect username or password',

  // ---------- 忘记密码 ----------
  'login.forgot.title': 'Reset panel password',
  'login.forgot.email': 'Admin email',
  'login.forgot.email.placeholder': 'The admin email configured in panel settings',
  'login.forgot.send': 'Send code',
  'login.forgot.resend': 'Resend',
  'login.forgot.resend.countdown': 'Resend ({0}s)',
  // The backend also reports success when the email does not match (anti-enumeration),
  // so the wording must not assert that a code was actually sent.
  'login.forgot.sent': 'If that address matches the admin email, a code has been sent',
  'login.forgot.code': 'Verification code',
  'login.forgot.code.placeholder': '6-digit code',
  'login.forgot.code.verify': 'Verify',
  'login.forgot.code.verifying': 'Verifying…',
  'login.forgot.newPassword': 'New password',
  'login.forgot.newPassword.placeholder': 'At least 6 characters',
  'login.forgot.reset': 'Reset password',
  'login.forgot.reset.busy': 'Resetting…',
  'login.forgot.done': 'Password reset. Sign in with your new password',
  'login.forgot.back': 'Back to sign in',

  // ---------- 控制台 ----------
  'console.title': 'Console',
  'console.status.running': 'Running',
  'console.status.starting': 'Starting',
  'console.status.stopped': 'Stopped',
  'console.status.downloading': 'Downloading',
  'console.status.failed': 'Install failed',
  'console.status.incomplete': 'Incomplete',
  'console.input.placeholder': 'Enter a command, e.g. list / say hello (Enter to send, ↑↓ for history)',
  'console.input.aria': 'Console command',
  'console.send': 'Send command',
  'console.send.tooltip': 'Send (Enter)',
  'console.clear': 'Clear',
  'console.empty': '(no output yet)',
  'console.error.load': 'Failed to load console',
  'console.error.send': 'Failed to send command',

  // ---------- 关于页 ----------
  'about.title': 'About',

  // ---------- 服务器列表页 ----------
  'servers.title': 'My servers',
  'servers.add': 'Add server',
  'servers.empty.title': 'No servers yet',
  'servers.empty.hint': 'Click “Add server” in the top right; the panel will install the Agent over SSH',
  'servers.drag.tooltip': 'Drag to reorder',
  'servers.field.hostname': 'Host',
  'servers.field.system': 'System',
  'servers.field.memory': 'Memory',
  'servers.field.disk': 'Disk',
  'servers.field.online': 'Online',
  'servers.java.notInstalled': 'Not installed',
  'servers.uptime': 'Up {0}',
  'servers.lastSeen': 'Last seen {0}',
  'servers.neverOnline': 'Never online',
  'servers.agent.installing': 'Installing Agent…',
  'servers.agent.offline': 'Agent offline, no system information',
  'servers.error.reorder': 'Failed to save order: ',

  // ---------- 状态徽章 ----------
  'badge.installing': 'Installing',
  'badge.agent.online': 'Agent online',
  'badge.offline': 'Offline',
  'badge.online': 'Online',
  'badge.latency.tooltip': 'Measured panel → server round-trip latency',
  'badge.latency': 'Latency {0}ms',

  // ---------- App 级事件提示 ----------
  'app.agentUpdate.failed': 'Agent auto-update failed',
  'app.agentUpdate.done': 'Agent updated',
  'app.agentUpdate.doneDetail': 'The remote Agent now matches the panel version',

  // ---------- 服务器详情页 ----------
  'server.detail.settings': 'Server settings',
  'server.detail.instances': 'MC instances',
  'server.detail.create': 'New instance',
  'server.detail.agentOffline': 'Agent offline',
  'server.detail.agentOffline.hint': 'Install or reinstall the Agent in Server settings',
  'server.detail.empty': 'No MC instances yet',
  'server.detail.empty.hint': 'Click “New instance”; the Agent will download the matching server build from the official source',
  'server.detail.field.core': 'Core',
  'server.detail.field.version': 'Version',
  'server.detail.field.memory': 'Memory',
  'server.detail.field.players': 'Players',
  'server.detail.field.uptime': 'Uptime',
  'server.detail.field.domain': 'Domain',
  'server.detail.starting': 'Starting…',
  'server.detail.downloading': 'Downloading server.jar… {0}%',
  'server.detail.panelInstall': 'Panel download',
  'server.detail.panelInstall.tooltip': 'When the server cannot reach the core site, the panel downloads it and transfers it over the encrypted channel',
  'server.detail.retryInstall': 'Retry install',
  'server.detail.start': 'Start',
  'server.detail.stop': 'Stop',
  'server.detail.toast.started': 'Start command sent',
  'server.detail.toast.stopped': 'Stop command sent',
  'server.detail.toast.reinstalled': 'Install restarted',
  'server.detail.toast.reinstalledDetail': 'See the card below and the instance console for progress',
  'server.detail.toast.panelTookOver': 'Panel took over the download',
  'server.detail.toast.panelTookOverDetail': 'The panel will download the core and transfer it automatically; see the card for progress',
  'server.detail.error.loadInstances': 'Failed to load instance list',
  'server.detail.error.agentOfflineCreate': 'Agent offline; cannot create an instance',
  'server.detail.error.panelInstall': 'Panel download failed',
  'server.detail.error.installFailed': 'Install failed',
} as const
