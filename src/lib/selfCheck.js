// 자가 점검 — 이 도구가 자기 사각지대를 스스로 아는 층.
//
// 왜 이걸 만드는가:
// 규칙 기반 시스템의 진짜 위험은 틀리는 것이 아니라 **모르는 채로 조용한 것**이다.
// 원인 사전에 없는 표현이 들어오면 그 통화는 '미분류'로 남는데, 지금은 건수만 보여준다.
// 담당자는 "무엇을 사전에 추가해야 하는가"를 직접 통화를 읽어가며 찾아야 한다.
// 그건 규칙이 할 수 있는 일이다 — 분류하지 못한 통화들에서 반복되는 말을 세면 된다.
//
// 즉 이 파일은 "분류기"가 아니라 **분류기의 결함을 찾는 층**이다.
// 시스템이 자기가 못 하는 것을 스스로 지목하고, 사람은 그 후보를 승인하기만 하면 된다.

import { THEMES, extractThemes, customerSpeech, isRepeatCall } from './vocThemes.js'
import { routeTicket, DEFAULT_ROUTE } from './ticketDraft.js'
import { maskPii } from './piiMask.js'

// 어느 도메인에나 흔해서 원인이 될 수 없는 말. 이걸 빼지 않으면 후보 1위가 늘 '그런데'다.
const STOPWORDS = new Set([
  '그런데', '그러면', '그리고', '그래서', '하지만', '그거', '이거', '저거', '뭐가', '어떻게',
  '있나요', '없나요', '인가요', '건가요', '거예요', '입니다', '합니다', '해주세요', '주세요',
  '알겠습니다', '감사합니다', '안녕하세요', '네네', '아니요', '괜찮아요', '지금', '오늘', '내일',
  '어제', '한번', '다시', '진짜', '정말', '조금', '많이', '아주', '너무', '제가', '저는', '고객',
  '상담사', '확인', '문의', '말씀', '전화', '통화', '부탁', '가능', '경우', '내용', '관련',
])

// 사전이 이미 아는 말 — 후보에서 뺀다 (이미 있는 걸 "추가하세요"라고 하면 신뢰를 잃는다)
function knownTerms() {
  const known = new Set()
  for (const t of THEMES) {
    for (const re of t.patterns) {
      // 정규식에서 한글 리터럴만 뽑아낸다 (메타문자·수량자는 버린다)
      for (const w of re.source.match(/[가-힣]{2,}/g) || []) known.add(w)
    }
  }
  return known
}

// 조사·어미를 대충 떼어 낸다. 형태소 분석기 없이도 "속도가/속도를/속도는"을 한 덩어리로 묶는 정도는 된다.
const PARTICLES = /(이랑|에서|에게|한테|까지|부터|으로|로서|로써|보다|처럼|만큼|이나|라도|이라도|은|는|이|가|을|를|의|에|와|과|도|만|로|랑)$/
function stem(word) {
  const w = word.replace(/[^가-힣a-zA-Z0-9]/g, '')
  if (w.length <= 2) return w
  return w.replace(PARTICLES, '') || w
}

function tokens(text) {
  return String(text || '')
    .split(/\s+/)
    .map(stem)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
}

// 분류하지 못한 통화들에서 반복되는 말을 세어 사전 후보를 만든다.
// 근거 문장을 함께 돌려준다 — 후보만 던지면 사람이 판단할 수 없다.
export function suggestThemeTerms(untaggedCalls, { minCount = 2, limit = 8 } = {}) {
  const known = knownTerms()
  const counter = new Map()

  for (const call of untaggedCalls || []) {
    const speech = customerSpeech(call?.transcript) || call?.title || ''
    const seen = new Set() // 한 통화 안에서 같은 말을 여러 번 해도 1건으로 센다
    for (const w of tokens(speech)) {
      if (seen.has(w) || known.has(w)) continue
      seen.add(w)
      if (!counter.has(w)) counter.set(w, { term: w, count: 0, examples: [] })
      const row = counter.get(w)
      row.count += 1
      const line = speech.split('\n').find((l) => l.includes(w))
      if (line && row.examples.length < 2) row.examples.push(line.trim().slice(0, 60))
    }
  }

  return [...counter.values()]
    .filter((r) => r.count >= minCount)
    .sort((a, b) => b.count - a.count || (a.term < b.term ? -1 : 1))
    .slice(0, limit)
}

