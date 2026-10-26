# 面板更新：健壮性盘点与「一键升到最新」探索

> 目的：为 **v1.0.0** 铺垫。范围＝面板自更新全链路（发现 → 预检 → 下载 → 校验 → 换包 → 重启 → 回滚）＋跨版本策略。
> 本文是**探索结论**，不包含代码改动。结论基于当前 `main`（0.6.0）与 GitHub 上已发布的 Release 实测。
>
> **2026-10-26 决策**：按本文路线 B 执行——先发 0.7.0（更新引擎 v2），再发 1.0.0；
> 外壳与 npm 依赖冻结，1.0.0 默认从 0.6.0 直跳（bridge 仅作未来安全网）。
> 具体工作包、接口与发布门禁见 **[panel-update-hardening-plan.md](./panel-update-hardening-plan.md)**。

---

## 0. 结论先行

1. 现在的自更新是「**条件满足时能用**」，不是「点了就能升」：
   只在 0.6.0+、GitHub 可达、依赖与外壳未变、且不是 systemd 自动重启托管时才能成功；
   git 形态**第一次更新成功后就会把自己变成 git-dirty，从此永久禁用更新**。
2. 「还要输入链接」不是 UI 偷懒，而是**发现层与信任层都绑死在 GitHub**：
   `settings.update.source` 只改写 zip 的下载地址，`update.json` 与 `SHA256SUMS.txt` 仍然只能从 GitHub 取。
   所以镜像救不了「检查更新」这一步——用户填了链接也常常点不动。
3. 「跨版本」目前有三处硬断点：**bridge 按钮必然失败**、**依赖/外壳一变就只能手动装**、
   **0.6.0 之前的 Release 根本没有应用包与元数据**。
4. 要做到「点击即更新到最新 + 正常跨版本」，必须把 **发现 / 传输 / 信任 / 应用 / 跨版本** 五层拆开。
   其中「完整包应用」与「镜像可承载元数据」必须在 **1.0.0 之前**发一版（0.7.0），
   否则 1.0.0 对 0.6.0 用户只能手动安装——原因见 §4 的「更新器能力被冻结」。

---

## 1. 现状链路：一次更新到底发生了什么

| # | 步骤 | 实现位置 | 关键约束 |
|---|---|---|---|
| 1 | 启动时探测安装形态 | `panel/server.js:125` → `panel/update.js:150` | `portable` / `dir` / `git-clean` 可更新；`git-dirty` / `unknown` 禁用 |
| 2 | 检查最新 Release | `panel/api.js:84`（`/releases/latest`） | 只认 `api.github.com`；缓存 10 分钟；同时取 `update.json` |
| 3 | 预检（升级计划） | `panel/api.js:1184` → `panel/update.js:300` | `minSourceVersion` / `minSchema` / `bridge` / Node 版本 / 完整包判定 |
| 4 | 用户点「立即更新」→ 取预检 → 点「开始更新」 | `web/src/pages/panel-settings.tsx:465`、`:483` | 两次点击；`confirm === version` 防旧页面误触发 |
| 5 | 下载应用包 | `panel/api.js:1399` → `:2832` | 单次请求、600s 超时、无重试/无断点 |
| 6 | 校验 | `panel/api.js:1409` | 只认 GitHub 资产的 `SHA256SUMS.txt`，拿不到就拒绝 |
| 7 | 解压 + 路径白名单校验 | `panel/api.js:1421`、`:1287` | 解压后才校验；`panel/update.js:479` 的安全函数**未接线** |
| 8 | 交接更新器（面板退出） | `panel/api.js:1357` | detached 子进程；`state=restarting`；600ms 后停机 |
| 9 | 等面板退出 | `scripts/panel-updater.js:215` | 端口无响应 **且** 旧 PID 已消失；60s 超时即放弃 |
| 10 | 备份 → 替换 → 拉起 → 健康检查 | `scripts/panel-updater.js:380` | 失败回滚程序 + 声明的数据文件；`data/update/` 留日志与结果 |
| 11 | 前端等新版回来 | `web/src/App.tsx:150` | 每 2s 轮询 `/version`，最多 3 分钟 |

