# BlockNexus 开发与实现说明

面向要改这个仓库的人：内部实现、目录结构、前端与 Agent 的构建、测试、版本号约定、外壳 exe 的重新生成。

安装与日常使用看 [README](../README.md)；发版流程见 `scripts/build-release.ps1`（维护者内部约定不随仓库发布）。

---

## 加密通道设计

- 每台服务器一个随机 256-bit token（只存面板 `data/config.json` 与远程 `agent.json`，**不随网络传输**）；
- **双向认证握手**：连接发起方发 `hello`（身份 + 随机 nonce）→ 对端回 `challenge`（自己的 nonce）→ 发起方提交 `HMAC(kProof,'auth1'||nonceC||nonceS)` 证明持有 token → 对端校验后再回 `HMAC(kProof,'auth2'||…)`，**双方都验证对方持有 token**（含时钟偏差检查）。因此无论哪个方向发起，未持有 token 的一方都无法建立通道：Agent 会拒绝伪造的面板，面板也会拒绝伪造的 Agent；
- 会话密钥由 `HKDF-SHA256(token, nonceC||nonceS)` 派生，两个方向独立（`kA2P` / `kP2A`）；
- 之后所有帧为二进制 `[版本|nonce前缀|计数器|AES-256-GCM 密文+tag]`，计数器严格单调递增防重放；
- 握手与数据都不暴露 token，被动窃听拿不到明文；
- 可选 TLS 传输层：`wss://` + 自签证书 + **指纹固定**（面板只信任安装时记录的那张证书）。

**已知限制**（诚实说明）：该设计防被动窃听与伪造，但不能防御主动中间人（MITM 可以转发握手）。公网部署建议在面板前加 HTTPS 反向代理，或通过 SSH 隧道访问面板端口。

---

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
  server.js     面板入口（HTTP + 静态资源 + SPA 回退 + Agent WS 升级路由 + 启动自迁移）
  config.js     data/config.json 持久化（服务器/SSH/token/登录密码/更新设置）
  crypto.js     HKDF / 握手证明 / AES-256-GCM 帧加解密
  agentlink.js  AgentHub：握手状态机、在线连接表、加密请求路由、事件转发
  ssh.js        SSH 安装器（远程 Linux：Node 检测安装、SFTP 上传、systemd 注册、Agent 热更新）
  localagent.js 本机 Agent 托管（面板直接 spawn/stop 进程 + 专用目录，免 SSH/systemd）
  quick.js      快速添加的默认值推导（内存/端口/实例名/版本/Java 主版本，纯函数、可单测）
  ddns.js       动态 DNS：IP 判定/域名拆分/服务商请求构造（纯函数）+ 注入 fetch 的网络动作
  frp.js        frp 客户端托管：配置生成（SakuraFrp 参数 / frpc.toml）、进程状态机、日志
  api.js        REST API（登录、服务器 CRUD、安装、实例操作、网络助手、面板自更新）+ SSE 实时推送
  update.js     自更新判定：安装形态、Release 元数据解析、升级计划、写入白名单（纯函数）
  migrate.js    data/config.json 的 schemaVersion 迁移链
  mail.js       邮件模板（HTML 卡片样式 + 纯文本兜底）
