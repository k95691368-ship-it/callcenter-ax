import { describe, it, expect } from 'vitest'
import { rewriteQuery, corpusVocabulary, REWRITE_RULES } from '../src/lib/queryRewrite.js'
import { FAQ_DOCS, bm25Rank, assessRetrieval } from '../src/lib/faqDocs.js'
import { HOLDOUT_SET, GOLDEN_SET, evaluate, rewriteRank, rewriteGain } from '../src/lib/searchEval.js'

// 이 층이 존재하는 이유는 하나다: 고객은 문서의 낱말로 말하지 않는다.
// "아버지 폰을 제 앞으로 돌리려면"은 명의 변경 문서와 겹치는 어절이 하나도 없어서
// 어간 처리로도 동의어 사전으로도 잇지 못했다(BM25 점수 전부 0이었다).

const rw = (q) => rewriteQuery(q, FAQ_DOCS)
const top = (q) => bm25Rank(rw(q).text, FAQ_DOCS)[0].id

describe('확장이지 치환이 아니다', () => {
  it('원문을 그대로 남기고 표준 용어만 덧붙인다', () => {
    // 치환하면 원문에만 있던 표현으로 맞출 기회를 잃고, 재작성이 틀렸을 때 되돌릴 근거도 사라진다
    const r = rw('와이프랑 같이 쓰면 싸진다던데')
    expect(r.text.startsWith('와이프랑 같이 쓰면 싸진다던데')).toBe(true)
    expect(r.added.length).toBeGreaterThan(0)
  })

  it('LLM에 넘길 원문을 따로 보존한다', () => {
    // search.js는 검색에만 text를 쓰고 답변 생성에는 original을 넘긴다.
    // 재작성본으로 답하게 하면 고객이 묻지 않은 '가족 결합 할인'을 설명하게 된다.
    const q = '와이프랑 같이 쓰면 싸진다던데'
    expect(rw(q).original).toBe(q)
  })

  it('이미 원문에 있는 말은 두 번 넣지 않는다', () => {
    // 같은 말을 두 번 세면 그 문서만 부풀어 랭킹이 왜곡된다
    const r = rw('해지하면 돈 내야 하나요')
    expect(r.applied).toContain('해지')
    expect(r.added).toEqual([])
    expect(r.text).toBe('해지하면 돈 내야 하나요')
  })
})

describe('세 축 — 관계어·행위·상태', () => {
  it('행위 표현을 업무 용어로 잇는다', () => {
    expect(rw('아버지 폰을 제 앞으로 돌리려면').added).toContain('변경')
    expect(rw('통신사 명의자 바꾸기').added).toContain('변경')
    expect(rw('약정 남았는데 중간에 그만두면 얼마 물어야 돼요').added).toContain('해지')
    expect(rw('가족끼리 묶으면 얼마 할인되나요').added).toContain('결합')
    // 공백을 지우고 보므로 '같이 쓰면'도 한 단서로 잡힌다
    expect(rw('와이프랑 같이 쓰면 싸진다던데').added).toContain('결합')
  })

  it('상태 표현을 요금 맥락으로 잇는다', () => {
    // '더 싼'의 '싼'은 한 글자라 tokenize 단계에서 통째로 버려진다 — 원문 문자열을 직접 봐야 잡힌다
    expect(rw('데이터 많이 쓰는데 더 싼 상품 없나요').added).toContain('할인')
    expect(rw('요금제가 너무 비싸요').added).toContain('할인')
  })

  it('관계어는 방향을 정하지 않고 후보만 넓힌다', () => {
    // '가족'은 결합(faq03)과 명의 변경(faq07) 양쪽에 있다. 방향은 함께 걸린 행위 규칙이 정한다.
    expect(rw('아버지 폰을 제 앞으로 돌리려면').added).toEqual(expect.arrayContaining(['가족', '변경']))
    expect(rw('와이프랑 같이 쓰면 싸진다던데').added).toEqual(expect.arrayContaining(['가족', '결합']))
  })

  it('복합어에 묻힌 도메인 용어를 꺼낸다', () => {
    // '중도해지'는 한 덩어리로 토큰화돼 '해지'와 매칭되지 않았다 (실측: 1위가 faq08이었다)
    expect(rw('중도해지 비용 문의').added).toContain('해지')
  })
})

