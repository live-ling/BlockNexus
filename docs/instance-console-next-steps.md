# 实例控制台页 · 勘察结论与后续修改建议（2026-10-25）

> 勘察对象：`web/src/pages/instance-detail.tsx`（1821 行）、`console-panel.tsx`（319 行）、
> `lib/sse.ts`（151 行）。本文只列**经代码验证**的事实，建议按优先级排序。
> 与 `instance-page-refactor.md`（排版规格）、`frontend-redesign-audit.md`（全局盘点）互补，不重复其内容。
>
> **状态：S1–S5 已实施（2026-10-25）**，实施结果见文末「实施结果」。

## 0. 勘察后修正的三个前提

1. **前端没有权限系统**。全仓 grep 不到 role/permission 字段——面板是单用户登录制。
   之前报告里的「权限派生」不适用于当前代码；真正的访问控制只有登录态。
   **建议：本轮不为它发明权限模型**（AGENTS.md 也写明多租户暂不做），但状态建模时把
   `canOperate` 留成派生函数的位置，未来加权限只改一处。
2. **第三版 IA 已落地且基本健康**：5 页签（2026-10-25 后续把「配置」与「维护」合并为「配置与维护」，现为 4 页签）、终端常驻概览、弹层入口已收敛（`openFromPanel` 统一调度）。
   页面头部注释（L4–L11）甚至写了布局硬约束。**骨架不要动。**
3. **真正的病在数据层与组件边界**，全部可在实例页内部修，不动后端、不动其它页面。

## 1. 代码实证的问题（按严重度）

### P0-a 日志双数据源（结构性，refactor 文档 §6 已标记未修）

- 页面：`console?tail=200`，**常驻 5s 轮询**（L243–261）→ 喂 ERROR 计数/最近事件。
- ConsolePanel：自拉 `tail=300` 历史 + 自订阅 SSE `console` 事件（L136–172）→ 喂显示。
- 后果：两条时间线；页面**永远**每 5 秒打一次接口（切走页签也不停）；计数与屏幕可能不一致；
  断线恢复时两处各补各的，缺口策略不同。

### P0-b 状态所有权混乱（实测 30+ 个 useState，14 个弹层开关平铺）

L130–175：`modsOpen/backupOpen/backupScheduleOpen/watchdogOpen/propsOpen/plugCfgOpen/editOpen/
deleteOpen/reinstallOpen/bansOpen/panelOpen/statsOpen/mapOpen/diag` —— 14 个布尔/枚举
平铺在页面顶层。任何一个弹层组件改名都要动页面。另有 `forceTick`（L175）这种
「为让时长走动而每秒重渲整页」的 hack（30s 一次，可接受，但应隔离在指标组件内）。

### P0-c ConsolePanel 内部维护第二份 status（L84）

`const [status, setStatus] = useState(instanceStatus)` —— 接收 prop 后又自立门户，
靠 SSE `instance.updated` 自行更新。父组件的 `instance.status` 与它可能短暂不一致，
「启停按钮可用」与「命令输入可用」由此会出现不同步的窗口期。

### P1-a 轮询无页签门控、无运行态门控

- `tail=200` 5s：无条件常驻（见 P0-a）。
- players 20s / stats 60s：有 `running` 门控（L291–304，好），但**没有 tab 门控**——
  用户在「文件」页签时玩家数据照刷。
- `files?path=` 探测（L264–278）：每次进页面都列一次根目录只为判断插件入口显隐，
  应延后到首次打开「配置」页签。

### P1-b SSE 事件处理散在组件里写 if 链（L307–343）

`subscribeServer` 回调里 5 个 if 分支 + 3 处 `setTimeout(load*, 800/1500)` 的
「等等再拉」猜测式刷新。没有 `Last-Event-ID`，断线期间的事件直接丢（sse.ts L88 靠
EventSource 自带重连，无补洞逻辑）。`installLogStore`（sse.ts L111–151）已是正确的
store 模式，但**实例日志没有走它**——两套模式并存。

### P1-c 乐观刷新靠 setTimeout 猜测

