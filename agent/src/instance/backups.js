'use strict';
// BlockNexus Agent — 备份（tar.gz 快照）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fmtSize } = require('../util.js');
const { MAP_CACHE_DIR } = require('./map-cache.js');



module.exports = {
  // ---------- 备份（系统 tar 打包到 <instances>/.backups/<name>/） ----------
  backupsDir(name) {
    return path.join(this.dir, '.backups', name);
  },

  backupFilePath(name, file) {
    if (!/^[\w.-]+\.tar\.gz$/i.test(String(file || ''))) throw new Error('非法备份文件名');
    const root = path.resolve(this.backupsDir(name));
    const p = path.join(root, file);
    if (!p.startsWith(root + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(p)) throw new Error('备份不存在');
    return p;
  },

  tarRun(args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn('tar', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => {
        err += d.toString();
      });
      child.on('error', (e) => reject(new Error('系统缺少 tar 命令: ' + e.message)));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('tar 执行失败: ' + err.slice(-400))),
      );
    });
  },

  async backupCreate(name) {
    const rec = this.get(name);
    if (rec.backupBusy) throw new Error('备份正在进行中，请稍后再试');
    rec.backupBusy = true;
    try {
      const dir = this.backupsDir(name);
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const file = `${name}-${stamp}.tar.gz`;
      const instDir = this.instanceRoot(name);
      const backupAbs = path.join(dir, file);
      // 相对路径（相对实例目录），避免 GNU tar 把 Windows 盘符 "D:" 误判为远程主机
      const rel = path.relative(instDir, backupAbs).split(path.sep).join('/');
      // 运行中先让世界落盘（save-off + save-all flush），避免 tar 捕获到正在写入的存档；
      // 命令失败（非原版核心等）只记日志，不阻断备份
      const send = (cmd) => {
        try {
          this.command(name, cmd);
          return true;
        } catch {
          return false;
        }
      };
      const running = !!rec.proc;
      if (running) {
        this.emitConsole(rec, '[BlockNexus] 开始备份：已暂停世界自动保存（save-off）…');
        send('save-off');
        send('save-all flush');
        await new Promise((r) => setTimeout(r, 3000));
      }
      try {
        // 排除地图缓存目录：它是可再生的派生数据（从 world/*.mca 重新渲染即可），
        // 打进备份只会让每份快照白白变大，还会在恢复时把过期缓存盖回实例目录。
        // 目录名来自 map-cache.js（三处共用同一常量，避免改名时漏改一处）。
        await this.tarRun(
          [`--exclude=./${MAP_CACHE_DIR}`, '-czf', rel, '.'],
          instDir,
        );
      } finally {
        if (running) send('save-on');
      }
      const size = fs.statSync(backupAbs).size;
      this.emitConsole(rec, `[BlockNexus] 备份完成: ${file} (${fmtSize(size)})`);
      const removed = this.pruneBackups(name, rec.meta.backupSchedule && rec.meta.backupSchedule.keepCount);
      if (removed.length) {
        this.emitConsole(rec, `[BlockNexus] 已按保留份数清理 ${removed.length} 个最旧备份`);
      }
      return { file, size };
    } finally {
      rec.backupBusy = false;
    }
  },

  // 按保留份数清理最旧备份（keepCount<1 表示不限制；手动与定时备份一起计数）
  pruneBackups(name, keepCount) {
    const n = Math.round(Number(keepCount) || 0);
    if (n < 1) return [];
    const list = this.backupList(name);
    if (list.length <= n) return [];
    const removed = list.slice(n).map((b) => b.file);
    for (const f of removed) {
      try {
        fs.rmSync(path.join(this.backupsDir(name), f), { force: true });
      } catch {}
    }
    return removed;
  },

  backupList(name) {
    const dir = this.backupsDir(name);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /\.tar\.gz$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  },

  async backupRestore(name, file) {
    const rec = this.get(name);
    const bp = this.backupFilePath(name, file);
    if (rec.proc) await this.stopAndWait(rec, 30000, true);
    const instDir = this.instanceRoot(name);
    for (const child of fs.readdirSync(instDir)) {
      fs.rmSync(path.join(instDir, child), { recursive: true, force: true });
    }
    const rel = path.relative(instDir, bp).split(path.sep).join('/');
    await this.tarRun(['-xzf', rel], instDir);
    this.scan();
    this.emitConsole(rec, '[BlockNexus] 备份已恢复: ' + file);
    return { ok: true };
  },

  backupDelete(name, file) {
    fs.rmSync(this.backupFilePath(name, file), { force: true });
    return { ok: true };
  }
};
