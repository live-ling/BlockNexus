# AGENTS.md — BlockNexus 工作区说明（给 AI 助手/新会话的工作记忆）

Minecraft 服务器管理面板：本地 Web 面板（Express + WebView2 外壳）+ SSH 部署到远程 Linux 的 Agent（单文件产物，依赖需内联）。开源仓库即本仓库：github.com/live-ling/BlockNexus。

## 与 mcpan 旧工作区的关系（历史背景）

本目录（Desktop\BlockNexus）现在**既是开发工作区又是发布仓库**：与 GitHub 同源历史，日常改动直接在这里提交并 `git push origin main`（勿 force push）。旧的 `Desktop\mcpan` 个人工作区（独立 git 历史、无 remote）已于 2026-10-06 完成迁移后弃用——运行根（root.txt）、`data/` 运行时数据均已迁到本目录；其历史备份在 `DE Project\BlockNexus Project\mcpan-workspace-history.bundle`（`git clone` 该 bundle 可找回旧提交）。勿从旧仓库向本仓库 force push。

## 构建与测试

```bash
npm run build:web     # 前端到 web/dist（面板托管的就是它）
npm run build:agent   # 重新生成 agent/agent.js（改 agent/src/** 后必须跑，忘跑会被测试拦下）
npm run test:agent    # 全部 Agent 测试（零依赖测试框架，不需要面板与真实服务器）
powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1   # 托盘外壳 exe（会结束运行中的托盘）
```

## Agent 侧约束（2026-10-06 更新）

- **允许加第三方依赖**（旧约束「零依赖」已放宽）。**依赖由打包器内联进产物**，目标机无需 npm。
  - ✅ `agent/build.js` **已支持内联 npm 包**（`resolveNpm`，含 exports 嵌套条件 / 子路径 / scoped 包）。
  - `agent/test-bundle-fresh.js` 的旧「零依赖」断言已改为两条更强的：**依赖必须已内联**、**不允许漏网的裸模块名**。
  - 新增常驻回归测试 `agent/test-npm-inline.js`（13 用例）：真实内联 `node-cron` 并**在没有 node_modules 的目录里运行产物**。
- ⚠️ **打包器不是通用 bundler**，只支持**纯 CJS、纯 JS** 的包。不支持 ESM、原生扩展（`.node`）、
  动态 require（变量拼接路径）、`import.meta`、以及需要非 JS 资源的包。
  **新增依赖前必须先确认能被内联**（跑 `npm run test:agent`）；选库时优先「零传递依赖 + 提供 CJS 构建」。
- **内存占用必须尽量小**：目标 **≤ 80 MB**，大内存服务器（12G+）可放宽到 **120 MB**。
  Agent 跑在 MC 服务器上、与游戏争资源。给按实例/按会话增长的 Map 加上限，
  参照 `loginFails` 那次的「表满淘汰最旧而非拒绝服务」思路；并在 `sys.stats` 里暴露自身 RSS。

### 已选定的依赖：node-cron

