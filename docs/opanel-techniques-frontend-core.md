# OPanel 前端核心层技术分析报告（WS / API / i18n / Settings / Types / 工程配置）

> 分析对象：`.opanel-reference/frontend/`。覆盖 `lib/ws/`、`hooks/`（WS 相关）、`lib/api.ts`、`lib/emitter.ts`、`lib/update.ts`、`lib/i18n.ts` + `lang/`、`lib/settings.ts`、`lib/types.ts`，以及 `package.json`、`.oxlintrc.json`。
> 全文只读剖析；路径相对 `.opanel-reference/frontend/`，行号为该文件内行号。
> 阅读顺序：第 1 节（WS，含"不要照抄的缺陷清单"）→ 第 2 节 → 第 4 节 → 第 5–6 节 → 第 7 节。

---

## 0. 总体取向

这一层的一致性非常清晰：**用类型当契约，用单一职责的文件当边界**。`lib/types.ts` 是唯一的 API 契约表（每个后端路由一个 interface，JSDoc 标路由，`types.ts:201`、`:211`、`:239`）；`lib/api.ts` 是唯一 HTTP 出口，全部过 `APIResponse<T>` 信封（`types.ts:7-10`）；`lib/i18n.ts` 是唯一取词出口，键名由 `lang/zh-cn.json` 反推成联合类型（`lang/index.ts:30`）；`lib/settings.ts` 是唯一 localStorage 出口，键名同样是联合类型（`settings.ts:16-49`）；`lib/emitter.ts` 是唯一广播出口，且只有 `refresh-data` 与 `loading-done` 两个事件名。

收益：新增接口 = 一个 interface + 一个 fetch 函数；新增文案 = 一行 JSON，无中间层要同步。代价在第 1 节可见——**WS 层是这一层里唯一"类型退化成 `any`"的地方**。

---

## 1. `lib/ws/` + `hooks/` —— 浏览器 WebSocket 层

### 1.1 `WebSocketClient<M>` 基类（`lib/ws/index.ts`，全文仅 80 行）

**类型层**（`index.ts:4-8`）：

```ts
type MessageType<M extends string> = M | "connect" | "error";
interface Packet<M extends string, D> { type: MessageType<M>; data: D }
```

`M` 是各功能自己声明的报文类型字符串联合；基类只补上 `"connect"`/`"error"` 两个公共类型。**没有任何从 `type` 到 payload 类型的映射**——`Packet<M, D>` 的 `D` 是独立的第三个参数，与 `M` 无约束关系。

**连接生命周期**（`index.ts:10-27`）：

```ts
constructor(route: string) {
  checkAuth().then((res) => {
    if(!res) { if(this.socket !== null) { this.socket.close(); this.socket = null; }
      window.location.href = "/login"; }
  });
  const url = new URL(route, wsUrl);
  this.socket = new WebSocket(url);
  this.init();
}
```

三个要点：① 构造函数里做副作用（一次 `POST /api/auth/check` + 立即建连 + 注册监听器），`route` 是相对片段，靠 `new URL(route, wsUrl)` 拼绝对地址，所以每个功能只传 `"/socket/terminal"`（`terminal.ts:40`）；② 鉴权是事后补救——`checkAuth()` 异步，`new WebSocket()` 同步发出，未登录时**握手会先发生一次**再被关掉，真正拦住的是服务端握手期的 cookie 校验；③ 失败走 `window.location.href` 整页跳转，而非 SPA 路由。

**监听器注册**（`index.ts:29-47`）：`subscribe("connect", () => this.onOpen())`、`subscribe("error", (err) => this.onError(err))`，外加原生 `addEventListener("error")` → `onError`、`addEventListener("close")` → `onClose`。注意 **`onOpen` 由服务端 `connect` 报文触发，而不是 socket 的 `open` 事件**——因此其语义是"服务端说它可以了"，消费者用 `connect` 关闭加载条是正确的（`app/panel/terminal/page.tsx:193-196`）。但同一段代码把 `onError` 的语义搞混了：`:36-38` 喂进去的是服务端 `error` 数据包的 payload，`:40-42` 喂进去的是传输层 `Event`，两者都进 `onError(err: any)`（`:64`）。

**订阅与分发**（`index.ts:49-60`）—— 全层最重要的机制，也是最大的坑：

```ts
public subscribe<D>(type: MessageType<M>, cb: (data: D) => void) {
  if(!this.socket) { toast.error("WebSocket not initialized."); return; }
  this.socket.addEventListener("message", (e) => {
    const packet: Packet<M, D> = JSON.parse(e.data);
    if(packet.type === type) { cb(packet.data); }
  });
}
```

**每个订阅者各自挂一个 `message` 监听器**，而不是"一个监听器 + 内部回调表"；方法返回 `void`，**没有取消订阅的手段**。`send` 同理，只检查 `socket !== null`（`:66-72`），不查 `readyState`、不缓冲、不排队。

### 1.2 五个 feature client：声明"路由 + 报文表"

子类只做两件事：传路由、实现三个钩子。**新增一个 WS 功能约 30 行**，这是这套抽象最成功的部分。

| 文件 | 路由 | 服务端 → 客户端 | 客户端 → 服务端 |
|---|---|---|---|
| `terminal.ts:38-40` | `/socket/terminal` | `init` `log` `mcdr-log` | `command`（双向另有 `autocomplete`） |
| `monitor.ts:11-14` | `/socket/monitor?limit=N` | `init` `update` | — |
| `players.ts:19-22` | `/socket/players` | `init` `join` `leave` `move` `gamemode-change` | `fetch` |
| `inventory.ts:22-25` | `/socket/inventory/{uuid}` | `init` | `fetch`（双向另有 `update`） |
| `map.ts:13-16` | `/socket/map` | `chunks-flush` | — |

值得抄的手法：

- **方向用注释写进类型**：每个 `XxxMessageType` 联合按 `/* server packet */`、`/* client packet */`、`/* common packet */` 分区（`terminal.ts:27-36`、`inventory.ts:13-20`）。零成本的协议文档，紧贴类型定义不会腐化。
- **连接参数走 query string 不走报文**：`MonitorClient(limit)` → `` `/socket/monitor?limit=${limit}` ``（`monitor.ts:13`），服务端建连时就知道推多少历史帧，省一次 `fetch` 往返，`init` 得以直接是全量。
- **路径参数定位实体**：`InventoryClient(uuid)` → `/socket/inventory/${uuid}`（`inventory.ts:24`），把"订阅哪个玩家"表达在连接层，天然隔离，报文无需带 uuid。
- **批量载荷降密度**：`PlayerMoveData = Pick<Player, "uuid" | "name" | "position">`（`players.ts:6`）+ `subscribe("move", (movedPlayers: PlayerMoveData[]) => ...)`（`app/panel/players/page.tsx:128`），服务端可按 tick 合并推送，消费侧用 `Map` 做 O(1) 归并（`page.tsx:129-135`）。
- **客户端补字段**：`ConsoleLog.uuid?: string`（`terminal.ts:24`）由前端收到时用 `uuidv7()` 填（`components/terminal-viewer.tsx:221`），只为当 React `key`，不污染协议。
- **占位首帧**：`createInitialMonitorData(limit)`（`hooks/use-monitor.ts:5-16`）先造全 0 数组（`tps: 20`，避免图表开局跳到 0 造成误导），`init` 到达前图表长度已正确，不会"先 3 个点再突然变 60 个"。

### 1.3 消费侧 `useWebSocket`（`hooks/use-websocket.ts:4-19`）

```ts
useEffect(() => {
  const ws = new clientClass(...args);
  setClient((current) => current ?? ws);
  return () => { ws.close(); setClient(null); };
// oxlint-disable-next-line react/exhaustive-deps
}, [clientClass]);
```

用 state 而非 ref，因为订阅必须发生在 `client` 进入渲染树之后，`useEffect(..., [client])` 是唯一能保证"实例已存在再订阅"的写法；代价是**首帧返回 `null`**，所有消费者必须 `if(!client) return;`（`players/page.tsx:103`、`inventory/page.tsx:103`、`map-canvas.tsx:226`）或 `client?.subscribe(...)`（`terminal/page.tsx:194`）。`use-monitor.ts:27-42` 干脆绕过该 hook 自己 `new` + `subscribe` + `close`，因为订阅集合静态且需 `safeLimit` 参与依赖。

