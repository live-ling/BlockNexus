# OPanel 前端 Minecraft 领域与 UI 约定技术分析报告

> 分析对象：`.opanel-reference/frontend/`（Next.js + React 19 + TypeScript + Shadcn UI + Tailwind v4，构建器为 `vinext`/Vite 8 + rolldown），以及为其提供瓦片与颜色表的 `core/src/main/java/net/opanel/map/`。
> 本文只做只读剖析，所有结论均来自实际源码；路径相对 `.opanel-reference/`，引用形式为 `文件:行号`，行号为该文件内行号。
> 覆盖范围：`lib/formatting-codes/`、`lib/snbt/`、`lib/nbt/`、`lib/texture.ts` + 纹理构建管线、`lib/map/` + `wasm-lib/`、`lib/server-config/` + `lib/gamerules/`、Shadcn/Tailwind 约定、单元测试体系。
> **范围外**：`lang/*.json` 语言包内容、打包产物、后端其余业务（另有 `docs/opanel-techniques-backend.md`）。

---

## 0. 结论速览：这一层真正解决的问题

OPanel 前端最容易被低估的一点是：**它把"Minecraft 的数据表示"当成一等公民来建模，而不是当成需要用户手工填写的文本框**。具体体现为五个互相独立的子系统：

1. **文本层**：`§` legacy formatting code（含 BungeeCord/Spigot 的 `§x§R§R§G§G§B§B` 十六进制扩展）在浏览器里被解析成 DOM 树或 ANSI 序列，`§k` 用 `requestAnimationFrame` 复现游戏内的"乱码闪烁"（`lib/formatting-codes/`）。
2. **物品数据层**：`lib/snbt/` 是纯 JS 的 SNBT 解析/序列化库；`lib/nbt/` 在其上建了一个**按游戏版本分流的属性解析器**（pre-1.20.5 的 `tag` 模型 vs 1.20.5+ 的 `components` 模型），把物品的 `custom_name`/`lore`/`enchantments`/`dyed_color`/`potion_contents` 等翻译成 UI 需要的语义（`lib/nbt/`）。
3. **纹理层**：构建期把选定的 `minecraft-textures` JSON 目录编译成**字面量动态 import 表**（`virtual:textures`），运行时按"不高于服务端版本的最新纹理版本"选包（`lib/texture.ts`），未被选中的版本 JSON 完全不进 bundle。
4. **地图层**：`OffscreenCanvas` 被 transfer 进 Web Worker，Worker 内用 Rust→Wasm 解码服务端预渲染的 `OTILE`/`OTILES` 二进制并着色、贴片、合成宏瓦片（`lib/map/` + `wasm-lib/`）。
5. **配置元数据层**：`server.properties` 字段和 gamerule 被建模成带 `type`/`description`/`icon` 的 `preset` 数组，表单 schema **从服务端返回的真实数据动态生成**（`generateFormSchema`），所以既不会漏字段，也不会与游戏版本脱节（`lib/server-config/`、`lib/gamerules/`）。

UI 约定方面有两条硬性规矩写在 `AGENTS.md`（"编写对话框 dialog 时，必须单独新建 `xxx-dialog.tsx` 文件"、"使用 DataTable 组件，编写 columns 定义时，必须单独新建 `columns.tsx` 文件"），仓库里 19 个 `*dialog*.tsx`（其中 15 个是业务对话框）与 3 个 `columns.tsx` 就是这两条规矩的落地。

---

## 1. Minecraft 文本格式化：`lib/formatting-codes/`

### 1.1 `text.ts` —— HTML 与 ANSI 两条解析路径

常量表在文件顶部（`lib/formatting-codes/text.ts:1-30`）：`secSign = "§"`（`:1`）、16 个颜色码、5 个格式码（`k`/`l`/`m`/`n`/`o`，`:5`）、以及两张 ANSI 映射表（`ansiColorMap:7-24`、`ansiFormatMap:25-30`）。

`purify()`（`:33-35`）先做一件很实际的事：`text.replaceAll("\u00c2", "")`。原因写在上方注释里的 wiki 链接——**Mojang 的旧版语言文件/服务端输出存在 UTF-8 被当作 Latin-1 双重编码的 `Â` 前缀**，不清掉就会把 `§` 变成 `Â§` 从而整段解析失败。

`parseTextToHTML(text, maxLines = 1, maxCharPerLine = Infinity)`（`:40-139`）返回一个 `HTMLSpanElement`，机制是**在遍历中维护 `currentNode` 游标**而不是正则替换：

