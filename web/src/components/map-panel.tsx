// 网页地图面板（P4-1e）
//
// 设计要点（对应 docs/p4-1-map-plan.md §4 P4-1e）：
//   · 渲染由 Agent 完成并产出 **PNG**，这里只做「把图片画到正确的像素位置」——
//     没有像素循环、没有调色板、没有自研二进制解码。
//   · 视角用「世界方块坐标 + 每方块像素数(zoom)」描述，而不是画布像素：
//     这样缩放时只需改 zoom，region 的绘制位置始终由世界坐标算出，不会累积误差。
//   · **只请求视口覆盖到的 region**，并按 key 缓存已加载的 Image 对象。
//     配合面板侧的 ETag/304，拖回看过的区域是零请求。
//   · `imageSmoothingEnabled = false`：地图是像素风，插值会让方块边界发糊。
//   · 重绘用 requestAnimationFrame 合并：拖动时 pointermove 触发频率远高于帧率，
//     每帧只画一次。

import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { $ } from '@/lib/i18n';
import { api, errText } from '@/lib/api';
import {
  REGION_BLOCKS,
  centerOn as centerOnView,
  panBy,
  regionKey,
  regionRange,
  regionRect,
  zoomAround,
} from '@/lib/map';

type Save = { save: string; regions: [number, number][]; version: string };

