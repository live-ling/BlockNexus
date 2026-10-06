# P0 立即整改计划（安全加固 + 启用已有资产）

> 上游依据：[opanel-adoption-plan.md](./opanel-adoption-plan.md) §1（安全四条）与 §2.7（CI 补强）、[blocknexus-current-state.md](./blocknexus-current-state.md) §1.3/§1.4/§8.3/§9.5。
> 本文档是**执行清单**：每一个改动都给出精确文件:行、具体做法、验证方法、风险与回滚。所有行号已在当前工作树（`panel/api.js` 2928 行）上复核。
> 目标版本：面板 `0.3.1`（补丁号递增，见 §0.3）。**不涉及 Agent 行为改动**，因此不动 `AGENT_VERSION`。

---

## 0. 总则

> **执行状态（2026-10-06）：P0-1 ~ P0-5 已实现并验证通过，P0-6 回归测试已落地（23/23）。**
>
> | 编号 | 状态 | 关键证据 |
> |---|---|---|
> | P0-1 | ✅ 完成 | `panel/net.js` 新增 `parseTrustProxy`；`server.js` 条件 `app.set('trust proxy', ...)`；5 种取值形态实测符合预期 |
> | P0-2 | ✅ 完成 | `panel/api.js` 新增 `cookieAttrs(req)`，三处 `Set-Cookie` 已接；实测默认不带 `Secure`、`secureCookies=true` 带 `Secure` |
> | P0-3 | ✅ 完成 | `loginFails` 补 `at` 字段 + `pruneLoginFails()` 纳入 60 秒 GC + `LOGIN_MAX_TRACKED` 上限（满则淘汰最早） |
> | P0-4 | ✅ 完成 | 中间件覆盖 `POST/PUT/PATCH/DELETE`，带 body 才校验 Content-Type，无 body 放行；**实机验证 `DELETE /servers/:id` 无 body 返回 401 而非 415** |
> | P0-5 | ✅ 完成 | `ci.yml` 增加 `build.js --check`、`test:agent`、`oxlint` 三步 |
> | P0-6 | ✅ 完成 | 新增 `agent/test-panel-security.js`，**23/23 通过**，已接入 `test:agent` 链 |
>
> **全量回归**：`npm run test:agent` 退出码 0（73 项模块检查 + 各脚本 + 23 项新安全用例）；`npx oxlint` 0 error；`npm run build:web` 成功。
> **未改**：`agent/agent.js`（无 `AGENT_VERSION` 递增）、`panel/crypto.js` 的 HKDF 标签、`data/config.json` 字段结构、任何第三方依赖。
> **本批计划外的必要修正**：① `LOGIN_LOCK_MS`/`LOGIN_MAX_FAILS` 改为可经 `limiterOpts` 注入（与既有 `cooldownMs` 等约定一致，生产行为不变）；② 修掉 `server.js` 中 `tlsOn` 的 TDZ 引用（原写法会在启动时 `ReferenceError`）；③ 锁定提示文案由硬编码「5 分钟」改为按 `LOGIN_LOCK_MS` 计算。

### 0.1 本批范围

| 编号 | 项目 | 类型 | 预估 | 风险 |
|---|---|---|---|---|
| **P0-1** | `trust proxy` 白名单化 | 安全修复 | 1.5 h | 中（配置错误可绕过限流） |
| **P0-2** | `Secure` Cookie 标志 | 安全修复 | 1 h | 低 |
| **P0-3** | `loginFails` GC + 容量上限 | 安全修复 | 1 h | 低 |
| **P0-4** | CSRF 中间件覆盖写方法 | 安全修复（语义） | 1.5 h | **中（可能 415 打断现有功能）** |
| **P0-5** | CI 启用 Agent 测试 / 产物新鲜度 / oxlint | 工程 | 1 h | 低 |
| **P0-6** | P0-1/3/4 的回归测试 | 测试 | 2 h | 低 |

合计约 **8 人时 / 1 个工作日**。建议**一天内一次性合并**，因为它们共同构成「面板暴露在反代后仍然安全」这一个可验证的状态。

**明确不在本批**：WebSocket 替换 SSE、cron 调度、i18n、前端测试框架、任何 MC 领域新功能。这些进路线图的 P1+（见 [iteration-roadmap.md](./iteration-roadmap.md)）。

### 0.2 不改的东西（红线）

- ❌ 不引入任何新的 npm 依赖（面板依赖仅 `express/nodemailer/ssh2/ws`）。
- ❌ 不改 `agent/src/**`（因此无需 `npm run build:agent`，也**不要**递增 `AGENT_VERSION`）。
- ❌ 不改现有登录/限流的**阈值语义**（仍是「5 次失败 → 锁 5 分钟」）。OPanel 用 10 分钟，我们**保持 5 分钟**，避免顺手改行为导致用户困惑。
- ❌ 不改 HKDF 的 `'mcpan/*'` info 标签（`panel/crypto.js:25-31`）——那是旧 Agent 兼容锚点，动了会让所有存量 Agent 失联。
- ❌ 不改 `data/config.json` 的字段结构（本批不落盘任何新配置，全部走启动参数/环境变量）。

