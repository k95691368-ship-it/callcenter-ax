import { describe, it, expect } from 'vitest'
import { stripSpeakerLabels, preservesOriginal } from '../src/lib/diarizeGuard.js'

describe('stripSpeakerLabels', () => {
  it('줄 앞의 화자 라벨만 제거하고 본문은 보존한다', () => {
    const s = stripSpeakerLabels('상담사: 안녕하세요\n고객: 요금 문의요\nagent: hello')
    expect(s).toBe('안녕하세요 요금 문의요 hello')
  })

  it('라벨이 없으면 공백 정규화만 한다', () => {
    expect(stripSpeakerLabels('그냥   텍스트\n두 줄')).toBe('그냥 텍스트 두 줄')
  })
})

describe('preservesOriginal (원문 보존 게이트)', () => {
  const ORIGINAL = '안녕하세요 한빛텔레콤입니다 위약금 문의는 확인이 필요합니다'

  it('라벨만 붙인 결과는 통과한다', () => {
    const formatted = '상담사: 안녕하세요 한빛텔레콤입니다\n고객: 위약금 문의는 확인이 필요합니다'
    const g = preservesOriginal(ORIGINAL, formatted)
    expect(g.ok).toBe(true)
    expect(g.cer).toBeLessThan(0.05)
  })

  it('단어를 바꾸거나 문장을 지어낸 결과는 거부한다', () => {
    const forged = '상담사: 안녕하세요 저희는 최고의 통신사입니다\n고객: 환불을 무조건 해주세요 지금 당장요'
    const g = preservesOriginal(ORIGINAL, forged)
    expect(g.ok).toBe(false)
  })

  it('빈 원문은 항상 거부한다', () => {
    expect(preservesOriginal('', '상담사: 아무거나').ok).toBe(false)
  })
})