两个洞见 1.6 第 10 条：`current ?? ws` 丢弃实例时不 `close()`，且 `...args` 不在依赖里（`inventory/page.tsx:39` 传 `searchParams.get("uuid")`，同页 client-side 切 uuid 会继续用旧连接）。

### 1.4 终端组件 `components/terminal-viewer.tsx` —— 批处理 + 迟滞自动滚动

被完整终端页（`app/panel/terminal/page.tsx:249-254`）与仪表盘 `terminal-card.tsx`（`simple` 模式）复用。266 行里四个独立机制。

**(a) rAF 合帧批处理**（`:127-165`）

```ts
const scheduleFlushLogsBuffer = () => {
  if(flushLogsRafRef.current) return;
  flushLogsRafRef.current = requestAnimationFrame(() => {
    flushLogsRafRef.current = null; flushLogsBuffer();
  });
};
```

收到 `init`/`log`/`mcdr-log` 时只做两件事：补 `uuid`、push 进 `logsBufferRef`，然后请求一帧（`:219-237`）。一帧内到达的所有日志合并成一次 `setLogs`，随后 `newLogs = [...current, ...buffer]` 并裁剪到 `MAX_LOG_LINES`（`:150-153`）。服务端刷屏时，这一层把"每行一次 React 渲染"压成"每帧一次"，是控制台能用的前提。`MAX_LOG_LINES` 在模块加载时读一次并冻结（`:15`；`settings.ts:63` 默认 1000、上限 20000）。

**(b) 带迟滞的自动滚动**（`:16`、`:133-199`）：判定"用户是否自己滚动"用了两个阈值——`flushLogsBuffer` 里离底 ≤20px 就解除接管状态（`:141-147`），`handleScroll` 里离底 >150px 才进入接管状态（`:177`）。中间 130px 是迟滞带，避免底部附近轻微滚动导致自动滚动反复开关。`STOP_SCROLLING_TIME = 5000`（`:16`）再加兜底：5 秒无 scroll 事件就恢复自动滚动，防止用户滚上去后日志"冻住"。真正滚动的是依赖 `logs` 的 effect（`:192-199`，`if(!scrollingRef.current) elem.scrollTo({top: elem.scrollHeight})`），因此每次合帧滚一次，不是每行滚一次。

**(c) 级别过滤 = CSS 隐藏，不是剪枝**（`:78`、`:260`）：`visible={levels.includes(log.level)}` 只改一行 class。切换级别不重建列表；代价是被过滤行仍留在 DOM。文本搜索则是真剪枝，渲染期 `.filter()`（`:248-255`），支持大小写敏感与正则模式——正则由 `parseRegex` 安全包裹，非法正则退化成 `new RegExp("")` 而不抛（`terminal/page.tsx:50-56`）。级别状态持久化在设置里（`page.tsx:68-70` 读、`:211-213` 写），用 `getLogLevels(info, warn, error)`（`terminal.ts:7-14`）做三布尔 ↔ 数组转换，避免把 UI 三元组泄漏到存储层。

**(d) 富文本三趟处理**（`:23-39`）是全组件最不显然的一段：

```ts
if(getSettings("terminal.rich-style")) {
  line = ansiConverter.toHtml(parseTextToANSI(line.replaceAll("\x7f", secSign)));
} else { line = purifyUnsafeText(line); }

// 只对标签之外的文本做链接化
line = line.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<[^>]*>|[^<]+/g, (f) => f.startsWith("<") ? f
  : f.replace(urlRegex, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));

// 文本片段包 span，让下划线跟随嵌套前景色
return line.replace(/<[^>]*>|[^<]+/g, (f) => f.startsWith("<") ? f
  : `<span data-slot="terminal-log-text">${f}</span>`);
```

顺序不可交换：① Minecraft `§` 格式化码先转 ANSI 转义（`parseTextToANSI`，`lib/formatting-codes/text.ts:144`），再交 ANSI→HTML 转换器；② 链接化必须避开已生成的 `<a>`（正则首分支专门吃掉完整锚点），否则嵌套锚点；③ 裹 `span` 是为了让 CSS `text-decoration` 跟随 ANSI 前景色的嵌套层级（否则下划线画在错误颜色上）。`\x7f`→`§` 是兼容旧服务端日志的净化。最终经 `dangerouslySetInnerHTML` 落地（`:104-105`）——**日志内容（玩家名、聊天）不可信，安全性全靠 `escapeXML: true`（`:18`）与 `purifyUnsafeText` 分支**。

### 1.5 `lib/ansi-to-html`：vendored 的第三方库（645 行）

是 `rburns/ansi-to-html` 的 TS 移植（`lib/ansi-to-html/README.md:9-19` 标注来源与 MIT），只加了 OSC 8 超链接（`:41`、`:355-369`、`:508-521`）与流式状态（`:13`、`:596`、`:640-641`）。三点值得抄：

1. **转义是转换器的职责，不是调用方的**（`:296-302`）：`pushText` 输出文本前统一 `entities.encodeXML`。调用方只管"要不要富文本"，避免"两处都转义出现 `&amp;lt;`"或"两处都忘"。
2. **超链接协议白名单 + 控制字符拒绝**（`:355-364`）：只放行 `http:`/`https:`，拒绝含 `\x00-\x20\x7f` 的 URL，`openHyperlink` 还对属性值再 `encodeXML`（`:368`）。凡"用户可控 URL 进 `href`"都该这样。
3. **`stream` 模式**（`:13`、`:590-641`）跨调用保存样式栈与未完成 OSC 序列。**OPanel 没开这个开关**——`terminal-viewer.tsx:18` 只传 `{ escapeXML: true }`，`toHtml` 结束时会把未闭合标签全补上（`:635-637`），因此每行独立成段、上一行的颜色不延续。这对"日志行本身完整"是对的；若要流式渲染真正的交互终端必须打开 `stream`。

转换器是模块级单例（`terminal-viewer.tsx:18`），避免每行新建对象。

### 1.6 这套 WS 模式的缺陷清单（**不要照抄**）

前 6 条直接影响用户，其余在规模上来后咬人。

