'use strict';
// Windows 后台静默 + Java 多版本管理的源码级回归测试。
//
// 为什么是「源码级」：CI 跑在 Linux 上，没法真拉起 Windows 进程；而
// 「反复弹 cmd 窗口」的根因就是某处 spawn 漏了 windowsHide —— 这条规则可以从源码静态检查。
// 以后只要有人新增子进程调用又忘了加，这里会直接失败，比靠 review 可靠。
// 运行：node agent/test-windows-quiet.js

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let total = 0;
function check(name, cond, detail = '') {
  total++;
  if (cond) pass++;
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${detail ? ' — ' + detail : ''}`);
}

/** 递归列出 src 下所有 .js */
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------- 1. 所有子进程调用都必须 windowsHide ----------
{
  const offenders = [];
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /\b(spawn|spawnSync|execFile)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const from = m.index;
      const lineStart = src.lastIndexOf('\n', from) + 1;
      const prefix = src.slice(lineStart, from).trim();
      // 注释里提到 spawn(...) 不算调用；`mySpawn(` 这种词中间也不会命中（\b 只按名匹配）
      if (prefix.startsWith('//') || prefix.startsWith('*')) continue;
      const chunk = src.slice(from, Math.min(from + 700, src.length));
      if (!/windowsHide\s*:\s*true/.test(chunk)) {
        const line = src.slice(0, from).split('\n').length;
        offenders.push(`${path.relative(SRC, file)}:${line} ${m[1]}`);
      }
    }
  }
  check(
    '所有 spawn/spawnSync/execFile 都带 windowsHide（Windows 后台静默）',
    offenders.length === 0,
    offenders.join('; '),
  );
}

// ---------- 2. Windows Java 管理能力 ----------
{
  const javaSrc = fs.readFileSync(path.join(SRC, 'instance', 'java.js'), 'utf8');
  check('java.js 不再直接拒绝 Windows', !javaSrc.includes('Java 管理仅支持 Linux'));
  check(
    'java.js 有平台化托管目录 + 默认版本记录',
    /javaRoot\s*\(\s*\)/.test(javaSrc) && javaSrc.includes('java-default.json'),
  );
  check(
    'java.js 有 Windows 安装（Temurin zip + 解压兜底）',
    /installTemurinWin\s*\(/.test(javaSrc) && /_unzipTo\s*\(/.test(javaSrc) && /Expand-Archive/.test(javaSrc),
  );
  check(
    'java.js 的列表带「可卸载」标记（外部 JDK 只允许切换）',
    javaSrc.includes('removable: this._isManagedJavaDir'),
  );
  check(
    'java.js 的 Windows 列表会扫描厂商目录',
    /_winJavaDirs\s*\(\s*\)/.test(javaSrc) &&
      javaSrc.includes('Eclipse Adoptium') &&
      javaSrc.includes('JAVA_HOME'),
  );
}

// ---------- 3. 启动时用选定的 Java，且隐藏窗口 ----------
{
  const lifeSrc = fs.readFileSync(path.join(SRC, 'instance', 'lifecycle.js'), 'utf8');
  check('javaCmd 在 Windows 上优先用「面板里选定的版本」', /_winJavaChosen\s*\(/.test(lifeSrc));
  check(
    '启动实例的 spawn 带 windowsHide',
    /spawn\(this\.javaCmd\(\)[\s\S]{0,300}?windowsHide:\s*true/.test(lifeSrc),
  );
  check(
    'java 探测（java -version）同样隐藏窗口',
    /spawnSync\(c, \['-version'\][\s\S]{0,120}?windowsHide:\s*true/.test(lifeSrc),
  );
}

// ---------- 4. 远程非 Linux 主机不再套用 Linux 安装流程 ----------
{
  const sshSrc = fs.readFileSync(path.join(ROOT, 'panel', 'ssh.js'), 'utf8');
  check('安装前先判平台，非 Linux 给出明确指引', /该主机不是 Linux/.test(sshSrc));
  check('平台探测对 Windows 也成立（uname 失败时回退 ver）', /ver 2>&1/.test(sshSrc));
  // 判定必须在 ensureSudo 之前，否则 Windows 上会先报「需要 root 或免密 sudo」
  const probeAt = sshSrc.indexOf('uname -s -m 2>&1 || ver');
  const sudoAt = sshSrc.indexOf('const sudo = await ensureSudo(conn, log);', probeAt);
  check('平台判定在 elevate 之前', probeAt > 0 && sudoAt > probeAt);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
