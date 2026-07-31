import { describe, it, expect } from 'vitest'
import { FAQ_DOCS, rankByKeyword, bm25Rank, assessRetrieval } from '../src/lib/faqDocs.js'
import { GOLDEN_SET, evaluate, compareRankers } from '../src/lib/searchEval.js'
import { stemWord, tokenize, expandQuery } from '../src/lib/korean.js'

describe('한국어 토크나이저 — 조사 하나 때문에 근거 문서를 놓치지 않게', () => {
  it('조사를 떼어 낸다', () => {
    expect(stemWord('인터넷이')).toBe('인터넷')
    expect(stemWord('요금제를')).toBe('요금제')
    expect(stemWord('명의로')).toBe('명의')
  })

  it('구어체 종결어미를 떼어 낸다', () => {
    expect(stemWord('느린데요')).toBe('느린')
    expect(stemWord('해지하면')).toBe('해지')
    expect(stemWord('바꾸려면')).toBe('바꾸')
  })

  it('너무 짧아지는 절단은 하지 않는다 (의미가 사라지면 검색이 더 나빠진다)', () => {
    expect(stemWord('이가')).toBe('이가')
    expect(stemWord('네')).toBe('네')
  })

  it('동의어를 표준어로 넓힌다 (치환이 아니라 추가 — 원문 표현도 살린다)', () => {
    const e = expandQuery('해지수수료가 얼마인가요')
    expect(e).toContain('위약금')
    expect(e.some((t) => t.includes('해지수수료'))).toBe(true)
  })

  it('어간 처리로 자를 수 없는 활용형도 동의어로 잇는다', () => {
    // '끊겨요'는 어미 목록으로 자르면 한 글자만 남아 자르지 않는다 — 앞부분으로 잇는다
    expect(expandQuery('자꾸 끊겨요')).toContain('속도')
  })

  it('표준어는 문서에 실제로 있는 형태여야 한다', () => {
    // 문서가 '이전 설치'로 띄어 쓰므로 표준어가 '이전설치'면 어느 문서와도 맞지 않는다
    const docText = FAQ_DOCS.map((d) => `${d.title} ${d.body}`).join(' ')
    for (const t of expandQuery('이사 가는데 인터넷')) {
      if (t === '이전') expect(tokenize(docText)).toContain('이전')
    }
  })
})

describe('검색 자가 평가 — 개선을 느낌이 아니라 숫자로', () => {
  const cmp = compareRankers(rankByKeyword, bm25Rank)

  it('새 랭커가 예전 랭커보다 낫다', () => {
    expect(cmp.after.recall1).toBeGreaterThan(cmp.before.recall1)
    expect(cmp.after.mrr).toBeGreaterThan(cmp.before.mrr)
  })

  it('퇴행이 없다 — 예전에 맞던 질의를 새로 틀리지 않는다', () => {
    expect(cmp.regressions).toEqual([])
  })

  it('하한선을 고정한다 (다음 수정이 조용히 나빠지면 여기서 걸린다)', () => {
    const s = evaluate(bm25Rank)
    expect(s.recall1).toBeGreaterThanOrEqual(0.85)
    expect(s.recall3).toBeGreaterThanOrEqual(0.9)
    expect(s.mrr).toBeGreaterThanOrEqual(0.9)
  })

  it('무관한 질의에는 답하지 않는다', () => {
    expect(evaluate(bm25Rank).abstainAccuracy).toBe(1)
  })

  it('골든셋이 실제 상담사의 말투를 담고 있다 (문어체만 있으면 평가가 쉬워진다)', () => {
    const kinds = new Set(GOLDEN_SET.map((g) => g.kind))
    expect(kinds).toContain('구어체')
    expect(kinds).toContain('동의어')
    expect(kinds).toContain('무관')
    expect(GOLDEN_SET.filter((g) => g.expected === null).length).toBeGreaterThanOrEqual(3)
  })

  it('아는 한계를 숨기지 않는다 — 남은 실패는 목록으로 돌려준다', () => {
    // 어휘가 전혀 겹치지 않는 질의("아버지 폰을 제 앞으로 돌리려면" → 명의 변경)는
    // 어휘 기반 검색의 원리적 한계다. 억지로 규칙을 넣어 맞히면 다른 질의가 망가진다.
    // 임베딩 경로가 살아 있을 때 잡히도록 두고, 여기서는 실패로 정직하게 센다.
    const s = evaluate(bm25Rank)
    expect(Array.isArray(s.fails)).toBe(true)
    expect(s.fails.length).toBeLessThanOrEqual(2)
  })
})

describe('근거 없음 판정 — 못 찾았으면 못 찾았다고 말한다', () => {
  it('무관한 질의는 none으로 물러난다', () => {
    expect(assessRetrieval(bm25Rank('점심 메뉴 추천해줘')).level).toBe('none')
  })

  it('제대로 맞은 질의는 strong이다', () => {
    expect(assessRetrieval(bm25Rank('로밍 요금 이의 제기 절차')).level).toBe('strong')
  })

  it('빈 결과에서 터지지 않는다', () => {
    expect(assessRetrieval([]).level).toBe('none')
    expect(assessRetrieval(null).level).toBe('none')
  })
})
