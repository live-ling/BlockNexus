# 实例详情页：功能盘点与重构方案（2026-10-21）

> 背景：实例页经过多轮增量修改（概览页签、底部终端、控制面板、内联编辑），功能已够用，
> 但 `web/src/pages/instance-detail.tsx` 已涨到 **1899 行 / 83 KB / 32 个 useState**，
> 再按「打补丁」方式改会越来越乱。本文先盘点现状，再给一套可分批落地的重构方案。

## 0. 现状数据

| 指标 | 数值 |
|---|---|
| `instance-detail.tsx` | **1899 行**，83 KB |
| `useState` | **32 个** |
| `useEffect` | 13 个 |
| `useCallback` | 7 个 |
| `useRef` | 2 个 |
| 页面内定义的子组件 | 14 个（MetricCard/DetailRow/ToolTile/ViewTab/InstanceIcon/CubeGlyph/JavaInstallRow/PlayerActionDialog/InstanceFrpDialog…） |
| 页面渲染的对话框/面板 | 15 个 |
| `instanceDetail.*` 文案键 | **227 个**（zh） |
| 控制台数据源 | **两套**：ConsolePanel 自己 `tail=300` + SSE；页面再轮询 `tail=200`（5s） |

## 1. 功能清单

### 1.1 顶部与状态

| 区域 | 功能 | 备注 |
|---|---|---|
| 指挥条 | 返回、实例图标、名称、状态徽标、延迟徽标、服务器名/主机（脱敏）/Agent 在线状态 | |
| 指挥条右侧 | 控制面板、重启、启动/停止（宽度固定防跳动） | |
| 地址条 | 连接地址、复制、frp 徽标、域名检测状态、重新检测 | 新增，替代原指标卡 |
| 指标条 | 在线玩家/上限、运行时长（停止时上次运行/失败原因）、内存上限 + 主机占用条 | 5→3 |

### 1.2 左栏

| 卡片 | 功能 |
|---|---|
| Java 提示 | 缺 Java 或 <21 时出现，一键安装 |
| 概览 | 核心、内存、端口、frp 状态（地址/复制/设置）、MOTD、展开后：主机地址/正版验证/备注/编辑 |
| 工具 | 文件、server.properties、备份、Mod |

### 1.3 中区

| 视图 | 功能 |
|---|---|
| 概览（默认） | 失败原因、最近事件（错误/上下线/备份/完成）、快捷操作（启停/立即备份/定时任务/打开终端）、命令输入 |
| AI 分析 | AiLogPanel（运行中） |
| Spark | SparkPanel（运行中且已装） |
| 地图 | MapPanel |
| 聊天 | ChatLogPanel |

### 1.4 底部终端 dock

收起一行（最后一行 + ERROR 计数）｜展开半屏/全屏｜拖拽调高并记忆｜搜索｜清空｜`Ctrl+\``｜出现新 ERROR 自动展开｜跨视图常驻（日志不丢）

### 1.5 右栏（仅运行/启动中）

在线玩家名单（头像、本次/累计时长、踢出/封禁/封禁 IP/OP/DEOP）、玩家统计、封禁目录、操作提示。

### 1.6 实例控制面板（模态）

| 分组 | 功能 |
|---|---|
| 基础 | 内存/备注内联保存；核心/端口/正版验证/MOTD 展示；属性、插件配置、完整编辑 |
| 网络 | 域名内联保存；公网端口内联绑定/更新/解除；frp 状态/转发目标 |
| 玩家 | 玩家统计、封禁目录 |
| 自动化 | 自动重启、定时备份（带启用点） |
| 备份 | 立即备份、定时备份 |
| 危险 | 面板安装、重装、删除（运行中提示先停止） |

### 1.7 对话框全集（15 个）

FileManager、ModManager、BackupDialog、BackupSchedule、AutoRestart、Properties、PluginConfig、BanList、PlayerStats、EditInstance、Reinstall、ConfirmDelete、PlayerAction、InstanceFrp、InstanceControlPanel。

