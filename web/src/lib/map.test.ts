import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ZOOM,
  REGION_BLOCKS,
  ZOOM_MAX,
  ZOOM_MIN,
  centerOn,
  panBy,
  regionKey,
  regionRange,
  regionRect,
  regionWorldBounds,
  screenToWorld,
  worldToScreen,
  zoomAround,
  type View,
} from './map'

// 地图的坐标数学是整块前端里最容易错、又最没法靠编译抓住的部分
// （画布绘制要有浏览器才能验证）。这里把纯函数算清楚，减少只能靠人眼点界面的面积。

const V = (camX: number, camZ: number, zoom: number): View => ({ camX, camZ, zoom })

describe('regionRange：视口覆盖哪些区域', () => {
  it('视口尺寸无效时返回 null（隐藏时 clientWidth 为 0，调用方要跳过绘制）', () => {
    expect(regionRange(V(0, 0, 1), 0, 100)).toBeNull()
    expect(regionRange(V(0, 0, 1), 100, 0)).toBeNull()
    expect(regionRange(V(0, 0, 0), 100, 100)).toBeNull()
  })

  it('相机在原点、视口小于一个区域 → 只覆盖 (0,0)', () => {
    expect(regionRange(V(0, 0, 1), 100, 100)).toEqual({ rx0: 0, rx1: 0, rz0: 0, rz1: 0 })
  })

  it('zoom 越小视野越大（同样的视口尺寸覆盖更多区域）', () => {
    const at1 = regionRange(V(0, 0, 1), 1024, 1024)!
    const at05 = regionRange(V(0, 0, 0.5), 1024, 1024)!
    expect(at1.rx1 - at1.rx0).toBe(1) // 1024px / 1px每方块 = 1024 方块 = 恰好 2 个区域
    expect(at05.rx1 - at05.rx0).toBe(3) // 1024 / 0.5 = 2048 方块 = 恰好 4 个区域
  })

  it('视口边缘正好落在区域边界时不多算（可见 0 像素的区域不该请求）', () => {
    // 1024 方块 = 正好 2 个区域宽，右边缘恰在 x=1024（region 2 的左边缘）
    // 若用 floor(x/512) 会多含 region 2（可见 0 像素，白白多发一次请求）
    const r = regionRange(V(0, 0, 1), 1024, 1)!
    expect(r.rx1).toBe(1)
  })

  it('边缘只差 1 像素时仍要把该区域算进来（不能漏）', () => {
    const r = regionRange(V(0, 0, 1), 1025, 1)!
    expect(r.rx1).toBe(2)
  })

  it('负坐标区域也算对（floor 而不是 trunc）', () => {
    // camX = -100 → -100/512 = -0.195 → floor = -1
    expect(regionRange(V(-100, -100, 1), 50, 50)).toEqual({ rx0: -1, rx1: -1, rz0: -1, rz1: -1 })
  })

  it('正好落在区域边界上时属于新区域', () => {
    expect(regionRange(V(512, 512, 1), 1, 1)).toEqual({ rx0: 1, rx1: 1, rz0: 1, rz1: 1 })
  })
})

