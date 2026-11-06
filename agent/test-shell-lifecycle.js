'use strict';
// 桌面启动/停止与 data 目录分层的回归测试。不需要真的启动 GUI。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureDataLayout, cacheFile } = require('../panel/data-layout');

let count = 0;
function check(name, fn) {
  fn();
  count++;
  console.log('PASS | ' + name);
}

check('旧日志/缓存迁移到 logs 与 cache，配置原地保留', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-layout-'));
  try {
    fs.writeFileSync(path.join(data, 'config.json'), '{"panel":{}}');
    fs.writeFileSync(path.join(data, 'panel.log'), 'old panel');
    fs.writeFileSync(path.join(data, 'mc-versions-cache.json'), '{"at":1}');
    fs.mkdirSync(path.join(data, 'webview2-profile'));
    fs.writeFileSync(path.join(data, 'webview2-profile', 'marker'), 'profile');
    const dirs = ensureDataLayout(data);
    assert.strictEqual(fs.readFileSync(path.join(dirs.logsDir, 'panel.log'), 'utf8'), 'old panel');
    assert.strictEqual(cacheFile(data, 'mc-versions-cache.json'), path.join(dirs.cacheDir, 'mc-versions-cache.json'));
    assert.ok(fs.existsSync(path.join(dirs.cacheDir, 'webview2-profile', 'marker')));
    assert.ok(fs.existsSync(path.join(data, 'config.json')));
    assert.ok(!fs.existsSync(path.join(data, 'panel.log')));
    ensureDataLayout(data); // 幂等
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

check('launcher dry-run 创建分层目录且不启动后台进程', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-launcher-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'panel'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'panel', 'server.js'), '');
    fs.writeFileSync(path.join(fixture, 'agent', 'agent.js'), '');
    for (const file of ['blocknexus-launcher.js', 'panel-data-layout-copy.js']) {
      const source = file === 'blocknexus-launcher.js'
        ? path.join(__dirname, '..', 'scripts', file)
        : path.join(__dirname, '..', 'panel', 'data-layout.js');
      const target = file === 'blocknexus-launcher.js'
        ? path.join(fixture, 'scripts', file)
        : path.join(fixture, 'panel', 'data-layout.js');
      fs.copyFileSync(source, target);
    }
    const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'blocknexus-launcher.js'), '--dry-run'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(fs.existsSync(path.join(fixture, 'data', 'logs')));
    assert.ok(fs.existsSync(path.join(fixture, 'data', 'cache')));
    assert.match(fs.readFileSync(path.join(fixture, 'data', 'logs', 'launcher.log'), 'utf8'), /dry-run/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

check('外壳保留提权主动接管、跨权限 ACL 与按 PID 退出兜底', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'tray', 'BlockNexusTray.cs'), 'utf8');
  assert.match(source, /Global\\BlockNexusTrayMutex/);
  assert.match(source, /EventWaitHandleSecurity/);
  assert.match(source, /ExistingProcessAlive/);
  assert.match(source, /ForceKillExisting/);
  assert.match(source, /BLOCKNEXUS_TRAY_PID/);
  assert.match(source, /startup flow attempt/);
  assert.ok(!source.includes('taskkill /F /IM'));
});

console.log(`\n${count}/${count} passed`);
