// 任务日志查看器：自动滚到底部 + 用户上滑查看历史时自动让位（follow-tail）
//
// 安装/卸载日志是流式追加的，最自然的阅读方式是跟着最新一行走；
// 但用户往回翻看历史时不该被强行拽回底部，因此这里实现经典的 "user follows tail"：
// 只有当用户已经贴在底部（误差 24px 内）时才自动滚动。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { $ } from '@/lib/i18n';

/** 距底部多少像素以内算「贴着底部」 */
const STICK_THRESHOLD = 24;

export function LogViewer({ lines, className = '' }: { lines: string; className?: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  // 是否跟随尾部：null 表示还不知道（初次渲染），true 后自动滚动
  const stickRef = useRef<boolean>(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  const onScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    stickRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  // 内容变化时跟随：仅当此前贴着底部才滚
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom();
    else setShowJump(true);
  }, [lines, scrollToBottom]);

  // 首次挂载（含刷新后重放历史）直接落到底部
  useEffect(() => {
    scrollToBottom();
    // 结束后再看一次是否被内容撑高，保证贴底
    const t = window.setTimeout(() => {
      if (stickRef.current) scrollToBottom();
    }, 60);
    return () => window.clearTimeout(t);
  }, [scrollToBottom]);

  const jumpToBottom = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
  };

  return (
    <div className={`relative ${className}`}>
      <div
        ref={viewportRef}
        onScroll={onScroll}
        className="h-44 overflow-y-auto overscroll-contain rounded-lg border bg-muted/20"
      >
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-muted-foreground">
          {lines}
        </pre>
      </div>
      {showJump && (
        <Button
          variant="secondary"
          size="sm"
          className="absolute bottom-2 right-3 h-7 gap-1 rounded-full px-2.5 text-[11px] shadow-sm"
          onClick={jumpToBottom}
        >
          <ArrowDown className="h-3 w-3" /> {$('logViewer.jumpToLatest')}
        </Button>
      )}
    </div>
  );
}