1. **`subscribe` 每次新增一个 `message` 监听器且无法取消**（`index.ts:49-60`）。无 unsubscribe 句柄、无事件名→回调数组映射、`close()` 也不移除。N 个订阅者 ⇒ 每条报文 `JSON.parse` N 次 ⇒ 整体 O(N²)。组件 effect 因任何原因重跑（依赖变化、StrictMode 双调用）时**旧监听器仍在**，同一条报文被处理两次、`setState` 两次、toast 弹两次。唯一"取消"手段是关掉整条连接。
2. **完全没有重连**。`onClose` 只有 `console.log`（`terminal.ts:47-49`、`monitor.ts:20-22`、`players.ts:28-30`、`inventory.ts:31-33`、`map.ts:22-24`），全前端 grep `reconnect` 零命中。断线后面板**静默失效**：数据停更、无任何提示、用户只能刷新页面。无指数退避、无 `online`/`visibilitychange` 触发、无重试上限。
3. **没有心跳/保活**。全前端无 `ping`/`heartbeat`。经反向代理或 NAT 的空闲连接被静默回收（TCP 半开）时，前端既收不到 `close` 也收不到 `error`，一直以为连着。**这是第 2 条的上游原因**——连断都感知不到，无从重连。
4. **`onError` 语义重载**（`index.ts:36-42` + `:64`）。服务端 `error` 报文与传输层 `Event` 共用 `any` 形参。`InventoryClient` 干脆不实现（`inventory.ts:35-37`）；`TerminalClient` 无论哪种都弹"无法连接到终端 WebSocket"（`terminal.ts:51-54`），传输层瞬时抖动也会弹用户可见错误。
5. **payload 类型退化成 `any`**。`MessageType<M>` 只约束 type 字符串（`index.ts:4`），`subscribe<D>` 的 `D` 由**调用者手写**（`players/page.tsx:105-140` 逐个标注 `Player`/`Player[]`/`PlayerMoveData[]`），写错不报错。正解是每个功能导出 `PayloadMap`，签名改为 `subscribe<K extends keyof PayloadMap>(type: K, cb: (data: PayloadMap[K]) => void)`。注意 `inventory.ts:4-11` 已定义 `InventoryMovePayload`/`InventoryUpdatePayload` 但**从未用于任何签名**（`inventory/page.tsx:110` 手写了 `PlayerInventory`），属"写了类型没接上"的半成品。
6. **没有请求—响应关联**。`send("fetch", null)` 后靠后续 `init`/`update` 广播"猜"（`players/page.tsx:142`、`inventory/page.tsx:128`）。无 request id、无 Promise 封装、无超时；并发两次 `fetch` 无法区分；也没有"请求失败"概念（只能等服务端推 `error`）。唯一去重是终端补全的手写守卫：`argIndexRef` 缓存上次参数下标，仅变化才发（`terminal/page.tsx:153-160`）。
7. **`send` 不查 `readyState`、不缓冲**（`index.ts:66-72`）。`socket !== null` ≠ `OPEN`：`new WebSocket()` 后处于 `CONNECTING`，此刻 `send` 抛 `InvalidStateError`。断线期间发出的命令静默丢弃。
8. **`JSON.parse` 无 `try/catch`**（`index.ts:55`）。畸形帧在每个订阅者监听器里各抛一次未捕获异常，污染控制台且无法归因。
9. **构造函数里做异步鉴权 + 立即建连**（`index.ts:14-26`）。未登录时会先建一条 WS 再关掉；`checkAuth` 失败走整页跳转，与 SPA 路由并存两套导航语义。鉴权依赖 cookie（`withCredentials`，`api.ts:42`），WS 与 HTTP 是两条隐式共享同一 cookie 的路径。
10. **`useWebSocket` 丢弃实例时不关闭**（`use-websocket.ts:9`）：`current ?? ws` 在 `current` 已存在时把新建 `ws` 直接扔掉而不 `close()` → 服务端残留活连接。同时 `...args` 不在依赖数组（`:16` 用 `oxlint-disable` 掩盖），构造参数变化不重连。
11. **终端清理手写 `innerHTML = ""`**（`terminal-viewer.tsx:167-171`，在 `:239` 被 `return () => clearLogs()` 调用）。它清掉 **React 管理的 DOM 节点**，但 `logs` state 未重置 ⇒ 虚拟 DOM 与真实 DOM 失配，重新订阅后 React 认为那些 `<p>` 还在而可能不再插入 → 白屏或错乱。应改 `setLogs([])`。
12. **全量渲染、零虚拟化**。每次 flush 都 `[...current, ...buffer]` 重建整数组并重渲染整表（`:150`），只靠 `memo(Log)`（`:41`）挡未变行；上限允许 20000（`settings.ts:63`），文本搜索每次渲染全表 `.filter()`（`:248-255`），级别过滤用 CSS 隐藏（`:78`、`:260`）。大上限 + 无窗口化 = 一开搜索就卡。
13. **每功能一条 socket，无多路复用**。仪表盘一个页面就 `terminal-card.tsx:19` + `players-card.tsx:31` + `use-monitor.ts:27` 三条，逼近 HTTP/1.1 upgrade 的每域 6 连接上限；服务端要为每条连接维护独立状态。
14. **没有 `visibilitychange` 降级**。页面进后台后 socket 与监控推送照跑，白耗电；服务端无法知道"这个客户端没人看"。

**一句话**：这套抽象"多路复用 + 报文类型字符串"的想法是对的（新增功能 30 行，路由/协议/方向一目了然），但它把"订阅管理""重连""请求关联"三件必须由基类负责的事全推给调用方，而调用方没有任何工具——于是三件都没做。复刻时请保留路由约定与报文类型联合，但把 `subscribe` 改成返回 `unsubscribe` 的内部回调表、加 `readyState` 检查与发送队列、加指数退避重连 + 心跳 + `visibilitychange` 暂停，并让 payload 类型跟随报文类型。

---

## 2. `lib/api.ts` —— HTTP 封装

### 2.1 地址解析（`api.ts:6-16`）

```ts
export const apiUrl = (process.env.NODE_ENV === "development") ? `http://localhost:3000` : "";
export const wsUrl = (
  (process.env.NODE_ENV === "development" || !globalThis["window"])
  ? `ws://localhost:3000`
  : `${window.location.protocol === "http:" ? "ws" : "wss"}://${window.location.host}`
);
```

生产环境 `apiUrl` 是**空串**，全部请求走同源相对路径（`apiUrl + route`）⇒ **打包产物不携带任何主机信息**，同一份前端可挂到任意域名/端口，这是"服务端模组内嵌 Web 服务"形态的必需项。`wsUrl` 从 `window.location.protocol` 推导 `ws`/`wss`，天然跟随 HTTPS，不会出现"HTTPS 页面连 `ws://`"被拦。`!globalThis["window"]` 也判为 dev 是给 SSR/预渲染留的兜底（代价是 SSR 下硬编码 localhost）。

### 2.2 `APIResponse<T>`：交叉类型信封（`types.ts:7-10`）

```ts
export type APIResponse<T> = { code: number; error: string } & T;
```

**这是全前端最重要的类型。** 它是交叉而非包装，所以调用方写 `const res = await sendGetRequest<SavesResponse>("/api/saves"); setSaves(res.saves);`（`app/panel/saves/page.tsx:38-39`）——少一层 `.data` 解包，全仓约 78 个 `toastError` 调用点都建立在这个简洁性上；每个端点 interface 只管业务字段，`code`/`error` 由信封统一提供。失败路径由 axios 抛异常（非 2xx）处理，所以 `error` 字段实际只在"HTTP 200 但业务失败"这类自定义语义下有用。代价：**`code`/`error` 与业务字段同层平铺**，若某端点自己也想叫 `code`，交叉会静默冲突。作为只读契约够用，作为会演进的信封偏脆。

### 2.3 `toastError`：状态码 → 文案的集中映射（`api.ts:23-36`）

```ts
if(e.status === 401 && window.location.pathname !== "/login" && window.location.pathname !== "/login/") {
  window.location.href = "/login"; return;
}
for(const [status, description] of descriptions) {
  if(e.status === status) { toast.error(message, { description }); return; }
}
toast.error(message, { description: e.message });
```

- **401 是全局特殊分支**，优先于传入映射，并做"已在登录页就不再跳"判断，避免登录页自身请求失败造成跳转循环——整层唯一的全局副作用。
- **映射由调用方给**，每个页面精确表达"这个接口的 400 是什么意思"：存档列表 `[[400, $("common.error.400")], [401, $("common.error.401")]]`（`saves/page.tsx:41-44`），游戏规则只关心 401（`gamerules/page.tsx:80-82`）。文案键约定为 `<功能>.error.<状态码>`（如 `saves.upload.error.409`、`logs.action.upload.error.502`），通用码集中在 `common.error.*`。
- **兜底是 `e.message`**（axios 英文网络错误），唯一没有本地化的分支。

这个"两层文案"模型（一句用户可读主语 + 一条按状态码细分的描述）比"每个 catch 塞一个字符串"可维护得多，也让同一主语能被多个状态码复用。

### 2.4 `Content-Type: text/plain`：真实原因与一个需要澄清的误解

四个写请求都显式声明 `text/plain`（`api.ts:67`、`:85`、`:102`、`:119`），body 处理一致：`typeof body === "string" ? body : JSON.stringify(body)`（`:56-60`）。字符串原样发、对象 JSON 序列化。这对上是合理的，因为后端两种用法都有：**原文端点直接 `ctx.body()`**（server.properties / motd / 启动命令 / 终端命令 / 行为准则正文，`core/.../ControlController.java:38,89,210,269,297`、`InfoController.java:69`、`TerminalController.java:22`），**JSON 端点用 `ctx.bodyAsClass(...)`**（`GamerulesController.java:37`、`SavesController.java:218`、`TasksController.java:46,65`、`MapController.java:103,169`、`OidcController.java:138,201,225`、`WhitelistController.java:43`）。`text/plain` 对两者都兼容，前端封装因此只需一套 header。

**但"CSRF 防护"这个说法需要纠正**（避免照着错误理由去抄）：

