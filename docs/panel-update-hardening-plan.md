# 面板更新强化计划（0.7.0 → 1.0.0）

> 状态：**待评审**。本文只写计划，不含代码改动。
> 依据：[面板更新健壮性盘点](./panel-update-robustness.md)（问题编号 P0-x / P1-x / P2-x 均出自该文）。
> 目标版本：**0.7.0 = 更新引擎强化版；1.0.0 = 正式发布版**。
> 约束：外壳（`BlockNexus.exe` + WebView2）**不在本次替换范围**；日常变更集中在 `web/dist`、`agent/agent.js`、`panel/`。
>
> **一页结论**：0.7.0 先修 3 个 P0（bridge 死路、git-clean 自锁、完整包死路）+ 去 API 化发现 + 签名 + 一键 UX；
> 1.0.0 在依赖/外壳冻结的前提下，从 0.6.0 / 0.7.0 直跳。
> 0.6.0 → 0.7.0 仍用旧三步流程（最后一次），0.5.0 及更早只能手动装。
>
> **实施状态（2026-10-26）**：WP-0/1/2/3/5、WP-4 的一键 UX、WP-6 的 systemd 包装脚本、WP-9 的文档已落地；
> `npm run test:agent` 全绿（新增 4 个测试），web 203 例全绿、`tsc`/Vite 构建通过；
> `lockHash`/`shellHash` 仍与 0.6.0 完全一致。**尚未做**：WP-7 的 GitHub Actions（先用本地 runbook）、
> 多跳 `intent.json`/`autoContinue`（bridge 已修好，当前手动点第二次）、full/deps 载荷、HTTP 代理。
> 版本号仍是 0.6.0；发版时按 §7.2 提升到 0.7.0。

---

## 1. 目标与边界

### 1.1 目标（本次必须达成）

1. **设置页一键更新到最新**：不需要填写任何链接/镜像地址；点一次「更新到 vX」→ 下载 → 校验 → 重启 → 自动刷新。
   **0.7.0 起生效**；0.6.0 → 0.7.0 是最后一次使用旧的三步流程（检查 → 立即更新 → 开始更新），但同样不需要输入链接。
2. **正常跨版本**：0.6.0 → 0.7.0 → 1.0.0 都能在面板内完成；数据 schema 从 1 起可连续迁移；桥接路径不再是死按钮。
3. **弱网可用**：发现、下载、校验不再是「必须有一个可达的 GitHub API」；镜像/代理可承载全部资产，且不牺牲完整性。
4. **失败可恢复**：更新器中断、健康检查失败、面板没起来，都有明确的「上次更新未完成」状态与回滚/重试入口。
5. **为 1.0.0 留下可复验的发布契约**：每次发版都能自动断言「旧版本能装新版本」。

### 1.2 非目标（本次明确不做）

- **不替换外壳**（exe/dll/WebView2）。外壳不变 → `shellHash` 不变 → 不触发 `needsFullPackage`。
- **不新增/升级 npm 运行时依赖**（`package-lock.json` 冻结）。这既是「0.6.0 能装 0.7.0」的前提，也让应用包保持 ~5.6 MB。
- **不做完整便携包的应用内替换**（`node_modules/`、`runtime/`、`*.exe`、`*.dll`）。若未来依赖必须变，走 §7.4 的预留方案。
- **不改 Agent 握手/加密协议**。Agent 可以有行为变更，但 1.0.0 之前不允许破坏性协议变更。
- 不做多租户、浏览器 WebSocket 重写等无关事项。

### 1.3 硬约束（不能破的线）

| 约束 | 原因 |
|---|---|
| 0.6.0 的更新器必须能装 0.7.0 | 更新器能力冻结在用户当前版本；这是唯一引导器（盘点 §4 第 3 点） |
| 0.7.0 的载荷路径必须在 0.6.0 的 `WRITE_ALLOW` 内 | 否则旧更新器整包拒绝（`panel/update.js:491-519`） |
| `package-lock.json` 不变 | 变了 → `lockHash` 变 → 0.6.0 要求完整包 → 只能手动 |
| `BlockNexus.exe` 不重打 | 重打 → `shellHash` 变 → 同上 |
| `update.json` + `SHA256SUMS.txt` 必须同时上传 | 0.6.0 只认 GitHub 的校验值 |
| 更新器仍是 detached 独立进程 | 面板必须先退出才能换文件 |

### 1.4 已定决策（按推荐方案）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **先发 0.7.0（更新引擎 v2），再发 1.0.0** | 0.7.0 承载多源/签名/一键 UX/恢复能力；在依赖与外壳冻结的前提下，它更像**验证里程碑**（0.6.0 技术上也能直装 1.0.0）；一旦 1.0.0 需要改依赖/外壳，0.7.0 就是硬前置 |
| D2 | **1.0.0 默认直跳**（`minSourceVersion: "0.6.0"`，无 bridge） | 依赖与外壳冻结，载荷契约不变；bridge 作为未来的安全网保留并修好 |
| D3 | **发现层去 API 化** | 主路径 `releases/latest/download/update.json` + 约定资产 URL；`api.github.com` 只做 changelog 增强 |
| D4 | **多源 + 自动失败切换** | 默认 GitHub；镜像可作为**内置候选**（维护者维护，用户无需输入）或高级自定义源；`settings.update.source` 降级为「高级」 |
| D5 | **Ed25519 签名清单** | `update.json.sig` + `update.json.files`；签名通过则任何源可信；无签名则退回「只信 GitHub」 |
| D6 | **只做 payload 更新** | 本次不碰外壳/依赖；`needsFullPackage` 只作为「解释 + 手动兜底」，不再出现在主流程 |
| D7 | **一键 UX** | 主按钮直接更新；预览信息内联；不可逆才二次确认；bridge 保留「第 1/2 步」 |
| D8 | **Agent 协议冻结** | 0.7.0 / 1.0.0 不改握手；Agent 版本可以递增，但必须向后兼容 0.5.5 |
| D9 | **systemd 协调** | 用启动包装脚本等更新锁（见 §6.6）；不再依赖「更新器抢在 systemd 之前」 |

