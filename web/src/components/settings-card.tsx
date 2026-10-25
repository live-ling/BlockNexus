// 设置页通用原语：分区块 + 字段行 + 状态胶囊，面板设置与「网络助手」共用。
//
// 2026-10-25 改版（去卡中卡）：设置页的分区骨架是「左目录 + 右侧全量分区」，
// 分区内部**不再套卡片**——原来每块都是 rounded-xl + border + shadow + 彩色图标，
// 一个分区里叠三四张卡，既挤又和新版灰阶视觉冲突。
// 现在靠层级分组：13px 区块标题 → 11.5px 字段标签 → 13px 控件值，
// 颜色只留给状态（StateChip / 错误文字）。
//
// 为什么原语单独成文件：DDNS / frp 在 panel-settings-network.tsx 里，
// 直接反向 import panel-settings.tsx 会形成循环依赖。

import { Label } from '@/components/ui/label';
import { cn } from 'cn';

/** 设置分块：13px 标题 + 11px 说明 + 右上状态/操作；内容不套卡片壳 */
export function SettingsCard({
  title,
  description,
  status,
  actions,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  status?: React.ReactNode;
  /** 标题行右侧的操作按钮（与状态互斥使用，谁重要放谁） */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('grid gap-3', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold tracking-tight">{title}</h3>
          {description && (
            <p className="mt-0.5 max-w-[560px] text-[11px] leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : status ? <div className="shrink-0 pt-0.5">{status}</div> : null}
      </header>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

/** 字段：11.5px 标签 + 控件 + 提示/错误在控件下方（保证同一排的输入框顶边对齐） */
export function Field({
  htmlFor,
  label,
  hint,
  error,
  className = '',
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  error?: string;
  /** 用于跨列（如 sm:col-span-2 让字段占满整行） */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-[11.5px] font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
      {error ? (
        <span className="text-[10.5px] leading-4 text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[10.5px] leading-4 text-muted-foreground/70">{hint}</span>
      ) : null}
    </div>
  );
}

/** 表单双列：620 上限，短字段不会被拉成整行宽 */
export function FormGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('grid max-w-[620px] gap-x-4 gap-y-3 sm:grid-cols-2', className)}>{children}</div>;
}

/** 字段行的操作条：按钮靠右、与字段同宽 */
export function FormActions({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex max-w-[620px] flex-wrap items-center justify-end gap-2', className)}>{children}</div>;
}

/** 区块右上角的配置状态小标 */
export function StateChip({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center gap-1.5 rounded border px-1.5 text-[10.5px] leading-none font-medium',
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
          : 'border-border bg-muted/50 text-muted-foreground',
      )}
    >
      <span className={cn('size-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-muted-foreground/60')} />
      {ok ? okText : badText}
    </span>
  );
}
