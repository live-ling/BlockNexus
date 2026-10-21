/**
 * 控制台原语（来源：`/proto` 第六版的 `proto-ui.tsx`，落地版）。
 *
 * 与原型版的差别：
 *   · 颜色改用语义令牌，深色主题自动跟随；
 *   · 文案键由调用方传入（这里不认识任何业务状态），
 *   · 原型里「列表页/设置页」共用的小件（Pill / Bar / KV / Field / 抽屉）都在这里，
 *     改一次全站生效。
 */

import type { ComponentProps, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from 'cn';
import { INPUT_CLASS, LABEL, SURFACE } from './tokens';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

const DOT_TONE: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  idle: 'bg-muted-foreground/50',
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

/** 细进度条（资源占用），固定宽度避免行内跳动 */
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

/** 资源占用 → 色调：>90 危险、>75 警告，其余正常 */
export function usageTone(pct: number): Tone {
  return pct > 90 ? 'bad' : pct > 75 ? 'warn' : 'ok';
}

/**
 * 内容面（卡片）。`flush` 给需要自己管内边距的内容（文件树、表格）。
 * 注意：列表页的卡片是整块可点的，不要在这里画分割线。
 */
export function Surface({
  children,
  className,
  flush,
  ...rest
}: ComponentProps<'div'> & {
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <div className={cn(SURFACE, flush ? '' : 'p-3.5', className)} {...rest}>
      {children}
    </div>
  );
}

/** 只读键值行（信息展示，不用于表单） */
export function KV({
  label,
  children,
  mono,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-baseline justify-between gap-2', className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right', mono && 'font-mono')}>{children}</span>
    </span>
  );
}

/** 表单行：标签在上、控件在下 */
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
        className={cn(INPUT_CLASS, 'pr-2 pl-8')}
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

/** 分段控件（筛选/视图切换） */
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
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <p className="text-[12.5px] font-medium">{title}</p>
      {hint && <p className="max-w-md text-[11.5px] text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

/** 分区标题：15px 标题 + 可选说明，右侧放操作 */
export function SectionHeading({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {hint && <p className="mt-0.5 text-[11px] text-muted-foreground/80">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

/** 卡片里的窄标签行（设置页/详情页的字段名） */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn(LABEL, className)}>{children}</span>;
}

/** 设置页的分区：标题 + 内容，不套卡片、不画线（靠间距分组） */
export function Group({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('grid gap-3', className)}>
      {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
      {children}
    </section>
  );
}

/** 抽屉里的一个字段块：标签在上、控件在下 */
export function FilterField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** 抽屉里的状态筛选：两列/三列按钮组（比 select 少一次点击） */
export function FilterChoices<T extends string>({
  value,
  options,
  onChange,
  columns = 2,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  columns?: 2 | 3;
}) {
  return (
    <div className={cn('grid gap-1.5', columns === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'h-8 rounded-md border text-[11.5px] transition-colors',
            value === o.value
              ? 'border-foreground/20 bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