describe('regionRect：绘制位置', () => {
  it('相机在区域原点时偏移为 0，尺寸 = 512 × zoom', () => {
    expect(regionRect(0, 0, V(0, 0, 1))).toEqual({ dx: 0, dy: 0, dw: REGION_BLOCKS, dh: REGION_BLOCKS })
  })

  it('相机右移后区域左移（世界向左滑）', () => {
    const r = regionRect(0, 0, V(100, 0, 1))
    expect(r.dx).toBe(-100)
    expect(r.dy).toBe(0)
  })

  it('zoom 同时影响偏移与尺寸', () => {
    const r = regionRect(1, 0, V(0, 0, 2))
    expect(r.dx).toBe(REGION_BLOCKS * 2)
    expect(r.dw).toBe(REGION_BLOCKS * 2)
  })

  it('负坐标区域位置正确', () => {
    const r = regionRect(-1, -1, V(0, 0, 1))
    expect(r.dx).toBe(-REGION_BLOCKS)
    expect(r.dy).toBe(-REGION_BLOCKS)
  })

  // 这条是本模块存在的核心理由：非整数缩放下相邻区域必须无缝
  it('横向相邻区域共享边界像素（非整数缩放下不留 1px 缝）', () => {
    for (const zoom of [0.37, 0.5, 0.73, 1.3, 2.7, 3.14159]) {
      for (const camX of [0, -137.4, 512.5, -1024.9]) {
        const view = V(camX, 0, zoom)
        const a = regionRect(0, 0, view)
        const b = regionRect(1, 0, view)
        expect(b.dx).toBe(a.dx + a.dw)
      }
    }
  })

  it('纵向相邻区域同样无缝', () => {
    for (const zoom of [0.37, 1.3, 2.7]) {
      const view = V(0, -333.25, zoom)
      const a = regionRect(0, 0, view)
      const b = regionRect(0, 1, view)
      expect(b.dy).toBe(a.dy + a.dh)
    }
  })

  it('整块区域不会算出 0 宽/0 高（否则 drawImage 会抛错）', () => {
    for (const zoom of [0.05, 0.5, 1, 8]) {
      const r = regionRect(0, 0, V(0, 0, zoom))
      expect(r.dw).toBeGreaterThan(0)
      expect(r.dh).toBeGreaterThan(0)
    }
  })
})

describe('worldToScreen / screenToWorld 互为逆运算', () => {
  const views = [V(0, 0, 1), V(-256, -256, 0.5), V(1234.5, -987.25, 3.7)]
  for (const v of views) {
    it(`往返一致（cam=${v.camX},${v.camZ} zoom=${v.zoom}）`, () => {
      const s = worldToScreen(777, -333, v)
      const b = screenToWorld(s.sx, s.sy, v)
      expect(b.bx).toBeCloseTo(777, 6)
      expect(b.bz).toBeCloseTo(-333, 6)
    })
  }
})

describe('zoomAround：锚点不动（滚轮手感的关键）', () => {
  it('缩放前后锚点处的世界坐标不变', () => {
    // 基准 zoom 必须落在 [ZOOM_MIN, ZOOM_MAX] = [1.75, 10] 内，
    // 否则会被钳制，断言量到的就不是我们想测的那次缩放
    const v = V(0, 0, DEFAULT_ZOOM)
    const sx = 300
    const sy = 200
    const before = screenToWorld(sx, sy, v)
    const next = zoomAround(v, 1.1, sx, sy)
    const after = screenToWorld(sx, sy, next)
    expect(after.bx).toBeCloseTo(before.bx, 6)
    expect(after.bz).toBeCloseTo(before.bz, 6)
    expect(next.zoom).toBeCloseTo(DEFAULT_ZOOM * 1.1, 6)
  })

  it('缩小方向同样保持锚点（且不触发下限钳制）', () => {
    const v = V(-100, 50, DEFAULT_ZOOM * 2)
    const before = screenToWorld(123, 45, v)
    const next = zoomAround(v, 0.9, 123, 45)
    const after = screenToWorld(123, 45, next)
    expect(after.bx).toBeCloseTo(before.bx, 6)
    expect(after.bz).toBeCloseTo(before.bz, 6)
    expect(next.zoom).toBeCloseTo(DEFAULT_ZOOM * 2 * 0.9, 6)
  })

  it('下限钳制时原样返回，锚点语义不被破坏', () => {
    const v = V(0, 0, ZOOM_MIN)
    const next = zoomAround(v, 0.9, 200, 150)   // 会被钳到 ZOOM_MIN ⇒ 等于没变
    expect(next).toBe(v)
  })

  it('缩放到上限后不再变', () => {
    const v = V(0, 0, ZOOM_MAX)
    expect(zoomAround(v, 1.5, 10, 10).zoom).toBe(ZOOM_MAX)
  })

  it('缩放到下限后不再变', () => {
    const v = V(0, 0, ZOOM_MIN)
    expect(zoomAround(v, 0.5, 10, 10).zoom).toBe(ZOOM_MIN)
  })

  it('越界时原样返回（引用不变，省一次重绘）', () => {
    const v = V(0, 0, ZOOM_MAX)
    expect(zoomAround(v, 2, 0, 0)).toBe(v)
  })
})