**形态与路径的现状**：`planUpgrade()` 只返回 `direct` / `bridge` / `manual`（`panel/update.js:292-294`），
而 `runUpdateJob()` 判断的是 `pre.mode === 'git'`（`panel/api.js:1374`）——这个分支永远不会命中（见 §3-P0-2）。
也就是说 **git-clean 安装实际走的是「下载应用包覆盖文件」**，而不是 `git fetch + checkout`。

---

## 2. 实测事实：GitHub 上的 Release 资产

用 GitHub API 读取 `live-ling/BlockNexus` 的 Release 列表（2026-10-26）：

| 版本 | portable | shell | app | update.json | SHA256SUMS |
|---|---|---|---|---|---|
| v0.6.0 | ✅ | ✅ | ✅ 5.6 MB | ✅ 467 B | ✅ |
| v0.5.0 | ✅ | ✅ | ❌ | ❌ | ❌ |
| v0.4.0 | ✅ | ✅ | ❌ | ❌ | ❌ |
| v0.3.0 及更早 | ✅ | ✅ | ❌ | ❌ | ❌ |

直接后果：

- **0.5.0 及更早的用户永远无法应用内更新**——不是代码不允许，而是线上根本没有应用包、元数据和校验文件；
  再叠加 0.6.0 发布说明里写的「从 0.5.0 升上来仍按老办法」，这条路径是设计内的手动路径。
- 0.6.0 是第一个「可作为更新来源」的版本，因此 **0.6.0 的更新器就是 1.0.0 唯一能依赖的引导器**（见 §4）。
- v0.5.0 的 `minSourceVersion` 之类的声明无从谈起：它连 `update.json` 都没有。

> 说明（2026-10-26 补测）：v0.6.0 的 `update.json` 实际值为
> `schema: 1`、`dataSchema: 1`、`minSchema: 1`、`minSourceVersion: ""`、`bridge: []`、`minNode: 18`、
> `lockHash: ae94d9bd…a89e7`、`shellHash: 53f07ad3…7758c`；当前工作区算出的两个哈希与它**完全一致**，
> 说明 0.6.0 的外壳与依赖至今未动（0.7.0 的 payload 路径可行）。
> 同时它暴露一个元数据缺陷：代码的 `CURRENT_SCHEMA` 是 3，而 Release 声明 `dataSchema: 1`；
> `minSourceVersion` 也是空串。发布门禁必须拦住这两项（见计划 §2.1 / WP-0）。

---

## 3. 发现的问题

### P0 — 会让「点击更新」直接失败

#### P0-1 `bridge` 按钮必然失败（跨版本路径是死代码）

前端在 `mode === 'bridge'` 时把中间版本作为目标提交：

```ts
// web/src/pages/panel-settings.tsx:796-804
<Button ... onClick={() => void startUpdate(preflight, preflight.bridgeVersion)}>
```

`startUpdate()` 会 POST `version = bridgeVersion`（`panel-settings.tsx:483`），但后端：

```js
// panel/api.js:1184  buildPreflight(req, force) 没有 target 参数
const to = meta.version || rel.latest || '';        // 永远是"最新版"
// panel/api.js:1490
if (!pre.to || pre.to !== version) return fail(res, 'update.no-release');
```

`preflight` 的 `?version=` 只在响应里回显（`panel/api.js:1465`），**从不参与计算**。
因此只要存在桥接版本，`pre.to`（最新）≠ `version`（桥接）→ 必然失败；
而且返回的是 `update.no-release`（HTTP 502，文案是「读取 Release 信息失败（网络或 GitHub 限流）」，
见 `panel/error-codes.js:595`），**把「目标版本对不上」误报成网络问题**，用户只会反复重试。
**结论：声明了 `bridge` 的 Release，用户点「先升级到 vX」一定失败。**

#### P0-2 git-clean 更新一次后变 git-dirty，后续永久禁用

- `buildPreflight()` 的 `mode` 取自 `plan.mode`（`panel/api.js:1225`），只可能是 `direct/bridge/manual`；
- `runUpdateJob()` 却用 `if (pre.mode === 'git')` 判断是否走 git 路径（`panel/api.js:1374`）→ 永不命中；
- 于是 git-clean 安装走 **payload 覆盖**，把工作区里的受版本控制文件改掉；
- 下次启动 `probeInstallKind()` 里 `git status --porcelain` 非空 → `git-dirty`（`panel/update.js:132-144`、`:87-98`）
  → 更新按钮消失，且**无法从界面恢复**（只能手动 `git checkout`）。