agent/
  agent.js      零依赖单文件 Agent（自带 RFC6455 WebSocket 客户端 + 同套加密实现）——**由 build.js 生成，勿直接编辑**
  build.js      打包器：把 src/** 拼成上面的单文件产物（`npm run build:agent`；`--check` 只校验是否同步）
  src/          Agent 源码，按功能组分模块（config/crypto/ws/http/catalog/util + instance/**）
scripts/
  panel-updater.js  自更新执行器（独立进程：快照 → 替换 → 拉起 → 健康检查 → 失败回滚）
  build-release.ps1 发版打包（便携版 / 纯外壳 / 应用包 + update.json + SHA256SUMS.txt）
data/           运行时数据（config.json、本地测试实例、data/update/ 更新日志与备份），已 gitignore
```

Agent 是「源码分模块 + 打包成单文件」：交付物仍是单文件（SSH 只上传一个文件、systemd 直接跑它、面板 `/agent.js` 匿名下载、手动 `curl -o agent.js` 安装都依赖这一点），所以改完源码必须重新打包：

```bash
npm run build:agent   # 重新生成 agent/agent.js
npm run test:agent    # 全部 Agent 测试（含产物新鲜度校验：忘打包会直接失败）
```

---

## 前端开发

前端基于 [shadcn/ui](https://ui.shadcn.com/)（nova 预设，Radix 底座）+ [beUI](https://beui.dev/)（shadcn registry 体系的 Motion 动效组件），React 19 + Tailwind 4 + Vite：

```bash
npm run build:web    # 构建前端到 web/dist（面板托管的就是这份产物）
cd web && npm run dev   # 开发模式（/api、/agent.js 自动代理到面板 :3080）
```

beUI 组件用法：`cd web && npx shadcn@latest add @beui/<name>`（已装：bottom-sheet、animated-toast-stack、animated-badge、tilt-card、theme-toggle、text-reveal、file-tree、file-upload）。

---

## 本地测试（不接触真实服务器）

添加一台「服务器」（host 随意，不点安装），用它的 token 把 Agent 跑在本机，即可完整体验创建实例（会真的从 Mojang 下载 `server.jar` 并用本机 Java 启动）：

```bash
node agent/agent.js --panel ws://127.0.0.1:3080 --token <token> --id <服务器ID> --instances ./data/instances
```

常驻回归测试（零依赖，不需要面板与真实服务器；逐个脚本见 `package.json` 的 `test:agent`）：

```bash
npm run test:agent                # Agent 全部单元测试（含产物新鲜度：改了 src 忘打包会直接失败）
node agent/e2e-panel-install.js   # 端到端：隔离面板 + 独立 Agent（加密通道断点续传、面板代下、安装失败兜底）
node agent/e2e-reset-code.js      # 找回密码三段式与限流（单跑约 10 分钟，CI 里独立跑）
node agent/test-quick-create.js   # 快速添加默认值推导（纯函数：内存/端口/名字/版本/Java 版本）
node agent/test-quick-setup.js    # 快速添加编排（真面板 API + 假 Agent，覆盖复用/续装/只装 Agent/失败分支）
node agent/test-windows-quiet.js  # Windows 静默托管（所有 spawn 必须 windowsHide）+ Windows Java 管理能力
node agent/test-uninstall.js      # 卸载 Agent：真起替身进程验证 stop/uninstall + 后置核验（服务/进程/目录）
node agent/test-ddns.js           # 动态 DNS：地址判定/域名拆分/四个服务商的请求构造（假 fetch）
node agent/test-frp.js            # frp 托管：TOML 生成/参数校验/进程早退路径（真子进程）
```

覆盖范围：模块导入完整性、产物与源码同步 / npm 内联、启动并发去重、看门狗与备份调度规则、玩家进出与在线时长统计、聊天解析与落盘、文件操作与路径越界、面板安全与加固、错误码与中英文案成对、面板自更新与配置迁移、Anvil 解析与地图渲染、Windows 子进程静默与 Java 多版本管理、卸载的后置核验与幂等。

---

## 版本号与 User-Agent

有两套**独立**的版本号，不要互相覆盖：

| 版本 | 位置 | 用途 |
| --- | --- | --- |
| **面板版本** | `package.json` 的 `version` | 启动横幅、`/api/me`、`/api/version`、关于页与设置页「版本与更新」卡片；与 GitHub Release 标签（`v0.2.0` 形式）比对判断有无更新 |
| **Agent 版本** | `agent/src/config.js` 的 `AGENT_VERSION` | 面板从交付产物 `agent/agent.js` 文本里正则提取，与远端 `hi` 上报值比对，不一致即自动更新远端脚本；本机 Agent 也可单独更新 |

对外 HTTP 请求的 User-Agent 都由这两处派生，不再另写版本字面量。镜像源对 UA 有实际要求：清华 TUNA 对**不带 UA** 的请求返回 403，MSL 要求 UA 含应用名，所以这两个字符串不能删空。改完 Agent 版本记得 `npm run build:agent`——产物里的 `AGENT_VERSION = 'x.y.z'` 是面板提取版本号的正则目标，`npm run test:agent` 会校验产物与源码同步。

---

## 重新生成外壳 BlockNexus.exe

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
