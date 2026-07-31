import { describe, it, expect } from 'vitest'
import {
  checkDailyBudget,
  costOf,
  remainingUsd,
  budgetNotice,
  DAILY_BUDGET_USD,
  RESERVE_PER_CALL_USD,
  isPaidMode,
} from '../functions/_lib/budget.js'

// ai_calls 조회를 흉내내는 D1 스텁. 실행된 SQL도 함께 붙잡아 "무엇을 세는지"를 확인한다.
//
// 집계는 mode별 행으로 돌아온다. SQL에 유료 mode 목록을 박아 두면 새 mode가 생길 때마다
// 조용히 빠지므로(실제로 live-hybrid가 그렇게 빠져 검색의 유료 호출이 예산에서 통째로
// 누락됐다), 판정은 JS의 isPaidMode가 한다.
function dbWith(rows, { throws = false } = {}) {
  const seen = { sql: '' }
  const list = Array.isArray(rows) ? rows : rows ? [{ mode: 'live', ...rows }] : []
  return {
    seen,
    prepare: (sql) => {
      seen.sql = sql
      const run = async () => {
        if (throws) throw new Error('D1 down')
        return { results: list }
      }
      return { bind: () => ({ all: run, first: async () => (await run()).results[0] }), all: run, first: async () => (await run()).results[0] }
    },
  }
}

describe('비용 계산', () => {
  it('입력·출력 단가를 각각 적용한다', () => {
    // 100만 입력 = $5, 100만 출력 = $25
    expect(costOf(1_000_000, 0)).toBeCloseTo(5)
    expect(costOf(0, 1_000_000)).toBeCloseTo(25)
    expect(costOf(null, undefined)).toBe(0)
  })
})

describe('일일 예산 — 회수가 아니라 금액으로 막는다', () => {
  it('지출이 상한 아래면 통과시킨다', async () => {
    const b = await checkDailyBudget({ DB: dbWith({ input_tokens: 10_000, output_tokens: 2_000 }) })
    expect(b.ok).toBe(true)
    expect(b.available).toBe(true)
    expect(b.spent).toBeCloseTo(0.1)
  })

  it('상한을 넘으면 막는다', async () => {
    const b = await checkDailyBudget({ DB: dbWith({ input_tokens: 700_000, output_tokens: 200_000 }) })
    expect(b.spent).toBeCloseTo(8.5)
    expect(b.ok).toBe(false)
  })

  it('이번 요청이 만들 호출 수만큼 미리 빼고 판단한다', async () => {
    // 이미 쓴 금액만 보면 이번 요청분만큼 상한을 넘겨 버린다 (일괄은 한 요청이 여러 호출)
    const nearLimit = { input_tokens: 400_000, output_tokens: 40_000 } // $3.0 - 여유 약 $0.0
    const one = await checkDailyBudget({ DB: dbWith(nearLimit) }, DAILY_BUDGET_USD, { calls: 1 })
    const many = await checkDailyBudget({ DB: dbWith(nearLimit) }, DAILY_BUDGET_USD, { calls: 10 })
    expect(many.reserve).toBeCloseTo(RESERVE_PER_CALL_USD * 10)
    expect(many.reserve).toBeGreaterThan(one.reserve)
  })

  it('무료 엔진만 제외하고, Claude가 실제로 청구한 것은 전부 센다', async () => {
    // Workers AI(live-oss)·Whisper(live-turbo/base)는 사용자의 Anthropic 크래딧이 아니다.
    expect(isPaidMode('live-oss')).toBe(false)
    expect(isPaidMode('live-base')).toBe(false)
    expect(isPaidMode('live-turbo')).toBe(false)
    expect(isPaidMode(undefined)).toBe(false)

    expect(isPaidMode('live')).toBe(true)
    // 검색은 live-hybrid·live-keyword로 남긴다. 유료 mode를 목록으로 박아 두던 시절
    // 이 둘이 통째로 빠져 검색의 Claude 지출이 예산에 잡히지 않았다.
    expect(isPaidMode('live-hybrid')).toBe(true)
    expect(isPaidMode('live-keyword')).toBe(true)
    // 강등·폴백도 센다 — LLM이 답한 뒤 근거율 게이트가 그 답을 버려도 토큰은 이미 청구됐다.
    // 버렸다는 이유로 빼면 예산이 실제 지출보다 낮게 잡힌다.
    expect(isPaidMode('guarded-hybrid')).toBe(true)
    expect(isPaidMode('fallback-refusal')).toBe(true)
  })

  it('무료 엔진 호출은 금액에 더하지 않는다', async () => {
    const db = dbWith([
      { mode: 'live', input_tokens: 10_000, output_tokens: 2_000 },
      { mode: 'live-oss', input_tokens: 900_000, output_tokens: 900_000 },
    ])
    const b = await checkDailyBudget({ DB: db })
    expect(b.spent).toBeCloseTo(0.1)
    expect(b.ok).toBe(true)
  })

  it('집계 창이 자정이 아니라 롤링 24시간이다', async () => {
    // 자정 기준이면 23시에 상한을 채운 사람이 한 시간 뒤 다시 가득 쓸 수 있다
    const db = dbWith({ input_tokens: 0, output_tokens: 0 })
    await checkDailyBudget({ DB: db })
    expect(db.seen.sql).toMatch(/-1 day/)
  })
})

describe('조회 실패와 설정 부재를 구분한다', () => {
  it('D1이 아예 없으면(로컬 개발) 막지 않는다', async () => {
    const b = await checkDailyBudget({})
    expect(b.ok).toBe(true)
    expect(b.available).toBe(false)
    expect(b.error).toBe(false)
  })

  it('조회 실패는 기본적으로 통과시킨다 (화면을 멈추지 않는다)', async () => {
    const b = await checkDailyBudget({ DB: dbWith(null, { throws: true }) })
    expect(b.ok).toBe(true)
    expect(b.error).toBe(true)
  })

  it('유료 호출 직전에는 조회 실패 시 막는다 (상한이 사라져 무제한 과금이 되는 쪽이 더 나쁘다)', async () => {
    const b = await checkDailyBudget({ DB: dbWith(null, { throws: true }) }, undefined, { failOpen: false })
    expect(b.ok).toBe(false)
    expect(b.error).toBe(true)
  })
})

describe('남은 예산과 안내 문구', () => {
  it('남은 금액을 돌려주고 음수는 0으로 접는다', async () => {
    const over = await checkDailyBudget({ DB: dbWith({ input_tokens: 700_000, output_tokens: 200_000 }) })
    expect(remainingUsd(over)).toBe(0)
  })

  it('집계할 수 없으면 남은 금액을 숫자로 지어내지 않는다', async () => {
    expect(remainingUsd(await checkDailyBudget({}))).toBeNull()
  })

  it('안내에 쓴 금액과 상한을 함께 적는다 (원인을 알 수 있게)', async () => {
    const b = await checkDailyBudget({ DB: dbWith({ input_tokens: 700_000, output_tokens: 200_000 }) })
    const note = budgetNotice(b)
    expect(note).toContain('$8.50')
    expect(note).toContain(`$${DAILY_BUDGET_USD}`)
    expect(note).toContain('24시간')
  })
})
