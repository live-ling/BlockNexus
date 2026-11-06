# 樱花 frp 引导优化

> 状态：**1.5a / 1.5b 已实现（2026-10-25）**；1.5c / 1.5d / 1.5e 仍待做，见 §0。
> 触发：真机连通性测试发现面板现有两种 frp 模式**都接不上** SakuraFrp，且用户实际使用方式是「从樱花后台复制一份手动配置」。
> 目标形态：**用户直接粘贴配置文件 → 面板（或 Agent）自动准备 frpc、生成配置、启动并显示状态**。

## 0. 实施进度（2026-10-25）

| 项 | 状态 | 落点 |
|---|---|---|
| 1.5a `user` + `transport.tls` 透传 | ✅ | `panel/frp.js`：`DEFAULTS.upstream.user/tlsEnable`、`buildUpstreamToml`、`publicConfig`（`hasUser`/`tlsEnable`，不回原文） |
| 1.5b 粘贴解析 + 导入接口 + 设置页入口 | ✅ | `frp.parseSakuraConfig()`（纯函数）、`POST /network/frp/import`、`web/src/components/frp-import-dialog.tsx`、设置页 frp 卡片「粘贴樱花配置」 |
| 暴露面板强制登录（P0-1 安全项的后端部分） | ✅ 后端 | `frp.exposureRisk()` + `PUT /network/frp` / `start` / `import` 三处拦截 |
| 顺手修：`restarts` 清零、日志轮转保留上一份 | ✅ | `FrpManager`（稳定 30s 后清零；`frpc.log` → `frpc.log.1`） |
| 1.5c 二进制自动下载 | ⬜ | 仍需固定版本 + SHA256 护栏（见 §4） |
| 1.5d Agent 侧托管 | ⬜ | 与 P0「Agent 侧 frpc」合并 |
| 1.5e sakura 模式能力探测 | ✅ | `FrpManager.start()` 早退时用 `sakuraBinaryUnsupported()` 判定日志，返回 `network.frp-sakura-needs-custom-build`（真机验证：上游 frpc → 该码） |
| 状态可见性（三态 / 重连次数 / 上次退出 / 轮询） | ✅ | `status()` 增 `state`/`restarts`/`lastExit`；设置页 8 秒轮询 + 刷新按钮 + 暴露风险横幅 |

**真机验证（2026-10-25）**：用 `parseSakuraConfig` + `buildUpstreamToml` 生成的 TOML 直接喂上游 frpc 0.71.1，
对 `frp-top.com:8088` 得到 `login to server success` + `[aaa] start proxy success`——即**面板生成的配置本身可用**，
不再需要人工抄字段。回归用例见 `agent/test-frp.js`（80 例：解析 / 错误路径 / 暴露风险 / 掩码 / TLS 透传）。

**UI 待构建**：本机沙箱内 `npm run build:web` 因 Tailwind 原生模块 `spawn EPERM` 无法完成（`tsc -b` 已通过），
需在正常环境跑一次 `npm run build:web` 才能在面板里看到「粘贴樱花配置」按钮。

---

## 1. 实测结论（2026-10-25，上游 frpc 0.71.1）

测试方式：临时目录 + 独立 frpc 进程，不触碰 `data/frp`（面板当时正托管另一套自建 frps）。

| # | 项 | 结果 |
|---|---|---|
| 1 | `frp-top.com:8088` DNS / TCP | ✅ `103.91.208.133` 可达 |
| 2 | 樱花手动配置（`user` + `auth.token` + `transport.tls.enable=false`） | ✅ `login to server success` → `[aaa] start proxy success` |
| 3 | 外网连 `remotePort` 回源到本机 `25565` | ✅ 收到本地监听器回包，端到端通 |
| 4 | **去掉 `user` 字段**（= 面板 `buildUpstreamToml()` 的产物） | ❌ `invalid configuration in upstream client, make sure token and user was set correctly` |
| 5 | **面板 sakura 模式的 `-f <token>:<ids> -n`** | ❌ `unknown shorthand flag: 'f' in -f` |

### 由此确定的两个缺陷

