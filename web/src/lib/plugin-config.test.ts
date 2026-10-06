import { describe, expect, it } from 'vitest'

import {
  applyJsonChanges,
  applyYamlChanges,
  cloneTree,
  detectFormat,
  diffTree,
  findNode,
  nodeToPojo,
  parseJsonConfig,
  parseYamlConfig,
  type ConfigChange,
  type ObjectNode,
} from './plugin-config'

/**
 * plugin-config.ts 最要紧的是「什么时候**不能**用表单编辑」——
 * 一旦判定错误，用户手写的注释/锚点就会在保存时被抹掉，属于静默数据损坏。
 * 因此这里重点钉住各条降级路径。
 */

describe('detectFormat', () => {
  it('按扩展名识别三种格式', () => {
    expect(detectFormat('config.yml')).toBe('yaml')
    expect(detectFormat('config.yaml')).toBe('yaml')
    expect(detectFormat('config.json')).toBe('json')
    expect(detectFormat('config.toml')).toBe('toml')
    expect(detectFormat('paper-global.yml')).toBe('yaml')
  })

  it('大小写不敏感', () => {
    expect(detectFormat('CONFIG.YML')).toBe('yaml')
    expect(detectFormat('Config.Json')).toBe('json')
  })

  it('未知扩展名返回 null（不参与表单化）', () => {
    expect(detectFormat('server.properties')).toBeNull()
    expect(detectFormat('notes.txt')).toBeNull()
    expect(detectFormat('noext')).toBeNull()
  })
})

describe('parseYamlConfig：必须降级为原文编辑的情形', () => {
  it('多文档 → 报错（含尾部单独一个 ---，yaml 也视为 2 个文档）', () => {
    expect(parseYamlConfig('a: 1\n---\nb: 2\n')).toHaveProperty('error')
    expect(parseYamlConfig('a: 1\n---\n')).toHaveProperty('error')
  })

  it('锚点/别名 → 报错（表单改值会失真）', () => {
    const r = parseYamlConfig('base: &b\n  x: 1\nuse: *b\n')
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('锚点')
  })

  it('顶层是数组 → 报错', () => {
    const r = parseYamlConfig('- a\n- b\n')
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('顶层')
  })

  it('语法错误 → 报错（带解析器原始信息）', () => {
    expect(parseYamlConfig('a: [1, 2\n')).toHaveProperty('error')
  })

  it('空文件 / 纯注释 → 合法的空对象根，不报错', () => {
    for (const src of ['', '# just a comment\n', '\n\n']) {
      const r = parseYamlConfig(src)
      expect(r).not.toHaveProperty('error')
      const ok = r as { format: string; root: ObjectNode }
      expect(ok.format).toBe('yaml')
      expect(ok.root.children).toEqual([])
    }
  })
})

describe('parseYamlConfig：正常表单化', () => {
  it('解析嵌套映射为树', () => {
    const r = parseYamlConfig('a: 1\nb:\n  c: hello\n')
    expect(r).not.toHaveProperty('error')
    const root = (r as { root: ObjectNode }).root
    expect(root.children.map((c) => c.key)).toEqual(['a', 'b'])
  })

  it('保留 CRLF 信息', () => {
    const r = parseYamlConfig('a: 1\r\n')
    expect((r as { eol: string }).eol).toBe('\r\n')
  })

  it('提取顶部注释作为 headerComment', () => {
    const r = parseYamlConfig('# 头部说明\na: 1\n')
    expect((r as { headerComment: string }).headerComment).toContain('头部说明')
  })
})

describe('parseJsonConfig：必须降级为原文编辑的情形', () => {
  it('语法错误 → 报错', () => {
    expect(parseJsonConfig('{ bad json')).toHaveProperty('error')
  })

  it('顶层是数组 → 报错', () => {
    const r = parseJsonConfig('[1,2,3]')
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('顶层')
  })

  it('顶层是标量 → 报错', () => {
    expect(parseJsonConfig('42')).toHaveProperty('error')
    expect(parseJsonConfig('"str"')).toHaveProperty('error')
    expect(parseJsonConfig('null')).toHaveProperty('error')
  })

  it('正常对象 → 解析为树', () => {
    const r = parseJsonConfig('{"a":1,"b":{"c":true}}')
    expect(r).not.toHaveProperty('error')
    const root = (r as { root: ObjectNode }).root
    expect(root.children.map((c) => c.key)).toEqual(['a', 'b'])
  })
})

