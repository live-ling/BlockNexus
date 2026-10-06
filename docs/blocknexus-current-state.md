# BlockNexus 现状能力清单（Current-State Capability Inventory）

> 审计对象：`D:\11493\Desktop\BlockNexus` —— Minecraft 服务器管理面板（本地 Express + WebView2 外壳 → SSH 部署到远程 Linux 的零依赖单文件 Agent）。
> 审计方式：只读代码走查 + 反向 grep 验证。所有结论附 `file:line`；**未读到的东西一律标注「不存在」并说明验证手段**。
> 本次审计**未修改任何代码**，只新增本报告。
>
> 规模基线：
> - `panel/api.js` 2928 行（79 处 `router.*()` 注册，其中 5 处为循环生成 → 展开后 **86 条**具体路由）
> - `panel/agentlink.js` 507 行、`panel/ssh.js` 475 行、`panel/localagent.js` 326 行
> - `agent/src/**` 23 个源模块 → 打包产物 `agent/agent.js`（193,912 字节 / 4598 行，零依赖；`node agent/build.js --check` 实测同步）
> - `web/src` 122 个 `.ts/.tsx`（其中 101 个 `.tsx`）；依赖 `react@19` / `vite@8` / `tailwindcss@4`（`web/package.json:12-36`）

---

## 0. 能力速览矩阵（Capability at a Glance）

| 维度 | 现状 | 关键判据 |
| --- | --- | --- |
| 认证 | 单管理员 + 会话 Cookie，可关闭 | `panel/config.js:18`、`panel/api.js:554-565` |
| 多用户 / RBAC | **无** | 无用户表、无角色标识符 |
| HTTP API Token | **无** | 仅 Agent WS 专用 token（`panel/config.js:142`） |
| OIDC / SSO / MFA | **无** | 全仓库 grep 零命中 |
| CSRF | JSON Content-Type 白名单 + `SameSite=Lax`，**无 token** | `panel/api.js:315-321` |
| 会话持久化 | **无**（内存 Map，重启全掉） | `panel/api.js:87` |
| 实时通道 | **仅 SSE 单向下行**，无 WebSocket、无事件续传 | `web/src/lib/sse.ts:50`、`panel/api.js:2906-2916` |
| Agent 协议 | 自研 RFC6455 子集 + AES-256-GCM 帧 + 双向 token 握手 | `agent/src/ws.js:24-324`、`panel/crypto.js:48-95` |
| 请求关联 | `id` + promise map + 每请求超时（默认 30s） | `panel/agentlink.js:449-468` |
| 文件传输 | 512 KB 串行分块 + 断点续传（含 Agent 重启续传）；SFTP 旁路 | `agent/src/instance/fs.js:202-331`、`panel/api.js:2713-2736` |
| HTTP API | 86 条路由，**响应信封不统一**，错误统一 `{error}` | `panel/api.js:2920-2923` |
| i18n | **完全没有**；68/122 源文件硬编码中文 | `web/src/lib/sse.ts` 无 i18n、`web/index.html:2` |
| MC 域建模 | 只有 **server.properties(62 键) + 通用配置编辑 + SLP/玩家/图标** | `web/src/lib/properties.ts:20-166` |
| NBT / 物品 / 地图 / gamerule / § 富文本 / 皮肤 | **全部不存在** | 三处分别 grep 零命中 |
| 调度 | Agent 侧 30 秒轮询，daily/interval，落盘 `blocknexus.json` | `agent/src/instance/watchdog.js:46-63` |
| 前端测试 | **零**（无 vitest/jest/RTL/e2e） | `web/package.json:6-11`、`:27-36` |
| Agent 测试 | 11 个零依赖脚本，≈120+ 断言，**不在 CI 中执行** | `package.json:11`、`.github/workflows/ci.yml:9-25` |
| 产物平台 | **仅 Windows x64**，无构建矩阵、无容器化 | `scripts/build-release.ps1:38`、`:70` |
| 发版 | 手工 `gh release create`，CI 只做语法检查 + 前端构建 | `ci.yml:3-40` |

---

## 1. Auth / Session（认证与会话）

### 1.1 存在的东西

| 项 | 实现 | 引用 |
| --- | --- | --- |
| Cookie 名 | `blocknexussid` | `panel/api.js:14` |
| 会话存储 | **进程内 `Map<sid, {exp, remember}>`**，无任何持久化 | `panel/api.js:87` |
| 会话 TTL | 默认 7 天；勾「记住我」30 天 | `panel/api.js:15-17` |
| 滑动续期 | 每次命中会话即重写 `exp` | `panel/api.js:560` |
| Cookie 属性 | `HttpOnly; SameSite=Lax; Path=/`（+可选 `Max-Age`） | `panel/api.js:356`、`:363`、`:625` |
| 登出 | 删除该 sid + 清 Cookie | `panel/api.js:360-365` |
| 凭据存储 | `data/config.json` 的 `panel.username` + `panel.passwordHash` | `panel/config.js:18`、`:44-47` |
| 密码哈希 | `scryptSync(password, salt, 32)`，16 字节随机 hex 盐 | `panel/config.js:10-12`、`:98-99` |
| 比较方式 | 用户名与密码都对 SHA-256 定长摘要做 `timingSafeEqual`（防时序/长度泄露） | `panel/config.js:110-122` |
| 开关 | `panel.authEnabled`，**默认 `false`**（本地服务免密）；关闭时中间件直接放行 | `panel/config.js:18`、`panel/api.js:554-565` |
| 启动期强制开启 | `BLOCKNEXUS_PASSWORD` / `BLOCKNEXUS_USERNAME` | `panel/server.js:35-42` |
| 登录失败限流 | 同 IP 连续 5 次失败 → 锁 5 分钟（锁定期内即使密码正确也拒） | `panel/api.js:325-347` |
| 面板自身 TLS | 可选 `--tls-cert/--tls-key`（自签或正式证书） | `panel/server.js:24-25`、`:74-79` |

### 1.2 忘记密码（三段式 OTP）

- 步骤 ①`POST /api/forgot-password`：6 位数字验证码，**只存 SHA-256 摘要**，15 分钟有效（`panel/api.js:441-445`）；发码限流为同 IP 60 秒冷却 + 每小时 5 次（`panel/api.js:389-391`、`:413-430`）；邮箱不匹配或未配 SMTP **也计数并返回成功**，避免探测管理员邮箱（`panel/api.js:432-439`）。
- 步骤 ②`POST /api/verify-reset-code`：通过后作废验证码并发放**一次性改密票据**（10 分钟，`panel/api.js:395`、`:499-501`）；同 IP 连错 5 次锁 15 分钟，单个验证码全局试错上限 20 次（防多 IP 爆破 6 位数字）（`panel/api.js:392-394`、`:474-493`）。
- 步骤 ③`POST /api/reset-password`：只认票据（兼容旧邮件链接 token），成功后 `sessions.clear()` **所有会话下线**（`panel/api.js:505-537`）。
- 限流记录有 GC 任务，每 60 秒清理 `forgotSent` / `verifyFails` / `resetTickets`（`panel/api.js:540-551`）。

### 1.3 CSRF 方案

- **无 CSRF token**。唯一防护是中间件：`POST` 必须 `Content-Type: application/json`（跨域 HTML 表单无法伪造），例外是 SFTP 直传的 `application/octet-stream`（`panel/api.js:315-321`）。
- 叠加 `SameSite=Lax` Cookie（`panel/api.js:356`）+ 全库无 CORS 中间件、无 `Access-Control-*` 响应头（`package.json:20-25` 仅 `express/nodemailer/ssh2/ws`）→ 跨站读写均被浏览器拦。
- 注意：该中间件**只检查 `POST`**；`PUT`/`DELETE` 未覆盖（`panel/api.js:316`）。原生 HTML 表单无法发 `PUT/DELETE`，故实际风险低，但防护面比看起来窄。

### 1.4 明确不存在（ABSENT）

- **多用户：不存在。** 只有一个 `panel.username` 单值字段（`panel/config.js:18`），没有任何用户列表 / 用户表 / `users[]`。
- **RBAC / 角色 / 权限：不存在。** 无 role、permission、scope、ACL 之类的任何标识符；`/api/me` 只回 `port/authEnabled/version`，**连用户名都不回**（`panel/api.js:367-374`）。README 路线图自己把「多用户与细粒度权限」列为未完成项（`README.md:422`）。
- **HTTP API Token：不存在。** 没有 `apiToken`、`api_key`（面板自身）、`X-API-Key`、PAT 机制。唯一的 token 是**每台服务器一个**、仅用于 Agent WS 通道的 256-bit 随机串（`panel/config.js:142`、`panel/crypto.js:97-99`），不用于 HTTP 认证。
- **审计日志 / 登录记录 / 会话列表：不存在。** 没有会话查看或踢出接口，`sessions` 是纯内部 Map。
- **会话持久化：不存在。** 面板重启即全体下线（`panel/api.js:87`）。同理 `resetTickets`（`panel/api.js:399`）与 `loginFails`（`panel/api.js:327`）均为内存态。
- **OIDC / SSO / OAuth / SAML / LDAP / Passkey / WebAuthn / TOTP / 2FA：全部不存在。** 对整个仓库 grep `oidc|oauth|saml|ldap|passkey|webauthn|totp|2fa|mfa`（含 `agent/agent.js` 产物）零命中。
- **密码策略：不存在。** 只有「至少 6 位」这一条硬校验（`panel/api.js:508-510`、`:614-618`）；无强度、无过期、无历史、无锁定阈值配置。
- **`Secure` Cookie 标志：不存在。** 即便面板以 HTTPS 启动，`Set-Cookie` 也只写 `HttpOnly; SameSite=Lax; Path=/`（`panel/api.js:356`、`:363`、`:625`）。
- **`trust proxy`：不存在。** 全 `panel/*.js` grep `trust proxy|trustProxy` 零命中。后果：放在反向代理后时 `req.ip` 恒为代理地址 → 登录限流与验证码限流退化为**全局限流**（任一攻击者可把所有人锁在门外）；同时 README 推荐「面板前加 HTTPS 反向代理」（`README.md:118`、`:461`）。
- **安全响应头：不存在。** 无 helmet、无 CSP / HSTS / `X-Frame-Options` / `X-Content-Type-Options`；只有 `app.disable('x-powered-by')`（`panel/server.js:45`）。
- **`loginFails` 无 GC。** 只有 `forgotSent`/`verifyFails`/`resetTickets` 被定时清理（`panel/api.js:540-551`），`loginFails`（`panel/api.js:327`）永不清理 → 每个新来源 IP 留一条永久记录。
- **暴力破解防护上游：不存在。** 无 fail2ban 集成、无验证码、无指数退避、无 IP 白名单。

---

## 2. Realtime Transport（浏览器实时通道）

### 2.1 传输方式：**仅 SSE，无浏览器 WebSocket，无轮询兜底实时**

- 前端唯一入口：`new EventSource('/api/events')`（`web/src/lib/sse.ts:50`），全局单例（`es`），订阅者放 `Set`（`web/src/lib/sse.ts:45-46`）。
- 服务端：`GET /api/events` 手写 `text/event-stream` 响应头（含 `X-Accel-Buffering: no`，为 nginx 反代准备），先发 `data: {"type":"hello"}\n\n`，把 `res` 塞进 `sseClients: Set`，`req.on('close')` 时移除（`panel/api.js:2906-2916`）。
- 广播实现：`bus.on('broadcast')` 把消息 `JSON.stringify` 成 `data: ...\n\n` 写给所有客户端（`panel/api.js:128-135`）。
- 心跳：服务端每 25 秒写 `:hb\n\n` 注释帧（`panel/api.js:136-142`）——仅防中间代理断连，前端不解析。

