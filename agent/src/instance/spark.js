'use strict';
// BlockNexus Agent — spark 性能分析
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const https = require('https');
const fs = require('fs');
const path = require('path');



module.exports = {
  // ---------- spark 性能模组：控制台被动解析 + 实时数据 / profiler / 健康摘要 ----------
  // spark 没有外部查询接口，数据一律走控制台：面板发 spark tps / profiler / health 等命令，
  // trackSpark 在控制台行里解析输出、捕获报告链接；未识别的 spark 行保留原始文本兜底展示。
  sparkCmd(rec, sub) {
    // 代理端核心命令名不同（velocity→sparkv / bungee→sparkb），当前核心类型未内置代理，先留映射位
    const base = 'spark';
    return sub ? `${base} ${sub}` : base;
  },

  sparkState(rec) {
    if (!rec.spark) {
      rec.spark = {
        latest: null,
        reports: [],
        buf: [],
        waiters: [],
        expect: null,
        collectUntil: 0,
        fetchedAt: 0,
        silentUntil: 0,
      };
    }
    return rec.spark;
  },

  // 面板自身发起的 spark 命令：在窗口期内把该实例的 spark 输出从面板控制台隐去
  // （数据仍照常解析）。用户在控制台手动敲 spark 命令没有这个窗口，输出照常显示。
  sparkSilence(rec, ms) {
    const s = this.sparkState(rec);
    s.silentUntil = Date.now() + ms;
  },

  // spark 安装检测：插件端（paper/purpur/folia）在 plugins/，模组端（fabric/forge/neoforge）在 mods/
  sparkDetect(rec) {
    for (const sub of ['mods', 'plugins']) {
      let ents;
      try {
        ents = fs.readdirSync(path.join(this.instDir(rec.meta.name), sub), { withFileTypes: true });
      } catch {
        continue; // 目录不存在（另一端才是插件/模组目录）
      }
      for (const ent of ents) {
        if (!ent.isFile()) continue;
        let file = ent.name;
        const disabled = file.toLowerCase().endsWith('.disabled');
        if (disabled) file = file.slice(0, -'.disabled'.length);
        if (!/^spark.*\.jar$/i.test(file)) continue;
        const vm = /^spark-([\d.]+)/i.exec(file); // spark-1.10.53-fabric.jar → 1.10.53
        return { installed: true, disabled, version: vm ? vm[1] : '', jar: ent.name };
      }
    }
    return { installed: false, disabled: false, version: '', jar: '' };
  },

  // 控制台行统一漏斗（emitConsole）：识别并解析 spark 输出行。
  // 返回 true = 这行是 spark 输出、已由本方法消化，不再进面板控制台
  // （面板轮询 spark tps 一次要打十来行，留着会把控制台刷屏）。
  // 真实格式（v1.10，逐行带 [⚡] 前缀；更老版本为 [spark]）：
  //   [⚡] TPS from last 5s, 10s, 1m, 5m, 15m:
  //   [⚡] *20.0, *20.0, *20.0, 20.0, 20.0        ← 5 值取后 3（1m/5m/15m）；* = 超出目标值
  //   [⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:
  //   [⚡] 5.7/13.7/20.3/35.1; 5.3/12.0/17.8/129.8 ← 取 1m 段的 med/p95 作 MSPT
  //   [⚡] CPU usage from last 10s, 1m, 15m:
  //   [⚡] 22%, 19%, 45% (system)
  //   [⚡] 24%, 21%, 46% (process)                ← 面板取进程占用
  // 表头行与数值行分两行：见到表头先记 expect，数值行到达才写入（expect 10s 过期，
  // 数值行自身也会按内容（纯数字正文）判定，表头行号丢失时不至于全丢）。
  trackSpark(rec, line) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/§./g, '');
    const s = this.sparkState(rec);
    const now = Date.now();
    // [⚡] 是 v1.10 起的标识（[spark-worker-pool-…] 这类线程名不匹配）；其后的正文用 body
    const isSparkLine = /\[(?:⚡|spark)\]/i.test(clean);
    const urlMatch = /https?:\/\/spark\.lucko\.me\/([A-Za-z0-9]+)\b/.exec(clean);
    // 健康报告正文（reply(Iterable) 路径）不带 [⚡] 前缀，只靠 sparkHealth 打开的
    // 收集窗口（collectUntil）整块收进来；窗口外的普通日志行照旧忽略
    const collecting = s.collectUntil > now;
    if (!isSparkLine && !urlMatch && !collecting) return false;
    // 面板自己发出的 spark 命令（轮询/分析/健康摘要）输出不进面板控制台：
    // 数据已被解析成结构化字段在 Spark 面板展示；用户手动敲的 spark 命令没有静默窗口，照常显示
    const hide = s.silentUntil > now;

    s.buf.push({ ts: now, text: clean });
    if (s.buf.length > 300) s.buf.splice(0, s.buf.length - 300);

    // 报告链接（profiler stop / health upload 完成时打印）。命令报错时 spark 会打印
    // 帮助链接（spark.lucko.me/docs），按保留路径排除，只留真正的报告 code
    if (urlMatch) {
      const code = urlMatch[1];
      if (!/^(docs|download|viewer|api|login|static|assets|about)$/i.test(code) && !s.reports.some((r) => r.code === code)) {
        s.reports.unshift({ code, url: `https://spark.lucko.me/${code}`, ts: now });
        if (s.reports.length > 20) s.reports.length = 20;
      }
    }

    // 收集窗口内的非 spark 行（健康报告正文）只收不解析，避免报告里的表头/数值被误当实时数据
    if (collecting && !isSparkLine) return hide;

    const pm = /\[(?:⚡|spark)\]\s*([\s\S]*)$/i.exec(clean);
    const body = pm ? pm[1] : clean;
    if (s.expect && now - s.expect.at > 10000) s.expect = null;
    const decimals = [...body.matchAll(/(\d{1,3}\.\d{1,3})/g)].map((m) => Number(m[1]));
    const apply = (patch, signal) => {
      s.latest = { ...s.latest, ...patch, ts: now };
      s.expect = null;
      // 唤醒等这类数据的请求（sparkStats 的刷新）
      s.waiters = s.waiters.filter((w) => {
        if (w.signal === signal) {
          w.done(null);
          return false;
        }
        return true;
      });
    };

    if (/\(process\)/.test(clean)) {
      const pct = [...clean.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
      if (pct.length) apply({ cpu: pct.slice(0, 3) }, 'cpu'); // 10s/1m/15m
    } else if (/Tick durations/i.test(clean)) {
      s.expect = { kind: 'mspt', at: now };
    } else if (/TPS/i.test(clean) && !/^[\s\d.,*]+$/.test(body)) {
      // 表头行：正文含字母。同行带够数值是旧版单行格式，直接解析
      if (decimals.length >= 3) apply({ tps: decimals.slice(-3) }, 'tps');
      else if (/from last|:\s*$/.test(clean)) s.expect = { kind: 'tps', at: now };
    } else if (s.expect?.kind === 'tps') {
      if (decimals.length >= 3 && /^[\s\d.,*]+$/.test(body)) apply({ tps: decimals.slice(-3) }, 'tps');
    } else if (s.expect?.kind === 'mspt') {
      const seg = clean.includes(';') ? clean.split(';')[1] : clean;
      const m = /(\d{1,4}(?:\.\d+)?)\/(\d{1,4}(?:\.\d+)?)\/(\d{1,4}(?:\.\d+)?)\/(\d{1,4}(?:\.\d+)?)/.exec(seg);
      if (m) apply({ msptMedian: Number(m[2]), msptP95: Number(m[3]) }, 'mspt');
    } else if (decimals.length >= 3 && /^[\s\d.,*]+$/.test(body)) {
      // 表头行丢失（控制台 tail 截断 / 版本文案变化）时的兜底：纯数值逗号行就是 TPS 数值行
      apply({ tps: decimals.slice(-3) }, 'tps');
    }

    // 唤醒行等待者（放在状态更新后，等待者读到的是最新值）
    for (const w of s.waiters) {
      if (w.test && w.test(clean)) w.done(clean);
    }
    return hide;
  },

  // 等下一条匹配的 spark 行（注册之后的行才算，不会命中历史输出）；超时返回 null
  sparkWaitLine(rec, test, timeoutMs) {
    const s = this.sparkState(rec);
    return new Promise((resolve) => {
      let done = false;
      const w = {
        test,
        done: (line) => {
          if (done) return;
          done = true;
          const i = s.waiters.indexOf(w);
          if (i >= 0) s.waiters.splice(i, 1);
          resolve(line);
        },
      };
      s.waiters.push(w);
      const timer = setTimeout(() => w.done(null), timeoutMs);
      if (timer.unref) timer.unref();
    });
  },

  // 等 trackSpark 应用某类数值（signal 标记）；超时返回 false
  sparkWaitSignal(rec, signal, timeoutMs) {
    const s = this.sparkState(rec);
    return new Promise((resolve) => {
      let done = false;
      const w = {
        signal,
        done: () => {
          if (done) return;
          done = true;
          const i = s.waiters.indexOf(w);
          if (i >= 0) s.waiters.splice(i, 1);
          resolve(true);
        },
      };
      s.waiters.push(w);
      const timer = setTimeout(() => w.done(), timeoutMs);
      if (timer.unref) timer.unref();
    });
  },

  sparkFresh(rec) {
    if (!rec.spark || !rec.spark.latest) return null;
    return { ...rec.spark.latest, stale: Date.now() - rec.spark.latest.ts > 45000 };
  },

  // 实时数据：返回安装检测结果 + 最新 TPS/CPU + 报告链接。
  // 刷新节流 20s：面板前端本身 15s 轮询一次，若不节流会把控制台刷屏（spark 一次 tps
  // 要打十来行日志）；面板同时开多个页面/标签时也只会有一次真实刷新。
  async sparkStats(name) {
    const rec = this.get(name);
    const det = this.sparkDetect(rec);
    const running = !!rec.proc;
    const s = this.sparkState(rec);
    const freshEnough = s.latest && Date.now() - s.fetchedAt < 20000;
    if (running && rec.ready && det.installed && !det.disabled && !freshEnough) {
      s.fetchedAt = Date.now();
      try {
        this.sparkSilence(rec, 20000); // 面板自身采样：输出只解析不进控制台
        this.command(name, this.sparkCmd(rec, 'tps'));
        // 输出是多行块：TPS 必到；CPU 基本必到；MSPT 仅部分平台支持（短超时兜底）
        await this.sparkWaitSignal(rec, 'tps', 4000);
        await this.sparkWaitSignal(rec, 'cpu', 1500);
        await this.sparkWaitSignal(rec, 'mspt', 800);
      } catch {
        // 进程刚好退出：直接返回已有缓存值
      }
    }
    return {
      ...det,
      running,
      stats: this.sparkFresh(rec),
      reports: rec.spark ? rec.spark.reports.slice(0, 20) : [],
    };
  },

  async sparkProfiler(name, params = {}) {
    const rec = this.get(name);
    if (!rec.proc) throw new Error('实例未在运行');
    const det = this.sparkDetect(rec);
    if (!det.installed || det.disabled) throw new Error('未检测到已启用的 spark，请先在 Mod 管理里安装');
    const send = (sub, quietMs = 0) => {
      try {
        if (quietMs) this.sparkSilence(rec, quietMs);
        this.command(name, this.sparkCmd(rec, sub));
        return true;
      } catch (e) {
        return e.message;
      }
    };

    if (params.action !== 'stop') {
      const timeoutSec = Math.min(Math.max(Math.round(Number(params.timeoutSec) || 60), 15), 600);
      // 启动反馈 + 分析结束时的报告链接都由面板发起的命令产生，一并静默
      const sent = send(`profiler start --timeout ${timeoutSec}`, Math.max(60000, (timeoutSec + 20) * 1000));
      if (sent !== true) return { started: false, error: sent };
      // start 是即时响应：等第一条 [⚡] 反馈（可能多行，逐行等到关键行）
      const deadline = Date.now() + 4000;
      const seen = [];
      while (Date.now() < deadline) {
        const line = await this.sparkWaitLine(rec, () => true, Math.max(500, deadline - Date.now()));
        if (!line) break;
        seen.push(line);
        if (/already running/i.test(line)) {
          return { started: false, error: 'spark 已有分析在进行中，可先停止再开始' };
        }
        // 「Profiler is now running!」— 启动成功；有背景分析时 spark 会先停止它再启动
        if (/is now running/i.test(line)) return { started: true, timeoutSec };
        if (/Expected flag|Unknown|error/i.test(line)) {
          // 审计 R3：spark 错误回显混进玩家聊天片段（虽概率低，但无任何过滤）。
          // 截断到 200 字符既能容纳正常错误信息，又切断大段跨会话回显。
          // 同时去 ANSI/Minecraft 格式（clean 已做过）与控制字符——后者在前端
          // 渲染仍可能造成零宽/方向控制符之类的可读性问题。
          const truncated = String(line.replace(/^.*?\[(?:⚡|spark)\]\s*/i, '').trim())
            .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
            .slice(0, 200);
          return { started: false, error: truncated };
        }
      }
      if (!seen.length) return { started: false, error: '未收到 spark 响应，请确认 spark 已正确加载' };
      return { started: true, timeoutSec }; // 文案变化兜底：有响应即认为已下发
    }

    const sent = send('profiler stop', 8000);
    if (sent !== true) return { stopped: false, error: sent };
    // stop 会立即停止并上传，链接一般几秒内出现；没等到也已存进 reports 由轮询带出
    const line = await this.sparkWaitLine(rec, (t) => /spark\.lucko\.me\//.test(t), 45000);
    const m = line && /https?:\/\/spark\.lucko\.me\/([A-Za-z0-9]+)/.exec(line);
    return { stopped: true, code: m ? m[1] : null };
  },

  // 健康摘要：health 命令输出多行报告。语法随版本变化——v1.10 及以前是 `health [--memory]`，
  // 26.x 起改为 `health show [--memory]`；按版本新旧依次尝试，命中报错（Expected flag 等）换下一种。
  // 报告正文由 reply(Iterable) 合并成一条消息发送，续行不带 [⚡] 前缀，故用 collectUntil
  // 开收集窗口整块收（窗口内非 spark 行只缓存不解析，避免报告里的表头被当成实时数据）。
  async sparkHealth(name) {
    const rec = this.get(name);
    if (!rec.proc) throw new Error('实例未在运行');
    const det = this.sparkDetect(rec);
    if (!det.installed || det.disabled) throw new Error('未检测到已启用的 spark');
    const s = this.sparkState(rec);
    let lastLines = [];
    for (const cmd of ['health --memory', 'health show --memory', 'health']) {
      const since = Date.now();
      s.collectUntil = since + 8000;
      this.sparkSilence(rec, 12000); // 面板采样的健康报告同样不进控制台
      try {
        this.command(name, this.sparkCmd(rec, cmd));
      } catch (e) {
        s.collectUntil = 0;
        throw new Error('发送命令失败: ' + e.message);
      }
      await this.sparkWaitLine(rec, () => true, 5000); // 第一行响应（生成中提示或报错）
      await new Promise((r) => setTimeout(r, 2000)); // 报告正文续行聚齐
      s.collectUntil = 0;
      // 去掉日志前缀（时间戳/线程名）与只含 [⚡] 的空行，正文按原样展示
      const strip = (t) =>
        t.replace(/^\[[\d:]+\]\s*\[[^\]]+\]:\s*/, '').replace(/\s+$/, '');
      const lines = s.buf
        .filter((e) => e.ts >= since)
        .map((e) => strip(e.text))
        .filter((t) => t && !/^\[(?:⚡|spark)\]\s*$/i.test(t));
      lastLines = lines;
      // 语法不支持 → 试下一种写法；正文里有成块内容则算成功
      const syntaxErr = lines.some((l) => /Expected flag|Unknown command|unexpected|Usage:/i.test(l));
      if (!syntaxErr && lines.length) return { lines: lines.slice(-60), stats: this.sparkFresh(rec) };
    }
    return { lines: lastLines.slice(-60), stats: this.sparkFresh(rec) };
  }
};