describe('树的读写工具', () => {
  const parsed = parseYamlConfig('a: 1\nb:\n  c: 2\n') as { root: ObjectNode }

  it('findNode 按路径取节点', () => {
    expect(findNode(parsed.root, 'a')?.key).toBe('a')
    expect(findNode(parsed.root, 'b.c')).toBeTruthy()
    expect(findNode(parsed.root, 'nope')).toBeUndefined()
    expect(findNode(parsed.root, 'b.nope')).toBeUndefined()
  })

  it('cloneTree 是深拷贝（嵌套子对象也是新引用）', () => {
    const copy = cloneTree(parsed.root) as ObjectNode
    expect(copy).toEqual(parsed.root)
    expect(copy).not.toBe(parsed.root)
    const originalChild = parsed.root.children[1] as ObjectNode
    const copiedChild = copy.children[1] as ObjectNode
    expect(copiedChild).not.toBe(originalChild)
    expect(copiedChild.children[0]).not.toBe(originalChild.children[0])
  })

  it('nodeToPojo 还原成普通对象', () => {
    expect(nodeToPojo(parsed.root)).toEqual({ a: 1, b: { c: 2 } })
  })

  it('diffTree 逐字段比对，只报出值变化的叶子路径', () => {
    const before = (parseYamlConfig('a: 1\nb:\n  c: 2\n  d: keep\n') as { root: ObjectNode }).root
    const after = (parseYamlConfig('a: 99\nb:\n  c: 2\n  d: keep\n') as { root: ObjectNode }).root
    const out: ConfigChange[] = []
    diffTree(before, after, '', out)
    expect(out).toEqual<ConfigChange[]>([{ path: 'a', value: 99 }])
  })

  it('diffTree 对未改动的树返回空', () => {
    const src = 'a: 1\nb:\n  c: 2\n'
    const t1 = (parseYamlConfig(src) as { root: ObjectNode }).root
    const t2 = (parseYamlConfig(src) as { root: ObjectNode }).root
    const out: ConfigChange[] = []
    diffTree(t1, t2, '', out)
    expect(out).toEqual([])
  })

  it('diffTree 嵌套值变化报出完整路径', () => {
    const before = (parseJsonConfig('{"b":{"c":1}}') as { root: ObjectNode }).root
    const after = (parseJsonConfig('{"b":{"c":7}}') as { root: ObjectNode }).root
    const out: ConfigChange[] = []
    diffTree(before, after, '', out)
    expect(out).toEqual<ConfigChange[]>([{ path: 'b.c', value: 7 }])
  })
})

describe('applyYamlChanges：改值但保留注释与键序', () => {
  it('只改目标值，注释与其余行原样保留', () => {
    const out = applyYamlChanges('# 我的注释\na: 1\n# 中间注释\nb: 2\n', [{ path: 'a', value: 99 }])
    expect(out).toContain('# 我的注释')
    expect(out).toContain('# 中间注释')
    expect(out).toMatch(/a:\s*99/)
    expect(out).toMatch(/b:\s*2/)
  })

  it('保留键的原始顺序', () => {
    const out = applyYamlChanges('z: 1\na: 2\nm: 3\n', [{ path: 'a', value: 22 }])
    const order = out.split('\n').filter((l) => /^[zam]:/.test(l)).map((l) => l[0])
    expect(order).toEqual(['z', 'a', 'm'])
  })

  it('新增键会写回文件', () => {
    expect(applyYamlChanges('a: 1\n', [{ path: 'b', value: 'new' }])).toMatch(/b:\s*new/)
  })

  it('嵌套路径可改', () => {
    expect(applyYamlChanges('b:\n  c: 2\n', [{ path: 'b.c', value: 42 }])).toMatch(/c:\s*42/)
  })

  it('changes 为空时原样返回', () => {
    const src = 'a: 1\n'
    expect(applyYamlChanges(src, [])).toBe(src)
  })

  it('保留 CRLF 换行风格', () => {
    const out = applyYamlChanges('a: 1\r\nb: 2\r\n', [{ path: 'a', value: 9 }])
    expect(out).toContain('\r\n')
    expect(out.replace(/\r\n/g, '')).not.toContain('\n')
  })

  // 契约确认：apply* 只在 parse* 成功之后才会被调用（对话框对解析失败的配置会
  // 降级为「原文编辑」，根本不会走到表单保存）。因此对非法输入抛错是设计意图，
  // 作为「调用顺序写错」的守卫，而不是要吞掉。下面两条把这个契约钉住，
  // 免得日后有人误以为应该静默返回原文。
  it('非法 YAML 抛错（调用顺序守卫，非用户可见崩溃）', () => {
    expect(() => applyYamlChanges('a: [1, 2\n', [{ path: 'a', value: 1 }])).toThrow()
  })
})

describe('applyJsonChanges', () => {
  it('改值并保持是合法 JSON', () => {
    const out = applyJsonChanges('{\n  "a": 1\n}\n', [{ path: 'a', value: 5 }])
    expect(JSON.parse(out)).toEqual({ a: 5 })
  })

  it('新增键', () => {
    const out = applyJsonChanges('{"a":1}', [{ path: 'b', value: true }])
    expect(JSON.parse(out)).toEqual({ a: 1, b: true })
  })

  it('changes 为空时原样返回', () => {
    const src = '{"a":1}'
    expect(applyJsonChanges(src, [])).toBe(src)
  })

  it('统一 2 空格缩进', () => {
    expect(applyJsonChanges('{"a":{"b":1}}', [{ path: 'a.b', value: 2 }])).toContain('\n  "a"')
  })

  it('非法 JSON 抛错（同上的调用顺序守卫）', () => {
    expect(() => applyJsonChanges('{ bad', [{ path: 'a', value: 1 }])).toThrow()
  })
})
