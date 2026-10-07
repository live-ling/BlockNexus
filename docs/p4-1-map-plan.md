# P4-1 世界地图（区块俯视图）实施计划

> 里程碑：BlockNexus v0.5.0 主线功能
> 状态：**待你确认后开工**
> 前置：docs/iteration-roadmap.md §P4-1、docs/opanel-techniques-backend.md §10、docs/opanel-techniques-frontend-mc.md §4

---

## 1. 目标

在实例详情页新增「地图」页签：把世界的方块俯视图画出来，可拖动、缩放、跳坐标，
并显示玩家位置（可选）。对应 OPanel 的网页地图。

**不做的**：洞穴剖面、实体/生物、结构、生物群系图层、3D 视角、实时方块编辑。
这些都不是「看世界长什么样」的最小闭环。

---

## 2. 关键设计取舍（与原方案 OPanel 的差异）

OPanel 的地图是「Java 解析 .mca + Rust→Wasm 渲染 + Worker 客户端」。
BlockNexus **无法照搬**，也不必照搬：

| 维度 | OPanel | BlockNexus 采用 | 理由 |
|---|---|---|---|
| 渲染位置 | Rust/Wasm（浏览器） | **Agent 侧出 PNG** | 本项目没有 Rust/wasm 构建链，也不该为地图引入一条 |
| 传输格式 | 自有二进制 `OTILE`/`OTILES` + wasm 解码 | **PNG 图片** | 浏览器原生解码（`createImageBitmap`），前端零解码代码 |
| 瓦片粒度 | 单区块 16×16 | **单区域文件**（一个 `.mca` = 32×32 区块 = 512×512 px） | 一次请求画一大片；请求数从「上千」降到「几个」 |
| 颜色来源 | 编译期从 client.jar 抽材质算色（phf 表） | **手写方块色表 + 未知方块品红** | 不下载 client.jar、不引入构建期依赖；品红能一眼看出漏了哪些方块 |

**为什么「区域级 PNG」是对的**：
- 屏幕上一屏最多覆盖几个区域 → **每次交互只发几个请求**（单区块瓦片要上千个）
- PNG 天然可被浏览器 HTTP 缓存 + `ETag` 协商，拖动回已看过的区域**零请求**
- 前端只剩「把图片画到 canvas 的正确位置」，没有像素循环、没有调色板版本同步

**代价（如实记录）**：
- Agent 每次生成 512×512 PNG 约 50–200ms（一次性，之后走落盘缓存）
- 首次打开一个大世界会看到逐块加载（可接受，且比 OPanel 的 wasm 首次下载快）

---

## 3. 数据流

```
世界目录/region/r.X.Z.mca
   │  ① Agent 读取（零依赖）
   ▼
Anvil 解析：8KiB 头 → 扇区偏移/长度 → zlib/gzip 解压 → NBT → sections[].block_states
   │                                      palette 位解包 + MOTION_BLOCKING 高度图
   ▼
每列顶部方块 id（16×16 = 256 个）→ 再合成整个区域 32×32 = 1024 列
   │  ② 着色 + 高度阴影
   ▼
512×512 RGBA → PNG 编码（自写 CRC32 + zlib.deflate）
   │  ③ 落盘缓存  <instDir>/.blocknexus-map/<region>.png
   ▼
Agent 协议  instance.map.regions / instance.map.region
   │  ④ 面板二进制转发（带 ETag，客户端缓存命中回 304）
   ▼
前端  <canvas> + ImageBitmap 缓存 + 拖动/缩放
```

---

## 4. 分阶段交付

每个阶段**独立可验证**，且都带测试（沿用现有零依赖测试框架）。

### P4-1a — Agent：Anvil 读取（最难的一块）

**新增** `agent/src/instance/anvil.js`
- `readRegionHeader(buf)` → 1024 个扇区偏移/长度 + 时间戳
- `extractChunk(buf, sectorOffset, sectorCount)` → 压缩字节
- `decompress(buf, type)` → 支持 `gzip(1)` / `zlib(2)` / `none(3)`，最高位 `0x80` 是 `.mcc` 外置标志
- `parseNbt(buf)` → 零依赖 NBT 解析器（compound / list / string / byte / short / int / long / byte[] / int[] / long[]）
- `unpackPalette(longs, bits, count)` → 调色板位解包（每 long 塞 `64/bits` 个值）
- `columnTopBlock(chunk, x, z)` → 该列顶部非空气方块 id

