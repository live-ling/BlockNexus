'use strict';
// 玩家在线时长统计的回归测试（零依赖测试框架）
//
// 为什么需要：用户要求「优化玩家方面，添加玩家在线时间统计」。统计的难点全在
// **边界**上，而不是加法本身：
//   · 会话必须成对（join/leave、SLP 名单、控制台 `list`、进程退出、Agent 被硬杀）
//   · 落盘必须可续（Agent 重启后不能重复计，也不能凭空造时长）
//   · 表必须有上限（按玩家名建键的表 = 可被外部驱动的增长点）
//   · 开关必须真的生效（关掉后不再新增记录）
// 这些都要能在没有 MC 服务端、没有面板的情况下验证，所以直接实例化 InstanceManager，
// 用 _nowOverride 步进时钟（不 sleep），把控制台行喂给 emitConsole。
//
// 运行：node agent/test-player-stats.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { InstanceManager } = require(path.join(__dirname, 'src', 'instance', 'manager.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-pstats-'));
const instancesDir = path.join(ROOT, 'instances');

/** 建一个最简实例目录（有 blocknexus.json + server.jar 即可被 scan 认出来） */
function makeInstance(name) {
  const dir = path.join(instancesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'blocknexus.json'),
    JSON.stringify({
      name,
      version: '1.20.1',
      port: 25565,
      memoryMB: 1024,
      source: 'vanilla',
      launch: { kind: 'jar', file: 'server.jar' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake');
  return dir;
}

const T0 = 1700000000000; // 固定基准时刻：断言里比较的是差值，不受真实时钟影响
const MIN = 60e3;
const log = (ts) => `[${new Date(ts).toISOString().slice(11, 19)}] [Server thread/INFO]: `;

(async () => {
  makeInstance('demo');
  const m = new InstanceManager(instancesDir);
  m._nowOverride = T0;
  const rec = m.get('demo');

  // ---------- 1. 基本会话：join → leave 累计时长 ----------
  m.emitConsole(rec, log(T0) + 'Steve joined the game');
  m.emitConsole(rec, log(T0) + 'Alex joined the game');
  m._nowOverride = T0 + 10 * MIN;
  m.emitConsole(rec, log(T0) + 'Steve left the game');
  m._nowOverride = T0 + 30 * MIN;

  let st = m.playersStats('demo');
  const steve = st.players.find((p) => p.name === 'Steve');
  const alex = st.players.find((p) => p.name === 'Alex');
  check('join 建立玩家记录', !!steve && !!alex);
  check('leave 结算出 10 分钟累计时长', steve && steve.totalMs === 10 * MIN, JSON.stringify(steve));
  check('会话数 +1', steve && steve.sessions === 1, JSON.stringify(steve));
  check('离开后 online=false 且 onlineSince 清空', steve && steve.online === false && steve.onlineSince === null, JSON.stringify(steve));
  check('仍在线的玩家 online=true 且有 onlineSince', alex && alex.online === true && alex.onlineSince === T0, JSON.stringify(alex));
  check('仍在线的玩家累计时长尚未包含当前会话（由 onlineSince 表达）', alex && alex.totalMs === 0, JSON.stringify(alex));
  check('firstSeen / lastSeen 都落在会话边界上', steve && steve.firstSeen === T0 && steve.lastSeen === T0 + 10 * MIN, JSON.stringify(steve));
  check('响应带回 Agent 时间 now（前端据此算时长，免受两端时钟差影响）', st.now === T0 + 30 * MIN, String(st.now));
  check('trackedSince 是首次开始统计的时刻', st.trackedSince === T0, String(st.trackedSince));
  check('实例未运行 → running=false（前端据此提示「仅历史」）', st.running === false);

  // ---------- 2. 二次会话累加；lost connection 也算离开 ----------
  m.emitConsole(rec, log(T0) + 'Steve joined the game');
  m._nowOverride = T0 + 40 * MIN;
  m.emitConsole(rec, log(T0) + 'Steve lost connection: Disconnected');
  st = m.playersStats('demo');
  const steve2 = st.players.find((p) => p.name === 'Steve');
  check('两次会话的时长累加（10 + 10 分钟）', steve2.totalMs === 20 * MIN, JSON.stringify(steve2));
  check('会话数为 2', steve2.sessions === 2, JSON.stringify(steve2));

  // ---------- 3. 控制台名单校准（`list` 输出 / 服务端周期播报） ----------
  m._nowOverride = T0 + 50 * MIN;
  m.emitConsole(rec, log(T0) + 'There are 2 of a max of 20 players online: Alex, Bob_99');
  st = m.playersStats('demo');
  const byName = (n) => st.players.find((p) => p.name === n);
  check('名单里的新玩家被补开会话（Bob_99）', byName('Bob_99') && byName('Bob_99').online === true, JSON.stringify(byName('Bob_99')));
  check('名单里仍在线的玩家保持会话', byName('Alex') && byName('Alex').online === true);
  check('名单外仍在线的玩家被结算关闭（Steve）', byName('Steve') && byName('Steve').online === false && byName('Steve').totalMs === 20 * MIN, JSON.stringify(byName('Steve')));

  // ---------- 4. SLP 名单补录 + SLP 权威 0 人时结算 ----------
  m._nowOverride = T0 + 60 * MIN;
  m.playerSeenOnline(rec, ['Carol']);
  st = m.playersStats('demo');
  check('SLP 名单里的玩家被补开会话（起点=首次看到在线）', byName('Carol') && byName('Carol').onlineSince === T0 + 60 * MIN);
  check('已有会话的玩家不因补录而重复开会话（sessions 不变）', byName('Alex').sessions === 1, JSON.stringify(byName('Alex')));
  m._nowOverride = T0 + 70 * MIN;
  m.closeAllPlayerSessions(rec);
  st = m.playersStats('demo');
  check('全部会话结算后无人在线', st.players.every((p) => !p.online));

  // ---------- 5. 落盘 → 重新装载（模拟 Agent 重启） ----------
  m.flushPlayerStatsNow(rec);
  const file = path.join(instancesDir, 'demo', m.PLAYER_DATA.PLAYER_DATA_DIR, m.PLAYER_DATA.STATS_FILE);
  check('统计写入 <实例目录>/.blocknexus-data/players.json', fs.existsSync(file), file);
  if (process.platform !== 'win32') {
    check('统计文件权限为 0600（同机其他用户读不到玩家数据）', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
    const dirMode = fs.statSync(path.dirname(file)).mode & 0o777;
    check('数据目录权限为 0700', dirMode === 0o700, dirMode.toString(8));
  }

  const m2 = new InstanceManager(instancesDir);
  m2._nowOverride = T0 + 200 * MIN; // 重启后过了很久
  const after = m2.playersStats('demo');
  const steve3 = after.players.find((p) => p.name === 'Steve');
  check('重启后统计被完整装载（累计时长不丢）', steve3 && steve3.totalMs === 20 * MIN, JSON.stringify(steve3));
  check('重启后不把历史会话当成「正在在线」', after.players.every((p) => !p.online));
  check('trackedSince 也随之恢复（而不是重置成重启时刻）', after.trackedSince === T0, String(after.trackedSince));

  // ---------- 6. Agent 被硬杀（会话开着、只有心跳）：按心跳结算，不重复计 ----------
  m2._nowOverride = T0 + 200 * MIN;
  m2.emitConsole(m2.get('demo'), log(0) + 'Dave joined the game');
  m2._nowOverride = T0 + 205 * MIN;
  m2.playerStatsTick(); // 心跳：只推进 hb，不累加 totalMs
  check('心跳不把当前会话算进累计（否则「累计 + 本次在线」会重复计一段时间）',
    m2.playersStats('demo').players.find((p) => p.name === 'Dave').totalMs === 0,
    JSON.stringify(m2.playersStats('demo').players.find((p) => p.name === 'Dave')));
  m2.flushPlayerStatsNow(m2.get('demo'));
  const m3 = new InstanceManager(instancesDir);
  m3._nowOverride = T0 + 999 * MIN;
  const dave = m3.playersStats('demo').players.find((p) => p.name === 'Dave');
  check('硬杀后按最后一次心跳结算（只算到心跳时刻，不多算到重启时刻）', dave && dave.totalMs === 5 * MIN, JSON.stringify(dave));
  check('硬杀后该玩家不再显示为在线（等下次观测重新开会话）', dave && dave.online === false);

  // ---------- 7. 文件损坏：改名留档后从空开始（不静默吞数据、也不让接口一直报错） ----------
  fs.writeFileSync(file, '{ 这不是 JSON');
  const m4 = new InstanceManager(instancesDir);
  const st4 = m4.playersStats('demo');
  check('损坏的统计文件不会让接口抛错', !!st4 && Array.isArray(st4.players));
  check('损坏的文件被改名留档（players.json.corrupt-*）',
    fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('players.json.corrupt-')),
    fs.readdirSync(path.dirname(file)).join(','));

  // ---------- 8. 表上限：超限淘汰「最近在线最早」的那位 ----------
  const cap = m4.PLAYER_DATA.MAX_TRACKED_PLAYERS;
  check(`上限常量存在且为正（${cap}）`, Number.isFinite(cap) && cap > 0);
  for (let i = 0; i < cap; i++) {
    m4._nowOverride = T0 + i;
    m4.applyPlayerEvent(m4.get('demo'), { type: 'join', name: 'P' + i });
  }
  m4._nowOverride = T0 + cap + 1000;
  m4.applyPlayerEvent(m4.get('demo'), { type: 'join', name: 'NEWCOMER' });
  const size = m4.playersStats('demo').players.length;
  let tracked = m4.get('demo').pstats.players;
  check(`玩家表不超过上限（${cap}）`, tracked.size <= cap, `实际 ${tracked.size}`);
  check('超限淘汰的是最近在线最早的那位，新玩家仍在', tracked.has('NEWCOMER') && !tracked.has('P0'),
    `P0 仍在=${tracked.has('P0')} NEWCOMER 仍在=${tracked.has('NEWCOMER')} size=${size}`);

  // ---------- 9. 开关：players=false 时不再新增/更新 ----------
  const rec9 = m4.get('demo');
  rec9.meta.tracking = { players: false, chat: true };
  m4._nowOverride = T0 + 5000;
  m4.emitConsole(rec9, log(0) + 'Nobody joined the game');
  m4.emitConsole(rec9, log(0) + 'Nobody2 joined the game');
  m4.applyPlayerEvent(rec9, { type: 'join', name: 'GHOST' });
  check('关掉统计后不再新增玩家记录', !rec9.pstats.players.has('GHOST'));
  rec9.meta.tracking = { players: true, chat: true };
  m4.applyPlayerEvent(rec9, { type: 'join', name: 'REAL' });
  check('重新打开后立即恢复记录', rec9.pstats.players.has('REAL'));
  check('trackingCfg 对缺省 / 部分字段都给出完整布尔值',
    JSON.stringify(m4.trackingCfg({ meta: {} })) === JSON.stringify({ players: true, chat: true }) &&
    JSON.stringify(m4.trackingCfg({ meta: { tracking: { chat: false } } })) === JSON.stringify({ players: true, chat: false }),
    JSON.stringify(m4.trackingCfg({ meta: { tracking: { chat: false } } })));

  // ---------- 10. list() 暴露 tracking；edit() 能改 ----------
  rec9.meta.tracking = { players: false, chat: true };
  check('instance.list 暴露 tracking（前端据此渲染开关）',
    JSON.stringify(m4.list().find((x) => x.name === 'demo').tracking) === JSON.stringify({ players: false, chat: true }),
    JSON.stringify(m4.list().find((x) => x.name === 'demo').tracking));
  const edited = m4.edit('demo', { tracking: { chat: false } });
  check('instance.edit 只改请求里出现的字段（players 保持 false）',
    edited.tracking.players === false && edited.tracking.chat === false, JSON.stringify(edited.tracking));
  const meta = JSON.parse(fs.readFileSync(path.join(instancesDir, 'demo', 'blocknexus.json'), 'utf8'));
  check('开关已写进实例元数据（Agent 重启后仍生效）', meta.tracking && meta.tracking.chat === false, JSON.stringify(meta.tracking));

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${pass}/${total} player-stats cases passed`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('测试执行失败:', e);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