1. `text/plain` 是 CORS **安全列表**的 Content-Type，实际效果是**跨域 POST 变成"简单请求"，跳过 OPTIONS 预检**。开发期前端 `:3001`、后端 `:3000` 时省一次往返。
2. 它**不是 CSRF 防护**，恰恰相反：能发简单请求意味着跨站表单也能发出这个 POST。真正的防线在服务端——会话 cookie 设为 `SameSite.LAX`（`core/.../web/JwtManager.java:121-123`），跨站请求根本不带该 cookie。Java 侧全文无 Origin/Referer 校验（grep 零命中）。
3. `PATCH`/`DELETE` **不是** CORS 安全列表方法，无论 Content-Type 都必然触发预检。所以"避免预检"只对 POST 成立，`:102`、`:119` 的 `text/plain` 更多是与 POST 保持一致。
4. "用 `application/json` 强制预检"本身也不是可靠 CSRF 防线（简单请求仍可致副作用），**不要**当设计依据。

结论：`text/plain` 是 **CORS 预检优化 + 原文端点语义统一**的产物，不是 CSRF 方案；照抄时请配套 `SameSite=Lax` 或显式同源校验。

### 2.5 其余细节

- **`withCredentials` 默认 true**（`:38`、`:46`、`:55`、`:72`、`:90`、`:107`、`:124`）。鉴权是 cookie（`BeforeController.java:91` 读 `ctx.cookie("token")`），跨域 dev 下必须显式开启；做成"可关的默认开启"让少数不需要 cookie 的调用能显式关闭。
- **Blob 端点**：`sendGetBlobRequest`（`:46-53`）与 `sendPostBlobRequest`（`:72-88`）用 `responseType: "blob"` 绕过信封返回裸 `Blob`。使用者是地图瓦片（`lib/map/tile-fetch.ts:26-30`、`:41-45`，注释写明"OTILES 二进制"交给 wasm 解码）。**这与 `APIResponse` 不同构**：失败时 error body 也是 Blob，`toastError` 的 `e.message` 更没信息量。tile-fetch 的做法是"全部失败模式 `return null`，worker 静默跳过"（`:17-19,31-33,46-48`），对可重试的细粒度资源是正确的取舍。
- **上传进度**：`uploadFile` 用 `FormData` + `multipart/form-data` + `onUploadProgress: (e) => onProgress(e.progress ?? 0)`（`:124-136`），进度为 0–1 浮点。用于存档（`saves/page.tsx:60`）、插件（`plugins/page.tsx:148`）、扩展（`extensions.tsx:214`）；图标与登录头图不传 `onProgress`（`favicon-dialog.tsx:37`、`login-banner-dialog.tsx:34`）。
- **业务语义函数同文件**：`checkAuth`（`:138-145`，异常吞成 `false`）、`logout`（`:147-154`）、`restartServer`（`:156-167`）、`stopServer`（`:169-172`）。把"状态码 → 跳转"的知识放在 API 层而非散在组件里是值得学的边界划分——`restartServer` 的 `if(e.status === 406) window.location.href = "/panel/settings?tab=server&openLaunchCommand"` 就是典型的"错误即导航"，比弹一句"请先配置启动命令"让用户自己找路友好。

---

## 3. `lib/emitter.ts` 与全局刷新模式

### 3.1 三行的实现，两个事件的纪律（`emitter.ts:1-3`）

```ts
import EventEmitter from "events";
export const emitter = new EventEmitter();
```

直接用 Node `events`（Vite 打包成浏览器可用版），进程内单例。**只有两个事件名**，这是它没变成意大利面的唯一原因：**`refresh-data`**（任何写操作成功后广播"数据脏了，谁在看谁自己重取"），**`loading-done`**（首帧就绪后让顶部进度条收敛，`components/loading-bar.tsx:59-65`）。发送方是 mutator（`plugins/plugin-utils.ts:13,29`、`saves/save-card.tsx:46,56`、`players/player-sheet.tsx:100,298,319,333,353`、`dashboard/motd-editor.tsx:56`、`extensions-utils.ts:12,31` 等 30+ 处）。

它解决的问题：没有它，"删除一个存档"要么把 `fetchServerWorlds` 层层往下传（穿透 3–4 层），要么把列表状态提到全局 context。`save-card.tsx` 不需要知道 `saves/page.tsx` 存在，喊一声即可。对"面板级 mutator + 页面级 reader"这种拓扑，这是单位成本最低的方案。它还顺带统一了"刷新列表"的通道：`players/page.tsx:142` 在 `refresh-data` 时走 `client.send("fetch", null)` 而非 HTTP。

### 3.2 但清理方式是错的，必须改

多数订阅点是：`emitter.on("refresh-data", () => fetchPlayerList()); return () => { emitter.removeAllListeners("refresh-data"); };`（`players/page.tsx:93-100`；同型见 `logs/page.tsx:63-66`、`saves/page.tsx:78-81`、`plugins/page.tsx:170-173`、`paper-config/page.tsx:99-102`、`code-of-conduct/page.tsx:134-137`、`banned-ips-dialog.tsx:68-71`、`inventory/page.tsx:128-132`、`players/page.tsx:142-146`）。

**`removeAllListeners("refresh-data")` 会摘掉所有组件注册的监听器，而不只是自己的。** 任何"父子同时订阅"的形态下，先卸载的一方会把另一方一起干掉，之后"刷新不生效"且极难定位。正确写法项目里已有样板：

```ts
emitter.on("refresh-data", fetchMapFeatureEnabled);
return () => { emitter.off("refresh-data", fetchMapFeatureEnabled); };
```
（`settings/page.tsx:169-172`；`settings/extensions.tsx:248-251` 同；`loading-bar.tsx:59-65` 同）

`tasks/page.tsx:51` 是同一 bug 的变体——`off` 里传了**新的匿名函数**，等于没注销。所以这是"规则未被执行"而非"不知道怎么做"。**BlockNexus 若采用该模式，请把"匿名 handler + removeAllListeners"列为禁止项。**

另一个结构性限制：`emitter` 是模块级单例，SSR 阶段共享（跨请求串扰风险）；且 `EventEmitter` 的 `on` 接受任意 string，拼错事件名（`"refresh_data"`）静默失效。加一个 `type EmitterEvents = "refresh-data" | "loading-done"` 的薄封装即可解决后者。

### 3.3 `lib/update.ts`：自更新检查的节流与预发布通道

- **节流靠 localStorage 时间戳**（`storageKey = "opanel.update"`、`checkInterval = 12 * 60 * 60 * 1000`，`:8-9`）：`doAutoUpdateCheck` 只在距上次超过 12h 时才真正请求 GitHub（`:50-62`），用户一天开 20 次面板也只打一次 API。
- **失败也写回时间戳**：`catch` 写入 `{ lastChecked: now, hasNewUpdate: currentInfo.hasNewUpdate }`（`:58-60`），保留上次结论而非清零，避免"GitHub 偶发失败 → 横幅消失 → 用户以为没更新"。
- **前向兼容读取**：`if(info.hasNewUpdate === undefined) info.hasNewUpdate = false;` 并写回（`:35-38`），与 `settings.ts` 的合并策略同源。
- **存储不可用即降级**：`getLocalStorage()` 包在 `try` 里，失败返回 `defaultUpdateCheckInfo`（`:20-26`）。
- **预发布通道 + semver 比较**（`:64-86`）：读 `system.preview-channel`；非预览通道跳过 `prerelease` 或名字带 rc 的版本；`release.tag_name.replace(/(?<!-)rc/g, "-rc")` 先把 `2.2.5rc1` 规范成 `2.2.5-rc1` 才能被 `semver.compare` 正确比较（`:72`）；返回第一个大于当前版本者（依赖 GitHub 的时间倒序）。`version` 来自 `import.meta.env.VITE_OPANEL_VERSION`（`lib/global.ts`），构建期注入；`isPreviewVersion(version)` 作为 `system.preview-channel` 的默认值（`settings.ts:81`），使"预览版构建默认开预览通道"零配置成立。

---

## 4. `lib/i18n.ts` + `lang/` —— i18n 架构

### 4.1 键名规范（`lang/README.md:9-19`）

