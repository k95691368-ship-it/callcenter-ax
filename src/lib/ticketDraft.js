// 에스컬레이션 티켓 초안 — 분석 결과를 "다음 사람이 바로 쓸 수 있는 문서"로 만든다.
//
// 통화를 분석해 "에스컬레이션 필요"라고 표시하는 것까지는 쉽다. 실무에서 막히는 건
// 그 다음이다 — 어느 부서로, 무슨 제목으로, 어떤 근거를 붙여 넘기는가.
// 그 조립을 규칙으로 처리하면 LLM 호출 없이도(=키 없이도) 동작하고, 부서 라우팅
// 기준이 코드에 남아 검토·수정이 가능하다. LLM이 붙으면 요약 문장만 더 좋아진다.

import { customerText } from './callMetrics.js'
import { extractThemes } from './vocThemes.js'
import { routeOf } from './teams.js'

// 부서 라우팅 규칙 — 위에서부터 먼저 맞는 것을 쓴다(구체적인 것이 위).
// 실제 조직도는 회사마다 다르므로 이름은 일반적인 콜센터 조직 기준으로 두었다.
// 원인과 무관하게 먼저 가야 하는 곳 — 에스컬레이션 우선 규칙.
// 소송을 언급한 통화는 문의 주제가 무엇이든 법무가 먼저 본다.
export const OVERRIDE_RULES = [
  {
    id: 'legal',
    team: 'legal',
    reason: '법적 조치·외부 기관 제보가 언급된 건',
    match: ({ text }) => /(소송|고소|법적|방통위|소비자원|언론|제보|변호사)/.test(text),
  },
  {
    id: 'retention',
    team: 'retention',
    reason: '해지 의사와 타사 이동 신호가 함께 확인된 건',
    match: ({ text, churnScore }) =>
      churnScore >= 70 || (/해지/.test(text) && /(타사|번호\s*이동|다른\s*통신사)/.test(text)),
  },
]

// 원인 사전에도 걸리지 않았을 때 쓰는 잔여 규칙 (카테고리·표현 기반)
export const ROUTING_RULES = [
  {
    id: 'billing',
    team: 'billing',
    reason: '청구·과금 이의 확인이 필요한 건',
    match: ({ text, category }) =>
      category === '요금' || /(과금|이중\s*청구|잘못\s*청구|요금\s*이의)/.test(text),
  },
  {
    id: 'network',
    team: 'network',
    reason: '반복 장애·품질 저하가 확인된 건',
    match: ({ text }) => /(느려|끊기|끊김|안\s*터지|장애|불통|속도)/.test(text),
  },
  {
    id: 'install',
    team: 'install',
    reason: '설치·이전 가능 여부 조회가 필요한 건',
    match: ({ text }) => /(이전\s*설치|설치\s*가능|이사|철거|재설치)/.test(text),
  },
  {
    id: 'compensation',
    team: 'compensation',
    reason: '보상·감면 심의가 필요한 건',
    match: ({ text }) => /(보상|배상|감면|환불)/.test(text),
  },
]

export const DEFAULT_ROUTE = routeOf('general', '1선에서 종결하지 못한 일반 문의')

