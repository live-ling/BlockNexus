# 前端重构交接说明（2026-10-21 · v2）

> **用途**：给接手的模型/新会话。读完本文即可开工，不需要翻聊天记录。
> 配套：`docs/frontend-redesign-design.md`（设计基线与逐页清单）、`docs/frontend-redesign-audit.md`（盘点）、
> `docs/instance-page-refactor.md`（实例页 P0–P4 方案）。

## 0. 当前在做什么

BlockNexus 面板前端在分支 `refactor/frontend-redesign` 上重构。当前处于**原型设计阶段**：
`web/src/prototype/` 里有一套 `/proto` 六屏原型（真实 shadcn 组件 + mock 数据、不接任何接口），
用来确认组件、排版、布局与样式；**真实页面 `web/src/pages/*` 这一轮一行没改**。

用户对原型的评价：列表页、设置页方向认可；**实例详情页「还是难看」**，希望重做视觉。
下一轮的首要目标是给出一版更耐看、更像桌面应用的详情页，而不是继续堆功能。

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 分支 | `refactor/frontend-redesign`（HEAD `c489be1`） |
| 基线 main | `5b3dd11`（未合并本分支） |
| 面板 / Agent 版本 | 0.6.0 / 0.5.4 |
| 工作区 | 仅 3 个用户未跟踪文件：`docs/shenji/`、`docs/正式版发布建议.md`、`merge18n.cjs`（**绝对不要提交**） |
| 原型文案 | `proto.*` 共 217 键，`zh.ts` / `en.ts` 一一对应 |

### 本分支提交时间线（都在原型与文档里，没动真实页面）

| 提交 | 内容 |
|---|---|
| `e25a0b1` | 设计基线首稿（页面清单 / 功能分区 / 尺寸令牌） |
| `1670f31` | `/proto` 六屏原型 + 外壳 |
| `3b6d5ef` | 二次修订：底部悬浮导航、行高 36、收窄横向控件、去掉「危险」页 |
| `aa3051d` | 三次：页头去状态、列表改纯卡片、筛选进右侧抽屉、设置页目录式 |
| `e7fe475` | 四次：修设置页滚动、去分区线、服务器卡加 Java、筛选按钮贴边悬停 |
| `0737f59` | 修 `<main>` 高度链（滚不动/目录点不动的根因） |
| `712ab4d` | 设置页撤销/保存移到页头右上 |
| `ed217f6` | 服务器卡资源改垂直排列、面板设置补回用户名 |
| `5683a1a` | 补确认密码与最短长度提示；服务器卡去状态点、Agent 徽章移右上 |
| `dd91dc0` / `b4fae58` / `ecd6b55` / `0554f49` | 服务器图标占位；实例卡图标与状态徽章的位置调整 |
| `3bd78a4` | 实例卡补「最近备份」 |
| `29905a2` | 实例工作台 P0：Tab 7→5、指标条 5→4、概览三段、主操作随状态、去右栏 |
| `c489be1` | 实例工作台 P1：实例切换下拉、控制面板基础页分三节 |

## 2. 已确认的设计决策（改之前先问用户，别再翻案）

| 项 | 结论 |
|---|---|
| 导航 | **底部居中悬浮导航**（复用现有 `ExpandableActionBar`），不做左侧栏 |
| 页头 | 只放标题/副标题/页面操作，**不显示** SSE、在线数、安装进度、版本更新 |
| 窗口基准 | **1000×720**（外壳最小 960×640；窄了做减法，不压窄列） |
| 密度 | 正文 13px、列表行 36、工具栏 44、Tab 40、卡片 padding 14 / gap 12 |
| 列表页 | **只要卡片**（表格/列表视图已删），卡片内不画分割线 |
| 筛选 | **贴边隐藏**（右边缘只露 7px，hover 滑出），点开 320px 抽屉；默认不占宽度 |
| 设置页 | 左目录（sticky，锚点 + 滚动高亮）+ 右侧一次性列出全部设置项；分区不画线不套卡片；**撤销/保存在页头右上** |
| 删除 | **没有「危险」页**；删除放在对象自己的页面里（实例→控制面板「基础」底部；服务器→设置页最后一节） |
| 实例工作台 | 5 个 Tab（概览/玩家/文件/配置/维护）；指标 4 项；概览三段（状态摘要 / 最近事件 / 快捷操作+MOTD）；主操作随状态翻转；无右栏玩家；标题旁实例切换下拉 |
| 控制面板 | `min(1160px,94vw) × min(760px,86vh)`；左导航 180；基础页分三节（基础字段 / 配置入口 / 维护） |

