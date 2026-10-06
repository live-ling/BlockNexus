# OPanel 核心 Java 后端技术分析报告

> 分析对象：`.opanel-reference/core/src/main/java/net/opanel/`（OPanel 2.2.5，Javalin + Jetty 后端），以及 `api/`、`example-extension/`、根构建设置。
> 本文只做只读剖析，所有结论均来自实际源码，路径相对 `net/opanel/`，行号为该文件内行号。
> 阅读顺序：先 `web/` → `endpoint/` → `controller/`（这三者是所有功能进入面板的门），再看 `storage/`、`task/`、`extension/`，最后是 `monitor/`、`map/`、`terminal/`、`event/` 与构建体系。

---

## 0. 总体架构与关键事实

OPanel 是一个"跑在游戏服务端进程内的 Web 面板"：业务逻辑全部在 `core`，游戏相关能力通过 `OPanelServer` 接口被各平台模块实现（`common/OPanelServer.java:16`）。

- 进程内单例装配点在 `OPanel.java:55-91`：`Uptimer` → `ScheduledTaskManager` → `MapRenderManager` → `MonitorManager` → `ActivityManager` → 库存轮询器 → `ExtensionManager` → `OidcManager` → `WebServer`。注意 **所有子系统的构造都在 `OPanel` 构造器里完成，WebServer 最后构造，但要在平台模块调用 `setServer()` + `webServer.start()` 之后才真正对外服务**（参考 `paper/paper-1.21.9/.../Main.java:104-113`：`ServerLoadEvent` 里依次 `setServer` → `getWebServer().start()` → `getMapRenderManager().init()`）。
- 运行目录固定为进程工作目录下的 `opanel/`：`OPanel.java:29-34` 定义 `opanel/`、`opanel/.tmp`、`opanel/extensions`、`opanel/mapdata`、`opanel/INITIAL_ACCESS_KEY.txt`、`opanel/.mcdr_bridge_active`。
- 启动时清理与安全动作在 `OPanel.java:93-120`：清空 `.tmp`，**强制删除 `INITIAL_ACCESS_KEY.txt`**（`:117-119`，删不掉就直接抛异常阻止启动）。
- Web 静态资源以类路径资源方式打包（`WebServer.java:346-353`，hostedPath `/`，directory `opanel-web`），即前端产物被 `processResources` 拷进 jar 的 `opanel-web/` 目录（见 `frontend.gradle:77-87`）。

之所以重要：这是一个"零外部依赖进程"的形态——没有独立服务、没有数据库服务、没有缓存服务，所有状态都在游戏进程内和 `opanel/` 目录里。它决定了后面几乎所有设计取舍：内存环形缓冲而非 Redis、单机文件存储而非外部 DB、进程内随机 JWT 签名密钥而非持久化密钥。

---

## 1. `web/` —— 认证、鉴权与 Web 服务

### 1.1 服务器搭建与路由注册

`WebServer.java:312-378` 一次性配置 Javalin：

- `config.jsonMapper(new JavalinGson(new Gson(), false))`（`:316`）——JSON 用 Gson，不使用 Jackson；`false` 表示不输出 stream 风格。
- CORS（`:319-339`）：`/open-api/*` 用 `anyHost()`；`/api/*`、`/assets/*`、`/file/*` 只允许 `http://localhost:3001`（前端 dev server）且 `allowCredentials = true`。
- Multipart 上传落到 `opanel/.tmp`，内存阈值 10 MB（`:342-343`）。
- 静态文件托管（`:346-353`）：`hostedPath = "/"`，`skipFileFunction` 把 `/panel/ext` 与 `/panel/ext/...` 从静态解析里剔除，交给扩展页面路由。
- 全局 404 处理器（`:360`）与全局异常处理器（`:363-371`）：异常统一转成 `{code:500, error:msg}`。
- 关停钩子（`:373-377`）：关闭全部 WS endpoint，并调用 `BaseController.unregisterAllControllerInstances()` 清空控制器实例表。

平台特化的一个补丁很关键：Forge/NeoForge 下注册 `URLResourceFactory` 到 `"union"` scheme（`:302-310`），否则 Jetty 无法从 jar 内联资源解析前端静态文件。

### 1.2 CRAM 挑战—响应登录（核心机制）

先看密钥分层的命名法，源码注释里写得很明确（前端 `frontend/app/login/page.tsx:94-99`、`frontend/app/panel/settings/security-dialog.tsx:50-51`）：

| 记号 | 计算式 | 出现在哪里 |
|---|---|---|
| hashed 1 | `md5(明文 accessKey)` | 客户端本地计算；仅在"改密码"和 OIDC 绑定时的中间值 |
| hashed 2 | `md5(md5(明文))` | **服务端落盘的 `config.accessKey`**；也是客户端持有的"等效口令" |
| hashed 3 | `md5(hashed 2 + challenge)` | 登录请求体里的 `result` |
| salted hashed 3 | `md5(salt + hashed 2)` | JWT 的 `access` claim（`JwtManager.java:26,69`） |

完整流程（服务端侧）：

1. **取挑战** `GET /api/auth?id=<clientId>` → `AuthController.getCram`（`controller/api/AuthController.java:39-74`）。
   - `id` 必须匹配 `[A-Za-z0-9_-]{1,64}`（`:22`）。
   - OIDC 开启时该接口直接 403（`:42-45`）；凭据未初始化时 503（`:46-49`）。
   - 调 `CramChallengeStore.create(ip, id)`，返回 `res.cram`（`:71-73`）。
2. **挑战存储** `web/CramChallengeStore.java`：
   - 容量限制：单 IP 最多 16 个活跃挑战，全局最多 4096 个（`:10-11`），超限返回 `Retry-After` + 429（`AuthController.java:65-69`）。
   - TTL 5 分钟（`:12`），每次 `create`/`consume` 都先做惰性清理（`:18,44,51-53`）。
   - 挑战值是 `Utils.generateRandomHex(16)`，即 **16 字节 → 32 个 hex 字符**（`:35-38`）。
   - 键为 `(ip, id)` 记录（`:72`），同 IP 同 id 重复创建 → 409 Conflict（`AuthController.java:61-64`）。
3. **提交响应** `POST /api/auth`，体 `{id, result}` → `validateCram`（`AuthController.java:76-139`）：
   - `result` 必须匹配 `[0-9a-f]{32}`（`:23`）。
   - `cramChallengeStore.consume(ip, id)`（`:108`）——**consume 语义是 remove，挑战一次性使用**（`CramChallengeStore.java:47`），失败后必须重新取挑战。
   - 服务端独立计算 `realResult = md5(storedRealKey + challenge)`（`:116`），用 `MessageDigest.isEqual` 常量时间比较（`:118-121`）。
   - 成功 → `JwtManager.generateToken(storedRealKey, salt)`，写 `token` Cookie，有效期 **1 天**（`:124-135`）。

为什么这样设计：挑战放在服务端并在单次校验后作废，使得"重放抓包"和"离线爆破"都没有收益；客户端从不把 hashed 2 明文发出去（只发 hashed 3），所以即使 TLS 被剥离也无法直接复用口令；`id` 由客户端随机生成作为会话盐，避免同一 IP 并发登录互相顶掉。需要注意的落地约束是：**每次登录失败都会消耗挑战**，因此前端必须"失败后重新 GET 挑战"。

### 1.3 JWT 会话模型与登出

`web/JwtManager.java`：

- 签名密钥 `signKey` 是 **进程启动时随机生成的 HS256 密钥**（`:15`）。因此 **服务端/插件重启会令全部会话失效**——这是刻意的（无密钥落盘 = 无长期令牌泄露面）。
- Token 结构（`:33-43`）：header `kid=accessKey`（`:16-18,89`），claims = `iss=opanel`、`jti=32 hex 随机 sessionId`、`iat`、`exp`、`access=md5(salt+hashed2)`。
- 服务端另有 `ACTIVE_SESSIONS: ConcurrentHashMap<sessionId, expirationMs>` 白名单（`:22`）——JWT 本身无状态，但**校验时必须同时存在于该表**（`:93-98`），否则视为无效。这让"登出"立刻生效。
- 校验顺序（`:68-107`）：签名 → 必需字段齐全 → `kid == "accessKey"` → issuer 匹配 → `access` claim 与当前口令一致 → 会话表存在且未过期。
- 清理：`cleanupExpiredSessions` 用 `AtomicLong` + CAS 做**限频清理**（每分钟最多一次，`:109-119`），避免每次校验都全表扫描。
- 登出：`POST /api/auth/logout` 调 `revokeToken`，把 sessionId 从表里移除并删 Cookie（`AuthController.java:156-164`）。
- 改口令：`SecurityController.updateAccessKey`（`controller/api/SecurityController.java:19-44`）先 `JwtManager.revokeAllTokens()`（`:37`）再写新 key，并**立即为当前客户端签发新 token**（`:41-42`），避免自己把自己踢下线。
- Cookie 属性（`:121-129`）：`SameSite=Lax`、`HttpOnly`、`Path=/`、`Secure` 由配置 `cookieSecure` 控制。

**没有 refresh token**：会话永远 24h 固定寿命，续期等于重新走 CRAM 或 OIDC。

为什么重要：这是"无状态令牌 + 有状态吊销白名单"的组合，代价是**重启即全员掉线**、多节点无法水平扩展（白名单在进程内存里）；收益是无需持久化签名密钥、登出立即生效、改口令立即全网失效。

### 1.4 登录限流

`web/LoginAttemptTracker.java`（供 `AuthController` 使用，`AuthController.java:26,174-179`）：

- 5 次失败 → 封 10 分钟（`:7,10,54`）；失败窗口 10 分钟（`:9`）；追踪 IP 上限 10000（`:8`），超限返回 429 + `Retry-After: 60`（`:12,110-112`）。
- 惰性清理：`getActiveRecord` 检查过期即删；`cleanupExpiredIfDue` 每 60 秒最多做一次全表清理（`:72-77`）。
- 语义细节：**封禁到期后记录整体视为过期**（`:79-83`），即封禁结束等于计数清零；`recordSuccess` 直接删记录（`:59-61`）。
- 分支返回：封禁返回 403 `"The Ip is banned temporarily."`，容量满返回 429（`AuthController.java:193-200`）。

OIDC 绑定用户有**独立**的限流器（`OidcController.java:22-25`）：`MAX_VERIFY_TRIES=5`、封 10 分钟，且比较用的是 `String.equals`（`:145`）而非常量时间比较——与 CRAM 路径的处理不一致。

为什么重要：两套限流都是**内存 + IP 维度**的，天然被 `proxyHeaders` 配置影响（见 1.7）。这类限流对单实例足够，但重启即清零，且 IPv6/代理池可绕过。

### 1.5 OIDC

`web/OidcManager.java` 是纯 OIDC 客户端（nimbus-sdk 实现）：

- Discovery 缓存 6 小时（`:42,93-95`），失败后由控制器在下次请求重试（`OidcController.java:32-39`）。
- 授权 URL：`response_type=code`，scope `openid profile`，带 `state` + `nonce`（`:100-119`）；`state` → nonce 存入 `stateStore`，**TTL 10 分钟**（`:41,108`）。
- 回调（`:124-180`）：解析 → 校验 `state` 存在（`:140-143`，**remove 语义，防重放**）→ 检查 state 时间戳（`:145-147`）→ `AuthorizationCodeGrant` + `ClientSecretBasic` 换 token（`:154-156`）→ 用 `IDTokenValidator` 校验 ID Token 并**校验 nonce**（`:174`）。
- 控制器侧（`OidcController.java:65-114`）：`sub` 在 `allowedUserIds` 白名单里 → 直接签发 OPanel JWT 并跳 `/panel/dashboard`；不在白名单 → 下发 `oidc-pending-user` Cookie（600 秒）并跳 `/login?oidc-bind=true`（`:106-113`）。
- 绑定流程 `bindNewUser`（`:116-178`）：客户端提交 `accessKey`，服务端**直接与落盘的 hashed 2 做字符串比较**（`:144-145`），即请求体里传的正是 `md5(md5(明文))`（`frontend/app/login/oidc-bind-dialog.tsx:40-43`）。这与 CRAM 路径不同——**绑定流程把可复用的 hashed 2 本身放进了请求体**，因此它依赖 TLS 保护，补偿手段只有 IP 限流。成功则把 `sub` 加入白名单持久化到 `StorageKey.OIDC_CONFIG`（`:157-167`），签发 JWT。
- `redirectUri` 在 `proxyHeaders` 打开时按 `X-Forwarded-Proto` 修正 scheme（`:245-255`）。
- 错误一律跳 `/login?oidc-error=true`，不把内部错误暴露给浏览器（`:75,87,93`）。

