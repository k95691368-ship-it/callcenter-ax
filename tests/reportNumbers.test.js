import { describe, it, expect } from 'vitest'
import { extractNumbers, allowedNumbers, verifyReportNumbers } from '../src/lib/reportNumbers.js'

const STATS = {
  total: 12,
  escalatedCount: 2,
  byCategory: [{ name: '요금', count: 5 }, { name: '해지', count: 4 }, { name: '기타', count: 3 }],
  bySentiment: [{ name: '강성', count: 3 }, { name: '중립', count: 9 }],
}

describe('extractNumbers', () => {
  it('콤마·소수 포함 숫자를 추출한다', () => {
    expect(extractNumbers('총 1,234건 중 41.7%가 요금')).toEqual([1234, 41.7])
  })
})

describe('allowedNumbers', () => {
  it('원본 수치와 파생 퍼센트를 허용한다', () => {
    const a = allowedNumbers(STATS)
    expect(a.has(12)).toBe(true)
    expect(a.has(5)).toBe(true)
    expect(a.has(41.7)).toBe(true) // 5/12
    expect(a.has(42)).toBe(true) // 반올림 정수
  })
})

describe('verifyReportNumbers (숫자 환각 검증)', () => {
  it('집계 수치·파생 퍼센트만 쓴 리포트는 통과한다', () => {
    const r = verifyReportNumbers(['총 12건 중 요금 5건(41.7%)이 최다, 에스컬레이션 2건'], STATS)
    expect(r.ok).toBe(true)
  })

  it('집계에 없는 숫자를 지어내면 잡아낸다', () => {
    const r = verifyReportNumbers(['지난달 대비 350% 급증했고 처리 비용은 870만 원'], STATS)
    expect(r.ok).toBe(false)
    expect(r.unknown).toContain(350)
    expect(r.unknown).toContain(870)
  })

  it('0~10 소형 서수는 허용한다 (첫째, 3가지 등 표현)', () => {
    const r = verifyReportNumbers(['3가지 개선안 중 1순위는 요금 안내'], STATS)
    expect(r.ok).toBe(true)
  })
})
