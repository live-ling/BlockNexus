/**
 * 页面唯一标题栏（沿用早期布局原型的 PageHeader）。
 *
 * 约定（docs/frontend-redesign-design.md §2）：
 *   · 只放「标题 / 副标题 / 页面自己的操作」；
 *   · 连接状态、安装进度、版本更新**不进页头**（它们要么在设置页，要么是全局提示）；
 *   · 高度固定 52px，标题 13px 半粗——页头是框架，不是内容。
 */

import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { $ } from '@/lib/i18n';

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 传了才显示返回箭头 */
  back?: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={
        'flex h-13 shrink-0 items-center gap-2 border-b border-border/70 bg-background px-5 ' + (className ?? '')
      }
    >
      {back && (
        <button
          type="button"
          onClick={back}
          title={$('common.back')}
          aria-label={$('common.back')}
          className="-ml-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      )}
      <div className="flex min-w-0 items-baseline gap-2">
        <h1 className="truncate text-[13px] font-semibold">{title}</h1>
        {subtitle && <span className="truncate text-[11.5px] text-muted-foreground">{subtitle}</span>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** 页面主体：滚动容器。底部留 24 给悬浮导航，别让最后一行卡片被盖住。 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={'min-h-0 flex-1 overflow-y-auto bg-muted/30 ' + (className ?? '')}>
      <div className="p-5 pb-24">{children}</div>
    </div>
  );
}