这是「第一次能升、第二次不能升」的直接原因，对 0.6.0 → 0.7.0 → 1.0.0 这种连续升级是致命的。

#### P0-3 `needsFullPackage` 是手动死路，而 1.0.0 几乎必然触发

`needsFullPackage()` 在 `lockHash`（package-lock.json 变了）或 `shellHash`（exe/dll 变了）不一致时返回 true
（`panel/update.js:370-376`），预检随即把 `allowed` 置 false 并只给一个「下载完整包」外链
（`panel/api.js:1210-1211`、`web/src/pages/panel-settings.tsx:751-767`）。

现实约束：

- 任何一次 `npm install`（新增/升级依赖、甚至只是重算 lock）都会改变 `lockHash`；
- 任何一次重打 `BlockNexus.exe`（图标、托盘逻辑、签名）都会改变 `shellHash`；
- 而 1.0.0 大概率两者都会动。

**结论：1.0.0 很可能对 0.6.0 用户变成「请下载完整包手动装」。** 这不是 bug，是当前设计刻意的边界——
但这正是「一键更新到最新」在正式版面前最大的缺口。

#### P0-4 systemd `Restart=always` 与「等面板退出」竞态

`docs/deployment.md:68` 的官方 unit 是 `Restart=always; RestartSec=3`。
更新器要求「端口无响应 **且** 旧 PID 已消失」才动手（`scripts/panel-updater.js:215-224`）。
问题在于**没有任何一方在更新期间阻止 systemd 拉起面板**：

- 面板 `server.close()` 后端口先关、进程 300ms 后才退（`panel/server.js:132-137`），
  更新器每 500ms 轮询，通常会在这个「端口已关、进程已退」的窗口里判定「可以动手」；
- 约 3 秒后 systemd 用**当前磁盘上的文件**启动面板——此时更新器可能**正在替换文件**
  （payload 文件少，通常能抢完；full 模式的 `node_modules` 几乎必然还没换完）；
- 结果可能是：新面板读到「新 server.js + 旧 api.js」的混合树、启动失败、systemd 再拉一次；
  或者更新器的健康检查被 systemd 拉起的面板满足/破坏，行为依时序而变；
- 若更新器恰好错过窗口（机器很慢、轮询被拖长），就等满 60 秒 → 「等待面板退出超时（未做任何改动）」。

`underSystemd()` 只用于**换完之后**的拉起（`scripts/panel-updater.js:346-348`），**没有用于协调停机**。
**这是静态分析结论，需要在真机 systemd 环境复现确认；但无论复现结果如何，「更新期间不阻止服务管理器重启」都是需要解决的设计缺口。**

#### P0-5 元数据与校验值只认 GitHub，「下载源」救不了

- 检查更新：`api.github.com/repos/.../releases/latest`（`panel/api.js:71`）；
- `update.json`：GitHub Release 资产（`panel/api.js:108-117`）；
- `SHA256SUMS.txt`：GitHub Release 资产（`panel/api.js:1411`，注释明确「镜像不在信任链上」）。

`downloadUrlFor()` 只改写 **zip 下载地址**（`panel/api.js:1169-1181`）。
所以在 GitHub API 不可达/限流的网络里：

- 用户填了镜像 → 仍然「检查更新失败」，表格里连版本号都拿不到；
- 即便拿到版本，`update.json` 取不到 → `meta.version = ''` → `planUpgrade` 判 `update.meta-invalid`
  → **直接不允许更新**（`panel/update.js:316-319`）；
- 就算元数据侥幸拿到，校验值还得回 GitHub。

**这就是「必须输入链接、填了也不一定有用」的根因。**

#### P0-6 Release 缺件时预检仍放行

`buildPreflight()` 只把 `appAssetAvailable` 当展示字段（`panel/api.js:1229`），
`allowed` 的计算里没有它（`:1201`）。当某个 Release **传了 `update.json`、却忘了 app zip** 时：