### 2.2 事件信封（exact shape）

服务端发出的一律是**单层 JSON 对象**，`data:` 行内容即对象本身，无 `event:` 名、无 `id:`：

```
data: {"type":"<discriminant>","serverId":"<srv_xxx>", ...type-specific}\n\n
```

- **无 `id:` 行 → 无 `Last-Event-ID` 断点续传**（`panel/api.js:128-135` 只写 `data:`）；前端也不读 `ev.lastEventId`（`web/src/lib/sse.ts:51-58`）。
- 重连完全交给浏览器 `EventSource` 内建行为，前端 `es.onerror = () => {}` 空实现（`web/src/lib/sse.ts:59`）——**无自定义指数退避**。
- 不支持多路复用 / 房间 / 按 serverId 的服务端过滤：**所有事件广播给所有浏览器**，客户端自行过滤（`web/src/lib/sse.ts:75-80` 的 `subscribeServer`）。

### 2.3 事件类型全集（服务端 → 浏览器）

判别字段 `type`，闭集如下（定义处 `web/src/lib/sse.ts:3-38`）：

| `type` | 负载字段 | 产生点 |
| --- | --- | --- |
| `hello` | 无 | `panel/api.js:2913`（连接建立时一次性） |
| `status` | `serverId, status` | `panel/agentlink.js:325` |
| `latency` | `serverId, latency` | `panel/agentlink.js:427-431`（RTT 最小值） |
| `stats` | `serverId, stats{memTotalMB,memUsedMB,disk{totalGB,freeGB}}` | `panel/api.js:153` |
| `agent-event` | `serverId, event, data` | `panel/agentlink.js:497-502`；`panel/api.js:1532`、`:2497` |
| `install` | `serverId, log?, done?, ok?, error?` | `panel/api.js:907`（`taskLogReset(...,'install')`）+ `:117`、`:124` |
| `uninstall` | 同上 | `panel/api.js:2776`、`:2884` |
| `agent-update` | `serverId, state:'updating'\|'failed'\|'done', remote?, bundled?, log?, error?` | `panel/api.js:266` |

`install` / `uninstall` 是 `taskLog(serverId, kind, text)` 用 `type: kind` 动态产生的（`panel/api.js:111-125`），`kind ∈ {'install','uninstall'}`，**不是字面量**——即 `type` 集合其实是半开放的。同一条日志还被服务端缓存在 `taskLogs: Map\`${serverId}:${kind}\`` 里（上限 256 KB，`panel/api.js:95-96`、`:115`），供刷新后经 `GET /servers/:id/task-log` 重放（`panel/api.js:2831-2842`）。

嵌套的 `agent-event.event` 子事件集合（由 Agent 经加密通道上报后原样透传）：

`hi`（上线信息，`panel/agentlink.js:481-486`）、`console`（`agent/src/instance/manager.js:201`）、`instance.updated`（`agent/src/instance/manager.js:208`、`lifecycle.js:276`）、`install.progress`（`agent/src/instance/core.js:188`、`java.js:63`）、`java.updated`（`agent/src/instance/java.js:207-209`）、`backup.updated`（`agent/src/instance/backup-schedule.js:60/74`、`agent.js:279-288`）、`watchdog.fired`（`watchdog.js:77`）、`watchdog.restarting`（`watchdog.js:103`）。

### 2.4 第二条独立的 SSE 流：AI 日志分析

不能用 `EventSource`（要 POST + 带 body），改用 `fetch` + `res.body.getReader()` 手动切 `\n\n` 帧（`web/src/lib/api.ts:479-555`，服务端 `panel/api.js:2218-2257`）。该流的信封是**另一套** `{type:'meta'|'delta'|'done'|'error'}`（`panel/api.js:2225`、`:2236`、`:2238-2250`、`:2252`）——与 `/api/events` 的信封**不共享类型**。

### 2.5 轮询（非实时，作为补充）

前端有 4 处 `setInterval`：在线玩家 20 秒（`web/src/pages/instance-detail.tsx:153`、`server-detail.tsx:89`）、spark 统计 15 秒（`web/src/components/spark-panel.tsx:132`）、纯 UI 时钟 30 秒 `forceTick`（`instance-detail.tsx:154`、`server-detail.tsx:90`、`servers.tsx:47`）。面板侧后台定时器：资源快照 30 秒（`panel/api.js:156-158`）、SSE 心跳 25 秒（`panel/api.js:136-142`）、Agent 外向连接收敛 15 秒（`panel/agentlink.js:154`）、Java 安装轮询最长 15 分钟（`panel/api.js:2478-2512`）。

### 2.6 明确不存在（ABSENT）

- 浏览器 WebSocket：不存在（前端无 `new WebSocket`）。
- 事件 ID / 断点续传 / 事件回放缓冲区：不存在。
- 服务端按订阅过滤（谁关心哪台服务器）：不存在，全量广播。
- 共享类型契约：不存在。前端类型是**手写 TS union**（`web/src/lib/sse.ts:3-38`），后端 `bus.emit('broadcast', {...})` 是**无类型裸对象**（`panel/api.js:117` 等）；两侧靠人肉对齐，无 codegen、无 JSON Schema、无共享包。
- 事件版本号 / 兼容协商：不存在。

---

## 3. Agent Protocol（面板 ↔ Agent 加密协议）

### 3.1 连接方向与握手（双向认证）

两个方向协议完全一致（`panel/agentlink.js:6-12`、`agent/src/ws.js:334-337`）：

```
client → server  {t:'hello', v, panel?/agent?, serverId, ts, nonce}   明文
server → client  {t:'challenge', nonce}
client → server  {t:'proof', proof = HMAC(kProof,'auth1'||nonceC||nonceP)}
server → client  {t:'ready',  proof = HMAC(kProof,'auth2'||nonceC||nonceP)}
之后全部为加密二进制帧
```

- 握手实现：面板侧 `runHandshake()`（`panel/agentlink.js:49-142`），Agent 侧 `runHandshake()`（`agent/src/ws.js:354-443`）——**两份几乎逐行等价的独立实现**，无共享代码。
- 双向认证：两个方向都校验对方 proof（`panel/agentlink.js:114`、`:124`；`agent/src/ws.js:423`、`:433`），任一方未持有 token 都无法建链。
- 时钟偏差检查：5 分钟（`panel/agentlink.js:19`、`:88`；`agent/src/ws.js:400`）。
- 握手超时：15 秒（`panel/agentlink.js:18`、`:59`；`agent/src/ws.js:355`）。
- 服务端角色按 `hello.serverId` 查 token（inbound：`panel/agentlink.js:178-182`；Agent listen 模式只服务单一身份并校验 id：`agent/src/ws.js:396-399`）。
- WS 升级路径固定 `/agent/ws`，面板侧不匹配即 `socket.destroy()`（`panel/agentlink.js:160-173`）。
- 「面板连 Agent」时 URL 由 `agentUrl()` 拼装：`{ws|wss}://{agent.host||host}:{agent.port||3099}/agent/ws`（`panel/agentlink.js:196-200`）；「Agent 连面板」时用 `panelWsUrl()` 把面板地址规范化后追加 `/agent/ws`（`agent/src/ws.js:327-332`）。
- 面板侧 WS 服务端 `maxPayload: 8MB`（`panel/agentlink.js:151`）；Agent 侧自研 WS 对 64MB 以上帧直接 close（`agent/src/ws.js:127-130`）。

### 3.2 加密分帧（encryption framing）

- 帧格式：`[0x01 版本][4B nonce 前缀][8B 计数器 BE][AES-256-GCM 密文][16B tag]`，`AAD = 计数器字节`（`panel/crypto.js:7`、`:54-68`）。
- 计数强制单调递增 → 重放帧直接抛错（`panel/crypto.js:83`）；`Sealer` 每个方向一个，前缀随机 4 字节（`panel/crypto.js:51`）。
- 会话密钥：`HKDF-SHA256(token, salt = nonceC||nonceP)`，派生 `kA2P`/`kP2A`/`kProof` 三把（`panel/crypto.js:23-32`）。
- ⚠ 密钥派生 info 标签**至今仍是 `'mcpan/a2p'` / `'mcpan/p2a'` / `'mcpan/proof'`**，为兼容旧 Agent 刻意保留（`panel/crypto.js:25-31` 有明确注释）。
- 方向绑定：Agent 用 `kA2P` 发 / `kP2A` 收（`agent/src/agent.js:128-129`），面板相反（`panel/agentlink.js:363-364`）。
- 解密失败 → 立刻踢连接重来（`panel/agentlink.js:376-381`）。
- 可选传输层 TLS：`wss://` + 自签证书 + **SHA-256 指纹固定**（安装时记录，每次连接比对，不一致断开）（`panel/agentlink.js:202-224`、`:207-224`；证书由服务器上的 `openssl` 生成并回传指纹：`panel/ssh.js:360-383`）。面板侧 `rejectUnauthorized: false`（`panel/agentlink.js:250`），安全性由 token 双向认证 + 指纹固定保证；Agent 侧有 `--insecure`/`tlsInsecure` 逃逸阀（`agent/src/config.js:55`、`agent/src/ws.js:65`）。
- 已知限制（README 自述）：不能防主动 MITM（`README.md:118`）。

### 3.3 请求/响应关联（id? promise map? timeouts?）

- **三样都有**：
  - 消息形状：`{t:'req', id, action, params}` → `{t:'res', id, ok, result}` 或 `{t:'res', id, ok:false, error}`（`panel/agentlink.js:466`、`:471-477`；Agent 侧 `agent/src/agent.js:166-171`）。
  - `id` 生成：`'r' + ++seq + '_' + crypto.randomBytes(4).toString('hex')`（`panel/agentlink.js:450`）。
  - **Promise map**：`this.pending: Map<id, {resolve, reject}>`（`panel/agentlink.js:365`、`:456-465`；`onMessage` 里 `pending.get(obj.id)` 命中才 resolve，`if (!p) return` 静默丢弃未知 id：`panel/agentlink.js:471-473`）。
  - **超时**：每请求一个 `setTimeout`，默认 30 秒（`panel/agentlink.js:449-455`），可被调用方覆盖（`panel/agentlink.js:335`：`request(serverId, action, params, timeoutMs=30000)`）。
  - 连接断开时**批量 reject 所有 pending**，错误码 `AGENT_OFFLINE`（`panel/agentlink.js:385-386`）。
  - 错误码分类：`AGENT_OFFLINE` / `AGENT_TIMEOUT` / `AGENT_ERROR`（`panel/agentlink.js:338`、`:454`、`:476`）。
- 只读请求自动重试一次：`agentRead()` 对 `AGENT_OFFLINE` 先 `waitOnline(5s)`，对 `AGENT_TIMEOUT` 直接重试（`panel/api.js:957-976`）。
- **无背压 / 无并发上限 / 无请求优先级 / 无取消**（除超时）；`pending` 无大小上限。
- Agent 侧动作表是 `switch (action)`，约 **60 个 case**，未匹配抛「未知操作」（`agent/src/agent.js:196-341`）。

### 3.4 重连 / 退避 / 心跳