`<page>.[...<component>].<part>`：`<page>` 是页面名（独立组件可省），`[...<component>]` 可自上而下逐级嵌套，`<part>` 是部件名（`placeholder`/`description`/`tooltip`）；浏览器标签页标题的键**只用页面名**；错误提示的 component 位固定用 `error`；全部 kebab-case。

关键：这套规范的实际威力在**递归解析**上——因为它保证"子键一定以父键 + `.` 开头"，`localizeRich` 才敢用"截掉最后一段"推导父键去解析引用（`:18`、`:65`）。规范不是风格偏好，而是算法依赖。

### 4.2 注册方式：全部静态导入 + 与 Minecraft 语言表合并（`lang/index.ts:1-28`）

```ts
import minecraftZhCN from "@/assets/minecraft/zh_cn.json";
export const languages: Record<string, Translations> = {
  "zh-cn": { ...zhCN, ...minecraftZhCN }, /* ... 共 8 种语言 */
};
```

两点必须说清：① **没有懒加载**——8 个语言包 + 8 个 MC 语言表全部顶部静态导入、全部进同一 bundle。这是刻意取舍：面板是内网/单机工具，体积不是瓶颈，而"同步取词"（`$()` 是纯同步函数，`i18n.ts:13-15`）换来零异步状态、零 loading 态、零水合不一致。若要改懒加载，`$()` 就得变 async 或引入初始化门闩，**所有调用点都要改，这不是能半途改的决定**。② **MC 物品/方块名与 UI 文案合并成一张扁平表**，键名沿用 MC 自己的 `item.minecraft.*`/`block.minecraft.*` 命名空间，好处是 `$mc` 直接查、无需第二套逻辑，代价是 `TranslationKey` 被撑大。

切换语言靠**整页刷新**：写入设置后立刻 `window.location.reload()`（`settings/page.tsx:305-307`）。选择器显示文本取语言包里的 `$lang` 键（`:314`），所以新增语言只需在 JSON 里写 `"$lang": "..."`（`zh-cn.json:2` 是 `"简体中文"`），无需额外显示名映射表。

### 4.3 `TranslationKey` 与缺键回退（`lang/index.ts:30-33`）

```ts
export type TranslationKey = keyof (typeof zhCN & typeof minecraftZhCN);
export type Translations = Record<TranslationKey, string>;
export type LanguageCode = keyof typeof languages;
```

- **`TranslationKey` 从 zh-cn 推导**，而 `Translations` 要求**每个键在每种语言里都存在**（`Record<...>`，非可选），因此 `languages` 的构建（`:19-28`）在编译期检查所有语言包的键集完整性——漏翻一个键，`tsc --noEmit` 就报错。**用类型系统强制翻译完整性，零运行时成本**。代价：`zh-cn.json` 成为事实上的源语言。
- **缺键回退就是返回键名本身**：`languages[...][id] || id`（`i18n.ts:14`）。这比返回空串好得多——界面出现 `terminal.ws.error` 一眼就知道缺哪个键。这也是 `$mc` 能用"返回值是否等于键名"判断命中的前提（`i18n.ts:91-92`）。

### 4.4 `$()` / `localize` / `localizeRich`

```ts
export const $ = (id: TranslationKey, ...args: any[]) => (
  args.length === 0 ? localize(id) : localizeRich(id, ...args)
);
```
（`i18n.ts:78-82`）

**`$` 是"看参数个数决定返回类型"的函数**：无参 → 纯字符串，可直接放进 `title=`、`toast.error()`；有参 → HTML 字符串，必须走 `dangerouslySetInnerHTML`。组件封装的对应物是 `components/i18n-text.tsx:6-28`（`rich` 布尔显式区分两条路径，并用 `memo` + 自定义比较器**故意不比 `args`**，`:29-33`，避免内联数组每次渲染都触发重渲）。

**`{0}` 模板参数**（`:26-35`）：定长 3 字符子串匹配 `/^{\d}$/`，按 `parseInt` 取 `args`；参数可以是字符串，也可以是 **ReactNode**（用 `renderToStaticMarkup` 转 HTML 串）。这让"把链接/kbd 嵌进译文"成为可能，而且**语序由译文决定**——中英文可各自决定 `{0}` 出现在句子哪里（英文 `login.form.oidc-description`，中文 `saves.progress.label`）。实例：`$("terminal.shortcut.form.name.max-length", SHORTCUT_NAME_MAX_LENGTH.toString())`（`terminal/create-shortcut-dialog.tsx:38`）；ReactNode 实例见 `about/thanks/page.tsx:79-83`、`gamerules/page.tsx:257-268`。注意它是**定长子串匹配**，所以只支持 `{0}`…`{9}`，`{10}` 不会被解析。

**`@b{...}` 富文本引用语法**（`:7-11`、`:37-70`）：`@` 后可跟任意多个样式字母（`b`/`i`/`s`，`s` 映射到 `span`），然后 `{ref}` 里放**同级引用键的最后一段**。实例是登录页 `"login.reset.content.line1": "…可通过@b{action1}并@b{action2}来进行密钥重置。"`，`ref` 通过 `parentId` 解析：`const parentId = id.replace(/\.[^.]*$/, "")`（`:18`）把 `login.reset.content.line1` 变成 `login.reset.content`，于是 `@b{action1}` → `login.reset.content.action1`。价值在**可翻译的结构**：整句是自由重排的译文，两个富文本片段自身也是可翻译键（各带加粗），译者不碰 HTML 也不会写错标签顺序。

三个粗糙点：① 结束标签靠字符串前插维护（`endTags = "</"+tagName+">" + endTags`），`@bi{...}` 能正确产出 `<b><i>…</i></b>` 但样式字母顺序被反转；② **两处 `while(str[i] !== "{")` / `!== "}"` 都没有边界检查**（`:46`、`:61`）——译文手滑少写一个花括号，`i` 越过 `str.length`（`str[i]` 变 `undefined`，永不等）→ **页面挂死**，这是最现实的风险；③ 转义只有 `parsed.replaceAll("\n", "<br>")`（`:73`），而**字符串参数被原样拼进 HTML**（`:28-31`，只有 ReactNode 走 `renderToStaticMarkup`）。因此 `$("plugins.hint", folderPath)` 经 `<Text>` 渲染时，服务端返回的字符串等于可注入 HTML。语言包可信，**参数不一定**（玩家名来自玩家）。应确立约定：带字符串参数的 `$()` 只用于纯文本渲染位置，或参数必须可信。

### 4.5 `$mc`：Minecraft 物品名助手（`i18n.ts:84-93`）

```ts
if(!itemId.startsWith("minecraft:")) return itemId;
const itemKey = `item.minecraft.${itemId.replace("minecraft:", "")}` as TranslationKey;
const blockKey = `block.minecraft.${itemId.replace("minecraft:", "")}` as TranslationKey;
let text = localize(itemKey);
if(text === itemKey) text = localize(blockKey);
if(text === blockKey) text = itemId;
```

三层回退：`item.minecraft.X` → `block.minecraft.X` → 原 id。第三层是必需的不是可选的：**模组物品不在原版语言表里**，必须原样显示 `modid:item`。判空**靠"返回值是否等于键名"**，直接依赖 4.3 的缺键约定——若改成返回空串这个函数就废了（两个约定互相支撑的典型）。两次 `as TranslationKey` 断言因为键是运行时拼的。用于 `inventory-item-tooltip.tsx:130`（无解析名时回退物品名）与 `item-explorer.tsx:32`（搜索纳入本地化名）。

### 4.6 语言来源与语言包形态

"当前语言"就是一条普通设置：读取入口始终是 `getSettings("system.language")`（`i18n.ts:14`），无独立状态机、无 cookie、无 `Accept-Language` 协商；`app/browser-init.tsx:16-28` 按该设置分支处理各语言特化。

`lang/zh-cn.json` 共 802 行、约 770 键，**扁平 `string → string` 对象、无嵌套**。首个键固定是 `$lang`（本语言自称），其余按页面分组并**用空行分隔分组**（`AGENTS.md` 要求"同分类内按逻辑顺序、不同分类间空一行、各语言文件结构一致"——这个"结构一致"直接服务于 4.3 的键集类型检查）。抽样：

