/**
 * 实例页的局部展示组件（只服务实例详情页，不改动通用组件）。
 *
 * 这些组件原来全部内联在 `pages/instance-detail.tsx` 尾部（那文件一度 1977 行），
 * 拆出来是为了让主页面文件只保留「编排」职责。
 *
 * ⚠ 布局硬约束（改这里之前先读 `pages/instance-detail.tsx` 顶部注释）：
 *   整页不滚动 `h-screen + overflow-hidden`；高度链 `100vh → flex-1 → min-h-0`；
 *   指标条高度写死 72px；主操作按钮位置/宽度恒定。
 */

import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { instanceIconUrl } from '@/lib/api';
import { $ } from '@/lib/i18n';

/**
 * 指标条：一条 72px 的分段 strip，取代三张各自带卡壳的 104px 卡——
 * 省掉卡与卡之间的间距/圆角空耗，把 36px 竖向空间还给内容区。
 * 高度写死仍然是为了防跳动；分段之间用 1px 发丝线，不用分割卡片。
 */
export function MetricStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="shrink-0">
      <div className="grid h-[72px] grid-cols-3 overflow-hidden rounded-lg border border-border/70 bg-card shadow-xs sm:divide-x sm:divide-border/60">
        {children}
      </div>
    </div>
  );
}

/** 指标条的一格：11px 大写标签 + 20px 大数字 + 辅助行 */
export function MetricCell({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1.5 px-3.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <p className="truncate text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
        {icon && <span className="ml-auto shrink-0 text-muted-foreground/60 [&_svg]:size-3">{icon}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

/** 数值行：20px mono + 小字号后缀（strip 里没有卡壳撑场，字号略收一档） */
export function MetricValue({ value, suffix }: { value: string; suffix?: string }) {
  return (
    <div className="flex h-5 shrink-0 items-baseline gap-1 overflow-hidden">
      <span className="truncate text-[20px] leading-none font-semibold tracking-tight tabular-nums">{value}</span>
      {suffix && <span className="shrink-0 text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

/** 辅助行：文字/进度条都装在 h-4 里，保证文字型与条型辅助行等高 */
export function MetricHelper({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="flex h-4 shrink-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground" title={title}>
      {children}
    </div>
  );
}

/** 趋势/状态胶囊（中性灰，不用状态色——颜色留给头部呼吸灯） */
export function MetricTrend({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

/** 进度条型辅助行（ratio 0~1；trailing 是右侧的小号数值说明） */
export function MetricBar({
  ratio,
  tone,
  trailing,
  title,
}: {
  ratio: number;
  tone: string;
  trailing?: string;
  title?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100);
  return (
    <MetricHelper title={title}>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {trailing && <span className="shrink-0 font-mono text-[11px] leading-[14px]">{trailing}</span>}
    </MetricHelper>
  );
}

export function Dot({ tone = 'bg-emerald-500' }: { tone?: string }) {
  return <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />;
}

/** 配置页的一行入口：icon + 标题 + 说明 + 当前值摘要 + 打开按钮 */
export function ConfigRow({
  icon: Icon,
  title,
  hint,
  value,
  action,
  disabled,
  onOpen,
}: {
  icon: typeof Sparkles;
  title: string;
  hint: string;
  value?: string;
  action: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
      {value && (
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:block">{value}</span>
      )}
      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={disabled} onClick={onOpen}>
        {action}
      </Button>
    </div>
  );
}

/** 维护页诊断的一行入口 */
export function DiagRow({
  icon: Icon,
  title,
  desc,
  disabled,
  onOpen,
}: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted/50 text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{desc}</p>
      </div>
      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={disabled} onClick={onOpen}>
        {$('instanceDetail.config.open')}
      </Button>
    </div>
  );
}

/**
 * 全屏浮层：地图 / AI 分析 / Spark 这类重内容的家。
 * 为什么是全屏而不是 46vh 就地展开：就地展开会把当前页签挤成残废；
 * 为什么不是抽屉：这些内容本身就占满一屏（地图/长文结果），抽屉反而窄。
 * Esc / 右上角关闭；fixed 定位不受页面 overflow-hidden 影响。
 */
export function FullScreenOverlay({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <h2 className="truncate text-[13px] font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          title={$('common.close')}
          aria-label={$('common.close')}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </div>
  );
}

/** 主区页签：下划线式，不用灰底药丸，避免和驾驶舱抢层级 */
export function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative -mb-px flex h-10 shrink-0 items-center border-b-2 px-3 text-[13px] transition-colors ${
        active
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}

/**
 * 实例图标：优先用游戏内的 server-icon（编辑里上传的 64×64 PNG），
 * 没有则回退到等距立方体方块（38×38 圆角）。
 */
export function InstanceIcon({ serverId, instance }: { serverId: string; instance: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div className="grid h-[38px] w-[38px] shrink-0 place-items-center overflow-hidden rounded-[10px] border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
      {missing ? (
        <CubeGlyph className="h-5 w-5" />
      ) : (
        <img
          src={instanceIconUrl(serverId, instance)}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setMissing(true)}
        />
      )}
    </div>
  );
}

/** 等距立方体（服务器图标占位/回退图形） */
function CubeGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M12 2.4 21 7.2v9.6L12 21.6 3 16.8V7.2z" fill="currentColor" opacity="0.16" />
      <path d="M12 2.4 21 7.2 12 12 3 7.2z" fill="currentColor" opacity="0.9" />
      <path d="M12 12v9.6L3 16.8V7.2z" fill="currentColor" opacity="0.5" />
      <path d="M21 7.2v9.6L12 21.6V12z" fill="currentColor" opacity="0.72" />
    </svg>
  );
}
