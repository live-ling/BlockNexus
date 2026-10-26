/**
 * 控制台视觉令牌（源自早期布局原型的「亮色极简控制台」，见 docs/frontend-redesign-design.md）。
 *
 * 为什么是常量而不是 CSS 变量：这些是**组合**（表面 + 边框 + 圆角 + 阴影 + 字号），
 * 单独一个变量表达不了；集中在这里是为了让「卡片长什么样」只有一处定义，
 * 改版时不会因为某个页面漏改而出现两种卡片。
 *
 * 颜色一律走语义令牌（`bg-card` / `border-border` / `text-muted-foreground`），
 * 不用 `slate-*` 硬编码——原型里写死 slate 只是为了看效果，
 * 真实页面必须跟着主题（含深色）一起变。
 */

/** 内容面：纯卡片色 + 极细边框 + 最轻阴影。页面底色另外用 `bg-muted/30`。 */
export const SURFACE = 'rounded-xl border border-border/70 bg-card shadow-xs';

/** 卡片内的分隔线（比外边框更淡，避免「每块都框起来」的表格感） */
export const HAIRLINE = 'border-border/60';

/** 全大写小标签：字段名 / 元数据键 */
export const LABEL = 'text-[11px] font-medium tracking-wider text-muted-foreground uppercase';

/** 次要文字（说明、时间戳） */
export const MUTED = 'text-muted-foreground/70';

/** 正文次要色（一句摘要） */
export const BODY_MUTED = 'text-muted-foreground';

/** 模块标题：15px，只比正文大一档 */
export const TITLE = 'text-[15px] font-semibold tracking-tight';

/** 强调文字色 */
export const STRONG = 'text-foreground';

/** 表单输入：32px，与列表行高/工具栏控件对齐 */
export const INPUT_CLASS =
  'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring disabled:bg-muted/50 disabled:text-muted-foreground';

/** 主操作：中性深色（不用主题色，避免每个页面都跳一块亮蓝） */
export const BTN_PRIMARY =
  'h-7 bg-foreground px-3 text-[13px] font-normal text-background shadow-xs hover:bg-foreground/85';