**风险点（提前记录）**
- **位宽**：`bits = max(4, ceil(log2(paletteSize)))`；1.18+ 与 1.17- 的 section 结构不同（`block_states` vs `Level`）
- **高度图**：`MOTION_BLOCKING` 是 `long[]`，位宽随世界高度范围变化（1.18+ 通常 9 bit）
- **palette 两种形态**（1.21.5+ 可能是字符串列表）：两种都要兼容
- **越界**：`sectorOffset == 0` 表示区块不存在 → 跳过（不能当错误）

**测试** `agent/test-anvil.js`：手工构造最小 `.mca` 字节（不依赖真实存档），
覆盖「正常区块 / 不存在的区块 / gzip / zlib / 位宽 4 与 9 / palette 两种形态」。

---

### P4-1b — Agent：着色 + 区域 PNG

**新增** `agent/src/instance/map-palette.js`
- `BLOCK_COLORS`：常见方块 → RGB（石头/草/沙/水/木/矿石/常见装饰方块…）
- `colorOf(blockId, biomeId)`：查不到 → **品红 `#FF00FF`**（刻意刺眼，一眼看出漏表）
- 保留「剥掉 `[axis=y]` 等 blockstate 后缀再查一次」的容错

**新增** `agent/src/png.js`
- 最小 PNG 编码器：IHDR + IDAT（zlib.deflate）+ IEND
- **自带 CRC32 表**（`zlib.crc32` 要 Node 20.15+，Agent 最低支持 16）

**高度阴影**：照搬原版地图规则 —— 明暗由**当前方块与北侧邻居的高度差**决定
（`diff > 0 → 最亮`、`== 0 → 次亮`、`> -2 → 较暗`、否则最暗），乘数 `[1.0, 0.8, 0.5, 0.4]`。
这样面板地图与游戏内地图观感一致，且非常好实现。

**测试** `agent/test-png.js`：编码出的 PNG 能被 Node 自己解回来（round-trip），
并校验 CRC32 正确；`test-map-palette.js` 校验未知方块出品红。

---

### P4-1c — Agent：地图协议 + 落盘缓存

**新增** `agent/src/instance/map.js`，并在 `agent.js` 路由加 case：
- `instance.map.saves` → `[{name, dir, regions: [[x,z],...], version}]`
  识别 `world/`、`world_nether/`、`world_the_end/`，以及 `level-name` 自定义
- `instance.map.region` → `{save, x, z, pngB64, version, cached}`
- `instance.map.version` → `{save, version}`（供前端轮询判断是否要刷新）

**缓存**：落盘到 `<instDir>/.blocknexus-map/<save>/<x>.<z>.png`，
版本号取「区域文件 mtime + size」的哈希；命中则直接读盘。
`.blocknexus-map/` 要**排除在备份与文件管理器之外**（否则污染用户世界的备份）。

**测试** `agent/test-map.js`：假造 region 目录与文件，验证 saves 枚举、
缓存命中、版本号变化后失效、以及 `.blocknexus-map` 不被枚举。

---

### P4-1d — 面板：API 转发

**改** `panel/api.js` + `agentlink.js`：
- `GET /servers/:id/instances/:name/map` → saves 列表
- `GET /servers/:id/instances/:name/map/:save/:x/:z.png` → 二进制 PNG
- `GET /servers/:id/instances/:name/map/:save/version` → 版本号
- 二进制走 `readBodyCapped` 同类保护（复用已有 `MAX_REMOTE_BODY` + 新增图片专用上限）
- **ETag / 304**：把 Agent 给的 version 直接当 ETag 用

**测试**：扩充 `agent/test-panel-hardening.js` —— 校验 PNG 端点有正确的
`Content-Type`、`Cache-Control`、以及超限时被拒。

---

### P4-1e — 前端：地图页

**新增** `web/src/pages/map.tsx` + `web/src/components/map-canvas.tsx` + `web/src/lib/map.ts`
- 实例详情页新增「地图」页签（与现有「控制台 / 文件 / 插件配置」同级）
- Canvas 绘制：按 `zoom`（每方块像素数）+ `offset` 计算每个区域图的绘制矩形
- **拖动**：`pointerdown/move/up`，`requestAnimationFrame` 合并重绘
- **缩放**：滚轮步进 zoom，钳制到 `[0.5, 8]`；`imageSmoothingEnabled = false`（像素风不能糊）
- **区域图加载**：只请求当前视口覆盖的区域；`Map<key, ImageBitmap>` 缓存；在途去重
- **坐标跳转**：输入 x/z 直接定位（对齐原版 F3 坐标）
- **悬停显示**：方块名 + 坐标（需要 Agent 回该列方块 id，见下）

