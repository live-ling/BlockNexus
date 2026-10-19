// 设置页通用卡片与表单原语：面板设置与「网络助手」两张卡共用。
//
// 为什么单独抽出来：DDNS / frp 卡片放在独立文件里（panel-settings-network.tsx），
// 如果直接反向 import panel-settings.tsx 会形成循环依赖；这几个原语本身也没有
// 任何状态，抽成无依赖组件最干净。

import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';

// 卡片主题色：图标底色 + 描边，让各设置分区一眼可辨（Tailwind 需静态类名，故用查表）
export const ACCENTS = {
  security: 'border-indigo-500/25 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  network: 'border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  mail: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  notify: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  ai: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  update: 'border-cyan-500/25 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
  language: 'border-pink-500/25 bg-pink-500/10 text-pink-600 dark:text-pink-400',
  info: 'border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-400',
} as const;

export type Accent = keyof typeof ACCENTS;

/** 统一卡片：图标 + 标题 + 说明 + 右上角状态 + 内容 */
export function SettingsCard({
  title,
  description,
  icon,
  status,
  accent,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  icon: React.ReactNode;
  status?: React.ReactNode;
  accent?: Accent;
  children: React.ReactNode;
  className?: string;
}) {
  const iconClass = accent ? ACCENTS[accent] : 'bg-muted/60 text-foreground';
  return (
    <Card className={`ring-1 ring-border ${className}`}>
      <CardContent className="flex flex-col gap-4 p-5">
        {/* 头部（固定） */}
        <div className="flex items-center gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border ${iconClass}`}>
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <b className="text-sm">{title}</b>
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {status && <div className="shrink-0 self-start">{status}</div>}
        </div>
        {/* 内容区拉伸，按钮沉底 */}
        <div className="flex flex-1 flex-col gap-4">{children}</div>
      </CardContent>
    </Card>
  );
}

/** 字段：标签 + 可选提示/错误 + 控件 */
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
    <div className={`grid content-start gap-1.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && !error && <span className="text-[11px] text-muted-foreground">{hint}</span>}
        {error && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
      {children}
    </div>
  );
}

/** 卡片右上角的配置状态小标 */
export function StateChip({ ok, okText, badText }: { ok: boolean; okText: string; badText: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        ok
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-border bg-muted/50 text-muted-foreground'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted-foreground/60'}`} />
      {ok ? okText : badText}
    </span>
  );
}
