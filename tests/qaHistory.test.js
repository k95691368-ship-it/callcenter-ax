import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadQaHistory, saveQaResult, clearQaHistory, summarizeQaHistory } from '../src/lib/qaHistory.js'

// QA 코칭 이력은 이미 받은 평가 결과만 재사용한다 — LLM 재호출 없음, 서버 저장 없음.
// 전사 원문을 저장하지 않는다는 계약을 테스트로 고정한다.

function stubStorage() {
  const map = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  })
  return map
}

const result = (total, { missed = [], violations = [], estimated = false } = {}) => ({
  score: {
    total,
    grade: total >= 90 ? 'A' : total >= 80 ? 'B' : total >= 70 ? 'C' : 'D',
    ruleScore: 32,
    llmScore: total - 32,
    deduction: 0,
    llmEstimated: estimated,
  },
  mentions: [
    { label: '첫인사·소속 밝히기', found: !missed.includes('첫인사·소속 밝히기') },
    { label: '녹취 고지', found: !missed.includes('녹취 고지') },
  ],
  findings: violations.map((label) => ({ label })),
})

describe('qaHistory 저장', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('비어 있으면 빈 배열이다', () => {
    expect(loadQaHistory()).toEqual([])
  })

  it('점수와 놓친 항목만 저장한다 — 전사 원문은 저장하지 않는다', () => {
    saveQaResult(result(80, { missed: ['녹취 고지'] }), { label: '테스트 통화' })
    const [row] = loadQaHistory()
    expect(row.total).toBe(80)
    expect(row.missed).toEqual(['녹취 고지'])
    // 전사·원문 필드가 없어야 한다
    expect(Object.keys(row)).not.toContain('transcript')
    expect(JSON.stringify(row)).not.toContain('상담사:')
  })

  it('점수가 없는 응답은 저장하지 않는다', () => {
    saveQaResult({ error: '실패' })
    expect(loadQaHistory()).toEqual([])
  })

  it('60건을 넘기면 최신 60건만 남긴다', () => {
    for (let i = 0; i < 65; i++) saveQaResult(result(70 + (i % 20)))
    expect(loadQaHistory()).toHaveLength(60)
  })

  it('라벨은 30자로 자른다', () => {
    saveQaResult(result(80), { label: '가'.repeat(60) })
    expect(loadQaHistory()[0].label.length).toBe(30)
  })

  it('저장 불가 환경에서도 예외를 던지지 않는다', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    })
    expect(() => saveQaResult(result(80))).not.toThrow()
  })

  it('clearQaHistory가 이력을 비운다', () => {
    stubStorage()
    saveQaResult(result(80))
    clearQaHistory()
    expect(loadQaHistory()).toEqual([])
  })
})

describe('summarizeQaHistory — 코칭 카드', () => {
  it('이력이 없으면 null이다', () => {
    expect(summarizeQaHistory([])).toBeNull()
    expect(summarizeQaHistory(null)).toBeNull()
  })

  it('평균과 건수를 계산한다', () => {
    const s = summarizeQaHistory([{ total: 80 }, { total: 90 }, { total: 70 }])
    expect(s.count).toBe(3)
    expect(s.avg).toBe(80)
  })

  it('표본이 4건 미만이면 추세를 말하지 않는다 — 노이즈를 분석이라 하지 않는다', () => {
    expect(summarizeQaHistory([{ total: 90 }, { total: 60 }]).trend).toBeNull()
  })

  it('반복 누락 항목을 코칭 카드로 만든다', () => {
    const history = [
      { total: 80, missed: ['녹취 고지'], violations: [] },
      { total: 78, missed: ['녹취 고지'], violations: [] },
      { total: 82, missed: [], violations: [] },
    ]
    const s = summarizeQaHistory(history)
    expect(s.missedTop[0]).toEqual({ label: '녹취 고지', count: 2 })
    expect(s.cards.some((c) => c.label.includes('반복 누락'))).toBe(true)
  })

  it('1회만 발생한 항목은 반복이라 부르지 않는다', () => {
    const s = summarizeQaHistory([
      { total: 80, missed: ['녹취 고지'], violations: [] },
      { total: 85, missed: [], violations: [] },
    ])
    expect(s.cards.some((c) => c.label.includes('반복 누락'))).toBe(false)
  })

  it('하락 추세를 잡아낸다', () => {
    const s = summarizeQaHistory([{ total: 90 }, { total: 88 }, { total: 70 }, { total: 68 }])
    expect(s.trend.direction).toBe('down')
    expect(s.cards.some((c) => c.id === 'coach-trend-down')).toBe(true)
  })

  it('개선 추세도 잡아낸다', () => {
    const s = summarizeQaHistory([{ total: 60 }, { total: 62 }, { total: 85 }, { total: 88 }])
    expect(s.trend.direction).toBe('up')
    expect(s.cards.some((c) => c.id === 'coach-trend-up')).toBe(true)
  })

  it('반복 패턴이 없으면 없다고 말한다', () => {
    const s = summarizeQaHistory([
      { total: 85, missed: [], violations: [] },
      { total: 86, missed: [], violations: [] },
    ])
    expect(s.cards[0].id).toBe('coach-none')
  })

  it('추정 점수 건수를 따로 센다 (실측과 섞어 보여주지 않기 위해)', () => {
    const s = summarizeQaHistory([
      { total: 80, estimated: true },
      { total: 85, estimated: false },
    ])
    expect(s.estimatedCount).toBe(1)
  })

  it('추세선용 좌표를 돌려준다', () => {
    const s = summarizeQaHistory([{ total: 80, date: '2026-07-27' }, { total: 90, date: '2026-07-28' }])
    expect(s.points).toHaveLength(2)
    expect(s.points[1]).toMatchObject({ total: 90, date: '2026-07-28' })
  })
})