**就近取方块信息的取舍**：悬停显示方块名需要「像素 → 方块 id」的映射。
PNG 里没有这个信息。方案：Agent 在 `instance.map.region` 里**附带该区域的
方块 id 数组**（1024 个 int，压缩后很小），前端据此反查。
**先做坐标显示，方块名放本阶段末尾**（可砍）。

---

### P4-1f —（可选）脏块自动更新

- Agent 定时（30s）扫描 region 目录的 mtime/size 变化 → 版本号自增
- 前端每 30s 轮询一次 `version`，变了就清掉对应区域图的缓存并重绘
- 不做 WebSocket 推送 —— 轮询一个整数比新增一条事件通道便宜得多

**明确不做**：方块事件级的实时刷新（那需要 Agent 挂在服务端进程里，架构上不成立）。

---

## 5. 约束与风险

| 项 | 说明 |
|---|---|
| **Agent 内存** | 渲染单个区域峰值 512×512×4 = **1MB**，用完即释放；不缓存原始 RGBA，只缓存 PNG 文件。目标 ≤80MB 不受影响 |
| **阻塞事件循环** | 解析 + 编码是同步 CPU 活。单区域 ~50–200ms，会卡住 Agent 的心跳。**缓解**：一次只渲染一个区域（队列），并在 `sys.stats` 之外**不新增**长任务；必要时改为子进程（先不做） |
| **大世界首屏** | 只请求视口内的区域，不预渲染全图。世界再大首屏也是几个请求 |
| **世界格式** | 只支持 Anvil（1.2+ 之后的默认）。远古 McRegion 与超平坦以外的 Mod 维度尽力而为 |
| **`.mcc` 外置** | 支持（最高位标志），否则部分存档会解析失败 |
| **不污染用户数据** | 缓存目录 `.blocknexus-map/` 必须排除在备份、文件管理器、实例删除的「保留数据」逻辑之外 |
| **测试真实性** | Anvil 测试用手工构造的字节，**不用真实存档**（仓库里不能放大存档）。会额外加一个「有存档就测、没有就跳过」的可选用例 |

---

## 6. 需要你确认的 4 个选择

1. **地图页签放哪**：实例详情页新增页签（我的建议）✅ / 还是独立顶级路由？
2. **颜色表来源**：手写常见方块色表 + 品红兜底（我的建议，零依赖）✅ /
   还是允许用户在设置里上传自定义色表？
3. **是否包含 P4-1f 脏块更新**：建议**先不做**，等前面跑通再评估 —— 它需要在
   Agent 上多一个定时扫描，且收益只有「开着游戏时地图自动更新」。
4. **悬停显示方块名**：建议**放在阶段末尾**，可以砍。它需要额外传 1024 个 int。

---

## 7. 验收标准

- [ ] 打开实例 →「地图」页签 → 看到世界俯视图（不是空白、不是品红海）
- [ ] 拖动流畅（`rAF` 合并，无「拖动时每帧发请求」）
- [ ] 缩放后像素不模糊（`imageSmoothingEnabled = false`）
- [ ] 重新打开已看过的区域**不发请求**（HTTP 缓存 / 内存缓存命中）
- [ ] Agent 内存与 RTT 无明显劣化（现测基线：面板 58MB / Agent RTT 个位数 ms）
- [ ] `.blocknexus-map/` 不出现在文件管理器与备份里
- [ ] `test:agent` / `tsc` / `oxlint` / `vitest` / `build:web` 全绿
- [ ] 中文 + 英文文案齐全（类型守卫强制键集一致）

---

## 8. 预估

| 阶段 | 内容 | 相对工作量 |
|---|---|---|
| P4-1a | Anvil 读取 + NBT 解析 + 测试 | 最大（占整项约 40%） |
| P4-1b | 颜色表 + PNG 编码器 + 测试 | 中 |
| P4-1c | 协议 + 落盘缓存 + 测试 | 中 |
| P4-1d | 面板转发 + ETag | 小 |
| P4-1e | 前端 Canvas + 交互 | 中大 |
| P4-1f | 脏块更新（可选） | 小 |

**建议的提交切分**（每步独立可回滚、测试通过才进下一步）：
`P4-1a` → `P4-1b` → `P4-1c` → `P4-1d` → `P4-1e` →（按需）`P4-1f`

---

## 9. 本计划刻意没做的事

- **不引入任何第三方依赖**（Agent 侧零依赖、前端零新增）
- **不引入 wasm / Rust 构建链**
- **不下载 Minecraft client.jar** 去抽材质算色（那是 OPanel 的做法，代价是构建期依赖 + 版权问题）
- **不做实时方块事件推送**（架构上 Agent 不在游戏进程内，做不到）
- **不把地图塞进现有的文件传输通道**（PNG 走独立端点，避免与上传/下载会话互相干扰）