- 预检显示「允许更新」；
- 用户点「开始更新」→ `runUpdateJob` 在 `update.asset-missing` 处失败（`panel/api.js:1391-1392`）。

这类缺件不是假想：v0.5.0 就只传了 portable（虽然它早于应用内更新功能，但说明「发布时少传资产」真实会发生）；
发布脚本本身也不校验资产齐套（`scripts/build-release.ps1` 允许 `-SkipApp`，且不会因跳过而拒绝生成 `update.json`）。

### P1 — 可靠性 / 可恢复性

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1-1 | 更新器无监管、无「待完成」标记 | `panel/api.js:1357`、`scripts/panel-updater.js` 无 heartbeat | 更新器崩溃/被杀 → 面板停在关闭状态，没有任何一方负责拉起 |
| P1-2 | `spawnUpdater` 不确认子进程真的起来了 | `panel/api.js:1345-1355` | `scripts/` 被删、权限异常时面板仍会退出，等于自杀 |
| P1-3 | 更新状态只存内存 | `panel/api.js:1097-1110` | 进程重启即丢；`lastResult` 与 `state` 两套真相 |
| P1-4 | 失败退避不持久化 | `panel/api.js:1112-1113` | 每次重启清零，自动更新可能在坏版本上每天循环 |
| P1-5 | 下载无重试/无断点/无多源 | `panel/api.js:2832-2862` | 国内网络 5.6 MB 尚可，42 MB 完整包在 600s 内失败概率高 |
| P1-6 | 健康检查只查 `/api/version` | `scripts/panel-updater.js:350-365` | 能返回版本号但配置加载失败/静态资源缺失的面板会被判定「健康」 |
| P1-7 | 无磁盘空间检查、解压无体积上限 | 全链路 | 小 VPS 上解压失败或写满磁盘 |
| P1-8 | `idleForUpdate()` 依赖内存里的 `taskLogs` | `panel/api.js:1154-1158`、`:321-351` | 某条任务路径没写 `done` → 更新永久「面板正忙」，重启才恢复 |
| P1-9 | `INSTALL` 只在启动时算一次 | `panel/server.js:125` | 运行期工作区变脏/变干净都不会重新判定；git 模式若生效，`checkout --force` 会覆盖用户改动 |
| P1-10 | 更新失败面板直接渲染 i18n key | `panel/api.js:1398`、`panel-settings.tsx:669-673` | 用户看到 `update.warn-breaking` 这种字符串 |
| P1-11 | 下载源协议校验前后端不一致 | UI 允许 `http(s)`（`panel-settings.tsx:957`），后端只收 `https`（`panel/api.js:1730`） | 填 http 镜像 → 保存时报错，提示语与规则对不上 |
| P1-12 | `fullPackageUrl` 不跟随下载源 | `panel/api.js:1228` | 需要手动装的人仍然只能点 GitHub 直链 |

### P2 — 安全 / 信任

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| P2-1 | 归档路径校验函数没接线 | `panel/update.js:479` 定义、`:574` 导出；`panel/api.js:1287` 的 `extractArchive` 没用它 | 现有 `unzip`/`bsdtar`/`Expand-Archive` 是否拦 `..` 取决于平台实现，**需实测**；这是纵深防御缺口，不是已证实漏洞 |
| P2-2 | 镜像不在信任链上 | `panel/api.js:1408` 注释 | 镜像只能加速「已哈希的 zip」，不能承载元数据；要真正多源，必须有可离线验证的签名 |
| P2-3 | 不支持 HTTP(S)_PROXY / 系统代理 | 全仓库无 `ProxyAgent`/`HTTP_PROXY` 处理 | 企业代理、系统级 VPN 环境下检查与下载都失败，且错误只显示「网络错误」 |
| P2-4 | GitHub API 响应无大小上限 | `panel/api.js:96` 的 `r.json()` | 与元数据的小文本上限（`MAX_REMOTE_BODY`）不一致；风险低，但属于同类问题 |
| P2-5 | 解压后不校验总大小 | `panel/api.js:1421-1435` | 压缩炸弹只受 200 MB zip 限制，解压后可远大于此 |

---

