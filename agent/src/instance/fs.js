'use strict';
// BlockNexus Agent — 文件管理与加密通道传输会话
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runCmd, tarCmd } = require('../util.js');



module.exports = {
  // ======================= 文件管理（作用域锁定在实例目录内） =======================

  instanceRoot(name) {
    this.get(name);
    return path.resolve(this.dir, name);
  },

  resolveSafe(root, rel) {
    const cleaned = String(rel || '').replace(/^\/+/, '').replace(/\\/g, '/');
    const resolved = path.resolve(root, cleaned);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('路径越界');
    }
    return resolved;
  },

  listFiles(name, rel) {
    const root = this.instanceRoot(name);
    const dir = this.resolveSafe(root, rel);
    if (!fs.existsSync(dir)) throw new Error('目录不存在');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        try {
          size = e.isDirectory() ? 0 : fs.statSync(full).size;
        } catch {}
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
          mtime: (() => {
            try {
              return fs.statSync(full).mtimeMs;
            } catch {
              return 0;
            }
          })(),
        };
      })
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
  },

  readFile(name, rel, maxKB = 512) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    const st = fs.statSync(file);
    if (st.isDirectory()) throw new Error('目标是目录');
    if (st.size > maxKB * 1024) throw new Error(`文件超过 ${maxKB}KB，不支持在线查看`);
    const head = Buffer.alloc(Math.min(st.size, 8192));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    if (head.includes(0)) throw new Error('二进制文件不支持在线查看');
    return { content: fs.readFileSync(file, 'utf8'), size: st.size, mtime: st.mtimeMs };
  },

  writeFile(name, rel, content) {
    if (Buffer.byteLength(String(content), 'utf8') > 2 * 1024 * 1024) {
      throw new Error('内容超过 2MB，请用上传功能');
    }
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    fs.writeFileSync(file, String(content), 'utf8');
    return { ok: true, size: Buffer.byteLength(String(content), 'utf8') };
  },

  mkdir(name, rel) {
    const root = this.instanceRoot(name);
    const dir = this.resolveSafe(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  },

  deletePath(name, rel) {
    const root = this.instanceRoot(name);
    if (!rel || String(rel).replace(/^\/+|\/+$/g, '') === '') {
      throw new Error('不能删除实例根目录');
    }
    const target = this.resolveSafe(root, rel);
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  },

  // ---------- 复制 / 移动 / 压缩 / 解压 ----------
  // 全部经 resolveSafe 锁定在实例目录内；目标已存在一律报错（前端负责自动改名去重），
  // 避免“粘贴覆盖”静默毁掉服务器文件。

  /** child 是否等于 parent 或位于 parent 内部 */
  isWithinPath(parent, child) {
    return child === parent || child.startsWith(parent + path.sep);
  },

  /** 递归复制（不依赖 fs.cpSync，兼容旧 Node；软链接按普通文件复制内容） */
  copyRecursive(src, dst) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      for (const e of fs.readdirSync(src)) this.copyRecursive(path.join(src, e), path.join(dst, e));
    } else {
      fs.copyFileSync(src, dst);
    }
  },

  copyMovePath(name, from, to, move) {
    const root = this.instanceRoot(name);
    if (!from || !to) throw new Error('缺少源/目标路径');
    const src = this.resolveSafe(root, from);
    const dst = this.resolveSafe(root, to);
    if (src === root) throw new Error('不能对实例根目录操作');
    if (!fs.existsSync(src)) throw new Error('源不存在');
    if (dst === src) throw new Error(move ? '源与目标相同' : '目标与源相同');
    // 移动/复制进自己的子树会造成递归环（mv /world /world/backup），必须拒绝
    if (this.isWithinPath(src, dst)) throw new Error('目标不能在源目录内部');
    if (fs.existsSync(dst)) throw new Error('目标已存在：' + path.basename(dst));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!move) {
      this.copyRecursive(src, dst);
    } else {
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        // 跨盘/跨文件系统 rename 会报 EXDEV：退回复制+删除
        if (e.code !== 'EXDEV') throw e;
        this.copyRecursive(src, dst);
        fs.rmSync(src, { recursive: true, force: true });
      }
    }
    return { ok: true };
  },

  /** 压缩为 .tar.gz（系统 tar，Windows 自带 bsdtar、Linux 常见 GNU tar 均支持） */
  async compressPaths(name, paths, out) {
    const root = this.instanceRoot(name);
    if (!Array.isArray(paths) || !paths.length) throw new Error('未选择要压缩的文件');
    if (!/\.(tar\.gz|tgz)$/i.test(String(out || ''))) throw new Error('压缩包只支持 .tar.gz 格式');
    const outFile = this.resolveSafe(root, out);
    if (fs.existsSync(outFile)) throw new Error('同名压缩包已存在：' + path.basename(outFile));
    const entries = paths.map((p) => {
      const abs = this.resolveSafe(root, p);
      if (abs === root) throw new Error('不能压缩实例根目录');
      if (this.isWithinPath(abs, outFile)) throw new Error('压缩包不能放在被压缩的目录内部');
      return path.relative(root, abs).split(path.sep).join('/');
    });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    await runCmd(tarCmd(), ['-czf', outFile, '-C', root, ...entries]);
    return { ok: true };
  },

  /** 解压 .zip / .tar.gz / .tgz / .tar 到压缩包所在目录（同名覆盖） */
  async extractArchive(name, rel) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      throw new Error('文件不存在');
    }
    if (!st.isFile()) throw new Error('不是文件');
    const destDir = path.dirname(file);
    if (/\.zip$/i.test(file)) {
      if (process.platform === 'win32') {
        // Windows 自带 bsdtar，可直接解 zip
        await runCmd(tarCmd(), ['-xf', file, '-C', destDir]);
      } else {
        // Linux：优先 unzip，缺失再试 bsdtar
        try {
          await runCmd('unzip', ['-o', file, '-d', destDir]);
        } catch (e) {
          if (!/ENOENT|缺少命令/.test(e.message)) throw e;
          await runCmd('bsdtar', ['-xf', file, '-C', destDir]);
        }
      }
    } else if (/\.(tar\.gz|tgz|tar)$/i.test(file)) {
      await runCmd(tarCmd(), ['-xf', file, '-C', destDir]);
    } else {
      throw new Error('仅支持 .zip / .tar.gz / .tgz / .tar');
    }
    return { ok: true };
  },

  // 分块上传：begin → chunk* → finish（写入 <final>.blocknexus-upload，完成后改名）
  // 支持断点续传：begin 带 resume 时优先接续已存在的 .blocknexus-upload 半成品；
  // 用 <final>.blocknexus-upload.meta 记录 {size,lastModified} 指纹，避免同名不同文件误续传。
  // 会话是纯内存的（Agent 重启后丢），但 tmp 文件在磁盘上，resume 按 size 接力。
  uploadBegin(name, dir, filename, size, lastModified, resume) {
    const root = this.instanceRoot(name);
    const dirAbs = this.resolveSafe(root, dir);
    const finalPath = this.resolveSafe(root, path.posix.join(String(dir || '').replace(/^\/+/, ''), filename));
    if (!finalPath.startsWith(root + path.sep)) throw new Error('路径越界');
    if (typeof size === 'number' && size > 200 * 1024 * 1024) throw new Error('单文件上限 200MB');
    const tmpPath = finalPath + '.blocknexus-upload';
    const metaPath = tmpPath + '.meta';
    const chunk = 512 * 1024;

    // 同一路径已有进行中的会话（如上一块 ACK 丢失后浏览器重试）：指纹一致才续用，
    // 并把 seq 清零——续传约定是「begin 之后 seq 从 1 重新计，以 received 为字节准绳」。
    // 指纹不符（同名换文件）必须作废旧会话，否则两份内容会拼在一起。
    for (const [id, up] of this.uploads) {
      if (up.tmpPath !== tmpPath) continue;
      if (resume) {
        const sameFingerprint =
          (typeof size !== 'number' || up.size === size) &&
          (lastModified === undefined || up.lastModified === undefined || up.lastModified === lastModified);
        if (sameFingerprint) {
          up.seq = 0;
          up.at = Date.now();
          return { uploadId: id, chunk, received: up.received, resumed: true };
        }
      }
      this.uploads.delete(id); // 全新上传或换了文件：作废旧会话，tmp 交给下面的续传判定
    }

    let received = 0;
    let resumed = false;
    const metaOk = (() => {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return (
          m.final === path.basename(finalPath) &&
          (m.size === size || typeof size !== 'number') &&
          (lastModified === undefined || m.lastModified === lastModified)
        );
      } catch {
        return false;
      }
    })();
    if (resume && metaOk && fs.existsSync(tmpPath)) {
      const st = fs.statSync(tmpPath);
      // 半成品比目标还大（多半是别的文件残留）→ 不敢续，重来
      if (typeof size === 'number' && st.size > size) {
        fs.rmSync(tmpPath, { force: true });
        fs.rmSync(metaPath, { force: true });
      } else {
        received = st.size;
        resumed = received > 0;
      }
    }
    if (!resumed) {
      fs.writeFileSync(tmpPath, Buffer.alloc(0));
      try {
        fs.writeFileSync(
          metaPath,
          JSON.stringify({ final: path.basename(finalPath), size, lastModified, at: Date.now() }),
        );
      } catch {}
    } else {
      // 刷新时间戳，避免续传中途被 GC 清掉
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        m.at = Date.now();
        fs.writeFileSync(metaPath, JSON.stringify(m));
      } catch {}
    }
    const uploadId = crypto.randomBytes(8).toString('hex');
    this.uploads.set(uploadId, {
      finalPath,
      tmpPath,
      metaPath,
      received,
      seq: 0,
      at: Date.now(),
      size: typeof size === 'number' ? size : undefined,
      lastModified,
    });
    return { uploadId, chunk, received, resumed };
  },

  uploadChunk(uploadId, seq, dataB64, seekTo) {
    const up = this.uploads.get(uploadId);
    if (!up) throw new Error('上传会话不存在或已过期（可重新 begin 续传）');
    // seekTo：续传对齐用。断电/重启可能留下半块，浏览器按 chunk 对齐后截断再续
    if (seekTo !== undefined && seekTo !== null) {
      const pos = Number(seekTo);
      if (!Number.isInteger(pos) || pos < 0 || pos > up.received) throw new Error('续传偏移非法');
      fs.truncateSync(up.tmpPath, pos);
      up.received = pos;
    }
    if (Number(seq) !== up.seq + 1) {
      const e = new Error(`分块乱序 (期望 ${up.seq + 1})`);
      e.received = up.received; // 浏览器据此重新 begin 对齐
      throw e;
    }
    const buf = Buffer.from(String(dataB64 || ''), 'base64');
    fs.appendFileSync(up.tmpPath, buf);
    up.received += buf.length;
    up.seq = Number(seq);
    up.at = Date.now();
    return { received: up.received };
  },

  uploadFinish(uploadId) {
    const up = this.uploads.get(uploadId);
    if (!up) throw new Error('上传会话不存在或已过期');
    fs.renameSync(up.tmpPath, up.finalPath);
    try {
      fs.rmSync(up.metaPath, { force: true });
    } catch {}
    this.uploads.delete(uploadId);
    return { ok: true, size: up.received };
  },

  uploadAbort(uploadId) {
    const up = this.uploads.get(uploadId);
    if (up) {
      try {
        fs.rmSync(up.tmpPath, { force: true });
      } catch {}
      try {
        fs.rmSync(up.metaPath, { force: true });
      } catch {}
      this.uploads.delete(uploadId);
    }
    return { ok: true };
  },

  // 分块下载：begin → chunk*（拉取式）→ finish
  _downloadBeginAbs(absPath) {
    const st = fs.statSync(absPath);
    if (st.isDirectory()) throw new Error('不能下载目录（请先压缩）');
    const fd = fs.openSync(absPath, 'r');
    const downloadId = crypto.randomBytes(8).toString('hex');
    this.downloads.set(downloadId, { fd, pos: 0, size: st.size, at: Date.now() });
    return { downloadId, size: st.size, chunk: 512 * 1024 };
  },

  downloadBegin(name, rel) {
    const root = this.instanceRoot(name);
    const file = this.resolveSafe(root, rel);
    return this._downloadBeginAbs(file);
  },

  downloadChunk(downloadId) {
    const dl = this.downloads.get(downloadId);
    if (!dl) throw new Error('下载会话不存在或已过期');
    const len = Math.min(512 * 1024, dl.size - dl.pos);
    const buf = Buffer.alloc(len);
    fs.readSync(dl.fd, buf, 0, len, dl.pos);
    dl.pos += len;
    dl.at = Date.now();
    return { dataB64: buf.toString('base64'), eof: dl.pos >= dl.size };
  },

  downloadFinish(downloadId) {
    const dl = this.downloads.get(downloadId);
    if (dl) {
      try {
        fs.closeSync(dl.fd);
      } catch {}
      this.downloads.delete(downloadId);
    }
    return { ok: true };
  },

  gcTransferSessions() {
    const now = Date.now();
    // 上传会话放慢到 2h：会话虽在内存里，tmp 半成品支持断点续传，过期即删（resume 就没了）
    for (const [id, up] of this.uploads) {
      if (now - up.at > 2 * 3600e3) {
        try {
          fs.rmSync(up.tmpPath, { force: true });
        } catch {}
        try {
          fs.rmSync(up.metaPath, { force: true });
        } catch {}
        this.uploads.delete(id);
      }
    }
    for (const [id, dl] of this.downloads) {
      if (now - dl.at > 30 * 60e3) {
        try {
          fs.closeSync(dl.fd);
        } catch {}
        this.downloads.delete(id);
      }
    }
  }
};
