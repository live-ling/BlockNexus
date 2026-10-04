import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  showValue = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { showValue?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value || 0)))
  const bar = (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="size-full flex-1 bg-primary transition-all"
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  )
  if (!showValue) return bar
  return (
    <div data-slot="progress-with-value" className="flex w-full items-center gap-2">
      <div className="min-w-0 flex-1">{bar}</div>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {pct}%
      </span>
    </div>
  )
}

export { Progress }
