import { describe, it, expect } from 'vitest'
import {
  checkDailyBudget,
  costOf,
  remainingUsd,
  budgetNotice,
  DAILY_BUDGET_USD,
  RESERVE_PER_CALL_USD,
  PAID_MODES,
} from '../functions/_lib/budget.js'

// ai_calls 조회를 흉내내는 D1 스텁. 실행된 SQL도 함께 붙잡아 "무엇을 세는지"를 확인한다.
function dbWith(row, { throws = false } = {}) {
  const seen = { sql: '', binds: [] }
  return {
    seen,
    prepare: (sql) => {
      seen.sql = sql
      return {
        bind: (...args) => {
          seen.binds = args
          return {
            first: async () => {
              if (throws) throw new Error('D1 down')
              return row
            },
          }
        },
      }
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

  it('유료(Claude) 호출만 센다 — 다른 회사 청구서를 여기에 더하지 않는다', async () => {
    const db = dbWith({ input_tokens: 0, output_tokens: 0 })
    await checkDailyBudget({ DB: db })
    // Workers AI(live-oss)·Whisper(live-base)는 사용자의 Anthropic 크래딧이 아니다
    expect(db.seen.binds).toEqual(PAID_MODES)
    expect(PAID_MODES).toEqual(['live'])
    expect(db.seen.sql).toMatch(/mode IN/)
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
