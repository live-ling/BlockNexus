'use strict';
// 方块 → 颜色表 + 原版地图的高度阴影规则 —— 零依赖
//
// 为什么手写色表而不用「下载 client.jar 抽材质算平均色」（OPanel 的做法）：
//   · 那需要构建期下载 client.jar，引入版权与网络依赖，还要求用户机器能访问 Mojang；
//   · 本项目是单用户面板，色表够用就行，缺的方块用**品红**兜底，一眼就能看出漏了哪些。
//
// ⚠ 草方块 / 树叶 / 水在游戏里是**生物群系着色**的，这里给的是平原（plains）观感，
//   不按生物群系变化。这是刻意的取舍：做生物群系着色要读每列的 biome id 并维护
//   一张群系色表，收益只是「更准的颜色」，不值第一版的复杂度。

/** 未知方块的兜底色：品红。刻意刺眼 —— 比默默画黑块更容易发现问题 */
const UNKNOWN = [255, 0, 255];

/** 透明方块（不画，露出底下的空白） */
const TRANSPARENT = new Set([
  'air',
  'cave_air',
  'void_air',
  'barrier',
  'light',
  'structure_void',
  'moving_piston',
]);

/**
 * 方块 → RGB。
 * 键是**去掉 `minecraft:` 前缀后**的名字；带 blockstate 后缀的会在查表前剥掉。
 */
