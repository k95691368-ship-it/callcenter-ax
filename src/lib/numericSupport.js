// 수치 근거 검증 — 답변에 나온 금액·기간·비율이 근거 문서에 실제로 있는가.
//
// 왜 근거율만으로는 부족한가:
// groundedness는 문자 2-gram 겹침이다. 그래서 "월 4만 4천 원"과 "월 9만 9천 원"은
// 거의 같은 점수를 받는다 — 숫자 하나만 바뀐 문장을 구분하지 못한다.
// 그런데 콜센터에서 틀리면 가장 비싼 것이 바로 그 숫자다. 위약금 액수, 요금제 가격,
// 처리 기한을 잘못 안내하면 그 자체로 분쟁이 된다.
// 문장이 "문서를 읽고 쓴 것처럼 보이는가"(근거율)와 "그 숫자가 문서에 있는가"(여기)는
// 다른 질문이고, 뒤쪽은 규칙으로 정확히 답할 수 있다.
//
// 설계 원칙:
// 1) 질문에 있던 숫자는 통과시킨다. 고객이 "12만 원이 나왔어요"라고 물으면 답변이 그
//    숫자를 되받는 것은 환각이 아니다.
// 2) 한국어 수사를 값으로 정규화한다. 문서는 '4만 4천 원', 답변은 '44,000원'으로 쓸 수 있다.
//    표기가 달라도 같은 값이면 근거가 있는 것이다.
// 3) 못 찾은 숫자는 그 자리를 그대로 돌려준다. "수치 검증 실패"만 말하면 어느 숫자가
//    문제인지 알 수 없어 사람이 확인할 수 없다.

const UNIT_MULTIPLIER = { 억: 100_000_000, 만: 10_000, 천: 1_000, 백: 100, 십: 10 }

// '4만 4천' → 44000, '100억' → 10000000000, '12' → 12
export function parseKoreanNumber(raw) {
  const text = String(raw || '').replace(/[\s,]/g, '')
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)

  let total = 0
  let matched = false
  const re = /(\d+(?:\.\d+)?)(억|만|천|백|십)?/g
  let m
  while ((m = re.exec(text))) {
    const value = Number(m[1])
    if (!Number.isFinite(value)) continue
    matched = true
    total += value * (UNIT_MULTIPLIER[m[2]] || 1)
  }
  return matched ? total : null
}

// 검증 대상 단위. 틀리면 분쟁이 되는 것(돈·기간·비율)과 그 밖(회선 수 등)을 나눈다.
const CRITICAL_UNITS = ['원', '%', '퍼센트', '개월', '년', '일', '시간']
const OTHER_UNITS = ['회선', '회', '건', '기가', 'gb', '명', '분']
const ALL_UNITS = [...CRITICAL_UNITS, ...OTHER_UNITS]

// 숫자 + 단위 표현을 뽑는다. 한국어 수사(만/천)가 섞인 형태까지 한 덩어리로 잡는다.
const CLAIM_RE = new RegExp(
  `((?:\\d[\\d,\\.]*\\s*(?:억|만|천|백|십)?\\s*){1,4})(${ALL_UNITS.join('|')})`,
  'gi'
)

export function extractNumericClaims(text) {
  const out = []
  const src = String(text || '')
  let m
  CLAIM_RE.lastIndex = 0
  while ((m = CLAIM_RE.exec(src))) {
    const value = parseKoreanNumber(m[1])
    if (value == null) continue
    const unit = m[2].toLowerCase()
    out.push({
      text: m[0].trim(),
      value,
      unit: unit === '퍼센트' ? '%' : unit === 'gb' ? '기가' : unit,
      critical: CRITICAL_UNITS.includes(unit) || unit === '퍼센트',
    })
  }
  return out
}

const keyOf = (c) => `${c.unit}:${c.value}`

// 반환: { ok, checked, supported, unsupported: [{text, value, unit, critical}] }
//
// question: 질문에 있던 숫자는 근거로 인정한다(고객이 말한 금액을 되받는 것은 환각이 아니다).
export function numericSupport(answer, docsText, question = '') {
  const claims = extractNumericClaims(answer)
  if (claims.length === 0) return { ok: true, checked: 0, supported: 0, unsupported: [] }

  const known = new Set([...extractNumericClaims(docsText), ...extractNumericClaims(question)].map(keyOf))
  // 단위 없이 적힌 숫자도 문서에 있으면 근거로 본다 ('4만 4천 원' 문서 ↔ '44000' 답변)
  const bareNumbers = new Set(
    (String(docsText || '') + ' ' + String(question || ''))
      .match(/\d[\d,]*(?:\s*(?:억|만|천|백|십))?/g)
      ?.map((s) => parseKoreanNumber(s))
      .filter((n) => n != null) || []
  )

  const unsupported = claims.filter((c) => !known.has(keyOf(c)) && !bareNumbers.has(c.value))
  return {
    ok: unsupported.every((c) => !c.critical),
    checked: claims.length,
    supported: claims.length - unsupported.length,
    unsupported,
  }
}

// 화면·안내에 쓸 한 줄 (문제가 없으면 null)
export function numericNotice(result) {
  const bad = result?.unsupported?.filter((c) => c.critical) || []
  if (bad.length === 0) return null
  return `답변에 근거 문서에서 확인되지 않는 수치가 있습니다: ${bad
    .map((c) => c.text)
    .join(', ')}. 금액·기간은 반드시 원문에서 확인한 뒤 안내하세요.`
}
