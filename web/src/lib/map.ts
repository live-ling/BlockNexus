// 地图坐标与视角的纯函数（P4-1e）
//
// 为什么单独抽出来：这是整块前端里**最容易出错、又最没法靠编译抓住**的部分
// （画布绘制要有浏览器才能验证）。抽成纯函数后可以用 vitest 精确覆盖，
// 不必依赖人工点界面。
//
// 坐标系约定：
//   · **世界坐标**：方块坐标（与原版 F3 一致）。原点是 (0, 0)。
//   · **相机**：camX/camZ 是视口**左上角**对应的世界方块坐标。
//   · **zoom**：每个方块占多少 CSS 像素。
//   · **region**：一个 .mca 文件覆盖 32×32 区块 = **512×512 方块**；
//     region 下标 (rx, rz) 对应世界范围 [rx*512, rx*512+511]。

/** 一个 region 覆盖的方块边长 */
export const REGION_BLOCKS = 512;

/** 缩放范围（每方块像素数） */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;

export type View = { camX: number; camZ: number; zoom: number };

/**
 * 视口覆盖到的 region 下标范围（闭区间）。
 * 返回 null 表示视口尺寸无效（隐藏时 clientWidth/Height 为 0），调用方应跳过绘制。
 */
export function regionRange(
  view: View,
  width: number,
  height: number,
): { rx0: number; rx1: number; rz0: number; rz1: number } | null {
  if (!(width > 0) || !(height > 0) || !(view.zoom > 0)) return null;
  // ⚠ 右/下边界用 `ceil(x/512) - 1` 而不是 `floor(x/512)`：
  //   当视口边缘**正好落在区域边界**上时，floor 会把「左边缘恰好贴着视口右边界、
  //   可见 0 像素」的那个区域也算进来，白白多发一次请求。
  //   ceil-1 在非整边界时等于 floor，在整边界时正好少算那一格。
  return {
    rx0: Math.floor(view.camX / REGION_BLOCKS),
    rx1: Math.ceil((view.camX + width / view.zoom) / REGION_BLOCKS) - 1,
    rz0: Math.floor(view.camZ / REGION_BLOCKS),
    rz1: Math.ceil((view.camZ + height / view.zoom) / REGION_BLOCKS) - 1,
  };
}

/**
 * 某个 region 在画布上的绘制矩形（CSS 像素）。
 * 用世界坐标算偏移，所以缩放不会累积误差。
 */
export function regionRect(
  rx: number,
  rz: number,
  view: View,
): { dx: number; dy: number; size: number } {
  const size = REGION_BLOCKS * view.zoom;
  return {
    dx: (rx * REGION_BLOCKS - view.camX) * view.zoom,
    dy: (rz * REGION_BLOCKS - view.camZ) * view.zoom,
    size,
  };
}

/** 世界坐标 → 画布坐标 */
export function worldToScreen(bx: number, bz: number, view: View): { sx: number; sy: number } {
  return { sx: (bx - view.camX) * view.zoom, sy: (bz - view.camZ) * view.zoom };
}

/** 画布坐标 → 世界坐标 */
export function screenToWorld(sx: number, sy: number, view: View): { bx: number; bz: number } {
  return { bx: view.camX + sx / view.zoom, bz: view.camZ + sy / view.zoom };
}

/**
 * 以画布上某点为锚点缩放：**锚点处的世界坐标在缩放前后保持不变**。
 *
 * 为什么必须这样：若只改 zoom 不动相机，缩放会始终以左上角为中心，
 * 用户滚轮指着的地方会「跑掉」，手感很差。
 */
export function zoomAround(view: View, factor: number, sx: number, sy: number): View {
  const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  if (nz === view.zoom) return view;
  const { bx, bz } = screenToWorld(sx, sy, view);
  return { camX: bx - sx / nz, camZ: bz - sy / nz, zoom: nz };
}

/** 把某个世界坐标居中到给定视口尺寸中央 */
export function centerOn(bx: number, bz: number, zoom: number, width: number, height: number): View {
  return {
    camX: bx - width / 2 / zoom,
    camZ: bz - height / 2 / zoom,
    zoom,
  };
}

/** 屏幕位移 → 相机位移（拖动时用）。位移方向与鼠标一致：向右拖 = 画面右移 = 相机左移 */
export function panBy(view: View, dxScreen: number, dyScreen: number): View {
  return {
    camX: view.camX - dxScreen / view.zoom,
    camZ: view.camZ - dyScreen / view.zoom,
    zoom: view.zoom,
  };
}

/** 该 region 的缓存/请求 key */
export function regionKey(rx: number, rz: number): string {
  return `${rx},${rz}`;
}

/** 根据 region 坐标算出它覆盖的世界范围（闭区间），用于判断「玩家在哪」之类 */
export function regionWorldBounds(rx: number, rz: number): {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
} {
  return {
    minX: rx * REGION_BLOCKS,
    minZ: rz * REGION_BLOCKS,
    maxX: rx * REGION_BLOCKS + REGION_BLOCKS - 1,
    maxZ: rz * REGION_BLOCKS + REGION_BLOCKS - 1,
  };
}
