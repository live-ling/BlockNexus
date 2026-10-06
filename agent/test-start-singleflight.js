// 启动并发去重（single-flight）验证：从 agent/src/instance/lifecycle.js 提取 start/doStart 源码，
// 用桩件验证「同一实例并发启动只会 spawn 一个 java 进程」。
//
// 背景：Paper 系首启在 spawn 之前要先等原版核心预下载，这个 await 期间 rec.proc 仍为空；
// 旧实现只靠 rec.proc 做守卫，于是第二次启动请求会再走一遍并 spawn 出第二个 java，
// 两个进程抢同一个 world/ → session.lock 崩溃（生产日志里就是这个现象）。
//
// 本测试不跑真实 java：spawn 用桩件替代，只断言「调用了几次 spawn」「复用了同一结果」
// 「startJob 在收尾后清空」「预下载期间 statusOf 判为 starting」「stop() 能取消启动」。

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const src = fs.readFileSync(path.join(__dirname, 'src', 'instance', 'lifecycle.js'), 'utf8');

/** 提取对象字面量里的方法（2 空格缩进 + 签名，收尾 "\n  },"） */
function extractMethod(name) {
  const m = new RegExp(`^  (?:async )?${name}\\(`, 'm').exec(src);
  if (!m) throw new Error('未找到 ' + name);
  const body = src.slice(m.index, src.indexOf('\n  },', m.index));
  if (body.length < 30) throw new Error(name + ' 提取内容异常');
  return body;
}
const startSrc = extractMethod('start');
const doStartSrc = extractMethod('doStart');
const stopSrc = extractMethod('stop');
const restartSrc = extractMethod('restart');

// 源码片段防漂移：单飞、进程归属、取消、spawn 前重校验必须在位
const frags = [
  ['start', 'rec.startJob'],
  ['start', 'if (rec.proc) throw new Error'],
  ['doStart', 'this.map.get(name) !== rec'],
  ['doStart', 'rec.startCancelled'],
  ['doStart', 'rec.proc !== child'],
  ['doStart', 'if (rec.proc) throw new Error'],
  ['stop', 'startCancelled'],
  ['restart', 'rec.startJob'],
];
for (const [where, frag] of frags) {
  const body = { start: startSrc, doStart: doStartSrc, stop: stopSrc, restart: restartSrc }[where];
  if (!body.includes(frag)) throw new Error(`${where} 缺少实现细节: ${frag}`);
}

// ---- 桩件 ----
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bn-singleflight-'));
const INST = 'srv';
let spawnCalls = [];
let resolveBootstrap = null;

/** 假 java 进程：够 start() 绑定 stdout/stderr/exit 即可 */
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {} };
  child.kill = () => {
    child.emit('exit', 0, 'SIGTERM');
  };
  return child;
}

function makeManager(logs = []) {
  const dir = path.join(TMP, INST);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'fake');
  const rec = {
    meta: {
      name: INST,
      source: 'paper',
      version: '1.21',
      memoryMB: 2048,
      port: 25565,
      installState: 'ready',
      launch: { kind: 'jar', file: 'server.jar' },
    },
    proc: null,
    buf: [],
    pending: [],
    ready: false,
  };
  const mgr = {
    dir: TMP,
    map: new Map([[INST, rec]]),
    _javaCmd: 'java',
    logs,
    rec,
    get: (name) => {
      if (mgr.map.get(name) !== rec) throw new Error('实例不存在: ' + name);
      return rec;
    },
    instDir: (name) => path.join(TMP, name),
    javaInfo: () => ({ installed: true, major: 21 }),
    javaCmd: () => 'java',
    emitConsole: (r, text) => logs.push(text),
    emitUpdated: () => {},
    makeLineSplitter: () => {
      const f = (text) => f.onLine(text);
      f.flush = () => {};
      return f;
    },
    ensureBootstrapVanilla: () =>
      new Promise((resolve) => {
        resolveBootstrap = resolve; // 手动控制「预下载」何时完成，制造 await 窗口
      }),
    trackPlayers: () => {},
    trackSpark: () => false,
    stopAndWait: async () => true,
    scheduleAutoRestart: () => {},
  };
  const obj = new Function(
    'fs', 'path', 'spawn', 'PAPERCLIP_SOURCES', 'fmtSize', 'sendEvent',
    'return {' + [startSrc, doStartSrc, stopSrc, restartSrc].join('},\n') + '}}',
  )(
    fs,
    path,
    (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return fakeChild(10000 + spawnCalls.length);
    },
    new Set(['paper', 'purpur', 'folia']),
    () => '0B',
    () => {},
  );
  Object.assign(mgr, obj);
  return mgr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, total = 0;