### 0.3 基线验证结果（2026-10-06 实测）

动手前先跑了一遍**改动前**的全套检查，用于事后区分「本来就这样」与「被我改坏了」。**结论：改动前全绿，`npm run test:agent` 退出码 0，可以作为回归基准。**

| 检查 | 结果 |
|---|---|
| `npm run test:agent`（11 个脚本完整链） | ✅ **退出码 0** |
| ├ `test-module-imports` | ✅ 73/73（1 条低置信度提示 `ws.js: timeoutMs`，是扫描噪音非错误） |
| ├ `build.js --check` | ✅ 同步（23 个模块，4842 行） |
| ├ `test-bundle-fresh` | ✅ 5/5 |
| ├ `test-bundle-smoke` | ✅ 5/5 |
| ├ `test-bootstrap-vanilla` | ✅ 12/12 |
| ├ `test-start-singleflight` | ✅ 18/18 |
| ├ `test-watchdog-schedule` / `test-backup-schedule` | ✅ |
| ├ `test-player-tracking` | ✅ 9/9 + 4/4（含中文处撕裂、跨 chunk 拼行） |
| ├ `test-fs-ops` | ✅ 20/20（含 tar/zip 压缩解压） |
| └ `e2e-panel-install` | ✅ 7/7 |
| `web` 的 `npx oxlint` | ✅ 退出码 0（60 warnings / **0 errors**） |

**给 P0-5 的两点结论**：

1. `oxlint` 是 0 error，CI 里直接 `npx oxlint`（`working-directory: web`）即可，**不需要**任何 `--deny-warnings=false` 之类的放水参数。
2. `test:agent` 在普通环境下本来就是全绿，CI 里加它**不会引入既有失败**。

> **踩过的坑（记录以免重犯）**：在**受限文件沙箱**下跑这套测试会出现 `spawn EPERM`（`test-bundle-smoke.js:45` 与 `test-fs-ops` 调系统 `tar` 时），因为该模式禁止子进程用管道捕获输出。最小复现：任何 `spawn(..., {stdio:['ignore','pipe','pipe']})` 或 `spawnSync('tar', ...)` 都直接返回 `EPERM`。
> **在非受限环境下（普通终端、GitHub CI）一切正常**——本节的 ✅ 就是在切到完全访问后取得的。
> 顺带一个测量陷阱：用 `npm run test:agent 2>&1 | Select-String ...` 这类管道时，`$LASTEXITCODE` 反映的是**管道最后一环**的退出码，不是 npm 的。要拿真实结果必须重定向到文件后再读 `$LASTEXITCODE`（本节即如此）。

### 0.4 版本与提交约定

- `package.json` 的 `version` 由 `0.3.0` → **`0.3.1`**（`panel/api.js:20-22` 与 `panel/server.js:84` 都从这里读，无需另改）。
- **本批不发布 GitHub Release**。按 `AGENTS.md`：推送代码不发版，用户面板的更新检查只认 Release 标签。P0 只在代码层落地。
- 提交粒度：**6 个独立 commit**（P0-1…P0-6 各一），便于单独 revert。每个 commit 信息写清楚「为什么」。
- 建议分支：`p0-security-hardening`（若你想走 PR 流程），或直接 `main`（当前是单人开发）。

---

## P0-1：`trust proxy` 白名单化

### 问题

`req.ip` 是**面板全部限流的唯一分桶键**，出现在 4 处：

| 位置 | 用途 |
|---|---|
| `panel/api.js:330` | 登录失败计数（5 次 → 锁 5 分钟） |
| `panel/api.js:410` | 忘记密码发码（60 秒冷却 + 每小时 5 次） |
| `panel/api.js:462` | 验证码校验失败（5 次 → 锁 15 分钟） |

全 `panel/*.js` 搜 `trust proxy` **零命中**。而 `README.md` 推荐「面板前加 HTTPS 反向代理」。两者相遇的后果：

- **反向代理后**：`req.ip` 恒为代理地址（通常是 `127.0.0.1`）→ 所有用户共享一个桶 → **任一攻击者失败 5 次，全体用户 5 分钟无法登录**；发码配额同样变成全局，第 6 个正常人收不到验证码。限流从「防爆破」退化成「拒绝服务放大器」。
- **当前之所以没炸**：默认只监听 `127.0.0.1`（`panel/server.js:22`），且用户多半没开反代。

### 做法

**新增启动参数，显式白名单，默认关闭**（默认关闭 = 默认安全，且不改现有行为）。

`panel/server.js`，在三段版本号/参数解析区（`:16-26`）之后新增：

