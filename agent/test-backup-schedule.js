// 存档定时备份的回归测试
// 1) 断言源码接线齐全（模块挂载、30s 轮询、RPC 分发、备份前的 save-off/save-all 与保留份数清理）
// 2) 用 stub this 功能性验证 setBackupSchedule 的校验规则
// 3) 用真实临时目录验证 pruneBackups 的保留份数清理

const fs = require('fs');
const os = require('os');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

// ---------- 1. 源码接线断言 ----------
const bsSrc = read('src', 'instance', 'backup-schedule.js');
for (const frag of [
  'defaultBackupSchedule() {',
  "return { enabled: false, keepCount: 0, schedules: [] };", // 老数据保持现状：默认不清理
  'setBackupSchedule(name, cfg = {}) {',
  'checkBackupSchedules() {',
  'this.scheduleDue(s, now)', // 复用看门狗的到期判定
  'this.saveMeta(rec);', // 先落盘 lastFiredAt 再触发，防重复
  "trigger: 'schedule'",
  '备份正在进行中', // 上一次备份未结束时跳过本次定时触发，不误报失败
]) {
  if (!bsSrc.includes(frag)) throw new Error('backup-schedule.js 缺少: ' + frag);
}

const mgrSrc = read('src', 'instance', 'manager.js');
for (const frag of [
  "require('./backup-schedule.js')",
  'this.checkBackupSchedules()', // 30 秒轮询
  'rec.meta.backupSchedule || this.defaultBackupSchedule()', // instance.list 回传前端
]) {
  if (!mgrSrc.includes(frag)) throw new Error('manager.js 缺少: ' + frag);
}

const backupsSrc = read('src', 'instance', 'backups.js');
for (const frag of [
  'rec.backupBusy', // 防并发
  "'save-off'",
  "'save-all flush'",
  "'save-on'",
  'this.pruneBackups(name,', // 备份成功后按保留份数清理
]) {
  if (!backupsSrc.includes(frag)) throw new Error('backups.js 缺少: ' + frag);
}

if (!read('src', 'agent.js').includes("'instance.backupSchedule.set'")) {
  throw new Error('agent.js 缺少 instance.backupSchedule.set 分发');
}
if (!read('..', 'panel', 'api.js').includes('/servers/:id/instances/:name/backup-schedule')) {
  throw new Error('panel/api.js 缺少 backup-schedule 路由');
}

// ---------- 2. setBackupSchedule 校验规则 ----------
const bs = require('./src/instance/backup-schedule.js');

function makeStub(rec) {
  return {
    get: () => rec,
    saved: 0,
    saveMeta() {
      this.saved++;
    },
    emitUpdated() {},
    defaultBackupSchedule: bs.defaultBackupSchedule,
  };
}

const shape = bs.defaultBackupSchedule();
if (shape.enabled !== false || shape.keepCount !== 0 || !Array.isArray(shape.schedules)) {
  throw new Error('defaultBackupSchedule 形状不符: ' + JSON.stringify(shape));
}

// keepCount 收敛 + schedules 校验
const rec1 = { meta: {} };
const stub1 = makeStub(rec1);
const out1 = bs.setBackupSchedule.call(stub1, 'a', {
  enabled: 1,
  keepCount: -5,
  schedules: [
    { time: 'oops', intervalMinutes: 1, days: [0, 9, 3] },
    { id: 'keep-me', time: '05:30', lastFiredAt: 12345 },
    ...Array.from({ length: 11 }, (_, i) => ({ time: '01:00', _i: i })),
  ],
});
if (out1.enabled !== true) throw new Error('enabled 未收敛为布尔');
if (out1.keepCount !== 0) throw new Error('keepCount 负数应收敛为 0');
if (out1.schedules.length !== 10) throw new Error('schedules 应截断到 10 条，实际 ' + out1.schedules.length);
const s0 = out1.schedules[0];
if (s0.time !== '04:00') throw new Error('非法时间应回退 04:00');
if (s0.intervalMinutes !== 5) throw new Error('间隔下限应为 5 分钟');
if (JSON.stringify(s0.days) !== '[0,3]') throw new Error('days 应过滤越界值: ' + JSON.stringify(s0.days));
if (s0.lastFiredAt === 12345) throw new Error('新任务不应继承无关 lastFiredAt');
const s1 = out1.schedules[1];
if (s1.id !== 'keep-me') throw new Error('id 应保留');
if (s1.time !== '05:30') throw new Error('时间应保留');
if (!(s1.lastFiredAt > 0)) throw new Error('新任务 lastFiredAt 应为当前时间');
if (stub1.saved !== 1) throw new Error('setBackupSchedule 应落盘 saveMeta');