| 侧 | 机制 | 引用 |
| --- | --- | --- |
| 面板→Agent（outbound） | 指数退避 3s → ×2 → 上限 30s；成功即重置为 3s | `panel/agentlink.js:240`、`:267`、`:282-283` |
| 面板连接集合收敛 | 每 15 秒 `syncOutbound()` 按配置增删，启动后 500ms 先跑一次 | `panel/agentlink.js:154-155`、`:227-236` |
| Agent→面板（client 模式） | 指数退避 1s → ×2 → 上限 30s；断线统一在 close 处理器排程 | `agent/src/agent.js:108`、`:90-109` |
| 心跳 | 面板侧每 30 秒 `ws.ping()`，测 RTT；连续 **2 次无 pong** 判定半开死链 → 主动断开触发重连 | `panel/agentlink.js:395`、`:401-416` |
| RTT 口径 | 保留最近 5 个样本取**最小值**（规避事件循环抖动），经 SSE `latency` 广播 | `panel/agentlink.js:418-432` |
| 日志降噪 | 相同失败原因 5 分钟内只记一次（两侧各有一套实现） | `panel/agentlink.js:24-34`；`agent/src/agent.js:33-39` |
| Agent listen 模式 | 无需重连；握手失败只 close，继续等下一条连接 | `agent/src/agent.js:143-150` |
| 连接接管 | 新连接接入时踢掉旧连接（`old.kick('新连接接入')`） | `panel/agentlink.js:310-316` |

### 3.5 文件上传/下载分块

**上行（浏览器 → 面板 → Agent）**，两条通道：

1. **加密通道分块（默认）**，块大小 **512 KB**（`web/src/lib/upload.ts:45`、`agent/src/instance/fs.js:210`）：
   - `fs.upload.begin {name, dir, filename, size, lastModified, resume}` → `{uploadId, chunk:524288, received, resumed}`（`agent/src/instance/fs.js:202-283`）；
   - `fs.upload.chunk {uploadId, seq, dataB64, seekTo}`，**`seq` 必须严格等于 `up.seq + 1`，否则抛「分块乱序」并把 `received` 附带在 error 上**供浏览器重新对齐（`agent/src/instance/fs.js:295-299`）；
   - `fs.upload.finish` 把 `<final>.blocknexus-upload` 原子 rename 成最终文件并删 meta（`agent/src/instance/fs.js:308-317`）；`fs.upload.abort` 清 tmp（`:319-331`）。
   - **数据是 base64 塞在 JSON 里再进加密帧**（`agent/src/instance/fs.js:300`）→ 有效载荷约 1.37 倍膨胀；单块 base64 后 ≈683 KB，仍低于面板 `express.json({limit:'1mb'})`（`panel/server.js:46`）。
   - **断点续传**：磁盘 semi 文件 `<final>.blocknexus-upload` + 指纹 sidecar `.blocknexus-upload.meta`（`{final, size, lastModified, at}`），指纹不符即作废（`agent/src/instance/fs.js:208-209`、`:232-254`）；Agent 重启后会话虽丢，但按 size 从磁盘接力（`agent/src/instance/fs.js:201`、`:244-254`）。半块按 chunk 对齐截断：客户端发 `seekTo`，Agent 执行 `fs.truncateSync(tmpPath, pos)`（`web/src/lib/upload.ts:48-49`、`agent/src/instance/fs.js:288-294`）。
   - 重试策略：**每块原样重试 1 次**，再失败就重新 `begin` 对齐（最多 8 次 recovery，`web/src/lib/upload.ts:59-93`）；面板代下推送文件用同协议、最多 6 次 recovery（`panel/api.js:1462-1512`）。
   - 并发：**严格串行**，无并行分块、无 Web Worker、无客户端哈希。
   - 单文件上限 **200 MB**（`agent/src/instance/fs.js:207`）。
   - 会话 GC：每 10 分钟扫一次，上传会话 2 小时、下载会话 30 分钟（`agent/src/instance/fs.js:371-393`、`agent/src/instance/manager.js:25`）。
2. **SFTP 直传（旁路）**：浏览器 `XHR` 以 `application/octet-stream` 单请求推给面板，面板用保存的 SSH 凭据经 `ssh2` SFTP 流直写实例目录，**无 200 MB 上限**（`web/src/lib/upload.ts:118-151`、`panel/api.js:2692-2736`、`panel/ssh.js:260-297`）。需要 SSH 凭据且 Agent 至少上线过一次（否则 `instancesDir` 未知，`panel/api.js:2721-2724`）。前端用 `xhr.upload.onprogress` 拿进度（`web/src/lib/upload.ts:135-139`）。通道选择 UI 见 `web/src/components/upload-channel.tsx:14-51`。

**下行（Agent → 面板 → 浏览器）**：拉取式分块，块同为 512 KB：`fs.download.begin` → `{downloadId,size,chunk}`，随后循环 `fs.download.chunk` 直到 `eof`，最后 `fs.download.finish`（`agent/src/instance/fs.js:333-369`）；面板边拉边 `res.write` 流式回浏览器（`panel/api.js:2739-2763` 文件、`panel/api.js:2393-2419` 备份）。**无 Range 请求支持、无断点续传、无压缩**。

### 3.6 明确不存在（ABSENT）

- 协议版本协商（`v:1` 只是常量，无降级逻辑，`panel/agentlink.js:72`）。
- 消息压缩（permessage-deflate 或应用层）。
- 请求取消 / 流式 RPC（长任务一律「立即返回 + 事件推送」，如 `backup.create` 返回 `{ok:true,started:true}`，`agent/src/agent.js:276-281`）。
- 共享协议代码/IDL（两侧各写一份，靠人肉同步）。
- token 轮换的在线生效：`/token/rotate` 只改面板侧并重建连接（`panel/api.js:869-877`），远端 `agent.json` 需重装/手动改。
- 传输层审计/流量指标（除 RTT 外无速率、无字节计数）。

---

## 4. HTTP API Surface（REST 接口面）

### 4.1 响应信封约定（**不统一**）

- **没有统一信封。** 成功响应有两种形态混用：① 原样返回业务载荷（多数 `res.json(await agent(server)('xxx', ...))`，如 `panel/api.js:1699`、`:2344`）；② `{ok:true}`（如 `panel/api.js:357`、`:762`、`:866`）。前端 `api<T>()` 因此**不检查 `ok`**，只检查 HTTP 状态码（`web/src/lib/api.ts:565-585`）。
- **错误信封统一为 `{error: string}`** + 语义化 HTTP 状态码：`400/401/403/404/409/415/429/500/502/504`（例：`panel/api.js:564`、`:741`、`:898`、`:318`、`:334`、`:922`）。
- 集中式错误中间件把 Agent 错误码映射成 HTTP：`AGENT_OFFLINE → 502`、`AGENT_TIMEOUT → 504`、其余 `500`，并允许 `err.status` 覆盖（`panel/api.js:2920-2923`）。
- 错误消息全是**中文自然语言裸字符串**（如「Agent 未连接」「实例名非法」），直接透传到前端 toast——即**错误文案与 UI 强耦合，无法国际化**。
- 无 OpenAPI/Swagger/JSON Schema，无 `/api/v1` 版本前缀，无 HATEOAS。
- 特例：`GET /servers/:id/instances/:name/icon` 返回**裸 `image/png` 二进制**（`panel/api.js:1868-1881`）；`files/download`、`backups/download` 返回**裸流**（`panel/api.js:2739`、`:2393`）；`ai-analyze` 返回 SSE 流（`panel/api.js:2164`）——这三类脱离 JSON 约定。

### 4.2 路由清单（按功能分组，`panel/api.js`）

**认证 / 会话 / 公共（6 条，均在鉴权中间件之前）**
- `POST /login` :329 — 登录，发会话 Cookie
- `POST /logout` :360 — 登出
- `GET /me` :367 — 公开面板信息（不含用户名）
- `GET /license` :377 — MIT 全文（关于页，匿名）
- `POST /forgot-password` :409 — 发 6 位验证码
- `POST /verify-reset-code` :461 — 校验验证码换一次性票据
- `POST /reset-password` :505 — 凭票据改密
- `GET /agent.js` :2901 — Agent 单文件匿名下载（另有 `panel/server.js:49` 的根路径同名路由）

**面板设置 / 版本（6 条）**
- `GET /version` :569 — 当前版本 + GitHub 最新 Release 与 changelog（10 分钟缓存，`?refresh=1` 跳过）
- `GET /settings` :576 — 读设置（SMTP 密码/AI 密钥只回 `hasPass`/`hasKey`）
- `PUT /settings` :602 — 部分更新设置 + 登录保护开关（含会话发放）
- `POST /settings/smtp-test` :689 — 发测试邮件
- `POST /settings/ai-test` :2093 — AI 连通性测试（回模型/首字延迟/耗时/token）
- `POST /settings/ai-models` :2135 — 拉服务商模型列表（过滤 embedding/tts）

**服务器 CRUD / SSH / Agent 生命周期（11 条）**
- `GET /servers` :747 — 列表（附 `stats`/`latency`/`onlineSince`/`agentBundled`/`agentUpdate`/`isLocal`）
- `POST /servers/reorder` :758 — 卡片排序持久化
- `POST /servers/ssh-check` :778 — 添加前 SSH 预检（不落盘）
- `POST /servers` :808 — 新增服务器（返回含 token）
- `GET /servers/:id` :816 — 单台（`?token=1` 才回 token）
- `PUT /servers/:id` :827 — 编辑（连接方向/TLS 变化会重建连接）
- `DELETE /servers/:id` :859 — 删除
- `POST /servers/:id/token/rotate` :869 — 轮换 Agent token
- `POST /servers/:id/install` :895 — SSH 安装 Agent（后台任务 + SSE 日志，30 秒等待上线）
- `POST /servers/:id/uninstall` :2766 — SSH 卸载（在线先优雅收尾，可选打包备份）
- `POST /servers/:id/agent-update` :766 — 手动触发 Agent 热更新
- `GET /servers/:id/info` :2514 — `sys.info` 透传
- `GET /servers/:id/task-log` :2831 — 重放安装/卸载日志

**本机 Agent 托管（2 条）**
- `POST /servers/:id/local-agent/start` :2844
- `POST /servers/:id/local-agent/stop` :2875

**实例核心 / 模板目录（4 条）**
- `GET /servers/:id/mcversions` :1628 — Mojang 版本清单（Agent 失败则面板兜底）
- `GET /servers/:id/cores` :1678 — 多核心类型目录（vanilla/paper/purpur/folia/fabric/forge/neoforge）
- `POST /servers/:id/instances` :1695 — 创建实例
- `POST /servers/:id/instances/:name/panel-install` :1644 — 面板代下核心并推送安装

**实例列表 / 生命周期（8 条）**
- `GET /servers/:id/instances` :945
- `POST .../:name/start|stop|restart` :1748（循环生成，超时 300s/300s/60s，`:1742`）
- `POST .../:name/command` :1761 — 控制台指令
- `POST .../:name/retry-install` :1706
- `POST .../:name/reinstall` :1717 — 清残留重装（可选换核心/版本/构建）
- `POST .../:name/setcore` :2275 — 指认上传的 jar 为核心
- `DELETE .../:name` :2259 — 删除（可选先备份 / force）
- `PUT .../:name` :2288 — 编辑备注/地址/内存

