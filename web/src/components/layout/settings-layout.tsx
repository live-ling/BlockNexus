/**
 * 设置页骨架（沿用早期布局原型的 SettingsLayout）：左目录（sticky）+ 右侧一次性列出全部分区。
 *
 * 三条硬约定（原型阶段踩过坑，别改回去）：
 *   ① **整页只有一个滚动容器**：原来只有右侧内容区能滚，鼠标停在左侧目录上滚不动；
 *   ② 目录 sticky，滚动时始终可见，并按「最后一个越过顶部的分区」高亮；
 *   ③ 分区之间不画分割线，只留间距（13px 标题 + 上方 28px 空白）。
 *
 * 跳转用 scrollTo 直接算偏移，不用 scrollIntoView——后者会把滚轮事件冒泡给外层
 * 可滚动元素，在「整页 + 卡片 + 抽屉」叠着的界面里容易滚到意料之外的位置。
 */

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cn } from 'cn';

export type SettingsSection = {
  id: string;
  /** 左侧目录里的名字 */
  label: ReactNode;
  /** 分区内容 */
  content: ReactNode;
  /**
   * 是否在正文里再渲染一遍分区标题。
   * 面板设置是「一个分区装几张小卡」→ true；服务器设置是「一张卡就是一分区」→ false
   * （卡自己已有标题，再打一遍就重复了）。
   */
  heading?: boolean;
};

export function SettingsLayout({
  sections,
  contentClassName = 'max-w-[760px]',
}: {
  sections: SettingsSection[];
  /** 右侧内容列宽：面板设置用 680（表单 620 + 呼吸），服务器设置保持 760 */
  contentClassName?: string;
}) {
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
    <div className="min-h-0 flex-1 overflow-y-auto" ref={scroller} onScroll={onScroll}>
      <div className="flex items-start">
        <nav className="sticky top-0 hidden w-[190px] shrink-0 flex-col gap-0.5 self-start px-3 py-5 md:flex">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jump(s.id)}
              className={cn(
                'flex h-8 items-center rounded-md px-2 text-left text-[12px] transition-colors',
                active === s.id
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </nav>

        <div className={cn('min-w-0 flex-1 px-5 pt-5 pb-24 md:px-6', contentClassName)}>
          {sections.map((s, i) => (
            <section key={s.id} id={`settings-${s.id}`} className={cn('scroll-mt-2', i > 0 && 'mt-7')}>
              {s.heading !== false && <h2 className="text-[13px] font-semibold">{s.label}</h2>}
              <div className={s.heading === false ? '' : 'mt-3'}>{s.content}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
