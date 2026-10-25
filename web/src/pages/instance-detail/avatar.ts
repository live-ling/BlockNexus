/**
 * 玩家名 → 头像底色（同名恒定；用 Tailwind 调色板类，不引入新 token）。
 *
 * 单独成文件：Fast Refresh 要求「只导出组件」的文件不混入纯函数导出。
 */

/** 玩家名 → 头像底色（同名恒定） */
const AVATAR_TONES = [
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-orange-500',
  'bg-indigo-500',
];

export function avatarTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 100003;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
