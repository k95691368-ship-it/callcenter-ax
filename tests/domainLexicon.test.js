import { describe, it, expect } from 'vitest'
import { applyLexicon } from '../src/lib/domainLexicon.js'
import { computeCer } from '../src/lib/cer.js'

describe('applyLexicon (STT 도메인 보정)', () => {
  it('whisper base의 실측 오전사 "한 밑에 내 콤"을 보정한다', () => {
    const { text, applied } = applyLexicon('안녕하세요. 한 밑에 내 콤 상담 사입니다.')
    expect(text).toContain('한빛텔레콤')
    expect(applied).toEqual([{ term: '한빛텔레콤', count: 1 }])
  })

  it('turbo의 실측 오전사 "한비텔레콤"을 보정한다', () => {
    const { text } = applyLexicon('한비텔레콤 상담사입니다.')
    expect(text).toBe('한빛텔레콤 상담사입니다.')
  })

  it('여러 용어를 한 번에 보정하고 건수를 집계한다', () => {
    const { text, applied } = applyLexicon('위악금 안내와 소약결제 차단, 위악금 재안내')
    expect(text).toBe('위약금 안내와 소액결제 차단, 위약금 재안내')
    expect(applied).toContainEqual({ term: '위약금', count: 2 })
    expect(applied).toContainEqual({ term: '소액결제', count: 1 })
  })

  it('보정할 것이 없으면 원문 그대로, applied는 빈 배열', () => {
    const src = '정상적인 문장입니다.'
    const { text, applied } = applyLexicon(src)
    expect(text).toBe(src)
    expect(applied).toEqual([])
  })

  it('보정 후 CER이 실제로 개선된다 (도메인 튜닝 효과 정량 확인)', () => {
    const ref = '안녕하세요. 한빛텔레콤 상담사입니다.'
    const hyp = '안녕하세요. 한 밑에 내 콤 상담 사입니다.'
    const before = computeCer(ref, hyp).cer
    const after = computeCer(ref, applyLexicon(hyp).text).cer
    expect(after).toBeLessThan(before)
    expect(after).toBe(0)
  })
})
