# 前端重构盘点（2026-10-21，分支 `refactor/frontend-redesign`）

> 目标：不是继续修实例页，而是把**页面骨架、弹层规范、列表/设置模板、数据层**统一，
> 让后续每个页面都能按模板改。本文先把「有什么、重复什么、缺什么」盘清，再给重构顺序。
>
> 方法：直接读 `web/src` 代码与构建产物（行数、组件、弹层尺寸、API 调用）。
> `docs/blocknexus-current-state.md` 里部分「不存在」结论已过时（如 trust proxy / Secure Cookie / CI 跑 test:agent 已补齐），
> 本文以当前代码为准。

## 1. 页面清单（8 个路由 + 登录态）

| 路由 | 文件 / 行数 | 职责 | 主要内容 | 依赖弹层 |
|---|---|---|---|---|
| `/`、`/instances` | `pages/instances.tsx` / 381 | 默认落地页：所有服务器的实例总览 | 按服务器分组、实例卡（状态/核心/人数/时长）、并发拉取（上限 6）、SSE | QuickAddDialog |
| `/servers` | `pages/servers.tsx` / 221 | 服务器卡片列表 | 拖动排序、在线/离线、资源、快速添加 | QuickAddDialog |
| `/server/:id` | `pages/server-detail.tsx` / 405 | 单台服务器详情 | 资源指标、实例列表、安装/卸载进度、玩家 | CreateInstanceDialog |
| `/server/:id/settings` | `pages/server-settings.tsx` / **1212** | 服务器设置 | 连接（SSH）、Agent 状态/更新、系统信息、Java 多版本、删除 | 本页自带 SettingsCard/InfoGrid + 卸载确认 |
| `/server/:id/instance/:name` | `pages/instance-detail.tsx` / **1899** | 单实例控制台 | 概览/指标/终端/玩家/控制面板 | **15 个**（见 §2） |
| `/settings` | `pages/panel-settings.tsx` / **1671** + `panel-settings-network.tsx` / 648 | 面板设置 | 登录、域名、DDNS、frp、SMTP、通知、AI、语言、版本、更新策略、关于 | 无（卡片内联） |
| `/about` | `pages/about.tsx` / 227 | 关于 | 版本、许可、参考链接 | 无 |
| `/reset?token` | `pages/login.tsx` / 478 | 登录 / 找回密码 / 重置 | 三段式 OTP、密码强度、会话 | 无 |
| （登录态） | `LoginPage` 同上 | 未登录 | 用户名密码、忘记密码 | 无 |

**规模事实**：4 个页面超过 1000 行（instance/server-settings/panel-settings 合计 4782 行）；
单页 state 最多 **32 个**（实例页）；暂无路由级代码分割（无 `lazy`/`Suspense`），首包 1.47 MB。

## 2. 弹层清单（22 个）

| 组件 | 行数 | 当前宽度/高度 | 用途 | 问题 |
|---|---|---|---|---|
| `dialogs.tsx` EditServerDialog | — | `sm:max-w-3xl` | 编辑服务器 SSH | 与服务器设置「连接」重复 |
| TokenDialog | — | `sm:max-w-lg` | 查看/轮换 token | |
| ManualInstallDialog | — | `sm:max-w-lg` | 手动安装命令 | |
| CreateInstanceDialog | — | `sm:max-w-2xl` | 在已有服务器建实例 | 与快速添加重复 |
| EditInstanceDialog | — | `sm:max-w-md` | 实例元信息/图标/MOTD | 与控制面板基础重复 |
| ReinstallDialog | — | `sm:max-w-[420px]` | 重装核心 | 破坏性弹层之一 |
| ConfirmDialog | — | `sm:max-w-md` | 通用确认 | 与卸载/重装/删除并存 |
| quick-add-dialog | 706 | `sm:max-w-3xl` | 加服务器→装 Agent→建实例 | 表单最复杂 |
| file-manager | 908 | `h-[82vh] sm:max-w-4xl` | 文件管理/编辑/上传 | 自带子弹层 |
| mod-manager | 271 | 自定 | Mod 列表/启停/删除 | |
| plugin-config-dialog | 731 | `max-h-[88vh] sm:max-w-5xl` | YAML/JSON/TOML 编辑 | 与属性/文件编辑器重叠 |
| properties-dialog | 300 | `max-h-[88vh] sm:max-w-3xl` | server.properties | |
| backup-dialog | 181 | `sm:max-w-lg` | 备份/恢复 | |
| backup-schedule-dialog | 287 | `max-h-[calc(100dvh-2rem)] sm:max-w-lg` | 定时备份 | |
| auto-restart-dialog | 283 | 同上 | 自动重启/定时重启 | |
| ban-list-dialog | 150 | 同上 | 封禁目录 | |
| player-stats-dialog | 199 | `max-h-[calc(100dvh-2rem)] sm:max-w-2xl` | 玩家统计 | |
| uninstall-dialog | 237 | `max-h-[calc(100dvh-2rem)] sm:max-w-lg` | 卸载 Agent | 破坏性弹层 |
| instance-control-panel | 444 | `max-w-[860px] min-h-[360px]` | 实例设置 6 组 | **偏小**（已确认） |
| StatusBadge / MaskedText / LogViewer / UploadChannel / CardField | 116/39/74/51/37 | — | 通用件 | 复用良好，保留 |

