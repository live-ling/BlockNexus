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

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error('frp 测试异常:', e);
  process.exit(1);
});