```json
{
  "$lang": "简体中文",

  "common.error.400": "请求参数错误",
  "terminal.title": "后台",
  "terminal.ws.error": "无法连接到终端WebSocket",
  "saves.progress.label": "正在上传 {0}...",
  "table.status": "第 {0} 页 / 共 {1} 页",
  "login.reset.content.line1": "…可通过@b{action1}并@b{action2}来进行密钥重置。",
  "settings.reset": "恢复默认设置"
}
```

分组顺序：`$lang` → `common.*`/`dialog.*`/`table.*`/`online-badge.*`/`text-copy.*`（跨页通用）→ `restart-alert.*` → `sidebar.*`/`nav.*` → `about.*`/`login.*` → 各功能页（`dashboard.*`…`extensions.*`）→ `settings.*`。MC 表合并后 `item.minecraft.*`/`block.minecraft.*` 也在同一张扁平表里。

---

## 5. `lib/settings.ts` —— 类型化 localStorage 设置仓库

### 5.1 一个联合类型充当 schema（`settings.ts:16-49`）

四个设计点：

1. **键名即命名空间**，`.` 分隔，与 i18n 同规矩（`terminal.*`、`monaco.*`、`state.*`），"这个设置属于哪个页面"一眼可见。
2. **`state.*` 与配置分离**：`state.sidebar.open`、`state.players.tab`、`state.terminal.history`、`state.paper-config.current-editing` 都是**界面瞬时状态**，与真正的用户偏好（字体大小、日志级别）同库但前缀区分。于是关闭面板再打开，用户回到"离开时的样子"而非"每次从第一个 tab 开始"——成本几乎为零。
3. **`?: never` 的用法**（`:34-42`）：`"server.launch-command"?: never` 表示该键可出现但值只能是 `undefined`，用于表达"这些服务端配置项已迁移到服务端"。误用 `changeSettings("server.launch-command", ...)` 会在**编译期报错**，同时不影响合并循环遍历这些键。用类型记录历史迁移的轻量做法。
4. **值类型就是真实类型**：`ConsoleLogLevel[]`（`:25`）、`CommandShortcut[]`（`:30`）、`RenderSettings`（`:17`）、`ConfigFile`（`:48`）、`LanguageCode`（`:37`）。因此 `getSettings("terminal.log-levels")` 返回数组可直接 `.includes("INFO")`（`terminal/page.tsx:68`），无需 `JSON.parse` + 断言。跨模块 `import type { ConfigFile } from "@/app/panel/paper-config/page"`（`:3`）说明这层不怕依赖业务模块的**类型**——编译后不留引用。

### 5.2 读取时的前向兼容合并（`settings.ts:101-123`）—— 本节最值得抄的 20 行

```ts
function getSettingsStorage(): SettingsStorageType {
  let storage: Storage;
  try { storage = getLocalStorage(); } catch { return defaultSettings; }

  const settingsStr = storage.getItem(storageKey);
  if(!settingsStr) { resetSettings(); return defaultSettings; }

  const settings = JSON.parse(settingsStr ?? "{}");
  for(const key in defaultSettings) {
    if(settings[key] === undefined) { settings[key] = defaultSettings[key as keyof SettingsStorageType]; }
  }
  storage.setItem(storageKey, JSON.stringify(settings));
  return settings;
}
```

- **缺失键在读取时补齐并立刻写回**（`:116-121`）：新版本引入新设置不需要任何迁移代码，老用户第一次打开就被补上默认值，且这次读取后 localStorage 里已是完整对象。这是"读时迁移"，比"写时迁移 + 版本号"简单得多，也不会有"版本号忘了加"。
- **未知键被保留**：循环是"遍历 `defaultSettings` 补齐"，不是"用默认值重建"，所以用户机器上多出来的键（降级安装、调试残留）不会被抹掉——"用户回滚旧版本再升级回来时设置还在"是必需的。
- **存储不可用即降级**（`:103-107`）：`getLocalStorage()` 内部处理禁用存储/隐私模式异常，此处只返回内存默认值，整个函数**永不抛异常**。
- **代价：每次读取都全量 `JSON.parse` + 合并 + `setItem`**，且**无内存缓存**。`getSettings` 在渲染期被高频调用（`terminal-viewer.tsx:24,77,81,84,90,99` 每个 `Log` 渲染都读好几次），渲染 1000 行日志会执行数千次同步 `JSON.parse` + `setItem`。实际没暴露问题（对象小、浏览器有写合并），但**照抄时应加模块级缓存 + `storage` 事件失效**。

### 5.3 读写 API（`settings.ts:125-137`）

```ts
export function getSettings<K extends keyof SettingsStorageType>(key: K): SettingsStorageType[K] {
  return getSettingsStorage()[key];
}
export function changeSettings<K extends keyof SettingsStorageType>(key: K, value: SettingsStorageType[K]) {
  const settings = getSettingsStorage(); settings[key] = value;
  getLocalStorage().setItem(storageKey, JSON.stringify(settings));
}
```

- **泛型把键与值绑死**：`changeSettings("terminal.font-size", "12")`、`changeSettings("terminal.log-levels", "INFO")` 都编译报错，这是散落 `localStorage.setItem` 无法提供的。
- **`changeSettings` 是读—改—写三步**（整个设置是一个 JSON 对象），因此是**原子性最差的写法**：两个标签页并发改不同键会互相覆盖。
- **写设置 ≠ 生效**。`system.language` 改完必须 `window.location.reload()`（`settings/page.tsx:305-307`）；`terminal.log-levels` 则由组件 `useState` 持有再 `useEffect` 写回（`terminal/page.tsx:68-70` 读、`:211-213` 写），即**内存 UI 状态是权威、存储只是持久化**。方向性很重要：不做"设置变化 → 广播 → 组件响应"，就没有跨组件同步（开两个标签页时不实时联动是已知缺口）。
- `resetSettings()`（`:135-137`）把 `defaultSettings` **同一个对象引用**整体写回，将来若有调用方修改返回对象会污染默认值；当前调用点都没改，属"知道就好"。
- **`getSettings` 在模块顶层被调用**：`monacoSettingsOptions`（`:90-99`）与 `terminal-viewer.tsx:15` 的 `MAX_LOG_LINES` 在模块加载时读一次，所以这些值**不受 `changeSettings` 影响**，改完必须刷新。

### 5.4 为什么优于散落的 localStorage

| 维度 | 散落调用 | `settings.ts` |
|---|---|---|
| 键名 | 字符串字面量，拼错静默失效 | 联合类型，拼错编译报错 |
| 值类型 | 手动 `JSON.parse` + 断言 | 泛型绑定，自动是目标类型 |
| 新增键 | 每个读取点写 `?? 默认值` | 只在 `defaultSettings` 写一次，读时自动补齐 |
| 命名空间 | 无处表达，易撞键 | `.` 分隔前缀，与 i18n 同规矩 |
| 存储不可用 | 每处各自 try/catch | 一处兜底，永不抛 |
| 迁移 | 需版本号 + 手写分支 | 缺键补默认值即迁移，无需版本号 |
| 审计"有多少设置" | 全局搜 `localStorage` | 读一次 `defaultSettings` |

短板只有两处：5.2 的**无缓存**（加缓存即可），与 5.3 的**无跨组件广播**（`emitter` 已在，加一个 `settings-changed` 事件即可——他们没做，说明当前没这个需求）。

---

## 6. `lib/types.ts` —— API 契约建模

### 6.1 结构（341 行，分三段，顺序本身就是文档）

1. **通用类型工具**（`:4-5`）：`ArrayItem<A> = A extends (infer T)[] ? T : never`（从数组取元素，用于 `ArrayItem<GithubReleaseResponse>`，`update.ts:66`）与 `SetState<T> = React.Dispatch<React.SetStateAction<T>>`（传 setter 时少写一坨）。
2. **领域枚举与实体**（`:12-199`）：`ServerType`、`GameMode`、`Difficulty`、`Dimension`、`InventoryType`、`AvatarProvider`、`SkinProvider` 等，**枚举字符串值与后端/游戏内标识一致**（`GameMode.SURVIVAL = "survival"`，`:16`），JSON 往返无需映射表。`MonitorData`（`:34-44`）是 WS 推送帧、`MonitorHistoryPoint`（`:45-53`）是历史接口——**实时与历史分成两个类型**，因为分辨率/聚合语义不同。
3. **端点响应表**（`:201-341`）：每个 interface 头顶一行 JSDoc 写后端路由。

