import { describe, it, expect } from 'vitest'
import { splitCalls, MAX_BATCH_CALLS } from '../src/lib/batchSplit.js'

describe('splitCalls (일괄 분석 입력 파서)', () => {
  it('빈 줄로 구분된 통화들을 나눈다', () => {
    const parts = splitCalls('상담사: A\n고객: B\n\n상담사: C\n\n\n상담사: D')
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('상담사: A\n고객: B')
  })

  it('최대 건수를 넘으면 잘라낸다', () => {
    const many = Array.from({ length: 9 }, (_, i) => `통화 ${i}`).join('\n\n')
    expect(splitCalls(many)).toHaveLength(MAX_BATCH_CALLS)
  })

  it('빈 입력·공백만 있으면 빈 배열이다', () => {
    expect(splitCalls('')).toEqual([])
    expect(splitCalls('  \n\n  ')).toEqual([])
    expect(splitCalls(null)).toEqual([])
  })
})
