import { describe, it, expect, vi, afterEach } from 'vitest'
import { runLlmLadder } from '../functions/_lib/ladder.js'

const OPTS = {
  system: '시스템',
  user: '사용자',
  tool: { name: 't', input_schema: {} },
  maxTokens: 1024,
  workersSchema: '{"a":"..."}',
  workersMaxTokens: 512,
}

// Workers AI 성공 스텁 — OpenAI 호환 형태로 JSON을 돌려준다
const workersOk = {
  run: async () => ({ choices: [{ message: { content: '{"a":"오픈소스 결과"}' } }] }),
}

afterEach(() => vi.unstubAllGlobals())

describe('runLlmLadder', () => {
  it('Claude 성공 시 claude 엔진 결과를 돌려준다', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'tool_use', input: { a: '클로드 결과' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    }))
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk }, OPTS)
    expect(r.engine).toBe('claude')
    expect(r.input.a).toBe('클로드 결과')
    expect(r.usage.input_tokens).toBe(10)
    expect(r.model).toBe(null)
  })

  it('Claude가 실패하면 데모로 추락하지 않고 오픈소스 LLM이 받아낸다', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({}) }))
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk }, OPTS)
    expect(r.engine).toBe('oss')
    expect(r.input.a).toBe('오픈소스 결과')
    expect(r.model).toBeTruthy()
  })

  it('키가 없으면 Claude를 건너뛰고 곧장 오픈소스로 간다 (fetch 미호출)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runLlmLadder({ AI: workersOk }, OPTS)
    expect(r.engine).toBe('oss')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('오픈소스 층이 없으면 Claude의 원래 오류를 던진다', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({}) }))
    await expect(runLlmLadder({ CLAUDE_API_KEY: 'k' }, OPTS)).rejects.toThrow(/혼잡/)
  })

  it('두 층이 모두 실패하면 아래층 오류가 아니라 Claude 오류를 보여준다', async () => {
    // 아래층 오류가 위층 오류를 덮어쓰면 "무엇이 먼저 무너졌는지"가 사라진다.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({}) }))
    const workersDown = { run: async () => { throw new Error('오픈소스 LLM 응답이 지연되고 있습니다') } }
    const err = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersDown }, OPTS).catch((e) => e)
    expect(err.message).toMatch(/혼잡/)
    expect(err.cause?.message).toMatch(/오픈소스/)
  })

  it('엔진이 하나도 없으면 명시적 오류를 던진다', async () => {
    await expect(runLlmLadder({}, OPTS)).rejects.toThrow(/사용 가능한 AI 엔진/)
  })
})

describe('Claude 일일 예산 칸막이 (금액 기준)', () => {
  // 상한 기준이 "회수"에서 "금액"으로 바뀌었다. 호출마다 비용이 몇 배씩 다르므로
  // 회수 상한으로는 "N회 안에서는 안전하다"가 성립하지 않기 때문이다.
  // 아래 스텁은 최근 24시간 토큰 합계를 돌려주는 ai_calls 조회를 흉내낸다.
  const dbWithSpend = (input, output) => ({
    prepare: () => ({
      bind: () => ({ first: async () => ({ input_tokens: input, output_tokens: output }) }),
      first: async () => ({ input_tokens: input, output_tokens: output }),
    }),
  })
  // 입력 70만 + 출력 20만 토큰 ≈ $8.5 — 상한 $3을 넘는다
  const spentOver = dbWithSpend(700_000, 200_000)
  const spentLittle = dbWithSpend(1_000, 500)
  const claudeOk = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'tool_use', input: { a: 'ok' } }], usage: { input_tokens: 1, output_tokens: 1 } }),
  })

  it('예산 소진 시 Claude API를 호출하지 않고 오픈소스가 답한다', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk, DB: spentOver }, OPTS)
    expect(r.engine).toBe('oss')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('예산이 남아 있으면 Claude를 그대로 쓴다', async () => {
    vi.stubGlobal('fetch', claudeOk)
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk, DB: spentLittle }, OPTS)
    expect(r.engine).toBe('claude')
  })

  it('예산 소진 + 오픈소스도 없으면 예산 안내 오류를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(runLlmLadder({ CLAUDE_API_KEY: 'k', DB: spentOver }, OPTS)).rejects.toThrow(/예산/)
  })

  it('D1 조회가 실패하면 유료 호출을 건너뛴다 (상한이 사라져 무제한 과금이 되는 쪽이 더 나쁘다)', async () => {
    const brokenDb = {
      prepare: () => ({
        bind: () => ({ first: async () => { throw new Error('D1 down') } }),
      }),
    }
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk, DB: brokenDb }, OPTS)
    expect(r.engine).toBe('oss')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('D1 바인딩이 아예 없으면(로컬 개발) 유료 경로를 막지 않는다', async () => {
    // 조회 실패와 설정 부재는 다르다 — 여기서 막으면 D1 없는 환경에서 Claude가 통째로 꺼진다
    vi.stubGlobal('fetch', claudeOk)
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk }, OPTS)
    expect(r.engine).toBe('claude')
  })
})
