'use strict';
// SSH 安装器：连接远程服务器 → 安装/检查 Node.js → 上传 agent.js 与 agent.json →
// 注册 systemd 服务（无 systemd 则用 nohup 拉起）。
// 注意：建议使用 root 账户；非 root 用户需要免密 sudo。

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const NODE_MIN_MAJOR = 16;
// tarball 回退用的 Node LTS 版本（distro 源/NodeSource 都装不上时）
const NODE_TARBALL_VERSION = 'v20.18.1';

/** SSH 主机密钥指纹（OpenSSH 风格 SHA256 base64，去掉尾部 = 填充） */
function hostKeyFingerprint(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'binary');
  return 'SHA256:' + crypto.createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

/**
 * TOFU 主机密钥判定（单独成函数以便直接测试——它是这条防线的全部逻辑）。
 *
 * 不做校验的后果：任何能做中间人的人都能拿到 SSH 凭据并完全接管服务器。
 * 而「首次就必须人工核对指纹」对本项目的单人使用场景太重——用户手上通常
 * 没有服务器指纹，逼他核对只会让人把整个功能关掉。
 *
 * 因此采 TOFU（首次使用即信任），与 agent.tlsFingerprint 同一思路：
 *   · 首次（记录为空）：记录并放行；
 *   · 之后：比对，不一致即拒绝——挡住**后续**的中间人，
 *     以及服务器被重装/换机导致的密钥变更（会明确报错，而不是静默连到陌生主机）。
 *
 * ⚠ 已知边界：首次连接本身仍可能被中间人利用（TOFU 的固有代价）。
 *
 * @returns {{ ok: boolean, fingerprint: string, recorded: boolean, error: string|null }}
 */
function verifyHostKey(server, key) {
  const fp = hostKeyFingerprint(key);
  const known = String((server.ssh && server.ssh.hostKeyFingerprint) || '');
  if (!known) return { ok: true, fingerprint: fp, recorded: true, error: null };
  if (known === fp) return { ok: true, fingerprint: fp, recorded: false, error: null };
  return {
    ok: false,
    fingerprint: fp,
    recorded: false,
    error:
      'SSH 主机密钥与首次记录的不一致，已拒绝连接。\n' +
      `  记录的指纹: ${known}\n` +
      `  本次的指纹: ${fp}\n` +
      '  这可能是服务器被重装/换机（若确属正常，清除该服务器的 SSH 指纹后重试），\n' +
      '  也可能是中间人攻击——请在确认前不要继续。',
  };
}

function sshConnect(server, readyTimeout = 20000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    // hostVerifier 只能返回布尔值，带不出原因；把原因记在这里，连接报错时替换掉
    // ssh2 那句没信息量的 "Host verification failed"。
    let hostKeyError = null;
    let recordedFingerprint = false;
    const opts = {
      host: server.host,
      port: server.ssh.port,
      username: server.ssh.user,
      readyTimeout,
      keepaliveInterval: 10000,
      // ---------- 主机密钥校验（TOFU：首次信任）----------
      // 不做校验的后果：任何能做中间人的人都能拿到 SSH 凭据并完全接管服务器。
      // 而「首次就必须人工核对指纹」对本项目的单人使用场景太重——用户手上
      // 通常没有服务器指纹，逼他核对只会让人直接跳过这个功能。
      //
      // 因此采 TOFU（首次使用即信任），与 agent.tlsFingerprint 同一思路：
      //   · 首次连接：记录指纹并放行；
      //   · 之后每次：比对，不一致即**拒绝**（返回 false 让 ssh2 中断连接）。
      // 能挡住的是**后续**的中间人，以及服务器被重装/换机导致的密钥变更——
      // 后者会明确报错，而不是静默连到一台陌生主机上。
      //
      // ⚠ 已知边界：首次连接本身仍可能被中间人利用（TOFU 的固有代价）。
      hostVerifier: (key) => {
        const r = verifyHostKey(server, key);
        if (!r.ok) {
          hostKeyError = r.error;
          return false;
        }
        if (r.recorded) {
          server.ssh.hostKeyFingerprint = r.fingerprint; // 记在配置记录上，由调用方持久化
          recordedFingerprint = true;
        }
        return true;
      },
    };
    if (server.ssh.auth === 'key') {
      const key = server.ssh.key || fs.readFileSync(server.ssh.keyPath, 'utf8');
      opts.privateKey = key;
    } else {
      opts.password = server.ssh.password;
      opts.tryKeyboard = false;
    }
    conn.on('ready', () => {
      // 暴露给调用方：本次是否新记录了指纹（据此决定要不要落盘）
      conn._bnRecordedHostKey = recordedFingerprint;
      resolve(conn);
    });
    conn.on('error', (e) => reject(new Error(hostKeyError || 'SSH 连接失败: ' + e.message)));
    conn.connect(opts);
  });
}

