'use strict';
// BlockNexus Agent — 启动入口（配置载入、信号处理）
// 源码模块：由 agent/build.js 打包成单文件 agent/agent.js 部署（勿直接改产物）。
const { loadConfig, VERSION } = require('./config.js');
const { InstanceManager } = require('./instance/manager.js');
const { Agent } = require('./agent.js');

// ============================ 启动 ============================

const conf = loadConfig();
const manager = new InstanceManager(conf.instances);
const agent = new Agent(conf, manager);
agent.start();

console.log(`${VERSION}`);
console.log(`实例目录: ${manager.dir}`);
console.log(
  conf.mode === 'listen'
    ? `运行模式: 监听端口 ${conf.listen}${conf.tls ? '（TLS）' : ''}（等待面板连入 ${conf.tls ? 'wss' : 'ws'}://<本机IP>:${conf.listen}/agent/ws）`
    : `运行模式: 主动连接面板 ${conf.panel}`,
);

process.on('uncaughtException', (e) => console.error('[uncaught]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message ? e.message : e));

// 优雅退出：面板停止本机 Agent / 系统关机时，先把运行中的 MC 实例停掉，避免 java 变孤儿进程。
// Windows 的 taskkill（不带 /F）会给控制台进程发 CTRL_CLOSE_EVENT，
// Ctrl 事件与 POSIX 信号都统一走这里；超时后由 Node 默认行为强制退出。
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.log(`\n[BlockNexus] 收到退出信号（${reason}），正在停止实例…`);
    const stopped = [];
    for (const rec of manager.map.values()) {
      if (rec.proc) {
        await manager.stopAndWait(rec, 20000, false);
        stopped.push(rec.meta.name);
      }
    }
    console.log(stopped.length ? `[BlockNexus] 已停止实例：${stopped.join('、')}` : '[BlockNexus] 无运行中的实例');
  } catch (e) {
    console.error('[BlockNexus] 优雅退出时出错: ' + (e && e.message ? e.message : e));
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    gracefulShutdown(sig).catch(() => process.exit(0));
  });
}
if (process.platform === 'win32') {
  // Windows 控制台 Ctrl 事件（面板 taskkill / 关闭控制台窗口都走这条）
  try {
    // 零依赖：用 Node 内置 libuv 忽略 stdio，仅绑定信号处理即可，无需额外模块
    process.on('SIGBREAK', () => {
      gracefulShutdown('CTRL_BREAK').catch(() => process.exit(0));
    });
  } catch {}
}

