import { describe, it, expect } from 'vitest'
import { HOLDOUT_SET, GOLDEN_SET, evaluate, selfAssessment } from '../src/lib/searchEval.js'
import { bm25Rank, rankByKeyword } from '../src/lib/faqDocs.js'

// 골든셋만으로 자기 품질을 재면 시스템은 자기 실력을 실제보다 높게 안다.
// 랭커를 고치면서 계속 돌려본 셋이기 때문이다(의도하지 않아도 그 셋에 맞춰진다).
// 그래서 보지 않은 질의로 다시 재고, 밖에 내보이는 숫자는 그쪽으로 삼는다.

describe('홀드아웃 — 튜닝에 쓰지 않은 질의', () => {
  it('골든셋과 겹치는 질의가 없다 (겹치면 홀드아웃이 아니다)', () => {
    const golden = new Set(GOLDEN_SET.map((g) => g.q))
    for (const h of HOLDOUT_SET) expect(golden.has(h.q)).toBe(false)
  })

  it('답변 가능 질의와 무관 질의를 모두 포함한다', () => {
    expect(HOLDOUT_SET.filter((h) => h.expected).length).toBeGreaterThanOrEqual(10)
    expect(HOLDOUT_SET.filter((h) => h.expected === null).length).toBeGreaterThanOrEqual(3)
  })

  it('기대 문서 id가 실제로 존재하는 문서를 가리킨다', () => {
    const ids = new Set(['faq01', 'faq02', 'faq03', 'faq04', 'faq05', 'faq06', 'faq07', 'faq08'])
    for (const h of HOLDOUT_SET) if (h.expected) expect(ids.has(h.expected)).toBe(true)
  })
})

describe('새 랭커가 보지 않은 질의에서도 낫다 (골든셋에 맞춰진 것이 아니다)', () => {
  const before = evaluate(rankByKeyword, { set: HOLDOUT_SET })
  const after = evaluate(bm25Rank, { set: HOLDOUT_SET })

  it('recall@1·recall@3·MRR 모두 퇴행하지 않는다', () => {
    expect(after.recall1).toBeGreaterThanOrEqual(before.recall1)
    expect(after.recall3).toBeGreaterThanOrEqual(before.recall3)
    expect(after.mrr).toBeGreaterThanOrEqual(before.mrr)
  })

  it('실측 하한선을 고정한다 — 다음 수정이 조용히 나빠지면 걸린다', () => {
    // 2026-07-31 실측: recall@1 0.571 · recall@3 0.929 · MRR 0.740
    expect(after.recall1).toBeGreaterThanOrEqual(0.5)
    expect(after.recall3).toBeGreaterThanOrEqual(0.85)
    expect(after.mrr).toBeGreaterThanOrEqual(0.7)
  })

  it('무관한 질의에는 답하지 않는다 (자신 있게 틀리는 것도 실패다)', () => {
    expect(after.abstainAccuracy).toBe(1)
  })
})

describe('selfAssessment — 자기 과대평가 폭을 스스로 잰다', () => {
  const s = selfAssessment()

  it('튜닝 셋과 홀드아웃을 나눠 낸다', () => {
    expect(s.tuned.recall1).toBeGreaterThan(0)
    expect(s.holdout.recall1).toBeGreaterThan(0)
  })

  it('밖에 말하는 수치는 낙관적인 쪽이 아니라 보지 않은 쪽이다', () => {
    expect(s.reportable.recall1).toBe(s.holdout.recall1)
    expect(s.reportable.mrr).toBe(s.holdout.mrr)
  })

  it('과대평가 폭을 숨기지 않고 숫자로 돌려준다', () => {
    expect(s.optimismGap.recall1).toBeCloseTo(s.tuned.recall1 - s.holdout.recall1, 3)
    // 실제로 격차가 있다 — 이 사실 자체가 골든셋만 믿으면 안 된다는 근거다
    expect(s.optimismGap.recall1).toBeGreaterThan(0)
  })
})
