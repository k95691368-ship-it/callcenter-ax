// 검색 자가 평가 — 이 도구가 자기 검색 품질을 스스로 잰다.
//
// 왜 필요한가:
// 랭커를 바꿀 때 "더 나아진 것 같다"는 느낌으로 판단하면, 어떤 질의는 좋아지고 어떤 질의는
// 조용히 나빠진 채로 배포된다. 그리고 RAG에서 검색은 바닥이다 — **못 찾은 문서는 근거가
// 될 수 없으므로**, 근거율 검증을 아무리 정교하게 만들어도 검색이 틀리면 소용이 없다.
//
// 골든셋은 실제 상담사가 칠 법한 말로 적는다. 문어체로만 적으면 평가가 쉬워지고,
// 정작 현장에서 쓰는 구어체·오탈자·동의어에서 무너지는 것을 못 잡는다.
// expected: null 은 "이 질의에는 답하지 말아야 한다"는 뜻이다 —
// 무관한 질문에 자신 있게 답하는 것도 실패로 센다.

import { FAQ_DOCS, bm25Rank, assessRetrieval } from './faqDocs.js'

export const GOLDEN_SET = [
  // 구어체 — 실제로 이렇게 검색한다
  { q: '인터넷이 너무 느린데요', expected: 'faq06', kind: '구어체' },
  { q: '자꾸 끊겨요 어떻게 하나요', expected: 'faq06', kind: '구어체' },
  { q: '해지하면 돈 내야 하나요', expected: 'faq02', kind: '구어체' },
  { q: '요금제 바꾸고 싶어요', expected: 'faq01', kind: '구어체' },
  { q: '아이가 게임 결제를 자꾸 해요', expected: 'faq05', kind: '구어체' },
  { q: '해외 나갔다 왔는데 요금이 많이 나왔어요', expected: 'faq04', kind: '구어체' },
  { q: '아버지 폰을 제 앞으로 돌리려면', expected: 'faq07', kind: '구어체' },

  // 동의어 — 고객과 문서가 같은 것을 다르게 부른다
  { q: '해지수수료가 얼마인가요', expected: 'faq02', kind: '동의어' },
  { q: '할인반환금 계산 방법', expected: 'faq02', kind: '동의어' },
  { q: '콘텐츠이용료 막고 싶어요', expected: 'faq05', kind: '동의어' },
  { q: '이사 가는데 인터넷 어떻게 하나요', expected: 'faq02', kind: '동의어' },
  { q: '가족끼리 묶으면 얼마 할인되나요', expected: 'faq03', kind: '동의어' },

  // 문어체 — 기존 랭커도 맞히던 기준선
  { q: '요금제 변경 규정', expected: 'faq01', kind: '문어체' },
  { q: '결합 할인 회선 수', expected: 'faq03', kind: '문어체' },
  { q: '로밍 요금 이의 제기 절차', expected: 'faq04', kind: '문어체' },
  { q: '속도 저하 점검 절차', expected: 'faq06', kind: '문어체' },
  { q: '명의 변경 필요 서류', expected: 'faq07', kind: '문어체' },
  { q: '필수 안내 멘트 기준', expected: 'faq08', kind: '문어체' },

  // 무관 — 답하지 말아야 한다
  { q: '점심 메뉴 추천해줘', expected: null, kind: '무관' },
  { q: '오늘 서울 날씨 어때', expected: null, kind: '무관' },
  { q: '주식 종목 하나만 알려줘', expected: null, kind: '무관' },
]

// 홀드아웃 — 랭커를 만들 때 **보지 않은** 질의로 다시 잰다.
//
// 왜 두 벌인가: 위 골든셋은 랭커를 고치면서 계속 돌려본 셋이다. 그렇게 하면 셋에 맞춰
// 조정하게 되고(의도하지 않아도), 그 점수는 실제 성능보다 낙관적이 된다.
// 실제로 이 두 셋의 점수는 크게 다르다 — 골든셋 recall@1 0.944 대 홀드아웃 0.571.
// 두 수치를 함께 두는 이유는, 하나만 보면 시스템이 자기 실력을 실제보다 높게 알기 때문이다.
// **밖에 내보이는 숫자는 홀드아웃 쪽이어야 한다.**
export const HOLDOUT_SET = [
  { q: '와이파이가 자꾸 뚝뚝 끊기는데 점검 좀요', expected: 'faq06', kind: '구어체' },
  { q: '데이터 많이 쓰는데 더 싼 상품 없나요', expected: 'faq01', kind: '구어체' },
  { q: '약정 남았는데 중간에 그만두면 얼마 물어야 돼요', expected: 'faq02', kind: '구어체' },
  { q: '애가 모바일로 아이템 산 거 취소되나요', expected: 'faq05', kind: '구어체' },
  { q: '일본 여행 다녀왔는데 청구서가 이상해요', expected: 'faq04', kind: '구어체' },
  { q: '와이프랑 같이 쓰면 싸진다던데', expected: 'faq03', kind: '구어체' },
  { q: '상담원이 처음에 뭐라고 말해야 하죠', expected: 'faq08', kind: '구어체' },
  { q: '중도해지 비용 문의', expected: 'faq02', kind: '동의어' },
  { q: '인터넷 품질 불량 신고', expected: 'faq06', kind: '동의어' },
  { q: '통신사 명의자 바꾸기', expected: 'faq07', kind: '동의어' },
  { q: '패밀리 결합 조건', expected: 'faq03', kind: '동의어' },
  { q: '소액결제 한도 차단 요청', expected: 'faq05', kind: '동의어' },
  { q: '요금제 하향 변경 시 적용 시점', expected: 'faq01', kind: '문어체' },
  { q: '로밍 요금 과금 이의 신청', expected: 'faq04', kind: '문어체' },
  { q: '내일 코스피 오를까요', expected: null, kind: '무관' },
  { q: '근처 맛집 알려줘', expected: null, kind: '무관' },
  { q: '아이폰 신제품 출시일', expected: null, kind: '무관' },
]

