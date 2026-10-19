# 后续优化清单（2026-10-19 记录）

> 来源：frp / DDNS 合并后的一次方向讨论。排序原则：**先堵新功能带来的风险 → 再做产品价值 → 最后才碰架构**。
> 现状基线：面板与 Agent 0.5.4；DDNS（Cloudflare/DNSPod/DuckDNS/Callback）与 frp（SakuraFrp / 自建 frps + 单实例端口绑定）已合入 `main`。

## P0 — 立即（2–3 天）

### 1. frp 安全闭环

- **暴露面板前强制登录保护**：代理目标端口 = 面板端口且 `authEnabled=false` 时，拒绝保存/启动（或强警告 + 一键设密码）。frp 让「把面板交给公网」只差一个端口号。
- **frp 配置收口**：设置页只保留 server / token / 二进制路径；代理列表只由实例页维护，避免两处改同一份 `settings.frp.upstream.proxies` 互相覆盖。
- **远程 / 异地实例的 frp**：面板托管的 frpc 只能转发面板本机端口。正确做法是 **Agent 侧托管 frpc**（面板下发配置，Agent 在本机 spawn、回传日志与状态），实例页的「绑定端口」对远程实例才可用。
- **SakuraFrp 模式真机验证**：现在只做了参数托管（`-f token:ids -n`），需要用真实账号跑一次登录 + 隧道连通。

### 2. 家用 Linux 拓扑适配

| 拓扑 | 面板机 | 开服机 | 现状 | 需要什么 |
|---|---|---|---|---|
| A | 家里 Linux | 同一台 | ✅ 可用 | 文档补 systemd 自启示例（面板本身是纯 Node，浏览器访问） |
| B | Windows | 家里 Linux，同一局域网 | ⚠️ 差 `localIP` | 代理条目支持 `localIP`：本机仍 `127.0.0.1`，LAN 实例填服务器内网 IP |
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

## 建议的下一步顺序

1. `localIP` 支持（小改动，先让「Windows 面板 + 同 LAN Linux 开服机」可用）；
2. Agent 侧 frpc（远程/异地实例的通用解）；
3. frp 暴露强制登录 + 配置收口（安全兜底）。