```js
// ---------- 反向代理信任（限流按真实客户端 IP 分桶）----------
// 不配 → 不信任任何转发头（req.ip = 直连地址），默认安全。
// 配 hop 数（推荐，如 1 = 只有紧邻的那一层反代）；
// 或配 IP/CIDR 列表；或配 'loopback' / 'linklocal' 等 express 预设。
// ⚠ 面板直连公网时绝不能开：攻击者可伪造 X-Forwarded-For 绕过限流。
const TRUST_PROXY = (() => {
  const raw = String(argOf('trust-proxy') || process.env.BLOCKNEXUS_TRUST_PROXY || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);            // 跳数
  if (['loopback', 'linklocal', 'uniquelocal'].includes(raw)) return raw;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
})();
```

在建 app 之前（`panel/server.js:44` 附近）应用：

```js
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY !== null) app.set('trust proxy', TRUST_PROXY);
```

**为什么用跳数而不是 IP 列表作默认推荐**：`X-Forwarded-For` 是由每一层代理**追加**自己的上游地址形成的。Express 在 `trust proxy = N` 时取「从右往左数第 N+1 个」，因此**攻击者往请求里预塞多少个 `X-Forwarded-For` 都没用**——这是抗伪造的关键。而 IP 列表写法若把范围写宽（例如为了图省事写 `0.0.0.0/0`），就等于无条件信任。**文档里必须把这一点写清楚。**

启动横幅（`panel/server.js:83-110`）补一行状态提示：

```js
console.log(`  反代信任:   ${TRUST_PROXY === null ? '未启用（按直连地址限流）' : `已启用（${JSON.stringify(TRUST_PROXY)}；请确认面板不直连公网）`}`);
```

`README.md`「安全注意事项」章节补一小段，含**验证方法**：

> 配置反代后，用两台不同设备各输错 5 次密码。若第二台设备的锁定提示带**剩余秒数**（说明命中同一个桶）→ `trust proxy` 没生效或配置有误；若第二台能正常尝试而不被锁 → 生效。

### 验证

1. **不配 `--trust-proxy`**：启动，从 `127.0.0.1` 直接请求，限流行为与改动前**逐字节一致**（用 `agent/e2e-reset-code.js` 回归，它本就不设 trust proxy 的那条路径——注意该脚本**自己**设了 `app.set('trust proxy', true)`，见 `agent/e2e-reset-code.js:112`，所以它不受本改动影响）。
2. **配 `--trust-proxy 1`**：`curl -H 'X-Forwarded-For: 1.2.3.4'` 与 `-H 'X-Forwarded-For: 5.6.7.8'` 各失败 5 次，两者应**各自锁定、互不影响**。
3. **配 `--trust-proxy 1` 但伪造两层**：`-H 'X-Forwarded-For: 9.9.9.9, 1.2.3.4'` 时，Express 取下一位（`1.2.3.4`）作为 `req.ip`——确认攻击者不能用前置伪造值冒充别人。

### 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 用户把 hop 数配大（如 `--trust-proxy 10`） | 等效于信任任意转发头 → 可绕过限流 | 启动横幅显式打印当前值；README 警告「hop 数应等于你实际部署的代理层数」 |
| 面板直连公网却开了此参数 | `X-Forwarded-For` 可任意伪造 | 保持**默认关闭**；横幅措辞明确要求「确认面板不直连公网」 |
| 用户以为开了就万事大吉 | 反代没传 `X-Forwarded-For` 时 `req.ip` 仍是直连地址 | `express` 会自动处理；README 提示检查反代的 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` |

**回滚**：删除 `app.set('trust proxy', ...)` 一行即完全回到现状（参数解析残留无害）。

---

## P0-2：`Secure` Cookie 标志

### 问题

三处 `Set-Cookie` 均为 `HttpOnly; SameSite=Lax; Path=/`，**无 `Secure`**：

| 行 | 场景 |
|---|---|
| `panel/api.js:356` | 登录发会话 |
| `panel/api.js:363` | 登出清 Cookie |
| `panel/api.js:625` | 设置页开启登录保护时补发会话 |

而面板**自身支持 HTTPS**（`panel/server.js:24-25,74-79` 的 `--tls-cert/--tls-key`，`tlsOn` 变量已存在）。HTTPS 部署下浏览器仍允许把这个会话 Cookie 经明文 HTTP 发出——同域一次 `http://` 请求（或子域降级）即可泄露会话。

### 做法

`createApi` 增加第 5 个参数（**放在 `limiterOpts` 之后，保持向后兼容**——现有测试调用是 `createApi(config, hub, bus)` 与 `createApi(config, hub, bus, LIMITS)`，两者都不受影响）：

```js
function createApi(config, hub, bus, limiterOpts = {}, opts = {}) {
```

在鉴权区（`panel/api.js:303` 附近）新增：

