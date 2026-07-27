import { describe, it, expect, vi, afterEach } from 'vitest'
import { verifyTurnstile } from '../functions/_lib/turnstile.js'

function req(headers = {}) {
  return { headers: { get: (k) => headers[k.toLowerCase()] ?? null } }
}

afterEach(() => vi.unstubAllGlobals())

describe('verifyTurnstile', () => {
  it('시크릿 미설정 시(로컬 개발) 통과시킨다', async () => {
    expect(await verifyTurnstile({}, req())).toBe(true)
  })

  it('시크릿이 있는데 토큰이 없으면 차단한다 (봇 차단 핵심)', async () => {
    expect(await verifyTurnstile({ TURNSTILE_SECRET: 's' }, req())).toBe(false)
  })

  it('Cloudflare 검증 성공 시 통과시킨다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: true }) })))
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET: 's' }, req({ 'x-turnstile-token': 't' }))
    ).toBe(true)
  })

  it('Cloudflare 검증 실패 응답이면 차단한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ success: false }) })))
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET: 's' }, req({ 'x-turnstile-token': 't' }))
    ).toBe(false)
  })

  it('검증 서비스 장애 시에는 데모 연속성을 위해 통과시킨다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(
      await verifyTurnstile({ TURNSTILE_SECRET: 's' }, req({ 'x-turnstile-token': 't' }))
    ).toBe(true)
  })
})
