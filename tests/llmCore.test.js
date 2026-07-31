import { describe, it, expect, vi, afterEach } from 'vitest'
import { callClaudeTool, ensureContract, getApiKey, hasApiKey } from '../functions/_lib/claude.js'
import { runLlmLadder } from '../functions/_lib/ladder.js'

// 감사로 드러난 6건(상한 절단·refusal 미처리·데드라인·retry-after·키 형태·요소 타입)의
// 회귀 테스트. 모두 fetch 스텁 위에서 실제 대기 없이 판정되도록 구성했다.

const ENV = { CLAUDE_API_KEY: 'sk-ant-test-key' }
const TOOL = { name: 'record_test', input_schema: { type: 'object' } }
const CALL = { system: 's', user: 'u', tool: TOOL, maxTokens: 6144 }

const OK_BODY = {
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', input: { ok: true } }],
  usage: { input_tokens: 10, output_tokens: 20 },
}

function apiResponse(body, { status = 200, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function sentBody(fetchMock, index) {
  return JSON.parse(fetchMock.mock.calls[index][1].body)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('max_tokens 예산 (thinking 합산 상한)', () => {
  it('요청값에 thinking 여유분을 더한 상한을 보낸다', async () => {
    const fetchMock = vi.fn(async () => apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    await callClaudeTool(ENV, CALL)
    const sent = sentBody(fetchMock, 0)
    expect(sent.model).toBe('claude-opus-5')
    // 6144만 보내면 6000자 원문을 되돌려주는 diarize가 thinking과 합쳐 상시 절단된다
    expect(sent.max_tokens).toBeGreaterThan(6144 + 4096)
  })

  it('절단되면 더 큰 상한으로 1회 재시도해 오픈소스 이중 과금을 막는다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: {} }] }))
      .mockResolvedValueOnce(apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const { input } = await callClaudeTool(ENV, CALL)
    expect(input).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sentBody(fetchMock, 1).max_tokens).toBeGreaterThan(sentBody(fetchMock, 0).max_tokens)
  })

  it('재시도까지 절단되면 기존 메시지로 실패한다 (무한 재시도 금지)', async () => {
    const fetchMock = vi.fn(async () =>
      apiResponse({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', input: {} }] })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(callClaudeTool(ENV, CALL)).rejects.toThrow(/너무 길어/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("stop_reason: 'refusal'", () => {
  it('전용 메시지로 실패한다 — tool_use 탐색 실패로 둔갑하지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        apiResponse({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber' } })
      )
    )
    const err = await callClaudeTool(ENV, CALL).catch((e) => e)
    expect(err.code).toBe('refusal')
    expect(err.message).toMatch(/안전 정책/)
    expect(err.message).not.toMatch(/찾을 수 없습니다/)
    expect(err.category).toBe('cyber')
  })
})

describe('429/5xx 재시도', () => {
  it('retry-after를 존중한다 — 0초면 기본 대기 없이 곧장 재시도한다', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse({}, { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    const started = Date.now()
    const { input } = await callClaudeTool(ENV, CALL)
    expect(input).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 헤더를 무시하고 고정 1.5초를 기다렸다면 이 경계를 넘는다
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('retry-after가 남은 데드라인보다 길면 재시도하지 않고 즉시 실패한다', async () => {
    const fetchMock = vi.fn(async () => apiResponse({}, { status: 429, headers: { 'retry-after': '120' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(callClaudeTool(ENV, { ...CALL, deadlineAt: Date.now() + 5000 })).rejects.toThrow(/혼잡/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('재시도 전에 첫 응답 본문을 정리한다', async () => {
    let cancelled = 0
    const overloaded = {
      ok: false,
      status: 503,
      headers: { get: () => '0' },
      body: {
        cancel: async () => {
          cancelled += 1
        },
      },
      json: async () => ({}),
    }
    const fetchMock = vi.fn().mockResolvedValueOnce(overloaded).mockResolvedValueOnce(apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    await callClaudeTool(ENV, CALL)
    expect(cancelled).toBe(1)
  })

  it('남은 시간이 없으면 요청을 걸지 않고 지연 안내로 실패한다', async () => {
    const fetchMock = vi.fn(async () => apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    await expect(callClaudeTool(ENV, { ...CALL, deadlineAt: Date.now() - 1 })).rejects.toThrow(/지연/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getApiKey 형태 검증', () => {
  it('시크릿 변수에 도메인 문자열이 들어 있으면 키가 없는 것으로 취급한다', () => {
    const env = { 'callcenter-ax.pages.dev': 'callcenter-ax.pages.dev' }
    expect(getApiKey(env)).toBe('')
    // health.js가 claude_key: true로 거짓 보고하던 지점
    expect(hasApiKey(env)).toBe(false)
  })

  it('두 변수를 모두 읽되 sk-ant- 형태를 우선한다', () => {
    expect(getApiKey({ 'callcenter-ax.pages.dev': 'sk-ant-real' })).toBe('sk-ant-real')
    expect(
      getApiKey({ CLAUDE_API_KEY: 'https://callcenter-ax.pages.dev', 'callcenter-ax.pages.dev': 'sk-ant-real' })
    ).toBe('sk-ant-real')
  })

  it('키 형태가 아니면 fetch 없이 실패한다 (401로 조용히 강등되지 않는다)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      callClaudeTool({ 'callcenter-ax.pages.dev': 'callcenter-ax.pages.dev' }, CALL)
    ).rejects.toThrow(/CLAUDE_API_KEY/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ensureContract 요소 타입', () => {
  it('stringArrays의 원시 요소를 문자열로 강제한다', () => {
    const input = { summary: ['첫 줄', 3, true] }
    ensureContract(input, { stringArrays: ['summary'] })
    expect(input.summary).toEqual(['첫 줄', '3', 'true'])
    expect(input.summary.join(' ')).not.toMatch(/object Object/)
  })

  it('stringArrays 요소가 객체면 폴백으로 돌려보낸다', () => {
    // 예전에는 통과해 join(' ')이 "[object Object]"를 만들고 근거율까지 왜곡했다
    expect(() => ensureContract({ summary: [{ text: '요약' }] }, { stringArrays: ['summary'] })).toThrow(/불완전/)
  })

  it('arrays는 레코드 배열(analyze-batch의 calls)을 그대로 보존한다', () => {
    const input = { calls: [{ category: '요금', summary: '한 줄' }] }
    ensureContract(input, { arrays: ['calls'] })
    expect(input.calls).toHaveLength(1)
    expect(input.calls[0].category).toBe('요금')
  })

  it('문자열 필드에 문자열이 아닌 값이 오면 거부한다', () => {
    expect(() => ensureContract({ headline: 3 }, { strings: ['headline'] })).toThrow(/불완전/)
    expect(() => ensureContract({ headline: { a: 1 } }, { strings: ['headline'] })).toThrow(/불완전/)
  })

  it('입력 자체가 객체가 아니면 거부한다', () => {
    expect(() => ensureContract(null, { strings: ['headline'] })).toThrow(/불완전/)
    expect(() => ensureContract([], { arrays: ['calls'] })).toThrow(/불완전/)
  })

  it('계약을 지킨 응답은 같은 객체를 그대로 돌려준다', () => {
    const input = { summary: ['a'], headline: 'ok' }
    expect(ensureContract(input, { stringArrays: ['summary'], strings: ['headline'] })).toBe(input)
  })
})

describe('runLlmLadder 데드라인', () => {
  const OPTS = {
    system: '시스템',
    user: '사용자',
    tool: TOOL,
    maxTokens: 1024,
    workersSchema: '{"a":"..."}',
    workersMaxTokens: 512,
  }
  const workersOk = { run: async () => ({ response: '{"a":"오픈소스 결과"}' }) }

  it('시간이 남아 있으면 Claude 실패 후 오픈소스가 받아낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => apiResponse({}, { status: 400 })))
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'sk-ant-k', AI: workersOk }, OPTS)
    expect(r.engine).toBe('oss')
  })

  it('데드라인이 소진되면 오픈소스를 건너뛰고 즉시 실패로 넘긴다', async () => {
    // 오픈소스 40초까지 얹으면 엣지 100초 한도를 넘겨 524가 되고 logCall이 실행되지 않는다.
    // 진입 시각만 실제 값으로 주고 이후 시계를 200초 뒤로 보내 그 상황을 만든다.
    const base = Date.now()
    let call = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? base : base + 200000))
    const run = vi.fn(async () => ({ response: '{"a":1}' }))
    const fetchMock = vi.fn(async () => apiResponse(OK_BODY))
    vi.stubGlobal('fetch', fetchMock)
    await expect(runLlmLadder({ CLAUDE_API_KEY: 'sk-ant-k', AI: { run } }, OPTS)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
