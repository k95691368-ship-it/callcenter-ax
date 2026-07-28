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

  it('둘 다 실패하면 Claude의 원래 오류를 던진다', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 400, json: async () => ({}) }))
    await expect(runLlmLadder({ CLAUDE_API_KEY: 'k' }, OPTS)).rejects.toThrow(/혼잡/)
  })

  it('엔진이 하나도 없으면 명시적 오류를 던진다', async () => {
    await expect(runLlmLadder({}, OPTS)).rejects.toThrow(/사용 가능한 AI 엔진/)
  })
})

describe('Claude 일일 예산 칸막이', () => {
  // 카운트가 상한을 넘긴 상태를 흉내내는 D1 스텁 — Claude를 건너뛰고 오픈소스로 가야 한다
  const fullBucketDb = {
    prepare: () => ({
      bind: () => ({ run: async () => ({}), first: async () => ({ count: 999 }) }),
      run: async () => ({}),
      first: async () => ({ count: 999 }),
    }),
  }

  it('예산 소진 시 Claude API를 호출하지 않고 오픈소스가 답한다', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const r = await runLlmLadder({ CLAUDE_API_KEY: 'k', AI: workersOk, DB: fullBucketDb }, OPTS)
    expect(r.engine).toBe('oss')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('예산 소진 + 오픈소스도 없으면 예산 안내 오류를 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(runLlmLadder({ CLAUDE_API_KEY: 'k', DB: fullBucketDb }, OPTS)).rejects.toThrow(/예산/)
  })
})
