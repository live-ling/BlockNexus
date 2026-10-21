// 原型共享原语（临时）。F1 时把这里经过确认的部分抽到 components/，其余随原型删除。
//
// 尺寸约定（对应 docs/frontend-redesign-design.md §4）：
//   Rail 208 / PageHeader 52 / Toolbar 40 / Tab 36 / StatusBar 28 / 表格行 30 / 面板内边距 12

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from 'cn';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

const DOT_TONE: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  idle: 'bg-zinc-400 dark:bg-zinc-500',
  info: 'bg-sky-500',
};

export function Dot({ tone = 'ok', className }: { tone?: Tone; className?: string }) {
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', DOT_TONE[tone], className)} />;
}

const PILL_TONE: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  idle: 'border-border bg-muted/50 text-muted-foreground',
  info: 'border-primary/25 bg-primary/10 text-foreground',
};

/** 行内小徽章：18px 高，不抢行高 */
export function Pill({
  children,
  tone = 'idle',
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center gap-1 rounded border px-1.5 text-[10.5px] leading-none font-medium whitespace-nowrap',
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 细进度条（资源/内存占用），宽度固定避免行内跳动 */
export function Bar({
  value,
  tone = 'ok',
  className,
}: {
  value: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span className={cn('inline-block h-1 w-9 shrink-0 overflow-hidden rounded-full bg-muted', className)}>
      <span
        className={cn('block h-full rounded-full', DOT_TONE[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </span>
  );
}

/** 分区面板：唯一允许的「卡片」，固定 36px 标题栏 + 12px 内边距 */
export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  bodyClassName,
  flush,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** 表格类内容自己管内边距 */
  flush?: boolean;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col rounded-lg border bg-card', className)}>
      {(title || actions) && (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          {title && <h2 className="text-[12px] font-semibold">{title}</h2>}
          {hint && <span className="truncate text-[11px] text-muted-foreground">{hint}</span>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1', flush ? '' : 'p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/** 只读键值行（信息展示，不用于表单） */
export function KV({
  label,
  children,
  mono,
  className,
  labelClassName,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  className?: string;
  labelClassName?: string;
}) {
  return (
    <div className={cn('flex min-w-0 items-baseline gap-3', className)}>
      <span className={cn('w-[76px] shrink-0 text-[11.5px] text-muted-foreground', labelClassName)}>{label}</span>
      <span className={cn('min-w-0 flex-1 truncate text-[12px]', mono && 'font-mono text-[11.5px]')}>{children}</span>
    </div>
  );
}

/** 表单行：标签在上、控件在下，两列网格里密度最高且不会出现窄长输入框 */
export function Field({
  label,
  hint,
  children,
  wide,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  return (
    <label className={cn('grid min-w-0 content-start gap-1', wide && 'col-span-2', className)}>
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="text-[10.5px] leading-4 text-muted-foreground/80">{hint}</span>}
    </label>
  );
}

export function FormGrid({ children, className }: { children: ReactNode; className?: string }) {
  // 620：两列各约 300，够放地址/路径，又不会让「内存 8192」这种短值输入框拉到 700 宽
  return <div className={cn('grid max-w-[620px] grid-cols-2 gap-x-4 gap-y-3.5', className)}>{children}</div>;
}

/** 列表工具栏：44px，搜索按内容宽度（不再拉满），筛选/视图靠右 */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-2 border-b px-4', className)}>{children}</div>
  );
}

export function SearchInput({
  placeholder,
  value,
  onChange,
  className,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-border bg-background pr-2 pl-8 text-[12px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring"
      />
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-8 shrink-0 rounded-md border border-border bg-background px-2 text-[11.5px] outline-none focus-visible:border-ring',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** 分段控件（筛选用）；视图切换也走它，图标 + 文字都可 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md border bg-muted/40 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded px-2.5 text-[11.5px] whitespace-nowrap transition-colors',
            o.value === value
              ? 'bg-background font-medium text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 空态：一行说明 + 可选操作，不铺大留白 */
export function EmptyState({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-8 text-center', className)}>
      <p className="text-[12.5px] font-medium">{title}</p>
      {hint && <p className="max-w-md text-[11.5px] text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

/** 表单输入的原型样式：36px 高（与放开的行高一致） */
export const INPUT_CLASS =
  'h-9 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-[12.5px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring disabled:opacity-60';

