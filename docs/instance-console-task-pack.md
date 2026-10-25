# 实例控制台页 · 执行任务包（给执行 agent，2026-10-25）

> 本文是**可直接投喂给编码 agent 的任务规格**。每个任务 = 目标 + 改动范围 + 硬约束 + 验收命令。
> 勘察依据见 [instance-console-next-steps.md](./instance-console-next-steps.md)（行号证据都在那里）。
>
> ## 全局禁令（每个任务都生效，prompt 里必须原样带上）
>
> 0. **frp 冻结**：另一个 agent 正在修 frp。禁止改动：
>    `panel/frp.js`、`panel/ddns.js`、`panel/api.js` 中 frp/DDNS 相关路由、
>    `web/src` 内 `getInstanceFrp` / `InstanceFrpInfo` / 控制面板「网络」组的代码、
>    `agent/src/**` 全部。遇到必须触碰时**停下来报告**，不要绕。
> 1. **不改后端**：`panel/**`、`agent/**`、`scripts/**` 一律只读。只允许改 `web/src/**` 和 `docs/**`。
> 2. **不动 IA**：页签（概览/玩家/文件/配置与维护；配置与维护已于 2026-10-25 合并）、Header 44px + Tabs 40px、终端常驻概览，
>    一律保持。不重排布局、不换组件库、不引新依赖。
> 3. **布局硬约束**（instance-detail.tsx L4–L11 原文，改动前复述一遍）：
>    整页不滚动 `h-screen + overflow-hidden`；高度链 `100vh → flex-1 → min-h-0`；
>    指标卡 `h-[84px]` 写死；主操作按钮位置/宽度恒定。
> 4. **不丢功能**：每个任务交付时附 parity 清单（该任务触及的功能逐项打勾）。
> 5. **i18n**：新增文案必须 zh/en 双键，键名沿用 `instanceDetail.*` 前缀。
> 6. **验证**：每步完成后跑 `npm run build:web` 必须绿；用提交态验证
>    （本仓库有过「工作区能编译、提交后 CI 失败」的前科）。
> 7. **组件不得自带 `setInterval` / `setTimeout` 轮询 / `subscribeSSE`**——
>    定时器与订阅只能存在于 hook 或 store 里（S2 完成后这条成为永久规则）。
> 8. 小步提交：一个任务一个 commit，messages 用 `refactor(web): ...`。

---

## 任务 S1 · 日志单源化（P0，先做）

**目标**：整页只剩一个日志数据源；ConsolePanel 变为受控组件。

**背景（agent 必须先读）**：
- 页面常驻 5s 轮询 `console?tail=200`（instance-detail.tsx L243–261）喂 ERROR 计数/最近事件；
- ConsolePanel 自拉 `tail=300` + 自订阅 SSE `console` 事件（console-panel.tsx L136–172）喂显示；
- ConsolePanel 还私藏第二份 status（console-panel.tsx L84，`useState(instanceStatus)` 后自立门户）。
- `lib/sse.ts` L111–151 已有 `installLogStore`（`useSyncExternalStore` 模式）——**照抄这个模式**。

**改动范围**：
1. 新增 `web/src/lib/instance-log-store.ts`：按 `serverId:instanceName` 分键，
   环形缓冲 1500 行，派生 ERROR 计数与「最近事件」所需数据；内部统一做
   `{ ts, text }[] → string[]` 归一化（`consoleLines`，老/新 Agent 混用的坑见 console-panel.tsx L145 注释）。
2. `console-panel.tsx`：
   - 删除内部 `tail=300` 拉取（L136–153）与 `subscribeSSE`（L156–172）；
   - `lines` / `status` 改为从 store 读取（props 注入或组件内 `useSyncExternalStore`，二选一，保持其一贯性）；
   - **保留**：命令历史、草稿、自动跟随滚动、搜索过滤、输入框自适应高度——这些是纯 UI，不许动逻辑。
3. `instance-detail.tsx`：删除 L243–261 的 5s 轮询，ERROR 计数/最近事件改从同一 store 读。
4. 断线补偿：SSE 重连成功后**一次性**拉 `tail=200` 补缺口（非常驻轮询）。

**验收**：
- 全局 grep `console?tail=` 在实例页运行期只剩「初次加载一次 + 断线补偿一次」两处调用点；
- DevTools Network：页签来回切换 60 秒，无周期性 console 请求；
- 终端显示、ERROR 计数、最近事件三者同源（同一行日志同时出现在三处）；
- `npm run build:web` 绿；parity：命令下发/历史/搜索/清空/跟随滚动全部正常。

---

## 任务 S2 · 状态收口 `useInstancePage`（P0，依赖 S1）