```js
// Cookie 的 Secure 标志：TLS 直连或显式声明强制加；否则按请求本身是否加密决定
// （反代后 req.secure 依赖 trust proxy，未配时退化为 false——与 P0-1 的警告一致）
const FORCE_SECURE_COOKIE = opts.secureCookies === true;
function cookieAttrs(req) {
  return (FORCE_SECURE_COOKIE || (req && req.secure)) ? '; Secure' : '';
}
```

三处替换：

```js
// :356
res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/${maxAge}${cookieAttrs(req)}`);
// :363
res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieAttrs(req)}`);
// :625
res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${cookieAttrs(req)}`);
```

`panel/server.js`：新增 `SECURE_COOKIE = argOf('secure-cookies') !== null || process.env.BLOCKNEXUS_SECURE_COOKIES === '1'`，并传参：

```js
app.use('/api', createApi(config, hub, bus, {}, { secureCookies: tlsOn || SECURE_COOKIE }));
```

> 注意参数位置：第 4 个 `limiterOpts` 传 `{}`（生产不用测试注入），第 5 个传 opts。

启动横幅补一行 `Cookie 安全标志: Secure 已启用 / 未启用（HTTP 直连时正常）`。

### 设计取舍（要说清楚，避免以后被"优化"掉）

**为什么用 `tlsOn || SECURE_COOKIE || req.secure` 而不是只看 `tlsOn`**：面板可能**同时**通过 `http://127.0.0.1:3080`（本机）和 `https://panel.example.com`（反代）访问。若全局只看 `tlsOn`（反代场景下为 `false`），后者的 Cookie 就没有 `Secure`——漏掉正是要修的洞。按请求判定能同时正确覆盖两种入口。

**安全性检查**：不存在「先不带 Secure 种下、再带着 Secure 读」导致用户登不上」的场景——`req.secure` 对同一个入口是稳定的，登录发 Cookie 与后续读 Cookie 走同一判定。

### 验证

1. **HTTP 直连**（无 TLS、不传 `--secure-cookies`）：`Set-Cookie` 与改动前一致（**无** `Secure`），本地 `http://127.0.0.1:3080` 登录正常。
2. **传 `--secure-cookies`**：登录响应头包含 `; Secure`。（注意：此时在纯 HTTP 下浏览器会**拒绝保存**该 Cookie——这是预期行为，正是该参数的意义；README 要写明「仅在你确实用 HTTPS 访问时开启」。）
3. **TLS 启动**（`--tls-cert/--tls-key`）：`https://` 下登录响应含 `; Secure`，登录后可正常访问受保护接口。
4. `agent/e2e-reset-code.js` 与 `agent/e2e-panel-install.js` 全绿（两者都不传第 5 参数 → `opts = {}` → `FORCE_SECURE_COOKIE = false`；e2e 走 HTTP，`req.secure` 为 false → 行为与现状一致）。

### 风险与回滚

| 风险 | 缓解 |
|---|---|
| 用户开了 `--secure-cookies` 却用 HTTP 访问 → 登录后立刻掉线 | README 明确写「仅 HTTPS 场景开启」；启动横幅提示当前状态；错误现象直观（登录成功但下一次请求 401） |
| 反代后未配 `trust proxy` → `req.secure` 恒 false → 漏加 Secure | 与 P0-1 的文档同一处警告；两者应一起配置 |

**回滚**：把 `cookieAttrs(req)` 三处删回空串即可；传参残留无害。

---

## P0-3：`loginFails` GC + 容量上限

### 问题

`panel/api.js:540-551` 的 60 秒 GC 任务只清三张表：

```js
for (const [ip, r] of forgotSent)   { ... forgotSent.delete(ip); }
for (const [ip, r] of verifyFails)  { ... verifyFails.delete(ip); }
for (const [t, exp] of resetTickets){ ... resetTickets.delete(t); }
```

**`loginFails`（`panel/api.js:327`）不在其中**。它的 `delete` 只发生在登录成功时（`:348`）。锁定到期后记录**永久驻留**（`{count, until}`）。因为它是按来源 IP 建键的，公网暴露时这是**可被外部驱动的无界内存增长**。

### 做法

**(a) 纳入 GC**（`panel/api.js:540-551` 的循环内追加）：

```js
// loginFails：锁定已过期、且距上次尝试超过锁定窗口 → 清理
for (const [ip, r] of loginFails) {
  if ((r.until || 0) <= now && now - (r.at || 0) > LOGIN_LOCK_MS) loginFails.delete(ip);
}
```

需要在写记录时补一个 `at` 时间戳（`panel/api.js:339-342`）：

```js
loginFails.set(ip, {
  count,
  until: count >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0,
  at: Date.now(),   // 新增：供 GC 判断"最后一次尝试"的时间
});
```

**(b) 容量上限**（对齐 OPanel 的 `MAX_TRACKED_IPS = 10000`，`LoginAttemptTracker.java:8,110-112`）。在 `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MS` 定义处（`panel/api.js:325-327`）新增常量：

```js
const LOGIN_MAX_TRACKED = 10000; // 限流记录上限，防分布式攻击撑爆内存
```