为什么重要：白名单 + 两步绑定（先 SSO 认证、再用面板口令确认）把"SSO 账号泄露 = 面板被接管"的风险降了一级；`state`/`nonce` 双校验和 10 分钟 state TTL 是标准的 OIDC 硬化做法。

### 1.6 路由角色与鉴权中间件

`web/AuthRouteRole.java:5-9` 定义三种角色：`PUBLIC`、`PANEL_SESSION`、`PANEL_OR_MCP`。它们在路由声明处作为 Javalin 角色传入，例如 `get("/", authController.getCram, PUBLIC)`（`WebServer.java:117`）、`path("info", Set.of(PANEL_OR_MCP), ...)`（`:162`）。

真正的执行点在 `controller/BeforeController.java:56-104`（注册为 `beforeMatched("/*", ...)`，`WebServer.java:101`）：

1. `OPTIONS` 直接放行（`:57`）——CORS 预检不做鉴权。
2. `isManagedAuthPath` 之外的路径不做 JWT 校验（`:57,180-185`）：只覆盖 `/api/**`、`/assets/upload|reset`、`/file/**`。
3. 角色必须**恰好一个**，否则 500 "Route authorization is not configured."（`:59-65`）——把"忘标角色"从安全漏洞变成显式失败。
4. `PANEL_OR_MCP` 且带 `Authorization: Bearer o-...`（长度必须正好 50，`:70-76`）→ 走 MCP 令牌路径：
   - 读 `StorageKey.MCP_CONFIG`，未启用返回 503（`:78-83`）；
   - 用 `MessageDigest.isEqual` 常量时间比较令牌（`:84-88`，实现见 `:187-193`）。
5. 否则读 Cookie `token`，`JwtManager.verifyToken`，失败则 `removeCookie` + 401 + `skipRemainingHandlers()`（`:91-103`）。

另外三个 before 钩子：`beforeAll` 注入 `X-Powered-By: OPanel` 与 `x-nextjs-deployment-id`（`:51-54`）；`handleRsc` 为 `.txt` + `Rsc: 1` 请求改 `Content-Type: text/x-component` 并回带 vinext RSC 兼容 ID（`:106-113`）；`handleFonts` 让 `.ttf/.otf` 直接 200 并设 Content-Type（`:115-124`）。

Open API 有独立钩子 `handleOpenAPI`（`:126-146`）：未启用 → 503；启用但该接口被关 → 503。接口名从路径 `/open-api/<name>/...` 取第一段（`:195-206`）。

为什么重要：**鉴权不在每个 handler 里，而是在"角色声明 + 单一前置过滤器"上**。新增路由若忘记写角色会得到 500 而不是静默放行，这是把安全默认值做进框架层的一个好样例。

### 1.7 客户端 IP 与下载间接层

- `BaseController.getClientIp`（`BaseController.java:105-139`）：只有 `proxyHeaders=true` 才信任 `X-Forwarded-For`/`X-Real-IP`；`X-Forwarded-For` 取第一个非空且非 `unknown/null/-` 的段；`proxyHeaders=false` 时直接用 `ctx.ip()`。**若面板直接暴露公网且开启 proxyHeaders，限流可被伪造头绕过**。
- 下载统一走 `/file/{id}/{fileName}`（`WebServer.java:112-114`），`DownloadController` 用 16 位随机 ID 映射到 `Path` 或 `byte[]`（`DownloadController.java:15-19,48-67`），**下载后立即从 map 移除**（`:41,44`），即可下载一次；`registerPath(path, callback)` 还支持"下载后回调"（`:52-57`）。
- 扩展与日志下载都复用这条通道：`ctx.redirect("/file/" + downloadId + "/" + fileName)`（`ExtensionsController.java:253-254`、`LogsController.java:66-68`）。

