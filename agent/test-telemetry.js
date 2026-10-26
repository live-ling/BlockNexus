'use strict';
// panel/telemetry.js 的回归测试（零依赖，假 fetch，不需要网络）
//
// 这个测试文件和别的不太一样：**它测的主要内容是「什么不该被发出去」**。
// 遥测功能写错不难，难的是悄悄把用户的 IP / 域名 / 路径 / 密钥带出去——
// 那种泄露一旦到了服务端就不可逆。所以这里除了正常功能，大量用例是「喂进去脏数据，
// 断言 buildPayload 拒绝、assertPayloadSafe 命中、send 不发」。
//
// 运行：node agent/test-telemetry.js

const path = require('path');
const T = require(path.join(__dirname, '..', 'panel', 'telemetry.js'));

let pass = 0;
let total = 0;
function ok(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${!cond && detail ? ' — ' + detail : ''}`);
}
function eq(name, got, want) {
  total++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const good = g === w;
  if (good) pass++;
  console.log(`${good ? 'PASS' : 'FAIL'} | ${name} → ${g}（期望 ${w}）`);
}

// ---------- 1. 默认值：必须 opt-in（开关默认关；端点默认官方接收端，无需手填） ----------
ok('默认关闭（opt-in 是硬约定）', T.DEFAULTS.enabled === false);
ok('默认端点是官方接收端（用户开开关即可用）',
  T.DEFAULTS.endpoint === 'https://api-blocknexus.liveling.top/telemetry', T.DEFAULTS.endpoint);
ok('默认端点本身必须通过端点校验（否则开关打开也发不出去）',
  T.normalizeEndpoint(T.DEFAULTS.endpoint) === T.DEFAULTS.endpoint);
ok('默认没有 instanceId', T.DEFAULTS.instanceId === '');
ok('默认间隔 24 小时', T.DEFAULTS.intervalSec === 24 * 3600);
// 隐私核心不变：默认关闭时 shouldSend 必须拒绝
ok('默认设置下 shouldSend 拒绝发送（enabled=false）',
  T.shouldSend(T.DEFAULTS, { now: Date.now(), lastSentAt: 0, failures: 0 }).reason === 'disabled');

// ---------- 2. 分桶（不上报精确值） ----------
eq('bucket: 0 / 负数 / 非数字 → "0"', [T.bucket(0), T.bucket(-1), T.bucket('x'), T.bucket(undefined)], ['0', '0', '0', '0']);
eq('bucket: 1', T.bucket(1), '1');
eq('bucket: 2..5', [T.bucket(2), T.bucket(5)], ['2-5', '2-5']);
eq('bucket: 6..20', [T.bucket(6), T.bucket(20)], ['6-20', '6-20']);
eq('bucket: 21+', T.bucket(21), '20+');
ok('bucket: 精确数量不出现在结果里（只给区间）', !JSON.stringify(T.bucket(37)).includes('37'));

// ---------- 3. 版本号校验 ----------
eq('version: 正常三段', T.version('0.6.0'), '0.6.0');
eq('version: 去 v 前缀', T.version('v1.2.3'), '1.2.3');
eq('version: 预发布后缀保留', T.version('0.7.0-beta.1'), '0.7.0-beta.1');
eq('version: 两段合法', T.version('0.6'), '0.6');
eq('version: 非数字一律空（挡住把路径/地址当版本号）',
  [T.version('/opt/blocknexus-agent'), T.version('1.2.3.4'), T.version('a.b.c'), T.version(null), T.version({})],
  ['', '', '', '', '']);

// ---------- 4. 错误码计数表 ----------
{
  const r = T.errorCounts({ 'ssh.timeout': 3, 'agent.offline': 12 });
  eq('errorCounts: 只收合法错误码', r, { 'ssh.timeout': 3, 'agent.offline': 12 });
  eq('errorCounts: 键含空格/大写/冒号 → 丢弃（那可能是文案）',
    T.errorCounts({ '连接 1.2.3.4 失败': 2, 'A:B': 1, 'x y': 1 }), {});
  eq('errorCounts: 负数/非数字/NaN → 丢弃',
    T.errorCounts({ a: -1, b: 'x', c: NaN, d: Infinity }), {});
  eq('errorCounts: 次数封顶', T.errorCounts({ a: 999999999 }), { a: 1000000 });
  ok('errorCounts: 键数封顶 20', Object.keys(T.errorCounts(Object.fromEntries(
    Array.from({ length: 50 }, (_, i) => [`e${i}`, 1]),
  ))).length === 20);
  eq('errorCounts: 非对象输入 → 空', [T.errorCounts(null), T.errorCounts([]), T.errorCounts('x')], [{}, {}, {}]);
}

// ---------- 5. Agent 版本列表 ----------
eq('agentVersions: 去重 + 排序无关', T.agentVersions(['0.5.2', '0.6.0', '0.5.2']), ['0.5.2', '0.6.0']);
eq('agentVersions: 非法值被剔除', T.agentVersions(['0.6.0', '/opt/agent', '1.2.3.4', '']), ['0.6.0']);
ok('agentVersions: 数量封顶 50', T.agentVersions(Array.from({ length: 200 }, (_, i) => `0.${i}.0`)).length === 50);
eq('agentVersions: 非数组 → 空', T.agentVersions({ a: '0.6.0' }), []);

// ---------- 6. buildPayload：白名单 ----------
const FACTS = {
  id: 'a1b2c3d4-0000-4000-8000-000000000000',
  panelVer: '0.6.0',
  os: 'windows',
  arch: 'x64',
  installKind: 'portable',
  agentVers: ['0.5.2', '0.6.0'],
  servers: 3,
  instances: 1,
  features: { ddns: true, frp: false, ai: true, smtp: false, notify: true },
  errors: { 'ssh.timeout': 2 },
  ts: 1700000000000,
};
{
  const r = T.buildPayload(FACTS);
  ok('buildPayload: 正常输入成功', r.ok === true && !!r.payload, JSON.stringify(r));
  eq('buildPayload: 字段集合固定（白名单）', Object.keys(r.payload).sort(),
    ['agentVers', 'arch', 'errors', 'features', 'id', 'installKind', 'instances', 'os', 'panelVer', 'servers', 'ts', 'v']);
  eq('buildPayload: 分桶生效', [r.payload.servers, r.payload.instances], ['2-5', '1']);
  eq('buildPayload: features 五个键齐全', Object.keys(r.payload.features).sort(),
    ['ai', 'ddns', 'frp', 'notify', 'smtp']);
}

// 关键：facts 里夹带敏感信息时，**必须被丢弃而不是透传**
{
  const dirty = {
    ...FACTS,
    // 这些是真实 world 里最容易顺手塞进 facts 的东西
    host: 'mc.example.com',
    serverIps: ['1.2.3.4', '10.0.0.5'],
    domain: 'panel.example.com',
    sshUser: 'root',
    sshPassword: 'p@ssw0rd',
    aiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
    installDir: '/opt/blocknexus-agent',
    instanceName: 'survival',
    email: 'admin@example.com',
    panelUrl: 'https://panel.example.com:3080',
    token: 'gho_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  };
  const r = T.buildPayload(dirty);
  ok('buildPayload: 夹带敏感字段的 facts 仍然成功（脏键被忽略）', r.ok === true, JSON.stringify(r));
  const dumped = JSON.stringify(r.payload);
  ok('buildPayload: 主机名/域名不出现在 payload', !dumped.includes('example.com'), dumped);
  ok('buildPayload: IP 不出现', !dumped.includes('1.2.3.4') && !dumped.includes('10.0.0.5'), dumped);
  ok('buildPayload: 用户名/口令不出现', !dumped.includes('root') && !dumped.includes('p@ssw0rd'), dumped);
  ok('buildPayload: AI key 不出现', !dumped.includes('sk-abcdef'), dumped);
  ok('buildPayload: 安装路径不出现', !dumped.includes('/opt/'), dumped);
  ok('buildPayload: 实例名不出现', !dumped.includes('survival'), dumped);
  ok('buildPayload: URL / token 不出现', !dumped.includes('https://') && !dumped.includes('gho_'), dumped);
}

// 没有 ID 就不发：宁可不收数据，也不造一个能关联到人的标识
{
  ok('buildPayload: 缺 id → 拒绝', T.buildPayload({ ...FACTS, id: '' }).reason === 'no-id');
  ok('buildPayload: id 非字符串 → 拒绝', T.buildPayload({ ...FACTS, id: { v: 1 } }).ok === false);
  ok('buildPayload: 空输入 → 拒绝', T.buildPayload().ok === false && T.buildPayload({}).ok === false);
}

// 枚举收敛：不认识的 OS/arch/kind 一律 other/unknown，不把原始字符串带出去
{
  const r = T.buildPayload({ ...FACTS, os: 'Microsoft Windows 11 Pro 10.0.22631', arch: 'AMD64', installKind: 'git-dirty-ish' });
  eq('buildPayload: 未知 OS/arch/kind 收敛到枚举', [r.payload.os, r.payload.arch, r.payload.installKind],
    ['other', 'other', 'unknown']);
}

// ---------- 6b. 事实采集（新增） ----------
eq('osOf: win32/linux/darwin/未知', [T.osOf('win32'), T.osOf('linux'), T.osOf('darwin'), T.osOf('SunOS')],
  ['windows', 'linux', 'other', 'other']);
ok('osOf: 不认识的 platform 不回传原始串', T.osOf('SunOS 5.11') === 'other');
{
  const settings = {
    ddns: { enabled: true, domain: 'mc.example.com', token: 'secret' },
    frp: { enabled: false, binaryPath: 'C:\\frp\\frpc.exe' },
    ai: { enabled: true, baseUrl: 'http://127.0.0.1:11434', apiKey: 'sk-xxx' },
    smtp: { host: 'smtp.example.com', user: 'panel', pass: 'p' },
    notify: { offline: false, recovery: false },
  };
  eq('featuresOf: 只取布尔，不含任何配置值',
    T.featuresOf(settings), { ddns: true, frp: false, ai: true, smtp: true, notify: false });
  const dumped = JSON.stringify(T.featuresOf(settings));
  ok('featuresOf: 域名/baseUrl/路径/密钥一个都不出现',
    !dumped.includes('example.com') && !dumped.includes('127.0.0.1') && !dumped.includes('sk-') && !dumped.includes('frpc'));
  eq('featuresOf: notify 只要有一个开关就算开', T.featuresOf({ notify: { offline: false, recovery: true } }).notify, true);
  eq('featuresOf: smtp 缺 user 不算启用', T.featuresOf({ smtp: { host: 'h', user: '' } }).smtp, false);
  eq('featuresOf: 空输入全 false', T.featuresOf(), { ddns: false, frp: false, ai: false, smtp: false, notify: false });
}
eq('agentVersOf: 从服务器 info 里取版本',
  T.agentVersOf([{ info: { agentVersion: '0.6.0' } }, { info: { agentVersion: '0.5.2' } }, { info: null }, {}]),
  ['0.6.0', '0.5.2']);
eq('agentVersOf: 非数组 → 空', T.agentVersOf(null), []);
{
  // 关键：info 里夹带的东西不能顺带出去
  const r = T.agentVersOf([{ info: { agentVersion: '0.6.0', host: '1.2.3.4', dir: '/opt/blocknexus-agent' } }]);
  eq('agentVersOf: 只取版本字段', r, ['0.6.0']);
}
eq('countBucket: 数字走分桶', [T.countBucket(0), T.countBucket(3), T.countBucket(30)], ['0', '2-5', '20+']);
eq('countBucket: 没采到（null/undefined）→ unknown（不与真实的 0 混淆）',
  [T.countBucket(null), T.countBucket(undefined), T.countBucket('x')], ['unknown', 'unknown', 'unknown']);

// ---------- 6c. 错误码计数器（bounded） ----------
{
  const tally = T.createErrorTally(3);
  for (let i = 0; i < 50; i++) tally.bump(`err.${i}`);
  ok('tally: 表满淘汰最旧而不是拒绝服务', Object.keys(tally.snapshot()).length === 3, JSON.stringify(tally.snapshot()));
  eq('tally: 保留的是最后三个', Object.keys(tally.snapshot()), ['err.47', 'err.48', 'err.49']);
  tally.bump('ssh.timeout');
  tally.bump('ssh.timeout');
  eq('tally: 同码累加', tally.snapshot()['ssh.timeout'], 2);
  // 非法形状不记：这条是防「把错误文案当 code 传进来」
  tally.reset();
  tally.bump('连接 1.2.3.4 失败');
  tally.bump('A:B:C');
  tally.bump('');
  eq('tally: 非法 code 形状一律不记', tally.snapshot(), {});
  tally.reset();
  eq('tally: reset 清空', tally.snapshot(), {});
}

// ---------- 6d. 配置归一化 ----------
{
  const r = T.normalizeConfig({ enabled: true, endpoint: 'https://t.example.com/t', intervalSec: 3600 }, {});
  ok('normalizeConfig: 合法输入通过', r.error === '' && r.config.enabled === true && r.config.endpoint === 'https://t.example.com/t',
    JSON.stringify(r));
  eq('normalizeConfig: 给了非法端点 → 报错而不是静默清空',
    T.normalizeConfig({ endpoint: 'https://10.0.0.5/t' }, {}).error, 'settings.telemetry-endpoint-invalid');
  eq('normalizeConfig: 端点没变时不报错（保留原值）',
    T.normalizeConfig({ enabled: true }, { endpoint: 'https://t.example.com/t' }).config.endpoint,
    'https://t.example.com/t');
  ok('normalizeConfig: 不传 enabled 时沿用旧值',
    T.normalizeConfig({}, { enabled: true }).config.enabled === true &&
      T.normalizeConfig({}, { enabled: false }).config.enabled === false);
  ok('normalizeConfig: instanceId 不从请求体读（防客户端伪造/覆盖）',
    T.normalizeConfig({ instanceId: 'evil' }, { instanceId: 'keep' }).config.instanceId === 'keep');
  eq('publicConfig: 只暴露状态，不暴露 ID 本身',
    T.publicConfig({ enabled: true, endpoint: 'https://t.example.com/t', instanceId: 'abc' }),
    { enabled: true, endpoint: 'https://t.example.com/t', intervalSec: 86400, hasId: true });
  eq('publicConfig: 无 ID 时 hasId=false', T.publicConfig({}).hasId, false);
  ok('publicConfig: 绝不回显 instanceId', !JSON.stringify(T.publicConfig({ instanceId: 'secret-id' })).includes('secret-id'));
}

// ---------- 7. assertPayloadSafe：第二道闸 ----------
{
  const cases = [
    ['IPv4', { a: '1.2.3.4' }],
    ['IPv6', { a: '2408:8207::1' }],
    ['邮箱', { a: 'admin@example.com' }],
    ['URL', { a: 'https://panel.example.com' }],
    ['Windows 路径', { a: 'C:\\Users\\admin\\panel' }],
    ['Unix 路径', { a: '/opt/blocknexus-agent' }],
    ['裸路径分隔符', { a: 'data/config.json' }],
    ['长随机串', { a: 'a'.repeat(64) }],
    ['sk- 前缀', { a: 'sk-abcdefghijklmnop' }],
    ['ghp_ 前缀', { a: 'ghp_xxxxxxxxxxxxxxxxxxxx' }],
    ['AWS key', { a: 'AKIAIOSFODNN7EXAMPLE' }],
    ['PEM 私钥', { a: '-----BEGIN RSA PRIVATE KEY-----' }],
    ['深层嵌套里的 IP', { a: { b: { c: ['x', '9.9.9.9'] } } }],
  ];
  for (const [label, obj] of cases) {
    const r = T.assertPayloadSafe(obj);
    ok(`assertPayloadSafe: ${label} → 拒绝`, r.ok === false, JSON.stringify(r));
  }
  ok('assertPayloadSafe: 干净 payload 通过',
    T.assertPayloadSafe({ os: 'linux', n: 3, b: true, list: ['0.6.0'] }).ok === true);
  ok('assertPayloadSafe: NaN / Infinity → 拒绝',
    T.assertPayloadSafe({ n: NaN }).ok === false && T.assertPayloadSafe({ n: Infinity }).ok === false);
  ok('assertPayloadSafe: 过深嵌套 → 拒绝（防递归炸弹）',
    (() => {
      let deep = { v: 'x' };
      for (let i = 0; i < 12; i++) deep = { nested: deep };
      return T.assertPayloadSafe(deep).ok === false;
    })());
}

// ---------- 8. 端点校验：遥测是外发，不许内网目标 ----------
{
  ok('endpoint: https 正常域名放行', T.normalizeEndpoint('https://t.example.com/telemetry') === 'https://t.example.com/telemetry');
  for (const [label, u] of [
    ['http 明文', 'http://t.example.com/t'],
    ['回环 127.0.0.1', 'https://127.0.0.1/t'],
    ['回环 localhost', 'https://localhost/t'],
    ['私网 10.x', 'https://10.0.0.5/t'],
    ['私网 192.168.x', 'https://192.168.1.5/t'],
    ['私网 172.16.x', 'https://172.16.0.5/t'],
    ['链路本地（云元数据）', 'https://169.254.169.254/latest/meta-data/'],
    ['IPv6 回环', 'https://[::1]/t'],
    ['IPv6 链路本地', 'https://[fe80::1]/t'],
    ['URL 里带凭据', 'https://user:pw@t.example.com/t'],
    ['不是 URL', 'just-a-string'],
    ['空', ''],
  ]) {
    ok(`endpoint: ${label} → 拒绝`, T.normalizeEndpoint(u) === '', String(T.normalizeEndpoint(u)));
  }
}

// ---------- 9. 间隔 ----------
eq('interval: 非法值回落 24h', [T.normalizeInterval('x'), T.normalizeInterval(null), T.normalizeInterval(undefined)],
  [24 * 3600, 24 * 3600, 24 * 3600]);
eq('interval: 显式 0 被夹到下限 1h', T.normalizeInterval(0), 3600);
eq('interval: 下限 1h', T.normalizeInterval(60), 3600);
eq('interval: 上限 7d', T.normalizeInterval(99999999), 7 * 24 * 3600);

// ---------- 10. shouldSend ----------
const S = { enabled: true, endpoint: 'https://t.example.com/t', intervalSec: 24 * 3600 };
ok('shouldSend: 关闭 → 不发', T.shouldSend({ ...S, enabled: false }, { now: 0, lastSentAt: 0, failures: 0 }).reason === 'disabled');
ok('shouldSend: 没端点 → 不发', T.shouldSend({ ...S, endpoint: '' }, { now: 0, lastSentAt: 0, failures: 0 }).reason === 'no-endpoint');
ok('shouldSend: 内网端点 → 不发', T.shouldSend({ ...S, endpoint: 'https://10.0.0.5/t' }, { now: 0, lastSentAt: 0, failures: 0 }).reason === 'no-endpoint');
ok('shouldSend: 首次（lastSentAt=0）→ 发', T.shouldSend(S, { now: 1000, lastSentAt: 0, failures: 0 }).send === true);
{
  const now = 1_000_000_000;
  ok('shouldSend: 距上次不足一个间隔 → 不发',
    T.shouldSend(S, { now, lastSentAt: now - 3600_000, failures: 0 }).reason === 'too-soon');
  ok('shouldSend: 超过一个间隔 → 发',
    T.shouldSend(S, { now, lastSentAt: now - 25 * 3600_000, failures: 0 }).send === true);
}
{
  const now = 1_000_000_000;
  const last = now - 60_000; // 刚失败过
  ok('shouldSend: 失败 1 次但未过 5 分钟退避 → 不发',
    T.shouldSend(S, { now, lastSentAt: last, failures: 1 }).reason === 'backoff');
  ok('shouldSend: 失败 1 次且过了 5 分钟 → 发',
    T.shouldSend(S, { now: now + 400_000, lastSentAt: last, failures: 1 }).send === true);
  ok('shouldSend: 退避逐级拉长（第 2 级 30 分钟：过 6 分钟仍不发）',
    T.shouldSend(S, { now: now + 400_000, lastSentAt: last, failures: 2 }).reason === 'backoff');
  // 退避是**独立通道**：过了退避就发，不再要求等满 24 小时间隔
  ok('shouldSend: 第 3 级退避（2 小时）内不发',
    T.shouldSend(S, { now: now + 3600_000, lastSentAt: last, failures: 3 }).reason === 'backoff');
  ok('shouldSend: 过了第 3 级退避 → 发（不等满一个间隔）',
    T.shouldSend(S, { now: now + 3 * 3600_000, lastSentAt: last, failures: 3 }).send === true);
  ok('shouldSend: 退避封顶不再无限翻倍（第 10 次 = 第 3 级 2 小时）',
    T.shouldSend(S, { now: now + 3 * 3600_000, lastSentAt: last, failures: 10 }).send === true &&
      T.shouldSend(S, { now: now + 3 * 3600_000, lastSentAt: last, failures: 3 }).send === true);
  ok('shouldSend: 成功后 failures 归零 → 回到正常间隔',
    T.shouldSend(S, { now: now + 3600_000, lastSentAt: last, failures: 0 }).reason === 'too-soon');
  // force（手动发送）：跳过节奏判断，但**不跳过**安全判断
  ok('shouldSend: force 跳过退避', T.shouldSend(S, { now, lastSentAt: last, failures: 3, force: true }).send === true);
  ok('shouldSend: force 仍拒绝 disabled',
    T.shouldSend({ ...S, enabled: false }, { now, lastSentAt: last, failures: 3, force: true }).reason === 'disabled');
  ok('shouldSend: force 仍拒绝非法端点',
    T.shouldSend({ ...S, endpoint: 'https://10.0.0.5/t' }, { now, lastSentAt: 0, failures: 0, force: true }).reason === 'no-endpoint');
}

// ---------- 11. send（假 fetch） ----------
(async () => {
  const payload = T.buildPayload(FACTS).payload;
  const EP = 'https://t.example.com/telemetry';

  // 记录请求，断言「发出去的到底是什么」
  let seen = null;
  const fakeOk = async (url, init) => {
    seen = { url, init };
    return { status: 200 };
  };

  const r1 = await T.send(payload, EP, { fetchImpl: fakeOk });
  ok('send: 成功 → sent=true', r1.sent === true && r1.status === 200, JSON.stringify(r1));
  ok('send: 打到配置的端点', seen && seen.url === EP);
  ok('send: 用 POST', seen && seen.init.method === 'POST');
  ok('send: body 是合法 JSON 且等于 payload',
    seen && JSON.parse(seen.init.body).id === payload.id);
  ok('send: 不带上任何自定义头里的凭据',
    seen && !JSON.stringify(seen.init.headers).match(/authorization|cookie/i),
    JSON.stringify(seen && seen.init.headers));

  // 端点非法 → 根本不发
  seen = null;
  const r2 = await T.send(payload, 'https://10.0.0.5/t', { fetchImpl: fakeOk });
  ok('send: 内网端点 → 不发且不调用 fetch', r2.sent === false && r2.reason === 'no-endpoint' && seen === null);

  // payload 里混入敏感内容 → 不发（第二道闸真的拦得住）
  seen = null;
  const r3 = await T.send({ ...payload, os: '1.2.3.4' }, EP, { fetchImpl: fakeOk });
  ok('send: payload 含 IP → 不发且不调用 fetch', r3.sent === false && r3.reason === 'ipv4' && seen === null);

  // 网络失败 → 不抛异常
  const r4 = await T.send(payload, EP, { fetchImpl: async () => { throw new Error('boom'); } });
  ok('send: 网络异常 → 返回失败而非抛出', r4.sent === false && r4.reason === 'network', JSON.stringify(r4));

  // 超时 → 不抛异常
  const r5 = await T.send(payload, EP, {
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  ok('send: 超时 → reason=timeout', r5.sent === false && r5.reason === 'timeout', JSON.stringify(r5));

  // HTTP 500
  const r6 = await T.send(payload, EP, { fetchImpl: async () => ({ status: 500 }) });
  ok('send: 5xx → sent=false', r6.sent === false && r6.status === 500 && r6.reason === 'http-500');

  // 没有 fetch 实现（老 Node）→ 优雅失败：临时摘掉全局 fetch 验证这条分支
  {
    const saved = globalThis.fetch;
    try {
      delete globalThis.fetch;
      const r7 = await T.send(payload, EP, {});
      ok('send: 无 fetch 实现 → 优雅失败', r7.sent === false && r7.reason === 'no-fetch', JSON.stringify(r7));
    } finally {
      if (saved) globalThis.fetch = saved;
    }
  }

  // ---------- 12. instanceId ----------
  {
    const c = require('crypto');
    const a = T.newInstanceId(c);
    const b = T.newInstanceId(c);
    ok('instanceId: 每次不同', a !== b && a.length > 8);
    ok('instanceId: 不含机器可识别信息（只是随机串）',
      !/^(?:[0-9a-f]{2}:){5}/.test(a) && !a.includes('admin'), a);
    // 没有 randomUUID 时退回随机字节
    const fake = { randomBytes: (n) => Buffer.alloc(n, 7) };
    ok('instanceId: 无 randomUUID 时退回随机字节', T.newInstanceId(fake) === '07'.repeat(16));
    const broken = { randomUUID: () => { throw new Error('nope'); }, randomBytes: (n) => Buffer.alloc(n, 1) };
    ok('instanceId: randomUUID 抛异常也能退避', T.newInstanceId(broken) === '01'.repeat(16));
  }

  console.log(`\n${pass}/${total} telemetry cases passed`);
  if (pass !== total) process.exit(1);
})();