describe('centerOn：坐标跳转', () => {
  it('目标点落在视口正中', () => {
    const v = centerOn(1000, -2000, 2, 800, 600)
    const s = worldToScreen(1000, -2000, v)
    expect(s.sx).toBeCloseTo(400, 6)
    expect(s.sy).toBeCloseTo(300, 6)
  })

  it('zoom 变化后目标仍在正中', () => {
    const v = centerOn(0, 0, 0.2, 1000, 400)
    const s = worldToScreen(0, 0, v)
    expect(s.sx).toBeCloseTo(500, 6)
    expect(s.sy).toBeCloseTo(200, 6)
  })
})

describe('panBy：拖动手感', () => {
  it('鼠标向右拖 → 相机左移（画面跟着手走）', () => {
    const v = panBy(V(0, 0, 1), 50, 0)
    expect(v.camX).toBe(-50)
  })

  it('位移换算要除以 zoom（放大后同样的鼠标位移对应更小的世界位移）', () => {
    const v = panBy(V(0, 0, 2), 50, 0)
    expect(v.camX).toBe(-25)
  })

  it('zoom 不变', () => {
    expect(panBy(V(0, 0, 3), 10, 10).zoom).toBe(3)
  })
})

describe('缩放量级（对齐 OPanel，防再退回「1 像素一方块」）', () => {
  // 这一组是「色块太小」那个 bug 的回归网。
  // 原先 ZOOM_MIN=0.05 / DEFAULT=1：一屏能覆盖 400+ 个区域（请求风暴），
  // 且默认一个方块只占 1 个屏幕像素 —— 根本看不出「方块」。
  // OPanel 的语义是「端到端最少放大 1.75×、默认 2×」。
  it('下限不低于 1.75（每方块至少 1.75 屏幕像素）', () => {
    expect(ZOOM_MIN).toBeGreaterThanOrEqual(1.75)
  })

  it('默认缩放为 2（每方块 2 像素）', () => {
    expect(DEFAULT_ZOOM).toBe(2)
  })

  it('默认值落在范围内', () => {
    expect(DEFAULT_ZOOM).toBeGreaterThanOrEqual(ZOOM_MIN)
    expect(DEFAULT_ZOOM).toBeLessThanOrEqual(ZOOM_MAX)
  })

  it('一屏覆盖的区域数有上限（不会因缩得太小而爆炸）', () => {
    // 取一个偏大的画布 1920×1080，在最小缩放下数覆盖到的区域数
    const r = regionRange({ camX: 0, camZ: 0, zoom: ZOOM_MIN }, 1920, 1080)!
    const cols = r.rx1 - r.rx0 + 1
    const rows = r.rz1 - r.rz0 + 1
    // 下限 1.75 时约 3×2；即便放宽到 1 也才 4×3。设 64 作为「绝不该爆」的粗线，
    // 真正要防的是 0.05 那种量级（那会是 400+）。
    expect(cols * rows).toBeLessThan(64)
  })
})

describe('regionKey / regionWorldBounds', () => {
  it('key 是稳定的 "x,z" 形式', () => {
    expect(regionKey(1, -2)).toBe('1,-2')
  })

  it('区域覆盖 512 方块（含端点）', () => {
    expect(regionWorldBounds(0, 0)).toEqual({ minX: 0, minZ: 0, maxX: 511, maxZ: 511 })
    expect(regionWorldBounds(-1, 2)).toEqual({ minX: -512, minZ: 1024, maxX: -1, maxZ: 1535 })
  })

  it('相邻区域不重叠也不留缝（这是「相邻 region 拼起来无缝隙」的算术依据）', () => {
    const a = regionWorldBounds(0, 0)
    const b = regionWorldBounds(1, 0)
    expect(b.minX).toBe(a.maxX + 1)
  })
})
