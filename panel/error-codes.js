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
  'auth.reset.code-expired': {
    // 状态码一律沿用改造前的实现（这些路径原本都用 400），不借迁移之机改语义
    status: 400,
    zh: '验证码已过期，请重新获取',
    en: 'The verification code has expired. Request a new one',
  },
  'auth.reset.code-wrong': {
    status: 400,
    zh: '验证码不正确（还可尝试 {left} 次）',
    en: 'Incorrect verification code ({left} attempts left)',
  },
  'auth.reset.verify-too-many': {
    status: 400,
    zh: '验证码尝试次数过多，请重新获取',
    en: 'Too many verification attempts. Request a new code',
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
  'internal.error': {
    status: 500,
    zh: '内部错误',
    en: 'Internal error',
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

/** 该 code 是否在表中 */
function hasErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, String(code));
}

/** 取建议状态码；未知 code 回退 500 */
function statusOf(code, fallback) {
  const e = ERROR_CODES[code];
  return (e && e.status) || fallback || 500;
}

/**
 * 取指定语言的文案；未知 code 返回 null（让调用方决定回退策略）。
 * @param {string} code
 * @param {'zh'|'en'} [lang]
 * @param {Record<string, unknown>} [params]
 */
function messageOf(code, lang, params) {
  const e = ERROR_CODES[code];
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
  renderTemplate,
  hasErrorCode,
  statusOf,
  messageOf,
  errorResponse,
  langOf,
};
