# DDNS 与 frp 接入实验计划（分支 `feat/ddns-frp`）

> 目标：让"家里/公司电脑开服"的用户，不买 VPS 也能被外网访问；同时让面板域名在动态 IP 下自动跟上。
> 本分支只做实验性实现，稳定后再合回 `main`。

## 一、范围

| 做 | 不做 |
|---|---|
| DDNS：面板侧定时同步 A/AAAA 记录（Cloudflare / DNSPod / DuckDNS / 自定义回调） | 不做 20 家服务商；不做独立常驻进程（面板本身常驻） |
| frp：面板托管 `frpc` 进程（SakuraFrp 模式 / 自建 frps 模式），生成配置、抓日志、自动重连 | 不打包 frpc 二进制；不自动化部署 frps；不接 SakuraFrp 私有 API 建隧道 |
| 状态展示：上次同步时间/IP/结果、frpc 运行状态与最近日志 | 不做多域名批量管理（v1 单条记录） |
| 安全：凭据掩码返回、默认关闭、失败不泄露 token | 不做 DDNS 记录删除/回滚历史 |

## 二、DDNS 设计

- 取 IP 三种来源（借鉴 ddns-go）：`api`（内置列表 + 可自定义 URL）→ `nic`（网卡地址，NAT 时会提示无公网地址）→ `command`（用户命令输出中提取）；
- 判定"要不要写"：**本机 IP 与服务商记录不一致才写**（避免限流），写后可选做一次 DNS 回读；
- 服务商适配器拆成**纯函数构造请求**（可单测）+ 薄网络层（注入 fetch）：
  - Cloudflare：`GET /zones` → `GET /dns_records` → `PATCH`（无记录则 `POST` 创建），Bearer Token；
  - DNSPod：`dnsapi.cn/Record.List` → `Record.Modify`/`Record.Create`，`login_token=ID,Token`；
  - DuckDNS：单条 GET，返回 `OK` 即成功；
  - Callback：URL + 模板（`#{ip} #{domain} #{type} #{ttl}`），2xx 即成功——覆盖未内置的服务商。
- 调度：默认 5 分钟一次；设置变化或手动「立即同步」立即执行；同一时刻只允许一个在途任务；
- 失败退避：连续失败按 5min → 10min → 30min 退避，成功即复位。

## 三、frp 设计

- 两种模式：
  1. **SakuraFrp**：`frpc -f <访问密钥>:<隧道ID[,隧道ID]> -n`（官方 frpc 或上游 frpc 均可，官方节点兼容上游 0.18+）；不碰私有 API，隧道在樱花面板建；
  2. **自建 frps**：面板按设置生成 `data/frp/frpc.toml`（serverAddr/serverPort/auth.token + proxies 列表），`frpc -c <file>` 启动。
- 进程托管：`windowsHide` 静默启动、日志落 `data/frp/frpc.log`、pid 记 `data/frp/runtime.json`；
  面板重启后清理陈旧 pid；异常退出按 5s/15s/60s 退避重连（最多 5 次后停下并在 UI 提示）。
- 二进制：用户自备（设置里填路径）；面板只校验可执行文件存在，不下载、不打包。

## 四、数据模型（`data/config.json` → `settings`）

```jsonc
{
  "ddns": {
    "enabled": false,
    "provider": "cloudflare",        // cloudflare | dnspod | duckdns | callback
    "domain": "",                     // 完整记录名，如 mc.example.com
    "ttl": 600,
    "intervalSec": 300,
    "ipv4": true,
    "ipv6": false,
    "source": "api",                  // api | nic | command
    "sourceUrl": "",
    "sourceIPv6": "",                 // 留空 = 同 source
    "command": "",
    "cloudflare": { "token": "", "zoneId": "" },
    "dnspod": { "id": "", "token": "", "root": "", "line": "默认" },
    "duckdns": { "token": "" },
    "callback": { "url": "", "body": "" }
  },
  "frp": {
    "enabled": false,
    "mode": "sakura",                 // sakura | upstream
    "binaryPath": "",
    "sakura": { "token": "", "tunnels": "" },
    "upstream": {
      "serverAddr": "", "serverPort": 7000, "authToken": "",
      "proxies": [{ "name": "", "type": "tcp", "localPort": 25565, "remotePort": 25565 }]
    }
  }
}
```

`schemaVersion` +1（新增 `settings.ddns` / `settings.frp` 默认值，老配置自动补齐）。

## 五、API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/network/ddns` | 配置（token 只回 `has*`）+ 运行时状态 |
| PUT | `/api/network/ddns` | 保存并重配调度器（空 token = 不修改） |
| POST | `/api/network/ddns/check` | 只检测当前公网 IP（不写记录） |
| POST | `/api/network/ddns/run` | 立即同步一次，返回结果 |
| GET | `/api/network/frp` | frp 配置（掩码）+ 运行状态 + 最近日志 |
| PUT | `/api/network/frp` | 保存配置；运行中则重启 |
| POST | `/api/network/frp/start` \| `/stop` \| `/restart` | 进程控制 |

错误码新增 `network.*`（非法域名/缺凭据/二进制缺失/端口非法/启动失败）。

## 六、UI

面板设置新增两张卡（放在「公网访问」区域）：

- **动态 DNS**：开关、服务商、域名、TTL、间隔；IPv4/IPv6 与取址方式（接口/网卡/命令）；各服务商字段；
  「检测公网 IP」「立即同步」按钮；状态行（上次时间 / IP / 结果 / 下次执行）。
- **frp 内网穿透**：开关、模式（SakuraFrp / 自建 frps）、frpc 路径、对应字段、启动/停止按钮、
  运行状态与最近日志（复用 `LogViewer`）。

## 七、安全

- 凭据读取一律掩码（`hasToken`），PUT 空值表示保留原值；
- 默认关闭；开启但缺凭据直接拒绝保存（不落半成品配置）；
- DDNS 接口全部在登录态之后；`command` 来源只在面板本机执行、有超时与输出上限；
- frp 只允许启动"用户指定路径"的可执行文件，路径必须在设置里显式保存（不做下载）。

## 八、测试

- `agent/test-ddns.js`：域名拆分、IP 提取（接口/网卡/命令）、变更判定、四个服务商的请求构造、间隔钳制；
- `agent/test-frp.js`：TOML 生成与转义、SakuraFrp 参数构造、配置校验（缺字段/非法端口/二进制不存在）；
- 复用 `test-panel-migrate.js` 验证 schema 迁移；
- 前端：`npm --prefix web test`（i18n 键集完整性）+ `tsc -b`。

## 九、分阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | DDNS 核心 + API + 设置卡 | 用假 fetch 单测全绿；面板里能保存、检测、手动同步；重启后配置仍在 |
| P2 | frp 进程托管（两种模式） | 配置生成单测；本机用假 `frpc`（脚本）验证启动/停止/日志；Windows 无弹窗 |
| P3 | 与实例联动（公网地址、端口锁定） | 手工验收：实例卡片显示公网地址；域名检测通过 |

## 十、风险

- 第三方服务（SakuraFrp）可用性/限速/计费与条款变化；免费节点官方明确"游戏服慎用"；
- DDNS 只在有公网 IP 时有效（CGNAT 无效），UI 必须明确提示；
- 凭据明文存储（与现有 SSH/SMTP 同级），文档需写清；
- frpc 由用户提供，版本差异（SakuraFrp 魔改版 vs 上游）需要分别对待。