### 6.2 JSDoc 写路由：把契约文档贴在类型上

```ts
/** `/api/version` */
export interface VersionResponse { serverType: ServerType; version: string; map: boolean; mcdr: boolean; ... }
/** `/api/info` */
export interface InfoResponse { favicon: string | null; motd: string /* base64 */; ... }
/** `/api/saves/{saveName}` */
export interface DownloadSaveResponse { download: string }
```
（`types.ts:201-209`、`:211-237`、`:272-275`）

路由路径直接写进 JSDoc（`:201`、`:211`、`:239`、`:244`、`:249`、`:257`、`:262`、`:267`、`:272`、`:277`、`:283`、`:288`、`:293`、`:299`、`:305`、`:310`、`:315`、`:320`、`:328`），"这个 interface 对应哪个接口"在 IDE 悬浮提示里就能看到，不必离开文件去翻 Java 控制器；路径参数用 `{saveName}` 占位，贴近 OpenAPI 习惯。唯一例外是 `GithubReleaseResponse`，标的是完整外部 URL（`:333`）——同一约定同时服务内部路由与外部 API。命名统一 `*Response`，全部是响应类型，请求体类型留在调用点或由 zod 推导（`gamerules/page.tsx:88` 的 `z.infer<typeof formSchema>`）。

### 6.3 base64 约定：为什么把字符串编码后再跨边界

15 处固定注释（`:63`、`:87`、`:134`、`:137`、`:151`、`:165`、`:214`、`:215`、`:241`、`:246`、`:251`、`:252`、`:253`、`:254`）：`Save.displayName`、`Player.banReason`、`Plugin.fileName`/`description`、`Extension.description`、`ScheduledTask.name`、`InfoResponse.motd`/`realtimeMotd`、`ServerPropertiesResponse.properties`、`CodeOfConductResponse.codeOfConducts`、`PaperServerConfigResponse.bukkit`/`spigot`/`paper`/`leaves`。

观察哪些被编码能反推判定标准：

| 被 base64 编码 | 不编码 |
|---|---|
| `Save.displayName` / `Player.banReason` / `ScheduledTask.name` | `Player.uuid` / `gamemode` / `ItemStack.id` |
| `Plugin.fileName` / `description` / `Extension.*` | `Plugin.version` / `size` / `author` |
| `InfoResponse.motd` / `realtimeMotd` | `port` / `maxPlayerCount` / `system.*` |
| `ServerPropertiesResponse.properties`（整个文件正文） | `GamerulesResponse.gamerules`（结构化对象） |
| `CodeOfConductResponse.codeOfConducts`（正文 map） | `SavesResponse.saves`（数组） |

规律：**被编码的是"从磁盘/游戏内取出的、内容与编码不可控的用户数据或文件正文"；不编码的是"面板自己生成的结构化值"。**

**为什么必须这样——四个理由：**

1. **文件与游戏内字符串的编码不一定是 UTF-8**。`server.properties`、`paper-global.yml`、行为准则 `.txt` 都是用户在服务端目录下用任意编辑器（记事本、旧插件生成的 GBK 文件）写的，按某种 `Charset` 读出可能已产生替换字符（U+FFFD），甚至字节序列不合法。直接塞进 JSON 字符串会在序列化/反序列化某一层被再改写或截断。base64 把"文本"降级成"字节的 ASCII 表示"，**从取出那刻起不再有编码解释**，直到前端 `base64ToString` 才用明确 UTF-8 解码（`lib/utils.ts:102-106`，走 `TextDecoder`）。
2. **避开控制字符与特殊字符**。MOTD 带 `§`/`\n`/制表符，插件 `description` 常带换行与 emoji，`banReason` 可能是玩家输入的任意内容。JSON 能表示，但一旦经过任何不严格转义的中间层（日志、代理、模板拼接）就会出现 `\u0000` 被截断、`\n` 折行之类问题。base64 字母表是 `[A-Za-z0-9+/=]`，**在 JSON、URL、HTML 属性、日志里都是绝对安全的一等公民**。
3. **把"解不出来的字节"变成可诊断的失败**而非静默乱码：前端解码集中在 `base64ToString`，失败抛在明确一处，而不是界面上某处显示 `æµ‹è¯•`。这也解释了为什么约定**必须在类型上用注释标出**——否则无法知道某个 `string` 是"UTF-8 文本"还是"base64 的 UTF-8 文本"。
4. **对齐 `Record<string, string>` 这类字段名不可控的场景**：`codeOfConducts`（语言代码 → 文件正文）与 `properties`（整篇配置）都没有结构、大小不定，只适合当不透明载荷，base64 恰好表达了"这是不透明载荷"的语义。

**代价与注意点：**

- **体积膨胀约 33%**（3 字节 → 4 字符）。对 `properties`（几 KB）与 MOTD 无所谓；大文件走的是 Blob 通道（见 2.5），不受影响。
- **不能直接搜索**：前端必须**先解码**，`plugins/page.tsx:85,94` 在过滤时就地 `base64ToString(fileName).toLowerCase()`；列表大时应缓存解码结果。
- **类型系统拦不住忘记解码**：`name: string // base64` 只是行尾注释，`tsc` 无法区分"已解码字符串"与"base64 字符串"。更严格写法是 `type Base64 = string & { __brand: "base64" }`，让"必须解码才能当文本用"成为编译期约束。**OPanel 没做这一步，是该约定最大的工程弱点**：15 个字段全靠注释和记性，而 `base64ToString` 在前端被调用约 25 次（`saves/save-sheet.tsx:60`、`plugins/plugin-dialog.tsx:48,88`、`tasks/task-item.tsx:66`、`dashboard/info-card.tsx:53,199`、`players/columns.tsx:261`…），漏一处界面就会显示 `5rWL6K+V`。
- **服务端是同一对函数**：`Utils.stringToBase64`/`base64ToString`（`core/.../utils/Utils.java:50-56`）都显式 `StandardCharsets.UTF_8`——该约定前后端成对实现，**不是单侧展示层 hack**，这是它成立的前提。

**给 BlockNexus 的取舍**：把"用户可控 / 磁盘正文 / 编码不确定"编码，"面板生成的 id、枚举、数值、结构"保持明文，是核心。若 BlockNexus 的面板↔agent 链路已明确 UTF-8，这条约定的价值主要在**第 2、4 点**（控制字符与不透明载荷）而非第 1 点。**只对真正的文件正文与用户输入字段使用**，不要扩散到所有字符串——否则每个字段都要解码，收益归零。

---

## 7. `package.json` + `.oxlintrc.json`

### 7.1 脚本（`package.json:6-19`）

`dev` = `npm run prelaunch && vite dev --port 3001`；`build` = `node scripts/build.js`；`start` = `vinext start`；`test` = `vitest run`；`lint` = `oxlint .`；`typecheck` = `tsc --noEmit`；`prelaunch[:force]` = `node scripts/prelaunch [-f]`；`wasm:test|build|build:force`（Rust → wasm）。

- **`dev` 前挂 `prelaunch`**：启动前生成/更新素材（MC 纹理、物品名，配 `scripts/generate-minecraft-assets.js`）。把生成步骤挂在 `dev` 前置而非让开发者手动跑，是"构建产物不提交"能落地的前提。
- **dev 端口硬编码 3001**，与后端 CORS 白名单 `http://localhost:3001`（backend `WebServer.java:319-339`）及 `api.ts:6-10` 的 `http://localhost:3000` **三者必须一致**——跨仓库约定，改一处要改三处。
- **`build` 走脚本而非框架 CLI**，因为产物要落到各服务端模块的 `build/frontend`，路径由 Gradle 属性（`frontend_env_*`）注入。
- **lint/typecheck 与 build 分离**（`AGENTS.md`："改完前端代码跑 Oxlint 和 TS 类型检查即可，不需要全量构建"）：秒级检查 vs 分钟级构建的刻意分工。
- `wasm:build` 需显式 `--run` 才真正执行（默认 dry-run 风格的安全设计）。

### 7.2 依赖（47 deps + 28 devDeps）

