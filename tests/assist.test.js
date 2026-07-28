import { describe, it, expect } from 'vitest'
import { extractQuery, demoAssist } from '../functions/api/cc/assist.js'
import { FAQ_DOCS, rankByKeyword } from '../src/lib/faqDocs.js'

describe('extractQuery (검색 질의 추출)', () => {
  it('마지막 고객 발화를 질의로 뽑는다', () => {
    const q = extractQuery(
      '상담사: 안녕하세요\n고객: 위약금이 왜 이래요\n상담사: 확인해 드릴게요\n고객: 이사 가는데 왜 내야 하죠?'
    )
    expect(q).toBe('이사 가는데 왜 내야 하죠?')
  })

  it('고객 발화가 없으면 대화 끝부분을 쓴다', () => {
    const q = extractQuery('상담사: 요금제 변경 안내드립니다')
    expect(q).toContain('요금제 변경')
  })
})

describe('demoAssist (LLM 없는 폴백 제안)', () => {
  const docs = rankByKeyword('이사 해지 위약금', FAQ_DOCS).slice(0, 2)

  it('최상위 근거 문서를 인용한 멘트 2개를 만든다', () => {
    const r = demoAssist(docs, '고객: 위약금 내야 하나요?')
    expect(r.suggestions).toHaveLength(2)
    expect(r.suggestions[1]).toContain(docs[0].title)
    expect(r.cited_ids).toEqual([docs[0].id])
  })

  it('법적 대응·보상 언급이 있으면 에스컬레이션 주의를 띄운다', () => {
    const r = demoAssist(docs, '고객: 해결 안 되면 소송할 겁니다')
    expect(r.caution).toContain('에스컬레이션')
    const calm = demoAssist(docs, '고객: 요금제 알려주세요')
    expect(calm.caution).toBe('')
  })
})