2026-10-06 实测对比后选定 **[node-cron](https://github.com/node-cron/node-cron)**（`^4.6.0`）作为 cron 解析/调度库：

| 维度 | node-cron | cron-parser |
|---|---|---|
| 传递依赖 | **0** | **luxon**（时间库） |
| 需内联的运行时体积 | **27 KB**（单文件 `dist/node-cron.cjs`） | 78.5 KB + **luxon 256 KB** ≈ 335 KB |
| 对 80 MB 内存目标的压力 | 小 | 明显更大（luxon 体量大得多） |
| CJS 入口 | `exports['.'].require.default` → `.cjs` | `main: dist/index.js`（CJS） |
| 附加能力 | 自带走秒 cron、`validate`、`schedule`、任务查询 | 侧重「算下次执行时刻」 |

**理由**：cron 解析只是调度的一个环节，node-cron 的 27 KB 零依赖远优于 cron-parser 的「+luxon 256 KB」。
且 node-cron 自带 `validate` 便于在**创建任务时**就拒绝非法表达式（与既有「创建时校验」的做法一致）。

⚠️ 内联它时踩到过一个真实坑：它的 `exports['.'].require` **本身是对象** `{types, default}`，
不是字符串——解析 exports 必须**递归**穿透条件对象。已修并在 `test-npm-inline.js` 里钉住。


## 平台适配范围（2026-10-06 确认）

- **主要平台：Ubuntu 系（Linux）** —— Agent 与面板都可能跑在这里。
- **Windows 系**：仅作为**桌面外壳**（WebView2 托盘程序）。
- 适配与测试以这两者为准则；勿为其他平台引入额外复杂度。

## 更名迁移（mcpan → blocknexus）

**兼容期已结束**：已确认**无存量旧 Agent 在生产运行**，因此所有为兼容 MCPan 时代而保留的代码都可清理。

- ✅ **HKDF info 标签已改为 `'blocknexus/*'`**（原先刻意保留 `'mcpan/*'` 作兼容锚点，现已解除）。
  `AGENT_VERSION` 已随之 0.3.5 → 0.3.6（**破坏性协议变更，必须靠版本号驱动远端自动更新**）。
  ⚠ `panel/crypto.js` 与 `agent/src/crypto.js` 的标签必须**逐字一致**，改动后务必递增 `AGENT_VERSION`。
- ✅ **遗留兼容代码已全部清理**（2026-10-06 完成）：
  `agent/src/instance/manager.js` 的 `mcpan.json` 改名回退、`agent/src/instance/java.js` 的
  `/opt/mcpan-java` 旧软链分支、`panel/ssh.js` 的 `mcpan-agent` 旧 systemd 服务清理、
  `README.md` 的「从 MCPan 更名升级」整节（已改写为「兼容期已结束」）。
- ⚠️ **旧 Agent 无法靠自动更新自救**：握手 proof 在建立连接时校验，旧标签必然失败 →
  连不上 → 永远发不出 `hi`（而自动更新靠 `hi` 触发）。**必须手动重装一次**。README 已写明。
- **协议不匹配的诊断（P0-a）已取消**——用户确认旧命名与旧 Agent 已全面废弃，
  不需要为此新增状态链路。

## 版本与发版策略（2026-10-06 确认）

- 本次迭代目标 **v0.4.0**；大范围修改完成后**一次性**推送并发 v0.4.0。
- **未到 v1.0.0 一概视为开发测试版**——不必为破坏性变更纠结 semver 严格性。
- 面板 `version` 与 Agent `AGENT_VERSION` 仍是两条独立版本线。

## mcpan 处置（2026-10-06 确认）

- **全面废弃**：代码层已清理完毕（见上）。
- **v0.4.0 发布确认通过后再清理**剩余归档物（历史 bundle、旧工作区残留等）。
  在此之前保留，便于必要时回查。


## 发版流程

1. 确认版本号：面板 `package.json` 的 `version`（如 0.3.0）与 Agent `agent/src/config.js` 的 `AGENT_VERSION`（独立版本线，改动 Agent 行为后要递增——面板靠它触发远端自动更新）；`npm run build:agent` 后推送；
2. `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1` → 在 `DE Project\BlockNexus Project` 生成便携版/纯外壳 zip + SHA256；
3. `gh release create vX.Y.Z --target <main最新> BlockNexus-*.zip` + 按惯例格式写说明（见 v0.2.0/v0.3.0 的 Release body）；**推送代码不发版**，用户面板的更新检查只认 GitHub Release 标签。

## 约定

- `.editorconfig` / `.github/workflows/ci.yml` / `data/config.example.json` 是本仓库独有，迁移时保留；
- `/root.txt` 是 build-exe.ps1 写进外壳目录的路径标记，已 gitignore，勿提交；
- README 是面向用户的主文档，新功能要在对应章节补一段并更新「API 一览」。
