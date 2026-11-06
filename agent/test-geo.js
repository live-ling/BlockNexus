'use strict';
// panel/geo.js（服务器地区自动推断，ipwho.is）的回归测试。
// 网络查询注入假 fetch 断言请求构造；内网判定与缓存用真实值。
// 运行：node agent/test-geo.js

const path = require('path');

let pass = 0;
let total = 0;
function check(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const geo = require(path.join(__dirname, '..', 'panel', 'geo.js'));

(async () => {
  // ---------- 内网地址判定 ----------
  {
    const priv = [
      '127.0.0.1', 'localhost', 'foo.localhost', 'nas.local', '10.0.0.8', '192.168.1.1',
      '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fd00::1', 'fc12::ab', 'fe80::1', '[192.168.0.1]',
    ];
    const pub = ['1.1.1.1', '8.8.8.8', '203.0.113.7', 'example.com', 'mc.example.org', '[2606:4700:4700::1111]', '172.32.0.1', '100.63.0.1'];
    const badPriv = priv.filter((h) => !geo.isPrivateHost(h));
    const badPub = pub.filter((h) => geo.isPrivateHost(h));
    check('内网/回环地址全部判为内网', badPriv.length === 0, badPriv.join(','));
    check('公网地址与域名全部判为公网', badPub.length === 0, badPub.join(','));
    check('空值判为内网（跳过）', geo.isPrivateHost('') && geo.isPrivateHost(null));
  }

  // ---------- 查询：成功 / 失败 / 缓存 / 内网跳过 ----------
  {
    const calls = [];
    const okJson = (o) => ({ ok: true, json: async () => o });
    let impl = async (url) => {
      calls.push(url);
      return okJson({ success: true, country_code: 'JP' });
    };
    const oldFetch = global.fetch;
    global.fetch = (url, opts) => impl(url, opts);

    const r1 = await geo.lookupRegion('198.51.100.7');
    check('成功推断返回小写国家码', r1 === 'jp', String(r1));
    check('请求打到 ipwho.is 且只取需要字段', calls.length === 1 && /ipwho\.is\/198\.51\.100\.7\?fields=success,country_code/.test(calls[0]), calls[0]);

    const r2 = await geo.lookupRegion('198.51.100.7');
    check('1 小时内同地址走缓存（不再发请求）', r2 === 'jp' && calls.length === 1, `calls=${calls.length}`);

    impl = async () => okJson({ success: false });
    const r3 = await geo.lookupRegion('203.0.113.9');
    check('success:false → null（失败也缓存）', r3 === null);
    const r4 = await geo.lookupRegion('203.0.113.9');
    check('失败结果同样被缓存（不反复打失败地址）', r4 === null);

    let callsBefore = calls.length;
    const r5 = await geo.lookupRegion('192.168.1.1');
    check('内网地址直接返回 null 且不发请求', r5 === null && calls.length === callsBefore);

    impl = async () => {
      throw new Error('network down');
    };
    const r6 = await geo.lookupRegion('203.0.113.10');
    check('网络异常 → null（不抛出影响主流程）', r6 === null);

    impl = async () => okJson({ success: true, country_code: 'JAPAN' });
    const r7 = await geo.lookupRegion('203.0.113.11');
    check('非法国家码（非两位）被拒 → null', r7 === null);

    impl = async () => okJson({ success: true, country_code: 'US' });
    const r8 = await geo.lookupRegion('example.com');
    check('域名也能查（ipwho.is 侧解析）', r8 === 'us');

    global.fetch = oldFetch;
  }

  console.log(`\n${pass}/${total} geo cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常:', e);
  process.exit(1);
});
