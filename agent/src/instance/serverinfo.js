'use strict';
// BlockNexus Agent — 封禁名单、图标、域名探测、模组、server.properties
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');



module.exports = {
  // ---------- 封禁目录：banned-players.json / banned-ips.json 的查看与解封 ----------
  // 运行中走控制台 pardon 命令（服务器内存里的封禁表才是真相源）；停止时直接改 JSON 文件
  banList(name) {
    const rec = this.get(name);
    const dir = this.instDir(name);
    const readJson = (file) => {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) return [];
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    };
    const st = this.statusOf(rec);
    return {
      players: readJson('banned-players.json'),
      ips: readJson('banned-ips.json'),
      running: st === 'running' || st === 'starting',
    };
  },

  banUnban(name, kind, target) {
    const rec = this.get(name);
    const t = String(target || '').trim();
    if (!t) throw new Error('缺少解封目标');
    const st = this.statusOf(rec);
    if (st === 'running' || st === 'starting') {
      const cmd = kind === 'ip' ? `pardon-ip ${t}` : `pardon ${t}`;
      this.command(name, cmd);
      return { ok: true, via: 'console' };
    }
    // 停止状态：服务器不在运行，直接从 JSON 里移除该条目
    const file = kind === 'ip' ? 'banned-ips.json' : 'banned-players.json';
    const p = path.join(this.instDir(name), file);
    if (!fs.existsSync(p)) return { ok: true, via: 'file' };
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(arr)) arr = [];
    } catch {
      throw new Error(file + ' 不是合法 JSON，请用文件管理器检查');
    }
    const filtered = arr.filter((e) => e && (kind === 'ip' ? e.ip : e.name) !== t);
    fs.writeFileSync(p, JSON.stringify(filtered, null, 2));
    return { ok: true, via: 'file' };
  },

  // ---------- server-icon：64x64 PNG（前端压缩后以 base64 上传） ----------
  iconPath(name) {
    return path.join(this.instDir(name), 'server-icon.png');
  },

  iconGet(name) {
    const p = this.iconPath(name);
    if (!fs.existsSync(p)) return { ok: false };
    return { ok: true, b64: fs.readFileSync(p).toString('base64') };
  },

  iconSet(name, b64) {
    const buf = Buffer.from(String(b64 || ''), 'base64');
    if (!buf.length || buf.length > 200 * 1024) throw new Error('图片数据无效（64x64 PNG 应远小于 200KB）');
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      throw new Error('仅支持 PNG 格式');
    }
    fs.writeFileSync(this.iconPath(name), buf);
    return { ok: true };
  },

  // 域名连通检测：解析实例「域名」并 TCP 探测实例端口。
  // 先查 Minecraft SRV 记录（_minecraft._tcp.<域名>，命中则用 SRV 的目标与端口），
  // 无 SRV 回退 A 记录 + meta 端口；探测对象是解析出的 IP，玩家视角的连通性。
  async domainCheck(name) {
    const rec = this.get(name);
    const raw = String(rec.meta.address || '').trim();
    if (!raw) throw new Error('该实例未设置域名');
    const dns = require('dns').promises;
    const net = require('net');
    // 地址允许手滑带协议头或端口，统一剥干净
    let domain = raw.replace(/^[a-z]+:\/\//i, '').split('/')[0];
    let explicitPort = null;
    const pm = domain.match(/^(.+):(\d+)$/);
    if (pm && !net.isIP(pm[1])) {
      domain = pm[1];
      explicitPort = Number(pm[2]);
    }
    const out = {
      domain,
      srv: null,
      host: domain,
      ip: null,
      port: explicitPort ?? rec.runtimePort ?? rec.meta.port,
      tcp: false,
      latencyMs: null,
      error: null,
    };
    try {
      try {
        const records = await dns.resolveSrv('_minecraft._tcp.' + domain);
        if (records && records.length) {
          records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
          out.srv = { host: records[0].name, port: records[0].port };
          out.host = records[0].name;
          out.port = records[0].port;
        }
      } catch {} // 无 SRV 是常态，走 A 记录
      const addrs = await dns.resolve4(out.host).catch(() => null);
      out.ip = addrs ? addrs[0] : (await dns.lookup(out.host)).address;
      const t0 = Date.now();
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host: out.ip, port: out.port }, () => {
          out.tcp = true;
          out.latencyMs = Date.now() - t0;
          sock.destroy();
          resolve();
        });
        sock.setTimeout(3000, () => {
          sock.destroy();
          reject(new Error('TCP 连接超时（3 秒）'));
        });
        sock.on('error', (e) => reject(new Error('TCP 连接失败: ' + e.message)));
      });
    } catch (e) {
      out.error = e.message || '检测失败';
    }
    return out;
  },

  // ---------- Mod 管理：实例 mods 目录的列表 / 启停（.disabled 后缀约定）/ 删除 ----------
  // 全部路径锁定在 instances/<name>/mods 内；禁用 = 改名加 .disabled（Forge/Fabric 通用约定）
  modsDir(name) {
    return path.join(this.instDir(name), 'mods');
  },

  modsList(name) {
    const rec = this.get(name);
    const dir = this.modsDir(name);
    const out = [];
    let exists = true;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile()) continue;
        let file = ent.name;
        let disabled = false;
        if (file.toLowerCase().endsWith('.disabled')) {
          disabled = true;
          file = ent.name.slice(0, -'.disabled'.length);
        }
        if (!/\.jar$/i.test(file)) continue;
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(dir, ent.name));
          size = st.size;
          mtime = st.mtimeMs;
        } catch {}
        out.push({ name: file, file: ent.name, disabled, size, mtime });
      }
    } catch (e) {
      if (e.code === 'ENOENT') exists = false;
      else throw e;
    }
    out.sort((a, b) => a.disabled - b.disabled || a.name.localeCompare(b.name));
    return { exists, dir, mods: out };
  },

  modsToggle(name, file, disable) {
    const dir = path.resolve(this.modsDir(name));
    const base = String(file || '');
    if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) {
      throw new Error('非法文件名');
    }
    const from = path.resolve(dir, base);
    if (!from.startsWith(dir + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(from)) throw new Error('文件不存在');
    let to;
    if (disable) {
      if (!/\.jar$/i.test(base)) throw new Error('仅 .jar 文件可禁用');
      to = from + '.disabled';
    } else {
      if (!/\.disabled$/i.test(base)) throw new Error('该文件未处于禁用状态');
      to = from.replace(/\.disabled$/i, '');
    }
    if (fs.existsSync(to)) throw new Error('目标文件已存在: ' + path.basename(to));
    fs.renameSync(from, to);
    return { ok: true, file: path.basename(to), disabled: !!disable };
  },

  modsDelete(name, file) {
    const dir = path.resolve(this.modsDir(name));
    const base = String(file || '');
    if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) {
      throw new Error('非法文件名');
    }
    const target = path.resolve(dir, base);
    if (!target.startsWith(dir + path.sep)) throw new Error('路径越界');
    if (!fs.existsSync(target)) throw new Error('文件不存在');
    fs.rmSync(target, { force: true });
    return { ok: true };
  },

  // ---------- server.properties 读写（面板做可视化配置用） ----------
  propertiesPath(name) {
    return path.join(this.instanceRoot(name), 'server.properties');
  },

  getProperties(name) {
    this.get(name);
    const file = this.propertiesPath(name);
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = '#Minecraft server properties\n';
    }
    return { content };
  },

  // 写回配置：只改值、保留注释与顺序；写完同步面板侧元信息
  saveProperties(name, content) {
    const rec = this.get(name);
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new Error('配置内容过大');
    const lines = text.split(/\r?\n/);
    const bad = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (!/^[A-Za-z0-9_.\-]+\s*=/.test(t)) bad.push(t.slice(0, 60));
    }
    if (bad.length) throw new Error('存在非法配置行（应为 key=value）：' + bad.slice(0, 3).join(' / '));

    fs.writeFileSync(this.propertiesPath(name), text, 'utf8');

    // 同步面板展示与服务端查询会用到的字段
    const props = {};
    for (const line of lines) {
      const m = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(line);
      if (m) props[m[1]] = m[2];
    }
    let changed = false;
    const port = Number(props['server-port']);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== rec.meta.port) {
      rec.meta.port = port;
      changed = true;
    }
    if (props.motd !== undefined && props.motd !== rec.meta.motd) {
      rec.meta.motd = props.motd;
      changed = true;
    }
    if (props['online-mode'] !== undefined) {
      const on = props['online-mode'] === 'true';
      if (on !== rec.meta.onlineMode) {
        rec.meta.onlineMode = on;
        changed = true;
      }
    }
    if (changed) this.saveMeta(rec);
    this.emitConsole(rec, '[BlockNexus] server.properties 已更新' + (rec.proc ? '（需重启实例后生效）' : ''));
    this.emitUpdated(rec);
    return { ok: true, metaSynced: changed };
  }
};
