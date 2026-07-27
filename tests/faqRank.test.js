import { describe, it, expect } from 'vitest'
import { FAQ_DOCS, rankByKeyword, cosineSim } from '../src/lib/faqDocs.js'

describe('rankByKeyword (임베딩 폴백 랭킹)', () => {
  it('위약금 질문은 해지 위약금 문서를 1위로 올린다', () => {
    const ranked = rankByKeyword('이사 때문에 해지하면 위약금 내야 하나요?')
    expect(ranked[0].id).toBe('faq02')
    expect(ranked[0].score).toBeGreaterThan(0)
  })

  it('로밍 요금 질문은 로밍 문서를 1위로 올린다', () => {
    const ranked = rankByKeyword('해외 로밍 요금이 잘못 나온 것 같아요')
    expect(ranked[0].id).toBe('faq04')
  })

  it('관련 없는 질문은 점수가 낮거나 0이다', () => {
    const ranked = rankByKeyword('점심 메뉴 추천')
    expect(ranked[0].score).toBe(0)
  })

  it('문서 전체를 대상으로 하고 원본을 변형하지 않는다', () => {
    const ranked = rankByKeyword('요금제')
    expect(ranked).toHaveLength(FAQ_DOCS.length)
    expect(FAQ_DOCS[0]).not.toHaveProperty('score')
  })
})

describe('cosineSim', () => {
  it('같은 방향 벡터는 1', () => {
    expect(cosineSim([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
  })

  it('직교 벡터는 0', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('영벡터는 0으로 처리한다 (0으로 나누지 않음)', () => {
    expect(cosineSim([0, 0], [1, 2])).toBe(0)
  })
})
