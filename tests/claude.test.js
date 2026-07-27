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
  function mockDb(count, { firstThrows = false } = {}) {
    return {
      prepare: () => ({
        bind: () => ({
          run: async () => ({}),
          first: async () => {
            if (firstThrows) throw new Error('D1 down')
            return { count }
          },
        }),
        run: async () => ({}),
      }),
    }
  }

  it('한도 미만이면 허용한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(3) }, 'b', 5, 60)).toBe(true)
  })

  it('한도에 도달하면 차단한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(5) }, 'b', 5, 60)).toBe(false)
  })

  it('DB 오류 시 500 대신 fail-open으로 허용한다', async () => {
    expect(await checkRateLimit({ DB: mockDb(0, { firstThrows: true }) }, 'b', 5, 60)).toBe(true)
  })

  it('DB 바인딩이 없으면 제한 없이 통과한다', async () => {
    expect(await checkRateLimit({}, 'b', 5, 60)).toBe(true)
  })
})