function run(conn, cmd, onOut) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => {
        out += d.toString();
        if (onOut) onOut(d.toString());
      });
      stream.stderr.on('data', (d) => {
        out += d.toString();
        if (onOut) onOut(d.toString());
      });
      stream.on('close', (code) => resolve({ code, out }));
    });
  });
}

async function runChecked(conn, cmd, log) {
  const { code, out } = await run(conn, cmd, (chunk) => log(chunk, true));
  if (code !== 0) throw new Error(`命令失败 (exit ${code}): ${cmd}\n${out.slice(-2000)}`);
  return out.trim();
}

function detectPM(out) {
  if (out.includes('apt')) return 'apt';
  if (out.includes('dnf')) return 'dnf';
  if (out.includes('yum')) return 'yum';
  if (out.includes('apk')) return 'apk';
  return null;
}

// Node tarball 回退：npmmirror（国内快）→ TUNA → 官方 dist，按 CPU 架构选包
function nodeTarballUrls(arch) {
  const name = `node-${NODE_TARBALL_VERSION}-linux-${arch}`;
  return [
    `https://npmmirror.com/mirrors/node/${NODE_TARBALL_VERSION}/${name}.tar.gz`,
    `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/${NODE_TARBALL_VERSION}/${name}.tar.gz`,
    `https://nodejs.org/dist/${NODE_TARBALL_VERSION}/${name}.tar.gz`,
  ];
}

