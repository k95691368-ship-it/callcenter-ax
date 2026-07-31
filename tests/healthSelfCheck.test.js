import { describe, it, expect } from 'vitest'
import { onRequestGet } from '../functions/api/cc/health.js'

// 자가 점검이 지켜야 할 것: "바인딩이 있다"와 "기능이 동작한다"를 구분해 말한다.
// 특히 예산이 소진된 상태에서 엔진 배지는 여전히 claude-opus-5인데 응답은 데모로 나간다 —
// 그 차이를 시스템이 스스로 알고 말하지 못하면 화면이 거짓을 말하게 된다.

// spend: 최근 24시간 유료(Claude) 토큰 합계 — 유료 상한이 회수에서 금액으로 바뀌면서
// "소진 상태"를 흉내내려면 버킷 카운트가 아니라 토큰 합계를 돌려줘야 한다.
const db = (counts = {}, spend = null) => ({
  prepare: (sql = '') => ({
    bind: (bucket) => ({
      first: async () =>
        /input_tokens/.test(sql) ? spend || { input_tokens: 0, output_tokens: 0 } : { count: counts[bucket] ?? 0 },
    }),
    first: async () => ({ ok: 1 }),
  }),
})

const get = async (env) => (await onRequestGet({ env })).json()
const cap = (d, id) => d.capabilities.find((c) => c.id === id)

describe('자가 점검 (health capabilities)', () => {
  it('엔진이 없으면 LLM·STT·RAG를 off로 판정한다', async () => {
    const d = await get({})
    expect(cap(d, 'llm').state).toBe('off')
    expect(cap(d, 'stt').state).toBe('off')
    expect(cap(d, 'rag').state).toBe('off')
  })

  it('규칙 검증층은 어떤 상태에서도 ready다 (외부 의존이 없다)', async () => {
    for (const env of [{}, { AI: {} }, { AI: {}, DB: db(), CLAUDE_API_KEY: 'sk-ant-x' }]) {
      const d = await get(env)
      expect(cap(d, 'rules').state).toBe('ready')
    }
  })

  it('Claude 키가 있고 예산이 남으면 LLM은 ready다', async () => {
    const d = await get({ AI: {}, DB: db(), CLAUDE_API_KEY: 'sk-ant-x' })
    expect(cap(d, 'llm').state).toBe('ready')
    expect(cap(d, 'llm').detail).toContain('Claude')
  })

  it('유료 예산이 소진되면 엔진 배지와 무관하게 degraded로 말한다', async () => {
    // 유료 상한이 회수에서 금액으로 바뀌었다 — 소진 상태는 토큰 합계로 흉내낸다
    const d = await get({ AI: {}, DB: db({}, { input_tokens: 700_000, output_tokens: 200_000 }), CLAUDE_API_KEY: 'sk-ant-x' })
    // 배지는 여전히 claude를 가리키지만
    expect(d.llm_engine).toBe('claude-opus-5')
    // 자가 점검은 실제 경로를 말한다
    expect(cap(d, 'llm').state).toBe('degraded')
    expect(cap(d, 'llm').detail).toContain('오픈소스')
    expect(d.budget.claude_budget_left_usd).toBe(0)
  })

  it('공유 예산이 소진되면 LLM은 off다 (데모로 나간다)', async () => {
    const d = await get({ AI: {}, DB: db({ 'cc:daily:all': 300 }), CLAUDE_API_KEY: 'sk-ant-x' })
    expect(cap(d, 'llm').state).toBe('off')
    // 공유 상한은 '회수' 한도이고 유료 상한만 '예산'(금액)이다 — 둘을 같은 말로 부르면
    // 어느 쪽에 걸렸는지 알 수 없어 문구를 갈랐다.
    expect(cap(d, 'llm').detail).toContain('한도')
    expect(d.budget.shared_daily_left).toBe(0)
  })

  it('Vectorize가 없으면 RAG는 degraded — 되는 것처럼 말하지 않는다', async () => {
    const withVec = await get({ AI: {}, VECTORIZE: {}, DB: db() })
    const without = await get({ AI: {}, DB: db() })
    expect(cap(withVec, 'rag').state).toBe('ready')
    expect(cap(without, 'rag').state).toBe('degraded')
    expect(cap(without, 'rag').detail).toContain('실시간 임베딩')
  })

  it('상태 점검이 예산을 차감하지 않는다 (보는 행위가 상태를 바꾸면 점검이 아니다)', async () => {
    let inserted = 0
    const env = {
      AI: {},
      CLAUDE_API_KEY: 'sk-ant-x',
      DB: {
        prepare: (sql) => {
          if (/INSERT/i.test(sql)) inserted += 1
          return {
            bind: () => ({ first: async () => ({ count: 0 }), run: async () => ({}) }),
            first: async () => ({ ok: 1 }),
            run: async () => ({}),
          }
        },
      },
    }
    await get(env)
    expect(inserted).toBe(0)
  })

  it('점검 결과는 캐시하지 않는다 (이미 바뀐 상태를 보여주면 안 된다)', async () => {
    const res = await onRequestGet({ env: {} })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('D1이 없어도 응답이 깨지지 않는다', async () => {
    const d = await get({ AI: {} })
    expect(d.ok).toBe(true)
    expect(d.budget.claude_budget_left_usd).toBeNull()
    expect(cap(d, 'telemetry').state).toBe('off')
  })

  it('모든 capability에 상태와 설명이 있다', async () => {
    const d = await get({ AI: {}, DB: db() })
    expect(d.capabilities.length).toBeGreaterThanOrEqual(5)
    for (const c of d.capabilities) {
      expect(['ready', 'degraded', 'off']).toContain(c.state)
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.detail.length).toBeGreaterThan(0)
    }
  })
})
