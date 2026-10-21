// 设置页骨架（原型）：左侧目录 + 右侧「所有分区一路排下来」。
//
// 与上一版的差别：
//   ① 不再点一个分页才看一块，右侧一次性展示全部设置项，左边只当目录/锚点；
//   ② 取消卡片束缚——分区之间只用一条分隔线，不再套边框面板。

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cn } from 'cn';

export type SettingsSection = { id: string; label: string; content: ReactNode };

export function SettingsLayout({ sections }: { sections: SettingsSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const scroller = useRef<HTMLDivElement>(null);

  // 滚动时高亮「当前读到哪一节」：取最后一个已经越过容器顶部的分区
  const onScroll = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    let current = sections[0]?.id ?? '';
    for (const s of sections) {
      const el = box.querySelector<HTMLElement>(`#settings-${s.id}`);
      if (el && el.getBoundingClientRect().top - top <= 36) current = s.id;
    }
    setActive(current);
  }, [sections]);

  const jump = (id: string) => {
    scroller.current?.querySelector<HTMLElement>(`#settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(id);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 border-r px-2.5 py-4">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jump(s.id)}
            className={cn(
              'flex h-9 items-center rounded-md px-2 text-left text-[12px] transition-colors',
              active === s.id
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div ref={scroller} onScroll={onScroll} className="min-w-0 flex-1 overflow-auto">
        <div className="max-w-[720px] px-6 py-5">
          {sections.map((s, i) => (
            <section
              key={s.id}
              id={`settings-${s.id}`}
              className={cn('scroll-mt-3', i > 0 && 'mt-7 border-t pt-7')}
            >
              <h2 className="text-[13px] font-semibold">{s.label}</h2>
              <div className="mt-3">{s.content}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
