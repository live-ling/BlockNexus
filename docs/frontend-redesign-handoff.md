# 前端重构交接说明（2026-10-21）

> 用途：当前会话上下文将满，本文作为**新会话的起点**。读完本文 + 引用的两份文档，即可继续，不需要翻聊天记录。

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 当前分支 | `refactor/frontend-redesign`（已推送，跟踪 origin） |
| 分支最新提交 | `45baeea docs: 前端重构总盘点` |
| 基线 main | `5b3dd11 docs: 实例页功能盘点与重构方案`（已推送） |
| 工作区 | 干净；仅有用户未跟踪文件 `docs/shenji/`、`docs/正式版发布建议.md`、`merge18n.cjs`（**不要提交**） |
| 面板/Agent 版本 | 面板 0.6.0；`AGENT_VERSION` 0.5.4 |

**本分支相对 main 只多了两份文档**，没有改代码：

- `docs/instance-page-refactor.md`（main 上已有，实例页逐项方案）
- `docs/frontend-redesign-audit.md`（本分支新增，前端总盘点）

## 2. 已经做完的（main 上，已合并）

实例页最近一轮渐进改造（`a92f481`→`e0e915e`）：

- 中区默认「概览」页签（最近事件/快捷操作/命令输入）；
- 左栏去重（删「更多管理」「危险操作」重复卡）、frp 并进概览行；
- 指标 5→3、连接地址独立成条；
- 终端降级为底部 dock（收起/半屏/全屏/错误自动展开/`Ctrl+\``/拖拽调高并记忆）；
- 实例控制面板模态（基础/网络/玩家/自动化/备份/危险，含内存/备注/域名/frp 端口内联）；
- 停止时收起右侧玩家栏。

## 3. 还没做的（本次要接手的）

用户反馈的两个直接问题，方案已定、**代码未改**：

1. **控制面板偏小**：当前 `max-w-[860px] min-h-[360px]`；应放大到 `min(1160px,94vw)` × `min(760px,86vh)`，左导航加宽、内容区独立滚动。
2. **终端不顺手**：dock 目前在**中栏内部**（宽度被左右栏挤掉）、默认收起；应移到**整页底部全宽**，整行可点击展开，收起态保留一行命令输入。

全局重构（F1–F6）尚未开始，详见 `docs/frontend-redesign-audit.md`：

- F1 设计原语（DialogShell 4 档尺寸 / PageHeader / SettingsSection / ListToolbar / EmptyState / Skeleton）+ 3 个弹层试点；
- F2 列表页统一（实例/服务器卡片、搜索/筛选/排序/批量）；
- F3 服务器设置 Tab 化；
- F4 面板设置 Tab 化；
- F5 实例页（按 `instance-page-refactor.md` 的 P0–P4，含上面两个问题）；
- F6 清理死 i18n / 重复弹层 / 路由级 lazy / 页面测试。

## 4. 盘点要点（详见审计文档）

- 页面：8 个路由；`instance-detail` 1899 行、`panel-settings` 1671+648、`server-settings` 1212；
- 弹层：22 个，7 种宽度写法、4 种高度写法；
- 重复：SettingsCard 两套、建实例两处、SSH 编辑两处、配置编辑器三套、危险确认 5 套、卡片三处；
- 缺失：全局搜索/命令面板、列表搜索筛选分页批量、ErrorBoundary/骨架屏、路由级分割（首包 1.47MB）、页面级测试、类型契约；后端缺审计/会话、指标历史、Webhook、任务中心、批量与查询参数、SSE 事件 ID。

## 5. 工作约束（必须遵守）

- **不一次性重写**：按 F1–F6 小步提交，每阶段独立可回滚；旧页面保留到 parity 通过。
- **不换 UI 框架**：继续 shadcn/Radix + Tailwind，不重做视觉语言。
- **i18n**：新增文案必须同时改 `web/src/lib/lang/zh.ts` 与 `en.ts`，占位符一致，en 不出现中文。
- **构建/测试**：`npm run build:web`、`npm --prefix web run lint`、`npm --prefix web test`；改 Agent 才需要 `npm run build:agent` + 递增 `AGENT_VERSION`（本次不涉及）。
- **不提交** `data/`、`docs/shenji/`、`docs/正式版发布建议.md`、`merge18n.cjs`。
- 提交信息用中文、说明「为什么」；每个阶段结束跑一遍构建与测试。

## 6. 新会话第一步（建议顺序）

1. `git status` / `git branch --show-current`，确认在 `refactor/frontend-redesign`；
2. 读 `AGENTS.md`、`docs/frontend-redesign-audit.md`、`docs/instance-page-refactor.md`；
3. 做 **F1**：先建 `web/src/components/dialog-shell.tsx` 等原语，选「备份 / 自动重启 / 属性」三个弹层试点；
4. 再回头做两个止痛项（面板放大、dock 全宽），或按 F2 继续列表页；
5. 每完成一项：build + lint + test，提交并推送分支。

## 7. 验收基线

- 单页 ≤ 600 行（实例/设置 ≤ 400）；弹层只用 DialogShell 4 档；列表有搜索/筛选；初始包目标 < 900KB；5 个主路由有页面 smoke 测试。