---

## 2. 版本路线

| 版本 | 定位 | 必须包含 | 能否被上一版装 |
|---|---|---|---|
| **0.6.0**（现状） | 第一个可自更新版本 | 应用包、`update.json`、`SHA256SUMS.txt` | — |
| **0.7.0** | 更新引擎 v2 | 发现/传输/签名/一键 UX/恢复/门禁；依赖与外壳冻结 | 0.6.0 可直接装（payload） |
| **1.0.0** | 正式发布 | 文档、稳定性、完整回归；依赖与外壳冻结 | 0.6.0 / 0.7.0 可直接装（payload） |

补充：

- 0.6.0 之前的版本（0.5.0 及更早）线上没有应用包/元数据，**只能手动装 0.7.0**；0.7.0 发布说明要给便携包镜像链接。
- 如果 1.0.0 最终不得不改依赖或重打外壳：把 1.0.0 的 `minSourceVersion` 提到 `0.7.0`、`bridge: ["0.7.0"]`，
  并先让 0.7.0 具备 §7.4 的依赖通道。**这是备用路线，不是当前计划。**

### 2.1 基线核对（已实测，2026-10-26）

拉取 v0.6.0 的 `update.json` 并与当前工作区对比：

| 项 | v0.6.0 Release | 当前工作区（`computeLocalHashes`） | 结论 |
|---|---|---|---|
| `lockHash` | `ae94d9bd…a89e7` | `ae94d9bd…a89e7` | **一致**（依赖冻结可行） |
| `shellHash` | `53f07ad3…7758c` | `53f07ad3…7758c` | **一致**（外壳未变，0.6.0 用户不会触发完整包） |
| `dataSchema` | `1` | 代码 `CURRENT_SCHEMA = 3` | **0.6.0 的元数据写错了**；新版本必须写 3 |
| `minSourceVersion` | `""` | — | 0.6.0 没声明来源下限；新版本必须显式写 `"0.6.0"` |
| `files` | 无 | — | 0.7.0 起新增 |

这条核对同时说明两件事：

1. **0.6.0 → 0.7.0 的 payload 更新在哈希层面是通的**——只要发布时不改 `package-lock.json`、不重打 exe/dll。
2. `build-release.ps1` 的默认值（`-DataSchema 1`、`-MinSourceVersion ''`）会产出「能装但不迁移/不设下限」的元数据；
   WP-0 的发布门禁必须把这两项拦住（0.6.0 就是现成的反例）。

---

## 3. 架构改动总览

```
                 ┌────────────────────────────────────────────┐
                 │ panel/release.js（新增，纯逻辑）            │
                 │ 源列表 / latest 元数据 URL / 资产 URL 构造  │
                 └───────────────┬────────────────────────────┘
                                 │
   ┌───────────────┐   ┌─────────▼─────────┐   ┌──────────────────┐
   │ GitHub 直连    │   │ 源选择 + 超时/重试 │   │ 自定义镜像（高级）│
   └───────────────┘   └─────────┬─────────┘   └──────────────────┘
                                 │
                 ┌───────────────▼────────────┐
                 │ panel/signature.js（新增）  │
                 │ Ed25519 验签 + files 哈希   │
                 └───────────────┬────────────┘
                                 │
                 ┌───────────────▼────────────┐
                 │ panel/update.js（判定）     │
                 │ 升级计划 / 目标版本 / 迁移  │
                 └───────────────┬────────────┘
                                 │
                 ┌───────────────▼────────────┐
                 │ panel/api.js（编排）        │
                 │ 一键 POST / 预检 / 状态     │
                 └───────────────┬────────────┘
                                 │
                 ┌───────────────▼────────────┐
                 │ scripts/panel-updater.js    │
                 │ pending/heartbeat/健康检查  │
                 └────────────────────────────┘
```

原则不变：**判定在 `panel/update.js`（纯函数、可单测），编排在 `panel/api.js`，执行在独立更新器。**
新增两个纯逻辑模块（`release.js` / `signature.js`），把外部输入与信任判断从 `api.js` 里拆出来。

---

## 4. 工作包

> 每个工作包都能独立提交、独立测试；依赖关系在「前置」列标注。
> 规模：S ≈ 0.5 天，M ≈ 1–2 天，L ≈ 2–3 天。

### WP-0 发布门禁与基线（S，前置：无）

**目标**：把「发版时少传/传错资产」变成机器可拦的错误。

**改动**

- 新增 `scripts/check-release.js`（纯 Node，零依赖）：
  - `package.json.version === update.json.version`
  - `update.json.files` 覆盖 app / portable / shell 三个 zip，且哈希为 64 位小写十六进制
  - `SHA256SUMS.txt` 中三个 zip 的哈希与 `update.json.files` 一致（sums 另含 update.json / .sig，供人工核对）
  - `dataSchema === panel/migrate.js` 的 `CURRENT_SCHEMA`
  - `minSchema <= 迁移链最旧键`（当前 1）
  - `minSourceVersion` 可解析且 `<= version`
  - `bridge` 升序、去重、每项 `> minSourceVersion`
  - `lockHash` / `shellHash` 与目录里的实际文件一致
  - 可选 `--expect-shell-hash <hash>` / `--expect-lock-hash <hash>` / `--require-signature`
- 新增 `scripts/finalize-release.js`（WP-3：files + 签名 + sums）与 `npm run check:release`。
- `scripts/build-release.ps1` 末尾调用 `finalize-release.js`，或在文档里规定「先 build 再 finalize」。

**测试**：对 `scripts/check-release.js` 做 Node 自测（临时目录 + 合成产物，覆盖缺件/错版本/错哈希/坏签名）。

**验收**：用 0.6.0 的真实 `update.json` 当**反例**——门禁必须报出 `dataSchema`（1≠3）、`minSourceVersion` 为空、缺 `files`、缺签名；
用 0.7.0 的产物跑同一套检查必须全绿。故意删掉 `app.zip` 也必须失败。