在 `loginFails.set(...)` 之前加：

```js
if (loginFails.size >= LOGIN_MAX_TRACKED && !loginFails.has(ip)) {
  // 表满：淘汰一条最旧的（Map 保持插入序，首个即最早）
  const oldest = loginFails.keys().next().value;
  if (oldest !== undefined) loginFails.delete(oldest);
}
```

然后在记录前跑一次与 GC 相同的过期清理，避免"表满但内容全是过期的"：

```js
for (const [k, r] of loginFails) {
  if ((r.until || 0) <= Date.now() && Date.now() - (r.at || 0) > LOGIN_LOCK_MS) loginFails.delete(k);
}
```

> **为什么淘汰最旧而不是返回 429**：OPanel 在表满时返回 429 —— 那在分布式攻击下等于**顺手做出了拒绝服务**（攻击者用 10000 个源 IP 就能让正常用户也被拒）。淘汰最旧是更稳的语义：限流精度轻微下降，但永不主动拒绝。

### 验证

1. 单元级：连续用 12 个不同的 `X-Forwarded-For` 各失败 5 次，等待 > `LOGIN_LOCK_MS`（测试里可用 `limiterOpts` 注入短窗口）后跑一次 GC 周期，断言 `loginFails.size` 回落。
2. 上限级：把 `LOGIN_MAX_TRACKED` 临时降到 3（或通过 `limiterOpts` 注入），发 5 个不同 IP，断言 `size <= 3` 且**最先插入的那条被淘汰**。
3. 行为不变：同一 IP 连续失败 5 次仍锁 5 分钟，第 6 次仍返回 429 带剩余秒数。

### 风险与回滚

**风险**：极低。唯一可感知的变化是「表满时最早的一条记录被遗忘」——对真实用户无影响。
**回滚**：删除 GC 循环里的 `loginFails` 分支与容量判断。

---

## P0-4：CSRF 中间件覆盖写方法

### 问题

`panel/api.js:315-321`：

```js
router.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    if (req.path.endsWith('/files/upload/sftp')) return next();
    return res.status(415).json({ error: '需要 application/json' });
  }
  next();
});
```

**只检查 `POST`**。现有 9 条写路由中，**3 条 `PUT` 与 2 条 `DELETE` 完全不被这条中间件覆盖**（`panel/api.js:602,827,859,2259,2288,2306,2323,2350,2554`）。

**评估**：实际风险低（原生 HTML 表单发不出 `PUT`/`DELETE`，且无 CORS 中间件 + `SameSite=Lax`）。但这是**「防护面看起来比实际宽」**——审计者读到这条会以为所有写请求都被覆盖。修它的价值在于**让代码如实表达意图**，并给将来可能加的 CORS/`SameSite=None` 留一道明确的闸。

### 关键前提（先读这一节，否则改动会 415 打断现有功能）

当前前端行为（`web/src/lib/api.ts:571`）：

```js
headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
```

即**有 body 才带 header，无 body 完全不带 `Content-Type`**。已核实全部 9 条写路由对应的前端调用：

| 前端调用点 | 方法 | body | 改动后走哪条分支 |
|---|---|---|---|
| `web/src/pages/instance-detail.tsx:727-731` | DELETE `.../instances/:name` | `{backupFirst, force}` | 有 body → 校验 JSON ✓ |
| `web/src/pages/server-settings.tsx:503` | DELETE `/servers/:id` | **无** | **无 body → 放行（关键！）** |
| `web/src/App.tsx:127` | POST `/logout` | `{}` | 有 body → 校验 JSON ✓ |
| `web/src/pages/panel-settings.tsx:414,563,713,732,870,1088` | PUT `/settings` | 有 | 校验 JSON ✓ |
| `web/src/components/dialogs.tsx:455,1209` | PUT `/servers/:id` | 有 | 校验 JSON ✓ |
| `web/src/components/auto-restart-dialog.tsx:256` | PUT `.../watchdog` | 有 | 校验 JSON ✓ |
| `web/src/components/properties-dialog.tsx:135` | PUT `.../properties` | 有 | 校验 JSON ✓ |
| `web/src/components/plugin-config-dialog.tsx:415`、`file-manager.tsx:268` | PUT `.../files/content` | 有 | 校验 JSON ✓ |
| `web/src/lib/api.ts:382` | PUT（通用封装） | 有 | 校验 JSON ✓ |

> ⚠ **`server-settings.tsx:503` 是本次改动唯一的真实地雷**：它 `method:'DELETE'` 且**没有 body**，因此 `api.ts:571` 不设 `Content-Type`。**如果写成朴素的 `!req.is('application/json')`，删除服务器会立刻 415 失败。** 这正是「无 body 放行」分支存在的理由——它不是一个宽松的妥协，而是**必须有的正确性条件**。

### 做法

替换为：

