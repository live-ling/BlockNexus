'use strict';
// 更新器（scripts/panel-updater.js）的端到端流程测试。
//
// 覆盖：成功替换、健康检查失败回滚、非法路径拒绝、pending/heartbeat/锁的清理。
// 不依赖真实面板：起一个假 HTTP 服务响应 /api/health 与 /，/api/version 直接断开
// （模拟「面板已退出」，让 waitPanelExit 立刻通过）。
//
// 运行：node agent/test-panel-update-flow.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const UPDATER = path.join(ROOT, 'scripts', 'panel-updater.js');

let pass = 0;
let total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${!ok && detail ? '\n       ' + detail : ''}`);
}

let healthVersion = '0.7.0';
const server = http.createServer((req, res) => {
  const url = String(req.url || '').split('?')[0];
  if (url === '/api/version') {
    // 让 waitPanelExit 看到「连接失败」= 面板已退出
    req.destroy();
    return;
  }
  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: healthVersion }));
    return;
  }
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
    return;
  }
  res.writeHead(404);
  res.end('nope');
});

function listen() {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function mkFixture(extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-flow-root-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-flow-stage-'));
  fs.mkdirSync(path.join(root, 'panel'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'server.js'), '// old panel\n');
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<div id="root">old</div>\n');
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ version: '0.7.0' }));
  fs.mkdirSync(path.join(stage, 'panel'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'panel', 'server.js'), '// new panel\n');
  fs.writeFileSync(path.join(stage, 'web', 'dist', 'index.html'), '<div id="root">new</div>\n');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = path.join(stage, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { root, stage };
}

function runUpdater({ root, stage, port, to = '0.7.0' }) {
  const updateDir = path.join(root, 'data', 'update');
  fs.mkdirSync(updateDir, { recursive: true });
  const args = [
    UPDATER,
    '--root', root,
    '--stage', stage,
    '--from', '0.6.0',
    '--to', to,
    '--mode', 'payload',
    '--scheme', 'http',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--pid', '0',
    '--launch', 'none',
    '--log', path.join(updateDir, 'update.log'),
    '--result', path.join(updateDir, 'last-result.json'),
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        BLOCKNEXUS_UPDATE_WAIT_MS: '1500',
        BLOCKNEXUS_UPDATE_HEALTH_MS: '3000',
      },
    });
    child.on('exit', (code) => resolve(code));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

(async () => {
  const port = await listen();
  try {
    // ---------- 1. 成功 ----------
    {
      healthVersion = '0.7.0';
      const { root, stage } = mkFixture();
      const code = await runUpdater({ root, stage, port });
      const result = readJson(path.join(root, 'data', 'update', 'last-result.json'));
      check('成功：更新器退出码 0', code === 0, `code=${code}`);
      check('成功：结果文件 ok=true', !!result && result.ok === true, JSON.stringify(result));
      check('成功：面板文件已替换',
        fs.readFileSync(path.join(root, 'panel', 'server.js'), 'utf8').includes('new panel'));
      check('成功：web/dist 已替换',
        fs.readFileSync(path.join(root, 'web', 'dist', 'index.html'), 'utf8').includes('new'));
      check('成功：pending 已清理',
        !fs.existsSync(path.join(root, 'data', 'update', 'pending.json')));
      check('成功：heartbeat 已清理',
        !fs.existsSync(path.join(root, 'data', 'update', 'heartbeat.json')));
      check('成功：in-progress 锁已清理',
        !fs.existsSync(path.join(root, 'data', 'update', 'in-progress')));
      check('成功：保留了备份',
        fs.existsSync(path.join(root, 'data', 'update', 'backup', '0.6.0', 'panel', 'server.js')));
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }

    // ---------- 2. 健康检查失败 → 回滚 ----------
    {
      healthVersion = '0.6.9'; // 永远不匹配期望版本
      const { root, stage } = mkFixture();
      const code = await runUpdater({ root, stage, port });
      const result = readJson(path.join(root, 'data', 'update', 'last-result.json'));
      const pending = readJson(path.join(root, 'data', 'update', 'pending.json'));
      check('回滚：更新器退出码 1', code === 1, `code=${code}`);
      check('回滚：结果 ok=false 且 rolledBack=true',
        !!result && result.ok === false && result.rolledBack === true, JSON.stringify(result));
      check('回滚：面板文件已恢复',
        fs.readFileSync(path.join(root, 'panel', 'server.js'), 'utf8').includes('old panel'));
      check('回滚：pending 保留为 failed（供下次启动提示）',
        !!pending && pending.phase === 'failed' && pending.to === '0.7.0', JSON.stringify(pending));
      check('回滚：锁已清理',
        !fs.existsSync(path.join(root, 'data', 'update', 'in-progress')));
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }

    // ---------- 3. 非法路径 → 一个文件都不写 ----------
    {
      healthVersion = '0.7.0';
      const { root, stage } = mkFixture({ 'data/config.json': '{"evil":true}' });
      const code = await runUpdater({ root, stage, port });
      const result = readJson(path.join(root, 'data', 'update', 'last-result.json'));
      check('非法路径：更新器退出码 1', code === 1, `code=${code}`);
      check('非法路径：结果 ok=false 且错误提到不允许写入',
        !!result && result.ok === false && /不允许写入/.test(String(result.error || '')), JSON.stringify(result));
      check('非法路径：panel 文件未被改动',
        fs.readFileSync(path.join(root, 'panel', 'server.js'), 'utf8').includes('old panel'));
      check('非法路径：data/config.json 未被创建',
        !fs.existsSync(path.join(root, 'data', 'config.json')));
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${pass}/${total} panel-update-flow cases passed`);
  process.exit(pass === total ? 0 : 1);
})();