// 同 id 老任务：lastFiredAt 以 Agent 侧已存的为准（客户端传值不覆盖），新任务从现在开始计时
const recA = { meta: {} };
const stubA = makeStub(recA);
const first = bs.setBackupSchedule.call(stubA, 'a', { schedules: [{ id: 'keep-me', time: '05:30' }] });
const t1 = first.schedules[0].lastFiredAt;
const second = bs.setBackupSchedule.call(stubA, 'a', {
  schedules: [{ id: 'keep-me', time: '06:00', lastFiredAt: 999 }],
});
if (second.schedules[0].lastFiredAt !== t1) throw new Error('同 id 老任务应保留 Agent 侧 lastFiredAt');
if (second.schedules[0].time !== '06:00') throw new Error('同 id 老任务的其他字段应更新');
const third = bs.setBackupSchedule.call(stubA, 'a', {
  schedules: [{ id: 'keep-me', time: '06:00' }, { id: 'new-one', time: '07:00' }],
});
if (third.schedules[0].lastFiredAt !== t1) throw new Error('再次保存时老任务 lastFiredAt 不应变');
if (!(third.schedules[1].lastFiredAt >= t1)) throw new Error('新任务 lastFiredAt 应为当前时间');

// keepCount 上限与非数字
const rec2 = { meta: {} };
const stub2 = makeStub(rec2);
const out2 = bs.setBackupSchedule.call(stub2, 'a', { keepCount: 9999 });
if (out2.keepCount !== 1000) throw new Error('keepCount 上限应为 1000');
// 非数字收敛为 0；不传 schedules 时保留上次配置（rec1 已有 10 条）
const out3 = bs.setBackupSchedule.call(stub1, 'a', { keepCount: 'abc' });
if (out3.keepCount !== 0) throw new Error('非数字 keepCount 应收敛为 0');
if (out3.schedules.length !== 10) throw new Error('不传 schedules 应保留上次配置');

// ---------- 3. pruneBackups 保留份数清理 ----------
const backups = require('./src/instance/backups.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-prune-'));
const names = [];
for (let i = 0; i < 5; i++) {
  const f = `srv-2026010${i}-00000${i}.tar.gz`;
  fs.writeFileSync(path.join(tmp, f), 'x');
  const t = new Date(Date.now() - (100 - i) * 60000); // i 越大越新
  fs.utimesSync(path.join(tmp, f), t, t);
  names.push(f);
}
const pruneStub = { backupsDir: () => tmp, backupList: backups.backupList };

// keepCount=0 不清理
if (backups.pruneBackups.call(pruneStub, 'srv', 0).length !== 0) throw new Error('keepCount=0 不应清理');
// keepCount=5 数量未超不清理
if (backups.pruneBackups.call(pruneStub, 'srv', 5).length !== 0) throw new Error('未超出份数不应清理');
// keepCount=2 清掉最旧 3 个
const removed = backups.pruneBackups.call(pruneStub, 'srv', 2);
const left = fs.readdirSync(tmp).sort();
if (removed.length !== 3) throw new Error('应清理 3 个，实际 ' + removed.length);
if (JSON.stringify(left) !== JSON.stringify(['srv-20260103-000003.tar.gz', 'srv-20260104-000004.tar.gz'])) {
  throw new Error('清理后应只剩最新 2 份，实际: ' + left.join(', '));
}

console.log('test-backup-schedule: all checks passed');