## 3. 原型结构（`web/src/prototype/`）

| 文件 | 行数 | 作用 |
|---|---|---|
| `index.tsx` | 37 | 入口；`?screen=` 深链与切屏回写地址 |
| `shell.tsx` | 164 | 悬浮导航、PageHeader、PROTO 切换器 |
| `proto-ui.tsx` | 259 | 原语：Panel / KV / Field / FormGrid / SearchInput / Select / Segmented / EmptyState |
| `filter-drawer.tsx` | 48 | 贴边竖标签 + 320px 抽屉 |
| `settings-layout.tsx` | 63 | 设置页：整页一个滚动容器、目录 sticky、分区无线 |
| `mock.ts` | 237 | 4 台服务器、7 个实例、玩家、事件、日志、备份 |
| `screens/instances.tsx` | 262 | 实例卡片网格 |
| `screens/servers.tsx` | 195 | 服务器卡片网格 |
| `screens/instance.tsx` | **876** | 实例工作台（5 Tab + Dock + 控制面板） |
| `screens/server-settings.tsx` | 149 | 服务器设置 |
| `screens/panel-settings.tsx` | 273 | 面板设置 |
| `screens/login.tsx` | 44 | 登录 |
| `prototype.test.tsx` | 62 | 静态渲染冒烟（含「缺键会显示 proto.xxx」守卫） |

打开方式：面板起来后访问 `http://127.0.0.1:<端口>/proto`；`?screen=instances|servers|server-settings|instance|panel-settings|login` 可直达。

## 4. 用户对详情页的反馈与可选方向（当前核心问题）

原话：**「详情页前端还是难看」**。已经试过但没解决：三栏改 Tab 工作台、去掉右栏、指标条瘦身、
状态摘要、终端 Dock 全宽、控制面板放大。

下一模型可先做的诊断（用浏览器的视觉判断，别只读代码）：

1. **层次平**：Tab 条、指标条、概览面板用同一套 1px 边框 + 12/13px 字号，页面没有主次与节奏；
2. **像后台表格**：概览仍是「一行摘要 + 两块面板」，缺少一眼可读的图形（状态带、趋势、迷你图、进度环）；
3. **图标与色彩弱**：只有 lucide 小图标，没有实例/服务器头像或色彩标识；状态色几乎被 muted 吃掉；
4. **顶部拥挤**：标题 + 切换箭头 + 状态徽章 + 4 个按钮挤一行；
5. **卡片/面板同权**：概览面板与列表卡片视觉重量一样，没有 hero 区。

可尝试的方向（供参考，不强制）：实例头部做一条带状态色的横带（左色条或渐变），名字与地址作为 hero；
指标用大数字 + 趋势/迷你条；概览第一屏 O(状态) → O(异常) → O(事件)；字号阶拉开（11/13/15/20/24）；
只让状态使用状态色。**先给方案或静态稿，让用户点头，再动代码**（用户明确要求这样协作）。

## 5. 硬约束

- **不换 UI 框架**：继续 shadcn/Radix + Tailwind v4；不加新依赖（`motion`、`lucide-react` 已在）。
- **不一次性重写**：每阶段独立提交、可回滚；旧页面保留到 parity 通过。
- **i18n**：新增文案必须同时改 `web/src/lib/lang/zh.ts` 与 `en.ts`，占位符一致，en 不出现中文；
  当前 `proto.*` 217 键。删键也要两边一起删（`en satisfies Record<TranslationKey,string>` 会拦住）。