export function MapPanel({
  serverId,
  instance,
  visible = true,
  heightClass = 'h-[45vh] lg:h-[60vh]',
}: {
  serverId: string;
  instance: string;
  /** 由父组件控制；切走时不必重绘，但切回要重画一次（画布尺寸可能变了） */
  visible?: boolean;
  heightClass?: string;
}) {
  const [saves, setSaves] = useState<Save[]>([]);
  const [cur, setCur] = useState('');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const [zoomUi, setZoomUi] = useState(1);
  const [jumpX, setJumpX] = useState('');
  const [jumpZ, setJumpZ] = useState('');

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 视角：camX/camZ 是视口左上角对应的**世界方块坐标**
  const viewRef = useRef({ camX: -REGION_BLOCKS / 2, camZ: -REGION_BLOCKS / 2, zoom: 1 });
  const dragRef = useRef<{ x: number; y: number; camX: number; camZ: number } | null>(null);
  const rafRef = useRef(0);
  const imgsRef = useRef(new Map<string, HTMLImageElement>());
  const inflightRef = useRef(new Set<string>());
  // 该世界**实际存在**的区域集合：避免为不存在的区域发一堆 404
  const haveRef = useRef(new Set<string>());
  const curRef = useRef('');
  // draw → requestRegion → scheduleDraw → draw 会形成循环依赖。
  // 用 ref 打断：draw 只调用 requestRef.current(...)，不直接引用 requestRegion 的函数值。
  // （比用 lint 压制 react-hooks/exhaustive-deps 好：压制会把真正的依赖漏项也一起藏起来。）
  const requestRef = useRef<(rx: number, rz: number) => void>(() => {});
  // 缩放函数也要给「原生非被动 wheel 监听」用（原因见下方绑定的注释）
  const zoomRef = useRef<(factor: number, sx: number, sy: number) => void>(() => {});

  useEffect(() => {
    curRef.current = cur;
  }, [cur]);

  // ---------- 加载存档列表 ----------
  useEffect(() => {
    let alive = true;
    setPhase('loading');
    api<{ saves: Save[] }>(`/servers/${serverId}/instances/${encodeURIComponent(instance)}/map`)
      .then((r) => {
        if (!alive) return;
        const list = r.saves || [];
        setSaves(list);
        if (!list.length) {
          setPhase('empty');
          return;
        }
        // 优先选 world，否则第一个（Paper 的多世界里 world 是主世界）
        const pick = list.find((s) => s.save === 'world') || list[0];
        setCur(pick.save);
        curRef.current = pick.save;
        setPhase('ready');
      })
      .catch((e) => {
        if (!alive) return;
        setPhase('error');
        setMsg(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [serverId, instance]);

  // 切换世界：清空缓存与存在集合，视角复位
  useEffect(() => {
    imgsRef.current.clear();
    inflightRef.current.clear();
    haveRef.current = new Set();
    viewRef.current = { camX: -REGION_BLOCKS / 2, camZ: -REGION_BLOCKS / 2, zoom: 1 };
    setZoomUi(1);
    const s = saves.find((x) => x.save === cur);
    if (s) for (const [x, z] of s.regions) haveRef.current.add(`${x},${z}`);
  }, [cur, saves]);

  // ---------- 绘制 ----------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 按设备像素比放大后备缓冲，否则高分屏上像素会糊
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return; // 隐藏时尺寸为 0：跳过，别把画布 resize 成 0
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 像素风：不能插值
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, w, h);

    const view = viewRef.current;
    const range = regionRange(view, w, h);
    if (!range) return; // 尺寸无效（隐藏中）

    for (let rz = range.rz0; rz <= range.rz1; rz++) {
      for (let rx = range.rx0; rx <= range.rx1; rx++) {
        const key = regionKey(rx, rz);
        if (!haveRef.current.has(key)) continue; // 该区域不存在，不必请求
        const img = imgsRef.current.get(key);
        if (!img) {
          requestRef.current(rx, rz);
          continue;
        }
        const r = regionRect(rx, rz, view);
        ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
      }
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  /** 请求一个区域图（去重 + 缓存）。用 <img> 是为了让浏览器自己处理 ETag/304 协商缓存 */
  const requestRegion = useCallback(
    (rx: number, rz: number) => {
      const key = `${rx},${rz}`;
      const save = curRef.current;
      if (!save || inflightRef.current.has(key) || imgsRef.current.has(key)) return;
      inflightRef.current.add(key);
      const img = new Image();
      img.onload = () => {
        inflightRef.current.delete(key);
        imgsRef.current.set(key, img);
        scheduleDraw();
      };
      img.onerror = () => {
        // 单张失败不该卡住整屏：移除标记，下次重绘会再试
        inflightRef.current.delete(key);
      };
      img.src = `/api/servers/${serverId}/instances/${encodeURIComponent(instance)}/map/${encodeURIComponent(save)}/${rx}/${rz}.png`;
    },
    [serverId, instance, scheduleDraw],
  );

  // 把 requestRegion 的最新函数值交给 draw 使用（见 requestRef 处的说明）
  useEffect(() => {
    requestRef.current = requestRegion;
  }, [requestRegion]);

  // 尺寸变化与可见性变化都要重绘（隐藏期间 clientWidth 为 0，不能画）
  // ⚠ 依赖里同样必须有 phase：理由与滚轮 effect 完全相同 —— wrapRef 只在 ready
  //   阶段存在，空/不充分的依赖会让观察器永远挂不上（窗口缩放时不重绘）。
  useEffect(() => {
    if (!visible) return;
    scheduleDraw();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [visible, scheduleDraw, phase]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ---------- 交互 ----------
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = viewRef.current;
    dragRef.current = { x: e.clientX, y: e.clientY, camX: v.camX, camZ: v.camZ };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 用拖动起点算总位移（而不是逐帧累加），避免误差累积与丢帧导致的漂移
    viewRef.current = panBy({ camX: d.camX, camZ: d.camZ, zoom: viewRef.current.zoom }, e.clientX - d.x, e.clientY - d.y);
    scheduleDraw();
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  };

  /** 以某个屏幕点为锚点缩放（滚轮处的内容保持不动，手感才对） */
  const zoomAt = (factor: number, sx: number, sy: number) => {
    const next = zoomAround(viewRef.current, factor, sx, sy);
    if (next === viewRef.current) return; // 已到上限/下限
    viewRef.current = next;
    setZoomUi(next.zoom);
    scheduleDraw();
  };

  // 把 zoomAt 的最新函数值交给原生 wheel 监听
  useEffect(() => {
    zoomRef.current = zoomAt;
  });

  // ---------- 滚轮缩放：必须用**非被动**原生监听 ----------
  //
  // ⚠ 不能用 React 的 onWheel + e.preventDefault()：
  //   React 17+ 把 `wheel`（以及 touchstart/touchmove）注册为**被动监听**（passive: true），
  //   被动监听里调用 preventDefault() 是**无效的**（浏览器会忽略并可能打印警告）。
  //   结果就是：滚轮缩放地图的同时，整个页面也跟着上下滚动 —— 这正是用户报的那个 bug。
  //   唯一可靠做法是自己用 { passive: false } 绑原生监听，再阻止默认行为。
  // ⚠ 依赖里**必须**有 phase：主树（含 wrapRef 那个 div）只在 ready 阶段才渲染，
  //   而这个 effect 在挂载时最先跑 —— 那一刻 phase 还是 'loading'，wrapRef.current
  //   是 null，于是直接 return 且**空依赖数组让它永不再试** → 滚轮监听从未挂上，
  //   表现为「滚轮不缩放、页面照样滚」。这正是上一轮那个 preventDefault 修复
  //   看起来生效、实际空转的原因。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      // 阻止页面滚动（含滚动链）：在地图上滚轮只用来缩放
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [phase]);

  /** 居中到世界坐标 */
  const doCenterOn = (bx: number, bz: number) => {
    const wrap = wrapRef.current;
    const v = viewRef.current;
    viewRef.current = centerOnView(bx, bz, v.zoom, wrap?.clientWidth ?? 0, wrap?.clientHeight ?? 0);
    scheduleDraw();
  };

  if (phase === 'loading') {
    return <div className={`grid place-items-center text-xs text-muted-foreground ${heightClass}`}>{$('common.loading')}</div>;
  }
  if (phase === 'error') {
    return (
      <div className={`grid place-items-center text-xs text-destructive ${heightClass}`}>
        {$('map.error')}
        {msg ? `：${msg}` : ''}
      </div>
    );
  }
  if (phase === 'empty') {
    return (
      <div className={`grid place-items-center gap-1 text-center text-xs text-muted-foreground ${heightClass}`}>
        <span>{$('map.empty')}</span>
        <span className="text-[11px] opacity-80">{$('map.emptyHint')}</span>
      </div>
    );
  }

  const totalRegions = saves.find((s) => s.save === cur)?.regions.length ?? 0;

  return (
    <div className="grid gap-2">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        {saves.length > 1 && (
          <Select value={cur} onValueChange={setCur}>
            <SelectTrigger className="h-8 w-40" aria-label={$('map.world')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {saves.map((s) => (
                <SelectItem key={s.save} value={s.save}>
                  {s.save}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <span className="text-[11px] text-muted-foreground">{$('map.regionCount', totalRegions)}</span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={$('map.zoomOut')}
            onClick={() => {
              const wrap = wrapRef.current;
              zoomAt(1 / 1.2, (wrap?.clientWidth ?? 0) / 2, (wrap?.clientHeight ?? 0) / 2);
            }}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span className="w-12 text-center font-mono text-[11px] text-muted-foreground">{zoomUi.toFixed(2)}×</span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={$('map.zoomIn')}
            onClick={() => {
              const wrap = wrapRef.current;
              zoomAt(1.2, (wrap?.clientWidth ?? 0) / 2, (wrap?.clientHeight ?? 0) / 2);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 画布 */}
      <div ref={wrapRef} className={`relative overflow-hidden overscroll-contain rounded-xl border bg-[#0b0f14] ${heightClass}`}>
        <canvas
          ref={canvasRef}
          className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/70 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
          {$('map.hint')}
        </div>
      </div>

      {/* 坐标跳转 */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor="map-x" className="text-[11px]">
            {$('map.coordX')}
          </Label>
          <Input
            id="map-x"
            className="h-8 w-24"
            inputMode="numeric"
            value={jumpX}
            onChange={(e) => setJumpX(e.target.value)}
            placeholder="0"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="map-z" className="text-[11px]">
            {$('map.coordZ')}
          </Label>
          <Input
            id="map-z"
            className="h-8 w-24"
            inputMode="numeric"
            value={jumpZ}
            onChange={(e) => setJumpZ(e.target.value)}
            placeholder="0"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!jumpX.trim() || !jumpZ.trim()}
          onClick={() => {
            const x = Number(jumpX);
            const z = Number(jumpZ);
            if (!Number.isFinite(x) || !Number.isFinite(z)) return;
            doCenterOn(x, z);
          }}
        >
          <Crosshair className="h-3.5 w-3.5" /> {$('map.go')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            viewRef.current = { camX: -REGION_BLOCKS / 2, camZ: -REGION_BLOCKS / 2, zoom: 1 };
            setZoomUi(1);
            scheduleDraw();
          }}
        >
          {$('map.reset')}
        </Button>
      </div>
    </div>
  );
}