## 4. 根因：三个耦合 + 一个「能力被冻结」

1. **发现、传输、信任三者耦合在 GitHub 上。**
   只要 `api.github.com` 或 `objects.githubusercontent.com` 不可达，更新就整体不可用；`source` 只解开了传输的一角。

2. **「元数据」同时承担「策略」。**
   `update.json` 缺失/字段非法不是「按保守默认继续」，而是直接 `meta-invalid` 拒绝（`panel/update.js:316`）。
   于是发布方漏传一个文件，用户的「一键更新」就退化成手动——0.5.0 已经发生过一次。

3. **更新器是一次性程序，能力被冻结在用户当前版本里。**
   面板用它**自己那份** `scripts/panel-updater.js` 去装新版本，装完才换成新的。
   所以：

   > **1.0.0 能被装上的前提，是 0.6.0 的更新器已经具备装 1.0.0 的能力。**

   0.6.0 的更新器只认 payload（不认完整包）、只认 GitHub 校验、白名单里没有 `node_modules/`、`runtime/`、`*.exe`、`*.dll`
   （`panel/update.js:491-519`）。这些能力**无法通过 1.0.0 自己补上**。

4. **跨版本靠「发布方声明」而不是「可验证的契约」。**
   `minSourceVersion` / `bridge` 写错、`dataSchema` 忘改、`irreversible` 误标，都没有发布期校验；
   而桥接路径本身还是坏的（P0-1）。

---

## 5. 目标设计：把五层拆开

### 5.1 发现层：约定优先，API 只做增强

**目标**：不依赖 `api.github.com` 也能知道「最新版是多少、有哪些资产」。

- 用 `https://github.com/live-ling/BlockNexus/releases/latest/download/update.json` 拿元数据：
  这是 GitHub 的固定重定向端点，**不计 API 速率限制**，镜像也容易代理。
- 版本号直接取 `update.json.version`；资产 URL 按命名约定构造：
  `.../releases/download/v{version}/{ASSET.app|portable|sums}`（`panel/update.js:23-29` 已有命名函数）。
- `releases/latest` API 降级为**可选增强**：只为拿 `changelog`、资产大小与 `releaseUrl`，失败不影响更新。
- 发布期保证 `update.json.version === tag`（见 §6.2）。
- 拿不到 `update.json` 时不再直接拒绝：用 tag（若能拿到）合成 **安全默认**（`breaking=true`、需人工确认、只允许 direct），
  让「元数据缺失」变成「更谨慎地可更新」，而不是「不能更新」。

### 5.2 传输层：源列表 + 自动切换

- 源模型从「一个前缀」升级为两个模板：

  ```js
  { id: 'github',
    latestMeta: 'https://github.com/{repo}/releases/latest/download/update.json',
    asset: 'https://github.com/{repo}/releases/download/v{version}/{name}' }
  { id: 'mirror-a',
    latestMeta: 'https://mirror-a/{repo}/releases/latest/download/update.json',
    asset: 'https://mirror-a/{repo}/releases/download/v{version}/{name}' }
  ```

- 元数据 6s 超时、每个源最多一次重试、成功即记住（仅内存，避免把死源钉死）；
- zip 下载按源重试一次，支持 `Range` 断点（GitHub CDN 支持）；
- `settings.update.source` 从「必填输入框」降级为「高级：自定义源」，留空＝自动。
  既有的 `{name}` / `{version}` 模板继续兼容。
- 代理：读取 `HTTP(S)_PROXY` / `NO_PROXY`，或复用系统代理（Windows 可从注册表读，Linux 读环境变量）。
  没有代理时给明确错误（而不是「网络错误」）。

### 5.3 信任层：签名清单（让镜像成为一等公民）

现状「镜像不在信任链上」导致镜像只能加速、不能救急。要真正做到「不用输链接也能在任何网络下更新」，需要：

- 发布时用 **Ed25519** 私钥对 `update.json` 的**原始字节**签名，产出 `update.json.sig`；
- `update.json` 增加 `files`（资产名 → SHA256），把 zip 的哈希链直接放进被签名的清单
  （不采用「`sumsHash` 签 SHA256SUMS」：SHA256SUMS 里包含 update.json，会形成循环）；