L416–419、L436：`op()` 成功后 `setTimeout(1500)` 再拉数据。正确做法已存在一半：
SSE `instance.updated` 会推状态，setTimeout 只是兜底。**保留兜底可以，但 UI 应以
SSE 为准**，当前代码里两者都在改同一份 state，时序靠运气。

### P2-a 页面内还藏着 3 个子组件（L1659+）

文件尾部内联定义了全屏浮层壳、Java 缺失引导、玩家操作确认等组件（各自带 useState），
加上主组件共 1821 行。应拆文件。

### P2-b 无错误边界、加载态是纯文本

`if (!server || !instance) return <div>加载中</div>`（L455–457）。agent 离线、
实例 404、SSE 断线三者在视觉上无法区分。

## 2. 修改建议（按执行顺序，每步独立可回滚）

### S1 · 日志单源化（P0-a + P0-c，最大收益）

1. 在 `lib/sse.ts` 旁新增 `instanceLogStore`（照搬 `installLogStore` 的
   `useSyncExternalStore` 模式）：订阅 SSE `console` 事件，按 `serverId:instance` 分键，
   环形缓冲 1500 行，派生 ERROR 计数。
2. ConsolePanel 改受控：`lines` / `status` 全部由 store 经 props/hook 注入，
   删除其内部 `tail=300` 拉取与 `subscribeSSE`（保留滚动跟随、命令历史等纯 UI 逻辑）。
3. 页面删除 5s `tail=200` 轮询，改从同一 store 读计数/最近事件。
4. 断线补偿：SSE `onerror` 后首次 `onmessage` 时拉一次 `tail=N` 补缺口（一次性，非常驻）。
   验收：整页只有一处 `console?tail=`；切页签后 Network 面板无周期请求。

### S2 · 状态收口：`useInstancePage` hook（P0-b）

- 14 个弹层开关合成一个 `modal: { kind: 'none' | 'mods' | 'backup' | ... }` 判别联合——
  同时只能开一个弹层本来就是事实（`openFromPanel` 已在强行保证），用类型把它钉死。
- 所有 `setInterval`/`subscribeServer` 收进 hook；组件只消费返回值。
- `forceTick` 挪进指标组件内部。
  验收：页面文件 ≤ 800 行，顶层 useState ≤ 8 个。

### S3 · 轮询门控（P1-a）

players/stats 加 `tab === 'players' || tab === 'overview'` 门控；`files?path=` 探测
延后到配置页签首次激活。纯减法，无风险。

### S4 · 事件处理集中化（P1-b + P1-c）

SSE 回调改为单一 reducer 式 switch；`op()` 后不再 setTimeout 猜刷新，UI 等
`instance.updated`（保留一次 5s 兜底超时即可）。补 10 种异常态的 UI 表达
（断线灰点 + 重连提示是最优先的一个，目前完全缺失）。

### S5 · 拆文件（P2-a）

页尾 3 个内联组件移出为 `components/instance/` 下独立文件。最后做，纯机械。

### 不做

- 不引入状态库/TanStack Query（audit 已定调）；`installLogStore` 模式够用。
- 不动 IA、不动后端 API、不加权限模型。
- 不重写 ConsolePanel 的显示/交互逻辑（命令历史、自动跟随是好的）。

## 3. 给 AI 协作的落地约束（写进每次 prompt）

1. 「整页不滚动、高度链 100vh→flex-1→min-h-0」已在文件头注释，改动前复述。
2. 任何新 state 必须先回答「归 hook 还是归组件」；禁止第 15 个平铺弹层开关。
3. 组件不得自带 `setInterval`/`subscribeSSE`。
4. 每步交付附 parity 检查：功能清单逐项勾 + Network 面板无多余周期请求。

## 4. 实施结果（2026-10-25，S1–S5 已完成）

### 落地的文件