**控制台 / 玩家 / 网络（5 条）**
- `GET .../:name/console?tail=` :1906（tail 上限 1000，`:1914`）
- `GET /servers/:id/players` :1667 — 全部运行中实例的在线人数与名单（SLP + 控制台跟踪）
- `GET .../:name/domain-check` :1896 — SRV/A + TCP 连通探测
- `GET .../:name/banlist` :1845
- `POST .../:name/banlist/unban` :1855

**Mod / spark 性能（6 条）**
- `GET .../:name/mods` :1774
- `POST .../:name/mods/toggle|mods/delete` :1788（循环）
- `GET .../:name/spark/stats` :1803
- `POST .../:name/spark/profiler` :1813（start 20s / stop 60s 超时，`:1821`）
- `GET .../:name/spark/health` :1834

**图标 / 配置（6 条）**
- `GET|POST .../:name/icon` :1868 / :1883 — server-icon 读写（GET 返回裸 PNG）
- `GET|PUT .../:name/properties` :2340 / :2350 — server.properties 读写
- `PUT .../:name/watchdog` :2306 — 崩溃重启 + 定时重启设置
- `PUT .../:name/backup-schedule` :2323 — 定时备份设置

**备份（6 条）**
- `GET .../:name/backups` :2367
- `POST .../:name/backups/create|restore|delete` :2382（循环）
- `GET .../:name/backups/download` :2393 — 流式下载

**Java 运行时（4 条）**
- `POST /servers/:id/java-install` :2421
- `GET /servers/:id/javas` :2437 — 托管版本 + 系统包 Java
- `POST /servers/:id/java-use` :2447 — 切换默认
- `POST /servers/:id/java-uninstall` :2460

**文件管理（15 条）**
- `GET .../files` :2527（列目录）
- `GET|PUT .../files/content` :2537 / :2554（读 maxKB ≤2048 / 写）
- `POST .../files/mkdir` :2570
- `POST .../files/delete` :2580
- `POST .../files/copy|move` :2597（循环，180s 超时）
- `POST .../files/compress` :2615
- `POST .../files/extract` :2628
- `POST .../files/upload/begin` :2640
- `POST .../files/upload/chunk` :2664（60s 超时）
- `POST .../files/upload/finish|abort` :2681（循环）
- `POST .../files/upload/sftp` :2713（唯一被 CSRF 中间件豁免的 POST）
- `GET .../files/download` :2739

**AI 与实时（2 条）**
- `POST .../:name/ai-analyze` :2164 — SSE 流式日志分析
- `GET /events` :2906 — SSE 实时通道

### 4.3 鉴权边界

- 鉴权是**单个 `router.use` 中间件**，位于所有业务路由之前（`panel/api.js:554-565`）；`authEnabled=false` 时全部放行。
- 是**全有或全无**：没有按路由/按角色的权限划分，任何已登录会话可做任何事（含删服务器、卸载 Agent、看全部 token）。
- 匿名可达：`/login`、`/logout`、`/me`、`/license`、三个找回密码接口、`/agent.js`（`panel/api.js:323`、`:385`、`:2900`；`panel/server.js:49`）。
- 无请求级限流（除登录与找回密码），无配额、无审计。

### 4.4 Agent action inventory（RPC 动作全集，61 个）

面板几乎所有业务路由都只是「取 serverId → `hub.request(serverId, '<action>', params, timeoutMs)` → 把 Agent 返回值原样 `res.json()`」的薄转发（典型：`panel/api.js:1699`、`:2354`、`:2559`）。因此**真正的业务能力边界由 Agent 的动作表决定**——`agent/src/agent.js:196-341` 的 `switch (action)` 共 61 个 case，未匹配抛「未知操作: …」（`agent/src/agent.js:338-339`）：

| 分组 | 动作（行号均指 `agent/src/agent.js`） |
| --- | --- |
| 连通性 / 系统（3） | `ping` :199、`sys.info` :201、`sys.stats` :203 |
| 目录 / 版本（3） | `instance.list` :205、`mc.versions` :207、`core.catalogs` :209 |
| 实例安装（5） | `instance.create` :211、`instance.retry-install` :213、`instance.reinstall` :215、`instance.setcore` :270、`instance.panelInstall` :274 |
| 实例生命周期（5） | `instance.start` :222、`instance.stop` :224、`instance.restart` :226、`instance.delete` :232、`instance.edit` :234 |
| 控制台 / 运维（4） | `instance.command` :228、`instance.console` :230、`instance.logLine` :272、`agent.prepareUninstall` :266 |
| 网络 / 玩家 / 封禁（5） | `instance.domainCheck` :236、`instance.players` :268、`instance.banList` :250、`instance.banUnban` :252、`instance.setcore`（见上） |
| Mod / spark（6） | `instance.modsList` :238、`instance.modsToggle` :240、`instance.modsDelete` :242、`instance.spark.stats` :244、`instance.spark.profiler` :246、`instance.spark.health` :248 |
| 图标 / 配置 / 调度（6） | `instance.iconGet` :254、`instance.iconSet` :256、`instance.watchdog.set` :258、`instance.backupSchedule.set` :260、`instance.properties.get` :262、`instance.properties.set` :264 |
| 备份（5） | `backup.create` :276、`backup.list` :282、`backup.restore` :284、`backup.delete` :290、`backup.download.begin` :292 |
| Java 运行时（4） | `java.install` :296、`java.list` :300、`java.use` :302、`java.uninstall` :304 |
| 文件管理（14） | `fs.list` :306、`fs.read` :308、`fs.write` :310、`fs.mkdir` :312、`fs.delete` :314、`fs.copy` :316、`fs.move` :318、`fs.compress` :320、`fs.extract` :322、`fs.upload.begin` :324、`fs.upload.chunk` :326、`fs.upload.finish` :328、`fs.upload.abort` :330、`fs.download.begin` :332、`fs.download.chunk` :334、`fs.download.finish` :336 |

两个值得注意的**异步约定**：长任务（备份创建/恢复、Java 安装、面板代下安装）**立即返回 `{ok:true, started:true}`**，真实结果稍后经 `evt` 事件推送（`agent/src/agent.js:276-299`、`:227-246`）。

---

## 5. i18n（国际化）

### 5.1 结论：**完全没有国际化**

- 对整个 `web/` grep `i18n|i18next|react-intl|useTranslation|locale|locales|formatjs`：**零命中**。
- 无 `locales/`、`messages/`、`lang/` 目录；无 `t()` / `useTranslation` / `FormattedMessage`；无 `<Trans>`。
- 无语言切换 UI；无 `Accept-Language` 处理（后端从不读该头）。

### 5.2 硬编码中文量化

| 指标 | 数值 |
| --- | --- |
| `web/src` 下 `.ts/.tsx` 总数 | **122** |
| 含 CJK 字符的 `.ts/.tsx` 文件数 | **68**（55.7%） |
| `web/src` 下 `.tsx` 总数 | **101** |
| 含 CJK 的 `.tsx` 文件数 | **55**（54.5%） |
| `pages/` 目录 | **7 / 7 全部含中文** |
| `components/` 目录 | 45 / 93 |
| `lib/` 目录 | 15 / 20 |

（统计方法：`Get-ChildItem -Recurse -Include *.ts,*.tsx` 后逐文件匹配 `[\u4e00-\u9fff]`。）

- `<html lang="zh-CN">` 硬写（`web/index.html:2`），`<title>` 也是中文硬写（`web/index.html:7`）。
- 所有 UI 文案以**中文字面量直接内联在 JSX**，包括 aria-label、占位符、按钮、toast、错误提示。例：`web/src/components/upload-channel.tsx:30`（`传输通道`）、`:39`（`加密通道（分块上传）`）、`:41`（`（未配置 SSH 凭据）`）。
- 后端错误消息也是中文并**直接呈现给用户**（`panel/api.js:564` `'未登录'`、`:741` `'服务器不存在'`、`:898` `'该服务器正在安装中'`）——i18n 化必须同时改后端文案，前端无法单侧处理。
- 硬编码 locale 的格式化：`toLocaleString('zh-CN', { hour12: false })` 出现 2 处（`web/src/lib/api.ts:615`、`panel/api.js:215`）；时间/字节格式化是手写函数而非 Intl 抽象（`web/src/lib/api.ts:591-627`、`:609-616`）。
- 无复数规则、无日期/数字本地化、无 RTL 支持、无时区处理（一律用服务器/浏览器本地时区）。

---

## 6. Minecraft-Specific Domain Logic（前端对 MC 域数据的理解程度）

### 6.1 存在的东西

**① server.properties 字段元数据（62 个键）** — `web/src/lib/properties.ts`
- 接口 `PropDef { label, type, group, options?, optionLabels?, min?, max?, hint? }`，`PropType = 'text'|'textarea'|'number'|'bool'|'select'`（`properties.ts:4-16`）。
- 分组常量 6 组：`['基础','玩法','世界','性能','网络','其他']`（`properties.ts:18`）。
- `PROP_DEFS` 实测 **62 个键**：基础 11、玩法 15、世界 10、性能 9、网络 9、其他 8（`properties.ts:20-166`）。含枚举中文选项映射（如 `difficulty`：`properties.ts:37-43`；`level-type` 的 `minecraft:normal` 等：`:81-99`）与逐键 `hint` 说明（如 `properties.ts:26` 正版验证说明）。
- **无损回写**：`parseProperties` 保留注释/空行/键序（`properties.ts:187-195`），`serializeProperties` 只改值、未知键原样保留、缺失键追加到末尾（`properties.ts:198-217`）。
- MC 特有的**转义冒号**处理：`level-type=minecraft\:normal` 的 unescape/escape（`properties.ts:170-179`）。

**② 插件/模组配置文件的结构化编辑** — `web/src/lib/plugin-config.ts`（447 行）
- 格式探测 `detectFormat`：yaml/yml/json/toml，未知扩展名不参与表单化（`plugin-config.ts:15-20`）。
- YAML 用 `yaml` 包 `parseDocument` + `setIn` 只写改动路径，注释/键序/引号风格保留（`plugin-config.ts:371-379`）；JSON 整体重序列化（`:382-389`）。
- 自动降级为「原文编辑」的条件：TOML（`TOML_REASON`，`:22`）、多文档 YAML（`:87-89`）、YAML 锚点/别名（`:96-101`）、顶层非映射（`:104-106`）、解析失败（`:91`）。
- 行级注释提取启发式（缩进栈推算 path），用于在表单里显示 YAML 注释（`plugin-config.ts:141-229`）；数组增删项采用「整段替换该数组」（`:325-363` 的 `diffTree`）。

**③ 核心类型 / 版本目录模型**
- `CORE_LABEL` 中文映射覆盖 `vanilla/paper/purpur/folia/fabric/forge/neoforge/mojang/url/upload`（`web/src/lib/api.ts:200-211`）。
- `INSTALLER_SOURCES = {fabric, forge, neoforge}`：标记「需要跑官方安装器」的耗时核心（`web/src/lib/api.ts:214`）。
- 版本目录类型 `CoreCatalog/CoreCatalogs/CoreKind`（`web/src/lib/api.ts:217-237`）与 `McVersions`（`:192-197`，含 `stale` 兜底标记）。

**④ 玩家名单与在线人数**
- `PlayersSnapshot` 类型：`{online, max, list?, running, unreachable?}`（`web/src/lib/api.ts:179-190`）。
- UI 消费：在线 `X/Y` 与玩家名列表（`web/src/pages/instance-detail.tsx:345-346`、`:567-620`）。
- 数据来源在两处（Agent 侧）：SLP 协议响应 `players.sample` 与**控制台行跟踪**合并去重（`agent/src/instance/players.js:132-182`），跟踪规则见 `players.js:224-255`（`joined the game`/`left the game`/`lost connection`/`There are N of a max of M`）。

