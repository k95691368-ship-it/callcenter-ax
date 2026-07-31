import { describe, it, expect } from 'vitest'
import { clientKey } from '../functions/_lib/http.js'
import { logCall } from '../functions/_lib/telemetry.js'
import { readFileSync } from 'node:fs'

// 이 프로젝트의 절대 규칙: 개인정보 미수집, IP·입력 내용 미저장.
// 규칙은 문서로 적어두는 것만으로는 지켜지지 않는다 — 저장 계층에 무엇이 흘러가는지
// 테스트로 고정해두어야, 나중에 누가 필드를 추가해도 여기서 걸린다.

const IPV4 = '203.0.113.45'
const IPV6 = '2001:db8::dead:beef'
const req = (ip) => ({ headers: { get: (h) => (h === 'CF-Connecting-IP' ? ip : null) } })

describe('clientKey (레이트리밋 버킷 키)', () => {
  it('IP 원문을 그대로 돌려주지 않는다', async () => {
    const key = await clientKey(req(IPV4), {})
    expect(key).not.toContain(IPV4)
    expect(key).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
  })

  it('IPv6도 원문이 남지 않는다', async () => {
    const key = await clientKey(req(IPV6), {})
    expect(key).not.toContain(IPV6)
    expect(key).not.toContain(':')
  })

  it('16자 16진수 해시 형태다', async () => {
    expect(await clientKey(req(IPV4), {})).toMatch(/^[0-9a-f]{16}$/)
  })

  it('같은 IP는 같은 키가 되어 제한이 실제로 동작한다', async () => {
    const a = await clientKey(req(IPV4), {})
    const b = await clientKey(req(IPV4), {})
    expect(a).toBe(b)
  })

  it('다른 IP는 다른 키가 된다', async () => {
    const a = await clientKey(req(IPV4), {})
    const b = await clientKey(req('198.51.100.7'), {})
    expect(a).not.toBe(b)
  })

  it('솔트가 다르면 키도 달라진다 (교차 연결 불가)', async () => {
    const a = await clientKey(req(IPV4), { RL_SALT: 'salt-a' })
    const b = await clientKey(req(IPV4), { RL_SALT: 'salt-b' })
    expect(a).not.toBe(b)
  })

  it('IP 헤더가 없으면 해시하지 않고 unknown으로 묶는다', async () => {
    expect(await clientKey(req(null), {})).toBe('unknown')
  })
})

describe('logCall (텔레메트리)', () => {
  function capture() {
    const seen = { sql: null, args: null }
    const context = {
      env: {
        DB: {
          prepare: (sql) => {
            seen.sql = sql
            return { bind: (...args) => ({ args, run: async () => { seen.args = args; return {} } }) }
          },
        },
      },
      waitUntil: () => {},
    }
    return { context, seen }
  }

  const ALLOWED_COLUMNS = ['endpoint', 'mode', 'latency_ms', 'input_tokens', 'output_tokens', 'findings_count']

  it('허용된 컬럼만 기록한다 (원문·IP 컬럼이 추가되면 실패한다)', async () => {
    const { context, seen } = capture()
    logCall(context, { endpoint: 'analyze', mode: 'live', startedAt: Date.now(), usage: { input_tokens: 5, output_tokens: 7 } })
    await Promise.resolve()
    const columns = seen.sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(',').map((c) => c.trim())
    expect(columns).toEqual(ALLOWED_COLUMNS)
  })

  it('바인딩되는 값에 통화 원문이나 IP가 섞이지 않는다', async () => {
    const { context, seen } = capture()
    logCall(context, {
      endpoint: 'qa',
      mode: 'live',
      startedAt: Date.now(),
      usage: { input_tokens: 11, output_tokens: 22 },
      findingsCount: 2,
    })
    await Promise.resolve()
    for (const v of seen.args) {
      if (v === null) continue
      if (typeof v === 'number') continue
      // 문자열 값은 짧은 식별자(endpoint·mode)만 허용한다
      expect(typeof v).toBe('string')
      expect(v.length).toBeLessThanOrEqual(24)
      expect(v).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/)
      expect(v).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('DB 바인딩이 없으면 아무것도 하지 않는다', () => {
    expect(() => logCall({ env: {} }, { endpoint: 'stt', mode: 'demo' })).not.toThrow()
  })
})

// ── 전사 텍스트가 서버로 나가기 전에 개인정보를 가렸는가 ──
//
// 콜센터 통화에는 본인확인이 반드시 들어간다. 주민번호·카드·연락처가 전사에 그대로 남고,
// 그 텍스트가 분석·평가·화자분리 API로 나간다. 마스킹이 한 경로에만 있으면 없는 것과 다르지 않다.
// 소스에서 "postJson으로 전사를 보내는 곳"을 찾아 가린 값을 쓰는지 확인한다.
describe('전사를 보내는 모든 경로가 마스킹을 거친다', () => {
  const read = (p) => readFileSync(new URL(`../src/pages/${p}`, import.meta.url), 'utf8')

  const SENDERS = [
    { file: 'SttPage.jsx', endpoint: '/api/cc/diarize' },
    { file: 'AnalyzePage.jsx', endpoint: '/api/cc/analyze' },
    { file: 'AnalyzePage.jsx', endpoint: '/api/cc/analyze-batch' },
    { file: 'QaPage.jsx', endpoint: '/api/cc/qa' },
  ]

  for (const { file, endpoint } of SENDERS) {
    it(`${file} → ${endpoint} 는 원문을 그대로 보내지 않는다`, () => {
      const src = read(file)
      expect(src).toContain('maskPii')
      // 호출 지점 앞뒤에서 가린 값(safe/masked/maskPii)을 쓰는지 확인
      const at = src.indexOf(`postJson('${endpoint}'`)
      expect(at).toBeGreaterThan(-1)
      const window = src.slice(Math.max(0, at - 400), at + 200)
      expect(window).toMatch(/maskPii|safe\.text|safeParts/)
    })
  }

  it('녹취 화면이 다음 단계로 넘기는 텍스트도 가려진 것이다', () => {
    const src = read('SttPage.jsx')
    const at = src.indexOf("sessionStorage.setItem('cc-transcript'")
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 80)).toContain('outbound')
  })
})
