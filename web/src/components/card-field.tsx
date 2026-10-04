// 卡片内的一格信息：定宽标签列 + 左对齐值（列表卡片统一排版用）

export function CardField({
  label,
  value,
  icon,
  tone,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'good' | 'primary' | 'warn';
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 items-baseline gap-1.5 ${className}`}>
      <span className="flex w-[4.1em] shrink-0 items-center gap-1 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={`min-w-0 break-words font-mono ${
          tone === 'good'
            ? 'font-medium text-emerald-600 dark:text-emerald-400'
            : tone === 'primary'
              ? 'text-primary'
              : tone === 'warn'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-foreground'
        }`}
      >
        {value}
      </span>
    </div>
  );
}
