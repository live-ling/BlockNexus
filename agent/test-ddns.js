'use strict';
// DDNS（panel/ddns.js）的回归测试：地址判定 / 域名拆分 / 请求构造 / 配置校验 / 网络动作。
//
// 网络动作全部用**假 fetch**：既能断言请求长什么样（URL、方法、body、头），
// 又不依赖真实 DNS 服务商，CI 稳定。

const path = require('path');
const ddns = require(path.join(__dirname, '..', 'panel', 'ddns.js'));

let pass = 0;
let total = 0;
function eq(name, got, want) {
  total++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} → ${g}（期望 ${w}）`);
}
function ok(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 地址判定 ----------
ok('8.8.8.8 是公网 IPv4', ddns.isPublicV4('8.8.8.8'));
ok('10.0.0.1 不是公网', !ddns.isPublicV4('10.0.0.1'));
ok('192.168.1.2 不是公网', !ddns.isPublicV4('192.168.1.2'));
ok('172.16.3.4 不是公网', !ddns.isPublicV4('172.16.3.4'));
ok('100.64.1.1（CGNAT）不是公网', !ddns.isPublicV4('100.64.1.1'));
ok('169.254.1.1 不是公网', !ddns.isPublicV4('169.254.1.1'));
ok('2408:8207::1 是公网 IPv6', ddns.isPublicV6('2408:8207::1'));
ok('fe80::1 不是公网 IPv6', !ddns.isPublicV6('fe80::1'));
ok('fc00::1（ULA）不是公网', !ddns.isPublicV6('fc00::1'));
ok('::1 不是公网', !ddns.isPublicV6('::1'));
ok('::ffff:8.8.8.8 按 v4 判定为公网', ddns.isPublicV6('::ffff:8.8.8.8'));

// ---------- 网卡取址 ----------
{
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.10', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    ppp0: [{ address: '1.2.3.4', family: 'IPv4', internal: false }],
    v6: [{ address: '2408:8207::5', family: 6, internal: false }],
  };
  eq('网卡里挑出公网 IPv4', ddns.pickInterfaceIps(ifaces, 4), [{ iface: 'ppp0', address: '1.2.3.4' }]);
  eq('网卡里挑出公网 IPv6（family 为数字也能认）', ddns.pickInterfaceIps(ifaces, 6), [
    { iface: 'v6', address: '2408:8207::5' },
  ]);
  const natOnly = { eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }] };
  eq('只有内网地址时为空', ddns.pickInterfaceIps(natOnly, 4), []);
}

// ---------- 输出解析 ----------
eq('从接口文本里取 IPv4', ddns.parseIpOutput('your ip is 8.8.4.4\n', 4), '8.8.4.4');
eq('跳过私网只取公网', ddns.parseIpOutput('10.0.0.1 then 1.1.1.1', 4), '1.1.1.1');
eq('从文本里取 IPv6', ddns.parseIpOutput('addr=2408:8207::9', 6), '2408:8207::9');
eq('没有可用地址时返回空串', ddns.parseIpOutput('nothing here', 4), '');

// ---------- 域名 ----------
eq('去协议/路径/大写/尾点', ddns.normalizeDomain('https://MC.Example.com./path'), 'mc.example.com');
eq('普通域名拆分', ddns.splitDomain('mc.example.com'), { root: 'example.com', sub: 'mc' });
eq('根域名本身', ddns.splitDomain('example.com'), { root: 'example.com', sub: '@' });
eq('二级后缀 com.cn', ddns.splitDomain('mc.example.com.cn'), { root: 'example.com.cn', sub: 'mc' });
eq('显式 root 优先', ddns.splitDomain('play.mc.example.com', 'example.com'), {
  root: 'example.com',
  sub: 'play.mc',
});
ok('合法域名', ddns.isValidDomain('mc.example.com'));
ok('粘贴整条 URL 会被规范化成主机名', ddns.isValidDomain('https://mc.example.com/path'));
ok('单段主机名不算 FQDN', !ddns.isValidDomain('mc'));
ok('IP 不能当 DDNS 域名', !ddns.isValidDomain('1.2.3.4'));

// ---------- 区间/变更 ----------
eq('间隔下限 60s', ddns.clampInterval(10), 60);
eq('间隔上限 24h', ddns.clampInterval(99999999), 86400);
eq('非法间隔回默认 300s', ddns.clampInterval('oops'), 300);
eq('TTL 下限 60s', ddns.clampTtl(1), 60);
ok('IP 相同不需要更新', !ddns.needsUpdate('1.2.3.4', '1.2.3.4'));
ok('IP 不同需要更新', ddns.needsUpdate('1.2.3.4', '1.2.3.5'));
ok('大小写差异不算变化（IPv6）', !ddns.needsUpdate('2408:ABCD::1', '2408:abcd::1'));

// ---------- Callback 模板 ----------
eq(
  'Callback 模板替换',
  ddns.renderCallback('http://x/set?ip=#{ip}&d=#{domain}&t=#{type}', { ip: '1.2.3.4', domain: 'a.com', type: 'A' }),
  'http://x/set?ip=1.2.3.4&d=a.com&t=A',
);
eq('未知占位符原样保留', ddns.renderCallback('#{ip}-#{nope}', { ip: '1.1.1.1' }), '1.1.1.1-#{nope}');

// ---------- 服务商请求构造 ----------
{
  const h = ddns.cfHeaders('tok');
  ok('Cloudflare 用 Bearer Token', h.Authorization === 'Bearer tok');
  ok('Cloudflare zone 查询 URL 带域名', ddns.cfZoneQueryUrl('example.com').includes('name=example.com'));
  ok(
    'Cloudflare 记录查询 URL 带 type/name',
    ddns.cfRecordQueryUrl('z1', 'mc.example.com', 'A').includes('type=A') &&
      ddns.cfRecordQueryUrl('z1', 'mc.example.com', 'A').includes('name=mc.example.com'),
  );
  eq('Cloudflare 写入体', ddns.cfRecordWriteBody({ type: 'A', domain: 'mc.example.com', ip: '1.2.3.4', ttl: 60 }), {
    type: 'A',
    name: 'mc.example.com',
    content: '1.2.3.4',
    ttl: 60,
    proxied: false,
  });
}
{
  const list = ddns.dnspodListBody({ id: '1', token: 't', root: 'example.com', sub: 'mc', type: 'A' });
  ok('DNSPod 列表体带 login_token', list.includes('login_token=1%2Ct'));
  ok('DNSPod 列表体带 sub_domain/record_type', list.includes('sub_domain=mc') && list.includes('record_type=A'));
  const mod = ddns.dnspodWriteBody({
    id: '1',
    token: 't',
    root: 'example.com',
    sub: 'mc',
    type: 'A',
    ip: '1.2.3.4',
    recordId: '99',
  });
  ok('DNSPod 修改体带 record_id 与 value', mod.includes('record_id=99') && mod.includes('value=1.2.3.4'));
  ok('DNSPod 修改体带默认线路', mod.includes('record_line=') && decodeURIComponent(mod).includes('默认'));
}
{
  const u4 = ddns.duckdnsUrl({ domain: 'home.duckdns.org', token: 'tk', ip: '1.2.3.4', family: 4 });
  ok('DuckDNS 用 ip= 更新 v4', u4.includes('domains=home') && u4.includes('ip=1.2.3.4') && !u4.includes('ipv6='));
  const u6 = ddns.duckdnsUrl({ domain: 'home.duckdns.org', token: 'tk', ip: '2408::1', family: 6 });
  ok('DuckDNS 用 ipv6= 更新 v6', u6.includes('ipv6=2408'));
}

// ---------- 配置校验 ----------
{
  const base = ddns.normalizeConfig({}, {});
  ok('空配置给出默认值', base.config && base.config.provider === 'cloudflare' && base.config.ipv4 === true);
  ok(
    '启用但缺凭据 → 报错',
    ddns.normalizeConfig({ enabled: true, domain: 'mc.example.com' }, {}).error === 'network.ddns-credentials-required',
  );
  ok(
    '填了凭据即可启用',
    !!ddns.normalizeConfig(
      { enabled: true, domain: 'mc.example.com', cloudflare: { token: 'x' } },
      {},
    ).config,
  );
  ok('非法域名 → 报错', ddns.normalizeConfig({ domain: 'http://x/y' }, {}).error === 'network.ddns-domain-invalid');
  ok(
    'IPv4/IPv6 都不选 → 报错',
    ddns.normalizeConfig({ ipv4: false, ipv6: false }, {}).error === 'network.ddns-ip-family-required',
  );
  ok(
    '命令取址必须填命令',
    ddns.normalizeConfig({ source: 'command', command: '' }, {}).error === 'network.ddns-command-required',
  );
  const keep = ddns.normalizeConfig({}, { cloudflare: { token: 'kept' }, enabled: false }).config;
  eq('空 token 保留原值', keep.cloudflare.token, 'kept');
  const pub = ddns.publicConfig({ cloudflare: { token: 'secret', zoneId: 'z' }, domain: 'a.com' });
  ok('publicConfig 不泄露 token', pub.cloudflare.hasToken === true && pub.cloudflare.token === undefined);
  ok('publicConfig 带 zoneId/域名', pub.cloudflare.zoneId === 'z' && pub.domain === 'a.com');
}

// ---------- 取 IP：假 fetch / 网卡 / 命令 ----------
async function netTests() {
  const fakeFetch = (text, status = 200) => async () => ({ ok: status === 200, status, text: async () => text });
  const r1 = await ddns.detectIp({ family: 4, source: 'api', fetchImpl: fakeFetch('1.2.3.4\n') });
  eq('接口取址成功', r1.ip, '1.2.3.4');
  const r2 = await ddns.detectIp({ family: 6, source: 'api', fetchImpl: fakeFetch('2408:8207::7') });
  eq('接口取 IPv6 成功', r2.ip, '2408:8207::7');
  const r3 = await ddns.detectIp({ family: 4, source: 'api', fetchImpl: fakeFetch('not-an-ip') });
  ok('接口返回非 IP 时报错', !r3.ip && /失败/.test(r3.error));
  const r4 = await ddns.detectIp({
    family: 4,
    source: 'nic',
    ifaces: { eth0: [{ address: '192.168.1.2', family: 'IPv4', internal: false }] },
  });
  ok('NAT 环境网卡取址给出可读提示', !r4.ip && /NAT|CGNAT/.test(r4.error), r4.error);
  const r5 = await ddns.detectIp({
    family: 4,
    source: 'command',
    command: `${process.execPath} -e "console.log('9.9.9.9')"`,
  });
  eq('命令取址成功', r5.ip, '9.9.9.9');
  const r6 = await ddns.detectBoth({ ipv4: true, ipv6: false, source: 'api' }, { fetchImpl: fakeFetch('5.6.7.8') });
  eq('detectBoth 只在启用 v4 时查 v4', [r6.ipv4.ip, r6.ipv6], ['5.6.7.8', null]);
}

// ---------- 写记录：假 fetch 断言请求 ----------
function jsonRes(body, status = 200) {
  return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function applyTests() {
  // Cloudflare：查 zone → 查记录 → PATCH 更新
  {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url, init });
      if (url.includes('/zones?')) return jsonRes({ success: true, result: [{ id: 'z1' }] });
      if (url.includes('/dns_records?')) return jsonRes({ success: true, result: [{ id: 'r1' }] });
      return jsonRes({ success: true, result: {} });
    };
    const r = await ddns.applyRecord({
      provider: 'cloudflare',
      cfg: { cloudflare: { token: 't' } },
      domain: 'mc.example.com',
      type: 'A',
      ip: '1.2.3.4',
      ttl: 120,
      fetchImpl: fake,
    });
    eq('Cloudflare 有记录时 PATCH', r.action, 'updated');
    ok('Cloudflare 请求数为 3（zone/record/patch）', calls.length === 3, String(calls.length));
    eq('Cloudflare PATCH 方法', calls[2].init.method, 'PATCH');
    eq('Cloudflare PATCH 内容', JSON.parse(calls[2].init.body).content, '1.2.3.4');
    ok('Cloudflare 带 Bearer 头', calls[0].init.headers.Authorization === 'Bearer t');
  }

  // Cloudflare：无记录 → POST 新建；返回 success=false → 抛错
  {
    const calls = [];
    const fake = async (url) => {
      calls.push(url);
      if (url.includes('/zones?')) return jsonRes({ success: true, result: [{ id: 'z1' }] });
      if (url.includes('/dns_records?')) return jsonRes({ success: true, result: [] });
      return jsonRes({ success: true, result: {} });
    };
    const r = await ddns.applyRecord({
      provider: 'cloudflare',
      cfg: { cloudflare: { token: 't', zoneId: 'z1' } },
      domain: 'mc.example.com',
      type: 'AAAA',
      ip: '2408::1',
      ttl: 60,
      fetchImpl: fake,
    });
    eq('Cloudflare 无记录时 created', r.action, 'created');
    ok('Cloudflare 指定 zoneId 时少一次查询', calls.length === 2, String(calls.length));
  }
  {
    let bad = false;
    try {
      await ddns.applyRecord({
        provider: 'cloudflare',
        cfg: { cloudflare: { token: 't', zoneId: 'z1' } },
        domain: 'mc.example.com',
        type: 'A',
        ip: '1.2.3.4',
        fetchImpl: async () => jsonRes({ success: false, errors: [{ message: 'bad token' }] }),
      });
    } catch (e) {
      bad = /bad token/.test(e.message);
    }
    ok('Cloudflare 业务错误会抛出原因', bad);
  }

  // DNSPod：有记录 → Modify；无记录 → Create
  {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.endsWith('Record.List')) return jsonRes({ status: { code: '1' }, records: [{ id: '7', type: 'A' }] });
      return jsonRes({ status: { code: '1' } });
    };
    const r = await ddns.applyRecord({
      provider: 'dnspod',
      cfg: { dnspod: { id: '1', token: 't' } },
      domain: 'mc.example.com',
      type: 'A',
      ip: '1.2.3.4',
      ttl: 600,
      fetchImpl: fake,
    });
    eq('DNSPod 有记录时 updated', r.action, 'updated');
    ok('DNSPod 改记录时带 record_id', /record_id=7/.test(calls[1].body));
  }
  {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.endsWith('Record.List')) return jsonRes({ status: { code: '1' }, records: [] });
      return jsonRes({ status: { code: '1' } });
    };
    const r = await ddns.applyRecord({
      provider: 'dnspod',
      cfg: { dnspod: { id: '1', token: 't' } },
      domain: 'mc.example.com',
      type: 'A',
      ip: '1.2.3.4',
      fetchImpl: fake,
    });
    eq('DNSPod 无记录时 created', r.action, 'created');
    ok('DNSPod 新建走 Record.Create', calls[1].url.endsWith('Record.Create'));
  }
  {
    let msg = '';
    try {
      await ddns.applyRecord({
        provider: 'dnspod',
        cfg: { dnspod: { id: '1', token: 't' } },
        domain: 'mc.example.com',
        type: 'A',
        ip: '1.2.3.4',
        fetchImpl: async () => jsonRes({ status: { code: '3', message: 'auth failed' } }),
      });
    } catch (e) {
      msg = e.message;
    }
    ok('DNSPod 失败会带服务端消息', /auth failed/.test(msg), msg);
  }

  // DuckDNS
  {
    let seen = '';
    const fake = async (url) => {
      seen = url;
      return { ok: true, status: 200, text: async () => 'OK' };
    };
    const r = await ddns.applyRecord({
      provider: 'duckdns',
      cfg: { duckdns: { token: 'tk' } },
      domain: 'home.duckdns.org',
      type: 'A',
      ip: '1.2.3.4',
      fetchImpl: fake,
    });
    eq('DuckDNS 成功', r.action, 'updated');
    ok('DuckDNS 请求带 ip', seen.includes('ip=1.2.3.4'));
    let failed = false;
    try {
      await ddns.applyRecord({
        provider: 'duckdns',
        cfg: { duckdns: { token: 'tk' } },
        domain: 'home.duckdns.org',
        type: 'A',
        ip: '1.2.3.4',
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'KO' }),
      });
    } catch {
      failed = true;
    }
    ok('DuckDNS 返回 KO 抛错', failed);
  }

  // Callback
  {
    let init = null;
    const fake = async (url, i) => {
      init = { url, ...i };
      return { ok: true, status: 204 };
    };
    const r = await ddns.applyRecord({
      provider: 'callback',
      cfg: { callback: { url: 'https://x/set', body: '{"ip":"#{ip}"}' } },
      domain: 'mc.example.com',
      type: 'A',
      ip: '1.2.3.4',
      fetchImpl: fake,
    });
    eq('Callback 成功', r.action, 'updated');
    eq('Callback 有 body 时 POST', init.method, 'POST');
    eq('Callback body 已替换占位符', JSON.parse(init.body).ip, '1.2.3.4');
  }
}

async function main() {
  await netTests();
  await applyTests();

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error('DDNS 测试异常:', e);
  process.exit(1);
});