**⑤ server-icon（服务器列表图标）**
- 前端本地裁切成 64×64 PNG 后 base64 提交（`panel/api.js:1883-1893`）；Agent 侧校验 PNG magic 与 ≤200 KB（`agent/src/instance/serverinfo.js:73-81`）；读取回裸 PNG（`panel/api.js:1868-1881`）。

**⑥ 域名连通检测（含 MC SRV）**
- `_minecraft._tcp.<domain>` SRV 解析 → A/AAAA → 3 秒 TCP 探测，返回 IP/端口/延迟/SRV 标记（`agent/src/instance/serverinfo.js:86-140`）。

**⑦ 其他 MC 相关**
- Mod 启用约定：`.jar` ↔ `.disabled` 原地改名（`agent/src/instance/serverinfo.js:180-200`）。
- 封禁表读写：`banned-players.json` / `banned-ips.json`，运行中走 `pardon`/`pardon-ip` 控制台命令（`agent/src/instance/serverinfo.js:15-60`）。
- 启动就绪判定：匹配 `Done ([\d.]+s)`（`agent/src/instance/lifecycle.js:140`）。
- JVM 参数：固定 `-Xms min(mem,1024)M -Xmx memM -XX:+UseG1GC` + `nogui`（`agent/src/instance/lifecycle.js:105-116`）。
- paperclip 首启原版核心预下载（Paper/Purpur/Folia，`:88-90`；`agent/src/catalog.js:31`）。
- MC 版本 ↔ NeoForge 前缀映射表（22 项，`agent/src/catalog.js:53-75`，**面板侧有一份重复拷贝**：`panel/api.js:1082-1089`）。

### 6.2 明确不存在（ABSENT）

以下每一项都对 `web/src`、`panel/`、`agent/src/` 三处分别 grep 验证过，均为**零命中**（除注明者）：

| 能力 | 验证 grep | 结论 |
| --- | --- | --- |
| **NBT 解析/写入** | `nbt\|NBT\|level\.dat\|playerdata\|servers\.dat\|TAG_Compound\|DataInputStream` | **不存在**。整个仓库没有任何 NBT reader/writer，也不读 `level.dat`；世界相关 UI 只有 `level-name`/`level-seed`/`level-type` 三个文本/下拉框（`properties.ts:79-99`）。 |
| **物品 / 背包渲染** | `inventory\|ItemStack\|item id\|minecraft:` | **不存在**。无物品图标、无背包/箱子/末影箱/潜影盒编辑器，无 slot 概念。 |
| **Gamerule 元数据** | `gamerule\|gamerules\|keepInventory\|doDaylightCycle` | **不存在**。没有任何 gamerule 类型（bool/int）、默认值或说明表；只能靠控制台手敲指令。 |
| **地图 / region 渲染** | `region\|\.mca\|anvil\|chunk render\|level\.dat` | **不存在**（`region-file-compression` 只是 properties 键名 `properties.ts:121`；`role="region"` 是 aria 属性）。无 Anvil/MCA 解析、无区块渲染、无 `canvas` 地图查看器。 |
| **聊天 / § 格式化码** | `§\|\\u00a7\|colorCode\|stripColor\|legacy color` | 前端**不存在**。全仓库唯一的 `§` 处理是 **Agent 侧剥离 spark 输出**：`line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/§./g,'')`（`agent/src/instance/spark.js:80`）。**MOTD 在 UI 里按纯文本显示**，`§` 颜色码不会被转成 HTML/CSS。 |
| **材质 / 资源包加载** | `textures\|assets\|minecraft-assets\|icons/minecraft\|mcasset` | **不存在**。无任何 MC 官方材质或图标资源（`web/public` 只有项目 logo）。 |
| **玩家皮肤 / 头像** | `skin\|avatar\|crafatar\|minotar\|mc-heads` | **不存在**（`avatar` 唯一命中是 AI 聊天组件的头像占位，`web/src/components/agents/message.tsx:47`）。玩家名单只有纯文字名字，无头图。 |
| **白名单 / OP 管理 UI** | `whitelist\|op\.json\|ops\.json` | **不存在**专门的 UI（`whitelist.json` 仅作为 plugin-config 可扫描的配置文件之一被提及）。`/op`、`/deop` 只能通过控制台或玩家快捷菜单的下发指令实现。 |
| **世界/种子地图预览、结构、生物群系** | `biome\|structure\|seed map\|world map` | **不存在**。 |
| **版本 ↔ Java 兼容性表** | — | **不是真正的映射表**。Agent 明确**不做版本硬性拦截**（`agent/src/instance/lifecycle.js:83-84` 注释：选错版本让服务端自己报错）；前端 `JavaEntry` 只暴露 `major`，Java 版本由用户自由挑选（`web/src/lib/api.ts:390-407`）。仓库里唯一的版本映射是 MC↔NeoForge 前缀表。 |
| **配方 / 进度 / 成就（advancements）** | `recipe\|advancement\|datapack` | **不存在**（数据包只有 `initial-enabled-packs`/`initial-disabled-packs` 两个文本键，`properties.ts:156-157`）。 |
| **服务端类型差异建模（plugin vs mod 生态）** | — | 极弱：只有 `INSTALLER_SOURCES` 集合（`api.ts:214`）与 `PAPERCLIP_SOURCES`（`agent/src/catalog.js:31`）；没有按核心类型区分可用属性/目录结构的模型。 |

### 6.3 小结

前端对 MC 域的理解**集中在「服务端配置文件」这一层**（`server.properties` 62 键元数据 + 通用 YAML/JSON/TOML 结构化编辑），加上少量**协议与运维层**数据（SLP 在线人数、SRV 域名探测、server-icon、封禁表、Mod 启停）。**对「游戏内数据」的建模基本为零**：没有 NBT、没有物品/背包、没有地图/区块、没有 gamerule、没有 § 富文本、没有皮肤/材质。

---

## 7. Scheduling（计划任务）

### 7.1 存储与执行模型

- **全部在 Agent 侧执行，面板只做 CRUD 透传**（关键设计：面板关闭也照常跑，`README.md:300`）。
- 持久化位置：每个实例目录下的 `blocknexus.json`，字段 `meta.watchdog` 与 `meta.backupSchedule`（Agent 侧 `saveMeta(rec)` 写盘：`agent/src/instance/manager.js:181-186`）。
- 执行节拍：`InstanceManager` 构造函数里两个 `setInterval`，**均为 30 秒**并 `.unref()`：
  - `checkWatchdogSchedules()`（`agent/src/instance/manager.js:26`）
  - `checkBackupSchedules()`（`agent/src/instance/manager.js:27`）
  - 另有传输会话 GC 每 10 分钟（`manager.js:25`）。
- **触发前先落盘**：`s.lastFiredAt = Date.now(); this.saveMeta(rec);` 再执行任务，避免崩溃/重启重复触发（`agent/src/instance/watchdog.js:73-74`、`backup-schedule.js:54-55`）。
- **无 cron 表达式**：只有 `type: 'daily' | 'interval'` 两种（`watchdog.js:31`、`backup-schedule.js:31`）。
- **无时区处理**：用 Agent 进程本地时间 `new Date()`（`watchdog.js:48-53`），无 tz 配置、无 `TZ` 透传。
- **无抖动（jitter）**：所有实例在同一 30 秒 tick 上判定（`watchdog.js:66-67`）。

### 7.2 定时判定规则 `scheduleDue(s, now)`（`agent/src/instance/watchdog.js:46-63`）

- `daily`：星期过滤（空数组=每天，`s.days.includes(now.getDay())`，0=周日）；命中目标 `HH:MM` 后的 **2 分钟窗口**内触发一次；且距上次触发需 **> 20 小时**（去重）（`watchdog.js:52-56`）。
- `interval`：`now - lastFiredAt >= intervalMinutes * 60000`，间隔被 clamp 到 **[5, 10080] 分钟**（5 分钟 ~ 7 天）（`watchdog.js:58-61`）。
- 非法输入返回 `false`（时间格式非 `HH:MM`、未知 type，`watchdog.js:50-51`、`:62`）。
- 该规则有三处独立副本：`watchdog.js`、`backup-schedule.js`（复用同一函数）、以及回归测试 `agent/test-watchdog-schedule.js`（12 例）。

### 7.3 两类任务

**A. 看门狗（崩溃重启 + 定时重启）** — `agent/src/instance/watchdog.js`
- `setWatchdog`：`{autoRestart, restartDelaySec ∈ [1,300], schedules[]}`，**每条实例最多 10 条计划**（`watchdog.js:23-38`、`:25` 的 `.slice(0, 10)`）。
- 崩溃重启：仅当「非主动停止 且 退出码非 0」（`agent/src/instance/lifecycle.js:158`、`:167`）；延迟 = `min(restartDelaySec * 10分钟内崩溃次数, 60s)` 的线性退避（`watchdog.js:94-97`）；执行前二次确认实例未被删除/未在运行（`watchdog.js:114`）；实例删除时取消待执行重启（`lifecycle.js:261-262`）。
- 定时重启：**只在实例运行时执行，未运行则跳过**（`watchdog.js:78-84`），并写控制台 + 推 `watchdog.fired` 事件。

**B. 定时备份** — `agent/src/instance/backup-schedule.js`
- `setBackupSchedule`：`{enabled, keepCount ∈ [0,1000], schedules[]}`，同样最多 10 条计划（`backup-schedule.js:22-38`）。
- **实例未运行也备份**（停机存档更干净，`backup-schedule.js:46` 注释）。
- 运行中先 `save-off` + `save-all flush` 落盘并等 3 秒，打包后 `save-on`（`agent/src/instance/backups.js:66-77`）；命令失败只记日志不阻断（`backups.js:57-65`）。
- 保留份数：每次成功备份后 `pruneBackups(name, keepCount)`，**手动与自动一起计数**，`keepCount < 1` 不清理（`backups.js:80-83`、`:91-103`）。
- 打包用系统 `tar`，相对路径规避 GNU tar 把 `D:` 当远程主机（`backups.js:27-39`、`:54-55`）；存于 `<instances>/.backups/<name>/`（`backups.js:14-16`）。

### 7.4 并发守卫（concurrency guard）

| 守卫 | 形式 | 行为 | 引用 |
| --- | --- | --- | --- |
| 备份互斥 | `rec.backupBusy` 布尔 | 第二个请求抛「备份正在进行中，请稍后再试」；定时触发捕获该错误并写「上一次备份仍在进行，本次定时触发已跳过」 | `agent/src/instance/backups.js:43-44`、`backup-schedule.js:69-71` |
| 启动单飞（single-flight） | `rec.startJob` Promise 复用 | 并发 `start` 直接返回同一个 Promise，**只 spawn 一个 java**（Paper 系预下载 await 期间 `rec.proc` 仍为空，这是历史崩溃点） | `agent/src/instance/lifecycle.js:51-66`、`:54` |
| 启动取消 | `rec.startCancelled` 标记 | 预下载期间 `stop` 可真正取消，spawn 前消费 | `lifecycle.js:96-99`、`:208-216` |
| Java 安装单任务 | `this.javaJob` | 已有任务则返回 `{ok:true,started:true,busy:true}` | `agent/src/instance/java.js:203`、`agent/src/agent.js:297` |
| 原版核心预下载去重 | `this.bootstrapJobs: Map<'name\|version', Job>` | 同版本并发只下一次 | `agent/src/instance/manager.js:21` |
| 面板侧安装互斥 | `installing: Set<serverId>` | `/install` 与 `/uninstall` 互斥，返回 409 | `panel/api.js:89`、`:898`、`:2769` |
| 面板代下互斥 | `panelInstalls: Set<\`${serverId}:${name}\`>` | 同上 | `panel/api.js:1514`、`:1519-1521` |
| 面板代下自动兜底冷却 | `panelFallbackAt: Map` | 同一实例 10 分钟内只自动代下一次 | `panel/api.js:1515`、`:1619` |
| Java 刷新轮询去重 | `javaRefreshing: Set` | 每 server 只跑一条轮询 | `panel/api.js:2477-2512` |