| 文件 | 变化 |
|---|---|
| `web/src/lib/instance-log-store.ts` | **新增**：全页面唯一的日志数据源（历史一次拉取 + SSE 实时追加 + 断线补偿），按 `serverId:instance` 分键，1500 行环形缓冲 + dropped 计数 |
| `web/src/lib/instance-log-store.test.ts` | **新增**：10 个用例（历史加载 / 实时追加 / 缓冲上限 / 断线合并） |
| `web/src/lib/sse.ts` | 新增 `sseConnection` 状态机（idle/connecting/open/reconnecting/closed）+ 浏览器 `offline`/`online` 事件接线 |
| `web/src/components/console-panel.tsx` | 改受控：删除内部 `tail=300` 拉取与 `subscribeSSE`，日志/状态一律来自 store |
| `web/src/pages/instance-detail.tsx` | 删除 5s `tail=200` 轮询；弹层 12 个布尔 → `ModalKind` 判别联合；轮询加页签门控；新增断线/Agent 离线条件条与头部连接指示；拆文件后 1461 行 |
| `web/src/pages/instance-detail/parts.tsx` | **新增**：指标条 / 配置行 / 浮层壳 / 页签 / 图标等展示组件 |
| `web/src/pages/instance-detail/dialogs.tsx` | **新增**：Java 安装行 + 玩家操作确认框 |
| `web/src/pages/instance-detail/avatar.ts` | **新增**：头像底色（单独成文件以满足 Fast Refresh 约束） |

### 关键实现取舍

1. **断线补偿不做内容去重**：MC 日志里重复行是常态（"Saving chunks" 连着出现），
   按内容去重会悄悄吃掉真实日志。合并策略是「以 Agent 尾部末行为锚点」，
   锚点找不到（Agent 重启过）时直接拼接，本地行一条不丢。
2. **只往已打开的实例追加**：Agent 会为同服所有实例推 `console` 事件，
   没人看的实例不在面板内存里堆缓冲。
3. **`onerror` 不可靠**：实测 CDP 断网时已建立的 SSE 连接不会立刻报错。
   所以额外接了浏览器 `offline`/`online` 事件，并把 `reconnecting`（能自愈）
   与 `closed`（必须刷新）区分开。
4. **命令执行后的刷新**：以 SSE `instance.updated` 为准，原来的固定 `setTimeout(1500)`
   改成 5s 兜底（原来是猜「差不多该好了」）。

### 实测验证（真实远程实例 minimc）

- 概览页 12 秒内 **零** 周期请求（改造前每 5 秒一次 `/console?tail=200`）；
- 切到「文件」页签 10 秒内 **零** players/console/files 请求；
- 切回「概览」后 players 轮询恢复；
- 断网 → 顶部出现「实时连接已断开」条件条，恢复 → 自动消失；
- 终端 300 行历史一次拉取、实时追加正常；ERROR 计数与「最近事件」同源；
- 布局硬约束未变：整页不滚动、Header 44px、指标条 72px、终端区 412px；
- `npx tsc -b` 绿、`oxlint` 0 warning、vitest **207 passed**（原 197 + 新 10）、`npm run build:web` 通过。

### 仍未做（留给下一轮）

- `useInstancePage` hook 尚未抽离（顶层 useState 约 20 个，其中一半是弹层/菜单的 UI 态）；
- SSE 回调仍是 if 链（未改 reducer/switch）；
- 错误边界（ErrorBoundary）与骨架屏仍未加；
- 指标历史图表、任务中心等属产品能力，不在前端重构范围。

## 5. 第二轮：视觉与操作优化（2026-10-25）

第一轮解决的是「数据对不对」，这一轮解决「好不好看、顺不顺手」。改动前用无头浏览器
实测（1440×860），把主观感受落成数字：

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 终端高度占视口 | 412px / 48% | **574px / 67%** |
| 终端可视行数（22px 行高） | 20 行 | **23 行**（字号 12.5→13） |
| 概览右侧「最近事件」卡 | 554px 高，内容与日志重复 | **已删除**，改为终端工具行「仅看错误」 |
| 固定区块堆叠 | 指标条 96 + 地址卡 66 + 快捷操作 28 | **指标条 72（仅运行时）+ 地址一行 32** |
| 停止态 | 三格「—」+ 空地址卡 + 旧 ERROR 徽章 | **中央大启动按钮 + 停止原因 + 最近日志（默认收起）** |
| 非日志字号档位 | 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 + 20 | **11 / 12 / 13 / 20 四档** |
| 主操作按钮高度 | 28px | **36px（中央启动 44px）** |
| 停止态页面文本节点 | 349 | **17** |

具体落地：