```js
// 简单 CSRF 防护：带 body 的写请求必须是 JSON / 表单编码；无 body 的写请求放行。
// ⚠ 前提（已核实）：前端只在有 body 时才设 Content-Type（web/src/lib/api.ts:571），
//   而 DELETE /servers/:id（server-settings.tsx:503）是无 body 的——若不放行无 body
//   请求，删除服务器会立刻 415 失败。
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_SAFE_TYPES = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'];

/** 请求是否带 body。用 content-length / transfer-encoding 判定，不依赖 Content-Type */
function hasRequestBody(req) {
  if (req.headers['transfer-encoding'] !== undefined) return true; // 分块传输
  return Number(req.headers['content-length'] || 0) > 0;
}

router.use((req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  // 无 body 的写请求没有可伪造的载荷；放行是正确性要求，不是宽松妥协
  if (!hasRequestBody(req)) return next();
  // 纵深防御：跨域 HTML 表单只能发出安全列表内的 Content-Type，其余（含 application/json
  // 与 PUT/PATCH/DELETE）都会触发 CORS 预检。真正的防线是 SameSite=Lax + 无 CORS 中间件，
  // 本检查是第二层，不是主防线。
  if (!CSRF_SAFE_TYPES.some((t) => req.is(t))) {
    if (req.path.endsWith('/files/upload/sftp')) return next();
    return res.status(415).json({ error: '需要 application/json' });
  }
  next();
});
```

> 抽成具名的 `hasRequestBody(req)` 而不是内联一个复杂表达式——这是本项改动唯一容易误解的地方，必须能单独加注释、单独测。

### 为什么可以放行 `application/x-www-form-urlencoded` 与 `multipart/form-data`

这两个是 CORS **安全列表**类型，跨域表单**可以**发出。但：

- 现有前端**从不**发这两个类型（只有 JSON 与 SFTP 的 octet-stream）。放行它们只是为将来的表单上传留路。
- 真正的防线是 `SameSite=Lax`（跨站请求根本不带会话 Cookie）+ 全库无 CORS 中间件。**Content-Type 检查是纵深防御的第二层，不是唯一防线**——这一点必须写进代码注释，避免后人误以为它是主防线（OPanel 那份调研里已澄清过这个流传很广的误解）。

若你希望**更严**，可以把 `CSRF_SAFE_TYPES` 收窄为只允许 `application/json`，但那样必须同时保证前端所有写请求都带 body 且带正确的 header——**不建议在本批做**，风险大于收益。

### 验证（必须逐条手工回归，因为可能 415）

逐项在 UI 里点一遍，全部应成功：

| 功能 | 方法 | 是否有 body | 改动后预期 |
|---|---|---|---|
| 面板设置保存 | PUT `/settings` | 是（JSON） | 200 |
| 服务器编辑 | PUT `/servers/:id` | 是 | 200 |
| **删除服务器** | DELETE `/servers/:id` | **否** | **200（走「无 body 放行」，最易被改错的一处）** |
| 删除实例 | DELETE `.../instances/:name` | 是 | 200 |
| 实例编辑 | PUT `.../instances/:name` | 是 | 200 |
| 看门狗设置 | PUT `.../watchdog` | 是 | 200 |
| 定时备份设置 | PUT `.../backup-schedule` | 是 | 200 |
| properties 保存 | PUT `.../properties` | 是 | 200 |
| 文件内容保存 | PUT `.../files/content` | 是 | 200 |
| 插件配置保存 | PUT `.../files/content` | 是 | 200 |
| 开启/关闭登录保护 | PUT `/settings` | 是 | 200 |
| 登出 | POST `/logout` | 是（`{}`） | 200 |
| SFTP 直传 | POST `.../files/upload/sftp` | 是（binary） | 200（豁免生效） |

上表已把 `web/src` 中全部 9 条写路由的前端调用点核实并归类（见「关键前提」节的对照表），**无待确认项**。

### 风险与回滚

| 风险 | 缓解 |
|---|---|
| **无 body 的写请求被 415 打断** | 先补全上表；`agent/e2e-panel-install.js` 与 `test-fs-ops.js` 覆盖了文件操作与删除路径，必须全绿 |
| SFTP 上传被拦 | 保留豁免分支，且 e2e 需覆盖 |
| 后人误以为这是主防线 | 代码注释明确写「防线是 SameSite + 无 CORS，本检查是纵深防御」 |

**回滚**：单行改回 `if (req.method === 'POST' && ...)`。

---

## P0-5：CI 启用已有资产

### 问题

`.github/workflows/ci.yml` 只有 2 个 job，且都在做「最低限度」的事：

- `backend`：`node --check` 遍历 `panel/*.js agent/*.js scripts/*.js`——**只做语法检查**。
- `frontend`：`npm ci && npm run build`——唯一的类型检查入口。

**完全没有跑**：`npm run test:agent`（11 个脚本、≈120+ 条断言）、`node agent/build.js --check`（Agent 产物新鲜度）、`oxlint`（存在但无人调用）。也就是说**本仓库最厚的测试资产只在开发者本机跑**。