- **框架/运行时**：`react`/`react-dom` `^19.2.8`、`next-themes`、`vinext` `^1.0.1` + `react-server-dom-webpack`（自研 Next 兼容 RSC 运行时）。构建实际用 Vite（devDeps 有 `@vitejs/plugin-react`、`@vitejs/plugin-rsc`）。
- **UI 基元**：12 个单个 `@radix-ui/react-*` + `radix-ui` 伞包、Shadcn 三件套（`class-variance-authority`/`clsx`/`tailwind-merge`）、`lucide-react`（**锁死精确版本 `0.577.0`，无 `^`**——图标库小版本常改路径/形状，锁死明智）、`recharts`、`sonner`。
- **表格/表单/校验**：`@tanstack/react-table`、`react-hook-form` + `@hookform/resolvers` + `zod`。
- **编辑器**：`monaco-editor` + `@monaco-editor/react` + `monaco-yaml`。
- **MC 领域**：`minecraft-textures`、`minecraft-skin-viewer`、`properties-file`、`locale-codes`（配 `utils.ts:114-117` 的 `validateLocaleCode`）。
- **工具**：`axios`、`entities`（ANSI 转义）、`date-format-parse`、`downloadjs`、`md5`（CRAM 登录）、`semver`、`uuid`（`v7` 当日志行 key）、`markdown-to-jsx`、`textarea-caret`。注意 `@types/downloadjs` **被放在 dependencies 而非 devDependencies**（小瑕疵）。
- **devDeps**：`oxlint` `^1.78.0`、`typescript` `^5`、`vitest` `^4.1.11` + `jsdom` + `@testing-library/{dom,jest-dom,react,user-event}`、`vite` `^8.2.0`、`tailwindcss` `^4` + `@tailwindcss/postcss` + `tailwind-scrollbar` + `tw-animate-css`、`eslint-plugin-{react,import}` 与 `@stylistic/eslint-plugin`（**作为 oxlint 的 JS 插件用**，见 7.3）、`yauzl`（zip 解包）、`wasm-pack`。**没有 `eslint` 本体**，lint 已完全迁到 oxlint。

### 7.3 `.oxlintrc.json`（144 行）

**(a) 关掉整个 correctness 类别，改白名单**（`:3-5` `"categories": { "correctness": "off" }`），配套 `overrides` 里逐条列出的 ~80 条规则（`:45-141`）。收益是**升级 oxlint 时规则集不漂移**（不会因某版本默认打开新规则而 CI 变红）；代价是新出现的高价值 correctness 规则不会自动生效，需人工跟进。对小团队长期维护，这是"稳定性优先于自动收益"的取舍。

**(b) 忽略生成物与 Shadcn 组件**（`:15-24`）：`scripts/**`、`build/**`、`dist/**`、`.next/**`、`.vinext/**`、**`components/ui/**`**、`wasm-lib/pkg/**`、`wasm-lib/target/**`。忽略 `components/ui/**` 是关键——那是 Shadcn 生成物，规则目标是业务代码风格一致。

**(c) 插件组合**（`:25-41`）：4 个内置（`typescript`、`react`、`nextjs`、`import`）+ 3 个 JS 插件（`@stylistic/eslint-plugin`，`eslint-plugin-react` 起名 `react-js`，`eslint-plugin-import` 起名 `import-js`）。**核心规则用 Rust 版跑得快，缺的规则用 JS 版兜**——oxlint 迁移期最实用的折中。

**(d) 值得注意的规则选择**：

- `no-unused-vars` 配 `{ "args": "none", "caughtErrors": "none" }`（`:48-51`）：未使用的**函数参数**与**不用的 catch 变量**都不报，但未使用的局部变量仍然报（能抓到真 bug）。回调常需占位参数、catch 常只关心"失败了"，这个宽松很实用。
- `react/react-in-jsx-scope: off`（`:68`）——React 19 / 新 JSX transform 不需要 import React。
- **`typescript/no-explicit-any: off`**（`:99`）：务实但代价明确——WS 层大面积 `any`（1.6 第 5 条）**没有任何静态信号**，只能靠 review。若要借鉴，建议**打开它并把 WS 层作为第一批整改对象**，那才是 `any` 真正造成损失的地方。
- **`react/exhaustive-deps: "warn"`**（`:95`）：warn 而非 error，因此可就地用 `// oxlint-disable-next-line react/exhaustive-deps` 压掉（`use-websocket.ts:15`、`map-canvas.tsx:222,233` 都这么干）。**这个规则被 warn 化 + 就地禁用，正是"依赖数组漏项"从"编译期可见"变成"运行时偶发"的原因**（1.6 第 10 条）；建议在 BlockNexus 把实例相关 hook 的依赖列为 error。
- `typescript/consistent-type-imports: "warn"`（`:113`）：强制 `import type`，对打包体积与循环依赖都有好处——`types.ts:1-2` 全用 `import type` 就是被它塑造的。
- **风格由 `@stylistic` 定义**（`:114-126`）：`keyword-spacing` 特别关掉了 `if`/`for`/`while`/`switch`/`with` 之后的空格（`"overrides": { "if": {"after": false}, ... }`），所以代码里全是 `if(!client) return;`；`brace-style: 1tbs` + `allowSingleLine` 允许单行写法。这两条一起定义了整个仓库的视觉风格（大量单行早返回）。
- `react-js/jsx-closing-bracket-location: after-props`（`:127`）+ `jsx-closing-tag-location: tag-aligned`——即本文引用片段的样子（`/>` 跟在最后一个 prop 后，闭合标签与开标签对齐）。
- **`import-js/order`**（`:133-140`）：分组 `["type", "builtin", "external"]`、`newlines-between: "ignore"`，所以每个文件开头是 `import type`，然后外部包，然后 `@/` 别名路径（归入 `external` 组）。成本极低、收益很高：所有文件 import 块形状一致，diff 里不出现"纯重排"噪声。
- **Next.js 规则集保留**（`:73-93`）：`no-html-link-for-pages`、`no-sync-scripts`、`inline-script-id` 等为 `error`，`google-font-*` 类为 `warn`。项目虽自研 `vinext`，但这些规则约束的是**约定**（用 `<Link>` 而非 `<a>`、脚本注入方式），对兼容运行时同样适用。

---

## 8. 对 BlockNexus 的迁移结论

**可直接借鉴：** ① `APIResponse<T>` 用交叉类型而非包装（给信封字段加保留前缀，避免与业务字段撞名）；② `toastError(e, message, [[status, desc]])` 两层文案模型 + 401 全局跳转 + "业务码即导航"（`api.ts:161-164`）；③ `TranslationKey` 从语言包推导 + `Record<TranslationKey, string>` 强制翻译完整（零运行时成本）；④ `{0}` 模板参数 + `@b{ref}` 富文本引用（**务必给两处 `while` 加边界检查，并对字符串参数做 HTML 转义**）；⑤ 设置存储的"读时合并 + 缺键补默认值 + 未知键保留"（**加模块级缓存**）；⑥ 文件正文/用户字段的 base64 约定（**改用品牌类型让漏解码成为编译错误**）；⑦ `oxlint` + 显式规则白名单 + `jsPlugins` 兜底，配上 `import-js/order` 与 `@stylistic/keyword-spacing`；⑧ 终端组件的 rAF 合帧 + 迟滞自动滚动（20px/150px + 5s）；⑨ `escapeXML` 由转换器负责 + 超链接协议白名单 + 控制字符拒绝。

**必须改造后才可借鉴：** WS 基类（`subscribe` 返回 `unsubscribe`、内部回调表、`readyState` 检查 + 发送队列、`PayloadMap` 跟随报文类型）、补齐指数退避重连 + 心跳 + `online`/`visibilitychange`、`onError` 区分服务端错误报文与传输层事件、`JSON.parse` 加 try/catch；`emitter` 禁止 `removeAllListeners(事件名)` 与匿名 handler（样板见 `settings/page.tsx:169-172`）；终端清理改 `setLogs([])`；大行数上限必须配虚拟化并把搜索过滤挪出渲染期；`Content-Type: text/plain` **不是** CSRF 防护，跨源部署请显式实现来源校验而非依赖"浏览器不会发这种请求"的假设。
