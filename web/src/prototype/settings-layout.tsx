// 设置页骨架（原型，2026-10-21 第四版）。
//
// 这一版修了三处：
//   ① 滚动：整页只保留**一个**滚动容器（原来只有右侧内容区能滚，鼠标停在左侧目录上滚不动）；
//   ② 目录改为 sticky，滚动时始终可见；
//   ③ 分区之间不再画分割线，只留间距（13px 标题 + 上方 28px 空白即可分组）。
//
// 跳转用 scrollTo 直接算偏移，不用 scrollIntoView——后者会把滚轮事件冒泡给外层可滚动元素，
// 在「整页 + 卡片 + 抽屉」叠着的界面里容易滚到意料之外的位置。

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
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`#settings-${id}`);
    if (!box || !el) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8;
    box.scrollTo({ top, behavior: 'smooth' });
    setActive(id);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto" ref={scroller} onScroll={onScroll}>
      <div className="flex items-start">
        <nav className="sticky top-0 flex w-[190px] shrink-0 flex-col gap-0.5 self-start px-2.5 py-5">
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

        <div className="min-w-0 max-w-[720px] flex-1 px-6 pt-5 pb-24">
          {sections.map((s, i) => (
            <section key={s.id} id={`settings-${s.id}`} className={cn('scroll-mt-2', i > 0 && 'mt-7')}>
              <h2 className="text-[13px] font-semibold">{s.label}</h2>
              <div className="mt-3">{s.content}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