const COLORS = {
  // ---------- 地表 ----------
  stone: [125, 125, 125],
  cobblestone: [110, 110, 110],
  mossy_cobblestone: [110, 124, 100],
  smooth_stone: [158, 158, 158],
  stone_bricks: [122, 122, 122],
  cracked_stone_bricks: [118, 118, 118],
  mossy_stone_bricks: [115, 125, 105],
  chiseled_stone_bricks: [120, 120, 120],
  dirt: [134, 96, 67],
  coarse_dirt: [134, 96, 67],
  rooted_dirt: [144, 104, 74],
  grass_block: [127, 178, 56],
  grass_path: [148, 122, 65],
  dirt_path: [148, 122, 65],
  farmland: [82, 52, 20],
  podzol: [91, 64, 24],
  mycelium: [111, 99, 105],
  mud: [60, 57, 60],
  mud_bricks: [137, 103, 95],
  packed_mud: [141, 106, 90],
  clay: [160, 166, 179],
  gravel: [136, 126, 126],
  sand: [219, 207, 163],
  red_sand: [190, 102, 33],
  sandstone: [216, 203, 155],
  red_sandstone: [181, 97, 31],
  snow: [249, 254, 254],
  snow_block: [249, 254, 254],
  powder_snow: [248, 253, 253],
  ice: [145, 183, 253],
  packed_ice: [141, 180, 250],
  blue_ice: [116, 167, 253],
  frosted_ice: [140, 180, 250],
  bedrock: [85, 85, 85],

  // ---------- 流体 ----------
  water: [63, 118, 228],
  flowing_water: [63, 118, 228],
  lava: [234, 109, 29],
  flowing_lava: [234, 109, 29],
  bubble_column: [63, 118, 228],

  // ---------- 岩石（1.17+） ----------
  deepslate: [80, 80, 82],
  cobbled_deepslate: [77, 77, 80],
  polished_deepslate: [72, 72, 75],
  deepslate_bricks: [70, 70, 73],
  deepslate_tiles: [54, 54, 56],
  tuff: [108, 109, 102],
  calcite: [223, 224, 220],
  dripstone_block: [134, 107, 92],
  amethyst_block: [133, 97, 191],
  smooth_basalt: [72, 72, 78],
  basalt: [72, 72, 78],
  polished_basalt: [88, 88, 91],
  blackstone: [42, 35, 40],
  polished_blackstone: [53, 46, 51],
  gilded_blackstone: [55, 42, 42],
  magma_block: [142, 63, 31],
  obsidian: [21, 18, 30],
  crying_obsidian: [32, 10, 60],
  ancient_debris: [95, 70, 66],
  netherrack: [111, 54, 52],
  nether_bricks: [44, 22, 26],
  red_nether_bricks: [70, 16, 20],
  soul_sand: [81, 62, 50],
  soul_soil: [75, 57, 46],
  glowstone: [254, 214, 133],
  shroomlight: [244, 147, 79],
  end_stone: [219, 222, 158],
  end_stone_bricks: [218, 224, 162],
  purpur_block: [169, 125, 169],
  purpur_pillar: [171, 128, 171],
  chorus_plant: [93, 66, 93],

  // ---------- 木头 ----------
  oak_log: [102, 81, 49],
  oak_planks: [162, 130, 78],
  oak_leaves: [60, 140, 40],
  oak_wood: [102, 81, 49],
  spruce_log: [58, 42, 23],
  spruce_planks: [114, 84, 48],
  spruce_leaves: [40, 90, 40],
  birch_log: [216, 215, 210],
  birch_planks: [192, 175, 121],
  birch_leaves: [80, 140, 60],
  jungle_log: [85, 67, 25],
  jungle_planks: [160, 115, 80],
  jungle_leaves: [45, 110, 30],
  acacia_log: [103, 96, 86],
  acacia_planks: [168, 90, 50],
  acacia_leaves: [70, 120, 40],
  dark_oak_log: [60, 46, 26],
  dark_oak_planks: [66, 43, 20],
  dark_oak_leaves: [40, 90, 30],
  mangrove_log: [80, 50, 40],
  mangrove_planks: [117, 54, 48],
  mangrove_leaves: [50, 110, 40],
  cherry_log: [54, 36, 44],
  cherry_planks: [226, 178, 178],
  cherry_leaves: [230, 155, 190],
  bamboo_block: [90, 140, 50],
  bamboo: [90, 140, 50],
  crimson_stem: [92, 25, 29],
  crimson_planks: [101, 48, 70],
  warped_stem: [43, 104, 99],
  warped_planks: [43, 104, 99],
  nether_wart_block: [114, 3, 3],
  warped_wart_block: [20, 120, 112],
  stripped_oak_log: [177, 143, 86],
  stripped_spruce_log: [110, 84, 50],
  stripped_birch_log: [196, 176, 118],
  stripped_jungle_log: [170, 124, 80],
  stripped_acacia_log: [174, 92, 52],
  stripped_dark_oak_log: [70, 50, 26],

  // ---------- 矿石 ----------
  coal_ore: [115, 115, 115],
  deepslate_coal_ore: [74, 74, 76],
  iron_ore: [136, 130, 127],
  deepslate_iron_ore: [96, 92, 90],
  copper_ore: [130, 127, 116],
  deepslate_copper_ore: [92, 90, 84],
  gold_ore: [145, 133, 106],
  deepslate_gold_ore: [104, 96, 78],
  redstone_ore: [133, 107, 107],
  deepslate_redstone_ore: [92, 76, 76],
  lapis_ore: [107, 117, 141],
  deepslate_lapis_ore: [78, 84, 100],
  diamond_ore: [124, 144, 146],
  deepslate_diamond_ore: [88, 102, 104],
  emerald_ore: [110, 140, 120],
  deepslate_emerald_ore: [80, 100, 88],
  nether_gold_ore: [117, 60, 44],
  nether_quartz_ore: [126, 84, 78],

  // ---------- 矿物块 ----------
  coal_block: [16, 15, 15],
  iron_block: [220, 220, 220],
  copper_block: [192, 107, 79],
  gold_block: [246, 208, 61],
  diamond_block: [92, 219, 213],
  redstone_block: [175, 24, 5],
  lapis_block: [30, 67, 140],
  emerald_block: [42, 203, 86],
  netherite_block: [67, 61, 64],
  quartz_block: [236, 233, 226],
  raw_iron_block: [166, 135, 107],
  raw_copper_block: [154, 105, 79],
  raw_gold_block: [221, 169, 46],
  amethyst_cluster: [160, 120, 210],
  budding_amethyst: [133, 97, 191],

  // ---------- 建筑 ----------
  bricks: [150, 97, 83],
  bookshelf: [156, 127, 74],
  crafting_table: [124, 90, 55],
  furnace: [110, 110, 110],
  blast_furnace: [90, 90, 90],
  smoker: [86, 78, 70],
  chest: [162, 130, 78],
  barrel: [109, 86, 54],
  tnt: [219, 68, 32],
  glass: [215, 240, 240],
  glass_pane: [215, 240, 240],
  tinted_glass: [40, 40, 40],
  hay_block: [166, 140, 31],
  melon: [141, 175, 44],
  pumpkin: [197, 124, 26],
  carved_pumpkin: [197, 124, 26],
  jack_o_lantern: [210, 140, 40],
  cactus: [15, 110, 32],
  sea_lantern: [172, 199, 190],
  prismarine: [99, 156, 151],
  prismarine_bricks: [99, 171, 158],
  dark_prismarine: [51, 91, 75],
  sponge: [195, 192, 74],
  wet_sponge: [171, 181, 70],
  terracotta: [152, 94, 67],
  white_terracotta: [209, 178, 161],
  orange_terracotta: [161, 83, 37],

  // ---------- 花岗岩类：在石头里成团生成，山地/海岸剖面大面积露出 ----------
  // ⚠ 这三种早期漏掉了，实测「50 个常见方块里 35 个未命中」时它们排在最前。
  //   缺它们的直接后果是整片山体渲染成品红 —— 就是用户看到的「满屏噪点」。
  andesite: [136, 136, 137],
  diorite: [207, 207, 208],
  granite: [149, 103, 85],
  polished_andesite: [132, 132, 133],
  polished_diorite: [214, 214, 215],
  polished_granite: [154, 106, 88],
  smooth_quartz: [235, 232, 225],
  smooth_sandstone: [220, 208, 160],
  smooth_red_sandstone: [181, 97, 31],
  smooth_stone: [158, 158, 158],
  cut_sandstone: [216, 203, 155],
  cut_red_sandstone: [181, 97, 31],
  chiseled_sandstone: [216, 203, 155],
  chiseled_red_sandstone: [181, 97, 31],
  chiseled_quartz_block: [232, 229, 220],
  chiseled_deepslate: [54, 54, 56],
  cracked_deepslate_bricks: [62, 62, 64],
  cracked_deepslate_tiles: [48, 48, 50],
  smooth_basalt: [72, 72, 78],

  // ---------- 1.17+ / 1.19+ 自然与建筑方块 ----------
  sculk: [16, 24, 30],
  sculk_vein: [14, 20, 26],
  sculk_catalyst: [12, 26, 28],
  sculk_shrieker: [18, 28, 32],
  mangrove_roots: [94, 66, 44],
  muddy_mangrove_roots: [70, 60, 48],
  warped_nylium: [43, 104, 99],
  crimson_nylium: [130, 40, 45],
  nether_sprouts: [40, 120, 110],
  bamboo_planks: [193, 168, 82],
  bamboo_mosaic: [193, 168, 82],
  ochre_froglight: [222, 214, 168],
  verdant_froglight: [190, 214, 178],
  pearlescent_froglight: [226, 200, 214],
  moss_block: [89, 109, 45],
  azalea_leaves: [76, 107, 32],
  flowering_azalea_leaves: [90, 120, 45],
  scaffolding: [174, 140, 86],
  campfire: [109, 80, 58],
  lantern: [190, 150, 80],
  lodestone: [160, 168, 175],
  iron_bars: [180, 180, 180],
  cobweb: [230, 235, 235],
  iron_door: [200, 200, 200],
  iron_block_door: [200, 200, 200],
  beacon: [110, 200, 190],
  conduit: [110, 160, 160],
  target: [215, 180, 170],
  slime_block: [110, 190, 90],
  honey_block: [230, 160, 60],
  note_block: [110, 80, 60],
  jukebox: [110, 85, 60],
  dispenser: [110, 110, 110],
  dropper: [110, 110, 110],
  observer: [110, 110, 110],
  piston: [140, 130, 110],
  sticky_piston: [140, 130, 110],
  hopper: [90, 90, 90],
  cauldron: [70, 70, 70],
  composter: [130, 100, 60],
  lectern: [160, 130, 80],
  loom: [150, 120, 80],
  cartography_table: [130, 105, 70],
  fletching_table: [200, 185, 135],
  smithing_table: [70, 55, 45],
  stonecutter: [130, 130, 130],
  grindstone: [150, 140, 120],
  bell: [230, 190, 70],
  anvil: [70, 70, 70],
  chipped_anvil: [70, 70, 70],
  damaged_anvil: [70, 70, 70],
  enchanting_table: [130, 60, 60],
  end_portal_frame: [90, 130, 110],
  respawn_anchor: [60, 20, 40],
  crying_obsidian_block: [32, 10, 60],

  // ---------- 植物 ----------
  short_grass: [110, 160, 60],
  tall_grass: [110, 160, 60],
  fern: [110, 160, 60],
  large_fern: [110, 160, 60],
  dead_bush: [140, 110, 55],
  dandelion: [120, 160, 50],
  poppy: [120, 160, 50],
  sunflower: [120, 160, 50],
  lilac: [120, 160, 50],
  rose_bush: [120, 160, 50],
  peony: [120, 160, 50],
  sugar_cane: [120, 170, 70],
  kelp: [60, 120, 60],
  seagrass: [60, 120, 60],
  vine: [60, 120, 40],
  lily_pad: [60, 130, 50],
  wheat: [180, 170, 60],
  carrots: [110, 160, 60],
  potatoes: [110, 160, 60],
  beetroots: [110, 160, 60],
  nether_wart: [120, 20, 25],
  crimson_fungus: [140, 60, 60],
  warped_fungus: [60, 130, 130],
  crimson_roots: [130, 40, 45],
  warped_roots: [60, 120, 120],
  big_dripleaf: [90, 130, 50],
  small_dripleaf: [90, 130, 50],
  glow_lichen: [130, 150, 120],
  hanging_roots: [130, 100, 70],
  twisting_vines: [60, 130, 130],
  weeping_vines: [130, 40, 45],

  // ---------- 羊毛 / 混凝土 ----------
  white_wool: [233, 236, 236],
  orange_wool: [240, 118, 19],
  magenta_wool: [189, 68, 179],
  light_blue_wool: [58, 175, 217],
  yellow_wool: [248, 198, 39],
  lime_wool: [112, 185, 25],
  pink_wool: [237, 141, 172],
  gray_wool: [62, 68, 71],
  light_gray_wool: [142, 142, 134],
  cyan_wool: [21, 137, 145],
  purple_wool: [121, 42, 172],
  blue_wool: [53, 57, 157],
  brown_wool: [114, 71, 40],
  green_wool: [84, 109, 27],
  red_wool: [161, 39, 34],
  black_wool: [20, 21, 25],
  white_concrete: [207, 213, 214],
  orange_concrete: [224, 97, 0],
  magenta_concrete: [169, 48, 159],
  light_blue_concrete: [36, 137, 199],
  yellow_concrete: [241, 175, 21],
  lime_concrete: [94, 168, 24],
  pink_concrete: [214, 101, 143],
  gray_concrete: [55, 58, 62],
  light_gray_concrete: [125, 125, 115],
  cyan_concrete: [21, 119, 136],
  purple_concrete: [100, 32, 156],
  blue_concrete: [44, 46, 143],
  brown_concrete: [96, 60, 32],
  green_concrete: [73, 91, 36],
  red_concrete: [142, 33, 33],
  black_concrete: [8, 10, 15],
  white_terracotta_glazed: [188, 212, 202],
  orange_glazed_terracotta: [154, 86, 40],
  magenta_glazed_terracotta: [150, 60, 145],
  light_blue_glazed_terracotta: [90, 150, 180],
  yellow_glazed_terracotta: [210, 180, 70],
  lime_glazed_terracotta: [130, 170, 60],
  pink_glazed_terracotta: [200, 120, 150],
  gray_glazed_terracotta: [80, 90, 95],
  light_gray_glazed_terracotta: [140, 145, 145],
  cyan_glazed_terracotta: [60, 120, 130],
  purple_glazed_terracotta: [110, 60, 140],
  blue_glazed_terracotta: [70, 80, 160],
  brown_glazed_terracotta: [100, 70, 50],
  green_glazed_terracotta: [80, 110, 60],
  red_glazed_terracotta: [150, 60, 55],
  black_glazed_terracotta: [40, 40, 45],
};

