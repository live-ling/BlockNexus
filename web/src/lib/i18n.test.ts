import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $,
  LANGUAGE_LABELS,
  LANGUAGES,
  __resetLanguageForTest,
  getLanguage,
  initLanguage,
  localize,
  renderTemplate,
  setLanguage,
} from './i18n'
import { en } from './lang/en'
import { zh } from './lang/zh'

/**
 * i18n 行为测试。
 *
 * 注意分工：
 *   · **键集完整性**由 `i18n.ts` 的 `Record<TranslationKey, string>` 在**编译期**强制
 *     （故意删掉 en 的一个键会让 `tsc -b` 报 TS2741），所以这里不重复测。
 *   · 这里测的是**运行期行为**：取词、缺键回退、模板替换、语言切换与持久化。
 */

beforeEach(() => {
  __resetLanguageForTest()
  vi.unstubAllGlobals()
})

afterEach(() => {
  __resetLanguageForTest()
  vi.unstubAllGlobals()
})

describe('两个语言包的静态一致性（编译期拦不住的补充检查）', () => {
  it('键集完全相同', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('每种语言都有 $lang 自称', () => {
    expect(zh.$lang).toBeTruthy()
    expect(en.$lang).toBeTruthy()
    expect(LANGUAGE_LABELS.zh).toBe(zh.$lang)
    expect(LANGUAGE_LABELS.en).toBe(en.$lang)
  })

  it('中英的 {占位符} 名称与顺序一致（否则替换会错位）', () => {
    const ph = (s: string) => (s.match(/\{\d\}/g) || []).join(',')
    const bad: string[] = []
    for (const k of Object.keys(zh) as (keyof typeof zh)[]) {
      if (ph(zh[k]) !== ph(en[k])) bad.push(`${k}: zh=[${ph(zh[k])}] en=[${ph(en[k])}]`)
    }
    expect(bad).toEqual([])
  })

  it('英文包里没有残留中文（防止漏翻偷懒）', () => {
    const bad = Object.entries(en)
      .filter(([k, v]) => k !== '$lang' && /[\u4e00-\u9fff]/.test(v))
      .map(([k]) => k)
    expect(bad).toEqual([])
  })
})

describe('localize / $', () => {
  it('默认语言是中文', () => {
    expect(getLanguage()).toBe('zh')
    expect($('login.submit')).toBe('登 录')
  })

  it('切到英文后取英文', () => {
    setLanguage('en')
    expect($('login.submit')).toBe('Sign in')
  })

  it('无参时返回原文，带参时替换占位', () => {
    expect($('common.save')).toBe('保存')
    setLanguage('en')
    expect($('login.forgot.resend.countdown', 30)).toBe('Resend (30s)')
    expect($('login.forgot.resend.countdown', 30)).toContain('30')
  })

  it('未知键回退成键名本身（可诊断，不返回空白）', () => {
    // 运行时塞入一个不存在的键，验证回退行为
    expect(localize('no.such.key' as never)).toBe('no.such.key')
  })
})

describe('renderTemplate', () => {
  it('替换 {0} / {1}', () => {
    expect(renderTemplate('{0} 与 {1}', ['a', 'b'])).toBe('a 与 b')
  })

  it('同一占位多次出现都会替换', () => {
    expect(renderTemplate('{0}-{0}', ['x'])).toBe('x-x')
  })

  it('缺失参数时保留占位符（可见即知缺哪个）', () => {
    expect(renderTemplate('{0} / {1}', ['a'])).toBe('a / {1}')
    expect(renderTemplate('{0}', [])).toBe('{0}')
  })

  it('支持数字 0（不被当作缺值）', () => {
    expect(renderTemplate('{0}', [0])).toBe('0')
  })

  it('占位符不是数字时不替换（只支持单数字）', () => {
    expect(renderTemplate('{ab}', ['x'])).toBe('{ab}')
  })

  it('没有占位时原样返回', () => {
    expect(renderTemplate('纯文本', ['x'])).toBe('纯文本')
  })
})

describe('语言持久化', () => {
  it('setLanguage 写入 localStorage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })

    setLanguage('en')
    expect(store.get('blocknexus.language')).toBe('en')

    __resetLanguageForTest()
    expect(initLanguage()).toBe('en')
  })

  it('存储里是非法值时回退默认语言', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'klingon',
      setItem: () => {},
    })
    __resetLanguageForTest()
    expect(initLanguage()).toBe('zh')
  })

  it('存储不可用时不抛异常，用默认语言', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
    })
    __resetLanguageForTest()
    expect(() => initLanguage()).not.toThrow()
    expect(getLanguage()).toBe('zh')
    expect(() => setLanguage('en')).not.toThrow()
    // 写入失败也不影响本次会话内生效
    expect(getLanguage()).toBe('en')
  })

  it('setLanguage 传入非法值时不改变当前语言', () => {
    setLanguage('en')
    setLanguage('klingon' as never)
    expect(getLanguage()).toBe('en')
  })
})

describe('LANGUAGES 注册表', () => {
  it('包含两种语言且与包内容一致', () => {
    expect(Object.keys(LANGUAGES).sort()).toEqual(['en', 'zh'])
    expect(LANGUAGES.zh['common.save']).toBe(zh['common.save'])
    expect(LANGUAGES.en['common.save']).toBe(en['common.save'])
  })
})