- 根节点固定 `class="cc-root"`（`:43`）；
- 换行支持两种形式：真实 `\n`（且 `lines < maxLines` 才生效）与转义的 `\n` 字面量（`:53-61`），插入 `<br>` 并重置行内计数；
- `\` 单独出现时被跳过（`:62`），这就是上面转义换行的配套处理；
- `§r` 把游标重置回根节点（`:84-88`）——**这是"颜色码重置整条链、格式码在颜色内层叠加"的关键**，测试用例 `lib/tests/formatting-codes.test.ts:73-79` 断言了 `.cc-a > .cc-l > .cc-n > .cc-o > .cc-m` 这种嵌套结构与 `§r` 后回到文本节点；
- 颜色码会先把游标重置到根（`:121-123`），格式码不会，于是产生"格式在颜色内部嵌套"的层级；
- 每个码生成 `<span class="cc-{code}">` 挂到当前游标下，游标前移（`:125-131`），样式完全交给 CSS；
- `maxCharPerLine` 用 `charAmountOfLine` 硬截断（`:132-135`），用于卡片/悬浮提示里限宽。

十六进制扩展的解析是这段代码里最讲究的部分（`:64-115`）。它先用一个 `tempRgbStr` 的中间状态机跨循环迭代收集 12 个 `§` 字符，**并且在收之前先做一次完整的 lookahead 校验**（`:94-108`）：第奇数位必须是 `§`、第偶数位必须是合法十六进制字符，任何一位不合法就整体放弃、退化成按普通码处理。这避免了"把 `§x` 后面跟的普通文本误吞 12 个字符"的经典 bug。收集完毕后在下一轮循环把颜色写成内联 `style.color = "#rrggbb"`（`:70-78`）。

`parseTextToANSI(text)`（`:144-212`）是同一套语法的终端版本，供控制台日志用：颜色码发 `\x1b[0m` 重置后再发颜色（`:184-190`），格式码**追加**到 `activeCodes`（`:192-197`），RGB 扩展发 `38;2;r;g;b`（`:172-181`），`§k` 在 ANSI 里被直接跳过（`:199-202`，终端无法实现闪烁），函数结尾补一次重置（`:208-210`）。

### 1.2 `obfuscate.ts` —— 用 rAF 复现 `§k`

游戏内 `§k` 是每帧随机替换字形。实现是 `enableObfuscate(root)`（`lib/formatting-codes/obfuscate.ts:26-32`）：在已挂载的 DOM 里 `getElementsByClassName("cc-k")`，对每个 span 注册 `requestAnimationFrame` 循环，每帧把原文按字符映射成等宽随机字符（`:8-14`）后写回 `innerText`（`:16-24`）。

细节：随机字符集分两类——`onePixel`（`|i!:;.`）与 `fivePixel`（一堆 1 像素宽以外的字符，`:5-6`），空格保持不变（`:9`）。这不是为了"好看"，而是为了**保持每帧文本宽度一致**，否则整行会抖动；同时 `cc-k` 的样式把它切到 Minecraft 的旧版 ASCII 字体（见下），保证随机字符真的存在对应字形。

### 1.3 `style/formatting-codes.css` —— 颜色码落到 Tailwind 令牌

`style/formatting-codes.css:6-96` 用嵌套选择器把 16 个颜色码映射到硬编码的 Minecraft 调色板，并且**对部分颜色做了明暗两套值**：

```css
.cc-1 { @apply dark:text-[#1515bb] text-[#00a]; }   /* 深蓝：暗色模式用更亮的蓝 */
.cc-6 { @apply dark:text-[#fa0] text-[#c78500]; }    /* 金：亮色模式压暗，避免黄底看不清 */
.cc-e { @apply dark:text-[#ff5] text-[#e9d200]; }
```

这套映射直接对应 `ansiColorMap` 的亮度取向，解决的是"游戏里在黑色背景上显示的颜色，放到白色面板背景上不可读"的问题。`.cc-l/.cc-m/.cc-n/.cc-o` 映射到 `font-semibold`/`line-through`/`underline`/`italic`（`:77-92`），`.cc-k` 使用 `--font-minecraft-ae-old`（`:94-96`）。文件头的 `@reference "tailwindcss"` 与 `@reference "./globals.css"`（`:1-2`）是 Tailwind v4 的跨文件 `@apply` 依赖声明。

### 1.4 `components/mc-text.tsx` —— React 接入方式

React 侧没有试图把解析结果转成 JSX，而是**直接操纵 DOM**（`components/mc-text.tsx:20-26`）：

```tsx
useEffect(() => {
  if(!containerRef.current) return;
  containerRef.current.innerHTML = "";
  containerRef.current.appendChild(parseTextToHTML(children, maxLines, maxCharPerLine));
  enableObfuscate(containerRef.current);
}, [children, maxLines, maxCharPerLine]);
```

容器带 `minecraftAE.className` 与 `minecraftAEOld.variable`（`:30`），即整体使用 Minecraft 的 ASCII 字体，`cc-k` 才需要切换旧版字体。为什么不做成 JSX：解析器需要**跨节点状态机**（当前颜色/格式链、RGB 收集、行计数），用 React 元素树来表达会引入大量中间结构；而这段输出本身是叶子节点，不受 React 协调影响，直接 append 更简单也更快。

从 `lib/nbt` 解析出的物品名/lore 最终也会走到这条链上——`getLore()` 返回的字符串在提示框里按普通文本渲染（见 §2.7），而经 `MinecraftText` 包装的文本（如 MOTD、玩家前缀）才会走 `§` 解析。

---

## 2. SNBT 与物品 NBT：`lib/snbt/` + `lib/nbt/`

### 2.1 先说清楚：这不是二进制 NBT 读取器

最需要明确的一点：**`lib/snbt/` 与 `lib/nbt/` 完全不解析 `.mca`/`level.dat` 那种二进制 NBT 流**。它们处理的是 **SNBT 字符串**（Stringified NBT，即 `{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}` 这种文本形式）。数据来源在 Java 侧：`core/src/main/java/net/opanel/common/OPanelInventory.java:83` 定义 `record OPanelItemStack(int slot, String id, int count, String snbt)`，即服务端把每个物品槽的 SNBT 文本（以及 `id`/`count`）通过 JSON API 发给前端（`:36`、`:77`），前端再在浏览器里解析。

`lib/snbt/README.md:9-16` 说明了出处：该目录基于 `myworldzycpc/snbt-js`（MIT）改写维护，OPanel 自己保留了 LICENSE 与版权声明。所以它的定位是"文本 NBT 工具库"，不是世界文件读取器。

### 2.2 `lib/snbt/`：解析、类型与路径

- `lib/snbt/parser.ts` 是一个手写递归下降解析器，支持 compound、list、byte/int/long array、单双引号字符串、数字后缀。`parse()` 里最有价值的是错误上下文（`lib/snbt/parser.ts:15-21`）：抛出时附带 `>>出错字符<<` 前后各 10 个字符与位置，这对"用户手搓 SNBT 后报错"的编辑场景是刚需。
- `lib/snbt/tags.ts` 的 `NbtNumber` 在构造时就按后缀做**范围钳制**（`:14-28`）：`b`→[-128,127]、`s`→[-32768,32767]、`l`→±2^63、`i`/空→四舍五入。`text()` 对 `d`/`f` 且整数值的情况补 `.1`（`:30-35`），这是为了让反序列化输出仍能被游戏当作浮点数读取。
- `lib/snbt/collections.ts` 提供 `NbtObject`/`NbtList`/`NbtByteArray`/`NbtIntArray`/`NbtLongArray`，统一接口是 `get`/`set`/`addChild`/`children` 与 `text()`（`lib/snbt/types.ts:5-7` 定义 `NbtValue { text(): string }`）。
- `lib/snbt/path.ts` 的 `parsePath` 支持 `a.b[0]."带引号的键"` 形式的路径（`:3-40`），并显式拒绝嵌套方括号（`:36`）。

### 2.3 `lib/nbt/index.ts`：按 1.20.5 分流的工厂

```ts
// lib/nbt/index.ts:6-11
export function createResolver(version: string, id: string, snbt: string): ItemNBTResolver {
  return compare(coerce(version) ?? "", coerce("1.20.5") ?? "") >= 0
    ? new ComponentsResolver(id, snbt)
    : new TagResolver(id, snbt);
}
```

这 6 行是整个物品显示的版本分水岭。1.20.5 起 Mojang 把物品数据从"`tag` 复合标签"迁移为"**数据组件（data components）**"，同一语义的键名、结构完全不同：

| 语义 | pre-1.20.5（`TagResolver`） | 1.20.5+（`ComponentsResolver`） |
|---|---|---|
| 自定义名 | `display.Name`（字符串或文本组件） | `minecraft:custom_name`（文本组件） |
| 描述 | `display.Lore`（列表） | `minecraft:lore`（列表） |
| 附魔 | `Enchantments:[{id,lvl}]`（列表） | `minecraft:enchantments.levels.<id>`（映射） |
| 耐久损耗 | `Damage` | `minecraft:damage` |
| 不可破坏 | `Unbreakable`（bool/num） | 存在即真（`minecraft:unbreakable`） |
| 药水 | `Potion` / `CustomPotionColor` | `minecraft:potion_contents.{potion,custom_color}` |
| 染色 | `display.color`（整数） | `minecraft:dyed_color`（整数或 [r,g,b] 浮点列表） |
| 堆叠上限 | 恒为 64 | `minecraft:max_stack_size`（组件可覆盖） |
| 模型 | 无 | `minecraft:item_model` |
| 地图/蜜蜂/蜂蜜 | `map`/`BlockEntityTag.Bees` | `minecraft:map_id`/`minecraft:bees`/`minecraft:block_state.honey_level` |

出处：`lib/nbt/tag-resolver.ts:26-37,48-61,71-86,96-109,112-138,160-192` 与 `lib/nbt/components-resolver.ts:47-64,90-118,120-137,186-235`。

### 2.4 `resolver.ts`：抽象基类定义"物品要回答的问题"

`lib/nbt/resolver.ts:20-61` 的 `ItemNBTResolver` 是模板方法模式的教科书用法：构造器统一做防御性解析——把 SNBT 解析成 `NbtObject`，**任何异常或非 compound 根都退化成空对象**（`:23-30`）：

```ts
try {
  const nbt = parseNbtString(snbt);
  this.nbt = nbt instanceof NbtObject ? nbt : new NbtObject();
} catch { this.nbt = new NbtObject(); }
```

这一段是整层健壮性的来源：服务端可能传来被截断的、旧版本格式的、甚至 mod 注入的畸形 SNBT，而 UI 绝不能因此白屏。`lib/tests/nbt-resolver.test.ts:33-53`（Components）与 `:96-115`（Tag）用两组 `it.each` 把 `""`、`"1"`、`"true"`、`"[]"` 以及每个字段的错类型组合全部跑一遍，断言**所有 getter 都不抛异常**——这是一个针对性极强的回归网。

基类还顺带定义了两个共享事实：`DEFAULT_MAX_STACK_SIZE = 64`（`:8`）与 `glintItems` 白名单（`:10-18`，附魔书/经验瓶/附魔金苹果/末地水晶/下界之星/成书/调试棒）。`isDyedLeatherArmor()`（`:51-58`）用"有染色颜色 + id 属于皮革四件套"来判定是否叠加染色图层——这两个先决条件缺一不可。

### 2.5 各字段的具体解析要点

- **药水颜色**（`components-resolver.ts:170-184`、`tag-resolver.ts:140-154`）：优先用 `custom_color`/`CustomPotionColor`（整数按 24 位拆 r/g/b，`:174-180`），否则查 `lib/nbt/potion-colors.ts` 的 `potionColors` 表（`:3-75`，`minecraft:water` 兜底）。`getPotionId()` 会剥掉 `long_`/`strong_` 前缀（`:167`），使同一种药水的三个变体共享颜色与名称。
- **染色皮革**（`components-resolver.ts:211-235`）：同时兼容"整数"与"三元浮点列表"两种编码，列表分支做 `Math.min(255, v * 255)`（`:229-231`）——这是组件化后 `dyed_color` 改成 `[r,g,b]` 0~1 浮点带来的差异，旧整数编码仍要支持。
- **附魔**：`ComponentsResolver` 兼容 `minecraft:enchantments` 直接是映射、或包一层 `levels`（`:56-58`）；`TagResolver` 则是列表逐项读 `id`/`lvl`（`tag-resolver.ts:28-36`）。
- **闪光（glint）**：`glintItems` 白名单 + 有附魔 + `minecraft:enchantment_glint_override`（bool 或非零数，`components-resolver.ts:129-136`）+ 有 `minecraft:lodestone_tracker`；旧版对应 `LodestoneTracked` 标签（`tag-resolver.ts:97`）。
- **堆叠上限**：只有组件版能读取（`:206-209`），旧版固定返回 64（`tag-resolver.ts:177-179`）——这是**故意不做版本猜测**的选择。
- **物品模型→纹理 id**：`itemModelToTextureId`（`components-resolver.ts:28-37`）把 `minecraft:item/stone` 这类资源路径削成 `minecraft:stone`，用来查纹理表，例子写在函数的 JSDoc 里。

### 2.6 `snbt-format.ts`：给"手改物品 NBT"用的格式化

`prettyFormatNBT`（`lib/nbt/snbt-format.ts:11-75`）和 `minifyNBT`（`:77-127`）都是**逐字符扫描 + 字符串字面量状态机**，而不是解析成 AST 再打印：

- `prettyFormatNBT` 在 `{`/`[` 后换行缩进 2 格、`:` 后补空格、`,` 后换行；关键是遇到引号进入 `strChar` 模式并处理 `\\` 转义（`:20-34`），因此**字符串内部的 `{`/`,`/`:` 不会被误判**；`{}`/`[]` 空容器保持在一行（`:38-47`）。
- `minifyNBT` 反过来：只在字符串外删除空白（`:112-125`）。

为什么不复用 `NbtObject` 再序列化：用户可能正在编辑**格式不合法或含未知结构**的 SNBT，格式化器必须在"解析失败"时也能工作。这一点在 `app/panel/players/inventory/item-dialog.test.tsx:35-42` 里被显式测试——它把 `prettyFormatNBT` 包成 `vi.fn` 以便断言调用，同时保留真实实现。

### 2.7 工具提示如何渲染名称、附魔与 lore

渲染入口是 `app/panel/players/inventory/inventory-item-tooltip.tsx` 的 `InventoryItemTooltip`（`:108-177`），它复刻了游戏内提示框的层次与配色：

- 名称：`resolvedNBT?.getName() ?? $mc(itemStack.id)`；有自定义名则 `italic`，有附魔则 `cc-b`（`:126-131`）。`getName()` 在解析器里会**先查自定义名、再查药水专用 i18n key、最后回落到原版物品名**（`components-resolver.ts:90-99`、`tag-resolver.ts:48-61`），`$mc(this.id)` 负责 `minecraft:diamond_sword → item.minecraft.diamond_sword` 的翻译。
- 附魔列表：`Array.from(getEnchantments())` 逐条渲染为 `enchantment.minecraft.<id> + " " + level`，等级 1~10 用 `enchantment.level.N` 罗马数字 key，超出范围直接显示数字（`:134-143`）。
- lore：`getLore().map(line => <span>{line}</span>)`，套 `cc-5 italic`（`:144-148`）——与游戏内"紫色斜体描述"一致。
- 附加行：不可破坏 `cc-9`、地图编号、蜂箱蜜蜂数/蜂蜜等级（用 i18n 模板 `%s` 替换，`:151-168`）。
- 最后一行为调试用的 id 行；若解析器是 `ComponentsResolver`，额外显示组件数量（`:170-174`），数据来自 `getComponentAmount()`（`components-resolver.ts:82-84`）。

一个重要事实：**lore 是按纯文本渲染的，不经过 `MinecraftText`**。所以 `getLore()` 里的 `§` 代码不会被解析成颜色（除非外层再包一层 `MinecraftText`）。`getLore()` 的文本提取走 `textComponentToString`（`lib/utils.ts:156-164`），它只处理两种形态：`NbtString` 直接返回，`NbtObject` 取 `text` 字段——**不递归处理 `extra` 子组件**。这是有意的简化：完整文本组件树（`extra`/`translate`/`with`）在提示框场景很少见，代价是遇到复杂组件时显示可能不完整。

### 2.8 `container.ts`：把容器物品也变成"可编辑的 SNBT 快照"

`lib/nbt/container.ts` 处理的是"箱子里有什么"这类容器内容，与物品本体是两条支路：

- `parseContainerNBT(snbt, itemId)`（`:196-226`）按**先新后旧**的顺序探测：有 `minecraft:container` 列表就走 `parseModernItems`（`:117-151`，读 `slot`/`item.{id,count,components}`），否则看 `BlockEntityTag.Items` 走 `parseLegacyItems`（`:153-184`，读 `Slot`/`id`/`Count`/`tag`），两者都不匹配返回 `null`。
- 尺寸不再靠猜：`VANILLA_CONTAINER_SIZES` 硬编码了原版 17 种容器的槽位数（`:23-40`，含 `_shulker_box` 通配与末影箱），未知容器按"至少 9 格、按 9 向上取整、最高不超过 256"处理（`:100-107`）。
- 序列化是反向操作（`:260-297`）：过滤掉 `minecraft:air`/`count <= 0`/越界槽位、按 slot 排序，再按 format 写回 `minecraft:container`（`createModernContainerItem`，`:235-247`，注意组件里 `NbtNumber(item.count)` 无后缀）或 `BlockEntityTag.Items`（`createLegacyContainerItem`，`:249-258`，注意 `Slot`/`Count` 带 `b` 后缀）。
- 最后统一 `prettyFormatNBT(stringifyNBT(root))`（`:296`）输出给人看。

`stringifyNBT`（`:55-65`）与 `stringifyKey`（`:51-53`）负责把键名在需要时加引号（正则 `/^[A-Za-z0-9._+-]+$/`），`quoteString`（`:42-49`）转义反斜杠/单引号/换行/回车/制表符。这保证了"编辑后回写"的文本仍能被服务端接受。

---

## 3. 物品纹理管线：`lib/texture.ts` + `vite-plugins/textures-plugin.js` + `scripts/`

### 3.1 `TEXTURE_VERSIONS` 契约与构建期校验

`scripts/texture-config.js:25-43` 是整个管线的闸门：

```js
export function resolveTextureVersions(env = process.env, production = true) {
  const value = env.TEXTURE_VERSIONS?.trim();
  if(!value && production) throw new Error("TEXTURE_VERSIONS is required for a production frontend build");
  const selected = !value || value === "all" ? availableVersions : value.split(",").map(v => v.trim());
  const invalid = selected.filter(v => !availableVersions.includes(v));
  if(invalid.length) throw new Error(`Invalid TEXTURE_VERSIONS entries: ...`);
  const resolved = [...new Set(selected)].sort(compareVersions);
  for(const version of resolved) resolveTexturePath(version);   // 逐个确认 JSON 文件真实存在
  return resolved;
}
```

规则可归纳为：

1. **生产构建必须有值**，开发构建（`production === false`）缺失或空白时默认 `all`；
2. `"all"` **必须单独出现**（`"all,26.3"` 会被判为非法，因为 `all` 不在 `availableVersions` 里）——`vite-plugins/textures-plugin.test.ts:36-42` 用 9 个非法样例覆盖了这一点，包括 `"1.20.2"`（MC 1.20.2 在纹理目录里对应的是 `1.20`，不是 `1.20.2`）、`">=1.21"`（拒绝版本范围）、`"../26.3"`（拒绝路径穿越）、`"26.3,"`/`",26.3"`/`"26.3,,26.1"`（拒绝空项）；
3. 允许列表来自 `minecraft-textures` 的 `versions`，**去重 + 按 semver 排序**；
4. 逐个调用 `resolveTexturePath`（`:10-18`）用 `require.resolve` 定位 `minecraft-textures/dist/textures/json/<version>.json`，并用 `fs.statSync().isFile()` 确认是普通文件，否则给出"Reinstall frontend dependencies"的明确提示。

`vite.config.ts:8,15` 展示了它如何接入：先 `{ ...loadEnv(mode, frontendDir, ""), ...process.env }` 合并出 env（`:8`），再把 `texturesPlugin(resolveTextureVersions(env, production))` 放进 plugins（`:15`）。**注意 `TEXTURE_VERSIONS` 没有 `VITE_` 前缀，因此不会泄漏到 `import.meta.env`**，它是纯构建期输入（`BUILDING.md:133-135`）。`vite.config.ts:16-20` 还有一条容易忽略的配置：`ssr.external: ["semver"]`，注释说明 semver 是 CommonJS，保持外部化可避免 Vite dev SSR 的模块运行器对它施加不兼容的 CJS 转换。

各平台的值来自 Gradle：`gradle.properties` 里的 `frontend_env_texture_versions` 被 Gradle 去掉前缀、转大写后作为环境变量传入（`BUILDING.md:44-48`），例如 `paper/paper-1.21/gradle.properties:6` 是 `1.21,1.21.2,1.21.4,1.21.5,1.21.6,1.21.7`，`neoforge/neoforge-1.21.1/gradle.properties:8` 是 `1.21,1.21.2`，Pumpkin 则读 `pumpkin/frontend.properties:2` 的 `TEXTURE_VERSIONS=26.3`。

### 3.2 `vite-plugins/textures-plugin.js`：字面量动态 import

```js
// vite-plugins/textures-plugin.js:11-29
export function texturesPlugin(versions) {
  const entries = versions.map((version) => {
    const file = normalizePath(resolveTexturePath(version));
    return `${JSON.stringify(version)}: () => import(${JSON.stringify(file)})`;
  });
  return {
    name: "textures-plugin",
    resolveId(id) { if(id === moduleId) return resolvedModuleId; },   // moduleId = "virtual:textures"
    load(id) { if(id === resolvedModuleId) return `export const textureLoaders = {\n${entries.join(",\n")}\n};`; },
  };
}
```

三个要点：

1. **为什么必须是"字面量"动态 import**：如果写成 `import(`../textures/${version}.json`)`，打包器无法静态分析，只能把所有版本都纳入"可能被引用"的集合（或直接报错），选了 `1.21` 却把 1.12~26.3 全部打进产物。改成把路径**字符串内联进生成的模块源码**（`JSON.stringify(file)`），打包器就能精确地只对选中的文件建立动态 chunk 边界。注释 `:12-13` 把这条写得非常直白："Literal imports keep unselected JSONs out of every build environment while preserving one lazy-loaded module per texture version."
2. **每个版本一个 lazy chunk**：这些都是 `import()`，所以每个版本形成一个独立 chunk，只有当玩家真的打开背包、且版本命中时才下载。这些 JSON 内部是 base64 贴图数据，体积可观，所以 lazy 是必需的——而不是优化。
3. **`virtual:textures` 是虚拟模块**：`resolveId` 把它映射到 `\0virtual:textures`（`:5`，`\0` 前缀是 Vite/rollup 约定，表示虚拟模块，避免被其它插件二次解析），`load` 时才生成内容。类型声明在 `env.d.ts:13-16`：

```ts
declare module 'virtual:textures' {
  import type { Item } from 'minecraft-textures';
  export const textureLoaders: Record<string, () => Promise<{ items: Item[] }>>;
}
```

### 3.3 `lib/texture.ts`：运行时的 semver 选版

```ts
// lib/texture.ts:5-18
export async function getTextures(version: string): Promise<Item[] | null> {
  let suitableVersion: string | null = null;
  for(const textureVersion of versions) {
    if(compare(coerce(textureVersion) ?? "", coerce(version) ?? "") > 0) break;
    suitableVersion = textureVersion;
  }
  if(suitableVersion == null) return null;
  const loadTextures = textureLoaders[suitableVersion];
  if(loadTextures == null) return null;
  return (await loadTextures()).items;
}
```

语义是"**取不高于服务端版本的最新纹理版本**"：`versions` 已按 semver 升序，顺序扫描到第一个超过服务端版本的就停，最后一个未超出的即答案。这样 MC 1.21.3 会命中纹理版本 `1.21.2`（因为纹理目录没有 1.21.3），而不是报错或回落到最低版本。

最后两行的 `null` 很关键，`BUILDING.md:158-162` 明确解释了设计意图：**如果运行时需要的版本没有被 bundle 进来（构建时选了别的版本），就返回 `null` 而绝不回退到另一个已打包的版本**。回退会显示错误的贴图（比如把 1.21 的贴图给 26.3 用），静默错误比明确的缺图更难排查。

调用方是 `app/panel/players/inventory/page.tsx:41-45`：拿到 `VersionContext.version` 后 `getTextures(...)` 存入 state，再通过 `InventoryTextureContext`（`contexts/inventory-texture-context.ts:4`）下发；`inventory-item.tsx:97-108` 用 `itemModelToTextureId` 优先按模型找贴图、找不到再退到按 id 找，都没有则视为 mod 物品（`:108`，`isModItem` 会禁用交互并提示）。贴图还叠加了 glint/药水/染色/皮革专用图层（`inventory-item.tsx:32-40`，样式在 `style/item-effect.css:4-24`——`.item-glint` 用 `mix-blend-color-dodge` + 6 秒位移动画，`.color-overlay` 用 `bg-blend-multiply`）。

### 3.4 构建期与运行时的闭环校验

`vite-plugins/textures-plugin.test.ts` 有两层测试：

- `:109-137` 用真实 Vite `build({ write: false })` 打一个内存包，断言**被包含的纹理模块集合恰好等于选中集合**，并且 `chunks.filter(c => c.isDynamicEntry).length === selected.length`、入口 chunk 里**没有任何**纹理模块。这是对"lazy 且不超集"这条性质最直接的证明。
- `:64-105` 反向校验各平台声明：读 `platform-modules.json` 遍历所有 target，从 `gradle.properties` 取出 `frontend_env_texture_versions`，断言它**不为 `all`**、且解析结果等于"该 target 支持的每个 MC 版本各自映射到不高于它的最新纹理版本、再去重"的集合；同时断言 helper 模块**不得**声明该属性（`:79-82`）。这样"某个平台忘了配纹理版本 / 顺手写成 all"就会在 CI 被拦住。
- `:51-61` 还起子进程跑 `scripts/build.js`，断言 `TEXTURE_VERSIONS=""` 时退出码为 1 且 stderr 含 `TEXTURE_VERSIONS is required`——即"生产漏配会在构建第一步就失败"，而不是产出静默缺贴图的包。

### 3.5 与地图资产的关系：`scripts/generate-minecraft-assets.js`

`wasm-lib/codegen/build.rs` 需要 `assets/minecraft/{blockstates,models,textures}`，这些由 `scripts/generate-minecraft-assets.js` 提供：从 Mojang `version_manifest.json` 找到最新 release，下载 `client.jar`，抽取 `assets/minecraft/textures/block/*.png`、`models/block/*.json`、`blockstates/*.json`（`:110-146`），另外从 assets index 下载并**按前缀裁剪**语言文件（`block`/`item`/`enchantment`/`effect`/`filled_map`/`container`，`:23-40`）。`scripts/build-config.js:31-48` 的 `validatePreparedFrontend` 会校验这些产物（以及 `wasm-lib/pkg/*`）存在且非空，否则报错要求先跑 `npm run prelaunch`。

---

## 4. 网页地图：`lib/map/` + `wasm-lib/`

### 4.1 线程模型：canvas 与 wasm 字节一起 transfer

主线程在 `app/panel/map/map-canvas.tsx:147-190` 里做三件事：

```tsx
const wasmResp = await fetch(wasmUrl);              // wasmUrl 来自 "@/wasm-lib/pkg/wasm_lib_bg.wasm?url"
const wasmBuffer = await wasmResp.arrayBuffer();
const offscreen = canvasRef.current.transferControlToOffscreen();
const worker = new MapTileWorker({ type: "module" });
worker.postMessage(
  { type: "init", canvas: offscreen, saveName: save, wasmModule: wasmBuffer, settings: settingsRef.current },
  [offscreen, wasmBuffer]                       // 两个都转移所有权，不复制
);
```

为什么这样做：`transferControlToOffscreen()` **每个 canvas 元素只能调用一次**（注释 `:143-150` 明确写了），所以初始化必须"每挂载一次、只做一次"，由父组件用 `key={save}` 在切换存档时整组件重挂载来获得新 canvas 和新 worker；同时把 wasm 二进制和 canvas 都用 transfer list 移交，Worker 内再 `initSync({ module: new Uint8Array(msg.wasmModule) })`（`lib/map/tile-worker.ts:86`）本地实例化——**主线程不持有第二份 wasm 实例，渲染完全不阻塞 UI**。

### 4.2 消息协议：`viewport` 与 `requestTiles` 的分离

`lib/map/tile-worker-protocol.ts` 是完整的双向协议定义，其中两条注释说明了设计的核心：

```ts
/** Pure render update. Sent during ongoing user interaction (drag, zoom in progress).
 *  Worker re-renders cached tiles but does NOT fetch new tiles. */
export interface ViewportMessage { type: "viewport"; viewport: Viewport }

/** Render + fetch. Sent at drag release, zoom step, and resize. Worker
 *  re-renders cached tiles AND issues a fetch for any uncached tiles. */
export interface RequestTilesMessage { type: "requestTiles"; viewport: Viewport }
```

其余消息：`init`（携带 `OffscreenCanvas` + `wasmModule` + `saveName` + 可选 `settings`，`:23-29`）、`setSettings`（`:31-34`）、`setFpsReporting`（`:36-39`）、`refresh`（`:60-63`）、`chunksFlush`（`:65-68`）；Worker→主线程为 `ready`/`fps`/`tilesLoaded`（`:70-95`）。`Viewport` 结构（`:7-21`）包含 `generation`、chunk 空间的小数 `camera`、`zoom`（每方块像素）、`viewportPx`（CSS 像素）和预先算好的 `tileBounds`。

Worker 内的分派（`lib/map/tile-worker.ts:53-70`）直接体现差异：

```ts
private handleViewport({ viewport }) { this.currentViewport = viewport; this.render(viewport); }
private handleRequestTiles({ viewport }) { this.currentViewport = viewport; this.render(viewport); this.loadTilesInBounds(viewport); }
```

**问题所在与收益**：拖动时每帧都改相机，如果每帧都发起瓦片请求，一次拖动会产生几十个 `POST /tiles-range`，服务端要反复读盘/打包，且响应乱序到达。把"纯重绘"和"重绘+取瓦片"拆成两种消息后，拖动过程只做 CPU/GPU 侧的重绘（用已有缓存），只有抬手、缩放步进、resize 才发请求。`hooks/use-map-tiles.ts:86-123` 在客户端再做一层 **rAF 合并 + 强度升级**：同一帧内多次 `postViewport()` 只发一条，且 `requestTiles` 优先级最高（`:81-89`，"更强的承诺"总是胜出），同时在发 `requestTiles` 时把视口写进 URL query（`:119-121`，格式 `x,z@zoom`，解析与钳制见 `:18-63`，坐标上限 200 万、zoom 钳制在 1.75~10）。

### 4.3 瓦片缓存、宏画布与请求去重

Worker 内的缓存结构（`tile-worker.ts:44-47`）：`tileCache: Map<string, ImageBitmap>`（单瓦片）、`macroCanvases: Map<string, OffscreenCanvas>`（16×16 瓦片合成的宏画布）、`inflight`/`inflightBundles`（去重集合）。

- `loadTilesInBounds`（`:161-197`）遍历 `tileBounds`，先筛掉**服务端根本没有的瓦片**（`availableTiles`，来自 `GET /api/map/{saveName}`，见 `:151-158`）、再筛掉已缓存和已在请求中的，然后把整段矩形**一次**交给 `fetchTilesInRange`（`:185`）。同一矩形已有在途请求则直接返回（`:180-182`）。
- `forceLoadTiles`（`:199-227`）是另一条通路，用于脏区块刷新：只请求**明确的坐标列表**，走 `POST /tiles`（`:216`），并允许覆盖已有缓存（`cacheTileBundle(bytes, false)`，`:219` 的 `useCache=false`）。
- `cacheTileBundle`（`:229-254`）调用 wasm 的 `render_tile_bundle_rgba`，遍历 `bundle.len()/x_at/z_at/rgba_at`，把每个 16×16 RGBA 包成 `ImageData` → `createImageBitmap`，写入缓存并 `stampTileIntoMacro`，然后如果该瓦片在当前视口内就立刻重绘（`:250-252`）——即"边到边画"。
- `stampTileIntoMacro`（`:317-329`）用 `BASE_COLOR = "#222"` 先铺底再画贴图，避免未加载区域出现透明缝隙。
- `render`（`:256-294`）只画**宏画布**：按 `MACRO_BLOCKS_PER_TILE = 16` 算出宏网格范围，`drawImage(macro, x0, y0, x1-x0, y1-y0)`。`:285-290` 的注释点出一个真实 bug 的来源——"**两端都取整**，让相邻宏共享精确像素边界；直接用小数坐标会在非整数缩放级别留下 1px 缝"。这里也是 `imageSmoothingEnabled = false` 反复重置的原因（`:85`、`:270`、`:311`），像素风地图不能有插值模糊。
- FPS 与瓦片计数通过 `setInterval` 每 200ms 上报（`:109-117`、`:331-337`），仅在 `debugMode` 下开启。

### 4.4 脏区块刷新闭环

`map-canvas.tsx:225-234` 订阅 WS 事件：

```tsx
client.subscribe("chunks-flush", ({ saveName, flushedChunks }) => {
  if(saveName !== saveRef.current) return;
  workerRef.current?.postMessage({ type: "chunksFlush", flushedChunks } satisfies MainToWorker);
});
```

Worker 收到后（`tile-worker.ts:141-149`）先按当前视口 `inBounds` 过滤，再 `forceLoadTiles` 走 `POST /tiles` 精确重取。Java 侧事件名定义在 `core/.../endpoint/MapEndpoint.java:13`（`CHUNKS_FLUSHED = "chunks-flush"`），由 `MapRenderManager` 在 flush 时通过 `EventManager` 广播（`core/.../map/MapRenderManager.java:131`）。这条链是"游戏内战破坏方块 → 面板地图自动更新"的全部机制。

### 4.5 服务端：瓦片格式与端点

**二进制格式**（`core/src/main/java/net/opanel/map/TileCompressor.java`）：

- 单个瓦片魔数 `"OTILE"`（`:18`）、瓦片束魔数 `"OTILES"`（`:19`）。
- `compressTile`（`:21-107`）顺序写出：魔数 → 调色板（u16 数量 + 每条 u8 长度 + UTF-8 字符串）→ 位压缩方块数据（**使用 `AnvilUtility.bitpack`，palette 最小 4 bit**，`:59`）→ 高度图（**先写 `heightMapBits` 一个字节，再 u16 long 数 + long 数组**，`:85-89`）→ 生物群系调色板 → 生物群系数据（`:60` 处：调色板只有 1 项时直接写 `{0L}` 占位）。
- `bundleTiles`（`:109-125`）写出 `"OTILES"` + i32 数量 + 每条 `(i64 packedCoord, i32 长度, bytes)`；坐标打包规则是 `(x << 32) | (z & 0xFFFFFFFF)`（`MapRenderManager.java:64-74`）。
- `parseBundle`（`:127-146`）是反向读取，用于启动时把磁盘上的 `.otiles` 一次性载入内存。

Wasm 侧严格对应（`wasm-lib/map-renderer/decode.rs`）：`MAGIC = b"OTILE"`（`:8`）、`BUNDLE_MAGIC = b"OTILES"`（`:9`），`decode_bundle` 逐条读 `packed i64` 后拆 `x = packed >> 32`、`z = packed as i32`（`:47-53`）。`:132-154` 有一个值得注意的兼容处理：高度图的 bit 数在新格式里是一个显式字节，旧格式没有；读之前用 `peek_u8`，若为 0 则说明这是旧格式 u16 long-count 的高字节，**不能消费它**，直接回落到 9 bit。

**端点**（`core/.../web/WebServer.java:174-180`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/map/` | 地图功能是否启用 |
| POST | `/api/map/` | 开关地图 |
| GET | `/api/map/{saveName}` | 可用瓦片坐标列表（`[x,z][]`） |
| POST | `/api/map/{saveName}/tiles-range` | 矩形范围内所有存在瓦片，打包成 OTILES |
| POST | `/api/map/{saveName}/tiles` | 指定坐标列表的瓦片，打包成 OTILES |

`MapController.getTilesInRange`（`.../controller/api/MapController.java:103-155`）会先规范化 min/max（`:119-122`）、按 `getAvailableTileCoords` 过滤（`:124-136`）、再算 ETag：

```java
String etag = "\"tiles-"+ manager.getIndexVersion(saveName) +"-"+ computeBundleHash(presentTiles) +"\"";
ctx.header("Cache-Control", "private, max-age=10");
if(handleEtag(ctx, etag)) { sendResponse(ctx, HttpStatus.NOT_MODIFIED); return; }
```

ETag 由"索引版本号（每次重载 bundle 自增，`MapRenderManager.java:186`）+ 集合内 `(coord, length)` 序列的 md5（`MapController.java:208-214`）"组成，命中即 `304`，避免拖动后重复传输未变化的瓦片。**注意 ETag 用的是 `length` 而不是内容哈希**——对"同长度但内容变了"的极端情况会漏判，但其窗口被 `max-age=10` 与索引版本号限制住。

`MapRenderManager` 的渲染/落盘策略（`:31-209`）：启动时对每个运行中的存档，若已有 `.otiles` 就异步 `loadTileBundle` 载入内存（`:88-89`），否则 `renderSave` 全量预渲染后写盘（`:91-93`）；后台 `scheduler.scheduleWithFixedDelay(flushDirtyChunks, 5000, 5000)`（`:97-102`）每 5 秒排空一次脏区块（**每批上限 `MAX_CHUNKS_PER_FLUSH = 64`**，`:36`、`:116`），逐块调用 `accessor.readLiveTile` 重渲染（`:124-128`），并把 flush 的区块通过事件广播出去（`:131`）；落盘用 `scheduleBundleWrite` 做 **5 秒去抖**（`:37`、`:139-150`），写文件走 `tmp → Files.move(REPLACE_EXISTING)` 的原子替换（`:202-205`）。

### 4.6 Rust Wasm 库的职责与导出 API

`frontend/wasm-lib/Cargo.toml:5` 指定 `build = "codegen/build.rs"`，`lib.path = "map-renderer/lib.rs"`，crate-type 为 `["cdylib","rlib"]`；发布 profile 用 `opt-level = "z"` + `lto = true` + `codegen-units = 1`（`:27-29`）——冲着体积去的。构建由 `scripts/build-wasm.js:37-53` 驱动：`wasm-pack build ... --target web --out-dir pkg --release`，并用"crate 目录内最新 mtime 是否新于 `pkg/wasm_lib_bg.wasm`"来决定是否跳过（`:29-35`，忽略 `target`/`pkg`）。

导出 API（`wasm-lib/map-renderer/lib.rs`）：

| 导出 | 位置 | 说明 |
|---|---|---|
| `render_tile_rgba(bytes, biome_coloring, render_shadows) -> Box<[u8]>` | `:52-56` | 解码单个 `.otile` 并渲染为 16×16 RGBA（1024 字节，行主序） |
| `render_tile_bundle_rgba(bytes, biome_coloring, render_shadows) -> TileBundle` | `:61-73` | 解码 `.otiles` 并把每条都渲染好，返回句柄 |
| `TileBundle::{len, x_at(i), z_at(i), rgba_at(i)}` | `:19-36` | JS 侧遍历接口（`rgba_at` 返回 `Box<[u8]>` 的克隆） |
| `init_panic_hook()` | `:43-47` | 把 Rust panic 转成可读的 JS 异常 |
| `#[wasm_bindgen(start)] init()` | `:38-41` | 初始化 `wasm_logger` |

三大职责具体落点：

1. **方块纹理数据解析 / 颜色表生成（构建期，Rust build script）**：`codegen/build.rs:27-118` 遍历 `assets/minecraft/blockstates/*.json`，对每个方块：跳过 `water`/`grass_block`（它们靠生物群系着色，`:77-79`）→ `pick_model` 取第一个 variant（或 multipart 的第一项）的 `model`（`:128-151`）→ `pick_texture` 按 `top → bottom → side → inside` 优先级取贴图，并解析一层模型内 `#ref` 引用、兼容 `{"sprite": ...}` 对象形式（`:24-25`、`:156-192`）→ 用 `png` crate 读 PNG 并**逐像素求平均（跳过 alpha=0）**，对树叶先按 `LEAF_TINTS` 着色再平均（`:14-22`、`:94-95`）→ `shade_rgba` 生成 4 档明暗（`:96`）→ 写入 `phf_codegen` 静态表，输出到 `$OUT_DIR/colors.rs`（`:110-117`）。`palette.rs:1` 用 `include!` 把它引入。**结果是一张编译进 wasm 的 O(1) 方块→4 档 RGBA 查找表**，运行时零解析、零 IO。
2. **地图着色（运行期）**：`render.rs:14-51` 逐像素取方块 id 与生物群系 id，`air` 直接留 alpha=0（`:24-27`），`grass_block`/`water` 在开启 `biome_coloring` 时走生物群系着色表（`:29-35`），其余走 `palette::lookup(id)`；`lookup`（`palette.rs:153-163`）在精确匹配失败时**会剥掉 `[axis=y]` 之类的 blockstate 后缀再查一次**，最终仍失败则返回品红（`:3`）——"用刺眼的品红把缺表项暴露出来"比默默画黑块更容易发现。
3. **生物群系颜色表**：`GRASS_COLORS`/`WATER_COLORS` 两张 `phf::Map`（`palette.rs:6-145`）来自 Minecraft Wiki 的气候列表，未知生物群系各自回落到 `DEFAULT_GRASS_COLOR = [0x91,0xbd,0x59,0xff]` / `DEFAULT_WATER_COLOR = [0x3f,0x76,0xe4,0xff]`（`:165-179`）。

**阴影规则**值得一提（`render.rs:56-72`）：明暗档（0 最亮 ~ 3 最暗）不是按绝对高度，而是**当前方块与其北侧邻居（z-1）的高度差**：`diff > 0 → 0`、`== 0 → 1`、`> -2 → 2`、否则 `3`；`z == 0` 时把 z 抬到 1 以避免越界。这就是原版地图物品的明暗规则，所以面板地图与游戏内地图观感一致。`utils.rs:5` 的 `SHADES = [1.0, 0.8, 0.5, 0.4]` 是这四档的乘数；`utils.rs:27-70` 提供 `bitpack`/`bitunpack`/`palette_size_to_bits_size`，与 Java 的 `AnvilUtility` 位打包规则对齐（`decode.rs:77` 对调色板设最低 4 bit）。

---

## 5. 配置元数据：`server.properties` 与 gamerules presets

### 5.1 数据结构：`preset` 只描述"怎么展示"，不描述"当前值"

`lib/server-config/index.ts:4-11`：

```ts
export interface Property {
  id: string
  description: string
  type: "boolean" | "number" | "string"
  icon?: LucideIcon
}
export type ServerProperties = Record<string, boolean | number | string>;
```

`lib/gamerules/index.ts:4-12` 是它的镜像，只是把 `description` 换成必填的 `name`、`type` 收窄为 `"boolean" | "number"`：

```ts
export interface Gamerule {
  id: string; name: string; description?: string
  type: "boolean" | "number"; icon?: LucideIcon
}
export type ServerGamerules = Record<string, boolean | number>;
```

`server-config/presets.ts:5-427` 是 73 条 `Property` 的数组（按 `id` 字典序排列，与 wiki 的 `server.properties` 词条对照，注释 `:4` 给出 zh.minecraft.wiki 链接），每条带中文说明与可选的 lucide 图标；`gamerules/presets.ts:5` 起是 59 条 `Gamerule`。这个数组**只描述字段本身**（名称、类型、说明、图标），当前值是运行时从服务端拉的。

### 5.2 表单 schema 从真实数据动态生成

```ts
// lib/server-config/index.ts:13-23
export function generateFormSchema(properties: ServerProperties): z.ZodObject<z.ZodRawShape> {
  const schemeList: z.ZodRawShape = {};
  for(const key in properties) {
    schemeList[key] = typeof properties[key] === "boolean" ? z.boolean() : z.number().or(z.string());
  }
  return z.object(schemeList);
}
```

`gamerules/index.ts:14-24` 是同一实现。**注意循环遍历的是传入的 `properties`（服务端真实返回的字段集），不是 preset 数组**。这带来三个直接好处：

1. **不会漏字段**：Mojang 新增一个属性时，即使 preset 还没补说明，表单也会照常渲染出来（只是没有图标和描述）；
2. **不会被 preset 里的过时字段误导**：某个版本删掉的属性不会凭空出现在表单里；
3. 校验规则与实际值的类型绑定，布尔就是 `z.boolean()`，数字与字符串互相兼容（因为 `server.properties` 里数字也是文本，需要双接受）。

`app/panel/dashboard/server-sheet.tsx:57-106` 展示了完整的读取/回写：

- 读：`GET /api/control/properties` 返回 base64 的原始文本（`:59-60`）→ `base64ToString` → `new Properties(raw).toObject()`（`:61`，用 `properties-file` 库）→ **逐字段做类型推断**：`"true"/"false"` → boolean，`isNumeric` → Number，其余为字符串并把换行转成字面量 `\n`（`:62-71`）；
- 写：反向拼回 `key=value\n`（字符串里的 `\n` 还原），整体 base64 后 `POST /api/control/properties`（`:82-106`），成功后弹"需要重启"提示（`openRestartAlert()`，`:99`，来自 `hooks/use-restart-alert`）。

### 5.3 UI 如何从 preset 渲染表单

`server-sheet.tsx:124-175` 的循环：

```tsx
{Array.from(propertiesMap).map(([key, value]) => {
  const preset = serverPropertiesPresets.find(({ id }) => id === key);
  if(key === "motd") return <Fragment key={key}/>;               // motd 有专门的编辑器，这里跳过
  return (
    <FormField ... render={({ field }) => (
      <Item>
        <ItemContent>
          <ItemTitle>{(preset?.icon) && <preset.icon size={17}/>}{key}</ItemTitle>
          {preset && <ItemDescription>{preset.description}</ItemDescription>}
          <FormMessage />
        </ItemContent>
        <ItemActions>
          {typeof value === "boolean" ? <Switch .../>
           : typeof value === "number" ? <Input type="number" .../>
           : <Input .../>}
        </ItemActions>
      </Item>
    )}/>
  );
})}
```

三点值得注意：**控件类型由实际值类型决定**（`typeof value`），而不是由 preset 的 `type` 决定——preset 只负责展示信息；`FormField` 上带 `defaultValue=""` 与注释指向 react-hook-form 的一个已知 issue（`:134`、gamerules/page.tsx:183`）；`Item`/`ItemActions` 是 Shadcn 的列表项组合件，天然形成"左说明右控件"的设置项布局。

gamerules 页（`app/panel/gamerules/page.tsx`）在此基础上多了四件事：

- **版本分流**（`:53-58`）：`compare(versionCtx.version, "1.21.11") < 0` 时用 `_gamerulePresetsOld`。
- **维度切换**（`:59-63`、`:149-169`）：维度存 URL query（`?dim=...`，`:112-121`），因为不同维度的 gamerule 集不同（`GET /api/gamerules/{dimension}`，`:76`）。
- **搜索**（`:143-148`、`:192`）：用 `searchString` 过滤 key，注意**同时支持隐藏不匹配项与工具提示显示中文名**（`:200-204`）。
- **提交前的类型回正**（`:92-98`）：`Input type=number` 仍然给字符串，提交前 `isNumeric` 则 `parseFloat`。

还有一个容易忽略但很关键的匹配条件（`:179`）：

```tsx
const preset = gamerulePresets.find(({ id, type }) => (id === key && typeof value === type));
```

**id 与类型都要匹配**才采用 preset。这样如果某个 gamerule 在新版本里从布尔改成了数字，旧 preset 的说明不会被错误地贴到一个语义已经变化（或同名不同类型）的字段上。

### 5.4 版本差异：`presets.ts` vs `presets-old.ts`

两文件的区别不只是增删，而是**命名风格的世代更替**（对照 `lib/gamerules/presets.ts` 与 `lib/gamerules/presets-old.ts`，脚本比对结果）：

- 新版 59 条全部是 **snake_case**（`advance_time`、`block_drops`、`max_minecart_speed`、`players_sleeping_percentage`），对应 1.21.11 起游戏侧改用的新命名；
- 旧版 61 条全部是 **camelCase**（`doDaylightCycle`、`doMobLoot`、`maxCommandChainLength`、`spawnRadius`）；
- 语义也重命名了，例如 `doDaylightCycle → advance_time`、`doWeatherCycle → advance_weather`、`doMobSpawning → spawn_mobs`、`doInsomnia → spawn_phantoms`、`announceAdvancements → show_advancement_messages`、`maxCommandChainLength → max_command_sequence_length`、`snowAccumulationHeight → max_snow_accumulation_height`、`spawnChunkRadius → respawn_radius`；
- 两版 id 集合只有极少数同名，**改名、新增、删除三者交织**（`presets.ts` 独有的 59 条与 `presets-old.ts` 独有的 61 条几乎不重叠）；旧版独有的 `disableRaids`、`doInsomnia`、`spawnChunkRadius` 在新版分别对应 `raids`、`spawn_phantoms`、`respawn_radius`，而新版新增了 `elytra_movement_check`、`lava_source_conversion`、`max_snow_accumulation_height`、`player_movement_check`、`projectiles_can_break_blocks` 等规则。

之所以要维护两份而不是"一份 + 映射表"：**差异是双向的**（既有改名也有删除和新增），映射表要处理"目标不存在"的情况，反而更复杂；而两份静态数组的维护成本低、类型检查友好。选择逻辑集中在一处（`gamerules/page.tsx:53-58` 的 semver 比较），没有散落到组件里。

### 5.5 与"朴素文本编辑器"方案的对比

朴素方案是给一个 textarea 让用户直接编辑 `server.properties` / 用命令改 gamerule。preset 方案解决了以下问题：

| 问题 | 朴素文本编辑器 | preset + 动态 schema |
|---|---|---|
| 类型错误 | `max-players=true`、`pvp=3` 都能写进去，服务端启动时才炸 | 控件类型由值类型决定，boolean 只能是 Switch，number 走数字输入 |
| 布尔值拼写 | `True`/`TRUE`/`yes`/`1` 各种写法都能出现，行为不一致 | 统一由 Switch 产生 `true`/`false` |
| 字段发现 | 73 个属性要靠记忆或翻 wiki，新手不知道有哪些 | 全部列出，带中文说明与图标，支持搜索 |
| 版本漂移 | 旧文档教用户改已删除的字段 | schema 从服务端实际返回值生成，字段集永远与当前版本一致；gamerule 的说明按版本分流 |
| 重启提示 | 用户不知道为什么没生效 | 保存后显式提示需要重启（`openRestartAlert`） |
| 换行/转义 | 手写 `\n` 容易破坏文件解析 | 读入时 `\n → \\n`、写出时反向还原（`server-sheet.tsx:69,88`） |

代价是必须维护 preset 的中文说明与图标（73+59 条），但这是**一次性成本 + 新增字段时补一行**，且 `description` 缺失时 UI 仍能正常渲染（`preset` 可能为 `undefined`，代码里所有使用处都有 `preset &&` / `preset?.` 保护）。

---

## 6. Shadcn/Tailwind 与两条强制文件布局约定

### 6.1 Shadcn 配置

`components.json:1-21`：`style: "new-york"`、`rsc: true`、Tailwind `baseColor: "neutral"` + `cssVariables: true`、`iconLibrary: "lucide"`，别名 `@/components`、`@/components/ui`、`@/lib`、`@/lib/utils`、`@/hooks`。UI 组件本体在 `components/ui/`（含 Shadcn 原生 `dialog.tsx`/`alert-dialog.tsx`，`@radix-ui/*` 为底层，`package.json:24-34`）。

**一个需要留意的落差**：`components.json:8` 写的 `css: "app/globals.css"`，但仓库里**没有** `app/globals.css`——实际主题文件是 `style/globals.css`，由 `app/layout.tsx:2-3` 直接 import：

```tsx
import "@/style/globals.css";
import "@/style/formatting-codes.css";
```

也就是说 `components.json` 的 `css` 字段与真实路径不一致（`shadcn add` 时会找不到目标文件）。如果要在 BlockNexus 里复用这套主题，应把 `css` 改成 `style/globals.css`。

### 6.2 主题令牌与暗色策略

`style/globals.css` 是 Tailwind v4 的 CSS-first 配置（**没有 `tailwind.config.js`**，`components.json:7` 的 `config` 为空字符串正是这个原因）：

- `@import "tailwindcss"` + `tw-animate-css` + 本地 `lib.css`/`markdown.css`（`:1-4`），并用 `@plugin "tailwind-scrollbar"` 以插件形式配置滚动条（`:6-9`，`preferredStrategy: "pseudoelements"`）；
- **暗色变体**：`@custom-variant dark (&:is(.dark *));`（`:11`），即 class 策略而非 media 策略。切换器是 `next-themes` 的 `ThemeProvider`（`app/layout.tsx:28-32`，`attribute="class"`、`defaultTheme="system"`、`enableSystem`、`disableTransitionOnChange`），`<html suppressHydrationWarning>`（`:24`）避免 SSR/CSR 主题不一致告警；
- `@theme inline { ... }`（`:13-55`）把 CSS 变量映射成 Tailwind 主题令牌（`--color-background: var(--background)` 等），包含 Shadcn 全套（background/foreground/card/popover/primary/secondary/muted/accent/destructive/border/input/ring/chart-1..5/sidebar-*/radius-*）**加上项目特有的一层**：`--color-highlight-primary`（选中态）与 `--color-theme`/`--color-theme-hovered`（品牌色，`:49-50`）；
- `:root`（`:57-94`）与 `.dark`（`:96-132`）给出两套 oklch 值。品牌色刻意分成两种媒介：亮色模式 `--theme: #7f4c26`（棕），暗色模式 `--theme: #f89d13`（橙）——**不是简单的明暗翻转，而是换色**，因为棕色在深色背景上几乎不可见。`--highlight-primary` 同理（`:67` vs `:105`，蓝色在暗色下压暗）。
- `@layer base`（`:134+`）统一 `border-border`/`outline-ring/50` 与 body 背景前景色。

Minecraft 相关的样式没有堆进 globals.css，而是拆成 `style/formatting-codes.css`（§ 代码，见 §1.3）与 `style/item-effect.css`（`.item-glint`/`.color-overlay`，见 §3.3）。后两者都用 `@reference "./globals.css"` 声明依赖（`item-effect.css:2`），以便在独立文件里使用主题令牌做 `@apply`。

### 6.3 约定一：对话框必须独立成 `xxx-dialog.tsx`

`AGENTS.md` 的原话是"编写对话框 dialog 时，必须单独新建 xxx-dialog.tsx 文件"。仓库共 19 个匹配 `*dialog*.tsx` 的文件，其中 **15 个是业务对话框**（另 2 个是 Shadcn 基础件 `components/ui/dialog.tsx`、`components/ui/alert-dialog.tsx`，另 2 个是对话框自己的测试 `item-dialog.test.tsx`、`task-template-dialog.test.tsx`）：

```
app/login/oidc-bind-dialog.tsx
app/panel/code-of-conduct/create-coc-dialog.tsx
app/panel/dashboard/favicon-dialog.tsx
app/panel/map/coord-dialog.tsx
app/panel/mcp/generate-token-dialog.tsx
app/panel/players/banned-ips-dialog.tsx
app/panel/players/inventory/item-dialog.tsx     (+ item-dialog.test.tsx)
app/panel/plugins/plugin-dialog.tsx
app/panel/saves/datapacks-dialog.tsx
app/panel/settings/launch-command-dialog.tsx
app/panel/settings/login-banner-dialog.tsx
app/panel/settings/security-dialog.tsx
app/panel/settings/update-dialog.tsx
app/panel/tasks/task-template-dialog.tsx        (+ task-template-dialog.test.tsx)
app/panel/terminal/create-shortcut-dialog.tsx
```

**布局规律**（以 `app/panel/dashboard/favicon-dialog.tsx` 为例）：文件与使用它的页面/组件**同目录**，命名用 kebab-case，导出的是同名 PascalCase 组件（`FaviconDialog`，`:23`），统一接受 `PropsWithChildren & { asChild?: boolean }`（`:23-28`），这样调用方可以 `<FaviconDialog asChild><Button/></FaviconDialog>` 把任意元素变成触发器（内部 `SheetTrigger/DialogTrigger asChild` 模式）。对话框状态（`dialogOpen`、临时文件、预览 URL）全部封装在文件内（`:30-33`），成功后通过 `emitter.emit("refresh-data")`（`:38`）通知外部刷新——**这是本地文件里的"刷新"唯一通道**（`lib/emitter.ts` 的全局单例 EventEmitter，仅一个 `refresh-data` 事件）。

为什么这条约定有价值：对话框通常包含表单状态、校验、异步上传/提交、失败映射（如 `favicon-dialog.tsx:41-45` 用 `toastError(e, msg, [[400, ...], [401, ...], [500, ...]])`），塞进页面组件会让页面函数迅速失控；独立文件还让对话框可以单独写测试（`item-dialog.test.tsx` 就是一个 441 行的独立测试）。

### 6.4 约定二：DataTable 的列定义必须独立成 `columns.tsx`

`AGENTS.md`："使用 DataTable 组件，编写 columns 定义时，必须单独新建 columns.tsx 文件"。对应实现是 `components/data-table.tsx`（`@tanstack/react-table` 的薄封装，`:27-59` 接收 `columns: ColumnDef<D, V>[]`、可选分页、`columnVisibility`、`fallbackMessage`；分页状态可同步到 URL query，`:61-70`）。

三处落地：

| 目录 | 导出 | 消费方 |
|---|---|---|
| `app/panel/players/columns.tsx` | `playerColumns`、`bannedColumns` | `app/panel/players/page.tsx:11,302,316` |
| `app/panel/logs/columns.tsx` | `columns` | `app/panel/logs/page.tsx:11,216` |
| `app/panel/plugins/columns.tsx` | `enabledPluginColumns`、`disabledPluginColumns` | `app/panel/plugins/page.tsx:19,318,326` |

**一个文件可以导出多组列**（players 的"玩家列表"与"封禁列表"、plugins 的"已启用"与"已禁用"共用同一行类型），这样两处表格的列定义放在一起便于对照维护。文件内还会就近定义列专用的私有子组件（`players/columns.tsx:24-63` 的 `PlayerAvatar`/`PlayerHoverInfo`），因为它们只被单元格渲染器使用，没有第二个消费者。

内容形态上，`ColumnDef` 的 `accessorKey` 指向行对象字段，`header` 与 `cell` 都用 `$()` 取 i18n 文案（`players/columns.tsx:68,100,117`），操作列没有 `accessorKey`（`:150-230`），直接在 `cell` 里放按钮并调用 `player-utils` 的动作函数。空字段用"空串 header + 空串 cell"隐藏（`:110-114`、`:264-268`，uuid 列），这是该 DataTable 封装下的惯用写法（列仍存在但可见性交给 `columnVisibility`）。所有行内动作完成后统一 `emitter.emit("refresh-data")`（`:165,177,199,217,292`），与对话框保持同一刷新机制。

为什么列定义要独立成文件：列定义往往会引入图标、Badge、按钮、链接、i18n、甚至 `PlayerSheet` 这类交互组件（`columns.tsx:8-17` 的 import 就有 8 行），而页面组件关心的是取数与布局。分开后页面只剩"DataTable + data"，列定义可以独立演进，也避免页面文件因为列定义而膨胀到几百行。

---

## 7. 单元测试体系

### 7.1 技术栈与配置

`package.json:10-18` 的脚本：`test: "vitest run"`、`test:watch: "vitest"`、`lint: "oxlint ."`、`typecheck: "tsc --noEmit"`、`wasm:test: "cd wasm-lib && cargo test -p wasm-lib"`。值得注意的是**前端改完只要 oxlint + tsc，不需要全量构建**（`AGENTS.md`），Rust 侧则有独立的 cargo 测试（`wasm-lib/tests/decode.rs`、`palette.rs`、`render.rs`，其中 `decode.rs:6,27` 手工构造 `OTILES`/`OTILE` 字节流）。

`vitest.config.ts` 是关键（`:10-30`）：

```ts
export default defineConfig({
  resolve: { alias: {
    "@/style/item-effect.css": path.resolve(__dirname, "test/style-stub.ts"),
    "@": path.resolve(__dirname, "."),
    "next/dynamic": "vinext/shims/dynamic",
    "next/font/local": "vinext/shims/font-local",
    "next/link": "vinext/shims/link",
    "next/navigation": "vinext/shims/navigation",
  }},
  test: {
    environment: "jsdom",
    env: { VITE_OPANEL_VERSION: "0.1.0", VITE_OPANEL_TARGET: "paper-26.1" },
    setupFiles: ["./test/setup.tsx"]
  },
  plugins: [react(), texturesPlugin(resolveTextureVersions({ TEXTURE_VERSIONS: "all" }))]
});
```

要点：

1. **测试里也挂真实的 `texturesPlugin`，且强制 `TEXTURE_VERSIONS: "all"`**（`:29`）——所以任何测试都可以 `import { textureLoaders } from "virtual:textures"` 而不必 mock，同时避免测试依赖开发者本地的 env 配置。
2. `next/*` 一律 alias 到 `vinext/shims/*`（`:15-18`），这解释了为什么测试可以直接对使用了 `next/navigation`/`next/link` 的组件 `render`。
3. `@/style/item-effect.css` 被替换成 stub（`:13`），因为 jsdom 不处理 CSS；`test/style-stub.ts` 只有 12 字节。
4. `environment: "jsdom"` 是全局默认；需要 node 环境的测试在文件头加 `// @vitest-environment node`（`vite-plugins/textures-plugin.test.ts:1`）。
5. `env` 注入了 `VITE_OPANEL_VERSION`/`VITE_OPANEL_TARGET`（`:23-26`），覆盖了 `vite.config.ts:13` 的 `define` 需求。

### 7.2 `test/setup.tsx`：全局 mock

`test/setup.tsx` 做了五件事：

```tsx
import "@testing-library/jest-dom/vitest";                              // :1  自定义匹配器（toBeInTheDocument 等）
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => isMobileMockState.current }));   // :5-7 可切换的移动端开关
vi.mock("next/font/local", () => ({ default: () => ({ className: "mocked-font-class", ... }) }));  // :9-15
vi.mock("@/lib/i18n", () => ({ $: (id, ...args) => `[${id}]${...}`, $mc, localize, localizeRich }));  // :17-22
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), ... } }));            // :24-31
vi.mock("@/components/monaco-editor", () => ({ default: MockMonacoEditor }));              // :33-54
```

- **i18n mock 的核心设计**：`$(id)` 返回 `` `[${id}]` ``，带参数则追加 `(args...)`。于是测试可以用 `screen.getByText("[gamerules.title]")` 这类**与语言无关**的断言，而不必维护中文字符串。
- **Monaco 被替换成 `<textarea data-testid="monaco-editor" data-theme={theme}>`**（`:44-52`），把 `value`/`onChange`/`readOnly` 透传——这样编辑器相关交互可以用 `fireEvent`/`userEvent` 正常测试，而不需要在 jsdom 里跑真正的 Monaco。
- **`useIsMobile` 的 mock 通过 `isMobileMockState.current` 这个可变引用桥接**（`:3`、`:6`），使测试可以动态切换响应式分支。

### 7.3 `test/test-helper.tsx` 与其它定制工具

`test/test-helper.tsx` 本身只有 9 行，导出 `mockUseIsMobile(initialValue = false)` 与 `setMockUseIsMobile(value)`——前者用于 `beforeEach` 设置初值，后者用于测试中途切换（配合上面的 `mock-state.ts`）。

同目录还有三个更有分量的 helper（`AGENTS.md` 明确要求"在有需要的时候可以直接使用，而不是编写重复的冗余代码"）：

- `test/contexts-helper.ts:3-15` 的 `createMockVersionContext(overrides)`：返回完整的 `APIResponse<VersionResponse>`（`serverType: "Paper"`、`version: "1.21.11"`、`map/mcdr/codeOfConduct/...` 全给默认值），省掉每个测试手写 Context 对象。
- `test/inventory-helper.ts`：`createItem`（`:8-15`）、`createInventoryData(size)`（`:17-23`，自动填 `minecraft:air` 空槽）、`createInventory`（`:25-33`，36 主背包 + 5 装备 + 27 末影箱）、`createMockInventoryTextures()`（`:35-41`，`Item[]` mock）、`createMockInventoryTooltipContextValue()`（`:43-52`，三个 `vi.fn()`）、以及 `createMockInventoryWsClient()`（`:54-81`，一个**带 `emit` 的假 WS 客户端**，可让测试主动触发服务端推送）。
- `test/terminal-helper.ts`（1.1 KB，终端相关 fixture）。

### 7.4 i18n mock 的"不是 100% 生效"坑

这是 OPanel 测试里最需要注意的一条，`AGENTS.md` 专门写了：

> 由于文件加载顺序的问题，i18n 方面的 mock（见 `frontend/test/setup.ts` 中对 `@/lib/i18n` 的 mock）并不是 100% 生效。一般情况下，测试中还是直接使用 `[i18n_id]`（mock 过）的写法，如果因为组件在 i18n 被 mock 前被加载导致 mock 不生效，以致测试不通过，再改成正则表达式同时匹配 `[i18n_id]` 和实际中文文本的写法。

机制上的原因：`setupFiles` 里的 `vi.mock` 只对**在其之后被 import 的模块**生效；如果某个测试文件（或它 import 的某个模块）在 setup 生效之前就已经把 `@/lib/i18n` 加载进模块图，那里的 `$` 就仍是真实实现，渲染出的是中文。此时 `getByText("[dialog.save]")` 找不到节点。

仓库里的标准应对就是**双匹配正则**，`app/panel/players/inventory/item-dialog.test.tsx` 是范例（该文件也正是 `AGENTS.md` 指名参考的文件）：

```tsx
// item-dialog.test.tsx:171,183,298,313,319,348,353,361,406,422
await user.click(screen.getByRole("button", { name: /(\[dialog\.save\]|保存)/ }));
await user.click(screen.getByRole("button", { name: /(\[dialog\.cancel\]|取消)/ }));
```

值得注意的细节：这个文件**同时**做了本地 i18n mock（`:21-29`，用 `vi.importActual` 展开真实模块后覆盖 `$`/`localize`/`localizeRich`）与正则双匹配。这说明本地 mock 能覆盖大部分情况，但**组件树深处（例如被其他模块提前 import 的组件）仍可能拿到真实 i18n**，正则才是最终的兜底手段。作为对照，该文件还 mock 了 `next-themes`（`:31-33`，固定 `theme: "dark"`）与 `@/lib/nbt/snbt-format`（`:35-42`，把 `prettyFormatNBT` 包成 `vi.fn` 但保留真实实现，以便断言"格式化被调用过"）。

### 7.5 两个真实测试文件的取向

- `lib/tests/nbt-resolver.test.ts`（145 行）代表"**防御性边界测试**"：用 `it.each` 把畸形 SNBT 与错类型逐字段跑一遍，断言不抛异常（`:33-53`、`:96-115`）；再用具体样例断言正确性（`:62-75` 附魔/耐久/glint、`:124-138` 旧版自定义名/lore/Unbreakable）。这类测试的价值在于**把服务端可能发来的任意脏数据变成不会白屏**。
- `vite-plugins/textures-plugin.test.ts`（138 行）代表"**构建契约测试**"：既验证配置校验规则（`:17-62`），又用真实 Vite 构建验证"只有选中版本进包、且都是 dynamic entry"（`:108-137`），还横跨全部平台模块校验 `gradle.properties` 声明（`:72-106`）。这类测试防的是"有人改了一行构建配置，包体悄悄翻十倍"这种代码审查很难发现的回归。

React 组件测试的强制约定是文件开头声明 `afterEach(() => cleanup())`（`AGENTS.md`），用来避免 jsdom 里多个测试的 DOM 污染。

---

## 8. 可以迁移到 BlockNexus 的要点（按收益排序）

1. **`virtual:*` 虚拟模块生成字面量动态 import** 是"多版本大体积静态数据"的通用解法：只要数据能按版本切成文件，就能做到"构建期只选需要的那几份、运行期按需 lazy 加载"，且构建期可校验。BlockNexus 若要做多版本材质/汉化/图标，这套 `scripts/xxx-config.js`（校验 + 排序）+ `vite-plugins/xxx-plugin.js`（生成 import 表）+ `env.d.ts` 类型声明三件套可直接照搬。
2. **版本分流的解析器工厂**（`compare(version, "1.20.5")` 决定 `ComponentsResolver` 还是 `TagResolver`）比散落各处的 `if (version)` 更好维护：抽象基类把"要回答哪些问题"固定下来，两个实现各自逐字段回答，防御性解析集中在基类构造器。
3. **`generateFormSchema(actualData)` 而不是 `generateFormSchema(presets)`**：让元数据只负责展示、真实数据负责字段集与校验，可以从根上避免"游戏更新了字段但面板的表单漏了/多了"。
4. **元数据与值类型双重匹配**（`id === key && typeof value === type`）是一个便宜且有效的保护，防止版本更替后把旧说明贴到语义已变的字段上。
5. **Worker 消息按"是否取数据"拆分**（`viewport` vs `requestTiles`）+ 客户端 rAF 合并 + 请求去重，是任何"拖动/缩放频繁取数"场景的通用模式，与 Minecraft 无关。
6. **`OffscreenCanvas` + wasm 字节一次性 transfer 进 Worker**，并把"只能 transfer 一次"这个限制转化为"父组件用 `key` 强制重挂载"的清晰契约。
7. **构建期 Rust build script 预计算查找表**（方块→4 档 RGBA 的 `phf` 表）：把"几千次 JSON 解析 + PNG 平均"从运行期搬到编译期，运行期只剩 O(1) 查表。凡是"静态、体积可控、查询频繁"的映射表都适用。
8. **两条文件布局约定**（`xxx-dialog.tsx`、`columns.tsx`）配合 `emitter.emit("refresh-data")` 这个单事件刷新通道，把"页面"与"交互细节/表格列"解耦，是目前 BlockNexus 前端最容易直接采用的一条经验。

---

## 9. 需要注意的坑与已知取舍（源码证据）

1. **`components.json:8` 的 `tailwind.css` 指向不存在的 `app/globals.css`**，真实文件是 `style/globals.css`（`app/layout.tsx:2`）。用 shadcn CLI 时要先修正，否则加组件会失败或落到错误位置。
2. **`textComponentToString`（`lib/utils.ts:156-164`）不递归 `extra`**。物品名/lore 若使用带 `extra` 的完整文本组件，只会取到顶层 `text`；这是已知简化。
3. **lore/名称在提示框里按纯文本渲染**（`inventory-item-tooltip.tsx:144-148`），`§` 代码不会生效，除非外层包 `MinecraftText`。
4. **`TagResolver` 的堆叠上限恒为 64**（`tag-resolver.ts:177-179`）——旧版没有对应标签，属于有意不做猜测。
5. **纹理版本未打包时 `getTextures` 返回 `null`，不回退**（`lib/texture.ts:12-16`，`BUILDING.md:158-162`）。结果是"没有贴图"而非"错误贴图"，这是刻意选择。
6. **`§x` RGB 校验失败时会被当作普通文本**（`text.ts:94-115` 的 lookahead 失败即放弃），不会吞掉后续 12 个字符——测试 `lib/tests/formatting-codes.test.ts:24-33` 覆盖了大小写混合与全 0/全 f 边界。
7. **瓦片 ETag 用长度而非内容哈希**（`MapController.java:208-214`），理论上存在"内容变但长度不变且索引版本未变"的漏判窗口，被 `max-age=10`（`MapController.java:139`）限制在 10 秒内。
8. **`transferControlToOffscreen` 一次性限制**（`map-canvas.tsx:143-150`）意味着任何"切存档不重挂载"的改动都会导致第二张地图空白——这是一个很容易踩的约束。
9. **i18n mock 不 100% 生效**（`AGENTS.md`、`item-dialog.test.tsx:21-29` 与 `:171` 的双重保险），新写组件测试时建议直接采用正则双匹配写法，省掉一次调试。
10. **纹理版本选择随平台声明**（`gradle.properties` 的 `frontend_env_texture_versions`）而**不是自动推导**；`textures-plugin.test.ts:72-105` 是唯一保证它与受支持版本列表一致的地方，一旦该测试被跳过，很容易出现"某个平台贴图版本过期"的静默退化。