/**
 * 原版地图的明暗档乘数（0 最亮 ~ 3 最暗）。
 * 与原版 `MapColor` 的观感一致：高处亮、低处暗，形成地形立体感。
 */
const SHADES = [1.0, 0.8, 0.5, 0.4];

/**
 * 规范化方块名：剥 `minecraft:` 前缀与 blockstate 后缀。
 * @param {string} name 例如 `minecraft:oak_log[axis=y]`
 */
function normalize(name) {
  // ⚠ 顺序要紧：**先** trim + 小写，**再**剥前缀与后缀。
  //   反过来写（先看前缀后小写）时，`'  Minecraft:STONE  '` 这类带空白/大写的输入
  //   会匹配不上前缀，于是整个名字留着 `minecraft:` 去查表 → 误判成未知方块（品红）。
  let n = String(name || '')
    .trim()
    .toLowerCase();
  const bracket = n.indexOf('[');
  if (bracket >= 0) n = n.slice(0, bracket);
  if (n.startsWith('minecraft:')) n = n.slice('minecraft:'.length);
  return n.trim();
}

/**
 * 可剥的后缀：形状变体。
 *
 * 为什么用「剥后缀」而不是把变体全列进色表：
 *   MC 里每个方块几乎都有 stairs / slab / wall / fence / door / trapdoor / button /
 *   pressure_plate / sign / pane / carpet 等形状变体，而且各自还有 16 种染色版与
 *   5 种氧化态。全枚举是**几千条**，而它们的颜色本就与基础方块一致或极接近。
 *   一条剥离规则就能覆盖，且新增方块时自动跟着生效。
 *
 * ⚠ 刻意**不**剥 `_block`：`coal_block` / `iron_block` 等是独立配色，剥掉会全变成煤/铁的原色。
 */