1. **upstream 模式缺 `user`**：`panel/frp.js` 的 `buildUpstreamToml()` 只输出 `serverAddr/serverPort/auth.*/proxies`，而樱花节点强制要求 `user`（访问密钥）。
   → 面板「自建 frps」模式对 SakuraFrp **必然登录失败**，且失败被 800ms 早退逻辑包装成「启动后立即退出」，用户只能翻日志。
2. **sakura 模式的参数是樱花定制 frpc 的私有参数**：上游 frpc 只有 `-c` / `--config-dir` / `-v` / `-h`。
   → 设置页文案让用户「自行下载 frpc 填路径」（通常拿到上游版），选 sakura 模式 **启动即失败**。
   两种模式互斥地依赖同一份 `binaryPath`，UI 上没有任何提示。

### 已验证的配置配方（占位符版）

```toml
user = "<访问密钥>"          # 樱花后台 → 访问密钥
auth.token = "<节点 token>"  # 樱花「手动配置」里给出的
serverAddr = "frp-top.com"
serverPort = 8088
transport.tls.enable = false
transport.tls.disableCustomTLSFirstByte = false

[[proxies]]
name = "aaa"
type = "tcp"
localIP = "localhost"
localPort = 25565
remotePort = 42399
```

⚠️ 樱花节点**关 TLS**；若实现时默认开 `transport.tls`，会连不上，必须按粘贴内容原样生效。

---

## 2. 目标体验（要做的功能）

### 主流程

1. 用户从樱花后台复制「手动配置」整段文本；
2. 面板里点「粘贴樱花配置」→ 粘贴 → 自动解析并回显（服务器地址 / 节点端口 / 隧道列表 / 代理映射），**凭据只显示掩码**；
3. 面板自动准备 frpc：本地机器下载到 `data/frp/bin/`，远程 Agent 下载到 `<Agent 目录>/frp/bin/`（见 §4）；
4. 自动生成运行配置并启动，状态条实时显示：`登录成功 → 隧道在线 → 公网地址`；
5. 异常可读：`凭据失效`（token 重置）/ `本地端口未监听`（实例没开）/ `节点拒绝`。

### 入口位置（待定，建议）

- **面板设置 → frp 卡片**：主入口「粘贴樱花配置」；解析成功后只读展示，不再让用户手填 TOML 字段；
- **实例页 frp 对话框**：已有「绑定公网端口」流程，可在「frp 未启用」的引导里加「粘贴樱花配置」直达；
- **快速添加**后续可加一步（目标机没有公网 IP 时提示），本期不做。

### 解析规则（只吃需要的字段）

- 接受：`user`、`auth.token`、`serverAddr`、`serverPort`、`transport.tls.enable`、`[[proxies]]` 的 `name/type/localIP/localPort/remotePort`；
- 注释里的 `# id = 29662979` 只用于**展示隧道 ID**，不参与逻辑；
- 其余字段（`log.*`、`metadatas` 等）由面板统一覆盖，不照搬用户粘贴内容；
- 解析失败/字段缺失 → 明确中文错误（缺 `user` / 缺 `auth.token` / 无代理），不要落到「启动后立即退出」。
- 解析器做成**纯函数 + 注入文本**，便于单测；不引入通用 TOML 依赖（只需极小子集，且 agent 打包器对内联包有限制）。

---

## 3. 与现有结构的关系（改动面）

| 层 | 现状 | 需要 |
|---|---|---|
| `panel/frp.js` | `DEFAULTS.upstream` 无 `user` | 加 `upstream.user`；`buildUpstreamToml` 输出 `user`；`publicConfig` 掩码 |
| 解析 | 无 | 新增 `parseSakuraConfig(text)` 纯函数（放 `panel/frp.js` 或 `panel/frp-import.js`） |
| `panel/api.js` | `PUT /network/frp` 只接受结构化体 | 新增 `POST /network/frp/import`（粘贴文本 → 结构化 + 校验），**不落盘原文** |
| 前端 | 设置页手填 + CSV textarea | 「粘贴樱花配置」弹窗 + 只读回显 |
| 二进制 | **不下载、不打包**（AGENTS.md 硬约束） | 需**显式推翻**：改为「按需下载 + SHA256 校验 + 缓存」（见 §4） |
| Agent | 无 frp 能力 | 远程实例需要 Agent 侧托管 frpc（与 `next-optimization.md` P0「Agent 侧 frpc」同一件事） |

