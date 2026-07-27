import { describe, it, expect } from 'vitest'
import { demoAnalyze } from '../functions/api/cc/analyze.js'

describe('demoAnalyze (키 없는 환경의 규칙 기반 분석)', () => {
  it('법적 언급이 있으면 강성 + 에스컬레이션으로 표시한다', () => {
    const r = demoAnalyze('고객: 소비자원에 신고하고 소송할 겁니다. 요금이 잘못 나왔어요.')
    expect(r.sentiment).toBe('강성')
    expect(r.escalate).toBe(true)
    expect(r.escalate_reason).toBeTruthy()
  })

  it('위약금 면제 요구는 에스컬레이션 대상이다', () => {
    const r = demoAnalyze('고객: 해지할 건데 위약금 면제해 주세요.')
    expect(r.escalate).toBe(true)
    expect(r.category).toBe('해지')
  })

  it('일반 요금 문의는 에스컬레이션 없이 요금으로 분류한다', () => {
    const r = demoAnalyze('고객: 요금 납부일을 바꾸고 싶어요. 상담사: 처리해 드리겠습니다.')
    expect(r.category).toBe('요금')
    expect(r.escalate).toBe(false)
  })

  it('응답 계약(요약 3줄, 배열 필드)을 지킨다', () => {
    const r = demoAnalyze('고객: 인터넷 가입하고 싶어요.')
    expect(r.summary).toHaveLength(3)
    expect(Array.isArray(r.intent_keywords)).toBe(true)
    expect(Array.isArray(r.actions)).toBe(true)
    expect(typeof r.escalate).toBe('boolean')
  })
})
