import { describe, it, expect } from 'vitest'
import { checkDailyBudget, costOf, isPaidMode, INPUT_PRICE, OUTPUT_PRICE } from '../functions/_lib/budget.js'

// 비용 가드에서 위험한 방향은 과소 계산이다 — 실제로 쓴 돈보다 적게 세면 상한이 늦게 걸린다.
// 아래 세 경로가 전부 과소 계산이었고, 이 테스트가 다시 열리는 것을 막는다.

// mode별 합계를 돌려주는 D1 스텁. cacheMissing이면 캐시 컬럼이 없는 배포를 흉내낸다.
const db = (rows, { cacheMissing = false } = {}) => ({
  prepare: (sql) => ({
    all: async () => {
      if (cacheMissing && /cache_read_tokens/.test(sql)) throw new Error('D1_ERROR: no such column: cache_read_tokens')
      return { results: rows }
    },
    bind: () => ({ all: async () => ({ results: rows }) }),
  }),
})

describe('isPaidMode — 유료 호출을 목록이 아니라 규칙으로 가른다', () => {
  it('Claude 경로는 검색 모드가 붙어도 유료로 센다', () => {
    // live-hybrid는 Claude가 답한 RAG 호출인데 예전 목록 방식에서 통째로 빠졌다
    expect(isPaidMode('live')).toBe(true)
    expect(isPaidMode('live-hybrid')).toBe(true)
    expect(isPaidMode('live-keyword')).toBe(true)
  })

  it('Workers AI 경로는 무료로 센다 (다른 회사 청구서를 더하지 않는다)', () => {
    expect(isPaidMode('live-oss')).toBe(false)
    expect(isPaidMode('live-oss-hybrid')).toBe(false)
    expect(isPaidMode('live-turbo')).toBe(false)
    expect(isPaidMode('live-base')).toBe(false)
  })

  it('보존 게이트가 막은 호출도 유료다 — Claude 호출은 이미 끝났다', () => {
    expect(isPaidMode('guarded')).toBe(true)
  })

  it('절단·거절 실패도 유료다 — 상한까지 생성한 뒤 실패한 가장 비싼 호출이다', () => {
    expect(isPaidMode('fallback-max-tokens')).toBe(true)
    expect(isPaidMode('fallback-refusal')).toBe(true)
  })

  it('mode가 없으면 유료로 세지 않는다', () => {
    for (const m of [null, undefined, '', 123]) expect(isPaidMode(m)).toBe(false)
  })

  it('토큰이 없는 기록은 유료로 분류돼도 비용이 0이다 (분류가 과금을 만들지 않는다)', () => {
    expect(costOf(null, null)).toBe(0)
    expect(costOf(0, 0, 0, 0)).toBe(0)
  })
})

describe('costOf — 캐시 토큰도 과금 대상이다', () => {
  it('입력·출력 단가를 그대로 반영한다', () => {
    expect(costOf(1_000_000, 0)).toBeCloseTo(5, 6)
    expect(costOf(0, 1_000_000)).toBeCloseTo(25, 6)
  })

  it('캐시 읽기는 입력의 10%로 계산한다 (0이 아니다)', () => {
    expect(costOf(0, 0, 1_000_000, 0)).toBeCloseTo(0.5, 6)
  })

  it('캐시 생성은 입력의 125%로 계산한다', () => {
    expect(costOf(0, 0, 0, 1_000_000)).toBeCloseTo(6.25, 6)
  })

  it('캐시를 빼먹으면 실제보다 적게 나온다 — 그 차이를 고정한다', () => {
    const withCache = costOf(1000, 500, 100_000, 0)
    const withoutCache = costOf(1000, 500)
    expect(withCache).toBeGreaterThan(withoutCache)
    expect(withCache - withoutCache).toBeCloseTo(100_000 * INPUT_PRICE * 0.1, 6)
  })
})