- **不提交** `data/`、`docs/shenji/`、`docs/正式版发布建议.md`、`merge18n.cjs`。
- **真实页面未动**：`web/src/pages/*` 仍是旧实现；原型与真实页面并行存在，落地时再逐页替换。
- 提交信息用中文、说明「为什么」。

## 6. 验证方式

```powershell
npm --prefix web run build     # tsc -b + vite build（类型检查含在内）
npm --prefix web run lint      # oxlint，期望 0 error（约 75 条既有 warning）
npm --prefix web test          # vitest，当前 193 passed
```

布局回归不要只看代码（本轮踩过坑）：起静态服务 + 无头 Edge，用 CDP 量尺寸。

```js
// 思路：serve web/dist（SPA 回退 index.html）→ msedge --headless=new --no-sandbox
// --remote-debugging-port=9222 --user-data-dir=<temp> → 用 Node 的全局 WebSocket 连 CDP，
// Runtime.evaluate 读 clientHeight/scrollHeight/scrollTop，或 Input.dispatchMouseEvent 模拟悬停/点击。
```

实测过的结论（可直接复用）：设置页滚动容器 `clientH 414 / scrollH 1017 / maxScroll 603`；
实例切换下拉点 `skyblock` 后头部变「skyblock 已停止」、指标变 `0/10`、`2.0/4G`、地址 `:25566`。

## 7. 已知的坑（都是本轮踩过的）

1. **`<main>` 必须 `min-h-0 overflow-hidden`**：column flex 子项的自动最小高度会取内容高度，
   否则子页面 `overflow-auto` 拿不到约束（`scrollHeight === clientHeight`），滚动与锚点跳转全失效。
2. **PowerShell 5.1 默认按 ANSI 读写**：不要用 `Get-Content`/`Set-Content` 改源码（中文会变成乱码且不可逆），
   改文件用编辑工具（UTF-8）；写脚本也避免把中文塞进命令行。
3. **Radix DropdownMenu 的 Trigger 监听 `pointerdown`**，不是 `click`；CDP 里要派发 PointerEvent。
4. 全局隐藏了滚动条（`html { scrollbar-width: none }`），肉眼判断「能不能滚」不可靠，量 `scrollTop`。
5. 原型冒烟测试用 `renderToStaticMarkup`（项目测试环境是 node、无 jsdom）；
   缺 i18n 键时页面会原样显示 `proto.xxx`，测试会顺带拦住。

## 8. 建议的下一步顺序

1. **（用户最在意）实例详情页视觉重做**：先出 1–2 版静态方案（截图或 `/proto` 变体）→ 用户点头 → 再改代码；
2. **F1 原语抽取**：把 `proto-ui.tsx` 里认可的部分抽到 `components/`（DialogShell 六档、PageHeader、
   SettingsLayout、ListToolbar、DataTable、StatusBar 等），并拿「备份/自动重启/属性」三个弹层试点；
3. **F2 列表页接真实数据**：实例总览与服务器列表仍是卡片 + 客户端筛选，接 `GET /servers`、
   `GET /servers/:id/instances`；后端分页/查询参数不在本轮；
4. **实例页落地**：按 `docs/instance-page-refactor.md` 的 P0–P4 拆组件，先做 P0 测试基建与日志单一数据源；
5. P2 的失败原因、近 24h 峰值需要后端字段，先出原型、后接。

## 9. 关键文件

- 设计基线：`docs/frontend-redesign-design.md`
- 总盘点：`docs/frontend-redesign-audit.md`
- 实例页方案：`docs/instance-page-refactor.md`
- 原型入口：`web/src/prototype/index.tsx`
- 最需要改的文件：`web/src/prototype/screens/instance.tsx`（876 行）
- 文案：`web/src/lib/lang/zh.ts`、`web/src/lib/lang/en.ts`（搜索 `proto.`）

## 10. 落地进度（2026-10-21 · F1 + F2 部分完成）

原型视觉已经开始落到真实页面，**每页独立提交、可单独回滚**：

