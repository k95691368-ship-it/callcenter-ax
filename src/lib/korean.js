// 한국어 검색용 경량 토크나이저 — 형태소 분석기 없이 조사·어미만 떼어 낸다.
//
// 왜 필요한가:
// 기존 랭커는 어절을 그대로 문자열 포함 검사했다. 그래서 "인터넷이 너무 느린데요"는
// 문서에 '인터넷'이 있어도 0점이었다 — '인터넷이'가 통째로 들어 있어야 했기 때문이다.
// 실제 상담사는 구어체로 검색한다. 조사 하나 때문에 근거 문서를 못 찾으면
// 그 뒤의 근거율 검증·인용은 아무 의미가 없다(못 찾은 문서는 근거가 될 수 없다).
//
// 형태소 분석기를 넣지 않는 이유:
// 브라우저와 Workers 양쪽에서 도는 코드이고, 사전 용량이 번들을 크게 늘린다.
// 콜센터 도메인은 어휘가 좁아서 조사·종결어미만 떼어도 대부분 맞는다.
// 대신 과하게 자르지 않도록 **2글자 이상이 남을 때만** 자른다.

// 조사 (긴 것부터 — '에서'를 '에'로 먼저 자르면 '서'가 남는다)
const PARTICLES = [
  '으로서', '으로써', '이라도', '에게서', '한테서',
  '에서', '에게', '한테', '까지', '부터', '으로', '보다', '처럼', '만큼', '이나', '라도', '이라',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '랑',
]

// 종결·연결 어미 (구어체 질의에서 실제로 자주 붙는 것들)
const ENDINGS = [
  '인데요', '한데요', '거든요', '나요', '까요', '가요', '데요', '어요', '아요', '해요', '예요',
  '이에요', '네요', '지요', '군요', '려면', '하려고', '되나요', '됩니까', '습니까', '입니까',
  '합니다', '습니다', '입니다', '했어요', '해주세요', '주세요', '싶어요', '있어요', '없어요',
]

function stripSuffixes(word, list) {
  for (const suffix of list) {
    if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length)
    }
  }
  return word
}

// 한 어절의 어간을 대충 뽑는다. 2글자 미만이 되면 자르지 않는다.
export function stemWord(raw) {
  let w = String(raw || '')
    .toLowerCase()
    .replace(/[^가-힣a-z0-9]/g, '')
  if (w.length <= 2) return w
  w = stripSuffixes(w, ENDINGS)
  w = stripSuffixes(w, PARTICLES)
  return w
}

export function tokenize(text) {
  return String(text || '')
    .split(/[^가-힣a-zA-Z0-9]+/)
    .map(stemWord)
    .filter((t) => t.length >= 2)
}

// 도메인 동의어 — 고객·상담사가 같은 것을 다른 말로 부른다.
// 이 사전이 없으면 "해지수수료"로 검색한 사람은 위약금 문서를 못 찾는다.
// (STT 후보정 사전과 목적이 다르다: 저쪽은 잘못 들린 말을 고치고, 이쪽은 다르게 부르는 말을 잇는다)
export const SYNONYMS = [
  { canon: '위약금', words: ['해지수수료', '해지비용', '할인반환금', '해약금', '위약'] },
  { canon: '속도', words: ['느림', '느려', '느린', '끊김', '끊겨', '버벅', '지연'] },
  { canon: '소액결제', words: ['콘텐츠이용료', '휴대폰결제', '게임결제'] },
  { canon: '셋톱박스', words: ['셋탑박스', '셋톱', '셋탑'] },
  { canon: '명의', words: ['명의이전', '명의변경', '양도'] },
  { canon: '로밍', words: ['해외데이터', '해외요금', '해외로밍'] },
  { canon: '결합', words: ['가족결합', '묶음', '패밀리'] },
  { canon: '요금제', words: ['플랜', '상품제'] },
  { canon: '이전설치', words: ['이사', '이전', '전출'] },
  { canon: '환불', words: ['취소', '반환'] },
]

const SYNONYM_INDEX = (() => {
  const map = new Map()
  for (const entry of SYNONYMS) {
    for (const w of entry.words) map.set(w, entry.canon)
    map.set(entry.canon, entry.canon)
  }
  return map
})()

// 질의를 확장한다 — 원래 토큰은 유지하고 표준어를 덧붙인다(치환이 아니라 추가).
// 치환해 버리면 원문에만 있는 표현으로 맞출 기회를 잃는다.
export function expandQuery(question) {
  const base = tokenize(question)
  const out = new Set(base)
  for (const t of base) {
    const canon = SYNONYM_INDEX.get(t)
    if (canon) out.add(canon)
    // 부분 일치도 본다 — '해지수수료가'가 '해지수수료'로 어간 처리되지 않는 경우 대비
    for (const [word, c] of SYNONYM_INDEX) {
      if (word.length >= 3 && t.includes(word)) out.add(c)
    }
  }
  return [...out]
}

// 문자 2-gram — 어절 매치가 하나도 없을 때의 마지막 수단.
// 오탈자("셋톱박수")나 띄어쓰기가 다른 질의를 완전 0점으로 두지 않기 위한 것이다.
export function bigrams(text) {
  const flat = String(text || '')
    .toLowerCase()
    .replace(/[^가-힣a-z0-9]/g, '')
  const out = []
  for (let i = 0; i < flat.length - 1; i++) out.push(flat.slice(i, i + 2))
  return out
}