### 做法

`backend` job 在 `node --check` 之后追加两步：

```yaml
      - name: Agent 产物新鲜度（src 改动后忘了 build:agent 会被拦下）
        run: node agent/build.js --check

      - name: Agent 测试（零依赖，不需要面板与真实服务器）
        run: npm run test:agent
```

`frontend` job 在 `npm run build` 之前追加：

```yaml
      - name: Lint
        run: npx oxlint
        working-directory: web
```

### 必须先在本地验证（否则会把 CI 弄红）

```powershell
node agent/build.js --check
npm run test:agent
cd web; npx oxlint
```

**已知风险**：

| 项 | 风险 | 处置 |
|---|---|---|
| `test:agent` 在 Linux 上 | 11 个脚本零依赖、用本地端口与临时目录；`test-fs-ops.js` 与 `e2e-panel-install.js` 会调系统 `tar`。Ubuntu runner 自带 `tar` ✓ | 本地先跑；若个别脚本有平台假设，**单独标注并在 CI 里跳过它**，不要因此放弃整批 |
| `test-bundle-smoke.js` 起真实进程占端口 | 用本地临时端口，跑两次不冲突 | 本地连跑两次确认 |
| `oxlint` 可能有既有告警 | `.oxlintrc.json` 只有 3 条规则（`react/rules-of-hooks`=error、`react/only-export-components`=warn） | 若 warn 导致非零退出，CI 里用 `npx oxlint --deny-warnings=false` 或先修掉；**不要**为了让 CI 绿而关规则 |

### 验证

推一个**故意破坏**的提交到分支，确认 CI 真的拦得住，然后 revert：

1. 改 `agent/src/util.js` 一个空格**不**跑 `build:agent` → `build.js --check` 应变红。
2. 在 `panel/api.js` 里加一行 `const x = ;` → `node --check` 应变红。
3. 在 `web/src` 里写一个违反 hooks 规则的组件 → `oxlint` 应变红。

### 风险与回滚

**风险**：CI 变红阻塞合并。**缓解**：先本地跑三遍全绿再上；若要临时放行，**单独注释掉那一步并留 TODO**，而不是删掉。
**回滚**：删除追加的 3 个 step。

---

## P0-6：P0-1/3/4 的回归测试

### 做法

沿用现有测试风格（零依赖、`check(desc, ok, detail)` + `process.exit(pass===total?0:1)`，见 `blocknexus-current-state.md` §8.1），新增 **`agent/test-panel-security.js`**，并在 `package.json:11` 的 `test:agent` 链末追加它。

覆盖用例：

| # | 用例 | 断言 |
|---|---|---|
| 1 | 未配 trust proxy 时，`X-Forwarded-For` 不影响分桶 | 两个不同 XFF 失败 5 次后，第 6 次仍从**直连 IP** 的桶判断 |
| 2 | 配 trust proxy=1 时，不同 XFF 各自分桶 | A 锁定时 B 仍可尝试 |
| 3 | trust proxy=1 时伪造两层 XFF | 取到的是最后一跳的下一位，不是最左值 |
| 4 | `loginFails` GC 生效 | 注入短窗口，走完 GC 周期后 `size` 回落 |
| 5 | `loginFails` 容量上限 | 注入 `maxTracked=3`，插 5 条后 `size<=3` 且淘汰最旧 |
| 6 | 无 body 的 DELETE 不被 415 | 无 `Content-Type` 的 DELETE → 非 415 |
| 7 | 带 JSON body 的 DELETE/PUT 正常 | 带 `application/json` → 非 415 |
| 8 | 带非法 Content-Type 的写请求被拦 | `text/plain` → 415 |
| 9 | SFTP 上传豁免仍生效 | `application/octet-stream` → 非 415 |
| 10 | `--secure-cookies` 下响应含 `; Secure` | 断言 `Set-Cookie` 含 `Secure` |
| 11 | 默认（无 TLS、无参数）不含 `Secure` | 断言不含，防回归到"到处都加" |

**实现要点**：仿照 `agent/e2e-reset-code.js:112-115` 的写法——**在同进程内**建一个隔离的 express app + `createApi(...)`，`app.listen` 到本地临时端口，用 `fetch` 发请求，用 `X-Forwarded-For` 模拟来源 IP。为让第 4/5 条可测，把 `maxTracked` 也纳入 `limiterOpts` 注入（与现有 `cooldownMs`/`windowMs`/`lockMs`/`maxCodeTries` 同列，**生产不传**）。

> **硬约束：本测试脚本绝不能 `spawn` 子进程**（不要用 `child_process`）。同进程内 `app.listen` + `fetch` 即可完成全部 11 条用例。这样它在受限沙箱里也能跑，**本地就能自验证**，不必依赖 CI（参见 §0.3 的两处 `spawn EPERM`）。

### 验证

