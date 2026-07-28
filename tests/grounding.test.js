import { describe, it, expect } from 'vitest'
import { charBigrams, groundedness } from '../src/lib/grounding.js'

const DOC = '약정 기간 내 해지 시 남은 개월 수에 비례한 위약금이 발생한다. 이전 설치 불가 지역이면 위약금이 전액 면제된다.'

describe('groundedness (RAG 근거율)', () => {
  it('문서 문장을 그대로 쓴 답변은 근거율이 높다', () => {
    const g = groundedness('약정 기간 내 해지 시 위약금이 발생하며, 이전 설치 불가 지역이면 전액 면제됩니다.', DOC)
    expect(g).toBeGreaterThan(0.7)
  })

  it('문서에 없는 내용을 지어낸 답변은 근거율이 낮다', () => {
    const g = groundedness('저희 프리미엄 멤버십에 가입하시면 항공 마일리지와 호텔 할인 쿠폰을 드립니다.', DOC)
    expect(g).toBeLessThan(0.35)
  })

  it('빈 답변은 0이다', () => {
    expect(groundedness('', DOC)).toBe(0)
    expect(groundedness('   ', DOC)).toBe(0)
  })

  it('charBigrams는 공백·구두점을 제거하고 2-gram을 만든다', () => {
    const grams = charBigrams('위약금, 면제!')
    expect(grams.has('위약')).toBe(true)
    expect(grams.has('금면')).toBe(true)
    expect(grams.has(', ')).toBe(false)
  })
})
