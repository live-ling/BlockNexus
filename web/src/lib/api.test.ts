import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, agentOutdated, agentVersionText, api, errText } from './api'
import { $, __resetLanguageForTest, setLanguage } from './i18n'

/**
 * 错误契约测试：后端返回 `{ error, code }`，前端必须把 code 带到 ApiError 上。
 * 这是 i18n 与「按错误类型分支」的前提——之前只能靠匹配中文文案，改文案就静默失效。
 */

function stubFetch(status: number, body: unknown, opts: { nonJson?: boolean } = {}) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (opts.nonJson) throw new Error('not json')
      return body
    },
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

/** 取第 n 次 fetch 调用的请求头（断言 Accept-Language / Content-Type 用） */
function headersOf(fn: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
  const init = fn.mock.calls[call]?.[1]
  return (init?.headers ?? {}) as Record<string, string>
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetLanguageForTest()
})

describe('api() 成功路径', () => {
  it('2xx 直接返回解析后的 body', async () => {
    stubFetch(200, { ok: true, name: 'srv' })
    await expect(api<{ ok: boolean; name: string }>('/x')).resolves.toEqual({ ok: true, name: 'srv' })
  })

  it('带上 Accept-Language，让后端 error 兜底文案也用当前语言', async () => {
    const fn = stubFetch(200, { ok: true })
    await api('/x')
    expect(headersOf(fn)['Accept-Language']).toBe('zh')

    setLanguage('en')
    const fn2 = stubFetch(200, { ok: true })
    await api('/x')
    expect(headersOf(fn2)['Accept-Language']).toBe('en')
  })

  it('有 body 时才带 Content-Type（无 body 的写请求不能被 415）', async () => {
    const fn = stubFetch(200, { ok: true })
    await api('/x', { method: 'DELETE' })
    expect(headersOf(fn)['Content-Type']).toBeUndefined()

    const fn2 = stubFetch(200, { ok: true })
    await api('/x', { method: 'PUT', body: {} })
    expect(headersOf(fn2)['Content-Type']).toBe('application/json')
  })
})

describe('api() 错误路径：code 必须透传', () => {
  it('非 2xx 抛 ApiError，并带上 status / code / 后端文案', async () => {
    stubFetch(404, { error: '服务器不存在', code: 'server.not-found' })
    const err = await api('/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const ae = err as ApiError
    expect(ae.status).toBe(404)
    expect(ae.code).toBe('server.not-found')
    expect(ae.message).toBe('服务器不存在')
  })

  it('401 未登录能被识别为 auth.not-logged-in（供 App 统一回登录态）', async () => {
    stubFetch(401, { error: '未登录', code: 'auth.not-logged-in' })
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(401)
    expect(err.code).toBe('auth.not-logged-in')
  })

  it('过渡期：没有 code 的旧接口不应报错，code 为 undefined、文案仍可用', async () => {
    stubFetch(500, { error: '旧接口的裸中文错误' })
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBeUndefined()
    expect(err.message).toBe('旧接口的裸中文错误')
  })

  it('响应体不是 JSON 时回退到状态码文案', async () => {
    stubFetch(502, null, { nonJson: true })
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(502)
    expect(err.message).toContain('502')
  })

  it('错误体里既没有 error 也没有 code 时仍有可读文案', async () => {
    stubFetch(503, {})
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError
    expect(err.message).toContain('503')
  })
})

describe('errText()', () => {
  it('ApiError 返回其文案', () => {
    expect(errText(new ApiError(404, '服务器不存在', 'server.not-found'))).toBe('服务器不存在')
  })

  it('普通 Error 返回 message', () => {
    expect(errText(new Error('boom'))).toBe('boom')
  })

  it('非 Error 值转成字符串', () => {
    expect(errText('plain')).toBe('plain')
    expect(errText(42)).toBe('42')
  })
})

describe('ApiError 本身', () => {
  it('code 是可选参数（不传也不影响既有调用点）', () => {
    const e = new ApiError(500, 'x')
    expect(e.code).toBeUndefined()
    expect(e.status).toBe(500)
    expect(e).toBeInstanceOf(Error)
  })
})

describe('agentVersionText / agentOutdated（版本号展示契约）', () => {
  // 回归背景：系统信息那行「远端 v0.5.0 · 本地 v{0}」的 v 由**译文**提供，
  // 而调用点又拼了一次 → 页面显示「本地 vv0.5.0」。约定收敛到 agentVersionText：
  // 它只返回裸版本号，v 前缀由译文或调用点二选一负责。
  it('返回裸版本号（不带 v）', () => {
    expect(agentVersionText('0.5.0')).toBe('0.5.0')
  })

  it('剥掉远端可能自带的 v 前缀（避免调用点再拼一次变成 vv）', () => {
    expect(agentVersionText('v0.5.0')).toBe('0.5.0')
    expect(agentVersionText('V0.5.0')).toBe('0.5.0')
  })

  it('缺值时用兜底（默认 —，可覆盖）', () => {
    expect(agentVersionText(undefined)).toBe('—')
    expect(agentVersionText(null)).toBe('—')
    expect(agentVersionText('')).toBe('—')
    expect(agentVersionText('  ')).toBe('—')
    expect(agentVersionText(undefined, '?')).toBe('?')
  })

  it('与译文拼接后恰好只有一个 v（这就是页面上那行的最终形态）', () => {
    expect(`· ${$('serverSettings.sys.agentLocal', agentVersionText('0.5.0'))}`).toContain('本地 v0.5.0')
    expect(`· ${$('serverSettings.sys.agentLocal', agentVersionText('0.5.0'))}`).not.toContain('vv')
  })

  it('agentOutdated：远端与随附版本不一致即为落后（随附版本缺失时不算）', () => {
    expect(agentOutdated({ info: { agentVersion: '0.4.5' }, agentBundled: '0.5.0' } as never)).toBe(true)
    expect(agentOutdated({ info: { agentVersion: '0.5.0' }, agentBundled: '0.5.0' } as never)).toBe(false)
    expect(agentOutdated({ info: null, agentBundled: '0.5.0' } as never)).toBe(true)
    expect(agentOutdated({ info: { agentVersion: '0.4.5' }, agentBundled: '' } as never)).toBe(false)
  })
})