## 2. 结构问题（按严重度）

### 2.0 两个直接可感的症状（本次反馈）

| 症状 | 原因 | 重构里怎么解 |
|---|---|---|
| **控制面板偏小** | 模态只有 `max-w-[860px]` + `min-h-[360px]`，六组内容挤在窄框里 | P4：放大到 `min(1160px, 94vw)` × `min(760px, 86vh)`，左导航加宽，内容区独立滚动；基础/网络改两列 |
| **终端不顺手** | dock 挂在**中栏内部**（宽度被左右栏挤掉一截）；默认收起；命令输入要展开后才能用 | P1/P3：dock 移出中栏，改为**整页底部全宽**；加「整行可点击展开」与展开状态记忆；命令输入在收起态也可用（一行输入条） |

| # | 问题 | 证据/影响 |
|---|---|---|
| S1 | **单文件巨型组件** | 1899 行、32 个 state；任何改动都要在整页里定位，review 困难 |
| S2 | **控制台双数据源** | ConsolePanel 自己 tail=300 + SSE；页面再 tail=200 轮询。两套日志可能不同步，概览事件解析依赖第二套 |
| S3 | **入口重复** | frp：左栏行 + 控制面板网络 + InstanceFrpDialog；属性：工具 + 控制面板基础；统计/封禁：右栏 + 控制面板 |
| S4 | **布局魔数散落** | `h-14`、`84px`、`46px`、`140px`、`max-w-1600`、多处 `vh`，靠注释维持，改一处容易错位 |
| S5 | **视图状态与业务状态混杂** | `mainView`、`dockOpen`、`dockHeight`、`panelTab`、14 个 `*Open` 全在一个组件 |
| S6 | **props 深传** | InstanceControlPanel 一次收 20 个 props + 回调 |
| S7 | **i18n 无分组清理** | 227 个 `instanceDetail.*`；删除的「更多管理」「危险卡」等键仍保留 |
| S8 | **页面无组件测试** | 只有 build/lint/通用单测；布局与交互改动没有回归网 |
| S9 | **数据加载分散** | loadServer/loadInstance/loadPlayers/loadStats 各自请求 + 轮询 + SSE 回调，无统一 loading/error |

## 3. 目标结构

```
web/src/pages/instance/
  InstancePage.tsx            # 只负责布局与视图切换（目标 <200 行）
  hooks/
    useInstanceDetail.ts      # server/instance/players/stats/frp + 轮询 + SSE
    useConsoleLog.ts          # 唯一日志源：tail + SSE + 环形缓冲 + 错误计数
    useInstanceActions.ts     # 启停/重启/命令/备份，统一 busy + toast
  layout/
    InstanceHeader.tsx        # 指挥条
    AddressBar.tsx
    MetricStrip.tsx
    InstanceSidebar.tsx       # Java 提示 + OverviewCard + ToolsCard
    ConsoleDock.tsx           # 收起/展开/拖拽/搜索/清空
    PlayerRail.tsx
  views/
    OverviewView.tsx          # 最近事件 + 快捷操作 + 命令
    AiView.tsx / SparkView.tsx / MapView.tsx / ChatView.tsx   # 薄包装
  control-panel/
    ControlPanel.tsx
    tabs/BasicTab.tsx / NetworkTab.tsx / PlayersTab.tsx / AutomationTab.tsx / BackupTab.tsx / DangerTab.tsx
  dialogs/                    # 复用现有 dialogs（文件/Mod/备份/属性/插件…）
```

## 4. 关键设计

### 4.1 唯一日志源（解决 S2）

`useConsoleLog(serverId, name)`：

