'use strict';
// 错误代码表的结构与行为测试（零依赖）
// 运行：node agent/test-error-codes.js

const path = require('path');
const {
  ERROR_CODES,
  errorResponse,
  hasErrorCode,
  messageOf,
  renderTemplate,
  statusOf,
} = require(path.join(__dirname, '..', 'panel', 'error-codes.js'));

const results = [];
function check(desc, ok, detail) {
  results.push({ desc, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '  → ' + detail : ''}`);
}

const codes = Object.keys(ERROR_CODES);

/** 抽出文案里的占位名（顺序敏感：中英必须一致，否则译文会错位） */
function placeholders(s) {
  return (String(s).match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1));
}

// ---------- 1. 命名约定 ----------
const badNames = codes.filter((c) => !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(c));
check('所有 code 符合 <领域>.<问题> kebab-case 约定', badNames.length === 0, badNames.join(', '));

// ---------- 2. 每条的结构完整 ----------
const badShape = [];
for (const [code, e] of Object.entries(ERROR_CODES)) {
  if (typeof e.status !== 'number' || e.status < 400 || e.status > 599) badShape.push(`${code}: status=${e.status}`);
  if (typeof e.zh !== 'string' || !e.zh.trim()) badShape.push(`${code}: zh 缺失`);
  if (typeof e.en !== 'string' || !e.en.trim()) badShape.push(`${code}: en 缺失`);
}
check('每条都有合法的 4xx/5xx status 与非空 zh/en', badShape.length === 0, badShape.join('; '));

// ---------- 3. 中英占位符必须完全一致（顺序敏感） ----------
const badPh = [];
for (const [code, e] of Object.entries(ERROR_CODES)) {
  const zh = placeholders(e.zh).join(',');
  const en = placeholders(e.en).join(',');
  if (zh !== en) badPh.push(`${code}: zh=[${zh}] en=[${en}]`);
}
check('中英文案的 {占位符} 名称与顺序一致', badPh.length === 0, badPh.join('; '));

// ---------- 4. 不含裸中文以外的异常字符（防止手滑） ----------
const badEn = codes.filter((c) => /[\u4e00-\u9fff]/.test(ERROR_CODES[c].en));
check('英文文案不含中文字符', badEn.length === 0, badEn.join(', '));

// ---------- 5. renderTemplate ----------
check('renderTemplate 替换占位', renderTemplate('a {x} b', { x: 1 }) === 'a 1 b');
check('renderTemplate 缺失参数时保留占位符（可诊断）',
  renderTemplate('a {x} b', {}) === 'a {x} b');
check('renderTemplate 无 params 时原样返回', renderTemplate('a {x}') === 'a {x}');
check('renderTemplate 支持数字 0（不被当成缺值）',
  renderTemplate('{n}', { n: 0 }) === '0');

// ---------- 6. hasErrorCode / statusOf ----------
check('hasErrorCode：已知 code 为真', hasErrorCode('server.not-found'));
check('hasErrorCode：未知 code 为假', !hasErrorCode('nope.nope'));
check('hasErrorCode：不把 Object 原型属性当 code',
  !hasErrorCode('constructor') && !hasErrorCode('toString') && !hasErrorCode('__proto__'));

check('statusOf：表中取建议值', statusOf('server.not-found') === 404);
check('statusOf：未知 code 回退 500', statusOf('nope.nope') === 500);
check('statusOf：未知 code 可用显式 fallback', statusOf('nope.nope', 418) === 418);

// ---------- 7. messageOf ----------
check('messageOf：中文', messageOf('auth.not-logged-in', 'zh') === '未登录');
check('messageOf：英文', messageOf('auth.not-logged-in', 'en') === 'Not signed in');
check('messageOf：缺省语言是中文', messageOf('auth.not-logged-in') === '未登录');
check('messageOf：带参数渲染', messageOf('auth.login-locked', 'zh', { minutes: 5 }) === '尝试次数过多，已锁定 5 分钟');
check('messageOf：英文带参数',
  messageOf('auth.login-locked', 'en', { minutes: 5 }) === 'Too many attempts. Locked for 5 minutes');
check('messageOf：未知 code 返回 null（交由调用方决定回退）', messageOf('nope.nope') === null);

// ---------- 8. errorResponse 过渡期形状 ----------
const r = errorResponse('server.not-found');
check('errorResponse：未指定 status 时取表中建议值', r.status === 404, `status=${r.status}`);
check('errorResponse：body 同时含 error 与 code（兼容旧调用方）',
  r.body.error === '服务器不存在' && r.body.code === 'server.not-found',
  JSON.stringify(r.body));
check('errorResponse：无参数时不带 params 字段', r.body.params === undefined);
const r2 = errorResponse('auth.login-locked', { minutes: 5 });
check('errorResponse：带参数时 error 已渲染',
  r2.body.error === '尝试次数过多，已锁定 5 分钟' && r2.status === 403,
  JSON.stringify(r2.body));
check('errorResponse：不重复回传 params（避免响应体积翻倍）',
  r2.body.params === undefined && Object.keys(r2.body).length === 2,
  JSON.stringify(r2.body));

const r3 = errorResponse('nope.nope');
check('errorResponse：未知 code 回退成 code 本身（绝不空白）',
  r3.body.error === 'nope.nope' && r3.body.code === 'nope.nope' && r3.status === 500,
  JSON.stringify(r3.body));

const r4 = errorResponse('server.not-found', undefined, { status: 410 });
check('errorResponse：显式 status 覆盖表值', r4.status === 410);

const r5 = errorResponse('auth.not-logged-in', undefined, { lang: 'en' });
check('errorResponse：可指定语言', r5.body.error === 'Not signed in');

const r6 = errorResponse('auth.login-locked', { minutes: 5 }, { lang: 'en' });
check('errorResponse：英文 + 参数', r6.body.error === 'Too many attempts. Locked for 5 minutes');

// ---------- 9. 覆盖面提示（不是失败，只是可读性） ----------
console.log(`\n表中 code 总数：${codes.length}`);
const byStatus = {};
for (const e of Object.values(ERROR_CODES)) byStatus[e.status] = (byStatus[e.status] || 0) + 1;
console.log('按状态码分布：', JSON.stringify(byStatus));

// ---------- 汇总 ----------
const pass = results.filter((x) => x.ok).length;
console.log(`\n${pass}/${results.length} error-codes cases passed`);
if (pass !== results.length) {
  console.log('失败项：');
  for (const x of results) if (!x.ok) console.log(`  · ${x.desc}${x.detail ? ' → ' + x.detail : ''}`);
  process.exit(1);
}
process.exit(0);
