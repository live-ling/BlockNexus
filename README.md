# BlockNexus · Minecraft 服务器管理面板

开服到管服，一个网页搞定：本机运行面板，SSH 给远程 Linux 装 Agent，在浏览器里创建/启动/备份 Minecraft 实例、看控制台、管玩家。面板与 Agent 之间走 **token 双向认证 + AES-256-GCM 加密通道**，面板不需要公网地址。

> [完整功能说明](docs/features.md) · [部署指南](docs/deployment.md) · [开发文档](docs/development.md) · [后续规划](docs/next-optimization.md)

## 30 秒上手

**Windows（推荐）**

1. 从 [Releases](https://github.com/live-ling/BlockNexus/releases) 下载 `BlockNexus-<版本>-portable.zip`；
2. **解压到任意目录**（别在压缩包里直接运行），双击 `BlockNexus.exe`；
3. 浏览器打开 `http://127.0.0.1:3080` → 点「快速添加」→ 本机什么都不用填；远程填 IP + SSH 账号 → 等 1–3 分钟开服。

**从源码**

```bash
git clone https://github.com/live-ling/BlockNexus.git
cd BlockNexus && npm install && npm run build:web
node panel/server.js        # http://127.0.0.1:3080
```

默认**只监听本机、无密码**（本地服务，打开即用）。要对外访问，先开登录再 `--host 0.0.0.0`，具体见 [部署指南](docs/deployment.md)。

## 三种用法

| 场景 | 怎么装 | 面板 / MC |
|---|---|---|
| 家里 Windows 开服 | 便携包，双击即用 | 同一台 |
| 家里或云上的 Linux | 源码 + systemd（[示例](docs/deployment.md)） | 同一台 |
| 面板在本地、MC 在远程 Linux | 「快速添加」填 SSH，Agent 自动安装 | 面板本地 / MC 远程 |

局域网里的 Linux 开服机也支持：frp 转发目标会自动用它的内网 IP。

## 能做什么

- **一键开服**：装 Agent → 建实例 → 缺 Java 自动装 → 启动，进度实时可见；
- **实例管理**：启动/停止/重启、实时控制台、文件管理、Mod 启停、`server.properties` 可视化、插件配置；
- **玩家**：在线名单、在线时长、聊天记录、踢出/封禁/OP、封禁目录；
- **备份与定时**：手动/定时备份、自动重启、崩溃重启；
- **网络**：DDNS（Cloudflare/DNSPod/DuckDNS/Callback）+ frp 内网穿透（实例页直接绑公网端口）；
- **跨平台**：Windows 全静默托管（不弹 cmd）、Linux/Windows 双平台 Java 多版本管理；
- **省心**：Agent 自动升级、面板应用内更新（保留 `data/`）、邮件离线通知、AI 日志分析。

## 安全（务必看）

- 面板默认**无密码**，只监听 `127.0.0.1`；`--host 0.0.0.0` 前必须开启登录保护；
- 反代后必须加 `--trust-proxy`，否则登录限流会退化成全局限流；
- `data/config.json` 里的 SSH 密码、Agent/frp token 是**明文**，机器与备份要可信；
- 用 frp 把面板端口映射到公网前，确认登录保护已开。

完整清单见 [部署指南 · 安全清单](docs/deployment.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/features.md](docs/features.md) | 完整功能说明、面板设置、API 一览 |
| [docs/deployment.md](docs/deployment.md) | Windows / Linux / 远程 Agent / 反向代理 / AI 部署清单 |
| [docs/development.md](docs/development.md) | 加密通道、目录结构、前端/Agent 构建、测试、版本号 |
| [docs/blocknexus-current-state.md](docs/blocknexus-current-state.md) | 现状能力清单（实现细节） |
| [docs/next-optimization.md](docs/next-optimization.md) | 后续优化方向与优先级 |
| [AGENTS.md](AGENTS.md) | 给 AI/新会话的工作记忆与发版流程 |

## 许可证

MIT，见 [LICENSE](LICENSE)。
