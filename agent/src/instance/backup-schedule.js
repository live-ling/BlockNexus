'use strict';
// BlockNexus Agent — 存档定时备份（每日/固定间隔计划 + 保留份数清理）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const crypto = require('crypto');
const { sendEvent } = require('../eventbus.js');



module.exports = {
  // ---------- 定时备份 ----------
  defaultBackupSchedule() {
    // keepCount 默认 0 = 不清理：老实例没有该字段时保持现状（备份只增不减）
    return { enabled: false, keepCount: 0, schedules: [] };
  },

  setBackupSchedule(name, cfg = {}) {
    const rec = this.get(name);
    const cur = rec.meta.backupSchedule || this.defaultBackupSchedule();
    const next = { ...cur };
    if (cfg.enabled !== undefined) next.enabled = !!cfg.enabled;
    if (cfg.keepCount !== undefined) {
      next.keepCount = Math.min(Math.max(Math.round(Number(cfg.keepCount) || 0), 0), 1000);
    }
    if (Array.isArray(cfg.schedules)) {
      next.schedules = cfg.schedules.slice(0, 10).map((s) => {
        const prev = (cur.schedules || []).find((x) => x.id === s.id);
        return {
          id: String(s.id || crypto.randomBytes(4).toString('hex')),
          enabled: s.enabled !== false,
          type: s.type === 'interval' ? 'interval' : 'daily',
          time: /^\d{1,2}:\d{2}$/.test(s.time || '') ? s.time : '04:00',
          days: Array.isArray(s.days) ? s.days.filter((d) => d >= 0 && d <= 6) : [],
          intervalMinutes: Math.min(Math.max(Number(s.intervalMinutes) || 360, 5), 10080),
          // 新任务从现在开始计时，避免保存后立刻触发；老任务保留上次触发时间
          lastFiredAt: prev ? prev.lastFiredAt : Date.now(),
        };
      });
    }
    rec.meta.backupSchedule = next;
    this.saveMeta(rec);
    this.emitUpdated(rec);
    return next;
  },

  // 每 30 秒检查一次各实例的定时备份任务（与定时重启同一节拍；实例停止时也照常备份）
  checkBackupSchedules() {
    const now = new Date();
    for (const rec of this.map.values()) {
      const bs = rec.meta.backupSchedule;
      if (!bs || !bs.enabled || !Array.isArray(bs.schedules) || !bs.schedules.length) continue;
      for (const s of bs.schedules) {
        if (!s.enabled || !this.scheduleDue(s, now)) continue;
        s.lastFiredAt = Date.now();
        this.saveMeta(rec); // 先落盘再去备份，崩溃/重启也不会重复触发
        const label = s.type === 'daily' ? `每日 ${s.time}` : `每 ${s.intervalMinutes} 分钟`;
        this.emitConsole(rec, `[BlockNexus] 定时备份触发（${label}）`);
        this.backupCreate(rec.meta.name)
          .then((r) =>
            sendEvent('backup.updated', {
              instance: rec.meta.name,
              done: true,
              ok: true,
              file: r.file,
              trigger: 'schedule',
            }),
          )
          .catch((e) => {
            if (/备份正在进行中/.test(e.message)) {
              this.emitConsole(rec, '[BlockNexus] 上一次备份仍在进行，本次定时触发已跳过');
              return;
            }
            this.emitConsole(rec, '[BlockNexus] 定时备份失败: ' + e.message);
            sendEvent('backup.updated', {
              instance: rec.meta.name,
              done: true,
              ok: false,
              error: e.message,
              trigger: 'schedule',
            });
          });
      }
    }
  },
};
