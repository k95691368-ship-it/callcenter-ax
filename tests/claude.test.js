import { describe, it, expect, vi, afterEach } from 'vitest'
import { callClaudeTool, ensureContract } from '../functions/_lib/claude.js'
import { checkRateLimit } from '../functions/_lib/rateLimit.js'

const ENV = { CLAUDE_API_KEY: 'test-key' }
const TOOL = { name: 'record_test', input_schema: { type: 'object' } }
const CALL = { system: 's', user: 'u', tool: TOOL, maxTokens: 100 }

function apiResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callClaudeTool', () => {
  it('정상 tool_use 응답에서 input과 usage를 반환한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        apiResponse({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', input: { titles: ['a'] } }],
          usage: { input_tokens: 10, output_tokens: 20 },
        })
      )
    )
    const { input, usage } = await callClaudeTool(ENV, CALL)
    expect(input).toEqual({ titles: ['a'] })
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 20 })
  })

  it('max_tokens로 잘린 응답은 tool_use가 있어도 거부한다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        apiResponse({
          stop_reason: 'max_tokens',
          content: [{ type: 'tool_use', input: {} }],
        })
      )
    )
    await expect(callClaudeTool(ENV, CALL)).rejects.toThrow(/너무 길어/)
  })

  it('과부하(429) 시 1회 재시도해 성공 응답을 반환한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse({}, 429))
      .mockResolvedValueOnce(
        apiResponse({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', input: { ok: true } }],
          usage: { input_tokens: 1, output_tokens: 2 },
        })
      )
    vi.stubGlobal('fetch', fetchMock)
    const { input } = await callClaudeTool(ENV, CALL)
    expect(input).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  }, 10000)

  it('재시도까지 실패하면 혼잡 안내 오류를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({}, 529)))
    await expect(callClaudeTool(ENV, CALL)).rejects.toThrow(/혼잡/)
  }, 10000)
})

describe('ensureContract', () => {
  it('필수 배열이 누락되면 거부한다', () => {
    expect(() => ensureContract({ titles: 'not-array' }, { arrays: ['titles'] })).toThrow(/불완전/)
  })

  it('필수 문자열이 비어 있으면 거부한다', () => {
    expect(() => ensureContract({ headline: '  ' }, { strings: ['headline'] })).toThrow(/불완전/)
  })

  it('계약을 지킨 응답은 통과시킨다', () => {
    const input = { titles: [], headline: 'ok' }
    expect(ensureContract(input, { arrays: ['titles'], strings: ['headline'] })).toBe(input)
  })
})

describe('checkRateLimit', () => {
  // 조건부 INSERT 한 문장으로 검사와 기록을 함께 처리하므로, 통과 여부는
  // meta.changes(삽입된 행 수)로 판정된다. 목도 그 계약을 따른다.
  // bind 인수를 버리지 않고 모아둔다 — 버킷 문자열에 무엇이 들어가는지 검증하기 위해서다.
  function mockDb(inserted, { throws = false } = {}) {
    const calls = { sql: [], bindings: [] }
    const db = {
      calls,
      prepare: (sql) => {
        calls.sql.push(sql)
        const stmt = {
          bind: (...args) => {
            calls.bindings.push(args)
            return {
              run: async () => {
                if (throws) throw new Error('D1 down')
                return { meta: { changes: inserted } }
              },
              first: async () => {
                if (throws) throw new Error('D1 down')
                return { count: 0 }
              },
            }
          },
          run: async () => ({ meta: { changes: 0 } }),
        }
        return stmt
      },
    }
    return db
  }

  it('한도 미만이면(행이 삽입되면) 허용한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(1) }, 'b', 5, 60)).toBe(true)
  })

  it('한도에 도달하면(행이 삽입되지 않으면) 차단한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(0) }, 'b', 5, 60)).toBe(false)
  })

  it('검사와 기록을 한 문장으로 처리해 동시 요청이 상한을 넘지 못한다', async () => {
    const db = mockDb(1)
    await checkRateLimit({ DB: db }, 'bucket-x', 5, 60)
    const insert = db.calls.sql.find((s) => s.includes('INSERT INTO rate_limit_hits'))
    expect(insert).toBeTruthy()
    // 조건 없는 INSERT였다면 상한 검사가 별도 왕복으로 분리되어 경쟁이 생긴다
    expect(insert).toMatch(/SELECT COUNT\(\*\)/)
  })

  it('DB 오류 시 남용 방지 버킷은 fail-open으로 허용한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(0, { throws: true }) }, 'b', 5, 60)).toBe(true)
  })

  it('DB 오류 시 유료 예산 버킷은 fail-closed로 막는다', async () => {
    expect(
      await checkRateLimit({ DB: mockDb(0, { throws: true }) }, 'cc:claude:daily', 150, 86400, { failOpen: false })
    ).toBe(false)
  })

  it('DB 바인딩이 없으면 제한 없이 통과한다', async () => {
    expect(await checkRateLimit({}, 'b', 5, 60)).toBe(true)
  })
})
