'use strict';
// BlockNexus Agent — 看门狗（崩溃自动重启 + 定时重启）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const crypto = require('crypto');
const { sendEvent } = require('../eventbus.js');



module.exports = {
  // ---------- 看门狗：崩溃自动重启 + 定时重启 ----------
  defaultWatchdog() {
    return { autoRestart: false, restartDelaySec: 5, schedules: [] };
  },

  setWatchdog(name, cfg = {}) {
    const rec = this.get(name);
    const cur = rec.meta.watchdog || this.defaultWatchdog();
    const next = { ...cur };
    if (cfg.autoRestart !== undefined) next.autoRestart = !!cfg.autoRestart;
    if (cfg.restartDelaySec !== undefined) {
      next.restartDelaySec = Math.min(Math.max(Number(cfg.restartDelaySec) || 5, 1), 300);
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
    rec.meta.watchdog = next;
    this.saveMeta(rec);
    this.emitUpdated(rec);
    return next;
  },

  // 某个定时任务此刻是否到期
  scheduleDue(s, now) {
    const last = s.lastFiredAt || 0;
    if (s.type === 'daily') {
      if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.getDay())) return false;
      const [h, m] = String(s.time || '04:00').split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return false;
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      const diffMin = (now.getTime() - target.getTime()) / 60000;
      // 到点后 2 分钟窗口内触发一次；20 小时内不重复
      return diffMin >= 0 && diffMin < 2 && now.getTime() - last > 20 * 3600e3;
    }
    if (s.type === 'interval') {
      const mins = Math.min(Math.max(Number(s.intervalMinutes) || 360, 5), 10080);
      return now.getTime() - last >= mins * 60000;
    }
    return false;
  },

  // 每 30 秒检查一次各实例的定时重启任务
  checkWatchdogSchedules() {
    const now = new Date();
    for (const rec of this.map.values()) {
      const wd = rec.meta.watchdog;
      if (!wd || !Array.isArray(wd.schedules) || !wd.schedules.length) continue;
      for (const s of wd.schedules) {
        if (!s.enabled || !this.scheduleDue(s, now)) continue;
        s.lastFiredAt = Date.now();
        this.saveMeta(rec);
        const label = s.type === 'daily' ? `每日 ${s.time}` : `每 ${s.intervalMinutes} 分钟`;
        this.emitConsole(rec, `[BlockNexus] 定时重启触发（${label}）`);
        sendEvent('watchdog.fired', { instance: rec.meta.name, scheduleId: s.id, label });
        if (rec.proc) {
          this.restart(rec.meta.name).catch((e) =>
            this.emitConsole(rec, '[BlockNexus] 定时重启失败: ' + e.message),
          );
        } else {
          this.emitConsole(rec, '[BlockNexus] 定时任务：实例未在运行，已跳过本次重启');
        }
      }
    }
  },

  // 崩溃后延迟自动重启（连续崩溃时逐步退避，最长 60 秒）
  scheduleAutoRestart(rec, code, signal) {
    const wd = rec.meta.watchdog;
    if (!wd || !wd.autoRestart) return;
    const now = Date.now();
    rec.crashTimes = (rec.crashTimes || []).filter((t) => now - t < 10 * 60e3);
    rec.crashTimes.push(now);
    const base = Math.min(Math.max(Number(wd.restartDelaySec) || 5, 1), 300);
    const delay = Math.min(base * rec.crashTimes.length, 60);
    this.emitConsole(
      rec,
      `[BlockNexus] 检测到异常退出 (code=${code}${signal ? ' signal=' + signal : ''})，${delay} 秒后自动重启` +
        (rec.crashTimes.length > 1 ? `（10 分钟内第 ${rec.crashTimes.length} 次）` : ''),
    );
    sendEvent('watchdog.restarting', {
      instance: rec.meta.name,
      code,
      signal: signal || null,
      delay,
      attempt: rec.crashTimes.length,
    });
    clearTimeout(rec.restartTimer);
    rec.restartTimer = setTimeout(() => {
      rec.restartTimer = null;
      // 实例可能已被删除/已手动启动，需再确认
      if (this.map.get(rec.meta.name) !== rec || rec.proc) return;
      this.start(rec.meta.name).catch((e) =>
        this.emitConsole(rec, '[BlockNexus] 自动重启失败: ' + e.message),
      );
    }, delay * 1000);
  }
};
