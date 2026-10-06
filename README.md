# BlockNexus · Minecraft 服务器管理面板

一站式 Minecraft 服务器管理平台：本地运行一个 Web 面板，通过 SSH 为远程服务器安装 Agent，在网页上创建和管理 Minecraft 实例（创建/服务端下载/启动/停止/控制台/文件/Mod/玩家/备份/自动重启），面板与 Agent 之间走 **token 双向认证的加密通道**。

```
┌────────────────────────────────┐                        ┌─────────────────────────────────┐
│ 本地电脑（可在 NAT 后）        │ SSH(安装/重装)       │ 远程 Linux 服务器（公网）       │
│                                │ scp agent.js         │                                 │
│ 面板 (Node 进程)               │ + systemd 托管       │ blocknexus-agent (Node)         │
│ · HTTP :3080                   │                      │ · 监听端口 :3099                │
│ · Web UI (SPA)                 │ ─── WS 主动连入 ──→  │ · MC 实例管理                   │
│ · AgentHub 加密通道            │ token 双向认证       │ · java 进程托管                 │
│ 浏览器 → http://127.0.0.1:3080 │ AES-256-GCM 帧       │ · 控制台/事件上报               │
│                                │                      │ /opt/blocknexus-agent/instances │
└────────────────────────────────┘                       └─────────────────────────────────┘
```

**连接方向**（默认「面板连接 Agent」）：Agent 在公网服务器上监听端口，本地面板作为客户端主动连入并用 token 认证——因此**面板不需要公网地址**，在家用网络/NAT 后也能管。若你的情况相反（服务器在 NAT 后、面板有公网地址），可在添加服务器时切换为「Agent 连接面板」。

**TLS（wss）**：添加/编辑服务器时可勾选「使用 TLS 加密（wss）」。安装 Agent 时面板会用服务器上的 `openssl` 生成自签证书（`/opt/blocknexus-agent/cert.pem`、`key.pem`），并记录证书的 **SHA-256 指纹**；之后每次连接都比对指纹，不匹配立即断开——因此自签场景下依然能防中间人。应用层本来就有 token 双向认证 + AES-256-GCM，这层 TLS 主要用于隐藏传输元数据（端口扫描只能看到 TLS 流量）。

## 快速开始