- 面板内置公钥（常量，随版本发布）；验签通过 → **任何源**都可接受；验签失败/无签名 → 回到「只信 GitHub」的旧规则；
- 私钥离线保管（或 GitHub Actions Secret），公钥进代码；Node 自带 `crypto` 的 Ed25519，无需新依赖。

这样才可能把「下载源」从用户视野里彻底拿掉。

### 5.4 应用层：payload 与 full 两种载荷

| 模式 | 载荷 | 适用 | 现状 |
|---|---|---|---|
| payload | `-app.zip`（5.6 MB） | 依赖与外壳都没变 | ✅ 已有 |
| full | `-portable.zip`（42 MB） | 依赖/外壳变了 | ❌ 只给外链 |

full 模式的难点不在下载，而在**替换时机**：

- Windows 外壳（`BlockNexus.exe`）持有 WebView2 的 dll，面板退出后外壳仍在运行（`scripts/tray/BlockNexusTray.cs`）；
- 因此 full 必须两段式：先用 **`BlockNexus.exe --exit-tray`** 收掉外壳（它只退出窗口与托盘，面板/Agent 继续运行，
  正好适合「面板已经退出」的更新时机；不要用 `--stop`，那会把本机 Agent 一起杀掉）→ 目录级原子替换
  （`node_modules`、`runtime`、`*.exe`、`*.dll`：旧目录改名 → 新目录改名 → 删除旧目录）→ 重新拉起外壳；
- Linux 只需替换 `node_modules`（runtime 用系统 Node），风险小得多。

**另一条更省事的路**：v1.0.0 **冻结依赖与外壳**，把 full 模式推迟到 1.1。
见 §6.1 的路线 A。

### 5.5 跨版本层：direct 优先，bridge 能用，多跳可续

- `buildPreflight(req, { target })` 接受目标版本：`?version=` 真正参与计算（取该版本 Release 的 `update.json`）；
- `POST /panel-update` 用**该目标版本**的计划校验，而不是要求 `pre.to === 最新`；
- 多跳用持久化 intent 驱动：

  ```json
  // data/update/intent.json
  { "target": "1.0.0", "chain": ["0.7.0", "1.0.0"], "step": 0, "startedAt": 0 }
  ```

  重启后 `/panel-update/status` 回报剩余跳数；UI 显示「继续升级到 v1.0.0」，用户点一次即可续跑；
- 发布契约测试：用**上一个版本**的 `panel/update.js` + `panel-updater.js` 去装一个合成的「新版本」载荷，
  断言通过。这是保证「0.6.0 能装 1.0.0」的唯一可自动化手段。

### 5.6 恢复与可观测

- **pending 标记**：交接更新器前写 `data/update/pending.json`；启动时若 `pending.to !== 当前版本` → 明确报「上次更新未完成」并给回滚/重试入口；
- **heartbeat**：更新器每 5s 写时间戳，面板据此显示「更新器已停止」；
- **健康检查增强**：`/api/version` 版本匹配 ＋ `/api/me` 可读 ＋ `web/dist/index.html` 可访问 ＋ 配置加载成功；
- **结构化失败原因**：区分「网络 / 校验 / 权限 / 磁盘 / 迁移 / 健康检查」，而不是一句 `error.message`；
- 失败面板把警告渲染成文案，不再显示 i18n key。

---

## 6. 为 v1.0.0 的发布策略（本文最重要的部分）

### 6.1 三条路线

**路线 A：1.0.0 冻结依赖与外壳（最快）**

- 不新增/升级 npm 依赖（`lockHash` 不变）；
- 不重打 `BlockNexus.exe`（`shellHash` 不变）——发布时别带 `-RebuildExe`；
- app zip 的路径集合不超出 0.6.0 的白名单（别新增顶级目录）。

满足这三条，0.6.0 用户点一次就能升到 1.0.0，**不需要先发 0.7.0**。
代价：1.0.0 不能顺手升级依赖/外壳。

**路线 B：先发 0.7.0（更新器 v2），再发 1.0.0（推荐）**

