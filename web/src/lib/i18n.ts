/**
 * 轻量 i18n（自研，零依赖）。
 *
 * 设计取舍（为什么不用 i18next/react-intl）：
 *   本项目只有中英两种语言、纯前端渲染、只有面板自己的文案要翻。
 *   一个 ~100 行的同步实现即可，且更容易做到「键集完整性由 TypeScript 强制」。
 *
 * 关键约定：
 *   1. **同步取词**：`$()` 是纯同步函数，没有 loading 态、没有异步初始化。
 *      代价是语言包全量进 bundle（面板是本地/内网工具，体积不是瓶颈）。
 *      ⚠ 「同步 vs 懒加载」不能半途改：改成懒加载会让 `$()` 变 async，所有调用点都要动。
 *   2. **键集由 zh 包反推**：`TranslationKey = keyof typeof zh`，
 *      再用 `Record<TranslationKey, string>` 约束 en 包 —— 漏翻一个键 `tsc` 直接报错。
 *   3. **缺键回退返回键名本身**：界面显示 `console.send-failed` 比显示空白有用得多，
 *      一眼就能看出缺哪个键。
 *   4. **不做富文本引用语法**：OPanel 的 `@b{ref}` 那种语法，其 `while` 循环没有边界检查,
 *      译文里少写一个花括号会让页面直接挂死。这里只做纯文本 + `{0}` 占位。
 */

import { en } from './lang/en'
import { zh } from './lang/zh'

export type LanguageCode = 'zh' | 'en'

/** 语言包形状：扁平 string → string */
export type Translations = Record<string, string>

/**
 * 允许的键 —— 以中文包为准。
 * 因此**新增文案必须先写进 zh 包**；en 包缺键或多键由下面的类型守卫拦下。
 */
export type TranslationKey = keyof typeof zh

// 编译期守卫：en 必须**恰好**包含 zh 的全部键（既不缺也不多）。
//
// ⚠ 这里必须用 `satisfies` 而不是 `const x: Record<TranslationKey, string> = en`：
//   赋值给 Record 时 TS 的「多余属性检查」只对**对象字面量**生效，
//   而 `en` 是一个变量引用 —— 缺键不会报错，多键也不会报错。
//   早期版本正是踩了这个坑：以为有守卫，实际 en 少了 19 个键 tsc 却是绿的。
//   `satisfies` 保持 en 的字面量类型并强制其键集与 Record 完全一致。
const _enCompleteness = en satisfies Record<TranslationKey, string>
void _enCompleteness

export const LANGUAGES: Record<LanguageCode, Translations> = {
  zh: zh as Translations,
  en: en as Translations,
}

/** 语言选择器里显示的自称（每种语言用自己的文字写自己） */
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  zh: '简体中文',
  en: 'English',
}

const STORAGE_KEY = 'blocknexus.language'
const DEFAULT_LANGUAGE: LanguageCode = 'zh'

let currentLanguage: LanguageCode = DEFAULT_LANGUAGE

function isLanguageCode(v: unknown): v is LanguageCode {
  return v === 'zh' || v === 'en'
}

/**
 * 初始化：从 localStorage 恢复；无记录时尝试按浏览器语言判断，再退回默认值。
 * 浏览器语言判断只接受 zh/en 两种语言里的一种，其余（klingon/ja/de/...）一律用默认。
 *
 * 为什么这么做——审计背景：
 *   原先无此回退，登录页固定默认中文，导致英文用户连登录表单都读不懂。
 *   加上这一行后，登录前就能看到自己语言；不需要在登录页再放漂浮切换。
 */
function detectFromNavigator(): LanguageCode | null {
  try {
    const nav = globalThis.navigator?.language?.toLowerCase() || ''
    if (nav.startsWith('zh')) return 'zh'
    if (nav.startsWith('en')) return 'en'
  } catch {
    // 忽略：navigator 不可访问
  }
  return null
}

export function initLanguage(): LanguageCode {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (isLanguageCode(saved)) return (currentLanguage = saved)
    const detected = detectFromNavigator()
    if (detected) currentLanguage = detected
  } catch {
    // 忽略：用默认语言
  }
  return currentLanguage
}

export function getLanguage(): LanguageCode {
  return currentLanguage
}

/** 切换语言：写入存储（失败也不影响本次会话内生效） */
export function setLanguage(lang: LanguageCode): void {
  if (!isLanguageCode(lang)) return
  currentLanguage = lang
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang)
  } catch {
    // 忽略
  }
}

/** 取原始文案；未知键回退成键名本身（可诊断） */
export function localize(id: TranslationKey): string {
  const pack = LANGUAGES[currentLanguage]
  return pack[id] || id
}

/**
 * 把 `{0}` / `{1}` 占位换成实参。
 * 只支持单数字占位（与常见的 10 个参数上限一致）。
 * 缺失的参数**保留占位符**——可见即知缺哪个参数，比留空好排查。
 */
export function renderTemplate(template: string, args: readonly unknown[]): string {
  return template.replace(/\{(\d)\}/g, (whole, d: string) => {
    const i = Number(d)
    const v = args[i]
    return v === undefined || v === null ? whole : String(v)
  })
}

/**
 * 取词入口。
 * 无参 → 纯文本；带参 → 已替换占位的纯文本（**仍然是纯文本，不是 HTML**）。
 *
 * ⚠ 刻意不返回 HTML、也不提供 dangerouslySetInnerHTML 路径：
 *   参数往往来自服务端/玩家（不可信），拼 HTML 就等于开一个注入面。
 *   需要富文本时请用 React 组件组合，而不是把标签塞进译文。
 */
export function $(id: TranslationKey, ...args: readonly unknown[]): string {
  const raw = localize(id)
  return args.length === 0 ? raw : renderTemplate(raw, args)
}

/** 仅供测试：重置为默认语言，避免用例之间互相影响 */
export function __resetLanguageForTest(): void {
  currentLanguage = DEFAULT_LANGUAGE
}