async function ensureNode(conn, sudo, log) {
  const probe = 'node -v 2>/dev/null || /usr/local/bin/node -v 2>/dev/null || true';
  const versionNow = async () => {
    const r = await run(conn, probe);
    const m = /v(\d+)\./.exec(r.out.trim());
    return m ? { full: r.out.trim(), major: Number(m[1]) } : null;
  };
  let cur = await versionNow();
  if (cur && cur.major >= NODE_MIN_MAJOR) {
    log(`检测到 Node.js ${cur.full}\n`);
    return;
  }
  log(`未检测到 Node.js (>=${NODE_MIN_MAJOR})，开始安装…\n`);
  const osInfo = await run(
    conn,
    'cat /etc/os-release 2>/dev/null; command -v apt-get dnf yum apk curl wget 2>/dev/null; uname -m',
  );
  const pm = detectPM(osInfo.out);
  const arch = /aarch64|arm64/.test(osInfo.out) ? 'arm64' : 'x64';
  const hasCurl = /curl/.test(osInfo.out);
  const hasWget = /wget/.test(osInfo.out);

  // 发行版源：失败不中断（源可能被墙/残缺），后面还有回退链
  if (pm === 'apt') {
    await run(conn, `${sudo}apt-get update -y`, log);
    await run(conn, `${sudo}apt-get install -y nodejs npm`, log);
  } else if (pm === 'dnf' || pm === 'yum') {
    await run(conn, `${sudo}dnf install -y nodejs || ${sudo}yum install -y nodejs`, log);
  } else if (pm === 'apk') {
    await run(conn, `${sudo}apk add --no-cache nodejs npm`, log);
  }
  cur = await versionNow();
  if (cur && cur.major >= NODE_MIN_MAJOR) {
    log(`Node.js 安装完成: ${cur.full}\n`);
    return;
  }

  // NodeSource（apt 系，发行版 Node 过旧时）：连接/安装失败也继续走 tarball 回退
  if (pm === 'apt' && (!cur || cur.major < NODE_MIN_MAJOR)) {
    log('发行版 Node 版本过旧或不可用，尝试 NodeSource 20.x…\n');
    await run(conn, `${sudo}apt-get install -y ca-certificates curl gnupg`, log);
    await run(
      conn,
      `curl -fsSL --connect-timeout 10 --max-time 120 https://deb.nodesource.com/setup_20.x | ${sudo}bash -`,
      log,
    );
    await run(conn, `${sudo}apt-get install -y nodejs`, log);
    cur = await versionNow();
    if (cur && cur.major >= NODE_MIN_MAJOR) {
      log(`Node.js 安装完成: ${cur.full}\n`);
      return;
    }
  }

  // tarball 兜底：多镜像逐个试，解压到 /usr/local（systemd 默认 PATH 含 /usr/local/bin）
  if (!hasCurl && !hasWget) {
    if (pm === 'apt') await run(conn, `${sudo}apt-get install -y curl`, log);
    else if (pm === 'dnf' || pm === 'yum') await run(conn, `${sudo}dnf install -y curl || ${sudo}yum install -y curl`, log);
    else if (pm === 'apk') await run(conn, `${sudo}apk add --no-cache curl`, log);
  }
  log(`改用 Node 官方二进制包（${NODE_TARBALL_VERSION}, ${arch}），多镜像尝试…\n`);
  const urls = nodeTarballUrls(arch).map((u) => `'${u}'`).join(' ');
  // 注意必须用换行拼接：do/fi 后面不能接 ';'，整串经 SSH 交给远端 shell 执行
  const download = [
    'for u in ' + urls + '; do',
    '  if command -v curl >/dev/null 2>&1; then',
    '    curl -fL --connect-timeout 8 --retry 2 -o /tmp/blocknexus-node.tar.gz "$u" && break',
    '  elif command -v wget >/dev/null 2>&1; then',
    '    wget -q --timeout=30 -O /tmp/blocknexus-node.tar.gz "$u" && break',
    '  fi',
    'done',
    '[ -s /tmp/blocknexus-node.tar.gz ]',
  ].join('\n');
  await runChecked(conn, download, log);
  await runChecked(
    conn,
    `${sudo}tar -xzf /tmp/blocknexus-node.tar.gz -C /usr/local --strip-components=1 && ${sudo}rm -f /tmp/blocknexus-node.tar.gz`,
    log,
  );
  cur = await versionNow();
  if (!cur || cur.major < NODE_MIN_MAJOR) {
    throw new Error('Node 安装后仍不可用，请手动安装 Node.js >= 16 后重试');
  }
  log(`Node.js 安装完成: ${cur.full}（/usr/local）\n`);
}

async function ensureSudo(conn, log) {
  const who = await run(conn, 'id -u');
  if (who.out.trim() === '0') return '';
  const { code } = await run(conn, 'sudo -n true 2>/dev/null');
  if (code !== 0) {
    throw new Error('当前 SSH 用户不是 root 且没有免密 sudo，请改用 root 账户或配置免密 sudo');
  }
  log('非 root 用户，使用 sudo 执行\n');
  return 'sudo ';
}

/**
 * 添加服务器前的 SSH 连接验证（不落盘、不改远端）：
 * 确认主机/端口/账号/密码可用，并探测系统与 Node/Java 环境，给安装可行性一个预告。
 * 抛错 = 连接失败；返回 ok=false 表示连上了但环境有安装硬伤（如无 root 且无免密 sudo）。
 */