### 7.5 面板自身定时器（非用户计划任务）

资源快照 30s（`panel/api.js:156-158`）、SSE 心跳 25s（`panel/api.js:136-142`）、限流记录 GC 60s（`panel/api.js:540-551`）、外向连接收敛 15s（`panel/agentlink.js:154`）、版本检查缓存 10 分钟（`panel/api.js:37`）。

### 7.6 明确不存在（ABSENT）

- cron 表达式 / crontab 语法：不存在。
- 时区与夏令时处理：不存在（无 `TZ`、无 UTC 归一化）。
- 任务执行历史 / 审计（除写进实例控制台外）：不存在；无独立任务表、无下次执行时间预测接口。
- 任务级重试与失败告警：不存在（仅写控制台 + 一条 SSE）。
- 依赖/串联任务（任务 A 成功后跑 B）：不存在。
- 跨实例/服务器级全局任务：不存在（调度粒度仅到实例）。
- 手动「立即执行一次」定时任务的接口：不存在（只有独立的手动备份/重启按钮）。
- 面板侧调度器：不存在（刻意不做，全部下沉 Agent）。

---

## 8. Testing（测试基础设施）

### 8.1 Agent 侧：11 个零依赖测试脚本 + 1 条聚合命令

`package.json:11` 的 `test:agent` 串起 **10 个**脚本（`e2e-reset-code.js` **不在**其中，需手动跑）：

```
test-module-imports → build.js --check → test-bundle-fresh → test-bundle-smoke
→ test-bootstrap-vanilla → test-start-singleflight → test-watchdog-schedule
→ test-backup-schedule → test-player-tracking → test-fs-ops → e2e-panel-install
```

| 脚本 | 覆盖内容 | 断言机制 | 用例数 | 需网络/真实服务器 |
| --- | --- | --- | --- | --- |
| `test-module-imports.js` | 模块导入完整性（用了别处符号却漏 `require`） | 自研词法扫描（剥注释/字符串、收集绑定名与自由标识符） | 循环驱动，38 处日志 | 否 |
| `build.js --check` | 产物新鲜度 | 文本全等比较，过期 `exit 1` | 1 | 否 |
| `test-bundle-fresh.js` | 产物同步 + 零依赖 + 保留 `AGENT_VERSION` + 模块齐全 | `check(desc, ok, detail)` 计数 | **5** | 否 |
| `test-bundle-smoke.js` | 黑盒启动产物（横幅、监听端口、SIGTERM 干净退出、缺配置报错） | `check()` + 真实 spawn | **5** | 否（本地端口 45911） |
| `test-bootstrap-vanilla.js` | 原版核心预下载（已就位跳过/sha1 自愈/官方成功/走镜像/下载成功但 sha1 不符/双源失败清理/并发只下一次） | 从 `src/instance/core.js` 正则抽方法体 + `new Function` 实例化资产 + `case_()` | **11** | 否（注入假 HTTP） |
| `test-start-singleflight.js` | 启动并发去重（只 spawn 一个 java）、进程归属、取消启动 | 抽 `start/doStart` 方法体 + 假 child + `check()` | **18** | 否 |
| `test-watchdog-schedule.js` | 定时判定规则（触发窗口、20 小时去重、星期过滤、间隔上下限、非法输入） | 抽 `scheduleDue` 方法体 + `cases[]` 表驱动 | **12** | 否 |
| `test-backup-schedule.js` | 接线断言 + `setBackupSchedule` 校验规则 + `pruneBackups` 保留份数（真实临时目录） | 源码文本断言 + stub `this` + 真实 fs | 3 段 | 否 |
| `test-player-tracking.js` | 玩家进出/名单解析 + 控制台跨 chunk 拼行（含中文字节截断） | 抽 `trackPlayers`/`makeLineSplitter` + 表驱动 | 约 **10**（6 跟踪 + 4 拼行） | 否 |
| `test-fs-ops.js` | 文件管理（复制/移动/压缩/解压/路径越界/目标已存在） | 抽 `fs.js` 方法体 + 真实临时目录 + 系统 `tar` | **16** | 否 |
| `e2e-panel-install.js` | 端到端：隔离面板 + 真 Agent（listen 模式），加密通道上传断点续传（含 Agent 重启后续传）、面板代下全链路、安装失败自动兜底 | `report(name, ok, detail)` + 真实 HTTP/WS/文件 | **8** | 本地起进程，不需外网 |
| `e2e-reset-code.js` | 找回密码三段式与限流（发码冷却/窗口、错码锁定、单码全局上限、票据一次性、过期、关闭保护即失效、旧 token 兼容） | `report()` + 注入更短窗口的 `limiterOpts`（第 4 参数）+ 假 SMTP | **24** | 否 |

**断言风格**：三种混用——① `check(desc, ok, detail)` + `pass/total` + `process.exit(pass===total?0:1)`；② **从 `agent/src/**` 用正则抽出方法体再 `new Function`/`Object.assign` 实例化**（因为源码是「对象字面量成员」风格，无法直接 `require` 单个方法）；③ e2e 的 `report()`。粗糙合计 **≈120+ 条断言**。

**测试的共同特征**：零第三方依赖（只用 `fs/path/os/net/http/child_process`），不需要面板与真实 MC 服务器，退出码即结果。

### 8.2 Bundle 新鲜度检查（`agent/test-bundle-fresh.js`）

机制（5 个断言，`test-bundle-fresh.js:16-53`）：

1. `agent/agent.js` 必须存在（`:22`）；
2. **内存重跑打包器**并做**逐字节全等比较**：`const { text } = build(); current === text` —— 请求 `agent/build.js` 导出的 `build()`，把 `src/**` 重新拼一遍，与磁盘产物比对（`:12`、`:23-27`）；
3. 每个模块 id 都出现在产物里（`__modules["<id>"]` 存在性，`:28-32`）；
4. **零依赖校验**：正则抽出产物里所有 `require('...')`，用 `require('module').builtinModules` 判断是否全是标准库或相对路径（`:33-45`）；
5. 产物仍保留 `AGENT_VERSION = '...'` 字面量（面板靠正则从产物文本提取版本，抽不到就失去自动更新能力，`:46-50`）。

`agent/build.js --check` 是同一比较的 CLI 版本：同步则打印模块数与行数 `return 0`，不同步则 stderr 提示 `请运行 npm run build:agent` 并 `return 1`（`build.js:119-126`）。

### 8.3 前端测试：**完全不存在**

- `web/package.json` **没有 `test` 脚本**（scripts 只有 `dev/build/lint/preview`，`web/package.json:6-11`）。
- devDependencies 里**没有** `vitest` / `jest` / `@testing-library/*` / `playwright` / `cypress` / `jsdom` / `happy-dom`（`web/package.json:27-36` 全列出：只有 `@types/*`、`@vitejs/plugin-react`、`oxlint`、`typescript`、`vite`）。
- `web/vite.config.ts` **没有 `test` 配置块**（全文 24 行，只有 plugins/resolve.alias/server.proxy）。
- 全 `web/` grep `vitest|jest|testing-library|playwright|cypress|jsdom|happy-dom|__tests__|\.test\.|\.spec\.` → 零命中。
- **唯一的静态检查**：`oxlint` 存在于 scripts 与 devDeps（`web/package.json:7`、`:32`），配置只有 3 条规则（`web/.oxlintrc.json:1-9`：`react/rules-of-hooks` 报错、`react/only-export-components` 警告）。**oxlint 未被 CI 调用**。
- 类型检查只作为 `web build` 的一部分隐式执行（`tsc -b && vite build`，`web/package.json:8`）。
- 结论：**前端零自动化测试覆盖**，所有 UI 行为（含实时事件、上传断点续传、properties/plugin-config 无损回写这类复杂逻辑）无回归防线。

---

## 9. Build / Release（构建与发布）

### 9.1 Agent 打包器 `agent/build.js`（138 行）

- 输入 `src/entry.js`，**深度优先**收集全部可达模块（`build.js:25-45`），相对 `require('./x.js')` / `require('../x.js')` 被**静态改写**为 `__require("<模块 id>")`；裸模块名（Node 标准库）原样透传（`build.js:35`、`:56-62`）。
- 模块 id 规范化为相对 `agent/` 的 posix 路径并补 `.js`（`build.js:48-53`），**收集顺序即引用顺序 → 输出确定性**（`build.js:24` 注释、`Map` 迭代序）。
- 产物结构：`#!/usr/bin/env node` + `'use strict'` + `__modules` 注册表 + `__cache` + `__require()` 加载器 + 每个模块包成 `__modules["id"] = function (module, exports, __require) {...}` + 末尾 `__require("src/entry.js")` 启动（`build.js:64-112`）。
- 模块内 `__dirname`/`__filename` 语义与拆分前的单文件一致（`build.js:14` 注释），模块自带 shebang 会被剥掉（`build.js:99`）。
- `--check` 只校验不写盘，过期退出码 1（`build.js:114-134`）；`build` 也作为库导出供测试复用（`build.js:138`）。
- 产物仍是**零依赖单文件**（约 193 KB），这是部署链路的前提：SSH 只上传一个文件、systemd `ExecStart=/usr/bin/env node {DIR}/agent.js`（`panel/ssh.js:304`）、面板 `/agent.js` 匿名下载（`panel/server.js:49`、`panel/api.js:2901`）、手动 `curl -o agent.js`。

### 9.2 Agent 版本与字段自动更新（auto-update）

链路：

1. 版本常量唯一来源 `AGENT_VERSION = '0.3.5'`（`agent/src/config.js:10`），对外的 `VERSION = 'BlockNexus/' + AGENT_VERSION`（`config.js:15`，同时用作 HTTP UA，见 `agent/src/http.js:47`）。
2. 面板**从交付产物文本正则提取**版本：启动时读 `agent/agent.js` 匹配 `/AGENT_VERSION\s*=\s*'([^']+)'/`（`panel/api.js:26-32`）；`test-bundle-fresh.js` 的第 5 条断言专门守护这个正则不会失效（`test-bundle-fresh.js:46-50`）。
3. Agent 上线时在 `hi` 事件里带 `info.agentVersion`（`agent/src/agent.js:188`、`:181-194`）。
4. 面板收到 `agent-event/hi` 即触发 `syncAgentVersion()`（`panel/api.js:292-296`、`:249-290`）：远端 ≠ 随附版本则自动更新——
   - SSH 服务器：`updateAgentScript()` 上传 `agent.js.new` 后原子改名并 `systemctl restart blocknexus-agent`（`panel/ssh.js:315-339`、`:330`）；
   - 本机服务器：面板直接重启自己托管的 Agent 进程（`panel/api.js:270-273`）。