**目标**：页面顶层 useState ≤ 8 个；弹层开关从 14 个布尔变成 1 个判别联合。

**改动范围**：
1. 新增 `web/src/pages/instance-detail/use-instance-page.ts`（目录随拆分建立）：
   收编所有 `load*`、`setInterval`、`subscribeServer`、SSE if 链（L307–343）。
2. 弹层状态合并为 `modal: { kind: 'none' } | { kind: 'mods' } | { kind: 'backup' } | ...`
   判别联合——`openFromPanel`（L364–368）已经在事实上保证同时只开一个，用类型钉死它。
   保留 160ms 的关闭动画延时逻辑（两个 Dialog 抢焦点的坑，注释在 L366）。
3. `forceTick`（L175）挪进指标组件内部，不再驱动整页重渲。
4. SSE 回调改为单一 switch；`op()` 后的 `setTimeout(1500)` 猜测刷新（L416–419）改为
   等 SSE `instance.updated`，只保留 5s 兜底超时。

**约束**：hook 返回值按区域分组（`header / overview / players / ...`），
组件只取自己那组；禁止把整个 hook 返回值透传下去。

**验收**：instance-detail.tsx ≤ 900 行；顶层 useState ≤ 8；
操作启停后状态变化由 SSE 驱动（可在代码里 grep 确认无裸 `setTimeout(load`）。

---

## 任务 S3 · 轮询门控（P1，独立于 S1/S2，可并行）

**目标**：非激活页签不发周期请求。

**改动范围**（都在 instance-detail.tsx / 或 S2 后的 hook 里）：
1. players 20s / stats 60s 轮询（L291–304）：增加门控 `tab === 'overview' || tab === 'players'`；
   保留现有 `running` 门控（这是对的，别删）。
2. `files?path=` 根目录探测（L264–278）：延后到「配置」页签**首次**激活时再发
   （用 ref 记「已探测过」，避免每次切页签都发）。

**验收**：DevTools Network：停在「文件」页签 90 秒，只有 SSE 连接，无 players/stats/files 请求；
切回概览后数据 1 个周期内刷新。

---

## 任务 S4 · 异常态补齐（P1，依赖 S2）

**目标**：以下状态有明确 UI 表达，不再共用「加载中」纯文本（L455–457）。

| 状态 | UI 要求 |
|---|---|
| SSE 断线 | Header 状态点变灰 + 条件条「连接中断，重连中」（目前完全缺失，最高优先） |
| Agent 离线 | 条件条红色；MetricStrip 整条隐藏（不显示 0 骗人）；全部操作禁用；历史日志仍只读可看 |
| 实例未运行 | 终端空态文案 + 命令输入禁用并说明原因（已有，保持）；启停按钮=启动 |
| 安装中 | 条件条 amber + 进度；启停禁用；**提供「重试续装」入口**（语义见 AGENTS.md：复用同名实例，禁止建出 xxx-2） |
| 日志爆炸 | 缓冲截断时显示「已丢弃 N 行」；自动跟随暂停，滚到底才恢复（ConsolePanel 已有跟随逻辑，补丢弃计数即可） |
| 实例 404 / 加载中 / 断线 | 三者视觉上必须可区分（现在都是一行灰字） |

**约束**：状态文案全部走条件条（AlertBanner 区域，无事零高度），**禁止新增常驻色块**；
颜色只走语义令牌 + emerald/amber/red 状态色（refactor 文档硬约束 3）。

**验收**：手工构造：停 Agent → 页面显示「Agent 离线」而非转圈；拔网 → 断线提示出现；
恢复后提示消失且日志缺口被补（S1 的补偿逻辑）。

---

## 任务 S5 · 拆文件（P2，最后做，纯机械）

**改动范围**：instance-detail.tsx 页尾 3 个内联组件（L1659 起：全屏浮层壳、Java 缺失引导、
玩家操作确认）移出到 `web/src/pages/instance-detail/` 下独立文件；
主文件同步迁入该目录成 `index.tsx`。

**约束**：零行为变化；import 路径用 `@/` 别名；不许顺手「优化」任何逻辑。

**验收**：`npm run build:web` 绿 + parity 清单全勾；主文件 ≤ 500 行（S1–S4 完成后应自然达标）。

---

## 执行顺序与依赖

```
S1（日志单源）──┐
               ├─→ S2（状态收口）─→ S4（异常态）─→ S5（拆文件）
S3（轮询门控）─┘  （S3 可随时插入，与 S1/S2 无冲突）
```

- 每个任务单独 commit、单独可回滚；S2 依赖 S1（store 先行，hook 才好收）。
- 任何任务中发现「必须改后端才能修」的问题：**停下，写进 docs/instance-console-next-steps.md
  的「待后端排期」节，不要绕过后端禁令**。
