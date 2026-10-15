'use strict';
// 聊天记录的回归测试（零依赖测试框架）
//
// 为什么需要：聊天记录是**面板长期离线也要保住**的数据，所以解析、落盘、读取三段
// 都得在没有 MC 服务端、没有面板的情况下可验证。重点在：
//   · 只认玩家聊天 / 表情 / 私聊（用户明确要求不存系统消息，误收即噪音）
//   · 日志前缀要吃得下 vanilla / Paper / Forge 三种形态
//   · 正文清洗（控制字符、折行、超长）与 NDJSON 序列化（引号/反斜杠不能破行）
//   · 分页用字节偏移游标：同毫秒多条也不能重、不能漏
//   · 关键词按**字面量**匹配（用户输入不该触发 ReDoS）
//   · 文件有硬上限（轮转）、内存缓冲有硬上限
//   · 权限 0600 / 目录 0700；实例名非法时直接拒绝
//
// 运行：node agent/test-chat-log.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { InstanceManager } = require(path.join(__dirname, 'src', 'instance', 'manager.js'));
const { setHandler } = require(path.join(__dirname, 'src', 'eventbus.js'));

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-chat-'));
const instancesDir = path.join(ROOT, 'instances');

function makeInstance(name) {
  const dir = path.join(instancesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'blocknexus.json'),
    JSON.stringify({ name, version: '1.20.1', port: 25565, memoryMB: 1024, source: 'vanilla', launch: { kind: 'jar', file: 'server.jar' } }),
  );
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake');
  return dir;
}

const T0 = 1700000000000;
const inst = makeInstance('demo');
const m = new InstanceManager(instancesDir);
m._nowOverride = T0;
const rec = m.get('demo');

// 捕获 Agent → 面板的事件（实时显示走这条；历史读取走 chatLog）
const events = [];
setHandler((event, data) => events.push({ event, data }));

// ---------- 1. 解析：必须收的形态 ----------
const parse = (line) => m.parseChatLine(line) || m.parseWhisperLine(line);
const cases = [
  // [日志行, 期望的 {k,n,m} 或 null, 说明]
  ['[12:34:56] [Server thread/INFO]: <Steve> hello', { k: 'chat', n: 'Steve', m: 'hello' }, 'vanilla 聊天'],
  ['[12:34:56] [Async Chat Thread - #0/INFO]: <Steve> 你好世界', { k: 'chat', n: 'Steve', m: '你好世界' }, 'Paper 异步聊天线程 + 中文'],
  ['[12:34:56] [Server thread/INFO]: [Not Secure] <Steve> hi', { k: 'chat', n: 'Steve', m: 'hi' }, '未签名聊天前缀'],
  ['[12:34:56] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: <Steve> hi', { k: 'chat', n: 'Steve', m: 'hi' }, 'Forge 双段日志前缀'],
  ['[12:34:56] [Server thread/INFO]: * Steve waves', { k: 'emote', n: 'Steve', m: 'waves' }, '/me 表情动作'],
  ['[12:34:56] [Server thread/INFO]: <玩家_01> 中文名也能收', { k: 'chat', n: '玩家_01', m: '中文名也能收' }, '非 ASCII 玩家名'],
  ['[12:34:56] [Server thread/INFO]: <Steve>hi', { k: 'chat', n: 'Steve', m: 'hi' }, '尖括号后无空格'],
  ['[12:34:56] [Server thread/INFO]: Steve whispers to Alex: psst', { k: 'whisper', n: 'Steve', m: 'psst' }, '私聊（发给别人）'],
  ['[12:34:56] [Server thread/INFO]: Steve whispers to you: psst', { k: 'whisper', n: 'Steve', m: 'psst' }, '私聊（发给我）'],
  // 必须拒收：系统消息与无关日志
  ['[12:34:56] [Server thread/INFO]: Steve joined the game', null, '加入消息不存'],
  ['[12:34:56] [Server thread/INFO]: Steve left the game', null, '离开消息不存'],
  ['[12:34:56] [Server thread/INFO]: Steve lost connection: Disconnected', null, '掉线消息不存'],
  ['[12:34:56] [Server thread/INFO]: Done (1.9s)! For help, type "help"', null, '就绪行不存'],
  ['[12:34:56] [Server thread/INFO]: There are 2 of a max of 20 players online: A, B', null, '名单行不存'],
  ['[12:34:56] [Server thread/INFO]: <Steve>', null, '空消息不存'],
  ['[BlockNexus] 备份完成: demo.tar.gz', null, 'BlockNexus 自身提示不存'],
  ['[12:34:56] [Server thread/INFO]: * * * Server overloaded * * *', null, '纯星号「名字」不被当表情'],
  ['[12:34:56] [Server thread/INFO]: [LuckPerms] Loaded 12 users', null, '插件日志不存'],
  ['', null, '空行'],
];
for (const [line, want, label] of cases) {
  const got = parse(line);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(`解析「${label}」`, ok, `得到 ${JSON.stringify(got)}`);
}