**方式一：便携版（推荐，无需 Node.js）**——从 [Releases](https://github.com/live-ling/BlockNexus/releases) 下载 `BlockNexus-<版本>-portable.zip`，解压到任意目录双击 `BlockNexus.exe` 即用（内置 Node 运行时、依赖与前端；数据保存在解压目录的 `data/` 下，删除目录即完全卸载）。

**方式二：从源码运行**——要求本机 Node.js >= 18。

```bash
npm install
npm run build:web   # 首次运行前构建前端（产物在 web/dist，面板直接托管）
npm start           # 或 node panel/server.js
```

**监听范围**：面板默认只监听 `127.0.0.1`（本地服务，不对局域网/公网暴露）。确实需要从其他机器访问时才显式放开：

```bash
node panel/server.js --host 0.0.0.0                  # 对外监听（此时必须开启登录保护）
node panel/server.js --host 0.0.0.0   --tls-cert cert.pem --tls-key key.pem              # 顺带面板自身走 HTTPS
# 等价的参数/环境变量：--port / BLOCKNEXUS_PORT，--host / BLOCKNEXUS_HOST，--tls-cert / BLOCKNEXUS_TLS_CERT，--tls-key / BLOCKNEXUS_TLS_KEY
# 反向代理后：--trust-proxy 1（可信代理层数）；面板自身是 HTTP 但外部走 HTTPS 时再加 --secure-cookies
```

**默认无密码**（本地服务，打开即用；此时顶栏不显示「退出登录」）。如需暴露给局域网/公网，可在面板右上角「设置」中开启登录保护：

- **用户名 + 密码**双重校验（用户名默认 `admin`，可自定义为 3–40 位字母数字与 `_ . @ -`；密码至少 6 位）；两者都用定长摘要做定时安全比较，避免时序/长度泄露；
- **失败限流**：同一来源连续失败 5 次锁定 5 分钟，锁定期内即使密码正确也会被拒（提示剩余秒数）；成功登录即清零计数；开关仅存在于面板进程内存中；
- 开关登录时会自动为当前浏览器发放会话（无需重新登录），关闭后立即恢复免密访问；
- 也可用环境变量启动强制开启：`BLOCKNEXUS_PASSWORD=<密码> BLOCKNEXUS_USERNAME=<用户名> npm start`。

> 内存推荐：新建实例时「最大内存」下拉的首项 **X（推荐）** 会按服务器物理内存自动计算（一半、向下对齐 512MB、上限 8GB）并默认选中，也可选预设值或「自定义…」精确填写 MB。

控制台会打印面板地址与**初始管理密码**（也可用环境变量 `BLOCKNEXUS_PASSWORD` 指定），浏览器打开 `http://127.0.0.1:3080` 登录。

### 添加服务器并安装 Agent

1. 首页点「+ 添加服务器」，填写 SSH 主机/端口/用户（建议 root）/密码或私钥；
2. 选择**连接方式**：
   - **面板连接 Agent**（默认、推荐）：Agent 在服务器上监听 `3099` 端口，面板主动连入。只需确保服务器安全组/防火墙放行该端口（TCP），**面板无需公网地址**；
   - **Agent 连接面板**：由 Agent 反向回连，需要在「面板地址」里填服务器能访问到的面板地址（公网 IP / frp / Tailscale）；
3. 进入服务器详情页点「安装 Agent（SSH）」——面板会自动：检测/安装 Node.js → 上传 `agent.js` → 写入 token 与监听端口 → 注册 `systemd` 服务（`blocknexus-agent`）→ 建立加密通道（面板侧会主动重试，断线每 3–30 秒退避重连）；

   > 本机服务器（host 为 `127.0.0.1`）不需要这一步：面板会直接在本机拉起 Agent，详见下文「本机服务器」。
4. 上线后即可「+ 新建实例」：选版本（自动拉取 Mojang 版本清单）、端口、内存、MOTD、离线模式，勾选 EULA 后创建，Agent 自动下载 `server.jar`（进度实时显示）。

如果服务器上没有 Java，详情页会出现「安装 Java」按钮（apt/dnf/yum/apk 自动选择 JDK 17/21）。

### Agent 版本与自动更新

Agent 会在上线信息（`hi`）中带上自身脚本版本；面板每次收到都会与**随面板分发的 agent.js 版本**比对，不一致时自动更新：

- **SSH 服务器**：上传新 `agent.js`（先落 `.new` 再原子改名）并 `systemctl restart blocknexus-agent`——token、TLS 证书、实例数据全部不动，通常几秒内以新版本回连；
- **本机 Agent**：面板直接重启本机 Agent 进程；
- **失败退避**：更新失败会提示原因，并在 10 分钟内不再自动重试；同一台连续失败 3 次后停止自动尝试，转为服务器设置页「系统信息」卡里的「立即更新」按钮手动触发（需要 SSH 凭据可用）。

服务器设置页「系统信息」始终显示远端 Agent 版本；落后时出现琥珀色提示条与更新进度。因此**升级面板后不需要手动重装 Agent**，旧版 Agent 首次上线即自动对齐。

### 本机服务器（host 填 127.0.0.1 / localhost）

面板发现某台服务器的 host 指向本机时，**不走 SSH、也不用 systemd**——面板直接在本机拉起/停止 `agent.js` 进程，服务器设置页会显示「本机 Agent」并给出进程 pid 与目录：

- **专用目录**：每台本机服务器一个隔离目录 `data/local-agents/<服务器ID>/`，其下 `instances/` 放 MC 实例、`agent.json` 放连接配置、`agent.log` 放日志；
- **启停**：设置页的「启动 Agent / 停止 Agent」只管进程，实例与存档**始终保留**，可随时再启动（面板会自动重连）；
- **安装/重装**：重建 `agent.json` 并拉起进程；若目标端口已被占用会直接报错，不会悄悄失败；
- **卸载**：默认只停进程、**保留实例数据**；勾选「同时删除专用目录」才清理。删的只是 `data/local-agents/<id>`，不会碰到项目源码（`agent/agent.js`）；
- 停止时若 Agent 在线，会先让 Agent 优雅停 MC 实例（`stop` 指令，超时才强杀），避免 java 变孤儿进程；Agent 进程本身先 `taskkill /PID`（Windows）等优雅退出，超时再 `/T /F` 杀进程树。

> 面板 own 的进程是 detached 的，面板退出后 Agent 仍存活；要彻底停止请用面板上的「停止 Agent / 卸载」，或 `npm stop`。

### 手动安装 Agent（备用）

SSH 自动安装失败或不想给面板 SSH 权限时，在服务器上手动执行（详情页「手动安装」弹窗里有带 token 的完整命令）：

```bash
curl -fsSL http://<面板地址>:3080/agent.js -o agent.js
node agent.js --panel ws://<面板地址>:3080 --token <服务器token> --id <服务器ID>
```

Agent 参数也可写入同目录 `agent.json`：`{ "panel": "...", "token": "...", "id": "..." }`。

## 从 MCPan 更名升级（兼容期已结束）

项目已由 **MCPan** 更名为 **BlockNexus**：品牌字符串、安装目录（`/opt/mcpan-agent` → `/opt/blocknexus-agent`）、systemd 服务名（`mcpan-agent` → `blocknexus-agent`）、环境变量前缀（`MCPAN_*` → `BLOCKNEXUS_*`）、登录 Cookie、上传临时文件后缀均已同步。

> ⚠️ **更名兼容期已于 0.3.1 结束。** 加密通道的握手标识已从 `mcpan/*` 改为 `blocknexus/*`，
> 因此**旧版 MCPan/BlockNexus Agent（`AGENT_VERSION` < 0.3.6）无法再与本面板建立加密连接**。
> 面板会把这类 Agent 显示为离线，并在其上线后按版本号**自动推送更新**（见「Agent 版本与自动更新」）。
>
> 若某台服务器长期未上线导致没能自动更新，请在该服务器的设置页点「重装 Agent」重装一次。

迁移要点：

- **面板**：重启即生效（`data/config.json` 与实例数据不受影响）；
- **远程 Agent**：需更新到 `AGENT_VERSION ≥ 0.3.6`。通常由面板自动完成；无法自动更新时手动重装一次；
- **实例元数据**：`mcpan.json` → `blocknexus.json`。0.3.6 起已移除自动改名回退，
  **若仍有实例目录停留在旧文件名，需手动把 `mcpan.json` 改名为 `blocknexus.json`**；
- **需要重新登录/选主题**：会话 Cookie 名与主题存储键随更名更换，更新后首次打开需重新登录、主题恢复默认；
- **Windows 桌面外壳**：运行 `npm run build:exe` 生成 `BlockNexus.exe`，再 `npm run shortcut` 重建桌面快捷方式（旧 `MCPan.exe`、`MCPan.lnk` 可删除）。

## 加密通道设计

- 每台服务器一个随机 256-bit token（只存面板 `data/config.json` 与远程 `agent.json`，**不随网络传输**）；
- **双向认证握手**：连接发起方发 `hello`（身份 + 随机 nonce）→ 对端回 `challenge`（自己的 nonce）→ 发起方提交 `HMAC(kProof,'auth1'||nonceC||nonceS)` 证明持有 token → 对端校验后再回 `HMAC(kProof,'auth2'||…)`，**双方都验证对方持有 token**（含时钟偏差检查）。因此无论哪个方向发起，未持有 token 的一方都无法建立通道：Agent 会拒绝伪造的面板，面板也会拒绝伪造的 Agent；
- 会话密钥由 `HKDF-SHA256(token, nonceC||nonceS)` 派生，两个方向独立（`kA2P` / `kP2A`）；
- 之后所有帧为二进制 `[版本|nonce前缀|计数器|AES-256-GCM 密文+tag]`，计数器严格单调递增防重放；
- 握手与数据都不暴露 token，被动窃听拿不到明文；
- 可选 TLS 传输层：`wss://` + 自签证书 + **指纹固定**（面板只信任安装时记录的那张证书）。

**已知限制**（诚实说明）：该设计防被动窃听与伪造，但不能防御主动中间人（MITM 可以转发握手）。公网部署建议在面板前加 HTTPS 反向代理，或通过 SSH 隧道访问面板端口。

## 目录结构

```
web/           前端（Vite + React 19 + TypeScript + Tailwind 4）
  src/pages/   登录 / 服务器列表 / 服务器详情 / 实例详情 / 面板设置 / 关于
  src/lib/     API 客户端、history 路由、SSE 事件总线、toast 封装、安装日志 store
  src/components/ui/        shadcn/ui 组件（CLI 生成）
  src/components/motion/    beUI 动效组件（操作条 / BottomSheet / Toast / 徽章 / TiltCard / 主题切换）
  src/components/agents/    beUI agents 组件（AI 对话：PromptInput / MessageScroller / StreamingResponse 等）
  src/components/          业务组件（文件管理器 / Mod 管理 / 封禁目录 / 备份 / 控制台等）
panel/
  server.js     面板入口（HTTP + 静态资源 + SPA 回退 + Agent WS 升级路由）
  config.js     data/config.json 持久化（服务器/SSH/token/登录密码）
  crypto.js     HKDF / 握手证明 / AES-256-GCM 帧加解密
  agentlink.js  AgentHub：握手状态机、在线连接表、加密请求路由、事件转发
  ssh.js        SSH 安装器（远程 Linux：Node 检测安装、SFTP 上传、systemd 注册、Agent 热更新）
  localagent.js 本机 Agent 托管（面板直接 spawn/stop 进程 + 专用目录，免 SSH/systemd）
  api.js        REST API（登录、服务器 CRUD、安装、实例操作）+ SSE 实时推送
  mail.js       邮件模板（HTML 卡片样式 + 纯文本兜底）
agent/
  agent.js      零依赖单文件 Agent（自带 RFC6455 WebSocket 客户端 + 同套加密实现）——**由 build.js 生成，勿直接编辑**
  build.js      打包器：把 src/** 拼成上面的单文件产物（`npm run build:agent`；`--check` 只校验是否同步）
  src/          Agent 源码，按功能组分模块（config/crypto/ws/http/catalog/util + instance/**）
data/           运行时数据（config.json、本地测试实例），已 gitignore
```

Agent 是「源码分模块 + 打包成单文件」：交付物仍是单文件（SSH 只上传一个文件、systemd 直接跑它、面板 `/agent.js` 匿名下载、手动 `curl -o agent.js` 安装都依赖这一点），所以改完源码必须重新打包：

```bash
npm run build:agent   # 重新生成 agent/agent.js
npm run test:agent    # 全部 Agent 测试（含产物新鲜度校验：忘打包会直接失败）
```

## 前端开发

前端基于 [shadcn/ui](https://ui.shadcn.com/)（nova 预设，Radix 底座）+ [beUI](https://beui.dev/)（shadcn registry 体系的 Motion 动效组件），React 19 + Tailwind 4 + Vite：

```bash
npm run build:web    # 构建前端到 web/dist（面板托管的就是这份产物）
cd web && npm run dev   # 开发模式（/api、/agent.js 自动代理到面板 :3080）
```

beUI 组件用法：`cd web && npx shadcn@latest add @beui/<name>`（已装：bottom-sheet、animated-toast-stack、animated-badge、tilt-card、theme-toggle、text-reveal、file-tree、file-upload）。

## 文件管理

实例卡片上的「文件」按钮打开文件管理器（右下角图标说明：文本/压缩包/图片有区分图标）：

- **目录树**（beUI FileTree）：文件夹懒加载，键盘方向键可导航；
- **文本预览与编辑**：`.properties/.txt/.log/.json/.yml` 等直接在网页编辑保存（≤512KB，二进制文件拒绝预览）；
- **上传**（beUI FileUpload）：拖拽或多选，队列显示实时进度（带百分比）、失败可重试。传输通道二选一：
  - **加密通道**（默认）：512KB 分块经面板↔Agent 加密通道传输（单文件上限 200MB）；分块失败自动重试，并支持**断点续传**——Agent 侧保留 `<文件>.blocknexus-upload` 半成品（带大小+修改时间指纹，防止同名不同文件误续传），网络抖动或页面刷新后点「重试」只补剩余字节；Agent 重启后也能按磁盘半成品续传（半块按 512KB 对齐截掉）；
  - **SFTP 直传**：面板用保存的 SSH 凭据把文件流直写到实例目录（自动逐级建目录），**无 200MB 上限**。需要该服务器配置过 SSH 凭据，且 Agent 至少上线过一次（面板要知道实例目录）。
- **多选批量操作**：每行有复选框（也可点工具栏最左的按钮全选/取消当前目录），勾选后复制/剪切/删除/压缩/下载都按勾选集批量执行；无勾选时回退到单选中的那一项。剪切粘贴一次可移动多项，部分失败会逐项提示；
- **下载 / 删除 / 新建文件夹 / 重命名**：下载由面板从 Agent 分块拉取后流式回传浏览器（支持多选批量下载）；
- **复制 / 剪切 / 粘贴（= 移动）**：选中后点复制或剪切，切换到目标目录点粘贴。目标目录已有同名文件时自动加 " (n)" 后缀，**绝不静默覆盖**；Agent 端移动遇跨文件系统（EXDEV）自动退回复制+删除；
- **压缩 / 解压**：压缩选中项为 `.tar.gz`（系统 tar：Windows 自带 bsdtar、Linux GNU tar，并显式锁定 Windows 的 System32 tar 以避开 Git Bash/MSYS 环境里 GNU tar 把 `C:\` 当远程主机的问题）；解压支持 `.zip / .tar.gz / .tgz / .tar` 到压缩包所在目录（解压前有确认提示，同名覆盖；Linux 上 zip 优先 `unzip`、缺失时退回 `bsdtar`）。压缩/解压在面板侧放宽到 180 秒超时，大存档也能处理。

安全边界：所有文件操作锁定在该实例目录内（`path.resolve` 前缀校验），实例根目录不可复制/移动/删除，目标路径落入源目录内部（递归环）会被拒绝；SSH 凭据与 token 仍按 `data/config.json` 的说明保管。

## 页面结构

前端为 **history 路由**（`/settings`、`/server/...` 等路径可直接访问与刷新；旧 `#/settings` 形式的链接进入时自动迁移）：

```
/                               服务器列表（卡片显示 Agent 状态、系统信息、内存/磁盘占用）
/settings                       面板设置（登录保护 / 公网域名 / SMTP / 通知 / AI / 版本与更新 / 关于入口）
/about                          关于页（版本信息、开源地址与许可证、引用服务、开源依赖、声明），设置页底部进入
/reset?token=…                  重置密码（邮件链接直达）
/server/<id>                    服务器详情：MC 实例列表（卡片：状态、备注、版本/内存、
                                在线玩家 X/Y、运行时间、IP+连接地址，仅「启动/停止」按钮）
/server/<id>/instance/<名称>     实例详情（全屏，不显示顶部导航）：左侧实例信息 + 大号控件，
                                中间常驻终端（实时日志 + 指令输入，滚动条隐藏），
                                右侧在线玩家名单（运行时，底部有「封禁目录」入口）
/server/<id>/settings           服务器设置：安装/重装 Agent、手动安装、系统信息（含 Agent 版本）、
                                编辑服务器、查看 Token、删除服务器
```

实例列表卡片点击进入实例详情页；服务器级操作全部收在「服务器设置」页，不在列表页出现。

## 实例管理能力

实例详情页承载全部单实例操作，按钮区包括：

- **启动 / 停止 / 重启**：状态徽章区分 运行中 / 启动中（等待 `Done (x.xxx)s!` 就绪信号，最长 300 秒兜底）/ 已停止 / 下载中 / 安装失败；
- **终端**：实时日志（按级别着色：ERROR 红、WARN 黄、就绪行绿、DEBUG/TRACE 灰、异常堆栈淡红）+ 底部指令输入框（自增高、↑↓ 翻 200 条历史、Enter 发送、Shift+Enter 换行）；
- **AI 分析**：与终端同区域切换，见下文「AI 日志分析」；
- **文件**：完整文件管理器（见下文「文件管理」）；
- **Mod 管理**：实例 `mods` 目录的列表（大小/时间/启用状态）、**启用与禁用**（原地改名加/去 `.disabled`，不删文件，重启生效）、删除（需确认）、上传（多选 `.jar`，带进度；目录不存在时上传自动创建）。非 Forge/Fabric 实例会提示未发现 mods 目录；
- **备份**：tar.gz 完整快照，支持创建/列表/下载/恢复/删除；
- **配置设置**：server.properties 可视化编辑（见下文）；
- **自动重启**：崩溃重启 + 定时重启（见下文）；
- **编辑**：备注、连接地址/域名、最大内存，以及 **server-icon 图标**（见下）；
- **服务器图标（server-icon）**：在「编辑」里上传任意图片，内置**本地裁切**——图片完整显示，按住左键拖出正方形选区（选区内拖动=移动，滑杆调大小），确认后压缩为 **64×64 PNG** 写入实例目录；游戏内服务器列表重启后生效；
- **面板代下**：网络受限服务器安装失败时由面板下载核心后推送（见「实例备份与核心来源」）。

## 玩家管理

- **在线玩家栏**（实例运行中显示）：实时名单（SLP + 控制台跟踪合并），每个玩家一个快捷菜单：
  - **踢出** / **封禁** / **封禁其 IP**：统一弹确认框，可填**原因**（随指令下发给服务端）；
  - **设为管理员** / **取消管理员**（op / deop）；
- **封禁目录**（在线玩家栏底部按钮）：读取 `banned-players.json` / `banned-ips.json`，展示封禁玩家与封禁 IP 的名称、理由、来源、日期与期限（永久显示「永久」），每条可一键**解封**——实例运行中走控制台 `pardon` / `pardon-ip`（内存中的封禁表才是真相源），实例停止时直接修改 JSON 文件。

## 域名连通检测

设置了「连接地址/域名」的实例，信息卡里会显示连通状态（**仅实例运行中检测**；未启动时提示「实例未启动，暂不检测域名连通」，避免必然失败的探测）：

- 解析顺序：`_minecraft._tcp.<域名>` **SRV 记录**（命中则用其目标与端口，结果显示 `· SRV`）→ A/AAAA 记录 → 实例端口；
- 对解析出的 IP 做 3 秒超时的 TCP 探测，显示 `✓ IP:端口 · TCP 延迟`（绿色）或失败原因（红色，可换行完整显示）；
- 域名可带端口（`play.example.com:25565`），协议头会被自动清理；右侧地球按钮可手动重新检测。

## 在线人数与玩家名单

面板通过 Agent 用 **Minecraft 服务器列表协议（SLP，Server List Ping）** 直接查询实例端口（纯 Node 标准库实现，无第三方依赖），拿到实时 `在线人数 / 上限`（上限也可从 `server.properties` 的 `max-players` 兜底）：
- 实例列表页与详情页每 20 秒刷新一次，运行中显示绿色 `玩家：3/20`；
- 实例详情页右侧有**在线玩家名单**栏（仅实例运行时出现，避免压缩终端宽度），点开即可看到当前在线的玩家名；
- 名单来源双保险：优先用 SLP 状态响应里的 `players.sample` 并与 **Agent 侧控制台跟踪**合并去重（原版 `sample` 上限 12 条、开启 `hide-online-players` 时为空）——跟踪从日志里的 `Steve joined the game` / `left the game` / `lost connection` 实时维护玩家集合，不向控制台注入任何命令；玩家在控制台执行 `list` 时也会同步校准名单；
- 查询地址依次尝试 `server.properties` 的 `server-ip`（服务端只绑定指定网卡时回环连不上）与 `127.0.0.1`；查询用的是**本次启动实际监听的端口**（改 `server-port` 未重启时不会查错端口）；
- SLP 完全不通时（如 `enable-status=false`）自动退回控制台跟踪结果；SLP 实测 0 人时会清空跟踪集，杜绝过期鬼影；
- 服务器启动中的短暂窗口会优雅降级为 `—/20`，不会拖慢接口（单实例查询 1.5 秒硬超时）。

## Java 环境（多版本管理）

服务器设置页独立的「Java 环境」卡：多版本的 **安装 / 切换 / 卸载**（服务器设置页在 Agent 卡与系统信息卡之间；实例详情页侧栏保留快捷入口）：

- **版本可选**：`Java 25（最新）` / `Java 21（推荐 · 1.20.5+）` / `Java 17（1.17 – 1.20.4）` / `Java 11（旧版备用）` / `Java 8（MC ≤ 1.16）`，旧版到最新全覆盖；
- **统一走 Temurin JRE**：优先清华 TUNA 镜像（国内快），失败再走 Adoptium 官方 API；每个版本独立目录落位 `/opt/blocknexus-java/jdk-*/`，互不覆盖；
- **完整安装列表 + 勾选生效**：卡片列出全部可用 Java（面板装的 Temurin 各版本 + 系统包 Java `/usr/bin/java`），点选即切换默认版本（`/usr/local/bin/java` 软链重指，Agent 立即重探测），选中行高亮「使用中」；
- **卸载**：托管版本可单独卸载（永久删除该版本目录）；卸载正在使用的版本会自动回退到其余版本或系统 Java，唯一可用时拒绝卸载；也可一键「改用系统包 Java」摘除面板的软链；
- **异步任务**：安装点击后面板立即返回，过程与结果实时推送（下载百分比、解压、链接每一步都显示）；
- 启动实例不再按 Java 版本硬性拦截——选错版本时服务端会自行报错，日志在控制台可见。

## 卸载 Agent

服务器设置页「Agent」卡片右上角的「卸载」按钮（红色描边）：

1. **优雅收尾**（Agent 在线时）：先逐个停止运行中的实例；勾选「卸载前把实例备份打包到安装目录之外」时，会把 `.backups` 打成 `blocknexus-backups-<时间戳>.tar.gz` 放到**安装目录的上一级**（默认即 `/opt/blocknexus-backups-*.tar.gz`，不会随安装目录一起被删），并把 `.backups` 移出实例目录；
2. **SSH 卸载**：停止并禁用 systemd 服务 `blocknexus-agent`、删除单元文件、`rm -rf` 安装目录（**递归删除全部实例与存档**）；
3. 可选「同时从面板移除该服务器」（不勾选则保留记录、Agent 显示离线，可随时重装）。

全程日志通过 SSE 实时显示在对话框里；执行失败会把错误写明（例如 SSH 连不上），且**不会**清空面板已缓存的系统信息。Agent 离线时也能卸载（跳过第 1 步，运行中的实例会随进程结束）。

## 配置设置（server.properties 可视化编辑）

实例详情页「配置设置」按钮：

- **中文映射表单**：内置约 50 个常用键的中文标签与控件类型（布尔=开关、枚举=下拉含中文选项、数值=输入框），按 `基础 / 玩法 / 世界 / 性能 / 网络 / 其他` 分组，并附简短说明（如「正版验证：关闭后未登录账号也能进入」）；
- **只改值、不动结构**：保存时保留注释、键顺序与未识别的键（实测行数不变、`#Minecraft server properties` 注释头保留）；未映射的键会在底部列出，需要时切到「原始文本」整文件编辑；
- **面板同步**：保存后自动把 `server-port / motd / online-mode` 同步到面板元信息（连接地址、玩家数上限、列表 MOTD 随之更新）；
- **安全校验**：Agent 端逐行校验必须是 `key=value`，非法内容直接拒绝并指出错误行；内容上限 256KB；
- **生效提示**：实例运行中时按钮变为「保存并重启」（一键保存后重启生效），否则为「保存」。

## 插件配置可视化

实例详情页「插件配置」按钮（实例目录存在 `plugins/` 或 `config/` 时显示，原版实例不出现）：

- **自动发现**：扫描 `plugins/`（含各插件子目录第一层）、`config/`（Fabric/NeoForge 数据目录）与根目录常见配置（bukkit.yml、spigot.yml、whitelist.json、*.toml 等），按来源分组列出，支持搜索与重新扫描；
- **结构化表单**：YAML/JSON 按值类型生成控件——布尔=开关、数字=输入框、长文本=多行框、嵌套对象=可折叠分组（组名旁显示该组的 YAML 注释）、数组=列表编辑器（标量项可增/删/改，对象项可编辑/删除）；
- **无损保存**：只对改动路径写回，未触碰的键、注释、键序、引号风格全部原样保留；数组增删项时整段替换该数组（仅该数组内部的注释会丢，键上的注释不受影响）；
- **自动降级**：TOML（序列化会丢注释）、含锚点/别名的 YAML、多文档 YAML、解析失败的文件自动退回「原始文本」编辑并说明原因；
- **生效提示**：与 server.properties 编辑一致——运行中实例显示「保存并重启」。

## 自动重启（崩溃重启 / 定时重启）

实例详情页「自动重启」按钮（启用后按钮上显示绿点）：

- **崩溃后自动重启**：进程异常退出（非手动停止、退出码非 0）时延迟自动拉起，延迟可设 1–300 秒；连续崩溃会逐步退避（最长 60 秒），10 分钟内多次崩溃会在控制台标注次数。**手动停止（页面按钮或控制台 `stop`）退出码为 0，不会被自动重启**；实例被删除时会取消待执行的重启。
- **定时重启任务**：可添加多条，支持
  - `每日定时`：指定 `HH:MM`，可勾选星期几（不选=每天）；
  - `固定间隔`：5 分钟 ~ 每周（预设 5/15/30 分钟、1/3/6/12 小时、每天、每周）。
  每条任务可单独启用/停用。任务只在实例运行时执行重启；若实例未运行则跳过本次（不会把被手动停掉的实例又拉起来）。Agent 每 30 秒检查一次，触发时会在控制台打印 `[BlockNexus] 定时重启触发（…）` 并通过 SSE 通知面板。
- 触发记录与重启过程都写进实例控制台，便于追溯。

调度判定规则有回归测试：`node agent/test-watchdog-schedule.js`（12 例：触发窗口、20 小时去重、星期过滤、间隔上下限、非法输入）。

## 实例备份与核心来源

- **实例卡片**：标题行 + 备注 + 信息网格（`版本/内存`、`玩家/运行时间`，以及各占一行的 `IP：host:port` 与 `域名`；标签列按内容自适应、不换行），**右下角是启停按钮**（红框=停止、绿框=启动）；点击卡片其余区域进入实例详情。
- **实例编辑**：详情页「编辑」按钮打开模态框设置**备注**与**连接地址/域名**（仅面板展示，不改服务端配置；卡片内不再提供行内编辑，域名值点击为复制）。
- **备份**：实例卡片「备份」按钮 → tar.gz 完整快照（用系统 `tar` 打包），存于服务器 `<实例目录>/.backups/<name>/`；支持创建/列表/下载/恢复/删除，恢复会清空实例目录后解包（运行中先强制停止）。删除实例时可勾选「删除前自动创建备份」，且备份在实例删除后仍然保留——重建同名实例即可从旧备份恢复。
- **定时备份**：详情页「定时备份」按钮（启用时带绿点）设置计划任务（每日固定时间+星期过滤 / 固定间隔，与自动重启同一套规则）与**保留份数**（开启时默认 10，0 = 不限制）。到期由 Agent 每 30 秒轮询触发，**面板关闭也照常执行**；实例未运行也会备份（停机存档最干净），运行中会先 `save-off` + `save-all flush` 落盘 3 秒再打包、完成后 `save-on`——手动备份同样受益，避免 tar 捕获正在写入的存档。每次备份成功后按保留份数自动清理最旧快照（手动与自动一起计数，0 时不清理）；同一实例同一时刻只跑一个备份任务，完成/失败经 SSE 推送 toast 并写入实例控制台。
- **核心来源**（新建实例三选一）：
  1. `官方版本` — Mojang 官方清单。获取链路带多层兜底：官方源 → BMCLAPI 镜像（清单与 server.jar 下载地址都会按路径改写走镜像）→ 最近 7 天的磁盘缓存（页面提示「缓存列表」）→ **MSL 镜像**；Agent 全部失败时面板会用自身网络再兜底一次，保证「版本列表加载失败」不再阻塞建实例；
  2. `自定义 URL` — 任意可直连的 `.jar` 下载地址（Paper/Purpur/Fabric/Forge 安装器直链等）；
  3. `上传本地核心` — 创建后走 beUI FileUpload 上传 `.jar`，自动重命名为 `server.jar`（也可稍后在文件管理中上传）。
- **MSL 镜像源**（[mslmc.cn](https://www.mslmc.cn)）：官方 API/下载不可用时的兜底解析链，覆盖 vanilla/paper/purpur/folia/forge/neoforge/fabric。paper/purpur/folia/vanilla 返回直连 jar，forge/neoforge 返回官方安装器（现场安装不变），fabric 返回官方 server jar（可直接启动）。带 sha256 的下载会做完整性校验；遵守 MSL 的 UA 与频率要求（仅在官方源失败后调用）。**本服务的镜像下载由 MSL 开服器提供（mslmc.cn）**。
- **面板代下**（服务器网络受限的兜底）：Agent 侧下载核心失败（核心站点 404/超时）时，安装会落为「失败」状态，面板在 10 分钟冷却内**自动**用自己的网络重新解析下载计划（vanilla/paper/purpur/folia/fabric/forge/neoforge/自定义 URL 均支持）、下载核心（官方源 → BMCLAPI 镜像），再经加密通道分块推送到服务器（同样支持断点续传），由 Agent 落位安装（直连 jar 改名 `server.jar`；fabric/forge/neoforge 继续跑官方安装器——安装器自身仍需服务器能连 maven，若也受限请改用「上传本地核心」）。实例卡片与详情页失败状态下也有手动「面板代下」按钮，全流程叙述写入实例控制台。
- **Paper/Purpur/Folia 首启预下载**：这三家的 `server.jar` 只是 paperclip 引导器，首次启动它会自己连 piston-data.mojang.com 下载原版核心到 `cache/mojang_<版本>.jar`——国内服务器连不上官方源就会一直卡在 `Failed to download mojang_x.jar`。Agent 会在**安装完成后**（以及每次**启动前**兜底，覆盖面板代下与旧实例）检测该文件，缺失时按「官方源 → BMCLAPI 镜像」预下载并按清单 sha1 校验后落位；paperclip 检测到文件存在且哈希匹配即跳过下载。预下载失败只告警不阻断启动（paperclip 仍会自行尝试）。
- **内存设置**：下拉含「（推荐）」项（按服务器物理内存一半、向下对齐 512MB、上限 8GB 计算，默认选中）、常用预设（512MB～16GB）与「自定义…」（精确到 MB，512–32768）。

## 本地测试（不接触真实服务器）

添加一台「服务器」（host 随意，不点安装），然后用它的 token 手动把 Agent 跑在本机：

```bash
node agent/agent.js --panel ws://127.0.0.1:3080 --token <token> --id <服务器ID> --instances ./data/instances
```

即可完整体验创建实例（会真的从 Mojang 下载 server.jar 并用本机 Java 启动）。

端到端回归测试（隔离面板 + 独立 Agent，覆盖加密通道断点续传、Agent 重启续传、面板代下全链路、安装失败自动兜底）：

```bash
node agent/e2e-panel-install.js
```

找回密码三段式与限流（发码限流、验证码校验换一次性票据、凭票据改密、错码锁定、过期与关闭保护即失效、旧 token 兼容）：

```bash
node agent/e2e-reset-code.js
```

Agent 单元测试（全部零依赖，不需要面板与真实服务器）：

```bash
npm run test:agent
```

逐个说明：

| 脚本 | 覆盖内容 |
| --- | --- |
| `node agent/test-module-imports.js` | 模块导入完整性（跨模块符号漏 import / 拼错名） |
| `node agent/build.js --check` | 产物新鲜度：`agent/agent.js` 是否与 `src/**` 同步 |
| `node agent/test-bundle-fresh.js` | 产物与源码一致、仍是零依赖、保留 `AGENT_VERSION` 常量 |
| `node agent/test-bundle-smoke.js` | 黑盒启动产物（横幅、监听端口、SIGTERM 干净退出） |
| `node agent/test-bootstrap-vanilla.js` | 原版核心预下载（官方/镜像、sha1 自愈、并发只下一次） |
| `node agent/test-start-singleflight.js` | 启动并发去重（并发只 spawn 一个 java）、进程归属、取消启动 |
| `node agent/test-watchdog-schedule.js` | 看门狗定时任务判定规则 |
| `node agent/test-player-tracking.js` | 玩家进出/名单解析、控制台跨 chunk 拼行 |
| `node agent/test-fs-ops.js` | 文件管理（复制/移动/压缩/解压/路径越界） |

## AI 日志分析（实例详情页「AI 分析」）

实例详情页顶部可在「终端 / AI 分析」间切换。启用后，AI 会读取该实例的控制台日志并流式给出分析。日志量取 **Agent 环形缓冲的全部内容（最多 500 行）**，这是上游能提供的上限；若日志整体过长仍会按字符截断，此时回答下方会标注「（过长已截断）」。

- **快捷分析**：输入框左侧 `+` 提供预设问题——分析运行状态、只看报错、崩溃原因、卡顿排查、插件冲突；也可直接输入自己的问题；- **多轮追问**：会带上最近几轮对话，可就同一个日志继续追问；
- **流式输出**：结果按 token 实时渲染，可随时点停止；每条回答可一键复制，并标注本次依据的日志行数；
- **模型侧不落盘**：日志只在内存中拼装后发给模型，分析完即丢弃。

配置在 `/settings` 的「AI 日志分析」卡片：填**接口地址**（OpenAI Chat Completions 兼容格式，如 DeepSeek `https://api.deepseek.com`、智谱 `https://open.bigmodel.cn/api/paas`）、**模型**（如 `deepseek-flash`、`cn:glm-5.3-flash`）与 **API 密钥**，打开开关保存即可。

模型不用手敲：填好地址与密钥后点「查询模型」即可从服务商拉取可选列表（自动过滤 embedding / tts 等非对话模型，聊天模型排前面）。**地址与密钥可以先填先验证再启用**——配置区不受启用开关限制，「查询模型」与「测试连接」在未启用时同样可用。密钥只保存在本机 `data/config.json`，页面回读时只显示「已保存」，不会回传明文；保存时留空表示不修改。

填完可点「测试连接」验证，结果会显示 **模型、状态、首字延迟、总耗时、Token 用量**；分析时每条回答下方也会带上同样的统计，便于对比不同模型的速度与开销。

推理类模型（如 `cn:glm-5.3-flash`）的思考过程放在 `reasoning_content` 而非 `content`，面板已兼容：正文为空时用思考内容兜底，不会显示成空白。这类模型首字通常要几秒到几十秒，属正常现象。

未启用、未填密钥、或该实例尚无日志时，会直接给出对应中文提示。

## API 一览（登录后，Cookie 会话）

```
POST /api/login | /api/logout        GET /api/me
POST /api/forgot-password            POST /api/verify-reset-code
POST /api/reset-password             (以上三个匿名，找回密码)
GET  /api/license                    (MIT 全文，匿名，关于页展示)
GET|PUT /api/settings                POST /api/settings/smtp-test
GET|POST /api/servers                GET|PUT|DELETE /api/servers/:id
POST /api/servers/:id/install        POST /api/servers/:id/token/rotate
POST /api/servers/:id/agent-update   (Agent 版本落后时的手动更新兜底)
GET|POST /api/servers/:id/instances  DELETE /api/servers/:id/instances/:name
POST /api/servers/:id/instances/:name/start|stop|restart|command
PUT /api/servers/:id/instances/:name/watchdog|backup-schedule  (自动重启 / 定时备份设置)
GET  /api/servers/:id/instances/:name/console?tail=200
GET  /api/servers/:id/instances/:name/domain-check
GET  /api/servers/:id/instances/:name/banlist
POST /api/servers/:id/instances/:name/banlist/unban
GET|POST /api/servers/:id/instances/:name/icon   (server-icon 读取/上传)
GET  /api/servers/:id/instances/:name/mods
POST /api/servers/:id/instances/:name/mods/toggle|mods/delete
GET  /api/servers/:id/mcversions     POST /api/servers/:id/java-install
GET  /api/servers/:id/javas          POST /api/servers/:id/java-use|java-uninstall   (Java 多版本)
POST /api/servers/:id/instances/:name/retry-install|reinstall|panel-install
POST /api/settings/ai-test           POST /api/settings/ai-models
POST /api/servers/:id/instances/:name/ai-analyze
GET  /api/version                    (当前版本 + GitHub 最新 Release 与更新日志)
GET  /api/events                     (SSE: status / latency / stats / agent-event / install / agent-update)
GET  /agent.js                       (Agent 单文件下载，匿名)
```

## 版本号与 User-Agent

有两套**独立**的版本号，不要互相覆盖：

| 版本 | 位置 | 用途 |
| --- | --- | --- |
| **面板版本** | `package.json` 的 `version` | 启动横幅、`/api/me`、`/api/version`、关于页与设置页「版本与更新」卡片；与 GitHub Release 标签（`v0.2.0` 形式）比对判断有无更新 |
| **Agent 版本** | `agent/src/config.js` 的 `AGENT_VERSION` | 面板从交付产物 `agent/agent.js` 文本里正则提取，与远端 `hi` 上报值比对，不一致即自动更新远端脚本；本机 Agent 也可单独更新 |

对外 HTTP 请求的 User-Agent 都由这两处派生，不再另写版本字面量。镜像源对 UA 有实际要求：清华 TUNA 对**不带 UA** 的请求返回 403，MSL 要求 UA 含应用名，所以这两个字符串不能删空。改完 Agent 版本记得 `npm run build:agent`——产物里的 `AGENT_VERSION = 'x.y.z'` 是面板提取版本号的正则目标，`npm run test:agent` 会校验产物与源码同步。

## 安全注意事项

- `data/config.json` 含 SSH 密码/私钥、服务器 token 与 AI 接口密钥（明文），请确保宿主机安全，必要时用私钥认证并收紧文件权限；
- 面板密码建议尽快用 `BLOCKNEXUS_PASSWORD` 替换初始密码；
- 面板监听 `0.0.0.0` 是为了让远程 Agent 能回连，浏览器访问请尽量走本机或受信任网络；
- Agent 以 systemd 默认身份（root）运行，MC 实例共享该权限——与绝大多数 MC 服务器运维习惯一致，但请知悉。

### 反向代理部署（重要）

面板放在反向代理后面时**必须加 `--trust-proxy <层数>`**，否则 `req.ip` 会恒为代理地址，
登录与找回密码的 IP 限流会退化成**全局限流**——任一攻击者失败 5 次就能把所有人锁在门外 5 分钟。

```bash
# Nginx 单层反代（最常见）
node panel/server.js --host 127.0.0.1 --trust-proxy 1

# 反代本身还有一层（如 CDN → Nginx）
node panel/server.js --host 127.0.0.1 --trust-proxy 2

# 只信任本机回环代理
node panel/server.js --trust-proxy loopback

# 外部走 HTTPS、但面板自身是 HTTP（反代终止 TLS）→ 让会话 Cookie 带上 Secure
node panel/server.js --host 127.0.0.1 --trust-proxy 1 --secure-cookies
```

- 等价环境变量：`BLOCKNEXUS_TRUST_PROXY`、`BLOCKNEXUS_SECURE_COOKIES=1`
- 反代需传 `X-Forwarded-For`，Nginx 写法：`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
- **`--trust-proxy` 默认关闭**。面板若直连公网，**绝不能开**——`X-Forwarded-For` 可被伪造，反而绕过限流。
- 用「层数」比用 IP 列表安全：`X-Forwarded-For` 由每层代理逐跳追加，express 取「从右往左第 N+1 个」，
  因此攻击者预塞多少个伪造值都不起作用。
- **验证方法**：用两台不同设备各输错 5 次密码。若第二台也被锁（提示带剩余秒数）→ `trust proxy` 没生效；
  若第二台能正常尝试 → 生效。
- `--secure-cookies` **仅在确实通过 HTTPS 访问时开启**：纯 HTTP 下浏览器会拒绝保存带 `Secure` 的 Cookie，
  表现为「登录成功但立刻掉线」。面板自身以 `--tls-cert/--tls-key` 启动 HTTPS 时会自动带上，无需此参数。
- 启动横幅会打印当前生效的「反代信任」与「安全 Cookie」状态，可据此确认配置。

## 路线图

- [ ] 面板 HTTPS / 反向代理子路径支持
- [ ] 多用户与细粒度权限
- [ ] 计划任务（定时备份等）

## Windows 一键启动

双击 **BlockNexus.exe** 即可：自动启动面板（已在运行则跳过）→ 顺带拉起 config.json 里**本机服务器**（host 为 127.0.0.1/localhost）对应的本地 Agent → 打开**独立的桌面应用窗口**（WebView2 渲染，无地址栏/标签页，任务栏独立图标）。

- 关闭窗口只是关掉界面，面板与 Agent 继续在后台运行；再次双击秒开（已有可见窗口时会把该窗口带到前台，不会重复开）；**跨站链接**（如 GitHub）自动交给系统默认浏览器打开，窗口始终留在面板上；
- **托盘图标**：面板在后台运行时，系统托盘常驻 BlockNexus 图标（就是 logo.png）——**左键单击**直接打开应用，**右键菜单只有两项**：
  - **打开应用** — 只开界面，面板与本地 Agent 继续运行；
  - **退出应用** — 完全关闭：关界面 + 停面板 + 停本地 Agent + 收掉托盘。

  不再有单独的「停止后台 / 仅退出托盘」项：想彻底关就点「退出应用」。
- 命令行同样可用：`npm stop`（或 `node scripts/blocknexus-launcher.js --stop`）会结束应用窗口、面板与本地 Agent 并收掉托盘；只想关界面用 `node scripts/blocknexus-launcher.js --close-window`；
- 相关文件：`scripts/tray/BlockNexusTray.cs`（托盘 exe 源码，WinForms）、`scripts/build-exe.ps1`（编译 + 自签 + 清图标缓存，见下）、`scripts/blocknexus-launcher.js`（启动器）、`scripts/blocknexus-edge.ps1`（探测/关闭应用窗口进程组）、`scripts/make-ico.ps1`（logo.png → `images/blocknexus.ico`）、`scripts/create-shortcut.ps1`（重建桌面快捷方式）。启动日志在 `data/launcher.log`。

### 重新生成 BlockNexus.exe

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1          # 只编译（图标始终由 logo.png 重新生成）
powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1 -Sign    # 编译 + 本机自签（会弹 UAC）
```

用系统自带的 `csc`（.NET Framework 4.x）编译，**不需要下载任何工具链**；图标由 `images/logo.png` 生成并内嵌进 exe，所以托盘和快捷方式显示的都是 logo.png。

**外壳分发包（项目外的 `..\BlockNexus\` 目录）**：build 脚本除在项目根生成 exe 外，还会把 `BlockNexus.exe / .config / WebView2Loader.dll / WebView2 托管 DLL / root.txt` 同步到**项目旁的 `BlockNexus\` 目录**（快捷方式与启动器都优先用它）。原因：实测 Win11 25H2（build 26200）上出现过「项目文件夹内任何 exe 的 `Shell_NotifyIcon` 都返回失败、托盘图标无法注册」的持久 shell 异常（同二进制在其他目录正常，重启 Explorer 无效），把外壳与项目分离即可绕开；exe 靠同目录 `root.txt`（build 时写入项目根路径）找回项目。托盘注册流程自带三级自愈：启动时用原生 `Shell_NotifyIcon` 探针验证、失败则延迟重加、Explorer 建好注册项后自动置 `IsPromoted=1` 提升到任务栏可见区。

`-Sign` 会在本机创建一个代码签名证书，装进 `LocalMachine`/`CurrentUser` 的 **Root 与 TrustedPublisher**，并对 exe 加上 DigiCert RFC3161 时间戳——这样 Defender SmartScreen 不再拦（未签名的本地 exe 必定被拦）。两个要点：

- 写 `LocalMachine` 信任区需要管理员，脚本会自行申请提权（需你在 UAC 上点「是」）；
- **本机自签只对这台机器有效**，换一台电脑仍需正规证书签名。

exe 换了图标但资源管理器还显示旧图时，脚本已自动执行 `ie4uinit -ClearIconCache` 清缓存。

## 面板设置（/settings）

导航栏「设置」进入**独立设置页**：

- **登录保护**：开关 + 用户名/密码（默认无密码；开启后所有接口需要会话）；
- **公网访问**：绑定面板对外域名（如 `panel.example.com`）。**HTTPS 由 nginx 等反向代理负责，面板无需配置 SSL**；域名用于找回密码链接与通知邮件中的面板地址；
- **SMTP 邮件**：服务器/端口/SSL 开关/用户名/授权码/发件人，可一键「保存并发送测试邮件」验证连通性（QQ/163 等邮箱使用授权码）；
- **通知设置**：管理员邮箱 + 「服务器离线时邮件通知」（同一次离线只发一封，24 小时后补发提醒；Agent 抖动重连由 10 分钟最小间隔兜底，不刷屏）+ 「恢复上线时通知」（只在发过离线通知后生效）；
- **AI 日志分析**：接口地址（OpenAI Chat Completions 兼容）/ 模型 / API 密钥 + 启用开关，可「测试连接」；密钥留空表示不修改，页面不回传明文。启用后实例详情页出现「AI 分析」页签（详见上文「AI 日志分析」）；
- **版本与更新**：显示当前版本与 GitHub 最新 Release 对比（有新版时提示并可跳转），内置**更新日志**（默认折叠，点击展开，读取自 Release 正文）；「检查更新」按钮可强制刷新（结果缓存 10 分钟）；下方为源码地址；
- **关于**（页面底部入口）：进入 `/about`，显示项目版本、开源地址、**许可证全文**（内置展开，无需跳转）、引用服务（MSL 开服器 / BMCLAPI / Mojang / Adoptium 及各核心官方 API）、开源依赖清单与免责声明。

### 忘记密码（邮箱验证码，三段式）

登录页「忘记密码？」后分三步，**验证码通过之前看不到密码输入**：

1. **发码**：输入管理员邮箱 → 面板通过 SMTP 发送 **6 位数字验证码**（**15 分钟有效**，只存 SHA-256 摘要）；
2. **校验**：在 OTP 框里填入验证码 → `POST /api/verify-reset-code` 校验通过后返回**一次性改密票据**（10 分钟有效），验证码同时作废；
3. **改密**：凭票据设置新密码 → `POST /api/reset-password`；重置成功后**所有会话下线**并需用新密码登录。

安全与限流：

- 验证码**不能直接改密**，必须携带第 ② 步的票据（票据一次性、10 分钟过期、关闭登录保护时全部作废）；
- **发码限流**：同一 IP **60 秒冷却** + **每小时 5 次**上限；邮箱不匹配/未配置 SMTP 的请求**同样计数**并返回成功（既避免探测管理员邮箱，也避免用不匹配邮箱无限轰炸）；
- **校验限流**：同一 IP 连续错 5 次**锁定 15 分钟**（提示剩余次数）；单个验证码累计试错 20 次即整码作废，兜底多 IP 分布式爆破 6 位数字；
- 邮件发出的重置链接（`/reset?token=…`）**仍然可用**：后端兼容按摘要比对 token，打开后直接设置新密码，无需再输验证码（旧版 `#/reset?token=…` 形式的链接进入时会自动迁移）。

验证码输入框用的是 beUI 的 [otp-input](https://beui.dev/components/blocks/otp-input)：支持粘贴整串、退格清空当前格、方向键/Home/End 移动光标、校验失败抖动、成功打勾，填满 6 位自动提交校验，复制邮件里的 6 位数字直接粘贴即可。

## 服务器卡片资源占用

首页服务器卡片与服务器设置页「系统信息」都会显示**内存当前占用**（`已用 / 总量`）与**磁盘用量**（实例目录所在分区的 `已用 / 总量`）：面板后台每 30 秒向在线 Agent 拉取一次快照并经 SSE 推送；Linux 上内存占用按 `/proc/meminfo` 的 MemAvailable 计算（页缓存不算"已用"），磁盘用 `fs.statfs`（老版本 Node 回退 `df`）。Agent 离线时保留最近一次数值。

## 地址脱敏

**服务器 IP** 在面板展示处默认脱敏为圆点，点击即可显示/隐藏（再点回收起）：服务器列表卡片、服务器详情页头部、实例详情页头部（**服务器设置页不脱敏**，便于核对 SSH/回连地址）。脱敏文本自己处理点击事件并阻止冒泡，因此在可点击卡片内点它只切换显示、不会误触进入详情。

首页「我的服务器」卡片：标题行（名称 + Agent 状态徽章）→ `IP` 行（脱敏，点击显示）→ 两列系统信息网格（`主机/系统/内存（当前占用）/磁盘/Java/Node/在线`，标签定宽对齐）。

**实例自身的连接地址与域名不做脱敏**（它们是给玩家用的，需要一眼看到/复制）。

这样截图分享面板时默认不会泄露机器地址，需要时点一下即可查看。

## 许可证

[MIT](./LICENSE) —— 欢迎自由使用、修改与二次分发，也欢迎 Issue / PR。