1. **终端吃掉主区**：删除右栏与「最近事件」卡，终端全宽；日志 13px / 行高 22px。
2. **地址压成一行**：地址、复制、frp、核心/Java/端口、域名检测收进一行 32px；
   非运行态不再渲染这一行。
3. **状态驱动布局**：运行态＝指标条 + 地址行 + 终端；停止/失败态＝状态图标 + 原因 +
   中央启动（44px）+ 查看最近日志/备份/控制面板，日志默认收起。
4. **ERROR 只算本次运行**：`instanceLogStore` 增加 `runStart`，在 `starting` 时前移，
   缓冲裁剪时同步左移；停止后不再挂历史错误。
5. **字号四档 + 按钮 36px**：`text-[10.5px]/[12.5px]` 等全部收敛；主操作 28→36，
   重启从 ⋮ 提为常驻按钮；地图/属性/控制在顶部 ⋮，备份仍在 ⋮。
6. **入口去重**：删除与页签重复的快捷操作行（文件→页签、备份→⋮、重启→Header）。

### 验收数据（实测）

- 运行态：终端卡 574px / 视口 860px = **67%**；页面不可滚动；
- 停止态：可见文本 17 个、无空指标、无历史 ERROR 徽章、中央启动按钮 44px；
- 「仅看错误」：300 行缓冲 → 226 行，非错误行 **0**（含异常堆栈行）；
- 字号统计：11px / 12px / 13px / 20px 四档，无 10px；
- 实例已按验证前状态恢复为 **stopped**。

## 6. 第三轮：控制面板宽度修复与同步收尾（2026-10-25）

### 根因

`DialogContent` 的基础类里有 `sm:max-w-sm`（24rem = **384px**）。控制面板写的是
`w-[min(1160px,94vw)] max-w-none`：`max-w-none` 没有 sm 变体，**压不过** `sm:max-w-sm`，
于是面板一直渲染成 384px 宽——这不是「设计得窄」，是**样式没生效**。

修复：`max-w-none! sm:max-w-none!`。实测 **1160 × 774**（nav 200 + 内容 960）。

### 面板重排

| 项 | 改前 | 改后 |
|---|---|---|
| 实际宽度 | 384px | **1160px** |
| 内容区 | 单栏 max-w 620（右侧大片留白） | **自适应双栏**，基础＝表单 568 + 只读 320 |
| 左导航 | 180px / 条目 30px / 12.5px | **200px / 条目 36px / 13px** |
| 网络组 | 一条长表单 | 域名 / frp **两张卡并排**（≥1280） |
| 自动化 | 单列两行 | 两张卡并排 |
| 控件 | 输入/按钮高度不一 | 输入 **36px**、按钮 **36px**、字号 **13px** |
| 小屏 | 200px 导航 + 152px 内容，不可用 | 导航转**横向页签**，内容 p-4 |

### 连带同步的几处

1. 停止态中央按钮只保留「查看最近日志」——`备份/控制面板` 与顶部 ⋮ 重复，删掉。
2. 文档同步：`instance-page-refactor.md` §2/§3/§6（概览新布局、面板 1160×780、双数据源已合并）、
   `frontend-redesign-audit.md` 的面板尺寸行。
3. 面板内 9 个 Button 统一 `text-[13px]`（组件默认 text-sm / size=sm 的 0.8rem 混用）。

### 验收

- 面板 1160×774，nav 200 / 内容 960，四个页签**均无横向溢出**（scrollWidth = clientWidth）；
- 基础信息卡片 568 + 320、网络 446×2、自动化 450×2、危险 880；
- 输入框 36px、按钮 36px；字号仅 11/12/13/14/16（14 来自 Button 组件默认值）；
- `tsc -b` 0 错误、vitest 210 passed、`npm run build:web` 通过。

## 7. 第四轮：配置/维护合并 + 设置页右栏利用（2026-10-25）

### 实例页：5 页签 → 4 页签

「配置」与「维护」**不是上下拼接**，而是按「改什么 / 数据与自动化」分成两列：

```
配置与维护
├ 左列 0.92fr：配置入口（属性/插件/Mod/编辑，44px 行）+ 诊断（AI/Spark）
└ 右列 1.08fr：备份列表（min-h 300）+ 自动化（自动重启/定时备份）
```