// 배정은 **고객이 요구한 것**으로 정한다.
//
// 1) 에스컬레이션 우선 규칙 (소송 언급·해지 이탈) — 주제와 무관하게 먼저 간다
// 2) 고객이 말한 원인의 담당 부서 — VOC 대시보드가 세는 것과 같은 표(teams.js)를 쓴다.
//    예전에는 이 단계가 없어, 소액결제 차단 요청이 '환불' 한 단어에 걸려 보상 심의팀으로
//    갔다. 대시보드는 같은 통화를 부가서비스팀으로 세고 있었다 — 두 화면이 서로 다른 답.
// 3) 원인 사전에도 안 걸리면 잔여 규칙, 그래도 없으면 고객지원 2선.
//
// 전사 전체가 아니라 고객 발화만 본다. 상담사는 거의 모든 통화에서 환불·설치·위약금
// 절차를 안내하므로, 그 발화까지 세면 배정이 상담사의 안내 문구에 끌려간다.
// 화자 라벨이 없는 전사에서는 전체를 그대로 쓴다(customerText가 그렇게 폴백한다).
export function routeTicket({ text = '', category = '', churnScore = 0 } = {}) {
  const ctx = { text: customerText(text).text, category, churnScore: Number(churnScore) || 0 }

  const override = OVERRIDE_RULES.find((r) => r.match(ctx))
  if (override) return routeOf(override.team, override.reason)

  const [theme] = extractThemes({ transcript: text })
  if (theme) return routeOf(theme.team, `${theme.label} — 고객이 요구한 내용 기준`)

  const rule = ROUTING_RULES.find((r) => r.match(ctx))
  if (rule) return routeOf(rule.team, rule.reason)

  return DEFAULT_ROUTE
}

// 제목은 검색·정렬에 쓰이므로 형식을 고정한다: [유형] 핵심 요구 (감정)
export function ticketTitle({ category = '기타', sentiment = '중립', summary = [], intentKeywords = [] } = {}) {
  // 유형과 같은 키워드는 제목에 쓰지 않는다 — "[해지] 해지"는 아무것도 알려주지 않는다.
  const keywords = (Array.isArray(intentKeywords) ? intentKeywords : [])
    .map((k) => String(k || '').trim())
    .filter((k) => k && k !== category)
  const core = keywords[0] || (Array.isArray(summary) && summary[0]) || '내용 확인 필요'
  const trimmed = String(core).replace(/\s+/g, ' ').trim().slice(0, 40)
  return `[${category}] ${trimmed}${sentiment === '강성' ? ' (강성)' : ''}`
}

// 티켓 본문 — 근거 없는 문장을 넣지 않는다. 분석에 없는 값은 줄 자체를 뺀다.
export function buildTicketDraft({
  transcript = '',
  category = '기타',
  sentiment = '중립',
  summary = [],
  intentKeywords = [],
  actions = [],
  escalateReason = null,
  churn = null,
} = {}) {
  const churnScore = churn?.score ?? 0
  const route = routeTicket({ text: transcript, category, churnScore })
  const title = ticketTitle({ category, sentiment, summary, intentKeywords })

  const lines = [
    `제목: ${title}`,
    `담당: ${route.team} · 우선순위 ${route.priority} · ${route.sla}`,
    `배정 근거: ${route.reason}`,
    '',
    `문의 유형: ${category} / 고객 감정: ${sentiment}`,
  ]

  if (churn && Number.isFinite(churn.score)) {
    lines.push(
      `이탈 위험: ${churn.score}점 (${churn.level})${churn.estimated ? ' · 규칙 기반 추정' : ''}` +
        `${churn.adjusted ? ' · 규칙 신호로 보정됨' : ''}`
    )
    if (churn.signals?.length) {
      lines.push(`위험 신호: ${churn.signals.map((s) => s.label).join(', ')}`)
    }
  }

  if (Array.isArray(summary) && summary.length) {
    lines.push('', '통화 요약')
    summary.slice(0, 3).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }

  if (escalateReason) lines.push('', `에스컬레이션 사유: ${escalateReason}`)

  if (Array.isArray(actions) && actions.length) {
    lines.push('', '요청 조치')
    actions.slice(0, 4).forEach((a) => lines.push(`  - ${a}`))
  }

  // 인용 근거 — 담당자가 원문을 다시 듣지 않아도 판단할 수 있게 위험 신호 발화를 붙인다.
  const quotes = (churn?.signals || []).map((s) => s.evidence).filter(Boolean).slice(0, 3)
  if (quotes.length) {
    lines.push('', '근거 발화 (전사 인용)')
    quotes.forEach((q) => lines.push(`  "${q}"`))
  }

  lines.push('', '※ 이 초안은 통화 분석 결과로 자동 조립된 것이며, 감면·보상 여부는 담당자가 판단합니다.')

  return { title, route, text: lines.join('\n') }
}