- 0.7.0 带上：多源发现、签名（可选）、full 模式、pending/heartbeat、bridge 修复；
- 0.7.0 自身必须能被 0.6.0 装上（所以 0.7.0 也不能改依赖/外壳，或改得很小并在 0.6.0 白名单内）；
- 1.0.0 的 `update.json` 设 `minSourceVersion: "0.7.0"`，`bridge: ["0.7.0"]`；
- 0.6.0 用户会看到「先升级到 0.7.0」，点一次到 0.7.0，再点一次到 1.0.0（或由 intent 自动续跑）。

**路线 C：混合**——0.7.0 只做「能装 full + 多源」，1.0.0 若冻结依赖/外壳则仍是一步到位。

### 6.2 v1.0.0 发布门禁（建议做成脚本/CI 断言）

| 检查 | 失败后果 |
|---|---|
| `tag_name === update.json.version` | 资产名对不上 → `asset-missing` |
| 四个资产齐全：`app.zip`、`portable.zip`、`update.json`、`SHA256SUMS.txt` | 预检放行但执行失败（P0-6） |
| `update.json.dataSchema === panel/migrate.js 的 CURRENT_SCHEMA` | 迁移不被执行，数据停在旧结构 |
| `minSchema` ≤ 迁移链能覆盖的最旧 schema（当前是 1） | 老用户被误判「无法迁移」，只能手动 |
| `minSourceVersion` ≤ 实际支持的最老来源版本 | 老用户被告知只能手动 |
| `lockHash` / `shellHash` 与发布脚本算法一致 | 退化成「需要完整便携包」 |
| `irreversible` 仅在真的不可逆时置真 | 用户失去回滚能力 |
| `autoSafe` 保守（默认 false） | 未经确认的自动升级 |
| 发布说明里写清手动路径 | 老版本用户卡住 |

### 6.3 明确不应发布的组合

- tag 与 `version` 不一致；
- 只传 portable、不传 app zip / update.json / SHA256SUMS（0.5.0 的教训）；
- 改了依赖却仍宣称 `minSourceVersion: "0.6.0"`；
- 声明了 `bridge` 但当前代码的桥接路径是坏的（P0-1），等于给用户一个死按钮。

---

## 7. 建议的实施顺序与验收

> 原则：先修「点了必失败」，再做「一键体验」，最后动信任模型。每一步都能独立发版。

**阶段 0：修 P0 断点（1–2 天，不改信任模型）**

- [ ] `buildPreflight` 支持 target；`POST` 用目标版本校验（修 P0-1）
- [ ] git-clean 真正走 git 路径：`buildPreflight` 按 `INSTALL.kind` 决定 `mode`（而不是只看 `plan.mode`），
      让 `runUpdateJob` 的 `--mode git` 分支可达；这条修好后，git 用户升级后仍是干净工作区（修 P0-2）
- [ ] `appAssetAvailable` 参与 `allowed`（修 P0-6）
- [ ] 元数据缺失时用 tag 合成安全默认，不再 `meta-invalid`（修 P0-5 的一半）
- [ ] 更新前重新探测 git 状态（修 P1-9）
- 验收：`0.6.0 → 0.7.0` 在便携版与 git-clean 上各跑一次；第二次更新仍可用。

**阶段 1：一键体验（2–3 天）**

- [ ] 发现层改用 `releases/latest/download/update.json` + 约定 URL（P0-5）
- [ ] 源列表 + 超时/重试/记忆；`source` 降级为高级项（§5.2）
- [ ] 预检合并进 `/version` 的 recommendation，版本卡只留一个「更新到 vX」按钮
- [ ] 失败面板渲染文案；前后端协议校验统一
- 验收：断网/代理/镜像三种网络下，按钮的行为与错误文案都正确。

**阶段 2：信任与完整包（3–5 天，视路线）**

- [ ] Ed25519 签名清单 + `sumsHash`；无签名回退旧规则
- [ ] full 模式（若走路线 B）
- [ ] 归档条目安全校验接线（P2-1）
- 验收：镜像篡改任意资产 → 拒绝；签名缺失 → 仅 GitHub 源可用。

**阶段 3：发布流水线与回归（2–3 天）**

- [ ] GitHub Actions 发布：校验 tag/资产/字段，生成并上传四个资产 + 签名
- [ ] 更新器 e2e（临时根目录 + `--launch none`）
- [ ] 旧更新器装新载荷的契约测试
- 验收：`git push --tags` 后无需手工补传；契约测试在 CI 里跑。

