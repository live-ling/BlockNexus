'use strict';
// BlockNexus Agent — 核心解析与下载（含 paperclip 原版核心预置）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。

const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { spawn } = require('child_process');
const { FABRIC_INSTALLER, FABRIC_INSTALLER_JAR, FABRIC_LOADER_API, FORGE_MAVEN, FORGE_MAVEN_BASE, MSL_SOURCES, NEOFORGE_MAVEN, NEOFORGE_MAVEN_BASE, NEOFORGE_MC_PREFIX, PAPERCLIP_SOURCES, PAPER_API, PURPUR_API, mslFetchJson } = require('../catalog.js');
const { downloadToFile, fetchJson, mirrorHostOf, withMirror } = require('../http.js');
const { cmpVersion, mavenVersions, verifyHash } = require('../util.js');
const { sendEvent } = require('../eventbus.js');



module.exports = {
  // ---------- 核心安装 ----------
  // 三类产物形态：
  //   1) 直连 jar（vanilla / paper / purpur / folia / url）→ 下载成 server.jar，直接 -jar 启动
  //   2) 安装器生成的启动脚本（forge / neoforge）→ java @user_jvm_args.txt @libraries/.../args.txt
  //   3) 安装器生成的小启动器（fabric）→ 仍是 -jar，但入口是 fabric-server-launch.jar
  // 后两类没有 server.jar，所以 meta.launch 记录了启动方式，start() 按它拼命令。

  /**
   * 把「核心类型 + 版本（+可选构建号）」解析成一个可下载/可执行的安装计划。
   * 官方源失败时走 MSL 镜像兜底（见 mslResolvePlan）。
   */
  async resolveCorePlan(rec) {
    const { source, version, build } = rec.meta;
    try {
      return await this.resolveCorePlanOfficial(rec);
    } catch (officialErr) {
      if (!MSL_SOURCES.has(source)) throw officialErr;
      try {
        const plan = await this.mslResolvePlan(source, version, build);
        this.emitConsole(rec, `[BlockNexus] 官方源不可用（${officialErr.message}），改用 MSL 镜像源`);
        return plan;
      } catch (mslErr) {
        this.emitConsole(rec, `[BlockNexus] MSL 镜像也不可用: ${mslErr.message}`);
        throw officialErr; // 镜像失败时保留官方错误（更接近根因）
      }
    }
  },

  /**
   * MSL 镜像兜底：来源+版本（+可选构建）→ 下载计划。
   * paper/purpur/folia/vanilla 返回直连 jar；forge/neoforge 返回官方安装器 jar（现场安装）；
   * fabric 返回官方 server jar（自带启动器，可直接 -jar，首启再拉依赖库）。
   * 部分下载返回 sha256，plan 带上供下载后校验。
   */
  async mslResolvePlan(source, version, build) {
    if (!MSL_SOURCES.has(source)) throw new Error('MSL 不支持该核心类型: ' + source);
    const q = build ? '?build=' + encodeURIComponent(build) : '';
    const d = await mslFetchJson(
      '/download/server/' + encodeURIComponent(source) + '/' + encodeURIComponent(version) + q,
      20000,
    );
    if (!d || !d.url) throw new Error('MSL 未返回下载地址');
    let fileName = 'server.jar';
    try { fileName = decodeURIComponent(new URL(d.url).pathname.split('/').pop()) || fileName; } catch {}
    const plan = { url: d.url, fileName };
    if (d.sha256) plan.sha256 = d.sha256;
    if (source === 'forge' || source === 'neoforge') {
      const m = new RegExp('^' + source + '-(.+)-installer\\.jar$').exec(fileName);
      plan.kind = source;
      plan.build = (m && m[1]) || (build ? String(build) : undefined);
    } else if (source === 'fabric') {
      plan.kind = 'direct'; // fabric server jar 可直接 -jar 启动
      plan.fileName = 'server.jar';
    } else {
      plan.kind = 'direct';
      if (build) plan.build = String(build);
    }
    return plan;
  },

  /** 官方源解析（resolveCorePlan 主体） */
  async resolveCorePlanOfficial(rec) {
    const { source, version, build } = rec.meta;
    const meta = rec.meta;

    if (source === 'url') {
      return { kind: 'direct', url: meta.url, fileName: 'server.jar' };
    }
    if (source === 'paper' || source === 'folia') {
      // 注意：/versions/{v} 里的 builds 只是构建号数组；完整对象（含下载链接）在 /versions/{v}/builds
      const d = await fetchJson(
        `${PAPER_API}/${source}/versions/${encodeURIComponent(version)}/builds`,
        15000,
      );
      const builds = Array.isArray(d.builds) ? d.builds : Array.isArray(d) ? d : [];
      if (!builds.length) throw new Error(`${source} ${version} 没有可用构建`);
      // 构建号是纯数字递增，取最大的即该 MC 版本的最新构建
      const latest = builds.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
      const pick = build ? builds.find((b) => String(b.id) === String(build)) : latest;
      if (!pick) throw new Error(`构建 #${build} 不存在`);
      const dl = pick.downloads && pick.downloads['server:default'];
      if (!dl || !dl.url) throw new Error('该构建没有服务端下载');
      return { kind: 'direct', url: dl.url, fileName: dl.name || 'server.jar', build: String(pick.id) };
    }
    if (source === 'purpur') {
      const d = await fetchJson(`${PURPUR_API}/${encodeURIComponent(version)}`, 15000);
      const builds = d.builds || {};
      const id = build || builds.latest;
      if (!id) throw new Error(`purpur ${version} 没有可用构建`);
      return {
        kind: 'direct',
        url: `${PURPUR_API}/${encodeURIComponent(version)}/${id}/download`,
        fileName: `purpur-${version}-${id}.jar`,
        build: id,
      };
    }
    if (source === 'fabric') {
      const loaders = await fetchJson(FABRIC_LOADER_API, 15000);
      const loader = Array.isArray(loaders) ? loaders[0] : null;
      if (!loader) throw new Error('未取到 Fabric Loader 版本');
      return {
        kind: 'fabric',
        url: `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${FABRIC_INSTALLER}/${FABRIC_INSTALLER_JAR}`,
        fileName: 'fabric-installer.jar',
        loader: loader.version,
        game: version,
      };
    }
    if (source === 'forge') {
      // build 里存的是完整 maven 版本（如 1.20.1-47.2.0），没带就现查该 MC 版本的最新
      let full = build;
      if (!full) {
        const xml = await this.httpGetText(FORGE_MAVEN, 20000);
        let best = null;
        for (const v of mavenVersions(xml)) {
          const m = new RegExp(`^${version.replace(/\./g, '\\.')}-(.+)$`).exec(v);
          if (m && (!best || cmpVersion(m[1], best.build) > 0)) best = { build: m[1], full: v };
        }
        if (!best) throw new Error(`Forge 没有 ${version} 的版本`);
        full = best.full;
      }
      return {
        kind: 'forge',
        url: `${FORGE_MAVEN_BASE}/${full}/forge-${full}-installer.jar`,
        fileName: `forge-${full}-installer.jar`,
        build: full,
      };
    }
    if (source === 'neoforge') {
      let full = build;
      if (!full) {
        const xml = await this.httpGetText(NEOFORGE_MAVEN, 20000);
        const prefix = NEOFORGE_MC_PREFIX[version];
        if (!prefix) throw new Error(`NeoForge 暂不支持 ${version}（版本映射未知）`);
        let best = null;
        for (const v of mavenVersions(xml)) {
          if (!v.startsWith(prefix)) continue;
          if (!best || cmpVersion(v, best) > 0) best = v;
        }
        if (!best) throw new Error(`NeoForge 没有 ${version} 的版本`);
        full = best;
      }
      return {
        kind: 'neoforge',
        url: `${NEOFORGE_MAVEN_BASE}/${full}/neoforge-${full}-installer.jar`,
        fileName: `neoforge-${full}-installer.jar`,
        build: full,
      };
    }
    // vanilla
    const data = await this.ensureVersions();
    const v = data.versions.find((x) => x.id === version);
    if (!v) throw new Error('版本不存在: ' + version);
    const mirror = mirrorHostOf();
    let vjson;
    try {
      vjson = await fetchJson(v.url);
    } catch (e) {
      if (!mirror || v.url.includes(mirror)) throw e;
      vjson = await fetchJson(withMirror(v.url, mirror));
    }
    const url = vjson.downloads && vjson.downloads.server && vjson.downloads.server.url;
    if (!url) throw new Error('该版本没有服务端下载（可能是快照/旧版）');
    return { kind: 'direct', url, fileName: 'server.jar' };
  },

  async downloadJar(rec, customUrl = null) {
    const { name, version, source } = rec.meta;
    const dir = this.instDir(name);
    const progress = (phase, pct) => sendEvent('install.progress', { instance: name, phase, pct });
    const onPct = (got, total) => {
      if (!total) return;
      const pct = Math.floor((got / total) * 100);
      if (pct % 5 === 0) progress('download', pct);
    };

    progress('download', 0);
    const plan = customUrl
      ? { kind: 'direct', url: customUrl, fileName: 'server.jar' }
      : await this.resolveCorePlan(rec);

    // ---- 安装器类：下载 installer → 现场安装 → 记录启动方式 ----
    if (plan.kind === 'fabric' || plan.kind === 'forge' || plan.kind === 'neoforge') {
      const tmp = path.join(dir, plan.fileName);
      try {
        await downloadToFile(plan.url, tmp, onPct);
        if (plan.sha256) await verifyHash(tmp, plan.sha256, 'sha256');
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw new Error(`${plan.kind} 安装器下载失败: ${e.message}`);
      }
      progress('install', 0);
      const launch = await this.runInstaller(rec, plan, tmp);
      rec.meta.launch = launch;
      rec.meta.installState = 'ready';
      rec.meta.build = plan.build || rec.meta.build;
      delete rec.meta.error;
      this.saveMeta(rec);
      this.emitConsole(rec, `[BlockNexus] ${source} ${version} 安装完成，可以启动了`);
      this.emitUpdated(rec);
      return;
    }

    // ---- 直连 jar：官方源 → 镜像兜底 ----
    const tmp = path.join(dir, 'server.jar.tmp');
    const mirror = customUrl ? null : mirrorHostOf();
    try {
      await downloadToFile(plan.url, tmp, onPct);
    } catch (e) {
      const mirrored = withMirror(plan.url, mirror);
      if (!mirror || mirrored === plan.url) throw e;
      progress('download', 0);
      this.emitConsole(rec, `[BlockNexus] 官方源下载失败（${e.message}），改用镜像源重试`);
      await downloadToFile(mirrored, tmp, onPct);
    }
    if (plan.sha256) {
      try {
        await verifyHash(tmp, plan.sha256, 'sha256');
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        throw e;
      }
    }
    fs.renameSync(tmp, path.join(dir, 'server.jar'));
    rec.meta.launch = { kind: 'jar', file: 'server.jar' };
    rec.meta.installState = 'ready';
    rec.meta.build = plan.build || rec.meta.build;
    delete rec.meta.error;
    this.saveMeta(rec);
    this.emitConsole(rec, `[BlockNexus] server.jar (${version}) 下载完成，可以启动了`);
    this.emitUpdated(rec);
    // 预下载放在「可以启动了」之后：这句话讲的是 server.jar 已就位，先报出来
    // 用户才能立刻点启动；预下载与启动请求会经 ensureBootstrapVanilla 的单飞去重合并，
    // 不会因为并发而重复下载或重复起进程。
    if (PAPERCLIP_SOURCES.has(source)) await this.ensureBootstrapVanilla(rec);
  },

  /**
   * 预置 paperclip 首启需要的原版核心（Paper/Purpur/Folia）：
   * server.jar 只是 paperclip 引导器，首次启动它会自己连 piston-data.mojang.com 下载
   * 原版 jar 到 cache/mojang_<版本>.jar —— 国内服务器连不上官方源就会一直启动失败。
   * 这里用「官方源 → BMCLAPI 镜像」提前把文件放好并按清单 sha1 校验，
   * paperclip 检测到文件存在且哈希匹配就会跳过下载。
   * 任何失败只告警不阻断启动（paperclip 仍会自行尝试，行为与旧版一致）。
   *
   * 并发去重：安装完成与每次启动前都会调用，首启时同一实例可能同时被多个入口触发
   * （连点启动、面板代下后立即启动等）。同一「实例+版本」的在途任务复用同一个 Promise，
   * 避免多个调用同时写同一个临时文件互相截断（历史上曾导致 sha1 校验读到别人写的内容、
   * 以及 rmSync 删掉别人正在写的文件报 ENOENT）。
   */
  ensureBootstrapVanilla(rec) {
    const version = rec.meta.version;
    if (!version) return Promise.resolve();
    const target = path.join(this.instDir(rec.meta.name), 'cache', `mojang_${version}.jar`);

    const key = rec.meta.name + '|' + version;
    const inflight = this.bootstrapJobs.get(key);
    if (inflight) return inflight; // 复用进行中的任务，不再重复下载
    const job = this.doBootstrapVanilla(rec, version, target).finally(() => {
      this.bootstrapJobs.delete(key); // 失败后下次仍可重试
    });
    this.bootstrapJobs.set(key, job);
    return job;
  },

  async doBootstrapVanilla(rec, version, target) {
    // 已就位：有 sha1 旁证时核对一遍（自愈被写坏/被污染的缓存），没有旁证则信任
    // （paperclip 自己下的文件没有旁证；核对不通过就走下面的重下流程）
    if (fs.existsSync(target)) {
      let expected = '';
      try {
        expected = fs.readFileSync(target + '.sha1', 'utf8').trim();
      } catch {}
      if (!expected) return; // 无旁证 → 视为就位（与 paperclip 的判定一致）
      try {
        await verifyHash(target, expected, 'sha1');
        return;
      } catch {
        this.emitConsole(rec, `[BlockNexus] 缓存的原版核心校验不符，重新下载（cache/mojang_${version}.jar）`);
      }
    }
    // 临时文件用「进程 + 序号」唯一命名：即使去重被绕过（例如两个 Agent 进程共用实例目录），
    // 也不会互相截断或删掉对方正在写的文件
    this.bootstrapSeq = (this.bootstrapSeq || 0) + 1;
    const tmp = `${target}.${process.pid}.${this.bootstrapSeq}.tmp`;
    this.emitConsole(rec, `[BlockNexus] ${rec.meta.source} 首次启动需要原版核心 ${version}，正在预下载（避免 paperclip 直连官方源超时）…`);
    try {
      const data = await this.ensureVersions();
      const v = data.versions.find((x) => x.id === version);
      if (!v) throw new Error('版本清单里没有 ' + version);
      const mirror = mirrorHostOf();
      let vjson;
      try {
        vjson = await fetchJson(v.url, 15000);
      } catch (e) {
        if (!mirror || v.url.includes(mirror)) throw e;
        vjson = await fetchJson(withMirror(v.url, mirror), 15000);
      }
      const dl = vjson.downloads && vjson.downloads.server;
      if (!dl || !dl.url) throw new Error('版本清单缺少原版服务端下载地址');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const mirrored = withMirror(dl.url, mirror);
      // 官方源与镜像源各试一次：「下载失败」与「sha1 不符」都换源重试
      // （内容不符通常是 CDN 缓存损坏，换镜像源才有意义）
      const sources = [[dl.url, '官方源']];
      if (mirror && mirrored !== dl.url) sources.push([mirrored, '镜像源']);
      let lastErr = null;
      for (const [url, label] of sources) {
        try {
          if (label === '镜像源') this.emitConsole(rec, `[BlockNexus] 原版核心改用镜像源重试（${lastErr ? lastErr.message : '官方源不可用'}）`);
          await downloadToFile(url, tmp);
          if (dl.sha1) await verifyHash(tmp, dl.sha1, 'sha1');
          fs.renameSync(tmp, target);
          try {
            fs.writeFileSync(target + '.sha1', dl.sha1 || '');
          } catch {}
          this.emitConsole(rec, `[BlockNexus] 原版核心已就位（cache/mojang_${version}.jar）`);
          return;
        } catch (e) {
          lastErr = e;
          try { fs.rmSync(tmp, { force: true }); } catch {}
        }
      }
      throw lastErr || new Error('没有可用的下载源');
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      this.emitConsole(rec, `[BlockNexus] 原版核心预下载失败（${e.message}），交由启动流程自行处理`);
    }
  },

  /**
   * 决定安装器进程要不要强制优先 IPv6。
   * Java 解析双栈域名时逐个 A/AAAA 记录串行重试，且只按 preferIPv4Stack 排序，
   * 没有 Node 那样的 Happy Eyeballs：在国内这类网络里会先撞上不通的 IPv4 记录，
   * 每条耗掉整个连接超时（默认几十秒），最终安装器假死或报超时。
   * 只在「该域名的 A 记录全不通、AAAA 有通」时才追加 -Djava.net.preferIPv6Addresses=true，
   * 纯 IPv4 环境不加，避免反向把它搞坏。探测结果按域名缓存。
   */
  async javaNetFlagFor(host) {
    if (!host) return [];
    if (this.javaNetFlags.has(host)) return this.javaNetFlags.get(host);
    let flag = [];
    try {
      const addrs = await dns.promises.lookup(host, { all: true });
      const v4 = addrs.filter((a) => a.family === 4);
      const v6 = addrs.filter((a) => a.family === 6);
      if (v4.length && v6.length) {
        const reachable = (a, ms) =>
          new Promise((resolve) => {
            const sock = new net.Socket();
            const done = (ok) => {
              sock.destroy();
              resolve(ok);
            };
            sock.setTimeout(ms);
            sock.once('connect', () => done(true));
            sock.once('timeout', () => done(false));
            sock.once('error', () => done(false));
            sock.connect(443, a.address);
          });
        const v4ok = (await Promise.all(v4.slice(0, 2).map((a) => reachable(a, 4000)))).some(Boolean);
        if (!v4ok) {
          const v6ok = (await Promise.all(v6.slice(0, 2).map((a) => reachable(a, 4000)))).some(Boolean);
          if (v6ok) flag = ['-Djava.net.preferIPv6Addresses=true'];
        }
      }
    } catch {}
    this.javaNetFlags.set(host, flag);
    return flag;
  },

  /**
   * 运行官方安装器（无头模式），把安装过程中的输出实时落到实例控制台。
   * 返回启动描述 { kind, file?, argsFile? }，供 start() 使用。
   */
  async runInstaller(rec, plan, installerPath) {
    const dir = this.instDir(rec.meta.name);
    const java = this.javaInfo();
    if (!java.installed) throw new Error('未检测到 Java，无法运行安装器');
    // 安装器自己在 Java 里下载依赖（Fabric 拉 maven、Forge/NeoForge 拉 maven + Mojang），
    // 所以按它要访问的域名决定是否强制 IPv6
    const host = new URL(plan.url).host;
    const netFlag = await this.javaNetFlagFor(host);
    if (netFlag.length) {
      this.emitConsole(rec, `[BlockNexus] ${host} 的 IPv4 不可达，安装器改用 IPv6 优先`);
    }
    let args;
    if (plan.kind === 'fabric') {
      args = [
        ...netFlag,
        '-jar',
        installerPath,
        'server',
        '-mcversion',
        plan.game,
        '-loader',
        plan.loader,
        '-downloadMinecraft',
      ];
    } else {
      // Forge / NeoForge：--installServer 会在当前目录生成 run.sh + libraries
      args = [...netFlag, '-jar', installerPath, '--installServer', '.'];
    }
    this.emitConsole(rec, `[BlockNexus] 运行 ${plan.kind} 安装器: java ${args.join(' ')}`);
    const code = await new Promise((resolve, reject) => {
      const child = spawn(this.javaCmd() || 'java', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const feed = this.makeLineSplitter((t) => this.emitConsole(rec, t));
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('close', () => feed.flush());
      child.on('error', reject);
      child.on('exit', (c) => resolve(c));
    });
    if (code !== 0) throw new Error(`${plan.kind} 安装器退出码 ${code}，详见控制台`);

    if (plan.kind === 'fabric') {
      if (!fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))) {
        throw new Error('安装器未生成 fabric-server-launch.jar');
      }
      return { kind: 'jar', file: 'fabric-server-launch.jar' };
    }
    // Forge / NeoForge：定位 libraries/**/unix|win_args.txt
    const argsFile = this.findModdedArgsFile(dir);
    if (!argsFile) throw new Error('安装器未生成启动参数文件，请查看控制台');
    return { kind: 'argsfile', argsFile };
  },

  /** 在 libraries 下递归找 forge/neoforge 生成的启动参数文件 */
  findModdedArgsFile(dir) {
    const want = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
    const libs = path.join(dir, 'libraries');
    const walk = (d, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(d);
      } catch {
        return null;
      }
      for (const n of names) {
        const p = path.join(d, n);
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (depth >= 6) continue;
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        } else if (n === want) {
          return path.relative(dir, p).split(path.sep).join('/');
        }
      }
      return null;
    };
    return walk(libs, 0);
  }
};
