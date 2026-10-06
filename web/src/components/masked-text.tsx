// 脱敏文本：默认显示圆点遮蔽，点击切换显示/隐藏（截图分享时默认不泄露地址）

import { useState } from 'react';

import { $ } from '@/lib/i18n';

export function MaskedText({
  value,
  /** 遮蔽时显示的字符数（按展示长度给个观感一致的点串） */
  dots = 10,
  className = '',
  title,
}: {
  value: string;
  dots?: number;
  className?: string;
  title?: string;
}) {
  const [shown, setShown] = useState(false);
  if (!value) return <span className={className}>—</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        // 阻止冒泡：卡片本身可点击（进入详情），点这里只应切换显示
        e.stopPropagation();
        e.preventDefault();
        setShown((s) => !s);
      }}
      title={shown ? $('maskedText.tooltip.hide') : $('maskedText.tooltip.show')}
      className={`max-w-full rounded px-0.5 text-left break-all hover:bg-muted ${className}`}
    >
      {shown ? value : '•'.repeat(dots)}
      <span className="ml-1 align-middle text-[10px] text-muted-foreground">
        {shown ? $('common.hide') : $('common.show')}
      </span>
      {title ? <span className="sr-only">{title}</span> : null}
    </button>
  );
}