const STRIP_SUFFIX = [
  '_stairs',
  '_slab',
  '_wall',
  '_fence_gate',
  '_fence',
  '_trapdoor',
  '_door',
  '_button',
  '_pressure_plate',
  '_hanging_sign',
  '_sign',
  '_pane',
  '_carpet',
  '_bars',
];

/** 可剥的前缀：加工变体（颜色接近基础方块） */
const STRIP_PREFIX = [
  'polished_',
  'smooth_',
  'chiseled_',
  'cut_',
  'cracked_',
  'mossy_',
  'stripped_',
  'waxed_',
  'exposed_',
  'weathered_',
  'oxidized_',
  'infested_',
  'cobbled_',
];

/** 木头家族：`oak_stairs` 这类剥完只剩 `oak`，再退到 `oak_planks` */
const WOODS = new Set([
  'oak',
  'spruce',
  'birch',
  'jungle',
  'acacia',
  'dark_oak',
  'mangrove',
  'cherry',
  'bamboo',
  'crimson',
  'warped',
]);

/** 带递归的查表（剥前缀 → 剥后缀 → 木头退化），深度受规则数限制，不会无限递归 */
function lookup(n, depth = 0) {
  const hit = COLORS[n];
  if (hit) return [hit[0], hit[1], hit[2]];
  if (depth > 3) return null;

  for (const p of STRIP_PREFIX) {
    if (n.startsWith(p) && n.length > p.length) {
      const r = lookup(n.slice(p.length), depth + 1);
      if (r) return r;
    }
  }
  for (const s of STRIP_SUFFIX) {
    if (n.endsWith(s) && n.length > s.length) {
      const base = n.slice(0, -s.length);
      const r = lookup(base, depth + 1);
      if (r) return r;
      if (WOODS.has(base)) {
        const w = COLORS[base + '_planks'];
        if (w) return [w[0], w[1], w[2]];
      }
    }
  }
  return null;
}