// 전체 자가 점검 — "지금 이 데이터에서 내가 얼마나 못 하고 있는가"
export function selfCheck(calls) {
  const list = (calls || []).filter(Boolean)
  const total = list.length
  const untagged = []
  let routedDefault = 0
  let repeats = 0
  let piiFound = 0

  for (const call of list) {
    // 원인은 한 번만 뽑아 배정 판정에도 넘긴다 — 예전에는 routeTicket이 안에서 다시 뽑았다
    const themes = extractThemes(call)
    if (themes.length === 0) untagged.push(call)
    const route = routeTicket({ text: call.transcript || '', category: call.analysis?.category, themes })
    if (route.team === DEFAULT_ROUTE.team) routedDefault += 1
    if (isRepeatCall(call)) repeats += 1
    piiFound += maskPii(call.transcript || '').total
  }

  // 표본이 0이면 비율은 0%가 아니라 **계산할 수 없는 값**이다.
  // 0으로 채우면 통화가 한 건도 없는 구간을 '분류 정확도 0%'라고 보고하게 된다.
  const rate = (n) => (total ? n / total : null)
  const suggestions = suggestThemeTerms(untagged)

  const gaps = []
  if (rate(untagged.length) > 0.2) {
    gaps.push({
      id: 'gap-untagged',
      level: 'warn',
      label: `원인 사전이 놓친 통화 ${untagged.length}건`,
      detail: `전체의 ${Math.round(rate(untagged.length) * 100)}%가 어떤 원인에도 걸리지 않았습니다. 사전을 넓히지 않으면 이 통화들은 집계에서 사실상 보이지 않습니다.`,
    })
  }
  if (rate(routedDefault) > 0.3) {
    gaps.push({
      id: 'gap-default-route',
      level: 'warn',
      label: `담당 부서가 정해지지 않은 통화 ${routedDefault}건`,
      detail: `전체의 ${Math.round(rate(routedDefault) * 100)}%가 기본값(${DEFAULT_ROUTE.team})으로 갔습니다. 라우팅 규칙이 이 데이터를 충분히 덮지 못합니다.`,
    })
  }
  if (suggestions.length > 0) {
    gaps.push({
      id: 'gap-suggestions',
      level: 'ok',
      label: `사전에 추가할 후보 ${suggestions.length}개를 찾았습니다`,
      detail: `분류하지 못한 통화에서 ${suggestions.length}개 표현이 반복됩니다 — 승인하면 다음 집계부터 잡힙니다.`,
    })
  }
  // 표본이 0이면 "사각지대가 없다"가 아니라 **점검할 것이 없었다**이다.
  // 0건을 두고 '0건 모두 원인이 잡혔습니다'라고 적으면 하지 않은 점검을 통과라고 말하는 것이다.
  if (total === 0) {
    gaps.push({
      id: 'gap-empty',
      level: 'ok',
      label: '이 구간에는 점검할 통화가 없습니다',
      detail: '통화가 한 건도 없어 사각지대를 판정하지 않았습니다 — 사각지대가 없다는 뜻이 아닙니다.',
    })
  } else if (gaps.length === 0) {
    // 경고 임계(미분류 20% · 기본배정 30%)를 넘지 않았다고 "모두 잡혔다"고 말하면 거짓이다.
    // 12건 중 1건이 미분류면 8%라 경고는 안 뜨는데 같은 카드의 타일은 92%라고 적혀 있다 —
    // 한 화면이 스스로 모순되는 두 말을 하게 된다. 남은 것이 있으면 몇 건인지 말한다.
    const leftovers = []
    if (untagged.length > 0) leftovers.push(`원인이 잡히지 않은 통화 ${untagged.length}건`)
    if (routedDefault > 0) leftovers.push(`담당 부서가 기본값으로 간 통화 ${routedDefault}건`)
    gaps.push(
      leftovers.length > 0
        ? {
            id: 'gap-minor',
            level: 'ok',
            label: '경고 임계를 넘지는 않았습니다',
            detail: `${leftovers.join(', ')}이 남아 있지만 비율이 경고 기준 아래입니다 — 늘어나면 여기에 경고로 올라옵니다.`,
          }
        : {
            id: 'gap-none',
            level: 'ok',
            label: '지금 데이터에서는 사각지대가 발견되지 않았습니다',
            detail: `${total}건 모두 원인이 잡혔고 담당 부서가 정해졌습니다. 새 유형의 문의가 들어오면 여기에 나타납니다.`,
          }
    )
  }

  return {
    total,
    taggedRate: rate(total - untagged.length),
    untaggedCount: untagged.length,
    untagged,
    routedDefault,
    defaultRouteRate: rate(routedDefault),
    repeatRate: rate(repeats),
    piiFound,
    suggestions,
    gaps,
  }
}
