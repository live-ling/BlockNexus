'use strict';
// BlockNexus Agent — 备份（tar.gz 快照）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');



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
    this.get(name);
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
    await this.tarRun(['-czf', rel, '.'], instDir);
    return { file, size: fs.statSync(backupAbs).size };
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
