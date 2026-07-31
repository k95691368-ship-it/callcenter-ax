// STT 도메인 용어 보정 — 공고의 "오픈소스 STT 모델의 도메인 튜닝" 1단계 구현.
// Whisper가 자주 틀리는 콜센터·브랜드 용어를 규칙 사전으로 후보정한다.
// (실측 근거: whisper base가 "한빛텔레콤"을 "한 밑에 내 콤"으로 전사)
// 모델 재학습 없이 서비스 레벨에서 적용 가능한 경량 도메인 최적화이며,
// 보정 전/후 CER을 비교해 개선 폭을 정량으로 보여준다.

// 사전 항목은 "Whisper가 실제로 이렇게 틀린다"를 근거로 넣는다. 짐작으로 넣은 규칙은
// 정상 발화를 망가뜨릴 수 있으므로, 콜센터에서 반복적으로 등장하는 고유명사·업무 용어와
// 한국어 STT가 자주 붙이거나 떼는 띄어쓰기 패턴에 한정한다.
export const LEXICON = [
  {
    term: '한빛텔레콤',
    patterns: [/한비\s*텔레콤/g, /한빛\s+텔레콤/g, /한\s*밑에?\s*내\s*콤/g, /한빛\s*텔레컴/g, /한빛\s*텔레컨/g],
  },
  { term: '위약금', patterns: [/위\s+약금/g, /위악금/g, /이약금/g] },
  { term: '소액결제', patterns: [/소액\s+결제/g, /소약\s*결제/g] },
  { term: '요금제', patterns: [/요금\s+제(?=[가-힣]?\s|$)/g] },
  { term: '명의 변경', patterns: [/명이\s*변경/g, /명의변경/g] },
  { term: '해지', patterns: [/헤지/g] },
  { term: '에스컬레이션', patterns: [/에스칼레이션/g, /이스컬레이션/g] },
  // 여기부터는 상담 중 금액·절차 안내에서 잘못 전사되면 그대로 오안내가 되는 용어들이다.
  { term: '약정', patterns: [/약전(?=\s|기간|이|을|은)/g, /야꿍/g] },
  { term: '할인반환금', patterns: [/할인\s+반환금/g, /할인반한금/g, /할인\s*반한금/g] },
  { term: '결합할인', patterns: [/결합\s+할인/g, /겹합\s*할인/g] },
  { term: '자동이체', patterns: [/자동\s+이체/g, /자동이채/g] },
  { term: '청구서', patterns: [/청구\s+서(?=[가-힣]?\s|$)/g, /청꾸서/g] },
  // '미납금액'은 오전사가 아니라 정상 복합어다. 표제어로 치환하면 '금액' 두 글자가
  // 사라져 "미납금액이 얼마인가요" → "미납이 얼마인가요"가 됐다(실측). 띄어쓰기만 본다.
  { term: '미납', patterns: [/미\s+납(?=\s|금|액)/g] },
  { term: '번호이동', patterns: [/번호\s+이동/g, /번호이돔/g] },
  { term: '개통', patterns: [/게통/g, /개퉁/g] },
  { term: '기가인터넷', patterns: [/기가\s+인터넷/g, /기가인터냇/g] },
  { term: '셋톱박스', patterns: [/셋탑\s*박스/g, /샛톱\s*박스/g, /셋톱\s+박스/g] },
  { term: '로밍', patterns: [/노밍/g, /로망(?=\s*(요금|서비스|해지|신청))/g] },
  { term: '소비자원', patterns: [/소비자\s+원(?=\s|에|이)/g, /소비자언/g] },
  { term: '방송통신위원회', patterns: [/방통위/g, /방송통신\s+위원회/g] },
  // '본인 확인'(띄어쓰기)은 표준 표기이고 이 앱 자신이 권장 스크립트에서 그렇게 쓴다
  // (qaRules.js의 example). 그걸 붙여쓰기로 바꾸면서 "전사 오류를 후보정했습니다"라고
  // 표시해, 내장 샘플 10건 중 9건이 오류가 있는 것처럼 보였다. 진짜 오전사만 남긴다.
  { term: '본인확인', patterns: [/보닌\s*확인/g] },
  { term: '접수번호', patterns: [/접수\s+번호/g] },
]

export const MAX_CUSTOM_TERMS = 3

// 사용자 입력(오전사→정정 쌍)을 검증해 커스텀 사전 항목으로 만든다.
// 정규식이 아닌 리터럴 문자열 매칭이라 사용자가 특수문자를 넣어도 안전하다.
export function buildCustomLexicon(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw.slice(0, MAX_CUSTOM_TERMS)) {
    const wrong = typeof r?.wrong === 'string' ? r.wrong.trim().slice(0, 30) : ''
    const term = typeof r?.term === 'string' ? r.term.trim().slice(0, 30) : ''
    if (!wrong || !term || wrong === term) continue
    out.push({ term, literals: [wrong], custom: true })
  }
  return out
}

// 전사 텍스트에 사전을 적용한다. 반환: { text, applied: [{term, count}] }
// extra(커스텀 사전)를 주면 내장 사전 뒤에 이어서 적용한다.
export function applyLexicon(text, extra = []) {
  let out = text || ''
  const applied = []
  for (const entry of [...LEXICON, ...extra]) {
    let count = 0
    for (const pattern of entry.patterns || []) {
      out = out.replace(pattern, () => {
        count += 1
        return entry.term
      })
    }
    for (const lit of entry.literals || []) {
      const parts = out.split(lit)
      if (parts.length > 1) {
        count += parts.length - 1
        out = parts.join(entry.term)
      }
    }
    if (count > 0) applied.push({ term: entry.term, count, ...(entry.custom ? { custom: true } : {}) })
  }
  return { text: out, applied }
}
