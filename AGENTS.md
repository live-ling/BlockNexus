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

- **允许加第三方依赖**（旧约束「零依赖」已放宽）。但**部署链路的前提要保住**：SSH 只上传一个文件、
  systemd `ExecStart=/usr/bin/env node {DIR}/agent.js`、面板 `/agent.js` 匿名下载、README 的手动 `curl` 安装。
  因此**加依赖要走「内联进产物」而不是「目标机 npm install」**，详见 `docs/iteration-roadmap.md` §4.3。
- ⚠️ 两处会让「直接 npm i」失败的闸，改依赖前必读：
  1. `agent/build.js` **只改写相对 require**，裸模块名原样透传 → 需扩展打包器才能内联 npm 包；
  2. `agent/test-bundle-fresh.js` 有一条**拒绝非标准库 require** 的断言 → 内联依赖后要改成
     「不允许出现 `node_modules` 路径或未内联的裸模块名」，**不能直接删掉这条防护**。
- **内存占用必须尽量小**（Agent 跑在 MC 服务器上，与游戏争资源）。给按实例/按会话增长的 Map 加上限，
  参照 `loginFails` 那次的「表满淘汰最旧而非拒绝服务」思路。

## 平台适配范围（2026-10-06 确认）

- **主要平台：Ubuntu 系（Linux）** —— Agent 与面板都可能跑在这里。
- **Windows 系**：仅作为**桌面外壳**（WebView2 托盘程序）。
- 适配与测试以这两者为准则；勿为其他平台引入额外复杂度。

## 更名迁移（mcpan → blocknexus）

**兼容期已结束**：已确认**无存量旧 Agent 在生产运行**，因此所有为兼容 MCPan 时代而保留的代码都可清理。

- ✅ **HKDF info 标签已改为 `'blocknexus/*'`**（原先刻意保留 `'mcpan/*'` 作兼容锚点，现已解除）。
  `AGENT_VERSION` 已随之 0.3.5 → 0.3.6（**破坏性协议变更，必须靠版本号驱动远端自动更新**）。
  ⚠ `panel/crypto.js` 与 `agent/src/crypto.js` 的标签必须**逐字一致**，改动后务必递增 `AGENT_VERSION`。
- ⬜ 待清理的遗留兼容代码（均为删除操作，删前建副本）：
  `agent/src/instance/manager.js` 的 `mcpan.json` 改名回退、
  `agent/src/instance/java.js` 的 `/opt/mcpan-java` 旧软链分支、
  `panel/ssh.js` 的 `mcpan-agent` 旧 systemd 服务清理、`README.md` 的「从 MCPan 更名升级」整节。
- 清单与执行注意见 `docs/iteration-roadmap.md` §4.5。

## 发版流程

1. 确认版本号：面板 `package.json` 的 `version`（如 0.3.0）与 Agent `agent/src/config.js` 的 `AGENT_VERSION`（独立版本线，改动 Agent 行为后要递增——面板靠它触发远端自动更新）；`npm run build:agent` 后推送；
2. `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1` → 在 `DE Project\BlockNexus Project` 生成便携版/纯外壳 zip + SHA256；
3. `gh release create vX.Y.Z --target <main最新> BlockNexus-*.zip` + 按惯例格式写说明（见 v0.2.0/v0.3.0 的 Release body）；**推送代码不发版**，用户面板的更新检查只认 GitHub Release 标签。

## 约定

- `.editorconfig` / `.github/workflows/ci.yml` / `data/config.example.json` 是本仓库独有，迁移时保留；
- `/root.txt` 是 build-exe.ps1 写进外壳目录的路径标记，已 gitignore，勿提交；
- README 是面向用户的主文档，新功能要在对应章节补一段并更新「API 一览」。