`npm run test:agent` 全绿；单独 `node agent/test-panel-security.js` 退出码为 0。

---

## 1. 执行顺序与提交划分

严格按此顺序（后一项依赖前一项的验证结论）：

```
P0-5 先做 ─────────────────────► 好处：先有 CI 门禁，后面每个改动都被自动验证
   │
P0-1 trust proxy
   │
P0-2 Secure Cookie
   │
P0-3 loginFails GC ────────────► 与 P0-1 同属"限流正确性"，可一起手工验证
   │
P0-4 CSRF 方法覆盖 ────────────► 风险最高，放最后，单独一个 commit 便于 revert
   │
P0-6 回归测试 ────────────────► 把前四项的验证固化成自动化
   │
最终：6 个 commit → 一次性合并 → 手工回归上表 → 推 main
```

| commit | 内容 | 本地必过 |
|---|---|---|
| 1 | `ci: 启用 Agent 测试、产物新鲜度检查与 oxlint` | `node agent/build.js --check`、`npm run test:agent`、`npx oxlint` |
| 2 | `fix(面板): trust proxy 显式白名单化，修复反代下限流退化为全局锁` | e2e-reset-code、手工两条用例 |
| 3 | `fix(面板): HTTPS 下发 Secure 会话 Cookie` | 手工 HTTP/HTTPS 各一次 |
| 4 | `fix(面板): loginFails 纳入 GC 并加容量上限，修复无界内存增长` | 手工 12 IP 用例 |
| 5 | `fix(面板): CSRF 中间件覆盖 PUT/PATCH/DELETE（无 body 放行）` | **全量 UI 回归表** |
| 6 | `test(面板): 新增 P0 安全回归测试` | `npm run test:agent` 全绿 |

---

## 2. 完成定义（DoD）

本批视为完成，当且仅当**全部满足**：

- [ ] 6 个 commit 已推送 `main`（或 PR 已合并）
- [ ] `npm run test:agent` 全绿（含新增的 `test-panel-security.js`）
- [ ] `node agent/build.js --check` 通过
- [ ] `cd web && npx oxlint` 通过
- [ ] `npm run build:web` 成功（前端未改逻辑，仅确认没连带破坏）
- [ ] §P0-4 的 UI 回归表**逐项手工点过**，无 415
- [ ] `README.md` 的「安全注意事项」补上 `--trust-proxy` 与 `--secure-cookies` 的说明与验证方法（**面向用户的主文档，AGENTS.md 要求新功能补对应章节**）
- [ ] 未改 `AGENT_VERSION`、未改 `panel/crypto.js` 的 HKDF 标签、未新增依赖
- [ ] 确认 `git status` 里没有 `data/`、`.opanel-reference/`、`docs/` 之外的意外改动

---

## 3. 需要你确认的三个决策点

1. **`--trust-proxy` 的形态**：我建议「hop 数（推荐）+ IP/CIDR 列表」两种都支持，默认关闭。你是否有**固定的反代部署形态**（如 Nginx 单层）？若有，可以在 README 里直接给出「照抄这一行」的配置，降低误配概率。
2. **`--secure-cookies` 要不要一个「自动」档**：现在是「TLS 直连自动开 / 反代需显式开」。要不要做成「检测到 `X-Forwarded-Proto: https` 就自动开」？**我倾向不做**——那要求同时信任转发头，与 P0-1 的谨慎默认冲突，容易做出一个「看起来聪明、实则更脆」的开关。
3. **P0-4 的 `CSRF_SAFE_TYPES` 是否收窄**：我建议保留 `x-www-form-urlencoded` / `multipart`（为将来表单上传留路，且不降低实际安全性）。若你希望「只允许 JSON」更严格，我需要先补全前端所有写请求的 header 断言。

确认后我按 §1 的顺序逐项实现，每完成一项就报告验证结果。

---

## 附：本计划中被我否决的候选改动

诚实记录，避免以后重复讨论：

| 候选 | 为何不做 |
|---|---|
| 把登录锁定从 5 分钟改成 10 分钟（对齐 OPanel） | 行为变更，与本批「只修安全语义」的目标无关；且 5 分钟已足够缓解爆破 |
| 给 `loginFails` 加指数退避 | 同上，属于限流策略设计，应单独评估（已写入路线图 P3） |
| 加 `helmet` / CSP / HSTS | 需引入依赖，违反「不新增依赖」红线；CSP 还会与现有内联样式/脚本冲突，需单独设计 |
| 加 `trust proxy` 的自动探测 | 自动探测 = 猜测部署形态，猜错的后果是安全洞；显式配置更安全 |
| 把 `data/config.json` 里的明文 SSH 密码加密 | 密钥存哪里是根本问题（本地文件加密只是搬运密钥），需要单独的密钥管理设计，进路线图 P3 |
| 本批就加 `/healthz` 与结构化日志 | 属可观测性，不影响安全；进路线图 P2 |