- 初次 `GET console?tail=300`，随后**只订阅一次 SSE**（不再 5 秒轮询）；
- 维护环形缓冲（如 2000 行）+ `errors` 计数 + `lastLine` + `clear()`；
- `ConsolePanel` 改为**纯展示 + 输入**：日志从 props/context 来，不再自己 fetch；
- 概览的「最近事件」与 dock 的摘要都读同一个缓冲，不再各扫一套。

> ConsolePanel 目前只被实例页使用（`web/src/components/console-panel.tsx`），改造面可控。

### 4.2 数据层统一（解决 S9）

`useInstanceDetail` 返回 `{ server, instance, players, stats, frp, loading, error, reload }`；
轮询（玩家 20s、状态）与 SSE（备份完成等）都收在 hook 内，页面不再各自 `useEffect`。

### 4.3 控制面板吸收重复入口（解决 S3）

- `NetworkTab` 直接内联 frp 绑定（已有），删除 `InstanceFrpDialog`；
- `BasicTab` 保留内存/备注内联，完整编辑仍走 `EditInstanceDialog`（图标/MOTD/正版验证/记录开关）；
- 左栏 frp 行只保留「状态 + 打开控制面板」；工具卡保留文件/属性/备份/Mod。

### 4.4 布局 token（解决 S4）

在页面级定义常量（或 CSS 变量）：`HEADER_H=56`、`ADDRESS_H=40`、`METRIC_H=84`、`TAB_H=46`、`DOCK_MIN=140`，组件统一引用。

## 5. 分阶段迁移

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| P0 | 页面测试基建：mock api/SSE，渲染实例页，断言关键区块（概览/终端/控制面板入口） | 0.5 天 | 测试可在 CI 跑；改动前后都通过 |
| P1 | 抽 `useConsoleLog` + `ConsolePanel` 改为受控；删页面 tail 轮询 | 1 天 | 日志/搜索/清空/自动展开行为不变；概览事件仍正确 |
| P2 | 抽 `useInstanceDetail` / `useInstanceActions`；页面只剩组合 | 1 天 | 轮询/SSE 行为不变；loading/error 统一 |
| P3 | 拆 layout 组件（Header/Address/Metrics/Sidebar/PlayerRail/ConsoleDock）；**dock 移出中栏、改为整页底部全宽**，收起态保留一行命令输入 | 1 天 | `instance-detail.tsx` < 500 行；终端变宽、展开/收起更顺手；视觉无其他差异 |
| P4 | 控制面板拆 tab 文件；**模态放大到 `min(1160px,94vw)` × `min(760px,86vh)`**、内容区独立滚动；吸收 frp 对话框；清理重复入口与死 i18n | 1.5 天 | 功能 parity 清单全过；面板不再拥挤；`instanceDetail.*` 键无未引用 |
| 合计 | | **~5 天** | 每阶段独立提交、可回滚 |

## 6. 功能 parity 清单（重构后逐项验收）

- [ ] 启动/停止/重启、启动中状态
- [ ] 地址复制、域名检测与重查、frp 徽标
- [ ] 3 张指标（玩家/内存/运行时长）
- [ ] Java 缺失提示与安装
- [ ] 概览：核心/内存/端口/frp/MOTD/展开信息/编辑
- [ ] 工具：文件/属性/备份/Mod
- [ ] 概览视图：失败原因、最近事件、快捷操作、命令输入
- [ ] AI/Spark/地图/聊天
- [ ] 终端 dock：收起/展开/拖拽/记忆/搜索/清空/`Ctrl+\``/错误自动展开
- [ ] 右栏：玩家名单与 5 个操作、统计、封禁
- [ ] 控制面板 6 组全部动作
- [ ] 弹窗关闭/焦点/滚动行为

## 7. 不做 / 风险

- **不换 UI 框架**、不动后端 API（除了日志源统一，但仍是现有接口）；
- 不重做视觉风格，尺寸/间距保持现状；
- 风险最高的是 P1（ConsolePanel 改造），但它只被本页使用，且 P0 有测试兜底；
- 每阶段单独提交，出问题可单独回滚。