// ---------- 2. 清洗：控制字符 / 折行 / 超长 / JSON 破坏字符 ----------
{
  const cap = m.PLAYER_DATA.CHAT_MAX_RECORD_CHARS;
  const noisy = parse('[12:34:56] [Server thread/INFO]: <Steve> a\u0000b\u0007c');
  check('控制字符被剥除', noisy && noisy.m === 'abc', JSON.stringify(noisy));
  const multiline = parse('[12:34:56] [Server thread/INFO]: <Steve> line1\nline2');
  check('换行折成空格（NDJSON 一行一条不能被破行）', multiline && multiline.m === 'line1 line2', JSON.stringify(multiline));
  const long = parse('[12:34:56] [Server thread/INFO]: <Steve> ' + 'x'.repeat(cap + 200));
  check(`超长消息被截断到 ${cap} 字符`, long && long.m.length === cap, String(long && long.m.length));
  check('消息里的引号与反斜杠原样保留（交给 JSON.stringify 转义）',
    (() => { const r = parse('[12:34:56] [Server thread/INFO]: <Steve> a"b\\c'); return r && r.m === 'a"b\\c'; })(),
    JSON.stringify(parse('[12:34:56] [Server thread/INFO]: <Steve> a"b\\c')));
}

// ---------- 3. 落盘：NDJSON 追加 + 事件推送 ----------
const chatFile = path.join(inst, m.PLAYER_DATA.PLAYER_DATA_DIR, m.PLAYER_DATA.CHAT_FILE);
{
  m._nowOverride = T0;
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: <Steve> hello');
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: Steve joined the game'); // 系统消息不该进文件
  m._nowOverride = T0 + 1000;
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: <Alex> 换行"引号\\反斜杠');
  check('未到时间片时只在内存缓冲（不落盘）', !fs.existsSync(chatFile), chatFile);
  m.flushChat(rec);
  check('flush 后生成 chat.ndjson', fs.existsSync(chatFile), chatFile);
  const lines = fs.readFileSync(chatFile, 'utf8').trim().split('\n');
  check('只写入玩家聊天（系统消息被排除）', lines.length === 2, JSON.stringify(lines));
  const recs = lines.map((l) => JSON.parse(l));
  check('记录字段为 t/k/n/m', recs[0].t === T0 && recs[0].k === 'chat' && recs[0].n === 'Steve' && recs[0].m === 'hello', JSON.stringify(recs[0]));
  check('含引号/反斜杠的消息仍是合法单行 JSON', recs[1].m === '换行"引号\\反斜杠', JSON.stringify(recs[1]));
  check('每批记录都推了 chat 事件（面板实时显示用）',
    events.length === 1 && events[0].event === 'chat' && events[0].data.instance === 'demo' && events[0].data.records.length === 2,
    JSON.stringify(events.map((e) => e.event)));
  if (process.platform !== 'win32') {
    check('chat.ndjson 权限 0600', (fs.statSync(chatFile).mode & 0o777) === 0o600, (fs.statSync(chatFile).mode & 0o777).toString(8));
    check('数据目录权限 0700', (fs.statSync(path.dirname(chatFile)).mode & 0o777) === 0o700, (fs.statSync(path.dirname(chatFile)).mode & 0o777).toString(8));
  }
}