/**
 * 方块名 → RGB。未知方块返回**品红**（刻意刺眼），透明方块返回 `null`。
 * @param {string} name
 * @returns {[number, number, number]|null}
 */
function colorOf(name) {
  const n = normalize(name);
  if (!n || TRANSPARENT.has(n)) return null;
  return lookup(n) || UNKNOWN;
}

/**
 * 明暗档：照搬原版规则 —— 由**当前方块与北侧邻居的高度差**决定，不是绝对高度。
 *
 * 这样同一高度的平地到处一样亮，而台阶、墙、坑的边缘会出现明暗线，
 * 观感与游戏内地图一致；用绝对高度则整张图会随地形起伏整体变暗变亮，反而不像地图。
 *
 * @param {number} topY 当前列顶部方块的高度
 * @param {number} northY 北侧（z-1）邻居的高度
 * @returns {number} 0..3
 */
function shadeIndexFor(topY, northY) {
  const diff = topY - northY;
  if (diff > 0) return 0;
  if (diff === 0) return 1;
  if (diff > -2) return 2;
  return 3;
}

/**
 * 取某列的明暗档，处理北侧取样的边界。
 *
 * `pz === 0` 时北侧越界：按原版做法**改用 pz = 1**（而不是把邻居当 0 高度或跳过），
 * 否则地图第一行会出现一条凭空的黑边。
 *
 * @param {Int16Array} heights
 * @param {number} size 图像边长
 * @param {number} px
 * @param {number} pz
 */
function shadeIndexAt(heights, size, px, pz) {
  // pz=0 时把**取样行**抬到 1（第一行复用第二行的档位），与 OPanel 一致
  // （render.rs:56-59 的 `if z == 0 { z += 1 }`）。注意不是「把北邻换成 pz=1」——
  // 那样算出来的是 h(0)-h(1)，方向相反，有坡度时会在每张区域图顶部留一条色线。
  const useRow = pz === 0 ? 1 : pz;
  const cur = heights[useRow * size + px];
  const north = heights[(useRow - 1) * size + px];
  return shadeIndexFor(cur, north);
}

/**
 * 应用明暗档。
 * @param {[number,number,number]} rgb
 * @param {number} shadeIndex 0..3
 * @returns {[number, number, number]}
 */
function applyShade(rgb, shadeIndex) {
  const k = SHADES[shadeIndex] ?? 1;
  return [Math.round(rgb[0] * k), Math.round(rgb[1] * k), Math.round(rgb[2] * k)];
}

module.exports = {
  UNKNOWN,
  COLORS,
  SHADES,
  normalize,
  colorOf,
  shadeIndexFor,
  shadeIndexAt,
  applyShade,
};