**尺寸事实**：同时存在 `max-w-lg/md/2xl/3xl/4xl/5xl/[420px]/[860px]` 与
`max-h-[calc(100vh-2rem)]/calc(100dvh-2rem)/[82vh]/[88vh]` 多种写法；头部/底部/滚动区结构各写各的。

## 3. 重复与清理候选

| # | 重复 | 证据 | 处理 |
|---|---|---|---|
| D1 | **SettingsCard/Field 两套** | `components/settings-card.tsx` vs `server-settings.tsx:1185/1238` 自建 `SettingsCard/InfoGrid` | 统一到 shared，删除本地实现 |
| D2 | **建实例两处** | `quick-add-dialog.tsx` vs `dialogs.tsx CreateInstanceDialog` | 抽 `InstanceForm`，两处复用 |
| D3 | **SSH 编辑两处** | `EditServerDialog` vs `server-settings` 连接卡 | 设置页只读+跳编辑，或统一为一个表单 |
| D4 | **配置编辑器三套** | properties / plugin-config / file-manager 编辑 | 抽 `ConfigEditor`（解析/校验/保存策略可插拔） |
| D5 | **破坏性确认 5 套** | Confirm/Reinstall/Uninstall/设置页删除/控制面板删除 | 统一 `DangerDialog`（影响描述 + 输入确认） |
| D6 | **卡片/列表项重复** | instances `InstanceCard`、server-detail 实例行、servers 卡片 | 抽 `InstanceCard` / `ServerCard` |
| D7 | **空态/加载态各写** | 各页 `common.loading` 纯文本、不同空态 | `EmptyState` / `Skeleton` 组件 |
| D8 | **错误处理重复** | 各页 `errText + toast`；无全局边界 | `ErrorBoundary` + 统一 `toastError` |
| D9 | **设置页布局两套** | panel-settings 卡片网格 vs server-settings 卡片列 | 统一 `SettingsLayout`（侧栏 tab + 分区） |
| D10 | **i18n 命名混杂** | 227 个 `instanceDetail.*`，含已删入口的键 | 按页/域拆前缀，清未引用键 |

## 4. 缺失能力（前端 / 后端）

### 4.1 前端