---

### WP-1 修跨版本死路（M，前置：无）

对应盘点 P0-1 / P0-2 / P0-6 / P1-9。

**改动**

- `panel/update.js`
  - 不改 `planUpgrade` 的入参契约：调用方直接传入**目标版本**的 meta（最新版或桥接版），
    桥接计划就按目标版本的 `minSourceVersion` / `bridge` / `dataSchema` 计算。
  - `needsFullPackage` 增加 `reason`（`lock` / `shell`），便于 UI 解释。
- `panel/api.js`
  - `buildPreflight(req, { target, force })`：`?version=` 真正参与计算；目标版本取 `releases/download/v{target}/update.json`（WP-2）。
  - `POST /panel-update`：`pre = buildPreflight(req, { target: version, force: true })`，校验 `pre.to === version`；
    不再要求「版本必须等于最新」。
  - **把「升级方式」与「升级路径」拆成两个字段**（这是 P0-2 的根因）：
    `plan.mode` 继续表示 `direct | bridge | manual`（给 UI 决定按钮）；
    新增 `pre.applyMode` 表示 `git | payload`（由 `INSTALL.kind` 决定），`runUpdateJob` 只按 `applyMode` 分支。
  - `appAssetAvailable` 参与 `allowed`：payload 模式缺 app zip → `allowed=false` + `update.asset-missing`。
  - 更新前重新探测 git：`applyMode === 'git'` 且 `probeGitClean() === false` → `update.disabled-dirty`。
  - 元数据缺失/非法但能拿到 tag 时：合成安全默认（`breaking=true`、`autoSafe=false`、`metaMissing=true`），
    允许 direct + 人工确认，不再直接 `meta-invalid`。
- `web/src/pages/panel-settings.tsx`：bridge 按钮与 POST 的 `version` 语义对齐（WP-4 会重写，但先修逻辑）。
- 发布纪律：**桥接版本的 `update.json` 必须声明 `minSourceVersion <= 当前本地版本`**，否则「先升到桥接版」这一跳仍会被判 `needs-manual`。

**测试**

- `agent/test-panel-update.js` 增补（纯逻辑）：目标版本的升级计划、bridge 选择、`needsFullPackage.reason`、元数据缺失回退。
- `agent/test-panel-update-target.js`（新增，纯逻辑）：target × localVersion × schema 的矩阵。
- bridge/`POST` 的端到端链路放到 WP-5 的 `test-panel-update-flow.js`（需要起面板）。

**验收**：模拟「0.5.0 → 0.9.0 需要 bridge」时，点「先升级到 0.7.0」能真正受理并下载 0.7.0。

---

### WP-2 发现层与传输层（L，前置：WP-1）

对应盘点 P0-5 / P1-5 / P1-11 / P2-3。

**新增 `panel/release.js`（纯逻辑 + 注入 fetch）**

```js
// 只做字符串/URL/解析，不发请求；请求由调用方注入
REPO = 'live-ling/BlockNexus'
DEFAULT_SOURCES = [{ id: 'github', latestMeta, asset }]   // 镜像由设置/内置候选追加
metaUrl(source, version?)     // version 省略 = latest
assetUrl(source, version, name)
parseMeta(text, { source })   // 复用 panel/update.js 的 parseUpdateMeta
pickSource(sources, prefer)   // 自定义源优先，其余按序
```

**`panel/api.js`**

- `checkLatestRelease(version, { force, source })` 重写：
  1. 依次尝试源：`GET {latestMeta}`（6s 超时、128KB 上限、每源重试 1 次）；
  2. 解析 `update.json`；验签（WP-3）；
  3. `api.github.com/releases/latest` 作为可选增强（4s 超时，只取 changelog / 大小 / releaseUrl），失败不影响；
  4. 缓存 `{ at, data, sourceId }` 10 分钟；错误保留旧缓存并带 `error`。
