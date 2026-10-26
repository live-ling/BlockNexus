# 部署指南

> 面向「把这套装到某台机器上」的步骤。功能说明见 [features.md](features.md)，开发/构建见 [development.md](development.md)，
> 后续规划见 [iteration-roadmap.md](iteration-roadmap.md) 与 [next-optimization.md](next-optimization.md)。

## 先选形态

| 形态 | 适合 | 面板位置 | MC 位置 | 入口 |
|---|---|---|---|---|
| **A. Windows 便携包** | 家里 Windows 开服，零依赖 | 同一台 | 同一台 | 双击 `BlockNexus.exe` |
| **B. 源码 / Linux 服务** | 家里或云上的 Linux 主机 | 同一台 | 同一台 | `node panel/server.js` + systemd |
| **C. 面板 + 远程 Agent** | 面板在本地，MC 在远程 Linux | 本地 | 远程 | 快速添加里填 SSH |

> 家用 Linux 建议用 **B**（面板和 MC 同机），frp/DDNS 都在实例页直接可用；
> 「Windows 面板 + 局域网 Linux 开服机」也已支持（frp 转发目标用内网 IP），见下文 C-2。

---

## A. Windows 便携包（推荐给普通用户）

1. 从 [Releases](https://github.com/live-ling/BlockNexus/releases) 下载 `BlockNexus-<版本>-portable.zip`；
2. **解压到任意目录**再运行（不要在压缩包里直接双击），双击 `BlockNexus.exe`；
3. 浏览器自动/手动打开 `http://127.0.0.1:3080`，点「快速添加」。

- 数据全部在解压目录的 `data/`：拷走 `data/` 就是迁移，删除整个目录就是卸载；
- 托盘图标：左键打开应用，右键「打开应用 / 退出应用」；
- 升级：设置 →「版本与更新」应用内更新；或下载新便携包，**保留旧 `data/`** 覆盖程序文件；
- **Defender**：`frpc` 常被判定为 HackTool，需要把 `data\frp\bin` 加入排除列表；
- 端口被占（如 25565）：先查 `netsh interface portproxy show all` 与 `Get-NetTCPConnection -LocalPort 25565`。

## B. 源码运行（Windows / Linux）

要求 **Node.js >= 18**（Linux 另需 `git`、`curl`；Agent 安装还需要 `systemd` 与 root/sudo）。

```bash
git clone https://github.com/live-ling/BlockNexus.git
cd BlockNexus
npm install
npm run build:web        # 首次必须构建前端，产物在 web/dist
node panel/server.js     # 默认 127.0.0.1:3080
```

常用参数（括号内为等价环境变量）：

| 参数 | 用途 |
|---|---|
| `--port`（`BLOCKNEXUS_PORT`） | 面板端口，默认 3080 |
| `--host`（`BLOCKNEXUS_HOST`） | 监听地址；默认 `127.0.0.1`，对外才用 `0.0.0.0` |
| `--tls-cert` / `--tls-key` | 面板自身 HTTPS |
| `--trust-proxy <层数\|loopback>` | 反代后必须设置，否则限流退化 |
| `--secure-cookies` | 反代终止 TLS、面板自身 HTTP 时使用 |

**默认无密码**（只监听本机）。对外监听前必须开启登录：设置页开启，或启动时给
`BLOCKNEXUS_USERNAME` / `BLOCKNEXUS_PASSWORD`。

### Linux + systemd（同机开服）

```ini
# /etc/systemd/system/blocknexus.service
[Unit]
Description=BlockNexus panel
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/blocknexus
# 用包装脚本：面板内更新期间它会等 data/update/in-progress 消失，避免
# systemd 在「面板已退、文件还没换完」时把旧版/半成品拉起来。
ExecStart=/opt/blocknexus/scripts/start-panel.sh --host 127.0.0.1
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
chmod +x /opt/blocknexus/scripts/start-panel.sh
sudo systemctl daemon-reload
sudo systemctl enable --now blocknexus
curl -s http://127.0.0.1:3080/api/me      # 验证
```

- 远程访问建议 **SSH 隧道**：`ssh -L 3080:127.0.0.1:3080 user@host`，比直接对外安全；
- 需要局域网访问才 `--host 0.0.0.0`，并先开登录；
- 升级：`git pull && npm ci && npm run build:web && sudo systemctl restart blocknexus`
  （`git-clean` 形态也可用面板内应用内更新）。
- **不用包装脚本时**：把 `ExecStart` 写成 `/usr/bin/node /opt/blocknexus/panel/server.js ...` 也能跑，
  但 `Restart=always` 会和更新器抢时间——可能表现为「等待面板退出超时」或更新后回滚。
  这种情况下建议至少把 `Restart` 改成 `on-failure`，并知道更新器会自己拉起面板（不再由 systemd 托管）。

## C. 面板 + 远程 Linux Agent

### C-1. 面板在本地、MC 在公网/远程 Linux

1. 远程机准备：SSH 可达、root/sudo、systemd、能联网装 Node（面板会代装）；
2. 面板「快速添加」填：主机/IP、SSH 端口、用户、密码或私钥；
3. 端口方向（默认「面板连 Agent」）：Agent 监听 `3099`，需要**面板能连到远程 3099**（安全组/防火墙放行）；
   若面板在 NAT 后，改用「Agent 连面板」并填远程机能访问到的面板地址；
4. 装完 Agent 后再建实例、装 Java、启动。

### C-2. Windows 面板 + 同一局域网的 Linux 开服机

- 快速添加里填 Linux 的内网 IP（如 `192.168.1.50`）+ SSH 账号；
- 实例页的 frp 绑定会自动把转发目标设为 `192.168.1.50`（`localIP`），前提是面板能直连该地址；
- 公网 IP 的远程实例不走面板 frpc：那台机器应自己跑 `frpc`（后续会支持 Agent 侧 frpc）。

---

## 反向代理与 HTTPS（重要）

面板交给 Nginx 时**必须**加 `--trust-proxy`，否则 `req.ip` 恒为代理地址，登录限流会变成全局限流：

```nginx
location / {
  proxy_pass http://127.0.0.1:3080;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  # SSE（/api/events）必须关缓冲，否则实时事件会攒着不发
  proxy_buffering off;
  proxy_read_timeout 3600s;
}
```

```bash
node panel/server.js --host 127.0.0.1 --trust-proxy 1 --secure-cookies
```

- 反代还有一层（CDN → Nginx）用 `--trust-proxy 2`；只信任本机代理可用 `--trust-proxy loopback`；
- 面板直连公网时**绝不能**开 `--trust-proxy`（`X-Forwarded-For` 可伪造）；
- 纯 HTTP 下不要开 `--secure-cookies`（浏览器不保存 Secure Cookie，表现为登录后立刻掉线）。

---

## 安全清单（部署后逐项确认）

1. **对外必须开登录**：`--host 0.0.0.0` 且无密码 = 任何人可接管面板（装 Agent、读写服务器文件）；
2. `data/config.json` 含 SSH 密码/私钥、Agent token、frp token、SMTP/AI 密钥（**明文**）：
   文件权限收紧到 600，机器本身要可信；
3. 反代必须 `--trust-proxy`，否则限流可被一个人打满；
4. 用 frp 把面板端口映射到公网前，**先确认登录保护已开**；
5. Agent 以 root/systemd 默认身份运行，MC 实例共享该权限；
6. 聊天记录与玩家统计是明文隐私数据（`<实例>/.blocknexus-data/`，0700/0600），注意备份去向；
7. 备份文件可能包含存档与配置，异地存放时自行加密。

---

## 给 AI 的部署清单（可直接照做）

**目标**：在目标机跑起面板（以及可选 Agent），并用 `curl` 证明可用。

### 1. 前置检查

```bash
node -v && npm -v && git --version
# Linux 额外
systemctl --version | head -1; ss -ltn | head; command -v curl
```

### 2. 安装（Linux 同机）

```bash
git clone https://github.com/live-ling/BlockNexus.git /opt/blocknexus
cd /opt/blocknexus
npm ci || npm install
npm run build:web
# 写 systemd unit（见上文 B）→ daemon-reload → enable --now
```

### 3. 验证（必须做，不要只看进程在跑）

```bash
curl -s http://127.0.0.1:3080/api/me          # 期望 JSON：port / authEnabled / version
ss -ltn | grep 3080                            # 期望监听地址符合预期
tail -n 40 <安装目录>/data/panel.log           # 启动横幅、迁移、错误
```

### 4. 常见坑（按优先级）

- **Windows Defender 拦 frpc**：把 `data\frp\bin` 加排除，否则 frp 启动即失败；
- **25565 被占**：`netsh interface portproxy show all`、`Get-NetTCPConnection -LocalPort 25565`，
  常见元凶是 `svchost`（IP Helper/portproxy）或另一个 MC；
- **`%TEMP%` 不可写**：Agent 0.5.3+ 已把 JVM 临时目录指到实例 `.tmp`，旧 Agent 会报
  `Can't create cache file!`；
- **端口方向**：面板默认只监听 127.0.0.1；Agent 默认 3099；frps 默认 7000；frp 远端端口需在云安全组放行；
- **Node 版本**：< 18 会直接起不来；Windows 上 `node` 不是内置命令，脚本里用绝对路径；
- **数据目录**：`data/` 不要进 git、不要打进发布包（凭据明文）；迁移只拷 `data/`。

### 5. 禁止 / 回滚

- 不要 `--host 0.0.0.0` 且无密码对外；不要 `git push --force`；不要提交 `data/`；
- 回滚：便携包保留旧目录即可；源码 `git checkout <上个 tag> && npm ci && npm run build:web`；
  数据回滚用 `data/update/backup/` 或自己的 `data/` 备份。
