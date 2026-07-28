// STT 도메인 용어 보정 — 공고의 "오픈소스 STT 모델의 도메인 튜닝" 1단계 구현.
// Whisper가 자주 틀리는 콜센터·브랜드 용어를 규칙 사전으로 후보정한다.
// (실측 근거: whisper base가 "한빛텔레콤"을 "한 밑에 내 콤"으로 전사)
// 모델 재학습 없이 서비스 레벨에서 적용 가능한 경량 도메인 최적화이며,
// 보정 전/후 CER을 비교해 개선 폭을 정량으로 보여준다.

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