// 랭커 하나를 골든셋으로 평가한다.
// rank: (question, docs) => [{id, score}, ...]
export function evaluate(rank, { docs = FAQ_DOCS, set = GOLDEN_SET } = {}) {
  let hit1 = 0
  let hit3 = 0
  let rrSum = 0
  let answerable = 0
  let irrelevant = 0
  let abstained = 0
  const fails = []

  for (const item of set) {
    const ranked = rank(item.q, docs)
    const ids = ranked.map((r) => r.id)

    if (item.expected === null) {
      irrelevant += 1
      // 무관 질의는 "근거 없음"으로 물러나야 맞다
      const level = assessRetrieval(ranked).level
      if (level === 'none') abstained += 1
      else fails.push({ q: item.q, kind: item.kind, why: `무관한 질의에 ${level} 판정 (1위 ${ids[0]})` })
      continue
    }

    answerable += 1
    const at = ids.indexOf(item.expected)
    if (at === 0) hit1 += 1
    if (at >= 0 && at < 3) hit3 += 1
    if (at >= 0) rrSum += 1 / (at + 1)
    if (at !== 0) {
      fails.push({
        q: item.q,
        kind: item.kind,
        why: at < 0 ? `정답 문서를 아예 못 찾음 (기대 ${item.expected})` : `${at + 1}위 (기대 ${item.expected}, 1위는 ${ids[0]})`,
      })
    }
  }

  const div = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0)
  return {
    total: set.length,
    answerable,
    recall1: div(hit1, answerable),
    recall3: div(hit3, answerable),
    mrr: div(rrSum, answerable),
    abstainAccuracy: div(abstained, irrelevant),
    fails,
  }
}

// 두 랭커를 나란히 재서 개선폭을 숫자로 남긴다 (느낌으로 판단하지 않기 위해서)
export function compareRankers(baseline, candidate, opts = {}) {
  const before = evaluate(baseline, opts)
  const after = evaluate(candidate, opts)
  const delta = (k) => Math.round((after[k] - before[k]) * 1000) / 1000
  return {
    before,
    after,
    delta: {
      recall1: delta('recall1'),
      recall3: delta('recall3'),
      mrr: delta('mrr'),
      abstainAccuracy: delta('abstainAccuracy'),
    },
    // 예전에는 맞았는데 지금 틀린 질의 — 개선이 아니라 교환일 수 있다
    regressions: after.fails.filter((f) => !before.fails.some((b) => b.q === f.q)),
  }
}

// 현재 운영 랭커의 성적 (화면에 그대로 보여줄 수 있게)
export function currentScore(opts = {}) {
  return evaluate(bm25Rank, opts)
}

// 튜닝에 참조한 셋과 참조하지 않은 셋을 나눠 잰다.
// 둘의 격차(gap)가 곧 "내가 내 실력을 얼마나 과대평가하고 있는가"다.
export function selfAssessment(rank = bm25Rank, { docs = FAQ_DOCS } = {}) {
  const tuned = evaluate(rank, { docs, set: GOLDEN_SET })
  const holdout = evaluate(rank, { docs, set: HOLDOUT_SET })
  const gap = (k) => Math.round((tuned[k] - holdout[k]) * 1000) / 1000
  return {
    tuned,
    holdout,
    // 밖에 말할 때 쓰는 수치 — 낙관적인 쪽이 아니라 보지 않은 쪽
    reportable: { recall1: holdout.recall1, recall3: holdout.recall3, mrr: holdout.mrr },
    optimismGap: { recall1: gap('recall1'), recall3: gap('recall3'), mrr: gap('mrr') },
  }
}