async function checkSsh(server) {
  const conn = await sshConnect(server, 12000);
  try {
    const batch = [
      'echo "===id==="; id -u; id -un',
      'echo "===sudo==="; sudo -n true 2>/dev/null && echo sudo-ok || echo sudo-no',
      'echo "===os==="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -s -m',
      'echo "===node==="; node -v 2>/dev/null || /usr/local/bin/node -v 2>/dev/null || true',
      'echo "===java==="; java -version 2>&1 | head -1',
      'echo "===end==="',
    ].join('; ');
    const { out } = await run(conn, batch);
    const section = (name) => {
      const m = new RegExp(`===${name}===\\n([\\s\\S]*?)(?:(?:\\n)?===\\w+===|\\n===end===)`, 'm').exec(out);
      return m ? m[1].trim() : '';
    };
    const idOut = section('id').split('\n');
    const uid = Number(idOut[0] || -1);
    const user = (idOut[1] || server.ssh.user).trim();
    const sudoOk = section('sudo') === 'sudo-ok';
    const osLines = section('os').split('\n');
    const osName = (osLines[0] || '').trim() || '未知发行版';
    const unameParts = (osLines[1] || '').trim().split(/\s+/);
    const sys = unameParts[0] || '';
    const arch = unameParts[1] || '';
    const nodeV = section('node');
    const javaLine = section('java');
    const jm = /version "(\d+)\./.exec(javaLine);
    const javaMajor = jm ? Number(jm[1]) : 0;

    const isRoot = uid === 0;
    const canInstall = isRoot || sudoOk;
    const warnings = [];
    if (!canInstall) {
      warnings.push('该账号不是 root 且无免密 sudo，自动安装 Agent / Java 会失败，请改用 root 或配置免密 sudo');
    }
    if (!nodeV) warnings.push('未检测到 Node.js，安装 Agent 时会自动安装（发行版源不可用时自动换镜像下载）');
    else if (!/^v(\d+)\./.test(nodeV) || Number(/^v(\d+)\./.exec(nodeV)[1]) < NODE_MIN_MAJOR) {
      warnings.push(`Node.js ${nodeV} 版本过低（需 >=${NODE_MIN_MAJOR}），安装 Agent 时会自动升级`);
    }
    if (!javaMajor) warnings.push('未检测到 Java，运行 MC 1.20.5+ 需 Java 21，可在面板一键安装');
    else if (javaMajor < 21) warnings.push(`Java ${javaMajor} 只能运行 1.20.4 及更早版本，MC 1.20.5+ 需 Java 21`);

    return {
      ok: true,
      canInstall,
      user,
      isRoot,
      sudoOk,
      os: sys === 'Linux' ? osName : `${sys} ${osName}`.trim(),
      arch,
      node: nodeV || '',
      java: javaMajor ? (javaLine || `Java ${javaMajor}`) : '',
      javaMajor,
      warnings,
    };
  } finally {
    conn.end();
  }
}

function sftpWrite(sftp, remote, content) {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remote);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(content);
  });
}

function sftpPut(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()));
  });
}

// SFTP 直传：把可读流写到远端绝对路径（自动逐级建目录）。
// 供文件管理器大文件上传使用——跳过加密通道的 512KB 分块与 200MB 上限。
async function sftpUploadStream(server, remotePath, readStream) {
  const conn = await sshConnect(server);
  try {
    const sftp = await new Promise((resolve, reject) =>
      conn.sftp((e, s) => (e ? reject(e) : resolve(s))),
    );
    // 逐级创建目录（相当于 mkdir -p；已存在时 mkdir 报错，忽略即可）
    const segs = String(remotePath).split('/').filter(Boolean);
    let cur = '';
    for (const seg of segs.slice(0, -1)) {
      cur += '/' + seg;
      await new Promise((resolve) => sftp.mkdir(cur, () => resolve()));
    }
    return await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(remotePath);
      let settled = false;
      let received = 0;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          ws.destroy();
        } catch {}
        reject(err);
      };
      ws.on('error', fail);
      ws.on('close', () => {
        if (!settled) resolve(ws.bytesWritten || received);
      });
      readStream.on('data', (c) => (received += c.length));
      readStream.on('error', fail);
      readStream.pipe(ws);
    });
  } finally {
    conn.end();
  }
}