- `fetchRemoteText` / `downloadFilePanel` 增加 `{ timeout, retries, source }`；zip 下载失败换源重试一次。
- `downloadUrlFor` 改为 `assetUrlFor(source, version, name)`，**元数据、校验文件、zip 全部走同一源**。
- 代理：读取 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`；先做环境变量版（最小实现），系统代理后置。
- 设置：`settings.update.source` 保留为「高级：自定义源」，留空＝自动；前后端协议校验统一（都允许 https，http 仅限 loopback）。

**测试**：`agent/test-panel-release.js`（新增）用假 fetch 覆盖：
- latest 元数据 URL 构造、资产 URL 构造、源顺序、镜像模板、`{name}/{version}` 兼容；
- 主源超时换备源、全部失败、缓存命中/过期、API 增强失败不影响；
- `update.json` 非法/缺字段、版本与 tag 不一致。

**验收**：断网（GitHub 不可达）+ 配置一个本地镜像源，仍能完成「检查 → 下载 → 校验 → 更新」。

---

### WP-3 签名清单与校验链（M，前置：WP-2）

对应盘点 P0-5 / P2-2。

**`update.json` v2（向后兼容，0.6.0 会忽略新字段）**

```json
{
  "schema": 2,
  "version": "1.0.0",
  "severity": "recommended",
  "autoSafe": false,
  "breaking": false,
  "requiresAgentReinstall": false,
  "minSourceVersion": "0.6.0",
  "bridge": [],
  "dataSchema": 3,
  "minSchema": 1,
  "irreversible": false,
  "minNode": 18,
  "lockHash": "…",
  "shellHash": "…",
  "files": {
    "BlockNexus-v1.0.0-app.zip": "…",
    "BlockNexus-v1.0.0-portable.zip": "…",
    "BlockNexus-shell-v1.0.0.zip": "…"
  },
  "summary": "…",
  "notesUrl": "https://github.com/live-ling/BlockNexus/releases/tag/v1.0.0"
}
```

> 为什么用 `files` 而不是 `sumsHash`：`sumsHash` 会与「SHA256SUMS 包含 update.json」形成循环；
> 把**载荷 zip** 的哈希直接放进被签名的 `update.json` 最简单。
> `files` **不包含** `SHA256SUMS.txt` / `update.json` / `.sig`（它们互相引用，放进去就会循环）；
> `SHA256SUMS.txt` 仍然是给 0.6.0 与人工核对的独立文件，覆盖全部资产。

**`update.json.sig`（新增资产）**

```json
{ "schema": 1, "keyId": "bn-1", "sig": "<base64 Ed25519 over update.json bytes>" }
```

**`panel/signature.js`（新增）**

- `PUBLIC_KEYS = { 'bn-1': '<PEM/base64>' }`
- `verifyUpdateMeta(rawText, sigText)` → `{ ok, keyId, reason }`
- 只对**原始字节**验签；JSON 重新序列化会导致验签失败（发布脚本必须按同一份字节写文件）。

**`scripts/finalize-release.js`（新增）**

- 输入：发布目录、私钥（`BLOCKNEXUS_SIGNING_KEY` 环境变量或 `--key` 文件）。
- 步骤：读 `update.json` → 计算 `files`（三个 zip）→ 写回（无 BOM）→ 签名 → 写 `update.json.sig` → 重算 `SHA256SUMS.txt`（含全部资产，含 `.sig`）。
- 私钥绝不进仓库；公钥进 `panel/signature.js`；提供 `--verify` 供 CI/本机复核。

**校验顺序（`panel/api.js`）**

1. 取 `update.json` + `update.json.sig`；
2. 验签通过 → 该源可信；验签失败 → 丢弃该源；无签名 → 只有 GitHub 源可信（旧规则）；
3. 下载 zip；用 `meta.files[name]` 校验（有签名时）；否则用 GitHub 的 `SHA256SUMS.txt`；
4. 任何一步不通过 → 换源；全部失败 → 结构化错误。

**测试**：`agent/test-panel-signature.js`（新增）：
- 正确签名、篡改 `update.json`、篡改 zip、错误 keyId、缺 `.sig`、未知字段、旧格式；
- 镜像提供合法签名 → 接受；镜像提供无签名 → 拒绝（非 GitHub 源）。

**验收**：本地镜像同时提供 `update.json`、`.sig`、zip；篡改任意一个都拒绝；不篡改则完整更新。

---

### WP-4 一键更新 UX（M，前置：WP-1 / WP-2）

对应盘点 P0-1 / P1-10 / P1-11。

**后端 `/version` 的 `recommendation` 增补**

```
target, mode, applyMode, bridgeVersion, migrations, downloadBytes,
needsFullPackage, fullPackageReason, appAssetAvailable,
allowed, reasonKey, reasonText, warnings[],
irreversible, requiresAgentReinstall, agentsToReinstall[],
sourceId, sourceLabel, metaMissing
```

**前端 `VersionCard` 重写更新区**

| 状态 | 主按钮 | 辅助信息 |
|---|---|---|
| 有新版本、可直更 | **更新到 v1.0.0** | `5.6 MB · 2 项数据迁移 · 来自 GitHub` |
| 不可逆 | **确认更新（不可逆）** + 勾选框 | 同上 + 不可逆警告 |
| 需要桥接 | **先升级到 v0.7.0（1/2）** | 「完成后再继续升级到 v1.0.0」 |
| 需要完整包 | **下载完整包**（跟随源） | 解释是依赖还是外壳变了 |
| 不允许 | 无 | `reasonText` |

- 去掉「立即更新 → 预览 → 开始更新」的两次点击：`/version` 已带计划，主按钮直接 POST；
- 「详情」展开时才请求 `/panel-update/preflight`（迁移项、警告、Agent 重装列表）；
- 「更新策略」卡：`auto` 三选一保留；**「下载源」移入「高级」折叠区**，提示「留空自动选择；校验由签名保证」；
- 失败时渲染已本地化的 warnings，不再显示 i18n key；
- bridge：POST 受理后写 `data/update/intent.json`；重启后卡片显示「继续升级（2/2）」；默认手动点一次，自动续跑作为可选项（见 §5.5）。

**i18n**：新增/删改 `panelSettings.update.*` 中文与英文键；`agent/test-error-codes.js` 的成对断言要过。

**测试**：`web` 侧抽一个纯函数 `web/src/lib/update-plan.ts`（决定主按钮/是否禁用/文案 key），配 `vitest`；
UI 用人工清单（见 §9.3）。

**验收**：0.7.0 起，从设置页不输入任何链接、**一次点击**完成到下一版的更新；
0.6.0 → 0.7.0 用旧三步流程可完成（无需输入链接）。

---

### WP-5 更新器 v2 与恢复（L，前置：WP-1）

对应盘点 P1-1 / P1-2 / P1-3 / P1-6 / P1-7 / P2-1 / P2-5。

**面板侧（`panel/api.js`）**

- 交接前写 `data/update/pending.json`：`{ from, to, mode, target, startedAt, pid, sourceId }`；
- `spawnUpdater` 后 2 秒内等 `heartbeat.json` 出现；没有 → 不关机，返回 `update.updater-not-started`；
- 启动对账（`panel/server.js` 或 `api.js` 初始化）：
  - `pending.to === APP_VERSION` → 视为成功（补写 result）；
  - `pending.to !== APP_VERSION` → `updateState.state='failed'` + `pendingUnfinished=true`，UI 给「重试 / 回滚」；
- `/panel-update/status` 增补 `pending`、`updaterAlive`、`chain`、`sourceId`。

**更新器侧（`scripts/panel-updater.js`）**

- 每 5s 写 `data/update/heartbeat.json`（pid + at）；结束时删除；
- 健康检查增强：`/api/version` 版本匹配 + `/api/me` 200 + `GET /` 返回 HTML；
- 磁盘空间：`fs.statfsSync`（Node ≥ 18.15）可用时要求 ≥ 2.5× zip 大小；
- 解压前**列条目**并逐条 `assertSafeArchiveEntry`（Windows 用 `[System.IO.Compression.ZipFile]`，Linux 用 `unzip -Z1` / `bsdtar -tf`），
  校验通过才解压；解压后再按现有白名单复核；
- `--mode git` 分支补齐（WP-1 后可达）：`fetch --tags`、`checkout --force`、按需 `npm ci` + `build:web`；
- 失败原因结构化：`NETWORK | CHECKSUM | EXTRACT | WRITE | HEALTH | MIGRATE`，写进 `last-result.json`。

**测试**：`agent/test-panel-update-flow.js`（新增）
- 临时根 + 假面板端口 + `--launch none` + `BLOCKNEXUS_UPDATE_WAIT_MS=1000`；
- 三条路径：成功替换、写入失败回滚、健康检查失败回滚；
- pending/heartbeat 的写入与清理；
- 恶意 zip 条目（`../`、绝对路径、符号链接）在解压前被拒。

**验收**：中途 `kill` 更新器 → 重启面板能看到「上次更新未完成」，且文件是旧版、可回滚。

---

### WP-6 systemd 协调（S，前置：WP-5，可裁剪）

对应盘点 P0-4。

**方案：启动包装脚本 + 更新锁**（不需要 sudo，不依赖 systemd 私有接口）

- 新增 `scripts/start-panel.sh`：
  - 若 `data/update/in-progress` 存在且 mtime 在 10 分钟内 → 每秒等待，最多 180 秒；
  - 锁过期则忽略；
  - 最后 `exec node panel/server.js "$@"`。
- 面板交接前写锁（与 `pending.json` 同时）；更新器完成/失败后删除锁。
- 更新器检测 `underSystemd()` 时：**不自己拉起面板**，等 systemd 通过包装脚本启动；健康检查照常。
- `docs/deployment.md` 的 unit 改为 `ExecStart=/opt/blocknexus/scripts/start-panel.sh --host 127.0.0.1`；
  保留旧写法并注明「旧写法不支持面板内更新」。

**测试**：Shell 脚本自测（临时目录 + 假锁 + 超时）；Linux 真机一次 systemd 更新。

**验收**：systemd 托管下面板内更新不再出现「等待退出超时」或混合文件树。

> 如果本次不想动部署脚本：保留 `Restart=always`，在文档明确「systemd 托管暂不支持面板内更新」。
> 二选一，默认做包装脚本（代码量很小）。

---

### WP-7 发布流水线与门禁（M，前置：WP-0 / WP-3）

**目标**：把「手动 gh release + 记得传六个文件」变成可复验流程。

> ⚠ **CI 里的外壳二进制**：`BlockNexus.exe` / `*.dll` 是 gitignore 的，干净 checkout 里没有。
> 发布工作流必须先从 **0.6.0 的 `BlockNexus-shell-v0.6.0.zip`** 解压出这五个文件放到仓库根，
> 再跑 `build-release.ps1`；**绝不能跑 `-RebuildExe`**（重新编译会改变 `shellHash`，0.6.0 用户就只能手动装）。
> 这也是「外壳冻结」在流水线上的具体落法。

- 新增 `.github/workflows/release.yml`（`workflow_dispatch`，`runs-on: windows-latest`）：
  1. checkout + Node 20；
  2. 下载并解压 0.6.0 的 shell zip → 仓库根（校验 SHA256）；
  3. `npm ci`、`npm --prefix web ci`、`npm run build:web`、`npm run build:agent`；
  4. `npm run test:agent`（必要时拆出 `test:e2e`）；
  5. `scripts/build-release.ps1`（不带 `-RebuildExe`）；
  6. `node scripts/finalize-release.js`（WP-3：files + 签名 + sums）；
  7. `node scripts/check-release.js --require-signature --expect-lock-hash <0.6.0> --expect-shell-hash <0.6.0>`；
  8. `gh release create` 上传 app / portable / shell / update.json / update.json.sig / SHA256SUMS.txt。
- Secret：`BLOCKNEXUS_SIGNING_KEY`；Environment `release` 需人工批准。
- 如果暂不接 Actions：把 1–7 写成 `scripts/release.ps1`，本地执行同一套检查。
- 1.0.0 若需要换外壳（当前计划不允许）：必须先发一个「带新外壳的完整包」手动升级版本，再恢复应用内更新。

**验收**：`workflow_dispatch` 一次跑完，Release 资产齐套；本地从 0.6.0 便携版用旧流程能装上。

---

### WP-8 Agent 跨版本与协议（S，前置：无）

对应盘点 §4（跨版本）与「改的一般是 agent」。

- **协议冻结**：0.7.0 / 1.0.0 不改 `panel/crypto.js` 与 `agent/src/crypto.js` 的 HKDF 标签、不改握手字段；
- `AGENT_VERSION` 仅在 Agent 行为变更时递增（当前 0.5.5）；
- `hi` 里增加只读字段 `proto: 1`（可选，向后兼容；老面板忽略）；
- 面板侧：`agentsToReinstall` 只列「真的需要人工」的服务器；非 SSH 的 outbound Agent 不能自动更新时，给明确的手动指令；
- 回归矩阵：panel 0.7.0 / 1.0.0 × agent 0.5.5 / 新版本，至少覆盖上线、心跳、实例列表、启停、日志。

**验收**：0.6.0 的 Agent（0.5.5）连 0.7.0 / 1.0.0 面板，功能不退化；不需要重装。

---

### WP-9 文档与工作记忆（S，前置：各 WP 落地后）

- `docs/features.md`：重写「面板版本与自动更新」一节（一键、签名、多源、恢复）。
- `docs/deployment.md`：systemd 包装脚本、镜像/签名、手动兜底、0.5.0 及更早的升级说明。
- `docs/development.md`：新增 `panel/release.js`、`panel/signature.js`、`scripts/finalize-release.js` / `check-release.js`、签名私钥约定。
- `AGENTS.md`：新增硬约束（依赖/外壳冻结、签名、`update.json` 契约、systemd 锁）。
- `README.md`：只在「升级」处补一句「设置页一键更新」。
- `docs/next-optimization.md`：加一条指向本计划。

---

## 5. 接口与数据变更

### 5.1 `update.json` v2

见 WP-3。要点：

- `schema: 2`（老面板不校验 schema，安全）；
- 新增 `files`（资产名 → SHA256）；0.6.0 会忽略；
- 保留 `SHA256SUMS.txt`（0.6.0 的信任锚）；
- `version` 必须等于 tag（`check-release.js` 断言）。

### 5.2 `update.json.sig`

```json
{ "schema": 1, "keyId": "bn-1", "sig": "base64..." }
```

签名对象是 `update.json` 的**原始字节**；发布脚本与面板都不做 JSON 重新序列化。

### 5.3 HTTP API

| 接口 | 变更 |
|---|---|
| `GET /api/version` | `recommendation` 增加 target/mode/applyMode/migrations/downloadBytes/allowed/reasonText/source 等 |
| `GET /api/panel-update/preflight?version=` | `version` 真正参与计算；返回该目标版本的完整计划 |
| `POST /api/panel-update` | `version` 可以是 bridge 目标；后端按该目标重新预检；错误码更精确 |
| `GET /api/panel-update/status` | 增加 `pending`、`updaterAlive`、`chain`、`sourceId` |
| `PUT /api/settings` | `update.source` 语义不变（高级）；新增 `update.autoContinue`（默认 `false`，见 §5.5） |

### 5.4 配置

- `settings.update` 新增字段都是**加法**：`Config.load()` 的 `{...defaults.update, ...raw}` 会补默认值，**不需要 schema 迁移**。
- `data/config.json` 的 `schemaVersion` 保持 3；1.0.0 若新增真正的结构变更再 +1。

### 5.5 `data/update/` 运行时文件

| 文件 | 写入方 | 用途 |
|---|---|---|
| `pending.json` | 面板 | 交接前写；启动对账 |
| `heartbeat.json` | 更新器 | 每 5s；面板判断更新器是否活着 |
| `in-progress` | 面板 | systemd 包装脚本等待的锁（TTL 10 分钟） |
| `intent.json` | 面板 | 多跳目标与当前步（bridge） |
| `last-result.json` | 更新器 | 现有；增加 `reason` 枚举 |
| `update.log` | 更新器 | 现有 |
| `backup/<from>/` | 更新器 | 现有；保留 3 份 |

**多跳策略**：`intent.json` 只在用户明确选择「更新到 vX」且计划是 bridge 时写入；
重启后 UI 显示「继续升级（2/2）」。**默认手动点一次**，`update.autoContinue=true` 时才在启动 20 秒后自动续跑
（有可见倒计时与取消）。这样既保留一键体验，又不在用户不知情时连续重启。

---

## 6. 关键流程

### 6.1 一键更新（direct）

1. 打开设置页 → `GET /version`（10 分钟缓存）→ 卡片显示「更新到 v1.0.0」；
2. 点击 → `POST /panel-update {version, confirm}`；
3. 后端：门禁（暴露/形态/在途/空闲）→ 强制预检（下载 `update.json`、验签、算计划）→ 202；
4. 面板下载 zip（源列表、重试、进度 SSE）→ 用 `meta.files` 校验 → 解压前列条目 → 解压 → 白名单复核；
5. 写 `pending.json` + `in-progress` → 启动更新器 → 2s 内确认 heartbeat → 面板退出；
6. 更新器：等端口/PID → 备份 → 替换 → 拉起（systemd 时等包装脚本）→ 健康检查；
7. 成功：写 `last-result.json`、删 `pending/heartbeat/in-progress`；失败：回滚 + 拉起旧版 + 记录原因；
8. 前端轮询 `/version`，版本达到目标后 `location.reload()`。

### 6.2 预检门禁（顺序不变）

对外免密 → 形态 → 在途 → 参数 → 目标版本新于当前 → 空闲 → 预检（签名/资产/迁移/Node）→ 不可逆确认。
**安全门禁仍然在最前，任何一步不过一个文件都不动。**

### 6.3 跨版本矩阵

| 来源 | 目标 | 路径 |
|---|---|---|
| 0.6.0 | 0.7.0 | direct（payload） |
| 0.6.0 | 1.0.0 | direct（payload；依赖/外壳冻结） |
| 0.7.0 | 1.0.0 | direct（payload） |
| 0.5.0 及更早 | 任意 | 手动便携包（线上无 app/元数据） |
| 未来需要桥接 | 最新 | bridge（WP-1 修好后可用） |

> 注：0.6.0 的前端是旧流程（检查 → 立即更新 → 预览 → 开始更新），无法回改。
> 因此「一键」体验从 0.7.0 起；0.6.0 这一步只保证「不需要输入链接也能升」。

### 6.4 数据迁移

- 迁移链从 schema 1 开始；1.0.0 若加 schema 4，必须补 `3→4` 并保证 `minSchema: 1`；
- 迁移前备份（现有 `migrateConfigBeforeLoad` 已做）；失败拒绝启动；
- 更新器在声明了迁移时额外备份 `data/config.json`；
- 发布门禁断言 `dataSchema === CURRENT_SCHEMA`。

### 6.5 失败与回滚

- 下载/校验/解压失败：面板内失败，不退出，可直接重试；
- 交接后失败：更新器回滚程序 + 声明的数据文件，拉起旧版，写 `last-result.json`；
- 不可逆迁移：拒绝自动回滚（备份保留）；
- 更新器死了：`pending.json` 让新启动的面板报「上次更新未完成」；`in-progress` 锁有 TTL，不会永久卡住。

### 6.6 systemd

见 WP-6。核心是「包装脚本等锁」，而不是「更新器与 systemd 抢时间」。

---

## 7. 为 1.0.0 的发布策略

### 7.1 发布门禁（必须全绿）

- [ ] `package.json.version === update.json.version === tag`
- [ ] 依赖未变：`package-lock.json` 哈希与 0.6.0 相同
- [ ] 外壳未变：`shellHash` 与 0.6.0 相同（不跑 `-RebuildExe`）
- [ ] `dataSchema === CURRENT_SCHEMA`；`minSchema <= 1`
- [ ] `minSourceVersion <= 0.6.0`；`bridge: []`（当前计划）
- [ ] app / portable / shell / `update.json` / `update.json.sig` / `SHA256SUMS.txt` 六件齐全；三个 zip 的哈希与 `files` 一致
- [ ] 签名验证通过（`check-release.js --require-signature`）
- [ ] 0.6.0 便携版 → 旧流程（不输入链接）→ 装上新版
- [ ] 0.7.0 → 1.0.0 点一次 → 装上新版
- [ ] `npm run test:agent`、web 单测/构建、CI 全绿
- [ ] 旧更新器契约测试通过

### 7.2 0.7.0 发布 Runbook

1. 确认 `git diff v0.6.0 -- package-lock.json` 为空；不重打 exe；
2. `package.json` → 0.7.0；如需改 Agent，`AGENT_VERSION` +0.0.1 且协议兼容；
3. `npm ci && npm run build:web && npm run build:agent && npm run test:agent`；
4. `build-release.ps1 -Severity recommended -DataSchema 3 -MinSchema 1 -MinSourceVersion 0.6.0 -Summary "..."`（无 `-AutoSafe`，无 `-RebuildExe`）；
5. `node scripts/finalize-release.js --dir <out> --key data/update-signing-key.b64`（CI 用 `BLOCKNEXUS_SIGNING_KEY`）；
6. `node scripts/check-release.js --dir <out> --require-signature --expect-lock-hash ae94d9bdcaee7422cf053f3b52911e486a0137d0f5a580769b79f9bf011a89e7 --expect-shell-hash 53f07ad3608705b435833b6473432b985aeb8e8aaf29a279846d602d7f97758c`；
7. `gh release create v0.7.0 ...` 上传六个文件；
8. 在**干净的 0.6.0 便携版**上，用 0.6.0 现有流程（检查更新 → 立即更新 → 开始更新）升到 0.7.0，确认不需要输入链接；
   如果用户之前填过自定义下载源，失败时先清空该字段再试。
9. 在 0.7.0 上，用 GitHub 不可达 + 本地镜像的环境再跑一次 0.7.0 → 1.0.0（验签路径）。

### 7.3 1.0.0 发布 Runbook

同 0.7.0，额外：

- `minSourceVersion: "0.6.0"`（若最终改了依赖/外壳，改 `"0.7.0"` + `bridge: ["0.7.0"]`）；
- `severity: recommended`（或按实际安全等级）；`autoSafe: false`；`breaking: false`；`irreversible: false`；
- 更新 README / features / deployment / 发布说明；
- 0.6.0 与 0.7.0 各跑一次真机升级；
- 发布后校验 `releases/latest/download/update.json` 与资产字节一致、签名可验。

### 7.4 依赖变更的预留方案（本次不做）

如果未来某版必须改依赖（`lockHash` 变），而外壳仍不变：

- 增加 `-deps.zip` 资产（只含 `node_modules/`）；
- 更新器增加 `--mode deps`：面板退出 → `node_modules` 目录级原子替换 → 拉起；
- 仍不需要碰外壳；
- 在 0.7.0 之后再实现，不影响 1.0.0。

---

## 8. 测试计划

### 8.1 单元（零依赖，进 `npm run test:agent`）

| 文件 | 覆盖 |
|---|---|
| `agent/test-panel-update.js`（增补） | 目标版本计划、bridge 选择、元数据回退、`needsFullPackage.reason` |
| `agent/test-panel-release.js`（新增） | 源列表、URL 构造、超时/重试、缓存、API 增强失败 |
| `agent/test-panel-signature.js`（新增） | 验签、篡改、keyId、旧格式、镜像信任规则 |
| `agent/test-panel-update-flow.js`（新增） | 更新器成功/回滚/健康检查失败、pending/heartbeat、恶意 zip |
| `agent/test-panel-update-contract.js`（新增） | 0.6.0 版更新器装新载荷（fixture） |
| `scripts/check-release.js` 自测 | 发布门禁 |

### 8.2 集成/端到端

- 本地假发布服务器（Node http）提供 `update.json` / `.sig` / zip / sums；`BLOCKNEXUS_UPDATE_BASE_URL` 仅用于测试；
- 起一个真实面板（临时 `data/`）→ 调 `/version` → `POST /panel-update` → 更新器 `--launch none` → 断言文件替换；
- 签名/镜像/离线三套场景。

### 8.3 人工验收矩阵

| 场景 | 安装形态 | 网络 | 期望 |
|---|---|---|---|
| 0.6.0 → 0.7.0 | Windows 便携版 | GitHub 直连 | 旧流程成功（无需输入链接），页面自动刷新 |
| 0.7.0 → 1.0.0 | Windows 便携版 | GitHub 直连 | 一键成功 |
| 检查更新 | 便携版（0.7.0+） | GitHub 不可达 + 镜像 | 换源成功（验签） |
| 失败回滚 | 便携版 | 注入校验失败 | 面板回到旧版，显示原因 |
| 中断恢复 | 便携版 | 更新器被 kill | 重启后显示「上次未完成」 |
| git-clean | 源码 | GitHub 直连 | 走 git 路径，更新后工作区干净 |
| systemd | Linux | GitHub 直连 | 不出现混合树/超时 |
| Agent 兼容 | 便携版 + 0.5.5 Agent | — | 上线、实例操作正常 |

### 8.4 发布前必须跑的

```bash
npm run test:agent
npm --prefix web test
npm --prefix web run build
node agent/build.js --check
node scripts/check-release.js --dir <release> --require-signature
```

---

## 9. 排期

| 阶段 | 内容 | 工期 |
|---|---|---|
| 第 1 周 | WP-0 门禁、WP-1 死路修复、WP-2 发现/传输 + 单测 | 4–5 天 |
| 第 2 周 | WP-3 签名、WP-4 一键 UX、WP-5 更新器 v2 + 测试 | 5–6 天 |
| 第 3 周 | 0.7.0 发布（WP-6 systemd、WP-7 流水线、WP-9 文档）+ 真机回归 | 3–4 天 |
| 第 4 周 | 1.0.0 稳定化、全矩阵验收、发布 | 2–3 天 |

可裁剪项：WP-6（systemd，改为文档声明）、WP-7 的 Actions（改为本地脚本）、WP-2 的 Range 断点。
若 0.7.0 只打算支持 GitHub 直连，可把 WP-3（签名）推迟到 1.0.0——代价是镜像/弱网支持一起推迟，且「不输入链接」只在 GitHub 可达时成立。

**首批提交顺序（建议，先红后绿）**

1. `agent/test-panel-update-target.js` + `panel/update.js` 的目标版本计划（WP-1）；
2. `agent/test-panel-release.js` + `panel/release.js`（WP-2）；
3. `buildPreflight` / `POST` 的 target 与 `applyMode`，配 `test-panel-update-flow.js` 的 API 用例（WP-1/WP-5）；
4. `panel/signature.js` + `finalize-release.js` + `check-release.js`（WP-3/WP-0）；
5. `VersionCard` 一键 UX（WP-4）；
6. 更新器 pending/heartbeat/健康检查（WP-5）；
7. 发布前才做 systemd/流水线/文档（WP-6/7/9）。

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 0.7.0 自己装不上（依赖/外壳变了） | 0.6.0 用户只能手动 | 发布门禁断言 lockHash/shellHash；不跑 `-RebuildExe` |
| CI 干净 checkout 没有 exe/dll（gitignore） | 重编外壳 → `shellHash` 变 → 只能手动 | 从 0.6.0 的 shell zip 取二进制；`--expect-shell-hash` 断言 |
| 签名私钥丢失/泄露 | 无法发版或镜像可投毒 | 离线备份 + CI Secret + keyId 轮换预案 |
| 镜像提供旧签名（重放） | 降级/重复提示 | `isNewer` 已拦降级；manifest 带 `version`；拒绝非新版本 |
| 0.6.0 用户网络打不开 GitHub | 首次升级只能手动 | 0.7.0 发布说明给便携包镜像；手动安装后即可一键 |
| systemd 包装脚本改动部署 | 老用户 unit 失效 | 兼容旧 `ExecStart`；文档给两种写法 |
| 测试只覆盖纯函数 | 更新器/链路回归 | WP-5 的 flow 测试 + 契约测试 + 人工矩阵 |
| 范围膨胀到完整包/代理 | 延期 | 明确非目标；依赖通道、系统代理后置 |
| `update.json` CDN 缓存 | 新版本检查延迟 | `latest/download` 重定向到新资产；缓存 10 分钟；`?refresh=1` |

---

## 11. 验收标准（DoD）

- [ ] 从 **0.6.0 便携版**：用现有三步流程（不输入链接）升到 0.7.0；
- [ ] 从 **0.7.0**：设置页**一次点击**升到 1.0.0，页面自动刷新；
- [ ] 从 **0.7.0**：GitHub 不可达 + 配置镜像时，检查/下载/验签全部可用；
- [ ] 篡改 `update.json` / zip / `.sig` 任意一个：拒绝更新，文案可读；
- [ ] 更新器被 kill：重启后显示「上次更新未完成」，可回滚；
- [ ] systemd 托管：不出现超时/混合树（或文档明确不支持）；
- [ ] git-clean：走 git 路径，更新后工作区干净，第二次更新仍可用；
- [ ] Agent 0.5.5 与 0.7.0 / 1.0.0 面板完全兼容；
- [ ] 依赖与外壳未变（lockHash/shellHash 与 0.6.0 相同）；
- [ ] `npm run test:agent`、web 单测、CI 全绿；
- [ ] 文档（features/deployment/development/AGENTS）同步。

---

## 12. 待确认（默认值已给，未回复即按默认执行）

1. **0.7.0 的发布时间**：默认本次强化完成后立即发，作为 1.0.0 的前置。
2. **签名私钥保管**：默认 GitHub Actions Secret + 离线备份；如果你希望完全离线签名，发布流程改成「本地签名后上传」。
3. **systemd**：默认做包装脚本；如果不想动部署，改为文档声明「systemd 暂不支持面板内更新」。
4. **多跳是否自动续跑**：默认 `autoContinue=false`（每次手动点一下）；打开后启动 20 秒自动续跑。
5. **是否托管官方镜像**：默认只内置 GitHub；如果目标用户主要在国内，建议后续用现有 VPS 做 `releases` 反向代理，
   并把它加进 `panel/release.js` 的内置候选源（用户无感、无需输入）。代码已支持，只是运维工作。

---

## 附录：文件改动清单（预估）

**新增**

- `panel/release.js`、`panel/signature.js`
- `scripts/finalize-release.js`、`scripts/check-release.js`、`scripts/start-panel.sh`
- `agent/test-panel-release.js`、`agent/test-panel-signature.js`、`agent/test-panel-update-flow.js`、`agent/test-panel-update-target.js`、`agent/test-panel-update-contract.js`
- `.github/workflows/release.yml`（可选）

**修改**

- `panel/api.js`、`panel/update.js`、`panel/server.js`、`panel/config.js`（默认值）
- `scripts/panel-updater.js`、`scripts/build-release.ps1`（末尾调用 finalize）
- `web/src/pages/panel-settings.tsx`、`web/src/lib/api.ts`、`web/src/lib/lang/zh.ts`、`web/src/lib/lang/en.ts`、`web/src/lib/update-plan.ts`（新增）
- `package.json`（scripts）、`docs/features.md`、`docs/deployment.md`、`docs/development.md`、`AGENTS.md`、`README.md`

**不动**

- `scripts/tray/**`、`BlockNexus.exe` / dll、`package-lock.json`、`panel/crypto.js`、`agent/src/crypto.js`
