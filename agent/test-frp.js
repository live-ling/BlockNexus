'use strict';
// frp 托管（panel/frp.js）的回归测试：配置生成 / 校验 / 进程状态机。
//
// 进程部分用**真实子进程**（process.execPath 冒充 frpc）：
//   · 它会在 1 秒内因为参数不合法而退出 → 正好覆盖"启动早退"这条错误路径；
//   · 不需要下载 frpc 二进制，也不会真的连 frps。

const fs = require('fs');
const os = require('os');
const path = require('path');
const frp = require(path.join(__dirname, '..', 'panel', 'frp.js'));

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---------- 纯函数 ----------
  eq('隧道 ID 解析（过滤非数字）', frp.parseTunnelIds('1, 2 ,abc,3'), ['1', '2', '3']);
  eq('SakuraFrp 启动参数', frp.buildSakuraArgs({ sakura: { token: 'tk', tunnels: '11,22' } }), [
    '-f',
    'tk:11,22',
    '-n',
  ]);
  eq('缺 token/隧道时返回 null', frp.buildSakuraArgs({ sakura: { token: '', tunnels: '1' } }), null);
  eq('TOML 字符串转义', frp.tomlStr('a"b\\c\nd'), '"a\\"b\\\\c d"');
  eq('端口钳制', [frp.clampPort(0), frp.clampPort(70000), frp.clampPort(25565)], [0, 0, 25565]);

  const toml = frp.buildUpstreamToml({
    upstream: {
      serverAddr: 'frps.example.com',
      serverPort: 7000,
      authToken: 'secret',
      proxies: [
        { name: 'mc', type: 'tcp', localPort: 25565, remotePort: 30001 },
        { name: 'bedrock', type: 'udp', localPort: 19132, remotePort: 30002 },
      ],
    },
  });
  ok('TOML 含 serverAddr/port', toml.includes('serverAddr = "frps.example.com"') && toml.includes('serverPort = 7000'));
  ok('TOML 含 auth.token', toml.includes('auth.token = "secret"'));
  ok('TOML 含两条 proxy', (toml.match(/\[\[proxies\]\]/g) || []).length === 2);
  ok('TOML 含 remotePort', toml.includes('remotePort = 30001') && toml.includes('remotePort = 30002'));
  ok('TOML 含 udp 类型', toml.includes('type = "udp"'));
  ok('TOML 默认 localIP=127.0.0.1', toml.includes('localIP = "127.0.0.1"'));
  const lanToml = frp.buildUpstreamToml({
    upstream: {
      serverAddr: 'x',
      serverPort: 7000,
      proxies: [{ name: 'mc', type: 'tcp', localPort: 25565, remotePort: 30001, localIP: '192.168.1.50' }],
    },
  });
  ok('TOML 按条目写 localIP（局域网实例）', lanToml.includes('localIP = "192.168.1.50"'));
  ok('isPrivateIPv4 认私网/回环', ['192.168.1.5', '10.0.0.2', '172.16.0.1', '127.0.0.1'].every((ip) => frp.isPrivateIPv4(ip)));
  ok('isPrivateIPv4 不认公网/主机名', !frp.isPrivateIPv4('8.8.8.8') && !frp.isPrivateIPv4('mc.example.com'));
  eq('frpTarget: 本机 → 127.0.0.1', frp.frpTarget('127.0.0.1', true), { targetHost: '127.0.0.1', lan: true });
  eq('frpTarget: 局域网内网 IP', frp.frpTarget('192.168.1.50', false), { targetHost: '192.168.1.50', lan: true });
  eq('frpTarget: 主机名按可达处理', frp.frpTarget('mc.lan', false), { targetHost: 'mc.lan', lan: true });
  eq('frpTarget: 公网 IP 不接（应由对方跑 frpc）', frp.frpTarget('8.8.8.8', false), { targetHost: '8.8.8.8', lan: false });
  const noAuth = frp.buildUpstreamToml({ upstream: { serverAddr: 'x', serverPort: 7000 } });
  ok('无 token 时省略 auth 段', !noAuth.includes('auth.'));

  // ---------- 配置校验 ----------
  {
    const r = frp.normalizeConfig({}, {});
    ok('默认配置可用', r.config && r.config.mode === 'sakura' && r.config.enabled === false);
    ok(
      '启用但没填二进制 → 报错',
      frp.normalizeConfig({ enabled: true, sakura: { token: 't', tunnels: '1' } }, {}).error ===
        'network.frp-binary-required',
    );
    ok(
      'SakuraFrp 缺 token → 报错',
      frp.normalizeConfig({ enabled: true, binaryPath: 'x', sakura: { tunnels: '1' } }, {}).error ===
        'network.frp-credentials-required',
    );
    ok(
      'SakuraFrp 隧道 ID 非法 → 报错',
      frp.normalizeConfig({ enabled: true, binaryPath: 'x', sakura: { token: 't', tunnels: 'abc' } }, {}).error ===
        'network.frp-tunnels-required',
    );
    ok(
      '自建模式缺 serverAddr → 报错',
      frp.normalizeConfig({ enabled: true, mode: 'upstream', binaryPath: 'x', upstream: { proxies: [{}] } }, {}).error ===
        'network.frp-server-required',
    );
    ok(
      '自建模式没代理 → 报错',
      frp.normalizeConfig(
        { enabled: true, mode: 'upstream', binaryPath: 'x', upstream: { serverAddr: 'a' } },
        {},
      ).error === 'network.frp-proxies-required',
    );
    ok(
      '代理端口非法 → 报错',
      frp.normalizeConfig(
        {
          mode: 'upstream',
          upstream: { proxies: [{ name: 'mc', localPort: 0, remotePort: 30001 }] },
        },
        {},
      ).error === 'network.frp-port-invalid',
    );
    ok(
      '代理名非法 → 报错',
      frp.normalizeConfig(
        { mode: 'upstream', upstream: { proxies: [{ name: '坏名字', localPort: 1, remotePort: 2 }] } },
        {},
      ).error === 'network.frp-proxy-name-invalid',
    );
    const lanCfg = frp.normalizeConfig(
      {
        mode: 'upstream',
        upstream: {
          proxies: [{ name: 'mc', localPort: 25565, remotePort: 30001, localIP: '192.168.1.50' }],
        },
      },
      {},
    );
    eq('代理的 localIP 被保留（局域网实例）', lanCfg.config.upstream.proxies[0].localIP, '192.168.1.50');
    const noIpCfg = frp.normalizeConfig(
      { mode: 'upstream', upstream: { proxies: [{ name: 'mc', localPort: 25565, remotePort: 30001 }] } },
      {},
    );
    eq('未填 localIP 时默认 127.0.0.1', noIpCfg.config.upstream.proxies[0].localIP, '127.0.0.1');
    ok(
      'localIP 非法 → 报错',
      frp.normalizeConfig(
        {
          mode: 'upstream',
          upstream: { proxies: [{ name: 'mc', localPort: 1, remotePort: 2, localIP: 'bad ip' }] },
        },
        {},
      ).error === 'network.frp-localip-invalid',
    );
    const merged = frp.normalizeConfig(
      { upstream: { serverAddr: 'a' } },
      { upstream: { authToken: 'keep', proxies: [{ name: 'mc', localPort: 1, remotePort: 2, type: 'tcp' }] } },
    );
    eq('空 token 保留原值', merged.config.upstream.authToken, 'keep');
    eq('未提交 proxies 时保留原列表', merged.config.upstream.proxies.length, 1);
  }

  // ---------- 掩码 ----------
  {
    const pub = frp.publicConfig({
      enabled: true,
      mode: 'sakura',
      binaryPath: 'C:/frpc.exe',
      sakura: { token: 'secret', tunnels: '1' },
      upstream: { serverAddr: 'a', authToken: 'secret2', proxies: [] },
    });
    ok('publicConfig 不泄露 sakura token', pub.sakura.hasToken === true && pub.sakura.token === undefined);
    ok('publicConfig 不泄露 authToken', pub.upstream.hasToken === true && pub.upstream.authToken === undefined);
    eq('publicConfig 保留隧道 ID', pub.sakura.tunnels, '1');
  }

  // ---------- 二进制检查 ----------
  ok('binaryOk 认不存在的路径', !frp.binaryOk('C:/definitely/not/here.exe'));
  ok('binaryOk 认真实文件', frp.binaryOk(process.execPath));

  // ---------- 进程状态机 ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-frp-'));
  try {
    // 陈旧 pid：构造时清掉
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    const mgr = new frp.FrpManager({ dir });
    ok('陈旧 pid 被清理', !fs.existsSync(path.join(dir, 'runtime.json')));
    eq('未运行时 stop 返回 stopped=false', (await mgr.stop()).stopped, false);

    // 二进制不存在
    let code = '';
    try {
      await mgr.start({ mode: 'sakura', binaryPath: path.join(dir, 'nope.exe'), sakura: { token: 't', tunnels: '1' } });
    } catch (e) {
      code = e.code;
    }
    eq('二进制缺失的错误码', code, 'network.frp-binary-missing');

    // 用 node 冒充 frpc：参数不合法 → 800ms 内退出 → 启动失败并附日志
    let early = null;
    try {
      await mgr.start({
        mode: 'sakura',
        binaryPath: process.execPath,
        sakura: { token: 't', tunnels: '1' },
      });
    } catch (e) {
      early = e;
    }
    ok('早退会抛 network.frp-start-failed', early && early.code === 'network.frp-start-failed');
    ok('早退时 runtime.json 已清掉', !fs.existsSync(path.join(dir, 'runtime.json')));
    ok('日志里有 frpc 输出', mgr.logTail(20).join('\n').length > 0);

    // 自建模式：先写 frpc.toml，再启动
    try {
      await mgr.start({
        mode: 'upstream',
        binaryPath: process.execPath,
        upstream: {
          serverAddr: 'frps.example.com',
          serverPort: 7000,
          proxies: [{ name: 'mc', type: 'tcp', localPort: 25565, remotePort: 30001 }],
        },
      });
    } catch {
      // 预期早退
    }
    const tomlFile = path.join(dir, 'frpc.toml');
    ok('自建模式生成了 frpc.toml', fs.existsSync(tomlFile));
    ok('frpc.toml 内容正确', fs.readFileSync(tomlFile, 'utf8').includes('remotePort = 30001'));

    // 已在运行 → start 直接返回 already（用当前进程 pid 冒充活着的 frpc）
    fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const again = await mgr.start({ mode: 'sakura', binaryPath: process.execPath, sakura: { token: 't', tunnels: '1' } });
    ok('已运行时不重复启动', again.already === true);
    fs.rmSync(path.join(dir, 'runtime.json'), { force: true });
    ok('stopSync 无进程时返回 false', mgr.stopSync() === false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- 樱花兼容：user / transport.tls ----------
  const tomlSakura = frp.buildUpstreamToml({
    upstream: {
      user: 's-demo',
      serverAddr: 'frp-top.com',
      serverPort: 8088,
      authToken: 'demo-token',
      tlsEnable: false,
      proxies: [{ name: 'aaa', type: 'tcp', localIP: 'localhost', localPort: 25565, remotePort: 42399 }],
    },
  });
  ok('TOML 输出 user（樱花必需）', tomlSakura.includes('user = "s-demo"'));
  ok('TOML 输出 transport.tls.enable = false', tomlSakura.includes('transport.tls.enable = false'));
  ok('TOML 仍输出代理端口', tomlSakura.includes('remotePort = 42399'));
  ok('tlsEnable=null 时不写 tls 行（老配置行为不变）', !frp.buildUpstreamToml({ upstream: { serverAddr: 'x' } }).includes('transport.tls'));

  // ---------- 粘贴樱花配置：解析 ----------
  const SAKURA_SAMPLE = [
    'user = "s-demo"',
    'auth.token = "demo-token"',
    '',
    'serverAddr = "frp-top.com"',
    'serverPort = 8088',
    '',
    'transport.tls.enable = false',
    'transport.tls.disableCustomTLSFirstByte = false',
    '',
    '[[proxies]]',
    '# id = 29662979',
    'name = "aaa"',
    'type = "tcp"',
    '',
    'localIP = "localhost"',
    'localPort = 25565',
    'remotePort = 42399',
  ].join('\r\n'); // 顺带覆盖 CRLF

  const p = frp.parseSakuraConfig(SAKURA_SAMPLE);
  eq('樱花配置：user', p.value.user, 's-demo');
  eq('樱花配置：auth.token', p.value.authToken, 'demo-token');
  eq('樱花配置：serverAddr', p.value.serverAddr, 'frp-top.com');
  eq('樱花配置：serverPort', p.value.serverPort, 8088);
  eq('樱花配置：tls 透传', p.value.tlsEnable, false);
  eq('樱花配置：代理条目', p.value.proxies, [
    { name: 'aaa', type: 'tcp', localIP: 'localhost', localPort: 25565, remotePort: 42399 },
  ]);
  eq('樱花配置：注释里的隧道 ID', p.value.tunnelIds, ['29662979']);

  // 解析结果能直接喂给 TOML 生成器（闭环）
  const roundTrip = frp.buildUpstreamToml({ upstream: p.value });
  ok('解析 → TOML 闭环：user', roundTrip.includes('user = "s-demo"'));
  ok('解析 → TOML 闭环：tls 关闭', roundTrip.includes('transport.tls.enable = false'));
  ok('解析 → TOML 闭环：远程端口', roundTrip.includes('remotePort = 42399'));

  // 与 POST /network/frp/import 同一条链路：解析结果必须能通过 normalizeConfig
  const imported = frp.normalizeConfig(
    {
      enabled: true,
      mode: 'upstream',
      binaryPath: 'frpc.exe',
      upstream: {
        user: p.value.user,
        authToken: p.value.authToken,
        serverAddr: p.value.serverAddr,
        serverPort: p.value.serverPort,
        tlsEnable: p.value.tlsEnable,
        proxies: p.value.proxies,
      },
    },
    {},
  );
  ok('导入链路：解析结果能通过 normalizeConfig', !imported.error && imported.config.upstream.proxies.length === 1);
  eq('导入链路：tls 关闭被保留', imported.config.upstream.tlsEnable, false);
  eq('导入链路：user 被保存', imported.config.upstream.user, 's-demo');

  // ---------- 粘贴樱花配置：错误路径 ----------
  eq('空文本', frp.parseSakuraConfig('   ').error, 'network.sakura-config-empty');
  eq('缺 user 被拦（樱花会拒绝登录）', frp.parseSakuraConfig(SAKURA_SAMPLE.replace(/^user = .*$/m, '')).error, 'network.sakura-missing-user');
  eq('缺 token', frp.parseSakuraConfig(SAKURA_SAMPLE.replace(/^auth\.token = .*$/m, '')).error, 'network.sakura-missing-token');
  eq('无 proxies', frp.parseSakuraConfig(SAKURA_SAMPLE.split('[[proxies]]')[0]).error, 'network.sakura-no-proxies');
  eq('坏行', frp.parseSakuraConfig('user = "u"\nthis is not toml').error, 'network.sakura-config-invalid');
  eq(
    '重复远程端口',
    frp.parseSakuraConfig(`${SAKURA_SAMPLE}\n[[proxies]]\nname = "bbb"\ntype = "tcp"\nlocalPort = 25566\nremotePort = 42399\n`).error,
    'frp.port-in-use',
  );
  eq(
    '非法代理名',
    frp.parseSakuraConfig(`${SAKURA_SAMPLE}\n[[proxies]]\nname = "-bad-"\ntype = "tcp"\nlocalPort = 1\nremotePort = 2\n`).error,
    'network.frp-proxy-name-invalid',
  );
  eq(
    '不支持的隧道类型（不能被静默当成 tcp）',
    frp.parseSakuraConfig(`${SAKURA_SAMPLE}\n[[proxies]]\nname = "web"\ntype = "http"\nlocalPort = 8080\nremotePort = 2\n`).error,
    'network.sakura-unsupported-type',
  );

  // ---------- 暴露面板风险 ----------
  const expCfg = { upstream: { proxies: [{ name: 'panel', localPort: 3080, remotePort: 38080 }] } };
  const riskOf = (o) => frp.exposureRisk(expCfg, Object.assign({ panelPort: 3080, mayBeExposed: true, authEnabled: false }, o));
  ok('对外可访问 + 未开登录 + 通了面板端口 → 有风险', riskOf({}).risky === true);
  ok('已开登录保护 → 不告警', riskOf({ authEnabled: true }).risky === false);
  ok('面板只听回环 → 不告警', riskOf({ mayBeExposed: false }).risky === false);
  ok('代理端口不是面板端口 → 不告警', riskOf({ panelPort: 3000 }).risky === false);
  ok('没有代理 → 不告警', frp.exposureRisk({}, { panelPort: 3080, mayBeExposed: true, authEnabled: false }).risky === false);
  eq('风险返回命中的端口', riskOf({}).port, 3080);
  eq('风险返回代理名', riskOf({}).proxy, 'panel');

  // ---------- 二进制能力探测（樱花模式需要定制 frpc） ----------
  ok('识别上游 frpc 的 -f 报错', frp.sakuraBinaryUnsupported("Error: unknown shorthand flag: 'f' in -f"));
  ok('识别 Go flag 风格报错', frp.sakuraBinaryUnsupported('flag provided but not defined: -f'));
  ok('识别 -n 报错', frp.sakuraBinaryUnsupported("unknown shorthand flag: 'n' in -n"));
  ok('普通登录失败不误判', !frp.sakuraBinaryUnsupported('login to the server failed: token invalid'));

  // ---------- 状态三态 ----------
  {
    const stDir = path.join(os.tmpdir(), 'bn-frp-status-' + Date.now());
    const stMgr = new frp.FrpManager({ dir: stDir });
    const st = stMgr.status();
    eq('状态：未运行 → stopped', st.state, 'stopped');
    eq('状态：带重连计数', st.restarts, 0);
    eq('状态：带 lastExit', st.lastExit, null);
    eq('状态：没有 pid', st.pid, 0);
    fs.rmSync(stDir, { recursive: true, force: true });
  }

  // ---------- 凭据掩码 / 合并语义 ----------
  const pub = frp.publicConfig({ upstream: { user: 's-secret-user', authToken: 'secret-token-xyz', serverAddr: 'a', proxies: [] } });
  ok('publicConfig 不回 user 原文', pub.upstream.hasUser === true && !JSON.stringify(pub).includes('s-secret-user'));
  ok('publicConfig 不回 token 原文', !JSON.stringify(pub).includes('secret-token-xyz'));
  eq(
    '空 user 字符串 = 保留原值',
    frp.normalizeConfig({ upstream: { user: '' } }, { upstream: { user: 'keep-me' } }).config.upstream.user,
    'keep-me',
  );
  eq(
    'tlsEnable=null = 显式清除',
    frp.normalizeConfig({ upstream: { tlsEnable: null } }, { upstream: { tlsEnable: false } }).config.upstream.tlsEnable,
    null,
  );

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error('frp 测试异常:', e);
  process.exit(1);
});