describe('checkDailyBudget — 합산 대상', () => {
  it('검색(live-hybrid)의 Claude 지출을 포함한다', async () => {
    const rows = [{ mode: 'live-hybrid', input_tokens: 200_000, output_tokens: 40_000 }]
    const b = await checkDailyBudget({ DB: db(rows) }, 100)
    // 0.2M×$5 + 0.04M×$25 = $1 + $1 = $2
    expect(b.spent).toBeCloseTo(2, 6)
  })

  it('오픈소스·Whisper 행은 토큰이 없어 더해지지 않는다', async () => {
    // 이 경로들이 예산에서 빠지는 이유는 mode 이름이 아니라 **토큰을 보고하지 않기**
    // 때문이다. workersLlm은 {input, model}만 돌려주고 stt는 usage 없이 기록한다.
    // (그래서 아래 '무료 경로는 usage를 만들지 않는다' 테스트가 이 전제를 지킨다.)
    const rows = [
      { mode: 'live-oss', input_tokens: 0, output_tokens: 0 },
      { mode: 'live-turbo', input_tokens: null, output_tokens: null },
      { mode: 'live-base', input_tokens: 0, output_tokens: 0 },
    ]
    const b = await checkDailyBudget({ DB: db(rows) }, 100)
    expect(b.spent).toBe(0)
  })

  it('오픈소스가 답해도 그 앞에서 Claude가 쓴 토큰은 합산한다', async () => {
    // 절단은 상한까지 생성한 뒤 실패하는 가장 비싼 호출이고, 그때 오픈소스가 답하면
    // 사용자는 정상 응답을 받는다. 나간 돈이 어디에도 안 남는 것이 이 자리의 위험이었다.
    const rows = [{ mode: 'live-oss', input_tokens: 8_000, output_tokens: 16_000 }]
    const b = await checkDailyBudget({ DB: db(rows) }, 100)
    expect(b.spent).toBeGreaterThan(0.4)
  })

  it('게이트 차단·실패로 나간 토큰도 합산한다 (가장 비싼 호출을 놓치지 않는다)', async () => {
    const rows = [
      { mode: 'guarded', input_tokens: 100_000, output_tokens: 0 }, // $0.5
      { mode: 'fallback-max-tokens', input_tokens: 0, output_tokens: 16_000 }, // $0.4
    ]
    const b = await checkDailyBudget({ DB: db(rows) }, 100)
    expect(b.spent).toBeCloseTo(0.9, 6)
  })

  it('캐시 토큰을 합산한다', async () => {
    const rows = [{ mode: 'live', input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000 }]
    const b = await checkDailyBudget({ DB: db(rows) }, 100)
    expect(b.spent).toBeCloseTo(0.5, 6)
  })

  it('상한을 넘으면 막고, 남으면 통과시킨다', async () => {
    const over = [{ mode: 'live', input_tokens: 700_000, output_tokens: 200_000 }] // $8.5
    const little = [{ mode: 'live', input_tokens: 1_000, output_tokens: 500 }]
    expect((await checkDailyBudget({ DB: db(over) }, 3)).ok).toBe(false)
    expect((await checkDailyBudget({ DB: db(little) }, 3)).ok).toBe(true)
  })

  it('이번 요청의 예상 비용을 미리 빼고 판단한다 (상한을 넘겨 놓고 막지 않는다)', async () => {
    // 남은 예산이 예약분보다 작으면 통과시키면 안 된다
    const rows = [{ mode: 'live', input_tokens: 0, output_tokens: 0 }]
    const b = await checkDailyBudget({ DB: db(rows) }, 0.01)
    expect(b.ok).toBe(false)
    expect(b.reserve).toBeGreaterThan(0)
  })
})

describe('마이그레이션이 아직 적용되지 않은 배포', () => {
  it('캐시 컬럼이 없으면 옛 문장으로 물러나 계산을 계속한다', async () => {
    const rows = [{ mode: 'live', input_tokens: 200_000, output_tokens: 40_000 }]
    const b = await checkDailyBudget({ DB: db(rows, { cacheMissing: true }) }, 100)
    expect(b.error).toBe(false)
    expect(b.available).toBe(true)
    expect(b.spent).toBeCloseTo(2, 6)
  })

  it('그 밖의 D1 오류는 삼키지 않는다 — 유료 경로에서는 막는다', async () => {
    const broken = { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: connection lost') } }) }
    const b = await checkDailyBudget({ DB: broken }, 3, { failOpen: false })
    expect(b.ok).toBe(false)
    expect(b.error).toBe(true)
  })

  it('D1 바인딩이 아예 없으면 설정 상태로 보고 통과시킨다', async () => {
    const b = await checkDailyBudget({}, 3, { failOpen: false })
    expect(b.ok).toBe(true)
    expect(b.available).toBe(false)
  })
})

describe('단가 상수', () => {
  it('claude-opus-5 공식 단가와 일치한다', () => {
    expect(INPUT_PRICE * 1_000_000).toBe(5)
    expect(OUTPUT_PRICE * 1_000_000).toBe(25)
  })
})

// 예산 판정이 "토큰이 있으면 유료"라는 전제 위에 서 있다.
// 그 전제가 깨지면(무료 층이 usage를 보고하기 시작하면) 남의 회사 청구서를 우리 상한에
// 더하게 되므로, 전제 자체를 테스트로 고정한다.
describe('무료 층은 usage를 만들지 않는다 (예산 판정의 전제)', () => {
  it('workersLlm은 사용량을 돌려주지 않는다', async () => {
    const { callWorkersJson } = await import('../functions/_lib/workersLlm.js')
    const env = { AI: { run: async () => ({ response: '{"ok":true}' }) } }
    const r = await callWorkersJson(env, { system: 's', user: 'u', maxTokens: 100 })
    expect(r.usage).toBeUndefined()
  })

  it('사다리는 오픈소스 응답에 usage를 싣지 않는다 (청구분은 paidUsage로만 나간다)', async () => {
    const { runLlmLadder, billedUsage } = await import('../functions/_lib/ladder.js')
    const env = { AI: { run: async () => ({ response: '{"ok":true}' }) } } // 키 없음 = Claude 미시도
    const r = await runLlmLadder(env, {
      system: 's', user: 'u', tool: { name: 't', input_schema: { type: 'object', properties: {} } },
      maxTokens: 100, workersSchema: '{}', workersMaxTokens: 100,
    })
    expect(r.engine).toBe('oss')
    expect(r.usage).toBeNull()
    expect(billedUsage(r)).toBeNull()
  })
})
