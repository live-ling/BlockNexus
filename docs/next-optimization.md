# 后续优化清单（2026-10-19 记录）

> 来源：frp / DDNS 合并后的一次方向讨论。排序原则：**先堵新功能带来的风险 → 再做产品价值 → 最后才碰架构**。
> 现状基线：面板与 Agent 0.5.4；DDNS（Cloudflare/DNSPod/DuckDNS/Callback）与 frp（SakuraFrp / 自建 frps + 单实例端口绑定）已合入 `main`。

## P0 — 立即（2–3 天）

### 1. frp 安全闭环

- **暴露面板前强制登录保护**：代理目标端口 = 面板端口且 `authEnabled=false` 时，拒绝保存/启动（或强警告 + 一键设密码）。frp 让「把面板交给公网」只差一个端口号。
  ⚠️ **后端已完成（2026-10-25）**：`frp.exposureRisk()` 纯函数 + `PUT /network/frp`、`start`/`restart`、`import` 三处拦截（错误码 `network.frp-exposes-panel`，附 6 例测试）。**前端「一键开登录保护」入口仍待做**。
- **frp 配置收口**：设置页只保留 server / token / 二进制路径；代理列表只由实例页维护，避免两处改同一份 `settings.frp.upstream.proxies` 互相覆盖。
- **远程 / 异地实例的 frp**：面板托管的 frpc 只能转发面板本机端口。正确做法是 **Agent 侧托管 frpc**（面板下发配置，Agent 在本机 spawn、回传日志与状态），实例页的「绑定端口」对远程实例才可用。
- **SakuraFrp 模式真机验证**：⚠️ 已用真实账号实测（2026-10-25，上游 frpc 0.71.1）——**登录 / 隧道注册 / 端到端转发均通过**，但同时证明面板现有两种模式都接不上樱花：upstream 模式缺 `user` 字段（樱花节点拒绝登录），sakura 模式的 `-f`/`-n` 是樱花定制 frpc 私有参数（上游 frpc 报 `unknown shorthand flag`）。**真机验证不再需要，改成「SakuraFrp 引导」实现**，方案与实测证据见 [frp-sakurafrp-onboarding.md](./frp-sakurafrp-onboarding.md)。

### 3. 樱花 frp 引导（粘贴配置 → 自动加载客户端）

- **一句话**：用户从樱花后台复制整段手动配置粘贴进面板，面板/Agent 自动准备 frpc、生成配置、启动并显示「隧道在线 + 公网地址」。
- ✅ **已落地（2026-10-25）**：`user` + `transport.tls` 透传、`parseSakuraConfig()` 纯函数（含 80 例回归）、`POST /network/frp/import`、设置页「粘贴樱花配置」弹窗（`web/src/components/frp-import-dialog.tsx`）。生成配置已用真机验证可登录 `frp-top.com`。
- ⬜ **待做**：二进制按需下载（推翻「不下载二进制」旧约束，需固定版本 + SHA256 校验）、远程实例走 Agent 侧托管。
- ✅ **补充落地（2026-10-25 第二轮）**：sakura 模式能力探测（上游 frpc 的 `-f` 报错翻译成 `network.frp-sakura-needs-custom-build`）、状态三态/重连次数/上次退出码、设置页 8 秒轮询 + 刷新、暴露风险提前横幅。
- 完整设计、解析规则、测试与排期见 [frp-sakurafrp-onboarding.md](./frp-sakurafrp-onboarding.md)。

### 2. 家用 Linux 拓扑适配

| 拓扑 | 面板机 | 开服机 | 现状 | 需要什么 |
|---|---|---|---|---|
| A | 家里 Linux | 同一台 | ✅ 可用 | 文档补 systemd 自启示例（面板本身是纯 Node，浏览器访问） |
| B | Windows | 家里 Linux，同一局域网 | ✅ **已支持**（2026-10-19） | 代理条目带 `localIP`：本机 `127.0.0.1`，LAN 实例自动用服务器内网 IP |
| C | 在外 | 家里 Linux（NAT 后） | ❌ | 依赖上面的「Agent 侧 frpc」 |