function check(desc, ok, detail) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}${detail && !ok ? '\n       ' + detail : ''}`);
}

(async () => {
  // 1) 并发两次 start：第一次卡在预下载，第二次必须复用同一任务，不 spawn 第二个进程
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    const p1 = mgr.start(INST);
    await sleep(10); // 让第一次进入预下载 await
    const p2 = mgr.start(INST);
    const samePromise = p1 === p2;
    resolveBootstrap();
    const [r1, r2] = await Promise.all([p1, p2]);
    check('并发第二次 start 复用同一进行中任务（同一 Promise）', samePromise);
    check('并发启动只 spawn 一个 java 进程', spawnCalls.length === 1, `spawn 次数 ${spawnCalls.length}`);
    check('两次调用拿到同一 pid', r1 && r2 && r1.pid === r2.pid, JSON.stringify([r1, r2]));
    check('启动结束后清空 startJob（不再阻塞后续启动）', mgr.rec.startJob === null || mgr.rec.startJob === undefined);
    check('rec.proc 指向存活进程', mgr.rec.proc && mgr.rec.proc.pid === 10001);
  }

  // 2) 预下载期间状态算「启动中」（否则界面显示已停止，用户会再点一次）
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    // statusOf 的内部契约：有 startJob 时先于 installState 判定
    const statusOf = () => (mgr.rec.proc ? (mgr.rec.ready === false ? 'starting' : 'running') : mgr.rec.startJob ? 'starting' : 'stopped');
    const p = mgr.start(INST);
    await sleep(10);
    check('预下载窗口内 statusOf → starting', statusOf() === 'starting', `实际 ${statusOf()}`);
    check('预下载窗口内 rec.proc 仍为空（说明守卫只能靠 startJob）', mgr.rec.proc === null);
    resolveBootstrap();
    await p;
    check('就绪前（ready=false）statusOf 仍为 starting', statusOf() === 'starting', `实际 ${statusOf()}`);
  }

  // 3) 预下载期间 stop() → 取消本次启动，不 spawn
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    const p = mgr.start(INST);
    await sleep(10);
    const stopped = await mgr.stop(INST);
    check('启动中调用 stop() 返回取消标记', stopped && stopped.cancelled === true, JSON.stringify(stopped));
    resolveBootstrap();
    let err = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    check('被取消的启动抛「启动已取消」而不是起进程', !!err && /取消/.test(err.message), err && err.message);
    check('取消后没有 spawn java', spawnCalls.length === 0, `spawn 次数 ${spawnCalls.length}`);
    check('取消标记被消费（不会残留影响下次启动）', !mgr.rec.startCancelled);
  }

  // 4) 已有进程时 start 仍然拒绝
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    const p = mgr.start(INST);
    resolveBootstrap();
    await p;
    let err = null;
    try {
      await mgr.start(INST);
    } catch (e) {
      err = e;
    }
    check('已在运行时 start 抛「实例已在运行」', !!err && err.message.includes('已在运行'), err && err.message);
    check('这种情况下不会再 spawn', spawnCalls.length === 1, `spawn 次数 ${spawnCalls.length}`);
  }

  // 5) 预下载期间实例被删除 → spawn 前拦下
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    const p = mgr.start(INST);
    await sleep(10);
    mgr.map.delete(INST); // 模拟并发删除
    resolveBootstrap();
    let err = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    check('预下载后被删除的实例不会 spawn', spawnCalls.length === 0 && !!err, err && err.message);
  }

  // 6) 旧进程退出不影响新进程（进程归属判定）
  {
    spawnCalls = [];
    resolveBootstrap = null;
    const mgr = makeManager();
    const p = mgr.start(INST);
    resolveBootstrap();
    await p;
    const first = mgr.rec.proc; // 通过 start() 起出来的进程，已绑定 exit 处理器
    check('第一个进程已登记', !!first && first.pid === 10001);
    // 模拟「新进程接管」：旧进程退出时 rec.proc 已指向别人 → 不应把 rec.proc 清空
    const second = fakeChild(20002);
    mgr.rec.proc = second;
    first.emit('exit', 0, null);
    check('旧进程退出不会清掉新进程的 rec.proc（进程归属判定生效）', mgr.rec.proc === second, `rec.proc=${mgr.rec.proc && mgr.rec.proc.pid}`);
    // 当前进程（仍是带处理器的 first）退出时才清空
    mgr.rec.proc = first;
    first.emit('exit', 0, null);
    check('当前进程退出正常清空 rec.proc', mgr.rec.proc === null, `rec.proc=${mgr.rec.proc && mgr.rec.proc.pid}`);
  }

  console.log(`\n${pass}/${total} start-singleflight cases passed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(pass === total ? 0 : 1);
})();