describe('게이트 — 재작성이 근거를 만들어내지 못하게 막는다', () => {
  // 덧붙이는 표준 용어는 전부 코퍼스에 실제로 있는 말이라, 재작성한 질의는 점수가 0이 될 수 없다.
  // 즉 재작성은 '근거 없음' 판정을 되돌릴 힘을 가진다 — 무관한 질문에 물러나는 것도
  // 이 검색이 지켜야 할 정답 행동이므로, 그 힘을 쓰지 못하게 조건을 건다.

  it('수식어만 걸린 질의는 재작성하지 않는다', () => {
    // 게이트가 없을 때 실측: "부모님 생신 선물 추천해줘"가 none → strong(faq03)으로 바뀌었다.
    // 평가셋의 무관 질의(점심 메뉴·날씨·주식)에는 관계어가 없어서 abstainAccuracy에 잡히지 않았다.
    for (const q of ['부모님 생신 선물 추천해줘', '와이프 선물 뭐가 좋아', '싼 항공권 알려줘', '저렴한 호텔 예약']) {
      const r = rw(q)
      expect(r.blocked).toBe(true)
      expect(r.added).toEqual([])
      expect(assessRetrieval(bm25Rank(r.text, FAQ_DOCS)).level).toBe('none')
    }
  })

  it('원문이 코퍼스 어휘에 걸리면 수식어 규칙도 통과시킨다', () => {
    // '데이터'가 문서에 있는 말이므로 이 질문이 상담 관련이라는 자체 근거가 있다
    const r = rw('데이터 많이 쓰는데 더 싼 상품 없나요')
    expect(r.anchored).toBe(true)
    expect(r.blocked).toBe(false)
  })

  it('행위 규칙은 어휘 근거가 없어도 통과한다 (행위 표현 자체가 상담 주제다)', () => {
    const r = rw('와이프랑 같이 쓰면 싸진다던데')
    expect(r.anchored).toBe(false)
    expect(r.blocked).toBe(false)
  })

  it('docs를 넘기지 않으면 어휘 근거를 확인할 수 없으므로 행위 규칙만 통과한다', () => {
    expect(rewriteQuery('와이프 선물 싸게').blocked).toBe(true)
    expect(rewriteQuery('중도해지 비용 문의').added).toContain('해지')
  })
})

describe('넣지 않은 규칙 — 하나를 맞히려다 다른 것을 깨지 않게', () => {
  it("'끊기다'를 해지로 잇지 않는다 (인터넷이 끊기는 것은 속도 장애다)", () => {
    expect(rw('인터넷이 자꾸 끊겨요').added).toEqual([])
    expect(top('인터넷이 자꾸 끊겨요')).toBe('faq06')
    expect(top('와이파이가 자꾸 뚝뚝 끊기는데 점검 좀요')).toBe('faq06')
  })

  it("'이관'을 변경으로 잇지 않는다 (faq04의 부서 이관과 부딪힌다)", () => {
    expect(rw('전문 부서로 이관해 주세요').added).toEqual([])
  })

  it("'아이'를 가족으로 잇지 않는다 (아이 관련 질의는 소액결제로 가야 한다)", () => {
    expect(rw('아이가 게임 결제를 자꾸 해요').added).toEqual([])
    expect(top('아이가 게임 결제를 자꾸 해요')).toBe('faq05')
    expect(top('애가 모바일로 아이템 산 거 취소되나요')).toBe('faq05')
  })

  it('규칙 표는 topic/modifier로만 분류된다 (게이트가 이 구분에 걸려 있다)', () => {
    expect(REWRITE_RULES.length).toBeGreaterThan(0)
    for (const r of REWRITE_RULES) {
      expect(['topic', 'modifier']).toContain(r.kind)
      expect(r.when.length).toBeGreaterThan(0)
      expect(r.add.length).toBeGreaterThan(0)
    }
  })
})

