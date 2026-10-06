import { Languages } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { $, LANGUAGE_LABELS, getLanguage, setLanguage, type LanguageCode } from '@/lib/i18n';

/**
 * 中/英语言切换。点击后整页刷新 —— 最简做法，且不会留下半翻译的界面。
 *
 * 为什么用刷新而不是状态订阅：
 *   语言包在渲染时按当前语言取词（`$()` 是同步函数），刷新一次即可全局生效；
 *   做响应式则要引入订阅 + 强制重渲染，对两种语言的场景属过度设计。
 *   代价：未保存的表单内容会丢，因此不适合放进正在编辑的表单里。
 */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const current = getLanguage();
  const other: LanguageCode = current === 'zh' ? 'en' : 'zh';
  const label = $('common.language');
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      className={`h-8 gap-1.5 px-2.5 text-xs font-normal text-muted-foreground hover:text-foreground ${className}`}
      onClick={() => {
        setLanguage(other);
        location.reload();
      }}
    >
      <Languages className="h-3.5 w-3.5" />
      {LANGUAGE_LABELS[other]}
    </Button>
  );
}
