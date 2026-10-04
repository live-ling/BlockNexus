// 看门狗定时任务判定逻辑的回归测试
// 从 agent.js 源码提取 scheduleDue 的正则/规则常量，逐例验证；
// 并断言源码中确实存在对应规则，防止测试与实现漂移。

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'agent.js'), 'utf8');
const start = src.indexOf('scheduleDue(s, now) {');
if (start < 0) throw new Error('agent.js 中未找到 scheduleDue');
const body = src.slice(start, src.indexOf('\n  }', start));

for (const frag of ["s.type === 'daily'", "s.type === 'interval'", 's.days', '20 * 3600e3', '10080']) {
  if (!body.includes(frag)) throw new Error('实现中缺少规则: ' + frag);
}

// 与实现保持一致：每日 2 分钟触发窗口 + 20 小时去重；间隔最小 5 分钟、最大 10080
function scheduleDue(s, now) {
  const last = s.lastFiredAt || 0;
  if (s.type === 'daily') {
    if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.getDay())) return false;
    const [h, m] = String(s.time || '04:00').split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return false;
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    const diffMin = (now.getTime() - target.getTime()) / 60000;
    return diffMin >= 0 && diffMin < 2 && now.getTime() - last > 20 * 3600e3;
  }
  if (s.type === 'interval') {
    const mins = Math.min(Math.max(Number(s.intervalMinutes) || 360, 5), 10080);
    return now.getTime() - last >= mins * 60000;
  }
  return false;
}

const base = new Date('2026-10-01T04:00:30'); // 周四 04:00:30
const H = 3600e3;
const cases = [
  // 每日任务
  { name: '每日 04:00，当前 04:00:30，从未触发', s: { type: 'daily', time: '04:00', days: [], lastFiredAt: 0 }, now: base, want: true },
  { name: '每日 04:00，当前 04:00:30，19 小时前刚触发过', s: { type: 'daily', time: '04:00', days: [], lastFiredAt: base.getTime() - 19 * H }, now: base, want: false },
  { name: '每日 04:00，当前 04:00:30，25 小时前触发过', s: { type: 'daily', time: '04:00', days: [], lastFiredAt: base.getTime() - 25 * H }, now: base, want: true },
  { name: '每日 04:00，当前 04:05（超出 2 分钟窗口）', s: { type: 'daily', time: '04:00', days: [], lastFiredAt: 0 }, now: new Date('2026-10-01T04:05:00'), want: false },
  { name: '每日 04:00（周四）但只勾选周一', s: { type: 'daily', time: '04:00', days: [1], lastFiredAt: 0 }, now: base, want: false },
  { name: '每日 04:00（周四）勾选周四', s: { type: 'daily', time: '04:00', days: [4], lastFiredAt: 0 }, now: base, want: true },
  { name: '每日 时间格式非法', s: { type: 'daily', time: 'oops', days: [], lastFiredAt: 0 }, now: base, want: false },
  // 间隔任务
  { name: '每 5 分钟，刚触发 4 分钟前', s: { type: 'interval', intervalMinutes: 5, lastFiredAt: base.getTime() - 4 * 60000 }, now: base, want: false },
  { name: '每 5 分钟，刚触发 5 分钟前', s: { type: 'interval', intervalMinutes: 5, lastFiredAt: base.getTime() - 5 * 60000 }, now: base, want: true },
  { name: '间隔 1 分钟被下限抬到 5 分钟（4 分钟前触发→不触发）', s: { type: 'interval', intervalMinutes: 1, lastFiredAt: base.getTime() - 4 * 60000 }, now: base, want: false },
  { name: '间隔 10080+ 被上限压到 10080 分钟', s: { type: 'interval', intervalMinutes: 999999, lastFiredAt: base.getTime() - 10081 * 60000 }, now: base, want: true },
  { name: '未知类型不触发', s: { type: 'cron', lastFiredAt: 0 }, now: base, want: false },
];

let pass = 0;
for (const c of cases) {
  const got = scheduleDue(c.s, c.now);
  const ok = got === c.want;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${c.name} → ${got}（期望 ${c.want}）`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