const UNIT = `[Unit]
Description=BlockNexus Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node {DIR}/agent.js
WorkingDirectory={DIR}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

// Agent 脚本热更新：仅替换 agent.js 并重启 systemd 服务——不动 token/TLS/单元文件/Java。
// 面板检测到远端 Agent 版本落后（hi 上报的 agentVersion ≠ 随附版本）时自动调用。
async function updateAgentScript(server, log) {
  const agentFile = path.join(__dirname, '..', 'agent', 'agent.js');
  if (!fs.existsSync(agentFile)) throw new Error('找不到 agent/agent.js');
  const dir = server.agent.installDir || '/opt/blocknexus-agent';

  log(`连接 ${server.ssh.user}@${server.host}:${server.ssh.port} …\n`);
  const conn = await sshConnect(server);
  try {
    const sudo = await ensureSudo(conn, log);
    log('上传新 agent.js …\n');
    const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
    // 先落 .new 再原子改名：避免传一半被 systemd 拉起的进程读到半截脚本
    await sftpPut(sftp, agentFile, `${dir}/agent.js.new`);
    await runChecked(
      conn,
      `${sudo}sh -c 'mv ${dir}/agent.js.new ${dir}/agent.js && systemctl restart blocknexus-agent'`,
      log,
    );
    log('已重启 blocknexus-agent，等待 Agent 以新版本回连 …\n');
  } finally {
    try { conn.end(); } catch {}
  }
}

// 安装/重装 agent。log(text) 用于向前端推送进度。
async function installAgent(server, log) {
  const agentFile = path.join(__dirname, '..', 'agent', 'agent.js');
  if (!fs.existsSync(agentFile)) throw new Error('找不到 agent/agent.js');
  const dir = server.agent.installDir || '/opt/blocknexus-agent';

  log(`连接 ${server.ssh.user}@${server.host}:${server.ssh.port} …\n`);
  const conn = await sshConnect(server);
  try {
    const sudo = await ensureSudo(conn, log);
    const uname = await runChecked(conn, 'uname -s -m', log);
    log(`系统: ${uname}\n`);
    if (!uname.startsWith('Linux')) throw new Error('目前仅支持 Linux 服务器');

    await ensureNode(conn, sudo, log);
    await runChecked(conn, `${sudo}mkdir -p ${dir}`, log);

    log('上传 agent.js …\n');
    const sftp = await new Promise((resolve, reject) => conn.sftp((e, s) => (e ? reject(e) : resolve(s))));
    await sftpPut(sftp, agentFile, `${dir}/agent.js`);

    // 需要 TLS 时先生成自签证书（用服务器上的 openssl），并把指纹回传给面板做固定校验
    let tlsFingerprint = null;
    if (server.agent.tls && server.agent.mode !== 'inbound') {
      const cn = server.host;
      log('生成自签 TLS 证书 …\n');
      await runChecked(
        conn,
        `${sudo}sh -c 'command -v openssl >/dev/null 2>&1 && ` +
          `[ -f ${dir}/cert.pem ] || ` +
          `openssl req -x509 -newkey rsa:2048 -nodes -days 3650 ` +
          `-keyout ${dir}/key.pem -out ${dir}/cert.pem -subj "/CN=${cn}" ` +
          `-addext "subjectAltName=IP:${cn},DNS:${cn}" 2>&1 | tail -2'`,
        log,
      ).catch((e) => {
        throw new Error('TLS 证书生成失败（需要 openssl 1.1.1+）：' + e.message);
      });
      const fp = await runChecked(
        conn,
        `openssl x509 -in ${dir}/cert.pem -noout -fingerprint -sha256 | cut -d= -f2`,
        log,
      );
      tlsFingerprint = fp.trim().toUpperCase();
      await runChecked(conn, `${sudo}chmod 600 ${dir}/key.pem ${dir}/cert.pem`, log);
      log(`证书指纹(SHA-256): ${tlsFingerprint}\n`);
    }

    // outbound（默认）：Agent 监听端口等面板连入；inbound：Agent 主动回连面板地址
    const agentCfg = JSON.stringify(
      server.agent.mode === 'inbound'
        ? { panel: server.agent.panelUrl, token: server.token, id: server.id }
        : {
            listen: server.agent.port || 3099,
            token: server.token,
            id: server.id,
            ...(tlsFingerprint ? { tls: { cert: `${dir}/cert.pem`, key: `${dir}/key.pem` } } : {}),
          },
    );
    await sftpWrite(sftp, `${dir}/agent.json`, agentCfg);
    await runChecked(conn, `${sudo}chmod 600 ${dir}/agent.json`, log);

    const hasSystemd = (await run(conn, '[ -d /run/systemd/system ] && echo yes || echo no')).out.trim() === 'yes';
    if (hasSystemd) {
      log('注册 systemd 服务 blocknexus-agent …\n');
      await sftpWrite(sftp, '/etc/systemd/system/blocknexus-agent.service', UNIT.replaceAll('{DIR}', dir));
      await runChecked(conn, `${sudo}systemctl daemon-reload`, log);
      await runChecked(conn, `${sudo}systemctl enable --now blocknexus-agent`, log);
      await runChecked(conn, `${sudo}systemctl restart blocknexus-agent`, log);
    } else {
      log('无 systemd，使用 nohup 拉起 …\n');
      await runChecked(
        conn,
        `${sudo}pkill -f "node ${dir}/agent.js" 2>/dev/null; sleep 1; ${sudo}sh -c 'nohup node ${dir}/agent.js >${dir}/agent.log 2>&1 & echo $! > ${dir}/agent.pid'`,
        log
      );
    }
    if (server.agent.mode === 'inbound') {
      log('安装完成，等待 Agent 回连面板…\n');
    } else {
      log(
        `安装完成。Agent 正在监听 ${server.agent.port || 3099} 端口${server.agent.tls ? '（TLS）' : ''}，` +
          '请确认服务器安全组/防火墙已放行。\n',
      );
    }
    return { tlsFingerprint };
  } finally {
    conn.end();
  }
}