为什么重要：没有把任意路径暴露成 GET 参数，而是"服务端注册 → 随机一次性 ID"的能力令牌模型，天然规避目录穿越和路径猜测；`Utils.isSafeFileName`（`utils/Utils.java:292-305`，拒绝 `..`、`/`、`\`、多段路径、绝对路径）是第二道闸。

### 1.8 静态文件与 SPA 回退

- 静态根是 jar 内 `opanel-web/`（`WebServer.java:32,346-353`）。
- SPA 回退在 `controller/ErrorController.java:19-38`：收到 404 时，若非 `/api*`、`/file*`，先尝试 `<path>/index.html`（`:25-31`，注释里说明是为了绕过 Forge ≤1.20.2 的 404 行为，issue #58），失败再返回包内 `404.html`（`:33-37`）。**它读的是类路径资源，不是文件系统**。
- 扩展页面宿主：`GET /panel/ext/{extId}[/...]` → `ExtensionPageController`（`controller/ExtensionPageController.java:19-36`）返回 `opanel-web/panel/ext/index.html`（`:13`），由前端那个页面再用 `<iframe src=...>` 内嵌真正的扩展页面（`frontend/app/panel/ext/page.tsx:20-25`）。

为什么重要：静态资源"在 jar 里 + 404 里做 SPA 回退"让面板可以在任意平台以单文件分发；把 `/panel/ext*` 从静态解析中排除是为了让扩展的**深层前端路由**（`/panel/ext/x/y/z`）也能命中外层宿主页。

### 1.9 CSRF / CORS 结论

- CORS 只对 `localhost:3001` 放开 credentials（`WebServer.java:324-338`），生产环境跨源不可用；`/open-api/*` 是 `anyHost()`，但 Open API 设计上就是给外部脚本用的，且要求显式开启。
- Cookie 是 `SameSite=Lax` + `HttpOnly`（`JwtManager.java:123-125`），跨站 POST 不会携带 Cookie，因此没有额外 CSRF token；`OPTIONS` 预检直接放行（`BeforeController.java:57`）。
- **没有独立的 CSRF token**：防护完全依赖 SameSite。若未来需要支持 `SameSite=None`（跨站 iframe 场景），必须补 token 或 Origin 校验。

---

## 2. `endpoint/` —— WebSocket 协议与实时推送

### 2.1 帧格式（协议全貌）

统一信封在 `endpoint/Packet.java:3-18`：

```java
public class Packet<D> {
    public static final String CONNECT = "connect";
    public static final String ERROR = "error";
    public String type;
    public D data;
}
```

即线上就是 `{"type": "...", "data": ...}`，无版本号、无请求 ID、无 ACK。前端 `frontend/lib/ws/index.ts:5-8,71` 完全对应该形状（`socket.send(JSON.stringify({ type, data }))`）。

各端点的 `type` 常量（都是内部静态类继承 `Packet`，模式高度一致）：

| 端点 | 路由 | `type` 常量 | 方向 |
|---|---|---|---|
| `PlayersEndpoint` | `/socket/players` | `init`,`fetch`,`join`,`leave`,`move`,`gamemode-change` | `fetch` 客户端→服务端；其余服务端→客户端 |
| `InventoryEndpoint` | `/socket/inventory/{uuid}` | `init`,`fetch`,`update` | `fetch`/`update` 双向 |
| `TerminalEndpoint` | `/socket/terminal` | `init`,`log`,`mcdr-log`,`autocomplete`,`command` | `command`/`autocomplete` 客户端→服务端 |
| `MapEndpoint` | `/socket/map` | `chunks-flush` | 仅服务端→客户端 |
| `MonitorEndpoint` | `/socket/monitor?limit=N` | `init`,`update` | 仅服务端→客户端 |

（`PlayersEndpoint.java:21-32`、`InventoryEndpoint.java:27-35`、`TerminalEndpoint.java:12-22`、`MapEndpoint.java:12-18`、`MonitorEndpoint.java:13-20`；路由注册在 `WebServer.java:64-68`。）

### 2.2 升级阶段的鉴权

`endpoint/BaseEndpoint.java:44-60`：

```java
String token = ctx.cookie("token");
final String hashedRealKey = plugin.getConfig().accessKey; // hashed 2
if(token == null || !JwtManager.verifyToken(token, hashedRealKey, plugin.getConfig().salt)) {
    ctx.closeSession(1008, "Unauthorized.");
    return;
}
```

要点：**升级本身不做鉴权**（Javalin/Jetty 先完成 101 握手），鉴权发生在"已连接"回调里，失败用 **1008 (policy violation)** 主动关闭。通过后：`session.setMaxOutgoingFrames(1024)`（`:55`）、加入 `sessions`、`ctx.enableAutomaticPings()`（`:57`）、下发 `connect` 帧（`:58`）。

为什么重要：这样 WS 与 HTTP 共用同一个 Cookie 会话，无需额外握手协议；代价是"未授权也能建立 TCP/WS 连接再被踢"，对扫描器不友好（但成本可控）。

### 2.3 按 `type` 的会话级订阅

`BaseEndpoint.subscribe`（`:81-105`）是路由核心：把 `(session, type) → consumer` 注册到 `sessionListeners`；收到消息时（`:62-72`）遍历该 session 的监听器，每个监听器**先按 `Packet.class` 粗解析拿 `type`**，匹配后再用 `TypeToken.getParameterized(Packet.class, dataClass)` 做精确反序列化（`:98-102`）。

即：路由 = "每个监听器自己 if type 相等"，没有中心分发表；`dataClass` 由调用方给出，实现类型安全的反序列化（例如 `subscribe(session, TerminalPacket.COMMAND, String.class, ...)`，`TerminalEndpoint.java:61`）。

防越权细节：监听器内部再检查 `ctx.session != session` 直接返回，且若 session 已被移出 `sessions` 集合则关闭连接（`:92-96`）。

### 2.4 背压与慢消费者

`BaseEndpoint.java:24-26,123-157`：

- 注释明确：Jetty 出站帧队列默认无界（-1），这里限制为 **1024 帧**（注意：单位是帧，不是字节）。
- `sendMessage` 先查 `session.isOpen()` 和 `slowConsumerSessions`，然后异步 `sendText(msg, callback)`。
- 回调里若失败原因是 `WritePendingException`（上一次写还没完成），把 session 加入 `slowConsumerSessions` 并**异步** `close(1013, "Slow consumer")`，失败再 `disconnect()`（`:136-148`）。
- 代码注释解释了为何静默处理异常：Minecraft 会把 `System.err` 重定向进服务端日志，日志里刷 WS 异常会污染控制台（`:135`）。
- `broadcast` 逐 session 发送并顺带剔除已关闭会话（`:159-169`）。

为什么重要：这是"把慢客户端从内存放大器中隔离出去"的最小实现——限帧 + 检测写阻塞 + 主动断开，且不把异常泄漏到游戏日志。任何做进程内 WS 广播的面板都需要这三件事。

### 2.5 每个端点的实时性策略

- **Players**：`PLAYER_MOVE` 是高频事件，用 `pendingPlayerMoves`（HashMap，按 uuid 去重）+ 1 秒固定延迟的 `moveBroadcastScheduler` 做**批量化合并**（`PlayersEndpoint.java:19,80-95,113-118,141-151`）——同一玩家 1 秒内多次移动只保留最后一个位置。`join/leave/gamemode-change` 立即广播。连接时 `init` 推全量玩家列表（`:153-166`），客户端可发 `fetch` 主动刷新（`:125`）。`joinTimeMap` 记录加入时刻用于计算在线时长（`:34,53-54`）。
- **Monitor**：连接时按 `?limit=` 回放内存历史（`MonitorEndpoint.java:35-38,45-55`，默认 `MAX_HISTORY_SIZE=200`），之后由 `MonitorManager` 的采样线程推 `update`（`:30-31`）。
- **Terminal**：连接时把 `LogListenerManager.getRecentLogs()` 全量下发（`TerminalEndpoint.java:59`），之后每条新日志广播 `log` 帧（`:39-41`）。用 `AtomicBoolean` 双重守卫防止多个 endpoint 实例重复注册日志监听（`:31-32,38,47`），否则前端会看到重复日志（注释 `:29-30`）。
- **Inventory**：按 `{uuid}` 路径参数校验玩家存在性（`InventoryEndpoint.java:48-61`），再订阅 `fetch`/`update`；`update` 做**严格校验**：库存类型可解析、物品非空、`slot ∈ [0, size)`（`:73-88`），越界返回 `error` 帧（`400`）。库存变更同时通过 `EventManager` 的 `PLAYER_INVENTORY_CHANGE` 推给所有看该玩家的 session（`:112-121`）。
- **Map**：只监听 `DIRTY_CHUNKS_FLUSH` 事件并广播（`MapEndpoint.java:25-29`），前端收到后按需重新拉 tile 数据。

### 2.6 错误帧与关闭语义

`sendErrorMessage(ctx, status)` → `Packet(ERROR, status.getCode())`（`BaseEndpoint.java:119-121`）。关闭码使用：`1008` 未授权/缺 uuid/玩家不存在、`1013` 慢消费者、`1000` 服务端停止（`closeAllSessions`，`:171-180`）。

### 2.7 重连与断线恢复

核心层**没有重连/断点续传**：没有消息序号、没有 replay 缓冲。恢复手段是"重连即全量重放"——terminal 重放最多 20000 行、monitor 重放最多 200 点、players 重放完整列表。前端 `WebSocketClient` 也没有自动重连逻辑（`frontend/lib/ws/index.ts:40-47` 只把 `close` 转成 `onClose()` 回调，由页面自行处理），并且构造时先 `checkAuth()`，失败就跳 `/login`（`:14-22`）。

为什么重要："全量重放 + 无状态连接"让服务端不需要为每个连接维护增量位置，显著简化实现；代价是重连瞬间的突发流量（terminal 20000 行是一次性大帧，正好会撞上 1024 帧上限——不过它是一帧，所以没问题，但体积可能很大）。

---

## 3. `controller/` —— HTTP 路由与响应契约

### 3.1 路由声明方式：代码式 DSL，非注解驱动

路由**不是注解驱动的**，而是在 `WebServer.buildRoutes()`（`WebServer.java:62-297`）里用 Javalin 的 `ApiBuilder` 静态 import 手写：

```java
before("/*", beforeController.beforeAll);
beforeMatched("/*", beforeController.authToken);
path("api", () -> {
    path("players", Set.of(PANEL_OR_MCP), () -> { ... });
});
```

（`WebServer.java:98-101,115,186`。`import static io.javalin.apibuilder.ApiBuilder.*` 见 `:28`。）

- 控制器实例在 `:71-95` 一次性 new 出来，并把 `Handler` 字段当作回调传入（例如 `playersController.getPlayers` 是 `public Handler xxx = ctx -> {...}`）。
- `Set.of(role)` 作为 `path(...)` 的第二参，把角色下发给该子树所有路由。

**注解体系只有一个例外**：`annotation/Rewrite.java`（`:1-15`，`SOURCE` 保留策略）是纯文档性注解，"标明该方法重写了父类方法"，因为平台模块会把 helper 的源码**直接编进**版本模块（见 `paper/paper-1.21.9/build.gradle:68-70` 的 `source(project(":paper-helper").sourceSets.main.allSource)`），此时 Java 编译器看到的父类可能不是同一个类，`@Override` 会失效，所以自定义了一个等价的标记注解。这是一个非常实际的"跨模块源码内联"副产物。

### 3.2 响应封装

`controller/BaseController.java:30-50` 定义了唯一的响应契约：

```java
protected void sendResponse(Context ctx, HttpStatus status, String msg) {
    ctx.status(status);
    HashMap<String, Object> jsonObj = new HashMap<>();
    jsonObj.put("code", status.getCode());
    jsonObj.put("error", msg);
    ctx.json(jsonObj);
}
protected void sendResponse(Context ctx, HashMap<String, Object> jsonObj) {
    jsonObj.put("code", 200); jsonObj.put("error", ""); ctx.json(jsonObj);
}
```

即 **HTTP 状态码与包体 `code` 双写**，成功响应把业务字段**平铺**在顶层（顺带塞 `code:200`、`error:""`），没有 `data` 包裹层。错误信息是英文纯文本，`HttpStatus.getMessage()` 作为默认文案。

二进制响应走 `sendContent`（`:52-88`），带 `Content-Disposition: attachment; filename="..."` 的变体；缓存协商走 `handleEtag`（`:90-94`）：写 `ETag`，若 `If-None-Match` 相等则调用方回 304。

控制器实例表 `instances`（`:15,24-28`）用来在同一进程内做控制器互调，例如 `ExtensionsController` 通过 `getControllerInstance(DownloadController.class)` 复用下载注册（`ExtensionsController.java:26`）；重复构造同一类会抛 `IllegalStateException`（`BaseController.java:24-26`），以防止路由注册被意外复制。

### 3.3 `controller/api/` 与 `controller/openapi/` 的区别

| 维度 | `controller/api/` | `controller/openapi/` |
|---|---|---|
| 挂载路径 | `/api/...` | `/open-api/...`（`WebServer.java:278-296`） |
| 鉴权 | `beforeMatched` 的 JWT/MCP 中间件 + 角色 | 无 JWT；仅 `handleOpenAPI` 检查总开关 + 单接口开关（`BeforeController.java:126-146`） |
| CORS | 只允许 `localhost:3001` | `anyHost()`（`WebServer.java:320-323`） |
| 开关存储 | MCP 令牌在 `StorageKey.MCP_CONFIG` | `StorageKey.OPEN_API_CONFIG`，逐接口 `interfaces` 映射（`:139-145`） |
| 覆盖范围 | 全功能（控制、存档、插件、任务、扩展…） | 只读：info / monitor / plugins / players / logs（`WebServer.java:281-295`） |
| 数据形态 | 复用同一 `MonitorController` 等 | 独立类，且**内容更少**：如 `OpenMonitorController.getMonitor` 只回最后一个快照，8 个字段（`controller/openapi/OpenMonitorController.java:16-34`），而 `MonitorController` 还提供 `history`（含时间范围聚合）与 `activity`（`controller/api/MonitorController.java:36-79`） |

两套 API 是**刻意分离的类树**，而不是同一 handler 加个开关。读一眼就能确认"对外开放"的能力面被硬编码为只读子集——这是最小暴露面的做法，新增开放接口必须显式写新类 + 新路由。

### 3.4 `handleEtag` 的实战用法（地图）

`MapController` 把"索引版本号"当 ETag：

```java
String etag = "\"avail-" + manager.getIndexVersion(saveName) + "\"";
ctx.header("Cache-Control", "private, max-age=5");
if(handleEtag(ctx, etag)) { sendResponse(ctx, HttpStatus.NOT_MODIFIED); return; }
```

（`controller/api/MapController.java:70-75`；范围查询则额外叠加内容哈希 `computeBundleHash`，`:138-143,208-214`。）版本号由 `MapRenderManager` 的 `AtomicLong` 维护（见 §10）。

为什么重要：在一个"实时性由版本号驱动"的系统里，ETag 不能基于文件 mtime（内存缓存根本没有文件），必须基于数据版本计数器；用 `private, max-age=5` 而不是 `no-store` 让浏览器在 5 秒内免请求，配合 5 秒的地图 flush 周期正好合拍。

### 3.5 `controller/api/` 目录速览

`WebServer.java:71-95` 一次性实例化的 25 个控制器，可按职责分四类（括号内为主要挂载点）：

- **入口/安全**：`BeforeController`（前置过滤器）、`AuthController`（`/api/auth`）、`OidcController`（`/api/auth/oidc`）、`SecurityController`（`POST /api/security`）、`BannedIpsController`（`/api/banned-ips`）、`McpController`（`/api/mcp`）。
- **服务器运营**：`ControlController`（`/api/control`，properties/守则/stop/reload/restart/切换存档/Paper 配置/启动命令）、`InfoController`（`/api/info`）、`GamerulesController`、`WhitelistController`、`PlayersController`、`SavesController`、`PluginsController`、`TasksController`。
- **观测**：`MonitorController`（快照/历史/活动）、`LogsController`（`/api/logs`，列表/内容/下载/清空/删文件/上传 mclogs）、`TerminalController`（供 MCP 用的命令表与发命令）。
- **资源与扩展**：`AssetsController`（`/api/assets`，含登录横幅图，`AssetsController.java:28-33`）、`IconController`（`/api/icon`，上传时校验必须 64×64 PNG，`IconController.java:36-47`）、`DownloadController`（`/file`）、`ExtensionsController`、`ExtensionPageController`、`VersionController`、`OpenAPIController`。

一个值得注意的取舍：多个控制器存在"给前端的接口"和"给 MCP/AI 的接口"共用同一路由的情况，代码里直接以注释标注（如 `getMonitorSnapshot` 后注 `// for mcp`，`MonitorController.java:22`；`patch` 版本的游戏规则后注 `// for mcp`，`WebServer.java:156`）。这避免了维护第二套 API，但意味着 MCP 的读写权限边界 = 面板自身的权限边界。

---

## 4. `storage/` —— 存储抽象

### 4.1 形状

`storage/Storage.java` 是单例懒加载（`:83-86`），构造器里把 7 个 `StorageKey` 映射到具体的 `StorageFile`（`:21-56`）：

| Key | 文件 | 类型 | 默认值 |
|---|---|---|---|
| `SCHEDULED_TASKS` | `tasks.json` | `List<ScheduledTask>` | 空列表 |
| `MCP_CONFIG` | `mcp-config.json` | `McpConfiguration` | `enabled=false` |
| `OPEN_API_CONFIG` | `open-api.json` | `OpenAPIConfiguration` | 关闭 + 默认接口表 |
| `LAUNCH_COMMAND` | `launch-command.txt` | 纯文本 | `""` |
| `MAP_CONFIG` | `map-config.json` | `MapConfiguration` | `enabled=false` |
| `OIDC_CONFIG` | `oidc-config.json` | `OidcConfiguration` | 空白名单 |
| `ACTIVITY` | `activity.json` | `List<ActivityData>` | 空列表 |

读写入口只有两个泛型方法 `getStoredData(key)` / `setStoredData(key, data)`（`:58-81`），**每次调用都读/写整个文件**——没有任何内存缓存层。所有文件都落在 `OPanel.OPANEL_DIR_PATH`（即 `opanel/`，`StorageFile.java:50,68`）。

注意 `StorageKey` 的 id（`storage/StorageKey.java:4-10`）只用于日志/调试输出（`toString()`），**与文件名无关**，文件名硬编码在 `Storage` 构造器里。

### 4.2 `StorageFile`：默认值、自愈与"向前兼容"

`storage/StorageFile.java`：

- 构造时若文件不存在，立即用默认值落盘（`:57-63`，纯文本版在 `:75-81`）。
- Gson 配置：注册 `DateAdapter` + `setPrettyPrinting`（`:84-88`），便于人工查看/手改。
- `read()`（`:91-114`）的容错链：文件内容不是合法 JSON → **覆盖写回默认值并返回默认值**（`:97-102`）；内容为 `null` → 同上（`:104-107`）；再调用 `fillMissingValues` 补齐缺失字段，并有变更时立即回写（`:109-111`）。
- `fillMissingValues`（`:121-145`）是**递归的"以默认值树为模板补键"**：目标对象缺失的键用默认值深拷贝补上，且递归进入嵌套对象。这就是它的 schema 迁移机制——**没有版本号、没有迁移脚本，靠"默认值即最全 schema"来前向补齐**。删除字段、改字段类型都不在这个机制的能力范围内（Gson 会静默置 null/0）。
- `write()` 用 `Files.writeString(..., TRUNCATE_EXISTING)`（`:116-119`），**非原子写**：没有 temp+rename，也没有 fsync。断电/崩溃可能留下半截 JSON —— 但 `read()` 的容错链会把它重置为默认值，**即"写崩 = 丢全部该文件的配置"**，而不是崩溃。

对比 `MonitorHistoryStore`（H2）和 `MapRenderManager` 的 tile bundle（temp + `Files.move(REPLACE_EXISTING)`，`MapRenderManager.java:202-205`），只有 `StorageFile` 是非原子写。

### 4.3 配置持久化是另一条路径

`config/ConfigManager.java:3-6` 只是一个 `get/set` 接口，真正实现由平台模块提供：Paper 侧是 `paper/paper-helper/.../config/ConfigManagerImpl.java`，直接读写 **Bukkit 的 `config.yml`**（`get()` 在 `:18-40` 逐字段带默认值读取，`set()` 在 `:42-64` 写回后 `plugin.saveConfig()`）。也就是说：

- **平台级配置（端口、口令、salt、OIDC、监控保留期）在 `config.yml`**（由平台/服务端生态管理）；
- **面板运行时数据（任务、MCP、Open API、地图开关、活动记录）在 `opanel/*.json`**（由 `Storage` 管理）。

`OPanelConfiguration.defaultConfig`（`config/OPanelConfiguration.java:4-25`）给出全部默认值：host `0.0.0.0`、port 3000、MCDR socket 25576、地图并发预渲染 4、监控采样 1000ms、监控历史保留 7/90/365 天、重启延迟 10s、`cookieSecure=false`、`proxyHeaders=false`、OIDC 关闭。

为什么重要：两套持久化分工明确——"需要用户手改、且平台惯例放在 yml 的"走平台配置；"面板自己新增、平台无关的"走 `opanel/*.json` 并由 `fillMissingValues` 自动升级。这让版本升级不需要迁移脚本，代价是无法表达破坏性 schema 变更。

---

## 5. `task/` —— 定时任务调度

### 5.1 调度模型：cron + 单次延迟任务自续期

`task/ScheduledTaskManager.java`：

- 用 **cron-utils** 解析 **UNIX 5 段 cron**（`CronDefinitionBuilder.instanceDefinitionFor(CronType.UNIX)`，`:33`），不使用 `ScheduledExecutorService` 的固定周期（`:30-32` 只是提供线程池）。
- 每个任务用 `ExecutionTime.nextExecution(after)` 算出下一次执行时刻，转成纳秒延迟投递**一次性** `executor.schedule(...)`；回调里执行完再算下一次继续 schedule（`:75-118`）。本质是"延迟队列 + 自续期"。
- 续期基准取 `max(now, next)`（`:105-109`），防止时钟回拨或提前唤醒导致同一时刻执行两次。
- 每个任务持有 `TaskFutureRef` 身份对象，调度前/执行前都校验 `taskFutureRefs.get(id) != futureRef → return`（`:78,94`），**防止被替换/删除后的旧回调还继续跑并重排自己**。
- 改 cron / 删除任务时 `future.cancel(false)`（不打断正在执行的）（`:64-67,149-152`）。

### 5.2 并发与重叠策略

- 一把 `ReentrantReadWriteLock`（`:26-28`）：所有结构性变更（create/update/delete/save/toggle）持写锁；**执行回调只持读锁**（`:90-103`），因此**同一任务不会与另一个任务的写操作互斥，多任务可并发执行；同一任务也不会重叠执行**（因为下一次是执行完成后才投递的）。
- 隐式语义：任务执行耗时超过 cron 间隔时，**下一次执行被顺延，不会补跑**（`rescheduleAfter` 用当前时间而非"错过的时刻"，且 `next` 只在 `rescheduleAfter < next` 时用于校正）。
- 执行器线程数 `max(2, CPU/2)`（`:30-32`）。

### 5.3 任务语言（自定义 DSL）

任务体不是单条命令，而是一门小语言，`task/TaskCommandParser.java:24-92`：

- `#` 开头或空行 = 注释（`:10,26-27`）；
- `@loop <n> ... @end` 循环（`:40-58`），嵌套通过**递归解析**实现（`currentLoop.setRoot(TaskCommandParser.parse(currentLoopCommands))`，`:30`）；
- `@goto <sign>` / `@sign <id>` 跳转（`:60-76`）——**已解析但执行器里整段被注释掉，是未实现的 todo**（`TaskCommandExecutor.java:27-39`）；
- `@<builtin> args...` 内置操作（`:78-88`，前缀 `@`，`TaskCommand.Builtin.PREFIX`）；
- 其他行 = 原样发给服务端的命令（`:90`）。

AST 在 `task/TaskCommand.java`：`Root extends Node<List<Node<?>>>`，`addChild` 时顺带把 `Sign` 记进 `gotoSignMap`（`:28-33`，为将来的 goto 准备）；`Builtin` 在构造时就把字符串转成枚举 `TaskBuiltinOperation.fromString`，未知操作直接抛 `IllegalArgumentException` → 被包装成 `IllegalTaskCommandSyntaxException`（`:80-85`）。

执行器 `TaskCommandExecutor.execute`（`:15-49`）：遍历节点，`Loop` 递归跑 n 次，`Builtin` 调 `operation.execute(args, server)`，`ServerCommand` 经过变量注入后 `server.sendServerCommand(...)`（`:46`）。变量注入器 `TaskBuiltinVariableInjector`（22 行）在每次执行时新建，意味着变量（如时间、玩家数）**在执行时刻求值**而非创建任务时。

**语法在创建/编辑时就校验**：`createTask` 先 `TaskCommandParser.parse(commands)` 再 parse cron，两者任一失败即拒绝（`:123-124`）；`updateTask` 同样（`:194-195`）。执行器里再 parse 一次（`TaskCommandExecutor.java:12`）。

### 5.4 持久化与生命周期

- 任务列表启动时从 `StorageKey.SCHEDULED_TASKS` 读入（`:43-45`），逐个 `scheduleTask`（`:49-51`）——**重启后自动恢复**；`enabled=false` 的任务仍然被排程，只是在回调里检查 `task.isEnabled()` 决定是否真的执行（`:96-100`），这样可以保留"下一次执行时间"的语义而不必增删调度。
- 每次变更 `saveTasks()` 全量写 JSON（`:58-60`）。
- `shutdown()` 取消所有 future、`executor.shutdownNow()`、最后再 `saveTasks()`（`:282-296`）。
- 任务 id 由 `Utils.generateRandomCharSequence(16, false)` 生成（`:126`）。
- 注意 `updateTask` 收到的是**未 base64 解码**的 `name`（`TasksController.java:66`），而 `createTask` 解了 base64（`:47`）——这是现存的不一致。

为什么重要：用"下次执行时刻 + 自续期"而不是固定周期，才能支持任意 cron（包括 `0 4 * * 1` 这种跨大间隔）；用身份对象 + 读写锁，解决了"任务正在执行时被删除/改cron"的经典竞态；缺失的 goto 说明 DSL 是分阶段落地的。

---

## 6. `terminal/` —— 控制台采集与命令执行

### 6.1 抽象

`terminal/LogListenerManager.java:6-12` 是极简接口：`addListener` / `clearListeners` / `getRecentLogs()` + 常量 `MAX_LOG_LINES = 20000`。

`terminal/ConsoleLog.java:3-18` 是日志行模型：`time, level, thread, source, line, thrownMessage, mcdr`。

### 6.2 平台实现：Log4j2 Appender

各平台模块各自实现一份（如 `paper/paper-1.21.9/.../terminal/LogListenerManagerImpl.java`）：

- 类上 `@Plugin(name = "LogListenerAppender", category = "Core", elementType = "appender")`，继承 `AbstractAppender`（`:19-20`）。
- `append(LogEvent)`：**只保留 INFO/WARN/ERROR**（`:30`），提取时间/级别/线程/logger 名/格式化消息（`:32-37`），异常用 `Utils.stringifyThrowable` 压成字符串（`:39-42`）。
- 环形缓冲是 `LinkedList + synchronized`，超过 20000 行从头部删（`:44-47`）。
- 然后同步回调所有 listener（`:49-51`）——注意**在日志线程上直接广播**，所以 `TerminalEndpoint` 的 listener 里做的是 `broadcast(...)`（非阻塞投递）。
- 注册方式是拿到 Log4j2 root logger 再 `addAppender`（`paper/paper-1.21.9/.../Main.java:81-87`），关服时 `removeAppender` + `clearListeners`（`:89-97`）。

### 6.3 命令执行与补全

`terminal/MCDRConnector`（MCDReforged 桥）与 `TerminalEndpoint`：

- 命令帧处理（`TerminalEndpoint.java:61-70`）：若 MCDR 桥活跃且命令以 `!!` 开头 → 走 MCDR socket；否则去掉前导 `/` 后调 `plugin.getServer().sendServerCommand(command)`。
- 补全（`:72-78`）：`argIndex == 1` 时直接返回 `plugin.getServer().getCommands()` 全量命令表，否则调 `getCommandTabList(argIndex, command)`（由平台用 Brigadier/命令分发器实现）。
- MCDR 桥（`MCDRConnector.java`）：后台 daemon 线程连**本机回环** `mcdrSocketPort`（`:47`），行协议 JSON → `ConsoleLog`（`:57-62`，`setMCDR(true)`）；断线每 5 秒重试（`:67-69`）；写用 `PrintWriter(autoFlush=true)`（`:52`）。桥是否启用由**文件存在性**决定：`OPanel.MCDR_BRIDGE_FLAG_PATH`（`OPanel.java:34,261-263`）。
- 富文本渲染：日志与终端用的 `§` 格式码、ANSI 转换在前端（`frontend/lib/ansi-to-html` 与 `lib/formatting-codes`），后端只传原始字符串。

为什么重要：日志采集挂在**日志框架的 appender 层**而不是 `System.out` 重定向——这样能拿到 level/thread/logger/异常对象等结构化字段，前端才能做过滤与折叠堆栈；环形缓冲定在 20000 行，是新客户端连接时的重放上限，决定了内存占用上限。

### 6.4 另一半：磁盘日志文件（`logger/Loggable`）

终端 WS 提供的是"最近 N 行的实时流"，而历史日志文件走 HTTP：`logger/Loggable.java:14-70` 是一个抽象基类（平台只实现 `info/warn/error` 三个方法），统一提供：

- `getLogFileList()`：列 `logs/` 下所有非目录项（`:21-36`）；
- `getLogContent(fileName)`：文件名过 `Utils.isSafeFileName`（`:43-45`），`.log`/`.txt` 直接读文本，`.gz` 走 `Utils.decompressTextGzip`（`:51-56`），其他扩展名拒绝（`:57`）；
- `deleteLog(fileName)`（`:60-70`）。

对应的 HTTP 入口是 `LogsController`（`/api/logs`）：列表、取内容、下载（`.log.gz` 下载时改名为 `.log`，`LogsController.java:67`）、清空、删除、以及 `POST /api/logs/{fileName}/upload-mclogs` —— 后者用 `HttpClient`（连接超时 10 秒，`:26-28`）把日志发到 `https://api.mclo.gs/1/log`（`:25`），即"一键分享日志到 mclo.gs"。

为什么重要：把"实时尾部"（内存 ring buffer + WS）和"历史归档"（磁盘文件 + HTTP + 一次性下载令牌）分成两条通道，是控制内存与流量的关键——WS 只承载尾部，否则一个开着面板的用户就等于把整个 logs 目录读进内存。

---

## 7. `monitor/` 与 `time/` —— 指标采集

### 7.1 TPS/MSPT 的计算（`time/TPS.java`）

不依赖平台 API，而是自己打点：

- 100 槽的 `long[100]` 存 `System.nanoTime()`，`onTick()` 由平台每 tick 调一次（`OPanel.java:122-124`，Paper 侧用 `runTaskTimer(this, instance::onTick, 0L, 1L)`，`Main.java:99-101`）。
- `getRecentMSPT()`（`:14-33`）：遍历 99 个相邻差，过滤 `duration >= 2s` 的样本（`:5,25`，视为服务器暂停/卡顿不参与均值），取平均后转毫秒；无有效样本时返回 50ms（即 TPS 20）。
- `getRecentTPS()` = `min(20, max(0, 1000/mspt))`（`:35-41`）。
- `isPaused()`（`:43-48`）：距最后一次 tick ≥ 2s 即判定暂停。
- `Uptimer` 更简单：构造时记 `System.currentTimeMillis()`，`getCurrent()` 返回差值（`time/Uptimer.java:6-12`）。

为什么重要：`1000/mspt` 只是近似（真实 TPS 是 tick 频率），但配合"剔除 ≥2s 的暂停窗口"就能在服务器挂起/存档时避免把 TPS 拉成 0，比平台 API 更可控且跨平台一致（Fabric/Forge/NeoForge/Paper 都只提供 tick 回调）。

### 7.2 采样与内存环形缓冲（`monitor/MonitorManager.java`）

- `MAX_HISTORY_SIZE = 200`；`ArrayDeque` 预填 200 个全 0 样本（TPS 填 20）（`:22,31,47-58`），保证前端首帧就有完整曲线。
- 采样线程单线程 daemon，`scheduleAtFixedRate(interval)`，间隔来自配置 `monitorSnapshotInterval`（默认 1000ms）（`:34-43,62-67`）。
- 每次采样（`:70-106`）依次取：CPU（`CpuSampler`）、系统内存率、JVM 堆内存率、TPS、网络上下行速率、磁盘读写速率；写内存环形缓冲，再同步分发给 `updateListeners`（异常只 warn，不影响采样循环）。
- `getHistory(limit)` 加读锁取快照并按 limit 截尾（`:127-140`）；`getSnapshot()` 是"即时采一次"（用于 MCP 的单点查询，`:108-121`）。
- 内存百分比都用 `Math.round` 取整：`Monitor.getMemoryRate` = (total-available)/total*100，`getJvmMemoryRate` 用 `ManagementFactory` 堆使用率（`monitor/Monitor.java:10-37`）。
- 速率计算是"计数器差分 / 实际经过毫秒 × 1000"（`NetworkMonitor.java:20-73`、`DiskMonitor.java:20-77`），按接口名/磁盘名分别保存上次计数（避免热插拔网卡导致负值），首次采样返回 0，且对负差分做 `Math.max(0, ...)` 保护。

### 7.3 持久化历史：H2 + 金字塔降采样

这是整个 core 里最"重"的一块。

存储层 `monitor/MonitorHistoryStore.java`：

- 用 **H2 嵌入式数据库**（`jdbc:h2:file:<opanel/monitor-history>;DB_CLOSE_ON_EXIT=FALSE`，`:49-59`），单表 `monitor_aggregate`，主键 `(resolution_seconds, bucket_start)`（`:141-171`）。
- 每行存 8 个指标的 **sum/min/max + sample_count**（`:25-35`），不是原始点。8 个指标 = cpu, memory, jvm_memory, tps, network_upload, network_download, disk_read, disk_write。
- 三种分辨率常量：分钟 60s、刻钟 900s、小时 3600s（`:19-21`）。
- `MERGE INTO ... KEY(...)` 做 upsert（`:36-40`），因而"同分钟重复写入"会合并而不是报错。
- 有 `monitor_schema_version` 表，版本必须精确等于 `SCHEMA_VERSION=1`，否则抛异常拒绝启动（`:173-183`）——**不支持就地升级**。
- `persistMinute` 在一个事务里：合并已有分钟桶 → upsert → `rollUpAfterMinute`（当刻钟/小时桶已完整时重建它们）（`:78-91,203-219`）。
- `maintain(now, config)` 每次做：重建两个已完成的上级分辨率 + 按各自保留天数删除旧数据（`:93-105`）。
- `readRange(resolution, from, to)` 查询时把下界往前扩一个桶（`:107-120`）——因为输出桶可能由"跨越查询边界的源桶"贡献，必须多读一点。

管理层 `monitor/MonitorHistoryManager.java`：

- 采样累积在内存里的当前分钟桶（`MonitorHistoryAccumulator.add`，`monitor/MonitorHistoryAccumulator.java:9-26`：时间戳对齐到分钟，桶切换时返回"已关闭"的聚合），再由 `recordSample` 交给单线程 executor 落库（`MonitorHistoryManager.java:80-95,155-169`）。
- 非有限值（NaN/Inf）样本直接跳过，且只告警一次（`:82-88,33`）。
- 查询（`:97-121`）提交到同一个 executor 并**带 10 秒超时**（`:23,109-115`），超时 `future.cancel(true)`；这样"慢查询"不会阻塞 HTTP 线程无限久。
- 分辨率选择（`:280-288`）：按 `from` 落在哪个保留窗口决定源分辨率（分钟/刻钟/小时）；`selectSourceResolution` 用 `retentionCutoff` 比较。
- 输出分辨率（`:290-308`）：`ceilDiv(span, maxPoints)` 后向上取整到源分辨率的整数倍，并**循环加大直到对齐后的桶数 ≤ maxPoints**（`:301-306`）——保证返回点数上限是硬约束。
- 跨分辨率拼接（`readStitchedRange`，`:224-267`）：先读小时段（到已完成的整点为止），再读刻钟段，最后读分钟段到 `min(to, now)`，三段首尾相接不重叠。
- 降采样在查询时做：按输出桶分组，用 `MonitorAggregate.merge` 合并（min/max 取极值、sum 累加），输出 `MonitorHistoryData(bucketStart, duration, sampleCount, avg, min, max)`（`:180-217`）。
- 可用性设计很稳：`available` 标志 + 失败即 `closeStoreQuietly` 并标记不可用，后台每 5 分钟尝试重开（`:22,330-360`）；查询不可用时抛 `IllegalStateException` → 控制器转 503（`MonitorController.java:76-78`）。关停时会把内存里未满一分钟的桶 flush（`:128-152`）。
- 保留期配置做了**单调性钳制**：分钟 ≤ 刻钟 ≤ 小时，越界回落到有效值并 warn（`config/MonitorHistoryConfiguration.java:18-50`），范围分别是 1–30 / 1–365 / 1–3650 天。

API 层：`GET /api/monitor/history?from&to&maxPoints`（默认 500，硬上限 2000，`MonitorHistoryManager.java:17-18`），返回 `{from,to,resolutionMs,points}`（`MonitorController.java:51-79`）。

为什么重要：这是"进程内时序数据库"的标准解——**原始点不落盘，只落聚合（sum/min/max + count），并在分钟→刻钟→小时三级金字塔上滚动**。查询时再按需二次聚合，因此内存与磁盘占用与保留时长无关（只与桶数量线性相关），且永远能给前端固定点数的曲线。代价是：无法回溯任意秒级精度、schema 版本变更必须弃库。

---

## 8. `extension/` —— 扩展系统

### 8.1 分发与契约：独立 `api` 模块

- 对外 API 在独立 Gradle 模块 `api/`（包名 `cn.opanel.api`），发布到 Maven Central，坐标 `cn.opanel:opanel-api`（`api/build.gradle`：`maven-publish` + `signing` + `nmcp`；根 `build.gradle:44-58` 用 `nmcpAggregation` 聚合发布）。
- 入口是 `cn.opanel.api.OPanelAPI`（`api/src/main/java/cn/opanel/api/OPanelAPI.java:24-103`）：`getOPanelVersion()`、`getServer()`、`getPluginsAPI()`、`getLogsAPI()`、`getTasksAPI()`、`getMonitor()`、`logInfo/Warn/Error`、`addHandler(path, HandlerType, Handler)`。
- 生命周期/事件注解：`@Extension`（标记唯一入口类）、`@ExtensionLoad`（必须 `public void load(OPanelAPI)`）、`@ExtensionUnload`（可选 `public void unload()`）、`@EventHandler`（见 `ExtensionManager.java:285-317`、`ExtensionEventDispatcher.java:112-135`）。
- API 的 Javadoc 明确承诺"同一实例直到 unload 前有效；unload 后调用抛 `APIUnavailableException`；返回值默认是快照"（`OPanelAPI.java:12-23`）。

### 8.2 加载：Jar + 受限 ClassLoader

`extension/ExtensionManager.java`：

- 扫描 `opanel/extensions/*.jar`，按文件名排序，逐个加载；单个失败只记日志，不影响其他（`:51-75`）。
- 元数据 `extension.json` → `ExtensionMetadata(extId, version, name, description, author, pages[])`（`extension/ExtensionMetadata.java:5-17`）；校验 `extId` 非空、匹配 `[a-z0-9]+(-[a-z0-9]+)*` 且 ≤64 字符（`:36,140-142`），`name` 非空，每个 page 的 `name` 非空且 `url` 必须 `isSafePageUrl`（`:239-247`）。
- `isSafePageUrl`（`:252-267`）要求：以 `/` 开头、不以 `//` 开头、不含 `\`、URI 不绝对、无 authority、path 通过 `Utils.normalizePath`。**这是防止扩展把一个相对 URL 变成外部跳转**。
- 入口类发现（`:195-214`）：遍历 jar 内 `.class`（排除 `META-INF/`、`versions/`、`module-info.class`，`:269-276`），`Class.forName(..., false, loader)` 只做元数据加载，然后要求**恰好一个** `@Extension` 类，否则跳过。
- 校验 `@ExtensionLoad` 签名必须是 `public void load(OPanelAPI)`（`:292-296`），`@ExtensionUnload` 至多一个且必须是 `public void unload()`（`:300-316`）。
- `ExtensionClassLoader`（`:372-403`）是**父加载器为 platform classloader 的 URLClassLoader**，并显式重写 `loadClass`：
  - `cn.opanel.api.*` → 由宿主的 api classloader 提供（保证扩展编译期 API 与运行期一致）；
  - `io.javalin.*`、`jakarta.servlet.*` → 由 core classloader 提供（扩展能写 Javalin handler）；
  - 其他先试 platform（JDK 类），再回落到自己的 jar。
  即**宿主与扩展之间只共享 API 和 Javalin 两个契约面**，扩展自带的第三方库不会污染宿主（也不共享宿主依赖）。
- 加载顺序保证：先 `put` 进 `loadedExtensions`，再调 `load()`，再 `eventDispatcher.activate()`；任何一步抛异常都会回滚卸载（`:176-188`）。
- 卸载（`:339-362`）：先 `eventDispatcher.deactivate`（等待正在派发的事件跑完，见 8.4），再调 `unload()`，`finally` 里 `api.invalidate()` → 从表移除 → 关闭 classloader 与 JarFile；并用 `unloadingExtensionIds` 防止重入。
- 运行时支持热装卸：`ExtensionsController` 的上传/删除/启停都直接调用 `loadExtension`/`unloadExtension`（`controller/api/ExtensionsController.java:121,167,219`），"禁用"就是给文件加 `.disabled` 后缀（`:24,153-176`），失败会回滚改名（`:192-202`）。

### 8.3 扩展能注册什么

1. **后端路由**：`ExtensionAPI.addHandler`（`extension/api/ExtensionAPI.java:107-119`）规范化路径后写进 `LoadedExtension.backendRoutesMap`（`extension/LoadedExtension.java:58-66`，路径→`(HandlerType, Handler)`，同路径重复注册即覆盖）。
   分发在 `BeforeController.routeExtensionBackend`（`controller/BeforeController.java:148-178`）：从路径参数取 extId 与 `path`（空则 `index.html`）→ `Utils.normalizePath` 防穿越 → 查扩展存在 → 查路由存在且**方法完全匹配** → **临时把线程上下文 ClassLoader 换成扩展的**，再执行 handler，最后恢复（`:170-177`）。
   路由挂载是"为每种 HTTP 方法各注册一个 handler"（`WebServer.java:259-267`，遍历 `HandlerType.values().filter(isHttpMethod)`），统一前缀 `/api/extension/{extId}/<path>`，角色 `PANEL_OR_MCP`。
2. **前端页面**：`extension.json` 的 `pages[].url`（如 `"/"`）→ `ExtensionsController.getRegisteredExtensionPages` 组装成 `/panel/ext/{extId}{url}`（`ExtensionsController.java:76-91`）；外壳由 `ExtensionPageController` 提供宿主页，再用 iframe 加载；jar 内 `web/**` 资源由 `getExtensionResource` 从 `JarFile` 流式读出（`:257-317`），支持 trailing slash → `index.html`、精确资源缺失时回退目录 index 并 302（`:279-303`），Content-Type 按扩展名推断（`:330-335`）。
   注意宿主页用的是 `/panel/ext/{extId}`（`WebServer.java:104-106`），资源用的是 `/api/extension-res/{extId}`（`:253-258`）——**两者是不同前缀**。
3. **事件监听**：见 8.4。
4. **日志**：`logInfo/Warn/Error` 统一加 `[扩展名] ` 前缀（`ExtensionContext.java:58-61` 与 `ExtensionAPI.java:83-104`）。

### 8.4 事件桥接与卸载安全

`extension/ExtensionEventDispatcher.java`：

- 支持的事件是**写死的白名单**（`:20-30`）：`PlayerJoinEvent`、`PlayerLeaveEvent`、`PlayerMoveEvent`、`PlayerGameModeChangeEvent`、`PlayerInventoryChangeEvent` → 对应 5 个 `EventType`。参数类型不在表里 → 加载期直接拒绝（`:131-134`）。
- `findEventHandlers`（`:94-110`）扫描 `@EventHandler`，按 `Method::toGenericString` 排序（**保证跨 JVM/多次加载的调用顺序稳定**），并按事件类型分组后做成不可变 Map。
- 派发（`:141-154`）：遍历所有 `Registration`，任一扩展抛异常只记录堆栈，绝不冒泡到平台事件总线（`:164-172` 的 catch-all 也说明了这点）。
- 卸载安全（`:174-228`）：每个 `Registration` 持一把 `ReentrantReadWriteLock`；派发持读锁，`deactivate` 先置 `active=false` 再获取写锁并立即释放（`awaitIdle`）——**这是"等待进行中的事件派发结束"的标准写法**，确保卸载后不会有扩展代码在跑。调用扩展方法时同样切换线程上下文 ClassLoader（`:205-217`）。
- 事件对象转换：`OPanelEvent.toAPIEvent(ExtensionAPI api)`（`event/OPanelEvent.java:6-8`）把内部事件转成 api 模块的 `ExtensionEvent` 子类；内部专用事件（如 `OPanelChunkDirtyEvent`）直接 `throw new UnsupportedOperationException("... is not open to extension API.")`（`event/OPanelChunkDirtyEvent.java:23-26`、`OPanelDirtyChunksFlushEvent.java:25-28`）。

### 8.5 `example-extension/`

- `build.gradle` 极简：只 `compileOnly 'io.javalin:javalin:7.2.3'` + `compileOnly(project(":api"))`，JDK 17（`example-extension/build.gradle:13-22`）——即扩展**打出来不含 API 和 Javalin**，运行时由宿主提供。
- `Main.java`（48 行）覆盖了全部扩展能力：`@Extension` 类、`@ExtensionLoad load(OPanelAPI)` 里打日志 + 读服务器信息 + `api.addHandler("/test", HandlerType.GET, ctx -> ctx.result("Hello World"))`、`@ExtensionUnload unload()`、三个 `@EventHandler`（`:10-47`）。
- 资源：`extension.json`（1 个 page，url `/`）、`web/index.html` + `web/assets/main.js` + `web/assets/style.css`，另有一个 `web/test/index.html` 用来验证子目录路由。

为什么重要：这个扩展系统把"第三方代码"约束在四个可控面上——**静态校验的元数据 + 受限 ClassLoader + 白名单事件 + 显式注册的路由**；卸载路径做了"先停止接收、等待在途派发、再关 classloader"的完整秩序，这是插件系统里最容易做错、也最容易导致 ClassLoader 泄漏的地方。

---

## 9. `event/` —— 面板事件总线

`event/EventManager.java` 是一个**极简进程内同步总线**：

- 单例（double-checked locking，`:35-44`）；
- `ConcurrentHashMap<EventType, Set<Consumer<? extends OPanelEvent>>>`，listener 集合是 `CopyOnWriteArraySet`（`:10,15`）——**同一 listener 实例只注册一次**，遍历时无需加锁；
- `emit` 就是同步 for 循环直接调 `accept`（`:27-33`），**没有异常隔离**（单个 listener 抛异常会中断后续 listener）——异常隔离被放在各自的 listener 内部（如 `MonitorManager.java:96-102`、`PlayersEndpoint` 的 `try/catch`）。
- `off` 用 `computeIfPresent` 并在集合空时移除 key（`:19-24`）。

`EventType`（`event/EventType.java:3-9`）共 7 个：`PLAYER_JOIN`、`PLAYER_LEAVE`、`PLAYER_MOVE`、`PLAYER_GAMEMODE_CHANGE`、`PLAYER_INVENTORY_CHANGE`、`CHUNK_DIRTY`、`DIRTY_CHUNKS_FLUSH`。注意**这里没有 CHUNK_DIRTY 的对外 API 事件**，它是地图内部信号。

事件如何生成：

- 玩家类事件由平台监听器发出（Paper 的 `PaperListener`、Fabric 的 mixin、Forge/NeoForge 的 `*Listener`），最终走 `EventManager.get().emit(...)`。
- **`PLAYER_INVENTORY_CHANGE` 没有平台事件，是轮询出来的**：`OPanelPlayerInventoryChangeEvent.registerPoller`（`event/OPanelPlayerInventoryChangeEvent.java:50-60`）起一个 1 秒周期的 daemon 线程（`POLL_INTERVAL_MS = 1000`，`:16`），对每个在线玩家算 `inventory.getHash()` 与上次比较，变化才 emit（`:74-92`），并 `retainAll(onlineUuidSet)` 清理离线玩家的记录（`:91`）。生命周期由 `OPanel` 构造器注册（`OPanel.java:81`）、`stop()` 里关闭（`:242`）。
- `CHUNK_DIRTY` 由平台在方块变化时发出（事件只带 chunkX/chunkZ，`:6-21`）。

事件如何到达 Web 层：**订阅方就是 WS endpoint 自身**，在构造器里 `EventManager.on(...)`，在 `onShutdown()` 里 `off(...)`（`PlayersEndpoint.java:108-111,130-133`；`InventoryEndpoint.java:120,151`；`MapEndpoint.java:29,34`；`ActivityManager.java:42,117`；`MapRenderManager.java:104-108,296`；`ExtensionEventDispatcher.java:49-53`）。也就是"事件 → 广播/批量缓冲 → WS 帧"这条链没有任何中间队列。

为什么重要：单进程、同步派发、无持久化的事件总线对面板场景是正确取舍（低延迟、无运维）；但要求每个订阅者自己处理异常和线程安全（例如 `PlayersEndpoint` 用锁保护 `pendingPlayerMoves`，`MapEndpoint` 直接 broadcast 依赖 `BaseEndpoint` 的慢消费者保护）。新增订阅者忘记在 shutdown 里 `off` 会造成泄漏——代码里每个订阅点都成对写了。

---

## 10. `map/` —— 网页地图预渲染

### 10.1 数据来源与两条渲染路径

- **离线（预渲染）**：`OPanelWorldRegion.getChunkTiles()`（`common/OPanelWorldRegion.java:8-16`，`REGION_SIZE = 32`，且明确注释"不要在主线调用"）直接解析 `.mca` 区域文件 → `TilesRenderTask` 逐 chunk 压缩 → `submitRenderedTile`（`map/TilesRenderTask.java:24-57`，边处理边把 list 元素置 null 以尽早释放，`:32-33`）。
- **在线（脏块实时）**：`OPanelChunkAccessor.readLiveTile(chunkX, chunkZ)`（`common/OPanelChunkAccessor.java:20`，`SYNC_CALL_TIMEOUT_MS = 5000`）由平台把调用**同步派发到游戏主线程**（Paper 实现：`Bukkit.getScheduler().callSyncMethod` + `future.get(5000ms)`，`paper/paper-helper/.../BasePaperChunkAccessor.java:26-33`），再 `flushDirtyChunks` → `SingleTileRenderTask` 压缩 → `submitRenderedTile`。

`BasePaperWorldRegion`（`paper/paper-helper/.../BasePaperWorldRegion.java`）演示了 MCA 格式的完整读取：8 KiB 头 = 1024 个 4 字节 location（3 字节扇区偏移 + 1 字节扇区数）+ 1024 个时间戳（`:70-80`）；`sectorOffset == 0` 表示 chunk 不存在（`:78-80`）；每 chunk 前 4 字节长度 + 1 字节压缩类型，最高位 `0x80` 是"数据外置到 `.mcc`"标志（`:94-109`）；支持 GZIP(1)/ZLIB(2)/NONE(3)（`:33-36,123-133`）；因为 NBT-API 的 `readNBT` 只吃 GZIP，所以解压后**重新包一层 GZIP** 再喂给它（`:56-63,116-120`）。NBT 里取 `Heightmaps.MOTION_BLOCKING` + `sections[].{Y, block_states, biomes}`，并兼容 26.3 起 palette 可能是"字符串列表或复合标签列表"两种形态（`:198-217`）。

### 10.2 Tile 的内存模型

`map/Tile.java`：一个 tile = 一个 chunk 的"俯视图"。

- `Section` 持有 palette + `blockStates`（已位解包为 int[]）+ biome palette/biomes（`:18-71`）；`getBlockType` 索引式 `y*256 + z*16 + x`，越界返回 `minecraft:air`（`:44-50`）；biome 索引按 4×4×4 降采样 `x>>>2, y>>>2, z>>>2`（`:59-70`）。
- 位打包原语在 `utils/AnvilUtility.java`：`bitunpack/bitpack` 按"每个 long 塞 `64/bits` 个值"实现（`:4-40`），`paletteSizeToBitsSize(palette, minSize)` = `max(minSize, ceil(log2(palette)))`（`:42-49`），heightmap 位宽由世界高度范围决定（`:58-64`）。
- `getTopBlocks()`（`:108-132`）对 16×16 每列取 heightmap 高度 → 找对应 section → 取该点方块 id 与 biome，得到最终要渲染的 256 个顶点。
- `getHeight(x,z)` = `storedHeight + minY - 1`（`:134-137`）——平台侧写 heightmap 时做了逆变换（`BasePaperChunkAccessor.java:63-67`，含越界钳制）。

### 10.3 序列化格式：自定义二进制

`map/TileCompressor.java` 定义两种自有格式：

- 单 tile：magic `"OTILE"`（`:18`），依次写 palette（short 数量 + 每个 id 一个长度字节 + UTF-8 字节）、位打包 blockData（short 长度 + long 数组）、heightmap 位宽 + 位打包数据、biomes palette、位打包 biomes（`:66-107`）。
- 批量包：magic `"OTILES"` + `int count` + 循环 `(long packedCoord, int len, byte[] bytes)`（`:109-125`），解析时先验 magic（`:127-146`）；`HashMap` 初始容量按 `count*4/3+1` 预分配避免 rehash（`:137`）。
- **没有外部压缩（zlib/gzip）**——压缩全靠"调色板 + 位打包"，因为方块 id 字典本身就高度重复（一个 chunk 顶层通常只有十几个不同方块）；这样浏览器端不需要解压步骤，无需引入新的运行时依赖。

### 10.4 缓存、去重与持久化

`map/MapRenderManager.java`：

- 坐标编码：`packCoord(x,z) = ((long)x << 32) | (z & 0xFFFFFFFFL)`（`:64-74`），用一个 long 当 map key。
- 三份 per-save 状态（`:51-53`）：`availableTilesIndex`（已渲染坐标集合）、`tileBytesCache`（坐标 → 压缩后的字节）、`indexVersion`（`AtomicLong` 版本号，任何写入都自增，驱动 HTTP ETag）。
- 启动（`:76-109`）：只处理"正在运行"的存档（`:80`）；若 `opanel/mapdata/<save>.otiles` 存在 → 异步 `loadTileBundle`（`:173-193`，一次读全文件解析进内存）；不存在 → **全量预渲染**，然后 `writeTileBundle`（`:86-95`）。
- 落盘：`writeTileBundle` 先生成新字节数组，写 `.otiles.tmp` 再 `Files.move(..., REPLACE_EXISTING)`（`:195-209`）——**原子替换**，与 `StorageFile` 形成对比。
- 批量写盘去抖：`scheduleBundleWrite` 用 `computeIfAbsent` 保证每个 save 在 5 秒窗口内最多一次延迟写（`:37,134-150`）；`shutdown()` 会**同步 flush 所有待写**（`:277-290`），避免关服丢最新实时块。
- 预渲染并发由 `Semaphore(plugin.getConfig().mapPrerenderConcurrent)` 控制（`<=0` 时回落 4，`:214-215`），执行在 `Executors.newFixedThreadPool(CPU 数)`（`:41-43`）。
- 脏块刷新：`FLUSH_INTERVAL_MS = 5000`、`MAX_CHUNKS_PER_FLUSH = 64`（`:35-36`）。每 5 秒 `dirtyChunkTracker.drain(64)`（`map/DirtyChunkTracker.java:27-38`，`ConcurrentHashMap.newKeySet()` + iterator.remove 无锁批量取），逐个 `readLiveTile` → 渲染 → 排 bundle 写（`MapRenderManager.java:111-132`），最后 `emit(DIRTY_CHUNKS_FLUSH, ...)` 通知前端刷新（`:131`）。
  - 注意这里的实际语义：脏块只在"当前存档"（`server.getCurrentSaveName()`）下渲染（`:119`），且 `readLiveTile` 拿不到（chunk 未加载）就跳过。
- 索引版本用于 HTTP 层：`getIndexVersion`（`:256-259`）与 tile 坐标快照 `getAvailableTileCoords`（`:250-254`，返回拷贝以避免并发迭代问题）。

### 10.5 HTTP 出口

`MapController`（`controller/api/MapController.java`）：

- `GET /api/map/{saveName}`：返回全部已渲染坐标数组（每项 `[x,z]`），ETag = `"avail-<version>"`，`Cache-Control: private, max-age=5`（`:52-89`）。
- `POST /api/map/{saveName}/tiles-range`：按矩形范围打包返回，ETag 叠加内容哈希（`:91-155`）。
- `POST /api/map/{saveName}/tiles`：按坐标列表打包返回（`:157-206`）。
- 两者都用 `sendContent(..., ContentType.APPLICATION_OCTET_STREAM)`，即前端拿到的就是 `OTILES` 二进制包。
- 存档名一律过 `Utils.isSafeFileName`（`:59,98,165`）；地图总开关用了 `originalEnabled`（启动时的值）而不是当前值（`:25,31,53`），即**运行时切换地图开关需要重启才在 tile 接口生效**。

为什么重要：整套设计围绕一个约束——**不能在游戏主线程上做重活**。离线预渲染走磁盘（无主线程），在线更新走"5 秒批量 + 只读已加载区块 + 5 秒读超时"的限流式主线程调用；"调色板 + 位打包 + 单文件 bundle"把上千个 chunk 的地图压成一次 IO，并用版本号做 HTTP 缓存协商。这套组合是可复制到其他"游戏内世界可视化"场景的。

---

## 11. `utils/` 与 `common/features/` —— 能力声明

### 11.1 `utils/Utils.java` 的实用件

- `md5`（`:30-48`）——刻意保留了手写 hex 拼接（注释说明为避免兼容性问题，不用 `HexFormat`）。**这是认证链的基元**。
- `isSafeFileName`（`:292-305`）：拒绝 null/空/含 `..`/含 `/` 或 `\`，再 `Path.normalize()` 校验非绝对、单段、名字不变。所有"用户提供文件名"的入口都走它。
- `normalizePath`（`:334-346`）：拒绝 `\`、拒绝前导 `//`、拒绝任何 `..` 段；**扩展路由与扩展页面 URL 都用它**。
- `isSafeFileName` / `normalizePath` 的组合是整套系统的路径穿越防线。
- `findAnnotatedMethods`（`:326-332`）：只扫 `getDeclaredMethods()`，**不遍历父类**——这正是 `@ExtensionLoad`/`@EventHandler` 必须在入口类自身声明的实现原因。
- 其他：`generateRandomHex(byteLength)`（`:201-210`）、`generateRandomCharSequence(len, specialChars)`（`:212-220`，字符集含 `@$`）、`stringifyThrowable`（`:184-191`，日志/控制台的异常序列化）、`hasClass`（`:233-240`，按类名探测平台能力）、`validateLocaleCode`（`:242-251`）、`gameTickToTime`（`:320-324`，Minecraft tick → `HH:mm`）。

### 11.2 `common/features/` —— 能力声明就是 Java 接口

这里**没有 feature flag 注册表、没有配置开关、没有 `FeatureManager`**。做法是：把"某些平台/版本才有的能力"定义成小接口，让平台实现类去 `implements`，调用方用 `instanceof` 探测。

四个能力接口：

| 接口 | 内容 | 实现者（示例） |
|---|---|---|
| `PaperRealtimeMotdFeature` | `CompletableFuture<String> getMotdAsync()`（`:5-7`） | `BasePaperServer`（`paper-helper/.../BasePaperServer.java:27`） |
| `PaperDimensionFeature` | `getNetherPath()` / `getTheEndPath()`（`:9-13`） | `BasePaperSave`（`paper-helper/.../BasePaperSave.java:25`） |
| `PaperConfigFeature` | bukkit/spigot/paper/leaves + 世界级 yml 的读写（`:11-77`，含路径 fallback：新版 `config/paper-global.yml` 不存在则回退 `paper.yml`，`:24-26`） | 各 Paper/Folia 版本 `PaperServer` |
| `CodeOfConductFeature` | `codeofconduct/<lang>.txt` 的增删查（`:15-58`，语言码与文件名双重校验） | Paper/Fabric/Forge 各版本 |

调用点全部是 `instanceof` 模式匹配 + 优雅降级：

```java
if(server instanceof PaperRealtimeMotdFeature feature) { ... }          // InfoController.java:56
if(!(server instanceof CodeOfConductFeature codeOfConductFeature)) { 503 } // ControlController.java:55-59
if(server.getServerType().isPaperSeries() && save instanceof PaperDimensionFeature feat) // SavesController.java:89
```

（见 `controller/api/InfoController.java:56`、`controller/api/ControlController.java:55,73,99,170,198,229,257`、`controller/api/SavesController.java:89,102,114`、`controller/api/VersionController.java:32`、`controller/openapi/OpenInfoController.java:40`。）

另一层能力探测是**服务端类型枚举**：`common/ServerType.java:3-27` 有 `PAPER/FABRIC/FORGE/NEOFORGE/FOLIA/LEAVES`，并提供 `isPaperSeries()`（`:21-27`）用于"Paper 系共享"的判断。还有 `Utils.hasClass(String)` 用于纯类存在性探测。

`common/OPanelServer.java` 是核心适配面（`:16-123`）：类型/版本/端口/MOTD、存档与维度、玩家与库存、封禁 IP、白名单、命令与 Tab 补全、游戏规则、reload/stop、游戏内时间、插件目录与启停、`getChunkAccessor()`。其中 `restart(int delay)` 是**带默认实现的跨平台重启**（`:62-102`）：Windows 用 `cmd /c start ... timeout N && <launchCommand>`；macOS 生成临时 `.command` 脚本 + `chmod +x` + `open`；Linux 用 `nohup bash -c 'sleep N && <launchCommand>'`（且对单引号做了 `'\\''` 转义）。启动命令来自 `StorageKey.LAUNCH_COMMAND`，缺省 delay 10 秒。`getPropertiesContent/writePropertiesContent` 是接口里的静态方法，直接读写 `server.properties`（`:111-123`）。

为什么重要：`instanceof` 能力探测把"平台差异"从**配置矩阵**（N 个版本 × M 个功能）变成了**类型系统**（类型实现了就有，没实现就 503）。新增一个能力只需要在 core 加一个接口、在需要的平台 `implements`，不需要维护任何开关表——这对 39 个版本模块的维护成本是决定性的。代价是能力对前端不可枚举（前端只能靠 API 返回 503/字段缺失来推断），以及 `Paper*Feature` 的命名把"能力"与"平台"耦合了（非 Paper 平台若想实现同一能力，接口名会显得别扭——`CodeOfConductFeature` 就没有平台前缀，是正确的写法）。

---

## 12. 构建体系：39 个版本模块如何共享代码

### 12.1 模块矩阵由 `platform-modules.json` 驱动

`platform-modules.json` 是一张 `平台 → { 目标模块 → [helper 模块...] }` 的两级表。统计下来：fabric 12、forge 13、neoforge 3、paper（含 folia）11 —— **共 39 个版本目标模块**，另有 6 个 helper（`fabric-config`、`fabric-helper`、`fabric-helper-unmapped`、`forge-helper`、`neoforge-helper`、`paper-helper`）。

`settings.gradle:29-53` 用它同时完成两件事：

```groovy
def platformModules = new groovy.json.JsonSlurper().parse(file('platform-modules.json'))
def buildTarget = providers.gradleProperty('buildTarget').orNull
platformModules.each { platform, modules ->
    modules.each { target, helpers ->
        if (buildTarget == null || target == buildTarget) {
            includedModules.addAll(helpers); includedModules.add(target)
        }
    }
    includedModules.each { module ->
        include module
        project(':' + module).projectDir = file(platform + '/' + module)   // 物理目录归档
    }
}
```

三个关键点：

1. **物理目录 ≠ Gradle 模块名**：`paper/paper-1.21.9` 归档在平台目录下，但 Gradle 里仍叫 `:paper-1.21.9`，模块间引用用 `project(":paper-helper")` 不需要平台前缀（`AGENTS.md` 也明确写了这条）。
2. **`buildTarget` 属性做单目标构建**：只 include 该目标的 helper + 自身；未知 target 直接抛 `GradleException`（`:35-37`）。CI 的单目标 job 就靠它（`.github/workflows/ci.yml:177`：`./gradlew -PbuildTarget="$BUILD_TARGET" ":$BUILD_TARGET:build"`），避免为一个版本编译 45 个模块。
3. **`apiOnly` 属性**（`:23-29`）：只 include `api`，供 API 单独发布（`.github/workflows/api-publish.yml`）；`buildTarget == null` 时才 include `example-extension`（`:53`）。

### 12.2 版本模块之间如何复用代码

`paper/paper-1.21.9/build.gradle` 展示了完整套路：

- `compileOnly(project(":paper-helper"))` —— helper 只参与编译（`:43`）；
- **但源码被直接内联编译**：`tasks.named('compileJava') { source(project(":paper-helper").sourceSets.main.allSource) }`（`:68-70`），资源同理 `from project(":paper-helper").sourceSets.main.resources`（`:83`）。这解释了 `@Rewrite` 注解存在的原因：helper 的类在版本模块里被**重新编译成本模块的类**，父类可能是同名但不同 ClassLoader 的类，`@Override` 会失效。
- `shadowJar` 打包：`shadowImplementation(project(":core"))` 并**排除 oshi**（`:39-42`，因为 oshi 由版本模块自己以 `implementation` 引入，避免重复）；`archiveBaseName.set(baseName + "-build")`、输出统一到根 `build/libs`（`:51-53`）。
- **依赖重定位**（`:55-61`）：gson、asm、nbtapi、kotlin、bstats、nimbusds、minidev 全部 relocate 到 `net.opanel.deps.*` —— 这是"插件跑在别人进程里"的必备动作，防止与服务器已有库冲突。（根 `build.gradle:36-42` 还给所有 shadowJar 补了一条 `relocate 'org.h2' → 'net.opanel.deps.h2'`，因为监控历史用了 H2。）
- 每个版本模块用 `baseName`（来自该模块 `gradle.properties`）+ 项目版本拼出 artifact 名；CI 侧 `build-matrix.mjs:25-28` 读同一个 `baseName` 生成矩阵里的 `artifact: ${baseName}-build-${version}`。

### 12.3 前端与后端如何合流

`frontend.gradle`（根 `build.gradle:60` 应用）把前端构建挂进每个版本模块的资源处理：

- 找出所有 target 项目（`:10-12`）；注册一个 `maxParallelUsages = 1` 的共享 `BuildService`（`:17-19`），**保证多模块并行构建时前端只跑一次/不并发**。
- `prepareFrontend`（`:21-37`）：执行 `npm run prelaunch` 准备 MC 资源与 wasm；`doFirst` 里硬校验 `node_modules/{vinext,vite,wasm-pack}` 存在，否则直接给出"先跑 npm ci"的明确报错（`:30-36`）。
- 每个 target 的 `buildFrontend`（`:54-75`）：以 `npm run build` 构建，环境变量来自该模块 `gradle.properties` 里 `frontend_env_*` 前缀的属性**去前缀转大写**（`:47-52`），再注入 `VITE_OPANEL_VERSION`、`OPANEL_FRONTEND_OUTPUT`；`doFirst` 校验必须有 `VITE_OPANEL_TARGET`（`:71-73`）。
- `processResources` 把产物 `client/` 拷进 jar 的 `opanel-web/`，并把 `vinext-rsc-compatibility-id` 文件一同打包（`:77-87`）——该文件正是 `BeforeController.loadRscCompatibilityId` 读的那个资源（`BeforeController.java:23,39-49`），用于 RSC 客户端导航。
- 构建输入的声明（`inputs.files(frontendSources)`、`inputs.properties(frontendEnv)`、`outputs.dir`，`:64-68`）让 Gradle 能正确增量/跳过前端构建。

### 12.4 CI 的构建矩阵与变更检测

`.github/scripts/build-matrix.mjs`（`createBuildMatrix`）：读 `platform-modules.json` + `gradle.properties` 的 `version`，逐一**校验**：target 名必须匹配 `^(fabric|forge|neoforge|paper|folia)-\d[\d.]*$`、不能重复、平台目录下必须存在 `build.gradle`、必须能从 `gradle.properties` 读到 `baseName`（`:14-31`）。**矩阵本身是"配置即校验"**，配置错了直接失败而不是静默少构建。还有配套的 `build-matrix.test.mjs` 在 CI 里跑（`ci.yml:52-54`）。

`.github/scripts/detect-builds.mjs`（`selectBuilds`）是变更影响分析（`:39-117`）：

- 忽略规则：`.md`、`.gitignore`、若干目录（`.agents/`、`.idea/`、`images/`、`example-extension/`…）、发布相关 workflow（`:8-31`）。
- 分类升级规则：
  - 改了 `ci.yml`/`detect-builds.mjs` → 全量（含 pumpkin + 前端检查）；
  - `frontend/**` → 全部 Java target + pumpkin + 前端检查；
  - `pumpkin/**`、`Cargo.toml/lock` → pumpkin；
  - `api/**` 或 `core/**` → 全部 Java target；
  - `gradle/**`、`build.gradle`、`settings.gradle`、`frontend.gradle`、`platform-modules.json`、`gradle.properties`、`gradlew*`、矩阵脚本 → 全部 Java target（其中 `frontend.gradle` 还额外触发前端检查）；
  - 其他文件按 `<platform>/<module>` 查表，命中的话**只需构建"该模块本身或把它列为 helper"的 target**（`:84-92`）；命中不了但平台已知 → 全量（`:93-98`，防止新增/删除模块被漏掉）；平台都不认识 → 全量 + 前端检查（`:99-102`）。
- `collectChangedFiles`（`:121-160`）：用 `git diff --name-only --no-renames -z base head` 取变更文件；PR 用 `merge-base`；浅克隆时 `--deepen=256` 补齐历史；**只有"Git 历史不可用"才回落全量**，配置错误必须抛错失败而不是静默变空矩阵（`:162-168` 的注释明确写了这个原则）。
- 输出写进 `$GITHUB_OUTPUT` 与 Step Summary（`buildSummary`，`:170-182`），让人能直接在 CI 页面上看到"为什么构建了这些"。

`ci.yml` 的 job 拓扑：`changes`（跑 detect + 矩阵自测）→ `prepare`（npm ci + prelaunch，产出 `frontend-prepared` artifact，只含 `frontend/assets/minecraft` 与 `frontend/wasm-lib/pkg`，`ci.yml:79-87`）→ `frontend-check`（lint/typecheck/test/wasm:test）→ `jar`（矩阵并行，JDK 同时装 25/21/17/14 并用 `JAVA_HOME=$JAVA_HOME_25_X64` 构建，`:154-177`）→ 独立 `pumpkin-check`/`pumpkin`（Rust，5 个原生 target）→ 汇总 job `ci` 用 `always()` + 判定所有 needs 结果（`:301-322`）。

为什么重要：**唯一的模块清单事实源是 `platform-modules.json`**，三处消费它且各有校验：`settings.gradle`（决定 include 什么）、`frontend.gradle`（决定哪些模块要构建前端）、CI 脚本（决定矩阵与增量范围）。新增一个游戏版本 = 加一条 JSON + 建一个目录，不需要改任何构建脚本。这是 39 个模块能长期维护的关键机制，也是这份仓库里最值得复制的构建工程实践。

---

## 13. 值得借鉴的做法（清单）

1. **挑战-响应登录 + 三层哈希**：客户端永不发送可复用凭据，服务端挑战一次性消费（`CramChallengeStore.consume`）。挑战池有 IP 与全局容量上限，天然抗资源耗尽。
2. **JWT + 服务端会话白名单**：无状态令牌负责承载，白名单负责"立即吊销"；CAS 限频清理避免全表扫描。
3. **角色声明 + 单一前置过滤器**：路由忘标角色返回 500 而不是放行（`BeforeController.java:59-65`），把配置错误变成显式失败。
4. **能力用接口 + `instanceof` 表达**，而不是配置矩阵；缺失能力统一回 503 而不是 500。
5. **WS 慢消费者治理**：限帧（1024）+ `WritePendingException` 检测 + 1013 主动断开；异常静默处理以防污染游戏日志。
6. **高频事件批量合并**：玩家移动 1 秒合并、地图脏块 5 秒批量 64 个、bundle 写盘 5 秒去抖、关服同步 flush。
7. **时间序列三级降采样**：只存 sum/min/max/count，分钟→刻钟→小时滚动 + 分区保留期；查询时按 maxPoints 反推输出分辨率，硬约束返回点数。
8. **H2 嵌入式 + `available` 标志 + 自动重开**：把"可选的重型特性"做成可失败、可自愈、可降级的模块。
9. **扩展沙箱边界清晰**：独立可发布的 api 模块 + 受限 ClassLoader（只共享 api 与 Javalin）+ 事件白名单 + 统一 `/api/extension/{extId}/` 命名空间 + 加载期签名/元数据校验。
10. **卸载秩序**：`deactivate`（停收）→ 写锁等待在途派发 → 调 `unload()` → `invalidate()` API → 关 classloader/JarFile。
11. **下载能力令牌**：`/file/{随机ID}/{name}`，一次性消费，杜绝路径暴露。
12. **构建矩阵单一事实源 + 变更影响分析**：配置即校验，未知输入一律升级为全量构建（宁可多建，不可漏建）。

## 14. 局限与风险（阅读源码时注意到的问题）

| 位置 | 现象 | 影响 |
|---|---|---|
| `JwtManager.java:15` | 签名密钥进程内随机 | 重启/热重载即全员掉线；无法多实例 |
| `JwtManager.java:20` | 无 refresh token，24h 固定 | 长会话用户被迫重新登录 |
| `StorageFile.java:116-119` | 非原子写（无 temp+rename） | 写入中途崩溃 → 文件损坏 → 下次 `read()` 回落默认值，**整份配置丢失** |
| `StorageFile.java:121-145` | "以默认值为模板补键"式迁移 | 无法处理删除字段/改类型/改语义；无 schema 版本号 |
| `MonitorHistoryStore.java:181-183` | schema 版本不匹配直接抛异常 | 升级只能弃库，无迁移路径 |
| `LoginAttemptTracker` | 内存态、IP 维度、重启清零 | 代理池/IPv6 可绕过；`proxyHeaders=true` 时若直连公网可伪造 `X-Forwarded-For`（`BaseController.java:105-139`） |
| `OidcController.java:145` | 绑定口令用 `String.equals` 而非常量时间比较，且请求体里带的是可复用的 hashed 2 | 与 CRAM 路径的硬化水平不一致；该请求被截获即等价泄露口令 |
| `TaskCommandExecutor.java:27-39` | `@goto` 解析完整但执行器整段注释 | DSL 有半成品语法，用户可写但无效 |
| `TasksController.java:47 vs 66` | `createTask` 解 base64，`updateTask` 不解 | 编辑任务时若沿用 query/body 约定会导致名称错乱 |
| `MapController.java:25,31,53` | 地图开关用启动快照 `originalEnabled` | 运行时切换地图总开关后 tile 接口不生效，需重启 |
| `BaseEndpoint.java:48-53` | WS 鉴权在握手之后 | 未授权连接也会占用一次完整的 WS 升级 |
| `TerminalEndpoint.java:59` | 连接即回放最多 20000 行日志 | 单帧体积可能很大，弱网/移动端首帧延迟明显 |
| `frontend/lib/ws/index.ts:40-47` | 无自动重连 | 断线需用户手动刷新 |
| `extension/ExtensionManager.java:56` | 扫描目录时用 `Files.list` 未过滤符号链接 | 极端情况下可被指向目录外的 jar（但要求攻击者已能写 `opanel/extensions`） |

---

## 15. 一页速查：数据流总览

```
浏览器
  │  Cookie: token (JWT, HS256, 24h)            WS: {"type","data"} (Cookie 鉴权, 1008 拒绝)
  ▼                                             ▼
Javalin/Jetty ── beforeAll ── beforeMatched(authToken: PUBLIC/PANEL_SESSION/PANEL_OR_MCP)
  │                                   │                      │
  │ /api/**  → controller/api/*       │ /open-api/**  → BeforeController.handleOpenAPI → controller/openapi/*
  │ /panel/ext/... → ExtensionPageController(宿主页) → iframe → jarball web/**
  │ /api/extension/{id}/** → routeExtensionBackend(切换 TCCL) → 扩展 Handler
  │ /file/{id}/{name} → DownloadController(一次性令牌)
  ▼
Service 层（core 单例，全部由 OPanel 构造器装配）
  ├ ScheduledTaskManager  ──cron-utils + 自续期──▶ TaskCommandExecutor ──▶ OPanelServer.sendServerCommand
  ├ MonitorManager ──1s 采样──▶ ArrayDeque[200] + MonitorHistoryManager ──▶ H2(分钟/刻钟/小时金字塔)
  ├ MapRenderManager ──预渲染 mca / 脏块 5s×64──────────────────────────▶ mapdata/<save>.otiles (原子替换)
  ├ ExtensionManager ──URLClassLoader(api+javalin 白名单)──▶ ExtensionEventDispatcher
  ├ ActivityManager / OidcManager / Uptimer
  └ EventManager（进程内同步总线）
        ├ PLAYER_JOIN/LEAVE/MOVE/GAMEMODE_CHANGE ← 平台监听器
        ├ PLAYER_INVENTORY_CHANGE ← 1s 轮询 inventory.getHash()
        └ CHUNK_DIRTY / DIRTY_CHUNKS_FLUSH ← 平台方块事件 / 地图 flush
              └─▶ WS Endpoints（Players/Inventory/Terminal/Map/Monitor）──▶ broadcast
平台边界：OPanelServer + common/features/*（instanceof 探测）+ OPanelChunkAccessor（同步回主线程，5s 超时）
```