---

## 8. 测试现状与缺口

**已有**：`agent/test-panel-update.js`（97 例）覆盖版本比较、安装形态、元数据清洗、升级计划、自动策略、回滚决策、
归档路径校验、写入白名单、shellHash 公式、git 远端白名单。质量很高，但它只测**纯函数**。

**缺口**（对应上面的问题）：

- 没有测 `buildPreflight` / `POST /panel-update` 的 target 与 bridge 流程 → P0-1 漏网；
- 没有测 `pre.mode` 与 `install.kind` 的联动 → P0-2 漏网；
- 没有测「release 缺 app zip」「缺 update.json」的预检结果 → P0-5/6 漏网；
- 没有测 `panel-updater.js`（它自己留了 `BLOCKNEXUS_UPDATE_WAIT_MS`/`HEALTH_MS` 环境变量用于演练，
  但没有任何测试使用）；
- `assertSafeArchiveEntry` 有测试、没接线 → 测试给了虚假的安全感。

**建议新增**：

1. `agent/test-panel-update-flow.js`：临时根 + 假面板端口 + `--launch none`，跑 payload 替换/回滚/健康检查失败三条路径；
2. `agent/test-panel-update-target.js`：bridge/直跳/目标版本不一致；
3. `agent/test-panel-update-contract.js`：从 git tag 取上一版 `panel/update.js`，喂合成载荷；
4. 发布脚本的字段一致性断言（可在 CI 里用 node 读 `scripts/update.template.json` 与 `panel/migrate.js`）。

---

## 9. 决策结果（2026-10-26）

| 问题 | 决定 |
|---|---|
| 1.0.0 是否改依赖/重打外壳 | **否**。依赖与外壳冻结；1.0.0 默认从 0.6.0 直跳，`bridge` 只作未来安全网 |
| 是否接受签名清单 | **是**。Ed25519 + `update.json.sig` + `files`；无签名回退「只信 GitHub」 |
| systemd 是否一等公民 | **是**。用启动包装脚本等更新锁，不依赖「更新器抢在 systemd 之前」 |
| 「输入链接」指什么 | 两者都覆盖：下载源降级为「高级」，完整包外链跟随源；主流程不需要任何输入 |

实施顺序、工作包与发布门禁见 **[panel-update-hardening-plan.md](./panel-update-hardening-plan.md)**。

---

## 附录 A：代码位置索引

- 判定：`panel/update.js`（`planUpgrade:300`、`needsFullPackage:370`、`WRITE_ALLOW:491`、`shouldAutoApply:443`、`assertSafeArchiveEntry:479`）
- 编排：`panel/api.js`（`checkLatestRelease:84`、`buildPreflight:1184`、`runUpdateJob:1367`、`POST /panel-update:1472`、`autoUpdateTick:1561`）
- 执行：`scripts/panel-updater.js`（`waitPanelExit:215`、`applyGit:254`、`main:380`）
- 启动：`panel/server.js`（`migrateConfigBeforeLoad:73`、`probeInstallKind:125`、`shutdown:132`）
- 前端：`web/src/pages/panel-settings.tsx`（`openPreflight:465`、`startUpdate:483`、bridge 按钮 `:796`、下载源 `:988`）
- 发布：`scripts/build-release.ps1`（`shellHash:82`、资产 `:244`、`update.json:375`）
- 部署：`docs/deployment.md:56-85`（systemd unit）

## 附录 B：本次探索的方法与未验证项

**方法**：通读更新链路源码与测试；读取 GitHub Release 列表核对资产；对照部署文档的 systemd 配置。

**未验证（需要真机/真实发布验证）**：

- systemd `Restart=always` 下的竞态（P0-4）——静态分析，未复现；
- Windows 外壳持有 dll 时的 full 模式替换细节——需要实机；
- 各平台解压器对 `..` 条目的处理（P2-1）——需要构造恶意 zip 实测；
- v0.6.0 `update.json` 的具体字段值——本次环境无法读取 release-assets 域名。

**本次没有改动任何代码、配置或发布产物。**
