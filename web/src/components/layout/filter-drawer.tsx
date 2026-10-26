/**
 * 右侧抽屉式筛选（沿用早期布局原型的 FilterDrawer 形态）。
 *
 * 设计意图：列表默认只有卡片，不再常驻一条工具栏；搜索/筛选/排序收进右边缘的竖标签里，
 * 需要时点开，占 320px，不挤压卡片区。
 */

import { useState, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { $ } from '@/lib/i18n';

export function FilterDrawer({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 贴边隐藏：平时只在右边缘露出 7px，鼠标靠近才滑出来 */}
      <div className="group fixed top-1/2 right-0 z-30 -translate-y-1/2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={$('ui.filter.title')}
          aria-label={$('ui.filter.title')}
          className="flex translate-x-[calc(100%-7px)] flex-col items-center gap-1 rounded-l-md border border-r-0 bg-card py-2.5 pr-1 pl-1.5 text-[10.5px] text-muted-foreground shadow-sm transition-transform duration-200 ease-out group-hover:translate-x-0 hover:text-foreground focus-visible:translate-x-0"
        >
          <SlidersHorizontal className="size-3.5" />
          <span className="tracking-[0.18em] [writing-mode:vertical-rl]">{$('ui.filter.title')}</span>
        </button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[320px] gap-0 p-0 sm:max-w-[320px]">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SheetTitle className="text-[13px] font-semibold">{$('ui.filter.title')}</SheetTitle>
            <SheetClose asChild>
              <Button size="icon-sm" variant="ghost" className="ml-auto">
                <X />
              </Button>
            </SheetClose>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
