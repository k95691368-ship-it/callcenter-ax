// VOC 이상 감지 — 집계를 보여주는 것에서 "무엇이 달라졌는지 알려주는 것"으로.
//
// 대시보드에 막대와 꺾은선을 그려놓아도, 운영자가 매일 눈으로 비교하지 않으면
// 급증을 놓친다. 콜센터에서 중요한 건 "오늘 해지 문의가 평소보다 3배"처럼
// 임계를 넘은 변화이고, 그건 규칙으로 계산된다 — LLM도 API 키도 필요 없다.
//
// 표본이 작을 때 비율만 보면(1건 → 3건 = 200% 증가) 매일 경보가 뜬다. 그래서
// 최소 건수 조건과 비율 조건을 함께 걸고, 근거 수치를 항상 같이 돌려준다.

import { extractThemes, isRepeatCall } from './vocThemes.js'

// 최근 며칠을 "현재"로 볼 것인가
export const RECENT_DAYS = 1
// 이 건수 미만이면 비율이 커도 경보하지 않는다 (표본 부족)
export const MIN_ABSOLUTE = 3
// 평균 대비 이 배수를 넘으면 급증으로 본다
export const SPIKE_RATIO = 2

function byDate(calls) {
  const map = new Map()
  for (const c of calls || []) {
    const d = c?.date
    if (!d) continue
    if (!map.has(d)) map.set(d, [])
    map.get(d).push(c)
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

// 카테고리별 급증 — 최근 구간과 그 이전 구간의 일평균을 비교한다
export function detectCategorySpikes(calls, { recentDays = RECENT_DAYS } = {}) {
  const days = byDate(calls)
  if (days.length < recentDays + 2) return []

  const recent = days.slice(-recentDays)
  const past = days.slice(0, -recentDays)
  const pastDayCount = past.length

  const count = (list, cat) =>
    list.reduce((s, [, items]) => s + items.filter((c) => c?.analysis?.category === cat).length, 0)

  const categories = [...new Set((calls || []).map((c) => c?.analysis?.category).filter(Boolean))]
  const out = []

  for (const cat of categories) {
    const now = count(recent, cat)
    const baseline = count(past, cat) / pastDayCount
    if (now < MIN_ABSOLUTE) continue
    // 이전 구간에 아예 없었다면 비율을 낼 수 없다 — 절대 건수만으로 판단한다
    const ratio = baseline > 0 ? now / recentDays / baseline : Infinity
    if (ratio < SPIKE_RATIO) continue
    out.push({
      id: `spike-${cat}`,
      kind: 'category-spike',
      level: ratio >= 3 || baseline === 0 ? 'high' : 'warn',
      category: cat,
      now,
      baselinePerDay: Math.round(baseline * 10) / 10,
      ratio: baseline > 0 ? Math.round(ratio * 10) / 10 : null,
      label: `${cat} 문의 급증`,
      detail:
        baseline > 0
          ? `최근 ${recentDays}일 ${now}건 — 이전 일평균 ${Math.round(baseline * 10) / 10}건의 약 ${Math.round(ratio * 10) / 10}배입니다.`
          : `최근 ${recentDays}일 ${now}건 — 이전 구간에는 없던 유형입니다.`,
    })
  }
  return out.sort((a, b) => b.now - a.now)
}

// 강성 고객 비율·에스컬레이션 비율이 임계를 넘었는지
export function detectRatioAlerts(calls, { hotThreshold = 0.25, escalateThreshold = 0.3 } = {}) {
  const list = (calls || []).filter((c) => c?.analysis)
  if (list.length < 5) return []
  const hot = list.filter((c) => c.analysis.sentiment === '강성').length
  const esc = list.filter((c) => c.analysis.escalate).length
  const out = []
  if (hot / list.length >= hotThreshold) {
    out.push({
      id: 'hot-ratio',
      kind: 'ratio',
      level: 'high',
      label: '강성 민원 비율 경보',
      detail: `전체 ${list.length}건 중 강성 ${hot}건(${Math.round((hot / list.length) * 100)}%) — 임계 ${Math.round(hotThreshold * 100)}%를 넘었습니다.`,
    })
  }
  if (esc / list.length >= escalateThreshold) {
    out.push({
      id: 'escalate-ratio',
      kind: 'ratio',
      level: 'warn',
      label: '에스컬레이션 비율 경보',
      detail: `전체 ${list.length}건 중 ${esc}건(${Math.round((esc / list.length) * 100)}%)이 담당자 확인 대상입니다 — 1선 종결률 점검이 필요합니다.`,
    })
  }
  return out
}

// 원인 단위 급증.
//
// 카테고리 급증은 "불만이 늘었다"까지만 말한다. 그걸 받은 사람이 할 수 있는 일은 없다 —
// 불만 안에는 속도 저하·과다 청구·응대 미흡이 섞여 있고 넘길 부서가 다르기 때문이다.
// 원인 단위로 세면 경보가 "무엇이, 어디로"까지 간다.
export function detectThemeSpikes(calls, { recentDays = RECENT_DAYS } = {}) {
  const days = byDate(calls)
  if (days.length < recentDays + 2) return []

  const recent = days.slice(-recentDays)
  const past = days.slice(0, -recentDays)
  const pastDayCount = past.length

  // 통화마다 원인 추출을 한 번만 한다 (구간마다 다시 뽑으면 같은 일을 두 번 한다)
  const themesOf = new Map()
  const idsOf = (call) => {
    if (!themesOf.has(call)) themesOf.set(call, extractThemes(call))
    return themesOf.get(call)
  }
  const count = (list, id) =>
    list.reduce((s, [, items]) => s + items.filter((c) => idsOf(c).some((t) => t.id === id)).length, 0)

  const seen = new Map()
  for (const [, items] of days) for (const c of items) for (const t of idsOf(c)) seen.set(t.id, t)

  const out = []
  for (const [id, theme] of seen) {
    const now = count(recent, id)
    if (now < MIN_ABSOLUTE) continue
    const baseline = count(past, id) / pastDayCount
    const ratio = baseline > 0 ? now / recentDays / baseline : Infinity
    if (ratio < SPIKE_RATIO) continue
    out.push({
      id: `theme-${id}`,
      kind: 'theme-spike',
      level: ratio >= 3 || baseline === 0 ? 'high' : 'warn',
      theme: id,
      dept: theme.dept,
      now,
      baselinePerDay: Math.round(baseline * 10) / 10,
      ratio: baseline > 0 ? Math.round(ratio * 10) / 10 : null,
      label: `${theme.label} 급증 → ${theme.dept}`,
      detail:
        baseline > 0
          ? `최근 ${recentDays}일 ${now}건 — 이전 일평균 ${Math.round(baseline * 10) / 10}건의 약 ${Math.round(ratio * 10) / 10}배입니다. ${theme.dept}에 공유가 필요합니다.`
          : `최근 ${recentDays}일 ${now}건 — 이전 구간에는 없던 원인입니다. ${theme.dept}에 공유가 필요합니다.`,
    })
  }
  return out.sort((a, b) => b.now - a.now)
}

// 재문의 비율 — 응대 품질이 아니라 처리 완결성의 지표다.
// 같은 원인으로 다시 걸려오는 통화가 많다면 통화당 처리시간을 줄이는 것보다
// 그 원인을 없애는 편이 총 통화 수를 줄인다.
export function detectRepeatAlert(calls, { repeatThreshold = 0.15 } = {}) {
  const list = (calls || []).filter(Boolean)
  if (list.length < 5) return []
  const repeats = list.filter((c) => isRepeatCall(c))
  if (repeats.length / list.length < repeatThreshold) return []
  return [
    {
      id: 'repeat-ratio',
      kind: 'ratio',
      level: 'warn',
      label: '재문의 비율 경보',
      detail: `전체 ${list.length}건 중 ${repeats.length}건(${Math.round((repeats.length / list.length) * 100)}%)이 같은 문제로 다시 걸려온 통화입니다 — 1선 종결이 안 되고 있습니다.`,
    },
  ]
}

export function detectVocAnomalies(calls, opts = {}) {
  return [
    ...detectRatioAlerts(calls, opts),
    ...detectRepeatAlert(calls, opts),
    ...detectCategorySpikes(calls, opts),
    ...detectThemeSpikes(calls, opts),
  ]
}
