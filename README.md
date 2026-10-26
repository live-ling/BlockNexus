# BlockNexus

一个用于管理 Minecraft 服务器的网页面板。支持一键开服、实例管理、玩家管理、备份与定时、网络穿透等完整功能。

## 功能特性

### 核心功能
- **一键开服**：自动安装 Agent → 创建实例 → 安装 Java → 启动服务器，进度实时可见
- **实例管理**：启动/停止/重启、实时控制台、文件管理、Mod 启停、`server.properties` 可视化编辑、插件配置
- **玩家管理**：在线名单、在线时长统计、聊天记录、踢出/封禁/OP、封禁目录
- **备份与定时**：手动/定时备份、自动重启、崩溃重启

### 网络功能
- **DDNS**：支持 Cloudflare、DNSPod、DuckDNS、Callback
- **frp 内网穿透**：实例页直接绑定公网端口

### 跨平台与运维
- **Windows 全静默托管**：不弹 cmd 窗口
- **Linux/Windows 双平台**：Java 多版本管理
- **自动升级**：Agent 自动升级、面板应用内更新（保留 `data/`）
- **离线通知**：邮件通知
- **AI 日志分析**：实例详情页 AI 分析

## 快速开始

### Windows（推荐）

1. 从 [Releases](https://github.com/live-ling/BlockNexus/releases) 下载 `BlockNexus-<版本>-portable.zip`
2. 解压到任意目录（不要在压缩包里直接运行）
3. 双击 `BlockNexus.exe`
4. 浏览器打开 `http://127.0.0.1:3080`

### 从源码运行

```bash
# 克隆项目
git clone https://github.com/live-ling/BlockNexus.git
cd BlockNexus

# 安装依赖并构建前端
npm install && npm run build:web

# 启动面板
node panel/server.js
# 访问 http://127.0.0.1:3080
```

## 使用模式

| 场景 | 部署方式 | 说明 |
|------|---------|------|
| 本地 Windows 开服 | 便携包，双击即用 | 面板与 MC 同一台机器 |
| 本地或云端 Linux | 源码 + systemd | 同机开服 |
| 面板本地、MC 远程 | 「快速添加」填 SSH | Agent 自动安装到远程 Linux |

## 项目结构

```
BlockNexus/
├── panel/           # 面板后端 (Node.js + Express)
│   ├── api.js       # REST API 路由
│   ├── agentlink.js # Agent 连接管理
│   ├── config.js    # 配置管理
│   ├── ddns.js      # DDNS 逻辑
│   ├── frp.js       # frp 内网穿透
│   └── server.js    # 主入口
├── agent/           # Agent 程序 (Node.js)
│   ├── src/         # 源代码
│   │   ├── agent.js # Agent 主逻辑
│   │   ├── instance/# 实例管理
│   │   ├── crypto.js# 加密模块
│   │   └── ws.js    # WebSocket 协议
│   └── build.js     # 打包脚本
├── web/             # 前端 (React + TypeScript + Vite)
│   ├── src/
│   │   ├── pages/   # 页面组件
│   │   ├── components/# UI 组件
│   │   └── lib/     # 工具库
│   └── package.json
├── scripts/         # 构建与工具脚本
│   └── tray/        # Windows 托盘程序 (C# + WebView2)
└── docs/            # 文档
```

## 安全说明

- 面板默认**无密码**，只监听 `127.0.0.1`（本地使用）
- 对外访问必须开启登录保护，使用 `--host 0.0.0.0` 前确认已配置认证
- 反向代理后必须加 `--trust-proxy`，否则登录限流会退化成全局限流
- `data/config.json` 中的 SSH 密码、Agent/frp token 为明文存储，确保机器与备份可信

## 文档

- [功能说明](docs/features.md)
- [部署指南](docs/deployment.md)
- [开发文档](docs/development.md)
- [后续规划](docs/next-optimization.md)

## 技术栈

- **前端**：React + TypeScript + Vite + Tailwind CSS
- **面板后端**：Node.js + Express
- **Agent**：Node.js（打包为单文件）
- **桌面壳**：C# + WebView2（Windows 托盘）
- **通信协议**：WebSocket + AES-256-GCM 加密

## 许可证

MIT License - 详见 [LICENSE](LICENSE)