// ---------- 4. 读取：条数 / 顺序 / 过滤 ----------
{
  fs.rmSync(chatFile, { force: true });
  m.chatClear('demo');
  for (let i = 0; i < 10; i++) {
    m._nowOverride = T0 + i * 1000;
    m.emitConsole(rec, `[12:34:56] [Server thread/INFO]: <${i % 2 === 0 ? 'Steve' : 'Alex'}> msg${i}`);
    m.flushChat(rec);
  }
  const all = m.chatLog('demo', { limit: 100 });
  check('读出全部 10 条', all.records.length === 10, String(all.records.length));
  check('记录按时间升序返回（旧 → 新）', all.records[0].m === 'msg0' && all.records[9].m === 'msg9', JSON.stringify(all.records.map((r) => r.m)));
  check('size 是当前文件字节数', all.size === fs.statSync(chatFile).size, `${all.size}`);
  check('本页之前没有更多 → more=false', all.more === false, JSON.stringify({ more: all.more, nextBefore: all.nextBefore }));

  const page1 = m.chatLog('demo', { limit: 3 });
  check('limit 生效（最新 3 条）', page1.records.map((r) => r.m).join(',') === 'msg7,msg8,msg9', page1.records.map((r) => r.m).join(','));
  check('还有更早 → more=true 且给出游标', page1.more === true && page1.nextBefore > 0, JSON.stringify({ more: page1.more, nextBefore: page1.nextBefore }));
  const pages = [page1.records.map((r) => r.m)];
  let cursor = page1.nextBefore;
  for (let i = 0; i < 5 && cursor > 0; i++) {
    const p = m.chatLog('demo', { limit: 3, before: cursor });
    pages.unshift(p.records.map((r) => r.m));
    cursor = p.more ? p.nextBefore : 0;
  }
  const flat = pages.flat();
  check('用字节游标翻完所有页：无重、无漏、顺序正确',
    JSON.stringify(flat) === JSON.stringify(['msg0', 'msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6', 'msg7', 'msg8', 'msg9']),
    JSON.stringify(flat));

  const mine = m.chatLog('demo', { limit: 100, player: 'Alex' });
  check('按玩家过滤（只留 Alex：奇数编号）', mine.records.every((r) => r.n === 'Alex') && mine.records.length === 5, JSON.stringify(mine.records.map((r) => r.m)));
  const kw = m.chatLog('demo', { limit: 100, q: 'MSG1' });
  check('关键词忽略大小写', kw.records.length === 1 && kw.records[0].m === 'msg1', JSON.stringify(kw.records.map((r) => r.m)));
  const re = m.chatLog('demo', { limit: 100, q: 'msg[0-9]' });
  check('关键词按字面量匹配（不进 RegExp：无匹配就是无匹配，不报错也不乱匹配）',
    re.records.length === 0, JSON.stringify(re.records.map((r) => r.m)));
  const playerLit = m.chatLog('demo', { limit: 100, player: '.*' });
  check('玩家名同样按字面量匹配', playerLit.records.length === 0, String(playerLit.records.length));

  // 轮转/清空过：游标失效 → reset，并给出最新一页
  const stale = m.chatLog('demo', { limit: 3, before: all.size + 99999 });
  check('游标超出文件大小 → reset=true 且返回最新一页',
    stale.reset === true && stale.records.length === 3 && stale.records[2].m === 'msg9',
    JSON.stringify({ reset: stale.reset, m: stale.records.map((r) => r.m) }));
}