5. 失败退避：`agentUpdateState` 做 10 分钟静默（无论成败），`agentUpdateTries` 连续失败 3 次后停止自动尝试，转为设置页「立即更新」按钮 `POST /servers/:id/agent-update`（`panel/api.js:246-247`、`:260-263`、`:765-773`）。
6. 进度经 SSE `agent-update` 推送（`panel/api.js:265-268`）。

版本号是**两条独立的线**：面板 `package.json:3` 的 `version`（0.3.0）与 Agent 的 `AGENT_VERSION`（0.3.5），互不覆盖（`README.md:401-410`）。

### 9.3 发布产物 `scripts/build-release.ps1`（119 行）

- 版本从 `package.json` 正则读出（`build-release.ps1:23-26`）。
- 前置硬校验 9 个文件必须存在：exe / exe.config / `WebView2Loader.dll` / 两个 WebView2 托管 DLL / `agent/agent.js` / `web/dist/index.html` / `LICENSE` / `scripts/blocknexus-launcher.js`（`build-release.ps1:29-37`）。
- **便携版 zip**（`BlockNexus-v<版本>-portable.zip`）内容：外壳运行件 + **打包机的 `node.exe` 直接复制为 `runtime\node.exe`**（`build-release.ps1:38`、`:70`）+ `package.json/package-lock.json/README.md/LICENSE` + `panel/`、`images/` + `web/dist` + `agent/agent.js` + `scripts/blocknexus-launcher.js`；随后 `npm ci --omit=dev --no-audit --no-fund` 装生产依赖（`:83-91`）；压缩前再断言 5 个关键路径存在（`:93-96`）。
- **纯外壳 zip**（`BlockNexus-shell-v<版本>.zip`）：只有 exe/dll/runtimes（`build-release.ps1:104-111`）。
- 最后打印两个 zip 的 **SHA256**（`build-release.ps1:113-115`）。
- 临时 staging 目录在 `$env:TEMP`，`finally` 里清理（`:51`、`:117-119`）。
- 输出目录默认硬编码为 `D:\11493\Desktop\DE Project\BlockNexus Project`，不存在才退回 `.\release`（`:45-48`）——**与开发机路径强耦合**。

### 9.4 桌面外壳 `scripts/build-exe.ps1`（221 行）

