import { describe, expect, it } from 'vitest'

import {
  escapeValue,
  parseProperties,
  serializeProperties,
  unescapeValue,
  type PropItem,
} from './properties'

/**
 * properties.ts 的核心承诺是「无损回写」：面板改一个值之后，
 * 用户手写的注释、空行、键序、未知键都必须原样保留。
 * 这是最容易在重构中被悄悄破坏的行为，所以逐条钉住。
 */

/** 便捷构造：解析 → 改写 → 序列化 */
function roundTrip(content: string, values: Record<string, string>): string {
  const { items, eol } = parseProperties(content)
  return serializeProperties(items, values, eol)
}

describe('parseProperties', () => {
  it('识别键值对并保留注释与空行', () => {
    const { items } = parseProperties('# 注释\n\nmax-players=20\n')
    expect(items).toEqual<PropItem[]>([
      { kind: 'raw', text: '# 注释' },
      { kind: 'raw', text: '' },
      { kind: 'pair', key: 'max-players', value: '20' },
      { kind: 'raw', text: '' },
    ])
  })

  it('值里的等号只切第一个（如 motd 含 =）', () => {
    const { items } = parseProperties('motd=A=B=C\n')
    expect(items[0]).toEqual<PropItem>({ kind: 'pair', key: 'motd', value: 'A=B=C' })
  })

  it('支持键名里的 . - _ 与数字', () => {
    const { items } = parseProperties('level-name=world\nfoo.bar-1_x=1\n')
    expect(items[0]).toEqual<PropItem>({ kind: 'pair', key: 'level-name', value: 'world' })
    expect(items[1]).toEqual<PropItem>({ kind: 'pair', key: 'foo.bar-1_x', value: '1' })
  })

  it('保留原值两侧不作 trim（值内的空格有意义）', () => {
    const { items } = parseProperties('motd= hello world \n')
    expect(items[0]).toEqual<PropItem>({ kind: 'pair', key: 'motd', value: ' hello world ' })
  })

  it('被注释掉的键当作 raw，不参与改写', () => {
    const { items } = parseProperties('#max-players=20\n')
    expect(items[0].kind).toBe('raw')
  })

  it('识别 CRLF 并回报 eol', () => {
    const { items, eol } = parseProperties('a=1\r\nb=2\r\n')
    expect(eol).toBe('\r\n')
    expect(items[0]).toEqual<PropItem>({ kind: 'pair', key: 'a', value: '1' })
    // 值不应带上 \r
    expect(items[0]).toEqual<PropItem>({ kind: 'pair', key: 'a', value: '1' })
    expect((items[0] as { value: string }).value).not.toContain('\r')
  })

  it('LF 文件回报 \\n', () => {
    expect(parseProperties('a=1\n').eol).toBe('\n')
  })
})

describe('serializeProperties：无损回写', () => {
  it('只改目标键的值，其余逐字节保留', () => {
    const src = '# 我手写的注释\nmax-players=20\n\nmotd=hi\n'
    expect(roundTrip(src, { 'max-players': '40' }))
      .toBe('# 我手写的注释\nmax-players=40\n\nmotd=hi\n')
  })

  it('未知键原样保留（不会被丢弃）', () => {
    const src = 'some-future-option=xyz\nmax-players=20\n'
    expect(roundTrip(src, { 'max-players': '40' }))
      .toBe('some-future-option=xyz\nmax-players=40\n')
  })

  it('缺失的键追加到末尾', () => {
    const src = 'max-players=20\n'
    // 注意：源文件末尾的换行会解析成最后一个空 raw 行，而「去掉尾部空行」是在
    // 追加之后才执行的，因此追加的键会落在这个空行之后（多一个空行）。
    // 这是既有行为，属于纯视觉差异、不影响 MC 解析，这里如实钉住以免日后被误改。
    expect(roundTrip(src, { 'max-players': '20', 'view-distance': '10' }))
      .toBe('max-players=20\n\nview-distance=10\n')
  })

  it('追加后整体仍可被重新解析回同样的键值', () => {
    const out = roundTrip('a=1\n', { a: '1', b: '2' })
    const { items } = parseProperties(out)
    const pairs = items.filter((i) => i.kind === 'pair')
    expect(pairs).toEqual<PropItem[]>([
      { kind: 'pair', key: 'a', value: '1' },
      { kind: 'pair', key: 'b', value: '2' },
    ])
  })

  it('已有键不会被追加逻辑重复写入', () => {
    const src = 'max-players=20\n'
    const out = roundTrip(src, { 'max-players': '40' })
    expect(out.match(/max-players=/g)).toHaveLength(1)
  })

  it('未出现在 values 里的键保持原值', () => {
    const src = 'a=1\nb=2\n'
    expect(roundTrip(src, { a: '9' })).toBe('a=9\nb=2\n')
  })

  it('保留键序（不排序）', () => {
    const src = 'z=1\na=2\nm=3\n'
    expect(roundTrip(src, { a: '22' })).toBe('z=1\na=22\nm=3\n')
  })

  it('CRLF 文件回写仍为 CRLF', () => {
    const src = 'a=1\r\nb=2\r\n'
    expect(roundTrip(src, { a: '9' })).toBe('a=9\r\nb=2\r\n')
  })

  it('去掉尾部多余空行并补一个换行', () => {
    expect(roundTrip('a=1\n\n\n', { a: '1' })).toBe('a=1\n')
  })

  it('注释所在行的位置不因改写而漂移', () => {
    const src = '# top\na=1\n# middle\nb=2\n'
    expect(roundTrip(src, { a: 'X', b: 'Y' })).toBe('# top\na=X\n# middle\nb=Y\n')
  })

  it('整体幂等：值不变时输出等于原文（规范化尾部换行）', () => {
    const src = '# c\na=1\nb=2\n'
    const once = roundTrip(src, { a: '1' })
    const twice = roundTrip(once, { a: '1' })
    expect(once).toBe(src)
    expect(twice).toBe(once)
  })
})

describe('转义冒号（MC 会写出 level-type=minecraft\\:normal）', () => {
  it('unescapeValue 还原 \\: 与 \\=', () => {
    expect(unescapeValue('minecraft\\:normal')).toBe('minecraft:normal')
    expect(unescapeValue('a\\=b')).toBe('a=b')
  })

  it('未转义的值不受影响', () => {
    expect(unescapeValue('minecraft:normal')).toBe('minecraft:normal')
  })

  it('原值用过转义冒号时，新值里的冒号也转义', () => {
    expect(escapeValue('minecraft:flat', 'minecraft\\:normal')).toBe('minecraft\\:flat')
  })

  it('原值没用转义冒号时不转义', () => {
    expect(escapeValue('minecraft:flat', 'minecraft:normal')).toBe('minecraft:flat')
  })

  it('新值没有冒号时原样返回', () => {
    expect(escapeValue('flat', 'minecraft\\:normal')).toBe('flat')
  })

  it('新值已含转义冒号时不重复转义', () => {
    expect(escapeValue('minecraft\\:flat', 'minecraft\\:normal')).toBe('minecraft\\:flat')
  })
})