// 判断本机面板地址给 Agent 用（添加服务器时的默认值提示）
function suggestPanelUrl(reqHost) {
  const port = process.env.BLOCKNEXUS_PORT || 3080;
  // reqHost 形如 127.0.0.1:3080 或 myhost:3080
  const hostname = String(reqHost || '').split(':')[0] || os.hostname();
  return `ws://${hostname}:${port}`;
}

// 卸载 Agent：停服务 → 删单元 → 递归删除安装目录（含 instances / .backups）
async function uninstallAgent(server, log) {
  const dir = server.agent.installDir || '/opt/blocknexus-agent';
  log(`连接 ${server.ssh.user}@${server.host}:${server.ssh.port} …\n`);
  const conn = await sshConnect(server);
  try {
    const sudo = await ensureSudo(conn, log);

    const hasSystemd =
      (await run(conn, '[ -d /run/systemd/system ] && echo yes || echo no')).out.trim() === 'yes';
    if (hasSystemd) {
      log('停止并禁用 systemd 服务 blocknexus-agent …\n');
      await run(conn, `${sudo}systemctl disable --now blocknexus-agent 2>&1 || true`, (c) => log(c, true));
      await run(conn, `${sudo}rm -f /etc/systemd/system/blocknexus-agent.service`);
      await run(conn, `${sudo}systemctl daemon-reload`);
    } else {
      log('停止 nohup 进程 …\n');
      await run(conn, `${sudo}pkill -f "node ${dir}/agent.js" 2>&1 || true`, (c) => log(c, true));
    }

    log(`递归删除安装目录 ${dir}（含实例与备份）…\n`);
    await runChecked(conn, `${sudo}rm -rf ${dir}`, log);

    // 确认删除干净
    const left = (await run(conn, `[ -e ${dir} ] && echo exists || echo gone`)).out.trim();
    log(left === 'gone' ? '✓ 安装目录已删除\n' : '⚠ 目录仍存在，请手动检查\n');
    log('✓ Agent 已卸载\n');
  } finally {
    conn.end();
  }
}

module.exports = { installAgent, updateAgentScript, uninstallAgent, checkSsh, suggestPanelUrl, sftpUploadStream, hostKeyFingerprint, verifyHostKey };