- 页签名 `配置与维护`，`Tab` 类型删除 `maintenance`；`BackupPanel active` 跟随 `config`；
- `files?path=` 探测仍只在首次进入该页签时触发；
- 左列表头 hint 改为「属性、插件与 Mod 入口；保存后按提示重启生效」，
  不再与「编辑」行的说明重复。

实测（1440×860）：4 个页签、两列 641 / 753px、面板无横向溢出、备份/自动化/诊断三块内容齐全。

### 两个设置页右侧留白

| | 改前 | 改后 |
|---|---|---|
| 面板设置内容列 | 680px（右侧空 570） | **1080px（右侧空 170）** |
| 服务器设置内容列 | 760px（右侧空 490） | **1080px（右侧空 170）** |
| 面板并排卡片 | 全部单列纵排 | 网络/通知/更新/外观 **xl 两列**（各 506px） |
| 面板单卡表单 | 620px 封顶 | **760px**；登录保护改 **3 列**、域名改「输入 + SSL 提示」两列 |
| 服务器信息行 | 单列 7 行 | **两列成对**（4+3 行） |
| 服务器 InfoGrid 字号 | text-xs | **12px**（标签 11px） |

- `SettingsLayout` 的默认宽度不变（仍 760），两个页面显式传 `contentClassName="max-w-[1080px]"`；
- `FormGrid` / `FormActions` 上限 620 → 760，仍不会把单字段拉满整行；
- 面板设置实测无横向溢出；各卡片 506px，服务器信息块 1032px。

### 仍未动

- 服务器设置的 Agent / Java 两张长卡仍是单列（内部本身是多行状态列表，硬拆两列会错位）；
- 面板设置 1080 下仍有 170px 右侧留白（留给滚动条与视觉呼吸，不再继续拉宽）；
- 弹层高度写法仍有两套（`88vh` vs `calc(100dvh-2rem)`），未在本轮统一。

## 8. 第五轮：设置页双列断点、日志面板与 Agent 版本判断（2026-10-25）

### 面板设置「还是单列」

原因：上一轮并排卡片用的是 `xl:grid-cols-2`，只在**视口 ≥1280** 生效。桌面外壳窗口常见
1100–1250 宽，于是又退回单列。改为 **`lg`（≥1024）**，并把内容列 1080 → **1160**：

| 视口 | 内容列 | 并排卡片 |
|---|---|---|
| 1440 | 1160（右留白 90） | 2 列 546 |
| 1200 | 995 | 2 列 464 |
| 1024 | 819 | 2 列 376 |

### 去掉项间分隔线

- `ToggleRow` 的 `border-t`（开关行之间的横线）
- DDNS / frp 「启用」标签下的 `border-b`
- DDNS「高级」展开区的 `border-l`

保留的只剩分段控件自身的外框（主题切换 / 更新策略），那不是分隔线。

### frp / DDNS 日志

原来日志是行内 `<span className="max-h-24 overflow-auto">`：**max-height 对 inline 元素无效**，
行数一多就把页面撑长，也没法滚动。改为共用 `LogPanel`：

- 固定 `max-h-40` 的块级滚动区，逐行渲染，自动滚到最新一行；
- 剥掉 frpc 的 ANSI 颜色符（`\x1b[0m` / `\x1b[1;33m`），否则满屏 `[0m[1;33m`；
- 错误行红色、警告行琥珀色，其余中性；显示「最近 N 行」；
- frp 即使没有输出也显示「暂无输出」，DDNS 有日志才出现。

实测 frp 面板：高 160px、scrollHeight 1736px（40 行），文本已从日期开头，无 ANSI 残渣。

### Agent「未安装」被判成版本过低

`agentOutdated()` 原实现是 `remote !== bundled`：`info` 为空（没装）时 `remote = undefined`，
于是必然为 `true`，服务器设置页在 Agent 未安装时显示「有新版本可用 / 版本过低」。

修复：**只有 `info` 存在且 `agentVersion` 非空时才比较**；未安装 / 老 Agent 未上报版本一律
返回 `false`，页面走安装引导或「旧版（未上报版本）」，不再谎报落后。
测试补 3 例（`info: null` / 空版本 / 空对象），vitest 由 210 → **211 passed**。
