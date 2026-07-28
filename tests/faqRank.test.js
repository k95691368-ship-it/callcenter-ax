import { describe, it, expect } from 'vitest'
import { FAQ_DOCS, rankByKeyword, cosineSim, fuseRankings } from '../src/lib/faqDocs.js'

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

describe('fuseRankings (하이브리드 RRF 융합)', () => {
  const A = { id: 'a', title: 'A', body: '', score: 0.9 }
  const B = { id: 'b', title: 'B', body: '', score: 0.5 }
  const C = { id: 'c', title: 'C', body: '', score: 0.4 }

  it('두 랭킹 모두에서 상위인 문서가 최상단에 온다', () => {
    const fused = fuseRankings([
      [A, B, C],
      [B, A, C],
    ])
    // A: 1/61+1/62, B: 1/62+1/61 → 동률, C: 1/63×2 → 최하위
    expect(fused.map((d) => d.id)).toContain('a')
    expect(fused[2].id).toBe('c')
  })

  it('한쪽 랭킹에만 있는 문서보다 양쪽에 있는 문서가 우선한다', () => {
    const fused = fuseRankings([
      [A, B],
      [B, C],
    ])
    expect(fused[0].id).toBe('b')
  })

  it('topK로 절단하고 rrf 점수를 붙인다', () => {
    const fused = fuseRankings([[A, B, C]], { topK: 2 })
    expect(fused).toHaveLength(2)
    expect(fused[0].rrf).toBeGreaterThan(fused[1].rrf)
  })

  it('첫 랭킹(벡터)의 원본 score 필드를 보존한다', () => {
    const fused = fuseRankings([
      [{ ...A, score: 0.87 }],
      [{ ...A, score: 3 }],
    ])
    expect(fused[0].score).toBe(0.87)
  })
})