- **全局搜索 / 命令面板**：没有（实例/服务器/设置只能点导航）；
- **列表能力**：搜索、筛选、排序、分页、多选批量——全无（服务器列表只有拖动排序）；
- **统一页面骨架**：无 breadcrumb / PageHeader；实例页甚至隐藏导航栏；
- **路由级代码分割**：无 `lazy/Suspense`，首包 1.47 MB；
- **错误边界 / 骨架屏**：无 `ErrorBoundary`，加载态是纯文字；
- **可访问性 / 键盘**：除 `Ctrl+`` 外无快捷键体系；焦点管理依赖 Radix 默认；
- **响应式**：固定 264/248 侧栏 + `max-w-1600`，窄屏基本没设计；
- **页面级测试**：9 个测试文件/185 用例，集中在工具函数与少量组件；实例/设置页无交互测试；
- **类型契约**：`api.ts` 1167 行手写，SSE 事件是手写 union，后端 `bus.emit` 无类型。

### 4.2 后端（前端重构会需要的）

- **审计日志 / 登录记录 / 会话列表**：不存在（`docs/blocknexus-current-state.md` 已验证；本次未改）；
- **指标历史**：只有 30s 快照，无分钟级聚合/图表接口；
- **Webhook 通知**：只有 SMTP；
- **任务中心**：定时任务全在 Agent，无「下次执行/历史/手动触发」接口；
- **批量操作**：无批量启动/停止/安装接口；列表查询无 `q/sort/page` 参数；
- **统一响应信封**：错误码已统一（`error-codes.js`），成功响应仍是 `{ok}` 与裸对象混用；
- **SSE 事件 ID / 回放**：无 `Last-Event-ID`，断线丢事件；
- **契约生成**：无 OpenAPI/JSON Schema/shared types。

> 说明：审计/会话/指标历史/Webhook 属于**产品能力**，不是前端重构的前置；但若新前端要展示它们，需要同步排期。

## 5. 目标信息架构

```
┌ 左侧 NavRail：实例 · 服务器 · 设置 ────────────────┐
│ 顶栏：面包屑 · 全局搜索(Ctrl+K) · 连接状态 · 主题   │
├──────────────────────────────────────────────────┤
│ ListPage：工具栏(搜索/筛选/排序/视图) + 卡片网格    │
│ DetailPage：Header(标题/状态/主操作/更多) + 指标 + Tab │
│ SettingsPage：侧栏分组 + 分区表单                   │
└──────────────────────────────────────────────────┘
```

- **实例页**：概览 + 整页宽底部终端（按 `instance-page-refactor.md`）；
- **服务器设置**：Tab = 连接 / Agent / 运行时 / Java / 危险；
- **面板设置**：Tab = 访问 / 网络（域名+DDNS+frp）/ 邮件与通知 / AI / 更新 / 关于；
- **弹层规范**：`DialogShell` 固定 4 档（sm 420 / md 560 / lg 760 / xl 960 / full 90vh），
  固定 header/footer、body 滚动、关闭按钮位置一致；表单用 `FormSection`，危险动用 `DangerDialog`。

## 6. 数据层

- `web/src/lib/api/` 按域拆：`servers.ts` / `instances.ts` / `settings.ts` / `network.ts` / `auth.ts`；
- 通用 hooks：`useApiQuery`（loading/error/refetch）、`usePolling`、`useSseEvent`；
- 共享类型：短期在 `web/src/lib/contracts.ts` 收口，长期由后端生成（可选）；
- 日志：**唯一日志源**（见实例页方案），ConsolePanel 改受控；
- 不引重依赖（不引 TanStack Query/状态库），保持包体。

## 7. 阶段计划（分支内小步合并）

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| F0 | 本盘点 | — | 本文 |
| F1 | 设计原语：DialogShell / PageHeader / SettingsSection / ListToolbar / EmptyState / Skeleton；选 3 个弹层试点 | 3–4 天 | 试点弹层尺寸/结构一致，无行为变化 |
| F2 | 列表页重构：实例/服务器共用卡片与工具栏，加搜索/筛选/排序（后端暂用客户端过滤） | 4–5 天 | 列表可搜可筛；卡片不再重复实现 |
| F3 | 服务器设置：Tab 化 + 复用 SettingsSection，删本地 SettingsCard | 2–3 天 | 行数减半；功能 parity |
| F4 | 面板设置：Tab 化，网络组拆出 DDNS/frp | 2–3 天 | 不再是一条长页 |
| F5 | 实例页：按 `instance-page-refactor.md` P0–P4 | 4–5 天 | 见该文档 parity 清单 |
| F6 | 清理：i18n 死键、重复弹层、路由级 lazy、页面测试 | 2–3 天 | 初始包明显下降；测试覆盖 5 个主路由 |

合计约 **3–4 周**（按小步提交，每阶段可单独 review/回滚）。

## 8. 验收标准

- 单页 ≤ 600 行（实例/设置页 ≤ 400 行，靠组件拆分）；
- 弹层只用 `DialogShell` 的 4 档尺寸，禁止再写 `max-h-[88vh]` 之类魔法值；
- 列表页有搜索/筛选/排序；服务器/实例卡片各只有一份实现；
- 首屏路由级分割，初始包目标 < 900 KB；
- 5 个主路由有页面级 smoke 测试（渲染 + 关键交互）；
- 功能 parity 清单逐页勾选（实例页清单见 `instance-page-refactor.md`）。

## 9. 风险与不做

- **不换 UI 框架**（继续 shadcn/Radix + Tailwind），不重做视觉语言；
- **不一次性重写**：按 F1–F6 小步合并，旧页面保留到 parity 通过；
- 后端 API 尽量不动；需要新增的（搜索参数/批量/审计）单独排期，不阻塞前端；
- 最大风险在 F5（实例页），已有独立方案与 parity 清单。
