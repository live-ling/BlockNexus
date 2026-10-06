# OPanel → BlockNexus：可借鉴技术清单（附落地优先级）

> 调研对象：[opanel-mc/opanel](https://github.com/opanel-mc/opanel)（GPL-3.0），已克隆到 `.opanel-reference/`（已 gitignore，仅作只读参考，不入本仓库）。
> 四份底层报告（本文件的全部论据来源）：
> - [opanel-techniques-backend.md](./opanel-techniques-backend.md) — Java 后端：认证/WS/存储/调度/扩展/地图/构建
> - [opanel-techniques-frontend-core.md](./opanel-techniques-frontend-core.md) — 前端基础层：WS 客户端/HTTP 封装/i18n/设置/类型契约
> - [opanel-techniques-frontend-mc.md](./opanel-techniques-frontend-mc.md) — 前端 MC 领域：§ 格式化/SNBT/材质管线/地图 Worker/配置元数据/测试
> - [blocknexus-current-state.md](./blocknexus-current-state.md) — **本仓库现状审计**（每个"不存在"都经反向 grep 验证）
>
> 许可证提醒：OPanel 是 **GPL-3.0**，BlockNexus 是 **MIT**。本清单只提炼**思路与架构模式**（不受版权保护），**不要复制其源码**——否则会把 BlockNexus 拖成 GPL 衍生作品。

---

## 0. 一句话结论

两个项目是同一个命题的两条解法，因此几乎每一项 OPanel 的设计在 BlockNexus 都有对应位置：

| | OPanel | BlockNexus |
|---|---|---|
| 形态 | 服务端插件（Java，跑在游戏进程内） | 本地面板（Node/Express）+ 远端 Agent（零依赖单文件） |
| 前端 | Next.js + React + TS + Shadcn | Vite + React + TS + Shadcn |
| 实时通道 | **WebSocket 双向**，5 个端点 | **SSE 单向** + 每次操作一次 HTTP |
| 认证 | CRAM 挑战-响应 → JWT（HS256） | 用户名密码 → 会话 Cookie |
| 平台适配 | 39 个版本模块 + `instanceof` 能力探测 | 7 类核心 + `switch (action)` RPC |
| 调度 | cron + 自续期 | daily/interval + 30 秒轮询 |
| i18n | 8 语言 × ~770 键，类型强制完整 | **无** |
| 前端测试 | vitest + jsdom + 自研 helper | **无** |
| MC 领域理解 | § 富文本 / SNBT / 物品 / 地图 / gamerule | 仅 server.properties + YAML/JSON |

**最高价值的单点发现**：BlockNexus 有 4 个**已确认的安全缺陷**（见 §1），修法在 OPanel 里有现成参考或反面对照，且都是几十行的改动。

**最值得整体照搬的三件事**：① WebSocket 双向通道 + 类型化报文（解锁终端补全、交互式控制台，见 §2.1）；② cron 调度（替掉 30 秒轮询，见 §2.3）；③ 时序指标「只存聚合 + 多级降采样」（见 §2.4）。

**最该警惕的一件事**：OPanel 的 WS 客户端有一个致命抽象缺陷（每个订阅者各挂一个无法取消的监听器），别照着写（见 §5）。

---

## 1. 立刻可做：安全加固（全部已在本仓库验证）

这四条是 OPanel 的**反面对照**+ BlockNexus 现状交叉验证出来的，改动量小、风险收益比最高。**建议优先于任何功能开发。**

### 1.1 补 `trust proxy`（当前是「全局锁死」而不是「限流」）

**现状（已用 grep 验证）**：全 `panel/*.js` 搜 `trust proxy` **零命中**；登录限流按 `req.ip` 分桶（`panel/api.js:325-347`），`req.ip` 在 Reverse Proxy 后恒为代理地址。

**后果**：README 推荐「面板前加 HTTPS 反向代理」。在此部署下，**任何一个攻击者失败 5 次即可把全体用户锁在门外 5 分钟**——限流从「防爆破」退化成「拒绝服务放大器」。同理 `forgot-password` 的发码窗口（每小时 5 次，`panel/api.js:389-391`）会变成全局配额，第 6 个正常人发不出验证码。

**做法**：`app.set('trust proxy', <受信代理地址/CIDR>)`——**必须显式列白名单，不要写 `true`**。OPanel 的反面教材值得记住：它用配置项 `proxyHeaders` 开关，`true` 时无条件信任 `X-Forwarded-For` 的第一段（`BaseController.java:105-139`），因此「直连公网 + 开启 proxyHeaders」= 攻击者自己伪造头绕过限流。两者的正确交集是：**信任代理，但只信任你确实部署了的那个代理**。

### 1.2 `Secure` Cookie 标志（HTTPS 下当前不下发）

**现状（已验证）**：三处 `Set-Cookie`（`panel/api.js:356`、`:363`、`:625`）均为 `HttpOnly; SameSite=Lax; Path=/`，**没有 `Secure`**；而面板自身支持 `--tls-cert/--tls-key` 起 HTTPS（`panel/server.js:74-79`）。

**后果**：HTTPS 部署下浏览器仍会把这个会话 Cookie 通过明文 HTTP 发给同域——一个 `http://` 子域或一次降级请求就能窃取会话。

**做法**：`Secure` 按启动时是否 TLS（`server.js` 已有 `tlsOn` 变量）或按 `req.secure` 动态追加。OPanel 的做法是配置项 `cookieSecure` 控制（`JwtManager.java:121-129`）——一个显式开关比自动判断更可预测，但**自动跟随 TLS 更不容易忘**。

### 1.3 `loginFails` 内存泄漏（唯一没被 GC 的限流表）

**现状（已验证）**：`panel/api.js:540-551` 的 60 秒 GC 任务只清理 `forgotSent` / `verifyFails` / `resetTickets` 三张表。`loginFails`（`panel/api.js:327`）**只增不减**——`delete` 只在登录成功时发生（`:348`），锁定到期后记录仍永久驻留。

**后果**：每个发起过一次失败登录的来源 IP 都会留下一条永久记录。面板暴露在公网时，这是一个**无界的、可被外部驱动的内存增长**。

**做法**：把 `loginFails` 一并纳入 GC；或采用 OPanel 的语义——`getActiveRecord` **读到过期即删**（`LoginAttemptTracker.java:72-83`），并额外钳制表大小（OPanel 设上限 10000，超限返回 429 + `Retry-After`，`LoginAttemptTracker.java:8,12`）。OPanel 那条「封禁到期 = 记录整体过期（计数同时清零）」的语义定义得很清楚，值得直接采用。

### 1.4 CSRF 中间件只覆盖 `POST`

**现状（已验证）**：`panel/api.js:316` 的守卫是 `if (req.method === 'POST' && !req.is('application/json'))`——**`PUT` / `DELETE` 不检查**。

**评估**：实际风险低（原生 HTML 表单发不出 `PUT`/`DELETE`，且无 CORS 中间件 + `SameSite=Lax`）。但这是**「防护面看起来比实际宽」**的典型：审计者读到这条中间件会以为所有写请求都被覆盖。

**做法**：改成 `['POST','PUT','PATCH','DELETE'].includes(req.method)`。顺带纠一个传播很广的误解（OPanel 报告已澄清）：**强制 `application/json` 也不是可靠的 CSRF 防线**（简单请求仍能造成副作用），真正的防线是 `SameSite` 或来源校验。BlockNexus 目前两者都有（`SameSite=Lax` + 无 CORS），这条改动是「让代码如实表达意图」，不是补一个漏洞。若将来要支持 `SameSite=None`，必须显式加来源校验。

---

## 2. 中期：值得当作独立特性来做的技术

### 2.1 浏览器 WebSocket 双向通道 + 类型化报文（收益最大）

**为什么**：这是 BlockNexus 与 OPanel 之间**最大的架构差**，且直接卡住一批功能。

现状是 SSE 单向（`web/src/lib/sse.ts:50`）：服务端→浏览器有推送，浏览器→服务端**每次操作一条 HTTP**。后果：

- **终端补全做不了**。OPanel 的 `autocomplete` 是双向报文的典型用例：服务端回 `getCommandTabList(argIndex, command)`（`TerminalEndpoint.java:72-78`）。SSE 下每次按键都要一条 HTTP，且有竞态（后发先至）。
- **高频交互做不了**。所有交互式控制（玩家背包实时编辑、地图拖动取块）都需要「客户端发意图 + 服务端推增量」的双向低延迟通道。
- **事件无法断点续传**。当前 SSE 只写 `data:` 不写 `id:`（`panel/api.js:128-135`），**没有 `Last-Event-ID`、没有回放缓冲**——断线期间的事件永久丢失。OPanel 的方案是「无状态连接 + 重连即全量重放」（terminal 重放 ≤20000 行、monitor 重放 ≤200 点、players 重放完整列表，`MonitorEndpoint.java:35-38`、`TerminalEndpoint.java:59`）。这个策略比「为每个连接维护增量位置」简单得多，且对面板场景足够。

**照搬什么**：

1. **报文信封 `{"type": "...", "data": ...}`**（`Packet.java:3-18`）。极简、自描述、前端一行就能分发。**在 BlockNexus 里可以直接复用已有的 `agent` 协议风格**（`{t:'req',id,...}`），甚至更好——因为 BlockNexus 的 agent 通道已经有成熟的 `id` + promise map + 超时（`panel/agentlink.js:449-468`），浏览器侧应该对齐这套而不是另起一套。
2. **按功能分端点 + 类型常量按方向分区的注释**（`TerminalEndpoint.java:12-22` 的 `/* server packet */` / `/* client packet */` 分区）。零成本的协议文档，且紧贴类型定义不会腐化。
3. **连接参数走 query string，路径参数定位实体**：`/socket/monitor?limit=N`（回放条数在建连时就确定，省一次往返）、`/socket/inventory/{uuid}`（订阅哪个实体表达在连接层）。
4. **连接时回放一段历史**，避免新连接的首屏空白——BlockNexus 目前靠 `GET .../console?tail=300` 补（`web/src/components/console-panel.tsx:104-106`），可以合并进 WS 的 `init` 帧。
5. **慢消费者治理**（`BaseEndpoint.java:24-26,123-157`）：限制出站帧数（OPanel 设 1024 帧）+ 检测写阻塞（`WritePendingException`）+ 主动断开（close 1013）。**这是进程内 WS 广播必备的三件事**，否则一个卡住的客户端会变成内存放大器。Node 侧对应的是 `ws` 的 `bufferedAmount` 检查 + `socket.terminate()`。

**不要照搬什么**（详见 §5.1）：OPanel 前端 `WebSocketClient` 的订阅管理是坏的；它没有重连、没有心跳、`send` 不检查 `readyState`。

**改造建议**：保留「按功能分客户端类 + type 字符串联合」的组织方式，但基类必须补齐——`subscribe` 返回 `unsubscribe`、内部用「type → 回调数组」的表而不是给每个订阅者挂 `message` 监听器、发送前检查 `readyState` 并排队、指数退避重连 + 心跳 + `visibilitychange`/`online` 触发、`onError` 区分「服务端 error 报文」与「传输层事件」。

**迁移成本提示**：BlockNexus 的 SSE 只有 8 个顶层事件类型（`web/src/lib/sse.ts:3-38`），且前端已有 `subscribeServer(serverId, fn)` 的过滤封装。切 WS 时可以保留这个 API 形状，只换底下的传输，把影响面压在 `sse.ts` 一个文件里。**注意 SSE 有一个 WS 没有的好处：浏览器 `EventSource` 自带重连，而 WS 要自己写。** 所以这次改造的净成本主要在重连逻辑上。

### 2.2 端到端类型契约（让前端类型跟着协议走）

**为什么**：BlockNexus 现在的契约是**人肉对齐**的——前端手写 TS union（`web/src/lib/sse.ts:3-38`），后端 `bus.emit('broadcast', {...})` 是**无类型裸对象**（`panel/api.js:117` 等）。改一个事件字段，编译器不会告诉你前端有 12 处读它。

**照搬什么**（按性价比排序）：

1. **每个端点导出一张 `PayloadMap`，把订阅签名改成泛型绑定**：
   ```ts
   type PayloadMap = { init: Player[], join: Player, leave: Player, move: PlayerMoveData[] };
   subscribe<K extends keyof PayloadMap>(type: K, cb: (data: PayloadMap[K]) => void): () => void;
   ```
   这是 OPanel **没做到**的地方（它的 `subscribe<D>` 让调用者手写 `D`，`ws/index.ts:49`，写错不报错），而它明明已经定义了 `InventoryMovePayload` 等类型却没接到签名上（`ws/inventory.ts:4-11`）——一个「写了类型但没接上」的半成品。BlockNexus 应该一步到位。

2. **空 `APIResponse<T>` 式的统一错误契约**。OPanel 用**交叉类型**而非包装类型：`{code:number, error:string} & T`（`types.ts:7-10`），调用方直接 `res.saves` 少一层 `.data`。BlockNexus 现在**没有统一信封**：成功响应有些返回裸载荷、有些返回 `{ok:true}`，前端 `api<T>()` 因此只检查 HTTP 状态码（`web/src/lib/api.ts:565-585`）。建议引入统一错误形状但**给信封字段加保留前缀**（OPanel 的交叉类型有个隐患：业务字段若也叫 `code` 会静默冲突）。

3. **把路由写进类型的 JSDoc**（`types.ts:201` 等）：`/** `/api/info` */ export interface InfoResponse {...}`。IDE 悬浮即见契约，不用翻后端。成本为零。

4. **两层错误文案模型**：`toastError(e, message, [[status, desc]])`——一句可复用的用户可读主语 + 一条按状态码细分的描述（`api.ts:23-36`）。比「每个 catch 里塞一个字符串」可维护得多。

5. **「错误即导航」**：`restartServer` 把 406 映射成「跳转到设置页的启动命令 tab」而不是弹个提示让用户自己找（`api.ts:161-164`）。这个模式值得在 BlockNexus 的 Agent 未配置类错误上推广。

### 2.3 cron 调度（替掉 30 秒轮询）

**现状**：只有 `daily`（HH:MM + 星期过滤 + 2 分钟窗口 + 20 小时去重）和 `interval`（clamp 到 5 分钟~7 天）两种，判定函数在 `agent/src/instance/watchdog.js:46-63`；执行靠两个 **30 秒** `setInterval`（`manager.js:26-27`）。**无 cron、无时区、无 jitter**——所有实例在同一 tick 上判定。

**OPanel 的做法**（`ScheduledTaskManager.java`）：

- 用 **cron-utils** 解析 **UNIX 5 段 cron**（`:33`）；不依赖固定周期，而是**算出下次执行时刻 → 投递一次性 `schedule` → 回调里再算下一次**（`:75-118`）。这是任意 cron（含 `0 4 * * 1` 这种跨大间隔）的必要做法。
- **续期基准取 `max(now, next)`**（`:105-109`）——防时钟回拨导致同一时刻跑两次。
- **每个任务一个身份对象 `TaskFutureRef`**，调度前/执行前都校验 `taskFutureRefs.get(id) != futureRef → return`（`:78,94`）：**防止「任务被改了 cron 或删了之后，旧的已排程回调还继续跑并给自己重排」**——这是定时系统最经典的竞态。
- **读写锁**：结构变更持写锁、**执行只持读锁**（`:26-28,90-103`）。因此多任务可并发、同一任务不重叠（因为下次是在执行完成后才投递的）。
- 隐式语义值得明确写进文档：**任务耗时超过间隔时，下一次顺延，不补跑**。
- `enabled=false` 的任务**仍然排程**，只在回调里检查是否真的执行（`:96-100`）——这样能保留「下次执行时间」的语义，UI 可以展示。

**顺手可捡的**：

- **jitter**：OPanel 也没做，但 BlockNexus 的 30 秒 tick 让所有实例同时判定，几十个实例会产生同步 IO 尖峰。加抖动是几行代码。
- **时区**：OPanel 用进程本地时间，BlockNexus 的 `new Date()` 也一样（`watchdog.js:48-53`）。面板在 Windows、Agent 在 Linux，**两者的「凌晨 4 点」可能不是同一个时刻**——这是个真实的行为陷阱，值得至少把时区显式暴露在 UI 上。
- **任务历史 / 下次执行时间预测 / 失败告警**：两边都没有。OPanel 至少把任务写进控制台并推一条 WS 事件。BlockNexus 已有 SSE，做成事件成本很低。

**一个必须保留的现有优点**：BlockNexus 的调度**全在 Agent 侧**（面板关了照跑，`README.md:300`）。OPanel 跑在游戏进程内，天然如此。**换成 cron 时不要把这个性质做丢**——不要在面板侧加调度器。

### 2.4 时序指标：只存聚合 + 多级降采样

**现状**：面板每 30 秒采一次资源快照（`panel/api.js:156-158`），**只保留最新一份**（`statsCache`），**无历史**。前端 spark / 监控曲线靠 15 秒轮询（`web/src/components/spark-panel.tsx:132`）。

**OPanel 的做法**（核心里最"重"但也最完整的一块）：

- **原始点不落盘，只落聚合**：单表 `monitor_aggregate`，每行存 8 个指标的 **sum / min / max / sample_count**（`MonitorHistoryStore.java:25-35`）。
- **分钟 → 刻钟 → 小时三级金字塔滚动**（`:19-21`），每级独立保留期。
- **查询时才二次聚合**：按 `maxPoints`（默认 500，硬上限 2000）反推输出分辨率，**循环加大直到桶数 ≤ maxPoints**（`MonitorHistoryManager.java:290-308`）。
- **跨分辨率拼接**（`:224-267`）：先读小时段（到已完成整点）、再刻钟段、最后分钟段，三段首尾相接不重叠。
- 因此**内存与磁盘占用只与桶数量线性相关，与保留时长无关**，且永远能给前端固定点数的曲线。
- 采样累积在内存的「当前分钟桶」，桶关闭时才落库（`MonitorHistoryAccumulator.java:9-26`）；查询走同一个单线程 executor 且**带 10 秒超时**（`:23,109-115`）——慢查询不会挂住 HTTP 线程。
- **可失败、可自愈、可降级**：`available` 标志 + 失败即关闭存储并每 5 分钟尝试重开（`:330-360`）；不可用时控制器转 503。
- 保留期配置做**单调性钳制**（分钟 ≤ 刻钟 ≤ 小时，越界回落并 warn，`MonitorHistoryConfiguration.java:18-50`）。

**BlockNexus 的落地路径**：OPanel 用 H2（嵌入式 Java 数据库）。Node 侧的等价选择是 **SQLite（`node:sqlite` 或 better-sqlite3）或纯 JSONL + 定期压实**——但注意 BlockNexus 的 Agent 是**零依赖单文件**（`AGENTS.md` 明确这是部署链路的前提），所以：

- 如果指标采集留在 Agent 侧，**不能引第三方依赖**，应选「内存聚合桶 + 定期覆写一个小的 JSON/二进制聚合文件」，保留期选短一些（如分钟级 6 小时 + 小时级 30 天）。
- 如果放面板侧（面板已有 `express` 等依赖，且 `data/` 目录已存在），可以上 SQLite，实现可以更接近 OPanel。

**不要抄的部分**：OPanel 的 schema 版本不匹配**直接抛异常拒绝启动、不支持就地升级**（`MonitorHistoryStore.java:173-183`）。BlockNexus 的 `data/config.json` 已经有「读时补默认值」的兼容策略（`panel/config.js:40-55`），指标库应沿用后者。

### 2.5 前端 i18n（若有多语言计划，且需要架构级决策）

**现状**：**完全没有**。68/122 个 `.ts/.tsx` 含硬编码中文，`pages/` 7/7；`<html lang="zh-CN">` 硬写。**关键约束：后端错误消息也是中文裸字符串并直接呈现给用户**（`panel/api.js:564` `'未登录'`、`:741` `'服务器不存在'`），所以**i18n 不可能只在前端做**。

**若要做，OPanel 有四个值得抄的机制**：

1. **`TranslationKey` 从语言包反推 + `Record<TranslationKey, string>` 强制翻译完整**（`lang/index.ts:30-31`）：漏翻一个键 `tsc --noEmit` 直接报错，**零运行时成本**。这是最漂亮的一点。
2. **缺键回退返回键名本身**（`i18n.ts:14`）：界面显示 `terminal.ws.error` 比显示空白有用得多——一眼看出缺哪个键、缺在哪个语言。
3. **`{0}` 模板参数 + `@b{ref}` 富文本引用**（`i18n.ts:26-70`）：语序由译文决定（中英可以各自决定 `{0}` 的位置）；`@b{ref}` 让**富文本片段本身也是可翻译键**，翻译者不碰 HTML 也不会写错标签顺序。
4. **错误文案键的约定 `<功能>.error.<状态码>`**（`saves.upload.error.409`）+ 通用码集中在 `common.error.*`。

**若照抄，必须修掉两个 bug**：

- `localizeRich` 的两个 `while` 循环**没有边界检查**（`i18n.ts:46,61`）。译文里少写一个花括号 → `i` 越过字符串长度 → `str[i]` 恒为 `undefined` 永不等于 `{` → **页面直接挂死**。必须加边界检查。
- `localizeRich` 把字符串参数**原样拼进 HTML**（`:28-31`），而组件用 `dangerouslySetInnerHTML` 渲染。**语言包可信，但参数不一定**（比如玩家名）。必须对字符串参数做转义。

**决策提示**：OPanel 的 i18n 是**全静态导入、同步取词**（`$()` 是纯同步函数），代价是 8 个语言包 + 8 个 MC 语言表全进同一个 bundle，收益是零异步状态、零 loading 态、零水合不一致。**「同步 vs 懒加载」不是一个可以半途改的决定**——懒加载会让 `$()` 变成 async，所有调用点都要改。BlockNexus 若采用，建议先定死同步方案。

### 2.6 类型化 localStorage 设置仓库

**现状**：设置散落在组件里（如控制台的 `MAX_LINES = 1500` 是模块常量，`web/src/components/console-panel.tsx:11`），无统一入口。

**OPanel 的做法**（`settings.ts`）：

- **一个联合类型充当 schema**：键名即命名空间（`terminal.font-size`、`state.sidebar.open`），值类型就是真实类型（`ConsoleLogLevel[]` 而不是 `string`），`getSettings`/`changeSettings` 泛型把键与值绑死——**拼错键名或类型不匹配都是编译错误**。
- **`state.*` 与用户偏好分离**：`state.players.tab`、`state.terminal.history`、`state.sidebar.open` 也存进同一个仓库但用前缀区分。**成本几乎为零，但用户重开面板回到的是「离开时的样子」而不是「每次都从第一个 tab 开始」**——这是体验上很划算的一条。
- **读时迁移（read-time migration）**：读取时遍历 `defaultSettings` 补齐缺失键**并立刻写回**（`settings.ts:101-123`）。新增设置零迁移代码、无需版本号。同时**未知键被保留**（是「补齐」不是「重建」），因此用户降级再升级回来设置还在。
- **存储不可用即降级到默认值**，整个函数永不抛异常。

**照抄时必须加一层缓存**：原实现**每次 `getSettings` 都做一次全量 `JSON.parse` + `localStorage.setItem`（同步 I/O）**，而它在渲染期被高频调用（`terminal-viewer.tsx` 每个 `Log` 渲染读好几次设置 → 1000 行日志数千次 `JSON.parse`）。加模块级缓存 + `storage` 事件失效即可。

**另一个可选增强**：OPanel **没有**设置变更广播，所以同一设置在两处打开时不会实时联动。BlockNexus 已有 SSE，加一个 `settings-changed` 事件很自然。

### 2.7 前端测试基础设施（当前为零）

**现状**：`web/package.json` **没有 `test` 脚本**，devDeps 里没有 vitest/jest/RTL/playwright/jsdom；`vite.config.ts` 无 `test` 配置块。**oxlint 存在但 CI 也不调用**。

**OPanel 的做法**：vitest 4 + jsdom + `setupFiles`，测试里也挂真实的 Vite 插件并断言构建产物（`textures-plugin.test.ts:109-137` 用真实 `vite.build({write:false})` 断言「进包集合恰好等于选中集合」）。

**最该先测的三处**（都是「复杂逻辑 + 无回归防线」的典型）：

1. `web/src/lib/properties.ts` 的**无损回写**（保留注释/空行/键序、只改值、未知键原样、缺失键追加、`\:` 转义）——这类逻辑最容易在重构时悄悄破坏。
2. `web/src/lib/plugin-config.ts` 的 YAML diff、注释提取、**自动降级为原文编辑**的边界条件（TOML / 多文档 / 锚点 / 顶层非映射 / 解析失败）。
3. `web/src/lib/upload.ts` 的**分块重试与断点续传对齐**（每块重试 1 次 → 失败重新 `begin` 对齐，最多 8 次 recovery）。

**顺手可做的 CI 补强**（三条都是「已有资产没被用起来」）：CI 跑 `test:agent`（120+ 条断言目前只在开发者本机跑）、CI 跑 `build.js --check`、CI 跑 `oxlint`。

---

## 3. 长期：需要新写一个子系统才谈得上的

### 3.1 MC 领域建模：从「配置文件编辑」走向「游戏内数据」

**现状**：BlockNexus 对 MC 的理解**止步于服务端配置层**——`server.properties` 62 键元数据 + 通用 YAML/JSON/TOML 结构化编辑 + SLP 在线人数 + SRV 探测 + server-icon + 封禁表 + Mod 启停。**整块「游戏内数据」能力为零**（已经对 `web/src`、`panel/`、`agent/src` 三处分别反向 grep 验证）：无 NBT、无物品/背包、无地图/区块、无 gamerule 元数据、无 § 富文本、无皮肤/材质。

按「收益 ÷ 成本」排序，建议这个顺序：

**(a) § 格式化码富文本渲染 —— 成本最低，立刻改善现有 UI**

现状里 **MOTD 是按纯文本显示的**（`§` 颜色码不生效），而 BlockNexus 已经在 console 里手写了日志级别着色（`console-panel.tsx:24-39`）。OPanel 的实现要点：

- **跨迭代状态机而非正则**（`formatting-codes/text.ts:40-139`）：`currentNode` 游标让「颜色码重置到 root、格式码在颜色层内嵌套」自然成立。正则做不到正确的嵌套语义。
- **`§x§R§R§G§G§B§B` 先做 12 位 lookahead 校验再收集**（`:94-108`）：校验失败就当普通文本，**不吞掉后续 12 个字符**。
- **HTML 与 ANSI 两条路径**（`parseTextToHTML` / `parseTextToANSI`）：同一个解析器喂终端和网页。
- **`§k`（乱码）用 rAF 复现**，随机字符分 1px/5px 两组以**保持每帧等宽**（否则整行抖动）——细节但很显功力。
- **浅色主题要另配一套色值**（游戏原色如深蓝在浅色面板上不可读）。

**(b) gamerule 与更完整的配置元数据 —— 成本低，且有架构教训**

BlockNexus 已有 `PROP_DEFS`（62 键，含分组/中文说明/枚举选项/`hint`）——这套基础设施已经在了，扩展 gamerule 是同类工作。**但有一条架构经验必须吸取**：

> **表单 schema 要从「服务端真实返回的数据」动态生成，而不是从 preset 生成。**
> `generateFormSchema(properties)` 循环遍历的是传入的**真实字段集**（`server-config/index.ts:13-23`），preset 只描述「怎么展示」（名称/类型/说明/图标）。这样 **Mojang 新增属性时即使 preset 没补说明，表单也照常渲染**；某个版本删掉的属性也不会凭空出现。
> 反过来若从 preset 生成，就会永久陷入「游戏更新字段 → 面板表单漏了/多了」。

另外两个可直接搬的细节：**控件类型由 `typeof value` 决定**（不由 preset 的 `type` 决定）；**preset 匹配要求 `id === key && typeof value === type` 双重命中**（`gamerules/page.tsx:179`）——防止某个 gamerule 在新版本里从布尔改成数字后，旧说明被贴到语义已变的字段上。还有「**保存后显式提示需要重启**」这类小而关键的 UX。

**(c) 物品 / 背包 / SNBT —— 需要新增 Agent 侧能力**

**必须先纠正一个常见误解**：OPanel 的 `lib/nbt/` **不是二进制 NBT 读取器**。它只处理**服务端发来的 SNBT 字符串**（证据在 Java 侧：`record OPanelItemStack(..., String snbt)`）。真正的 NBT 读写发生在 Java 侧的游戏 API 内部。

这直接决定 BlockNexus 的路径：**Agent 是零依赖 JS，没有 MC 服务端 API**，所以：

- **二进制 NBT（`level.dat` / `playerdata/*.dat` / `region/*.mca`）需要在 Agent 侧从零实现 NBT 读写**——可行（NBT 格式本身不复杂），但这是实打实的工作量。
- **物品/背包编辑**在 Agent 侧几乎不可行（没有游戏内 API，只能改存档文件，且运行中会与服务器内存冲突）。**BlockNexus 的 Agent 架构天然不适合做这个**——这是与 OPanel「跑在游戏进程内」的根本差异，不要硬追。

若做 SNBT 侧，OPanel 值得抄的是：**按 MC 版本分流的解析器工厂**（`compare(version, "1.20.5")` 决定用 `ComponentsResolver` 还是 `TagResolver`，`nbt/index.ts:6-11`）+ **抽象基类把「物品要回答哪些问题」固定下来**，两个实现各自逐字段回答，**防御性解析集中在基类构造器**（解析异常即退化空对象，`resolver.ts:23-30`）。这比散落各处的 `if (version)` 好维护得多。

**(d) 网页地图 —— 最大的单项工程**

OPanel 的地图是完整子系统（Java 侧解析 `.mca` + Rust/Wasm 渲染 + Worker 客户端）。几个与「Minecraft」无关、可复用到任何「拖动/缩放频繁取数」场景的通用模式：

- **Worker 消息按「是否取数据」拆分**：`viewport`（只重绘缓存瓦片）vs `requestTiles`（重绘 + 取数）。这解决了「拖动过程中每帧发一次请求」的问题——拖动时只发 `viewport`，**松手/缩放步进/尺寸变化时才发 `requestTiles`**。
- **客户端 rAF 合并 + 请求去重（inflight map）**。
- **`OffscreenCanvas` + wasm 字节一次性 transfer 进 Worker**，并把「只能 transfer 一次」这个限制**转化为「父组件用 `key` 强制重挂载」的清晰契约**（`map-canvas.tsx:143-150`）。
- **脏区块闭环**：服务端每 5 秒批量 flush 脏块（上限 64 块）→ 推事件 → 前端按需重新拉瓦片。
- **构建期 Rust build script 预计算查找表**（方块 → 4 档 RGBA 的 `phf` 表）：把「几千次 JSON 解析 + PNG 平均」从运行期搬到编译期，运行期只剩 O(1) 查表。**凡是「静态、体积可控、查询频繁」的映射表都适用这个手法。**
- 服务端侧：自定义二进制瓦片格式（调色板 + 位打包，**不做 zlib**——因为方块 id 字典本身高度重复）、**temp + rename 原子替换**、**写盘 5 秒去抖 + 关服同步 flush**、**基于版本号计数器的 ETag**（`"avail-<version>"`，配 `Cache-Control: private, max-age=5`，与 5 秒 flush 周期正好合拍）。

**注意 BlockNexus 的架构约束**：地图渲染若放 Agent 侧，同样是零依赖 JS——解析 `.mca` 需要实现 Anvil 格式（8 KiB 头 = 1024 个 location + 1024 个时间戳、压缩类型 GZIP/ZLIB/NONE、`.mcc` 外置标志、NBT sections + palette 位解包 + heightmap）。这是可行但相当可观的工程量，**建议作为独立里程碑评估后再决定**。

### 3.2 扩展系统（长期，且需要先有稳定的对外契约）

OPanel 的扩展系统把第三方代码约束在四个可控面上，这套边界设计值得整体借鉴（即使 BlockNexus 最终选择更简单的形态）：

1. **独立可发布的 API 模块**（`api/`，发布到 Maven Central）：宿主与扩展的唯一契约面，且**版本独立演进**。Node 侧的对应物是「独立 npm 包 + `peerDependencies`」。
2. **受限 ClassLoader，只共享 API 和 Web 框架两件事**（`ExtensionManager.java:372-403`）：扩展自带的第三方库不污染宿主、也不共享宿主依赖。Node 侧对应「每个扩展独立 `node_modules` + 受控的 `require`」，但 **Node 没有 ClassLoader 隔离**——这是移植时最大的落差，需要明确承认「Node 插件无法真正沙箱化」，靠**权限模型 + 独立进程** 而不是加载器隔离。
3. **事件白名单 + 加载期签名校验**：参数类型不在白名单里的 `@EventHandler` **在加载期就被拒绝**（`ExtensionEventDispatcher.java:20-30,131-134`），而不是运行时静默不触发。
4. **卸载秩序**（`ExtensionEventDispatcher.java:174-228`）：`deactivate`（停收）→ **写锁等待在途派发结束** → 调 `unload()` → `invalidate()` API → 关 ClassLoader。**这是插件系统里最容易做错、也最容易导致资源泄漏的地方**——「先停止接收、等待在途任务跑完、再释放」这个顺序在任何异步插件系统里都成立。
5. **两条安全细节**：扩展页面 URL 必须通过 `isSafePageUrl`（必须以 `/` 开头、不以 `//` 开头、不含 `\`、URI 不绝对、无 authority）——**防止扩展把一个相对 URL 变成外部跳转**（`ExtensionManager.java:252-267`）；扩展路由分发时**临时替换线程上下文 ClassLoader**（`BeforeController.java:170-177`）。
6. **`example-extension/` 覆盖全部扩展能力，且 `compileOnly` API 与 Web 框架**（打出来不含它们，运行时由宿主提供）——**一个可运行的示例比十页文档有用**。

### 3.3 一次性下载令牌（小而有价值）

**OPanel 的做法**：所有下载统一走 `/file/{随机16位ID}/{fileName}`，服务端用 map 把 ID 映射到 `Path` 或 `byte[]`，**下载后立即从 map 移除（可下载一次）**，并支持「下载后回调」用于清理（`DownloadController.java:15-19,41-67`）。

**为什么值得**：没有把任意路径暴露成 GET 参数，而是「服务端注册 → 随机一次性 ID」的能力令牌模型，**天然规避目录穿越和路径猜测**。`isSafeFileName`（拒绝 `..`、`/`、`\`、多段路径、绝对路径）是第二道闸。

BlockNexus 的下载是流式代理（`panel/api.js:2739-2763` 文件、`:2393-2419` 备份），路径由前端传参——**值得检查一下 `isSafeFileName` 类的校验是否覆盖了所有用户提供的文件名入口**。OPanel 的「所有『用户提供文件名』的入口都走同一个校验函数」是一条好纪律。

---

## 4. BlockNexus 已经更好或不必改的地方

诚实评估，避免为了「借鉴」而倒退：

| 领域 | BlockNexus 现状 | OPanel | 结论 |
|---|---|---|---|
| **存储原子性** | `config.js:75-89` 用「唯一临时名 + `renameSync`」原子替换，还处理了并发保存互抢（ENOENT） | `StorageFile.write()` 用 `TRUNCATE_EXISTING`，**非原子**；崩溃留下半截 JSON → `read()` 回落默认值 → **整份配置丢失** | **BlockNexus 更正确，不要改** |
| **Agent 协议完整性** | 双向认证（两方向都验 proof）+ 时钟偏差检查 + 单调计数器防重放 + TLS 证书指纹固定 + 半开链路检测（2 次丢 pong 即踢）+ RTT 取最近 5 次最小值 | WS 无重连、无心跳、无序号 | **BlockNexus 明显更成熟** |
| **会话吊销粒度** | 内存 Map，可单个删、可全清 | JWT + 服务端白名单（重启全掉线，但登出立即生效） | 各有权衡；OPanel 的「**无状态令牌承载 + 有状态白名单负责立即吊销**」组合值得参考，但 BlockNexus 现在的纯 Map 更简单且已够用 |
| **重置密码流程** | 三段式 OTP（摘要存储、一次性票据、发码限流、单码全局试错上限、邮箱不匹配也返回成功防探测） | OIDC 绑定流程**把可复用的 hashed2 放进请求体**且用 `String.equals` 非常量时间比较 | **BlockNexus 的密码路径硬化水平高于 OPanel 的 OIDC 绑定路径** |
| **控制台体验** | 日志级别着色、指令历史 ↑↓、自增高输入、follow-tail 精确判定（40px 容差） | 有补全与级别过滤，但**清理用 `innerHTML=""` 而不是 `setLogs([])`**（会导致虚拟 DOM 与真实 DOM 失配 → 白屏） | BlockNexus 的清理方式是对的；可从 OPanel 补「补全」与「级别过滤」 |
| **上传断点续传** | 512KB 串行分块 + 磁盘指纹 sidecar + **Agent 重启后仍能按 size 接力** + 半块 `seekTo` 截断 + 每块重试后重新对齐 | 无（OPanel 的下载走一次性令牌，上传走 multipart 整体） | **BlockNexus 的分块上传复杂度远高于 OPanel**；但注意它的 200MB 硬上限与 base64 1.37× 膨胀 |
| **CSRF 语义** | `SameSite=Lax` + 无 CORS + JSON Content-Type 检查 | 无 CSRF token，靠 `SameSite=Lax` | 相当；BlockNexus 补 §1.4 后更清晰 |

**结论**：BlockNexus 在**传输安全、存储原子性、上传可靠性**三块已经领先或持平。借鉴重点应放在 **前端架构、实时通道、类型契约、i18n、测试、MC 领域建模、调度、指标历史** ——这些是它真正的短板。

---

## 5. 反面清单：OPanel 里不要照抄的东西

每一条都有源码定位，都是「看起来对、用起来会咬人」的设计。

### 5.1 前端 WS 基类的订阅管理（最严重）

`ws/index.ts:49-60`：**每次 `subscribe` 都给同一个 socket 挂一个新的 `message` 监听器，且该方法返回 `void`——没有任何取消订阅的手段。**

后果链条：

- N 个订阅者 ⇒ 每条报文 `JSON.parse` N 次 ⇒ 整体 **O(N²) 解析开销**。
- 组件 effect 因任何原因重跑（依赖变化、React StrictMode 双调用）⇒ **旧监听器仍在** ⇒ 同一条报文被处理两次、`setState` 两次、**toast 弹两次**。
- 唯一的「取消」手段是关掉整条连接。

**正确写法**：内部维护 `Map<type, Set<callback>>`，**一个** `message` 监听器负责分发；`subscribe` 返回 `unsubscribe`。

### 5.2 前端 WS 完全没有重连与心跳

`index.ts:40-47` 把 `close` 直接转成 `onClose()` 回调，各 feature client 的 `onClose` **只有 `console.log`**（`terminal.ts:47-49`、`monitor.ts:20-22`、`players.ts:28-30`、`inventory.ts:31-33`、`map.ts:22-24`）；全前端搜 `reconnect` 零命中；无 `ping`/`heartbeat`；无 `visibilitychange`/`online` 触发。

后果：**断线后面板静默失效**——数据停止更新、没有任何提示，用户唯一出路是手动刷新。而且**「没有心跳」是「没有重连」的上游原因**：TCP 半开（经代理/NAT 被静默回收）时前端既收不到 `close` 也收不到 `error`，**连断了都感知不到**。

BlockNexus 的 SSE 靠浏览器 `EventSource` 内建重连回避了这个问题——**这是切到 WS 时必须自己补回来的成本**，别低估。

### 5.3 `emitter` 用 `removeAllListeners` 清理

`players/page.tsx:93-100` 等 8 处用 `emitter.on("refresh-data", () => f())` + `return () => emitter.removeAllListeners("refresh-data")`。

**`removeAllListeners(事件名)` 会摘掉所有组件注册的监听器，而不只是自己的。** 在「父子组件同时订阅」的形态下（比如一个 dialog 挂在某页面里、两边都订阅），**先卸载的那一方会把另一方的订阅一起干掉**，之后「刷新不生效」且极难定位——报错的地方和出问题的地方隔了两层。

同一文件里 `settings/page.tsx:169-172` 是**正确样板**（具名 handler + `off`）。所以这是「规则未被执行」而非「不知道该怎么做」。**规则应当是：只允许具名 handler + `off`，禁止 `removeAllListeners(事件名)` 与匿名 handler。**（`tasks/page.tsx:51` 的 `off` 里传了个新的匿名函数，等于没注销——同一个 bug 的变体。）

### 5.4 终端清理用 `innerHTML = ""`

`terminal-viewer.tsx:167-171` 在清理函数里手写 `innerHTML = ""`：它清掉了 **React 管理的 DOM 节点**，但 `logs` state 没重置。虚拟 DOM 与真实 DOM 从此失配——重新订阅后 React 认为那些节点还在，可能不再插入 ⇒ **白屏或内容错乱**。要清空就 `setLogs([])`。

### 5.5 行数上限给到 20000 却不做虚拟化

`MAX_LOG_LINES` 默认 1000、**上限 20000**（`settings.ts:63`）；每次 flush 都 `[...current, ...buffer]` 重建整个数组（`terminal-viewer.tsx:150`）；文本搜索过滤每次渲染**全表 `.filter()`**（`:248-255`）；级别过滤用 **CSS 隐藏而非剪枝**（`:78,260`，被过滤的行仍留在 DOM 里）。

行数上限很高 + 无窗口化 = **一开搜索就卡**。BlockNexus 现在 `MAX_LINES = 1500`（`console-panel.tsx:11`）且无虚拟化——量级安全，但**不要往上加这个上限**，除非同时上窗口化渲染 + `useMemo`/worker 过滤。

### 5.6 `useWebSocket` 丢弃实例时不 close

`hooks/use-websocket.ts:9` 的 `setClient((current) => current ?? ws)` 在 `current` 已存在时把新建的 `ws` 直接扔掉，**不调用 `close()`** ⇒ 服务端残留一条活连接。同时 `...args` 不在依赖数组（`:16` 用 `oxlint-disable` 掩盖），构造参数变化不会重连（`inventory/page.tsx:39` 传的 `uuid`——同页 client-side 切 uuid 会继续用旧连接）。

**通用教训**：`oxlint-disable` 压掉 `exhaustive-deps` 的地方，就是依赖漏项从「编译期可见」变成「运行时偶发」的地方。OPanel 把该规则设为 `warn` 并广泛就地禁用——**BlockNexus 应采用时把它设为 `error`**，至少对实例相关 hook。

### 5.7 其他明确的坑（清单）

| 位置 | 问题 |
|---|---|
| `StorageFile.java:116-119` | 非原子写（无 temp+rename）：写崩 = **整份配置丢**（对比：`config.yml` 走平台自身保存、地图 bundle 走 temp+move） |
| `StorageFile.java:121-145` | 「以默认值树递归补键」式迁移：**无法处理删字段/改类型/改语义**；无 schema 版本号 |
| `MonitorHistoryStore.java:173-183` | schema 版本不匹配**直接抛异常拒绝启动**，不支持就地升级 |
| `JwtManager.java:15` | 签名密钥**进程内随机生成**：重启/热重载即全员掉线，且无法多实例 |
| `TaskCommandExecutor.java:27-39` | `@goto` 语法**解析完整但执行器整段被注释掉**——用户能写但无效（半成品语法不该发布） |
| `TasksController.java:47 vs 66` | `createTask` 解 base64，`updateTask` **不解**——同一字段两处不一致 |
| `MapController.java:25,31,53` | 地图开关用**启动时快照** `originalEnabled`：运行时切换开关后 tile 接口不生效，需重启 |
| `BaseEndpoint.java:48-53` | **WS 鉴权在握手之后**：未授权连接也会占用一次完整的 WS 升级 |
| `OidcController.java:145` | OIDC 绑定用 `String.equals` 而非常量时间比较，且**请求体里带的是可复用的 hashed2**；该请求被截获即等价泄露口令 |
| `MapController.java:208-214` | 瓦片 ETag 用**长度**而非内容哈希：存在「内容变但长度不变且索引版本未变」的漏判窗口（被 10 秒 max-age 限制） |
| `components.json:8` | 配置指向**不存在的 `app/globals.css`**（真实文件是 `style/globals.css`）——用 shadcn CLI 前必须修 |
| `localizeRich`（`i18n.ts:46,61`） | 两个 `while` 无边界检查：译文少一个花括号 → **页面挂死**；字符串参数**未转义**即拼进 HTML |
| `getSettings`（`settings.ts:101-123`） | 每次调用全量 `JSON.parse` + `setItem`（同步 I/O），无缓存，却在渲染期高频调用 |

---

## 6. 建议的执行顺序

按「风险 × 收益 ÷ 成本」排：

| 阶段 | 内容 | 依据 |
|---|---|---|
| **P0（安全，立刻）** | `trust proxy` 白名单、`Secure` Cookie、`loginFails` GC、CSRF 方法覆盖 | §1（4 项均已验证） |
| **P0（零成本资产启用）** | CI 跑 `test:agent` + `build.js --check` + `oxlint` | §2.7 |
| **P1（前端地基）** | 类型化设置仓库（带缓存）→ `APIResponse` 统一错误契约 + 路由 JSDoc → 前端测试基础设施（先测 properties/plugin-config/upload） | §2.2、§2.6、§2.7 |
| **P1（立刻改善 UI）** | § 格式化码富文本（MOTD 现在还是纯文本） | §3.1(a) |
| **P2（架构级）** | WebSocket 双向 + 类型化报文（替代 SSE）→ 终端补全；同批做重连/心跳/断线提示 | §2.1、§2.2 |
| **P2（运维能力）** | cron 调度（保留 Agent 侧执行的架构性质）+ jitter + 时区显式化 | §2.3 |
| **P3（产品能力）** | 指标历史（只存聚合 + 多级降采样）；gamerule 元数据（schema 从真实数据生成） | §2.4、§3.1(b) |
| **P3（若有多语言计划）** | i18n——**需要先决定「同步取词」**，且必须同时处理后端中文错误消息 | §2.5 |
| **P4（独立里程碑）** | 网页地图；NBT/物品（**注意 Agent 架构的根本限制**）；扩展系统；一次性下载令牌 | §3.3、§3.1(c)(d)、§3.2 |

---

## 附录：本次调研的产出与方法

| 文件 | 内容 | 规模 |
|---|---|---|
| `docs/opanel-techniques-backend.md` | Java 后端 15 节：CRAM/JWT/WS 协议/控制器/存储/调度/终端/监控 H2/扩展系统/事件总线/地图渲染/能力探测/39 模块构建体系 + 15 条风险表 | 825 行 |
| `docs/opanel-techniques-frontend-core.md` | 前端基础层：WS 客户端（含 **14 条缺陷清单**）/HTTP 封装/emitter/i18n 完整架构/设置仓库/类型契约 base64 约定/oxlint 配置 | 531 行 |
| `docs/opanel-techniques-frontend-mc.md` | MC 领域 9 节：§ 状态机/SNBT（**澄清非二进制 NBT**）/材质管线/地图 Worker+Wasm/配置元数据/shadcn 与两条文件布局约定/vitest + i18n mock 坑 + 10 条已知取舍 | 716 行 |
| `docs/blocknexus-current-state.md` | 本仓库现状审计 9 维度 + 57 条缺口 + 2 附录（**所有「不存在」经反向 grep 验证**） | 477 行 |
| 本文件 | 可借鉴清单 + 优先级 + 反面清单 + 执行顺序 | 404 行 |

**方法**：克隆 `opanel-mc/opanel` 到 `.opanel-reference/`（已加入 `.gitignore`，不入仓库）；四路并行深读（后端 / 前端核心 / 前端 MC 领域 / 本仓库现状审计），全部结论带 `file:line` 引用。本文件的**安全类结论（§1）与「BlockNexus 已更好」结论（§4）由我本人二次验证**，未直接采信子报告。原克隆的第三方库分析基于源码与类型声明（`node_modules` 不存在，未打开 `minecraft-textures` 包内 JSON）。

**未做的事**：未执行任何构建或测试命令（纯静态审计）；未修改 BlockNexus 任何源代码——本次只新增 `docs/` 下 5 个文件与 3 行 `.gitignore`。