// ---------- 5. 坏行容错 ----------
{
  fs.appendFileSync(chatFile, '这不是 JSON\n{"t":1,"k":"chat","n":"Broken"}\n');
  const r = m.chatLog('demo', { limit: 100 });
  check('坏行被跳过、缺字段的行也被跳过，接口不抛错', r.records.length === 10, String(r.records.length));
}

// ---------- 6. 上限：超过 2MB 时轮转，保留最新数据 ----------
{
  const capBytes = m.PLAYER_DATA.CHAT_MAX_BYTES;
  const filler = (i) => JSON.stringify({ t: T0 + i, k: 'chat', n: 'Filler', m: 'f'.repeat(400) }) + '\n';
  let big = '';
  while (big.length < capBytes + 1000) big += filler(big.length);
  fs.writeFileSync(chatFile, big);
  const before = fs.statSync(chatFile).size;
  m._nowOverride = T0 + 999999;
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: <Newcomer> after rotation');
  m.flushChat(rec);
  const after = fs.statSync(chatFile).size;
  check('超过上限时轮转（文件变小）', after < before, `${before} → ${after}`);
  check('轮转后文件仍在上限 + 一批的合理范围内', after <= capBytes + 64 * 1024, String(after));
  const tail = m.chatLog('demo', { limit: 5 });
  check('轮转后仍能读出记录，且最新一条就是刚写入的',
    tail.records.length > 0 && tail.records[tail.records.length - 1].m === 'after rotation',
    JSON.stringify(tail.records.map((r) => r.m)));
}

// ---------- 7. 清空 ----------
{
  const r = m.chatClear('demo');
  check('清空返回被删除的字节数', r.ok === true && r.removedBytes > 0, JSON.stringify(r));
  check('清空后文件不存在', !fs.existsSync(chatFile));
  check('清空后读到空列表（接口仍可用）', m.chatLog('demo', { limit: 10 }).records.length === 0);
}

// ---------- 8. 开关：chat=false 时不记录 ----------
{
  rec.meta.tracking = { players: true, chat: false };
  m._nowOverride = T0 + 1234;
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: <Steve> 不该被记录');
  check('关掉聊天记录后不落盘', !fs.existsSync(chatFile));
  check('关掉聊天记录后也不推 chat 事件', events.filter((e) => e.event === 'chat').every((e) => e.data.records.every((r) => r.m !== '不该被记录')));
  rec.meta.tracking = { players: true, chat: true };
  m.emitConsole(rec, '[12:34:56] [Server thread/INFO]: <Steve> 重新打开后能记');
  m.flushChat(rec);
  check('重新打开后恢复记录', m.chatLog('demo', { limit: 10 }).records.some((r) => r.m === '重新打开后能记'));
}

// ---------- 9. 路径安全：实例名必须存在（不接受任意名字拼路径） ----------
{
  let threw = false;
  try {
    m.chatLog('../evil', { limit: 1 });
  } catch {
    threw = true;
  }
  check('对不存在的实例名（含路径穿越）直接抛错', threw);
  let threw2 = false;
  try {
    m.chatClear('../../etc');
  } catch {
    threw2 = true;
  }
  check('清空同样拒绝非法实例名', threw2);
}

// ---------- 10. 缓冲上限是不变式（flush 总会清空缓冲，这里是二道保险） ----------
check('缓冲上限常量存在（防止磁盘写不进去时内存无限增长）',
  m.PLAYER_DATA.CHAT_PENDING_MAX >= m.PLAYER_DATA.CHAT_FLUSH_MAX,
  `${m.PLAYER_DATA.CHAT_PENDING_MAX} / ${m.PLAYER_DATA.CHAT_FLUSH_MAX}`);

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass}/${total} chat-log cases passed`);
process.exit(pass === total ? 0 : 1);