- 家用出口若是公网 IPv6 → DDNS 同步 AAAA 即可；CGNAT 只能 frp；
- 面板与 Linux 不同 LAN 时，SSH 需要公网/内网穿透（Tailscale / ZeroTier 等）才能装 Agent；
- Linux 防火墙需放行 MC 端口与 frps `bindPort`。

## P1 — 安全与可靠性（1–2 周）

- **`data/config.json` 凭据加密**（路线图 P3-7）：SSH 密码、frp token、SMTP、AI key 目前明文。Windows 用 DPAPI，Linux 用 0600 密钥文件（可选口令）。
- **DDNS 真实服务商联调**：目前只有假 fetch 单测；用真实 Cloudflare/DNSPod zone 跑通 A/AAAA、变更检测、失败退避，并在 README 写可复现验收步骤。
- **备份增强**：按数量/天数保留、异地（WebDAV/S3）、恢复流程校验（能恢复比有备份更重要）。

## P2 — 产品价值（2–4 周）

- **指标历史**（路线图 P3-1）：玩家数 / 内存 / 在线时长按分钟聚合 + 图表，回答「昨晚为什么卡」。
- **整合包 / 服务端包导入**：拖 zip → 识别核心与版本 → 建实例，开服工具的高频刚需。
- **Windows 本地体验**：开机自启、托盘单实例、端口占用检测（`svchost`/portproxy 占 25565 这次就踩到了）、防火墙放行提示。

## 暂不做

- **浏览器 WebSocket 重写**（P2-1）：成本 4–5 天、风险高（重连 / 慢消费者 / 协议迁移）；当前 SSE + 轮询够用，等终端成为重度场景再说。
- **P4 领域深水区**（NBT / 地图编辑 / 物品栏）：偏离「开服运维工具」定位。
- **多用户 / 权限、多租户、云托管**：与「本地单管理员面板」的定位冲突。

## 已完成（2026-10-19）

- ✅ **`localIP` 支持**：代理条目带 `localIP`；实例页按服务器地址自动推导转发目标——本机 `127.0.0.1`，同一局域网（私有 IP）/主机名用服务器内网地址，公网 IP 仍拒绝（应由那台机器自己跑 frpc）。设置页的代理行格式扩展为 `名称,本地端口,远程端口[,tcp|udp[,转发地址]]`。

## 已完成（2026-10-25）

- ✅ **frp 安全闭环 + 面板交互体验方案已定型**（盘点与排期见本文 P0-1 与本轮计划）：暴露面板强制登录、配置收口、状态三态/轮询/日志抽屉、保存-重启联动、`restarts` 清零与日志轮转。
- ✅ **SakuraFrp 真机连通性验证**：`user` + `auth.token` + `transport.tls.enable=false` 配置下登录/隧道注册/端到端转发全部通过；同时定位「两种模式都接不上」的两个缺陷，详见 [frp-sakurafrp-onboarding.md](./frp-sakurafrp-onboarding.md) §1。

## 建议的下一步顺序

1. **SakuraFrp 最小修复**：`buildUpstreamToml` 加 `user`（半天，立刻让樱花「手动配置」可用）；
2. **frp 暴露强制登录 + 配置收口**（安全兜底）；
3. **樱花粘贴导入 + 客户端自动加载**（含推翻「不下载二进制」的护栏：固定版本 + SHA256）；
4. Agent 侧 frpc（远程/异地实例的通用解，与樱花引导的远程分支合并做）。

## 相关计划

- [面板更新强化计划（0.7.0 → 1.0.0）](./panel-update-hardening-plan.md)：发现层去 API 化、多源、Ed25519 签名、一键更新、pending/heartbeat 恢复；实施状态见文首。
- [面板更新健壮性盘点](./panel-update-robustness.md)：现状链路的 P0/P1/P2 问题与证据（P0-1 bridge 死路、P0-2 git 自锁等）。
