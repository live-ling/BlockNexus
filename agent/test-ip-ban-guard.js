'use strict';
// ban-ip 误伤防护的回归测试。
//
// 背景：经 frp / 本机端口代理接入时，服务端看到的玩家地址全是 127.0.0.1。
// 这时执行 `ban-ip <玩家>` 会把服务器上所有人一起封掉（解封前谁都进不来）。
// 防护分两半，这里都钉住：
//   1. players.trackPlayers 从登录行记住「玩家名 → 来源 IP」；
//   2. util.ipBanBlockReason 在指令下发前拦截回环地址的 ban-ip。

const path = require('path');
const util = require(path.join(__dirname, '..', 'agent', 'src', 'util.js'));
const players = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'players.js'));
// stripLogPrefix 在 playerdata 混入里（两个模块最终挂到同一个 InstanceManager 上）
const playerdata = require(path.join(__dirname, '..', 'agent', 'src', 'instance', 'playerdata.js'));

let pass = 0;
let total = 0;
function ok(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, got, want) {
  total++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const good = g === w;
  if (good) pass++;
  console.log(`${good ? 'PASS' : 'FAIL'} | ${name} → ${g}（期望 ${w}）`);
}

// ---------- 回环判定 ----------
for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
  ok(`回环地址 ${ip}`, util.isLoopbackIp(ip));
}
for (const ip of ['1.2.3.4', '192.168.1.10', '10.0.0.1', '2408:8207::1', '0.0.0.0', '', null]) {
  ok(`非回环地址 ${JSON.stringify(ip)}`, !util.isLoopbackIp(ip));
}

// ---------- ban-ip 拦截 ----------
const map = new Map([
  ['lingfrom_cn', '127.0.0.1'],
  ['remote_guy', '203.0.113.7'],
]);
{
  const r = util.ipBanBlockReason('ban-ip lingfrom_cn', map);
  ok('回环玩家的 ban-ip 被拒', r.length > 0, r);
  ok('拒绝原因提示改用 ban', r.includes('ban lingfrom_cn'), r);
}
ok('直接写回环 IP 也被拒', util.ipBanBlockReason('ban-ip 127.0.0.1', map) !== '');
ok('IPv6 回环也被拒', util.ipBanBlockReason('ban-ip ::1', map) !== '');
ok('带引号的玩家名也能识别', util.ipBanBlockReason('ban-ip "lingfrom_cn"', map) !== '');
ok('前后空格不影响', util.ipBanBlockReason('  ban-ip   lingfrom_cn  ', map) !== '');
ok('公网 IP 的玩家放行', util.ipBanBlockReason('ban-ip remote_guy', map) === '');
ok('直接写公网 IP 放行', util.ipBanBlockReason('ban-ip 203.0.113.7', map) === '');
ok('未知玩家放行（交给服务端判断）', util.ipBanBlockReason('ban-ip nobody_here', map) === '');
ok('普通 ban 不受影响', util.ipBanBlockReason('ban lingfrom_cn', map) === '');
ok('pardon-ip 不受影响', util.ipBanBlockReason('pardon-ip lingfrom_cn', map) === '');
ok('空指令不报错', util.ipBanBlockReason('', map) === '');
ok('没有 IP 记录时放行', util.ipBanBlockReason('ban-ip lingfrom_cn', undefined) === '');

// ---------- 登录行 IP 跟踪 ----------
{
  const rec = { players: new Set() };
  const self = { stripLogPrefix: playerdata.stripLogPrefix, players: new Set() };

  eq(
    '登录行被识别但不产生 join 事件',
    players.trackPlayers.call(self, rec, '[21:14:48] [Server thread/INFO]: lingfrom_cn[/127.0.0.1:63909] logged in with entity id 48 at (-5.5, 88.0, -23.5)'),
    null,
  );
  eq('记录了玩家来源 IP', rec.playerIps.get('lingfrom_cn'), '127.0.0.1');
  ok('登录行不会提前把人算进在线名单', !rec.players.has('lingfrom_cn'));

  eq(
    'joined the game 产生 join 事件',
    players.trackPlayers.call(self, rec, '[21:14:48] [Server thread/INFO]: lingfrom_cn joined the game'),
    { type: 'join', name: 'lingfrom_cn' },
  );
  ok('在线名单已加入', rec.players.has('lingfrom_cn'));

  eq(
    'IPv6 登录行能拆出地址',
    (() => {
      players.trackPlayers.call(self, rec, '[21:16:00] [User Authenticator #2/INFO]: v6guy[/2408:8207:1234::9:5555] logged in with entity id 7 at (0, 0, 0)');
      return rec.playerIps.get('v6guy');
    })(),
    '2408:8207:1234::9',
  );

  // 用跟踪到的 IP 走一次拦截（必须在断线清除之前）
  ok('跟踪到的回环 IP 会触发拦截', util.ipBanBlockReason('ban-ip lingfrom_cn', rec.playerIps) !== '');

  eq(
    '断线事件返回 leave',
    players.trackPlayers.call(self, rec, '[21:15:18] [Server thread/INFO]: lingfrom_cn lost connection: Disconnected'),
    { type: 'leave', name: 'lingfrom_cn' },
  );
  ok('断线后 IP 记录被清掉', !rec.playerIps.has('lingfrom_cn'));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
