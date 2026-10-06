# AGENTS.md — BlockNexus 工作区说明（给 AI 助手/新会话的工作记忆）

Minecraft 服务器管理面板：本地 Web 面板（Express + WebView2 外壳）+ SSH 部署到远程 Linux 的 Agent（零依赖单文件）。开源仓库即本仓库：github.com/live-ling/BlockNexus。

## 双工作区（重要）

- **本目录（Desktop\BlockNexus）= 发布仓库**：与 GitHub 同源历史，从这里提交并 `git push origin main`（勿 force push）；
- `Desktop\mcpan` = 个人工作区：**独立 git 历史、无 remote**，日常迭代在这里。发布 = 把 mcpan 内容迁移过来（`git -C ..\mcpan archive <commit> | tar -x -C .`）+ 手工合 README（两边 README 真分叉，本仓库版是基底）→ 功能级提交 → 推送。两仓库无共同祖先，切勿互相强推。

## 构建与测试

```bash
npm run build:web     # 前端到 web/dist（面板托管的就是它）
npm run build:agent   # 重新生成 agent/agent.js（改 agent/src/** 后必须跑，忘跑会被测试拦下）
npm run test:agent    # 全部 Agent 测试（零依赖，不需要面板与真实服务器）
powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1   # 托盘外壳 exe（会结束运行中的托盘）
```

## 发版流程

1. 确认版本号：面板 `package.json` 的 `version`（如 0.3.0）与 Agent `agent/src/config.js` 的 `AGENT_VERSION`（独立版本线，改动 Agent 行为后要递增——面板靠它触发远端自动更新）；`npm run build:agent` 后推送；
2. `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1` → 在 `DE Project\BlockNexus Project` 生成便携版/纯外壳 zip + SHA256；
3. `gh release create vX.Y.Z --target <main最新> BlockNexus-*.zip` + 按惯例格式写说明（见 v0.2.0/v0.3.0 的 Release body）；**推送代码不发版**，用户面板的更新检查只认 GitHub Release 标签。

## 约定

- `.editorconfig` / `.github/workflows/ci.yml` / `data/config.example.json` 是本仓库独有，迁移时保留；
- `/root.txt` 是 build-exe.ps1 写进外壳目录的路径标记，已 gitignore，勿提交；
- README 是面向用户的主文档，新功能要在对应章节补一段并更新「API 一览」。