---

## 4. 二进制自动加载（需要先定策略）

现有硬约束是「面板不打包、不下载 frpc 二进制」。本需求要「自动加载」，等于推翻它，必须补三条护栏：

1. **版本固定**：内置一份支持的 frpc 版本号，不从「最新版」漂移；
2. **完整性校验**：下载后校验 SHA256（哈希内置在代码/发布清单里，与自更新同一套思路），不匹配即删除并报错；
3. **来源明确**：优先 `github.com/fatedier/frp` release 直链（可脚本化）；樱花官网盘不做抓取（页面结构会变、且非脚本友好）。

其他点：

- 下载目标：本地 `data/frp/bin/frpc[.exe]`；Agent 侧 `<Agent>/frp/bin/`（与 `java/` 同级，遵循「运行时产物收敛在 data 或 Agent 目录」的既有约定）；
- 已有二进制时**不重复下载**，仅校验版本；
- 用户自备路径仍保留（离线/内网环境），自动下载只是默认路径；
- 远程 Agent 若无法出网：由面板中转下载并以 `file.upload` 同款分片通道下发（本期可标记为「后续」）。

---

## 5. 测试与验收

**单测（`agent/test-frp.js` 或新增 `test-frp-import.js`）**
- 真实樱花配置样例（占位符）解析成功；
- 中文注释 / CRLF / 行尾空格 / 注释里的隧道 ID；
- 缺 `user`、缺 `auth.token`、无 `[[proxies]]` → 各自明确错误码；
- 多代理、重复 `remotePort`、非法端口、`localIP` 归一（`localhost` → 保持/归一为 `127.0.0.1` 的策略需定）；
- `transport.tls.enable` 透传（true/false 都要能被原样写回生成配置）。

**验收**
1. 粘贴 → 20 秒内状态显示「隧道在线」+ 公网地址；
2. 面板机缺 frpc → 自动下载并以 SHA256 校验通过后启动；
3. 粘贴缺 `user` 的配置 → 中文提示「樱花配置缺少访问密钥」，**不启动进程**；
4. 远程实例：Agent 侧启动，日志与状态在面板可见；
5. 原有「自建 frps / 手填路径」路径不回归。

---

## 6. 风险与待决

| 风险 | 处理 |
|---|---|
| 自动下载引入供应链风险 | 固定版本 + SHA256 + 失败即删；不提供「任意 URL 下载」 |
| 樱花 token 重置后配置失效 | 错误提示「凭据失效，请重新粘贴樱花配置」，并给重置入口说明 |
| 粘贴文本含凭据 | 不写日志、不回显、不落盘原文；只存结构化字段（仍建议后续做凭据加密，见 P1） |
| 免费节点限流/共享带宽 | 文档写明；状态里区分「隧道在线」与「实际吞吐」 |
| 与「配置收口」冲突 | 粘贴导入应只写 `upstream` 段，代理列表仍以实例页为准；导入的 proxies 作为初始值 |

**待决问题**

1. sakura 模式（`-f`）是否保留？——建议保留但对二进制做能力探测（`frpc -h` 看有无 `-f`），不支持时明确报错并引导用粘贴导入；
2. 粘贴里的 `localPort` 与实例端口不一致时，以谁为准？（建议：**以实例为准并提示替换**，避免用户改了实例端口后隧道静默失效）；
3. Agent 侧下载是否走面板中转（离线主机）；
4. 是否支持「一个面板多份樱花配置」（多账号/多节点）——本期按单份设计。

---

## 7. 建议排期

| 阶段 | 内容 | 估时 |
|---|---|---|
| 1.5a | `upstream.user` + TOML 输出 + 掩码（最小的可用修复） | 0.5 天 |
| 1.5b | 粘贴解析 + 导入接口 + 设置页弹窗 + 单测 | 1 天 |
| 1.5c | 二进制自动下载（本地）+ 版本固定 + SHA256 | 1 天 |
| 1.5d | Agent 侧托管 + 远程配置下发（与 P0「Agent 侧 frpc」合并） | 3–5 天 |
| 1.5e | sakura 模式能力探测 + 文档与引导文案 | 0.5 天 |

**1.5a → 1.5b → 1.5c 可合为一次发布**；1.5d 单独里程碑。