| 提交 | 内容 |
|---|---|
| `0370ffe` | 抽出公共原语 + 实例总览/服务器列表改卡片与右侧筛选抽屉 |
| `a6e8fb1` | 实例详情：44px 头部（呼吸灯/切换实例/更多）、3 张驾驶舱指标卡、下划线页签、灰底白卡 |
| `f35e8c5` | 服务器详情/服务器设置/面板设置统一 PageHeader + PageBody + 卡片头部 |
| `f604d53` | 原型第六版（亮色极简控制台）本身 |

新增的共用层（**后续页面一律从这里取，不要再抄原型**）：

| 文件 | 内容 |
|---|---|
| `web/src/components/layout/tokens.ts` | SURFACE / HAIRLINE / LABEL / MUTED / TITLE / INPUT_CLASS / BTN_PRIMARY |
| `web/src/components/layout/primitives.tsx` | Dot / Pill / Bar / usageTone / Surface / KV / Field / FormGrid / SearchInput / Select / Segmented / EmptyState / SectionHeading / FilterField / FilterChoices |
| `web/src/components/layout/page-header.tsx` | PageHeader（标题/副标题/返回/操作）+ PageBody（灰底滚动容器，pb-24 给悬浮导航让位） |
| `web/src/components/layout/filter-drawer.tsx` | 右侧贴边竖标签 + 320px 抽屉 |
| `web/src/components/layout/status.tsx` | InstanceStatusPill / AgentStatusPill（静态 18px 胶囊，替代动效徽章） |
| `web/src/components/layout/instance-card.tsx` | 实例卡片（总览与服务器详情共用，actions/extra 两个插槽） |
| `web/src/components/layout/settings-layout.tsx` | 设置页骨架：sticky 左目录 + 单滚动容器 + 分区（`heading:false` 用于「一张卡即一分区」） |

仍然待办：

1. ~~设置页「左目录 + 右侧全量分区」结构~~ **已完成**（`components/layout/settings-layout.tsx`）：
   面板设置按「访问 / 网络 / 通知 / AI / 版本与更新 / 外观 / 关于」分区，
   服务器设置按「连接信息 / Agent / Java / 系统信息 / 删除服务器」分区；
   卡片内部的保存逻辑没动，仍是每卡各存各的（统一成页头一个保存按钮是下一步的事）。
2. **登录页只做了轻调**（标题 15px、输入 36px、卡片 20rem），背景图与毛玻璃保留。
3. `about.tsx` 已跟随（PageHeader + 灰底白卡），只是信息展示，没有交互改动。
4. ~~原型里的 5 Tab 未落地~~ **已完成**：详情页现在是「驾驶舱 + 概览 / 玩家 / 文件 / 配置 / 维护 + 底部终端」，
   左栏与右栏取消。AI / Spark / 地图 / 聊天的归属（已定，别再挪）：

   | 原视图 | 现在的位置 | 理由 |
   |---|---|---|
   | 地图 | 概览底部，点快捷操作「地图」就地展开（`mapOpen`） | 世界地图是「眼前这个实例长什么样」，属于状态展示 |
   | 聊天记录 | 玩家页右侧（左玩家列表、右 `ChatLogPanel`） | 聊天是玩家活动，和名单天然一组 |
   | AI 日志分析 | 维护页「诊断」区（`diag='ai'`） | 读日志找问题，属于排障工具 |
   | Spark 性能 | 维护页「诊断」区（`diag='spark'`，装了 spark 才出现） | 同上，TPS/CPU 剖析 |

   文件页内联文件管理器（`FileManagerView`，对话框与页签共用）；配置页是「配置设置 / 插件配置 /
   Mod 管理 / 编辑」四张入口卡；维护页是「自动化（自动重启 + 定时备份）/ 备份（内联 `BackupPanel`）/ 诊断」。
5. 旧徽章（`components/status-badge.tsx` 的 AnimatedBadge）与 `components/settings-card.tsx`
   仍在用，等所有页面迁移完再统一删除。

⚠ 本机沙箱里 `vite build` / `vitest` 会因 `spawn EPERM` 失败，需要放宽权限跑；
只跑 `npx tsc -b` 与 `oxlint` 不受影响。