describe('원래 못 찾던 두 질의', () => {
  it('"아버지 폰을 제 앞으로 돌리려면" → 명의 변경', () => {
    // 재작성 전: 7위 (1위는 요금제 규정)
    expect(top('아버지 폰을 제 앞으로 돌리려면')).toBe('faq07')
  })

  it('"와이프랑 같이 쓰면 싸진다던데" → 결합 할인', () => {
    // 재작성 전: 어절 매치가 하나도 없어 점수 전부 0 → 2-gram 폴백으로 3위
    expect(top('와이프랑 같이 쓰면 싸진다던데')).toBe('faq03')
  })
})

describe('전후 비교 — 개선을 숫자로 남긴다 (밖에 말하는 수치는 홀드아웃)', () => {
  const gain = rewriteGain()

  it('홀드아웃의 어떤 지표도 떨어지지 않는다', () => {
    expect(gain.holdout.delta.recall1).toBeGreaterThanOrEqual(0)
    expect(gain.holdout.delta.recall3).toBeGreaterThanOrEqual(0)
    expect(gain.holdout.delta.mrr).toBeGreaterThanOrEqual(0)
  })

  it('예전에 맞던 질의를 새로 틀리지 않는다 (개선이 아니라 교환이면 채택하지 않는다)', () => {
    expect(gain.holdout.regressions).toEqual([])
    expect(gain.golden.regressions).toEqual([])
  })

  it('무관 질의에 물러나는 정확도를 지킨다 — 다른 어떤 지표보다 먼저 본다', () => {
    expect(gain.abstainKept).toBe(true)
    expect(gain.holdout.after.abstainAccuracy).toBe(1)
    expect(gain.golden.after.abstainAccuracy).toBe(1)
  })

  it('홀드아웃 실측 하한선을 고정한다 — 다음 수정이 조용히 나빠지면 걸린다', () => {
    // 2026-07-31 실측: recall@1 0.571 → 0.857 · recall@3 0.929 → 0.929 · MRR 0.740 → 0.907
    const after = evaluate(rewriteRank, { set: HOLDOUT_SET })
    expect(after.recall1).toBeGreaterThanOrEqual(0.85)
    expect(after.recall3).toBeGreaterThanOrEqual(0.92)
    expect(after.mrr).toBeGreaterThanOrEqual(0.9)
  })

  it('골든셋만 오르는 변경이 아니다 (그건 채점표에 맞춘 것이다)', () => {
    // 골든셋은 랭커를 고치면서 계속 돌려본 셋이라 여기만 오르는 개선은 개선이 아니다
    expect(gain.holdout.delta.recall1).toBeGreaterThan(0)
  })

  it('남은 실패를 숨기지 않고 목록으로 돌려준다', () => {
    // 어휘가 겹치지 않는 질의는 어휘 검색의 원리적 한계다. 억지로 규칙을 넣어 맞히면
    // 홀드아웃이 채점표가 되고 "보지 않은 질의로 잰다"는 전제가 사라진다.
    expect(Array.isArray(gain.remaining)).toBe(true)
    expect(gain.remaining.length).toBeGreaterThan(0)
    expect(gain.remaining.length).toBeLessThanOrEqual(3)
  })

  it('홀드아웃이 골든셋보다 낮게 유지된다 (14문항에서 만점이 나오면 그건 실력이 아니다)', () => {
    const holdout = evaluate(rewriteRank, { set: HOLDOUT_SET })
    const golden = evaluate(rewriteRank, { set: GOLDEN_SET })
    expect(holdout.recall1).toBeLessThan(golden.recall1)
  })
})

describe('입력 방어', () => {
  it('빈 값·null·비문자열에서 터지지 않는다', () => {
    for (const q of ['', '   ', null, undefined, 12345]) {
      const r = rewriteQuery(q, FAQ_DOCS)
      expect(r.added).toEqual([])
      expect(typeof r.text).toBe('string')
    }
  })

  it('빈 코퍼스에서도 어휘 집합을 만들 수 있다', () => {
    expect(corpusVocabulary([]).size).toBe(0)
    expect(corpusVocabulary(null).size).toBe(0)
    expect(corpusVocabulary(FAQ_DOCS).has('위약금')).toBe(true)
  })

  it('제목·본문이 없는 문서가 섞여도 어휘 추출이 죽지 않는다', () => {
    expect(() => corpusVocabulary([{ id: 'x' }, ...FAQ_DOCS])).not.toThrow()
  })
})