- 工具链：**系统自带 `csc.exe`（.NET Framework 4.x）**，从 `C:\Windows\Microsoft.NET\Framework*\v4.0.30319\csc.exe` 取最新（`build-exe.ps1:44-46`）——**Windows-only，且不需要下载任何工具链**。
- 图标始终由 `images/logo.png` 重新生成（调 `make-ico.ps1`，`:28-32`），`/win32icon` + `/resource` 双写（`:76-77`）。
- 目标 `/target:winexe /platform:anycpu`，引用 System.* + WebView2 两个托管 DLL（`:73-82`）；`WebView2Loader.dll` 按 x64/x86 分别落位（`:59-67`）。
- 编译前强杀正在运行的 exe（`:35-41`）；编译后 copy `app.config`（`:88`）。
- 额外把外壳同步到项目外的兄弟目录 `..\BlockNexus\` 并写 `root.txt` 记录项目根（`:93-113`）——为绕开 Win11 25H2 的托盘图标注册异常（`:94-95` 注释）。
- 清 Windows 图标缓存 `ie4uinit -ClearIconCache`（`:115-127`）。
- `-Sign` 走本地自签：`New-SelfSignedCertificate` → 导入 `Root` 与 `TrustedPublisher` 的 CurrentUser+LocalMachine → `signtool` + DigiCert RFC3161 时间戳（失败退回无时间戳）（`:134-221`）。**明确是本机自签，换机无效**（`:6` 注释）。

### 9.5 CI `.github/workflows/ci.yml`（40 行，仓库唯一 workflow）

- 触发：`push` 到 `main` + 所有 `pull_request`（`ci.yml:3-6`）。**无 tag 触发、无 release 触发**。
- job `backend`（`ubuntu-latest`，Node **20**）：`npm install --ignore-scripts` → shell 循环 `node --check` 覆盖 `panel/*.js agent/*.js scripts/*.js`（`ci.yml:9-25`）。**只做语法检查**：不跑 `test:agent`、不跑 `build.js --check`、不跑任何测试。
- job `frontend`（`ubuntu-latest`，Node **20**）：`npm ci` + `npm run build`（= `tsc -b && vite build`）（`ci.yml:27-40`）。这是唯一的类型检查入口。
- **无矩阵**（无 `strategy.matrix`）、无缓存配置、无 artifact 上传、无 lint 步骤、无 release job、无 secrets 使用。
- 发布是**纯手工**：`gh release create vX.Y.Z` + 手写 Release body（`AGENTS.md` 发版流程）。

### 9.6 明确不存在（ABSENT）

- **多平台 / 构建矩阵：不存在。** 无 `strategy.matrix`、无交叉编译、无 `electron-builder` / `pkg` / `node-sea` / Dockerfile / linux / macOS 产物。发布物**只有 Windows x64**：`build:exe` 依赖 Windows .NET Framework `csc` 与 WinForms/WebView2（`build-exe.ps1:44-46`、`:73-82`），便携包内嵌的是**构建机的 `node.exe`**（`build-release.ps1:38`、`:70`）。`web/` 只是静态产物，跨平台的是被 SSH 推过去的 `agent/agent.js`（零依赖、靠目标机自带 Node ≥16，`panel/ssh.js:11`）。
- 容器化 / 镜像发布：不存在（无 Dockerfile、无 compose、无 registry 逻辑）。
- 自动版本号递增 / changelog 生成：不存在（版本手改 + 手写 Release body）。
- 签名与公证的正式链路：不存在（仅本机自签；脚本头部即声明「这是本机自签，换一台电脑仍需正规证书签名」，`scripts/build-exe.ps1:6`）。
- 依赖锁定审计 / SCA / SBOM：不存在（无 `npm audit` 步骤、无 Dependabot 配置）。
- 前端 bundle 体积预算 / 分析：不存在。
- 回滚机制 / 灰度 / 更新通道：不存在（面板只比对 GitHub Release 最新标签，`panel/api.js:56-83`；Agent 自动更新是**强制对齐**，无版本区间或回滚）。
- CI 覆盖 Agent 测试：不存在（`ci.yml` 未调用 `test:agent`，Agent 的 120+ 断言只在开发者本机跑）。

---

## 10. Gaps vs a Modern Panel（相对现代面板的缺口汇总）

以下能力在当前代码库中**完全不存在**（不是「弱」，而是没有实现），按主题列出，并注明对本仓库的具体含义。

### 10.1 身份与访问（最大缺口）

1. **多用户**：单一 `panel.username`（`panel/config.js:18`），无用户表。
2. **RBAC / 权限模型**：无角色、无 scope、无资源级授权；登录后即全权（`panel/api.js:554-565` 是唯一的鉴权闸门）。
3. **HTTP API Token / 机器可访问凭证**：无；无法给 CI、脚本、第三方集成发放受限凭证（唯一的 token 是 Agent 通道专用，`panel/config.js:142`）。
4. **OIDC / SSO / LDAP / SAML**：无。
5. **MFA（TOTP / WebAuthn）**：无。
6. **会话治理**：无会话列表、无「踢出其他设备」、无「登出全部」、无持久化（重启即全掉，`panel/api.js:87`）。
7. **审计日志**：无任何操作审计（谁在何时删了哪个实例 / 看了哪个 token 都无记录）。
8. **`Secure` Cookie 标志**：即使 HTTPS 也不下发（`panel/api.js:356`）。
9. **反向代理感知**：无 `trust proxy` → 限流退化为全局（全库 grep 零命中）。
10. **密码策略与账号锁定策略**：只有「≥6 位」（`panel/api.js:508`、`:614`）。
11. **`loginFails` 内存泄漏**：无 GC（对比 `panel/api.js:540-551` 只清三类记录）。

### 10.2 实时与前端架构

12. **浏览器 WebSocket / 双向通道**：无，只有 SSE 单向 + 每次操作一次 HTTP。
13. **事件断点续传（`id:` / `Last-Event-ID`）与回放缓冲**：无（`panel/api.js:128-135`），断线期间的事件永久丢失（唯一例外是安装/卸载日志的 REST 重放，`panel/api.js:2831`）。
14. **服务端按订阅过滤**：无，所有事件广播给所有页面（`panel/api.js:128-135`）。
15. **类型安全的端到端契约**：无（前端手写 union `sse.ts:3-38` vs 后端裸对象 `api.js:117`）。
16. **事件版本协商**：无。
17. **前端测试**：零（无 vitest/jest/RTL/Playwright，`web/package.json:27-36`）。
18. **前端 lint 进 CI**：无（oxlint 存在但 `ci.yml` 不调用）。
19. **状态管理/数据层抽象**：无（组件内 `fetch` + `setState` + 手工刷新，如 `instance-detail.tsx:111-176`）。
20. **乐观更新 / 离线队列 / 冲突处理**：无。

### 10.3 i18n 与可访问性

21. **国际化框架**：完全没有（零命中），68/122 个源文件硬编码中文，7/7 页面含中文。
22. **语言切换 / 多语言资源**：无；`<html lang="zh-CN">` 硬写（`web/index.html:2`）。
23. **后端错误消息本地化**：无且不可能单侧实现（错误是中文裸字符串，如 `panel/api.js:741`）。
24. **日期/数字/时区本地化**：无（`zh-CN` 硬编码 2 处，`web/src/lib/api.ts:615`、`panel/api.js:215`）。
25. **RTL 支持**：无。

### 10.4 Minecraft 游戏域建模

26. **NBT 读写**：完全不存在 → 无法做玩家数据、世界数据、物品数据的任何展示或编辑。
27. **物品 / 背包 / 容器渲染**：不存在（无 ItemStack、无物品图标、无背包编辑器）。
28. **Gamerule 元数据与可视化**：不存在。
29. **地图 / region（Anvil/MCA）解析与渲染**：不存在，无任何世界可视化。
30. **聊天/§ 富文本渲染**：前端不存在（MOTD 按纯文本显示）；唯一 `§` 处理在 Agent 侧剥离 spark 输出（`agent/src/instance/spark.js:80`）。
31. **材质 / 图标资源管线**：不存在。
32. **玩家皮肤/头像**：不存在（玩家名单只有名字文本）。
33. **白名单 / OP 列表的专用 UI**：不存在。
34. **版本 ↔ Java 兼容性矩阵**：刻意不做（`agent/src/instance/lifecycle.js:83-84`）；唯一的映射表是 MC↔NeoForge 前缀，且有**面板/Agent 两份重复拷贝**（`panel/api.js:1082-1089` 与 `agent/src/catalog.js:53-75`）。
35. **数据包 / 配方 / 进度管理**：不存在。
36. **服务器类型差异化建模（plugin vs mod 生态）**：几乎没有。

### 10.5 调度与编排

37. **cron 表达式**：无，仅 daily/interval（`agent/src/instance/watchdog.js:31`）。
38. **时区支持**：无，用进程本地时间（`watchdog.js:48-53`）。
39. **任务历史 / 下次执行时间 / 失败告警**：无（仅写实例控制台 + 一条 SSE）。
40. **跨实例/服务器级计划任务**：无（粒度只到实例）。
41. **任务依赖 / 工作流编排**：无。
42. **抖动（jitter）与错峰**：无，所有实例同一 30 秒 tick。

### 10.6 传输、扩展性与可观测性

43. **上传并行分块 / 客户端哈希 / tus 之类标准协议**：无；严格串行、base64 膨胀、单文件 200 MB 硬上限（`agent/src/instance/fs.js:207`、`:295-299`）。
44. **下载 Range / 断点续传**：无（`panel/api.js:2739-2763` 一次性拉完）。
45. **协议版本协商 / 降级 / 压缩**：无。
46. **可观测性**：无 metrics（Prometheus/OTel）、无结构化日志、无 trace id、无健康检查端点（仅 `panels` 启动横幅与 `console.error`，`panel/server.js:84-110`）。
47. **告警通道**：只有 SMTP 邮件且仅两类（离线/恢复）（`panel/api.js:210-240`）；无 Webhook、无 Slack/Discord/Telegram、无告警规则引擎。
48. **备份异地/对象存储**：无（仅本地 `.backups` tar.gz，`agent/src/instance/backups.js:14-16`）。

### 10.7 构建、发布与交付

49. **多平台产物 / 构建矩阵**：不存在，只有 Windows x64 便携包（`scripts/build-release.ps1:64-111`），内嵌构建机 `node.exe`（`:70`）。
50. **容器化**：无 Dockerfile / compose。
51. **CI 覆盖 Agent 测试**：无（`ci.yml` 只跑 `node --check` 与前端构建；Agent 的 ≈120 条断言不在 CI 中执行）。
52. **自动发版 / changelog 生成 / artifact 上传**：无（手工 `gh release create`）。
53. **正式代码签名**：无（仅本机自签，`scripts/build-exe.ps1:6`）。
54. **发布脚本路径可移植性**：默认输出目录硬编码开发机绝对路径（`scripts/build-release.ps1:46`）。
55. **依赖安全审计 / SBOM / 自动更新依赖**：无。
56. **数据库**：无（一切状态在 `data/config.json` + 每实例 `blocknexus.json`，全量读改写；`panel/config.js:75-89` 原子写但无并发/事务/迁移框架）。
57. **加密瓶颈**：HKDF info 标签仍是历史遗留 `'mcpan/*'`（`panel/crypto.js:28-30`），旧 Agent 兼容被固化进协议；`rejectUnauthorized:false` + 指纹固定是自签场景的折中（`panel/agentlink.js:250`）；README 自述不能防主动 MITM（`README.md:118`）。

---

## 附录 A：本次审计的验证方式与局限

- **读全文**：`panel/server.js`、`panel/config.js`、`panel/crypto.js`、`panel/agentlink.js`、`panel/api.js`、`agent/src/ws.js`、`agent/src/http.js`、`agent/src/agent.js`、`agent/src/entry.js`、`agent/src/config.js`、`agent/src/eventbus.js`、`agent/src/state.js`、`agent/src/catalog.js`、`agent/src/instance/{manager,lifecycle,install,fs,backups,players,serverinfo,watchdog,backup-schedule,java}.js`、`agent/build.js`、`agent/test-bundle-fresh.js`、`web/src/lib/{sse,api,upload,properties,plugin-config}.ts`、`web/src/components/upload-channel.tsx`、`.github/workflows/ci.yml`、`scripts/{build-exe,build-release}.ps1`、`package.json`、`web/package.json`、`web/vite.config.ts`、`web/.oxlintrc.json`、`web/index.html`。
- **抽样/结构扫描**（读函数清单与关键字行，非全文）：`panel/ssh.js`、`panel/localagent.js`、`agent/src/instance/{core,spark,catalog-cache}.js`、各 `test-*.js`/`e2e-*.js`。
- **反向 grep 验证「不存在」**：`nbt|level.dat|playerdata|inventory|gamerule|\.mca|textures|skin|§`（分别对 `web/src`、`panel/`、`agent/src` 执行）；`i18n|react-intl|useTranslation|locale`（对 `web/`）；`oidc|oauth|saml|ldap|passkey|webauthn|totp|2fa|mfa`（全仓库）；`trust proxy`（`panel/*.js`）；`vitest|jest|testing-library|playwright|cypress|jsdom`（`web/`）。
- **量化统计**：CJK 文件计数用 `Get-ChildItem -Recurse -Include *.ts,*.tsx` + 逐文件正则匹配；`PROP_DEFS` 键数用正则计数并人工分组核对（62）；路由数用 `router\.(get|post|put|delete)\(` 计数（79 处注册，5 处循环生成）。
- **局限**：
  1. 用例数一栏对部分测试脚本是「按断言辅助函数调用估算」，`test-module-imports.js` 与 `test-backup-schedule.js` 为循环/分段驱动，无法给出精确单例数。
  2. 未执行任何测试或构建命令（纯静态审计），因此「通过率」不在本报告范围。
  3. `agent/agent.js`（打包产物）只作为存在性/规模参考，未逐行审计（其内容由 `agent/src/**` + `agent/build.js` 推导）。
  4. 未审计 `web/src/components/dialogs.tsx`(64 KB)、`web/src/components/agents/**`（AI 聊天 UI 组件库）、`web/src/pages/panel-settings.tsx`(39 KB)、`website/`、`.opanel-reference/` 与 `.zcode/` 目录的逐行细节；`components/agents/**` 从命名与文件清单看属于通用 AI 对话框组件（非 MC 业务），故未计入「MC 域能力」。
  5. `data/*.log`、`data/config.json` 等运行时数据未读取（含敏感凭据）。

---

## 附录 B：持久化数据模型（对比基准）

**没有数据库。**全部状态分三层：面板单文件 JSON、每实例一个 JSON、磁盘缓存文件；其余都是进程内存。

### B.1 面板 `data/config.json`（唯一写入点 `panel/config.js:75-89`）

```jsonc
{
  "panel": {
    "port": 3080, "host": "127.0.0.1",
    "username": "admin",
    "passwordHash": { "salt": "<16B hex>", "hash": "<scrypt 32B hex>" },
    "authEnabled": false,
    "resetCode":  { "hash": "<sha256>", "expires": 0 },   // 临时，用后删除 api.js:497
    "resetToken": { "hash": "<sha256>", "expires": 0 }    // 旧版邮件链接兼容
  },
  "servers": [{
    "id": "srv_<6B hex>", "name": "…", "host": "…",
    "token": "<32B base64url>",                            // Agent 通道共享密钥
    "createdAt": 0, "status": "offline", "lastSeen": null, "info": null, "installing": false,
    "ssh":   { "port": 22, "user": "root", "auth": "password|key",
               "password": "明文", "keyPath": "", "key": "明文私钥" },
    "agent": { "mode": "outbound|inbound", "host": "", "port": 3099,
               "tls": false, "tlsFingerprint": "", "panelUrl": "",
               "installDir": "/opt/blocknexus-agent" }
  }],
  "settings": {
    "domain": "", "adminEmail": "",
    "smtp":   { "host": "", "port": 465, "secure": true, "user": "", "pass": "明文", "from": "" },
    "notify": { "offline": true, "recovery": false },
    "ai":     { "enabled": false, "baseUrl": "", "apiKey": "明文", "model": "" }
  }
}
```

- 结构定义：`panel/config.js:17-33`；服务器默认值：`panel/config.js:137-167`。
- **SSH 密码/私钥、Agent token、SMTP 密码、AI 密钥全部明文落盘**（文件头注释即声明：`panel/config.js:3`；README 亦有「安全注意事项」：`README.md:414`）。
- 写入是原子替换：唯一临时名（`pid + 随机`）→ `fs.renameSync`，避免并发保存互抢（`panel/config.js:75-89`）。
- **无 schema 版本号、无迁移框架**。老配置兼容靠零散的默认值合并：`panel/config.js:40-55`（settings 子对象逐个浅合并）、`:56-68`（server.agent 字段补全 + 老的 `mode` 缺省为 `inbound`）、`:47-48`（用户名兜底 `admin`）。
- 读改写是**全量**：任何一次 `updateServer()` 都重写整个文件（`panel/config.js:193`）；服务器多了以后每次心跳状态变更都会整文件重写。

### B.2 每实例 `<instancesDir>/<name>/blocknexus.json`

```jsonc
{
  "name": "survival", "version": "1.21.4", "source": "vanilla|paper|purpur|folia|fabric|forge|neoforge|url|upload",
  "build": "", "url": "", "port": 25565, "memoryMB": 2048,
  "motd": "A Minecraft Server", "onlineMode": true,
  "note": "", "address": "",
  "watchdog":       { "autoRestart": false, "restartDelaySec": 5, "schedules": [] },
  "backupSchedule": { "enabled": false, "keepCount": 0, "schedules": [] },
  "eula": true,
  "installState": "downloading|ready|failed",
  "createdAt": 0,
  "launch": { "kind": "jar|argsfile", "file": "server.jar", "argsFile": "…" },
  "error": ""
}
```

- 初始形状：`agent/src/instance/install.js:42-59`；`launch` 由安装阶段写入（`:86`、`:169`、`:203`）；`installState` 与 `error` 驱动前端状态徽章（`agent/src/instance/manager.js:62-73`）。
- 调度设置就活在这两个字段里（`watchdog.js:12-43`、`backup-schedule.js:12-44`）。
- **实例注册表不存在**：列表 = 扫 `instancesDir` 下的目录 + 读同名 `blocknexus.json`（`agent/src/instance/manager.js:34-60`），因此「删目录 = 删实例」，无数据库一致性可言。
- 元数据文件名有历史迁移：首次扫描时 `mcpan.json` → `blocknexus.json`（`manager.js:47-54`）。
- 世界存档、`server.properties`、`eula.txt`、`mods/`、`server-icon.png` 与元数据**同目录平铺**；备份另存于 `<instancesDir>/.backups/<name>/`（`agent/src/instance/backups.js:14-16`）。

### B.3 磁盘缓存（可丢，纯提速/兜底）

| 文件 | 内容 | TTL | 引用 |
| --- | --- | --- | --- |
| `data/mc-versions-cache.json` | 规范化后的 Mojang 版本清单 | 新鲜 1 小时 / 可用 7 天 | `panel/api.js:979-981`、`:1044-1048`、`:1054-1058` |
| `data/mc-cores-cache.json` | 7 类核心的版本目录 | 同上 | `panel/api.js:1078`、`:1224-1233` |

### B.4 纯内存态（面板/Agent 重启即丢）

- 面板：`sessions`（`panel/api.js:87`）、`sseClients`（`:88`）、`installing`（`:89`）、`taskLogs`（`:95`）、`statsCache`（`:147`）、`offlineNotified`（`:207`）、`agentUpdateState`/`agentUpdateTries`（`:246-247`）、`loginFails`（`:327`）、`forgotSent`/`verifyFails`/`resetTickets`/`codeTries`（`:397-400`）、`versionCache`（`:38`）、`panelInstalls`/`panelFallbackAt`（`:1514-1515`）、`javaRefreshing`（`:2477`）。
- Agent：`uploads` / `downloads` 传输会话（`agent/src/instance/fs.js:201`）、`javaJob`（`manager.js:20`）、`bootstrapJobs`（`manager.js:21`）、实例控制台环形缓冲（**上限 500 行**，`manager.js:194`）、`rec.players` 跟踪集（`lifecycle.js:121`）、`crashTimes` 崩溃窗口（`watchdog.js:94`）。

**对比含义**：把面板进程杀掉再拉起，所有会话、限流计数、安装日志、Agent 更新退避状态、传输会话全部归零；已落盘的只有 `config.json`、每实例 `blocknexus.json` 与其世界文件。
