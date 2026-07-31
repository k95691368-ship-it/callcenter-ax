// VOC 이상 감지 — 집계를 보여주는 것에서 "무엇이 달라졌는지 알려주는 것"으로.
//
// 대시보드에 막대와 꺾은선을 그려놓아도, 운영자가 매일 눈으로 비교하지 않으면
// 급증을 놓친다. 콜센터에서 중요한 건 "오늘 해지 문의가 평소보다 3배"처럼
// 임계를 넘은 변화이고, 그건 규칙으로 계산된다 — LLM도 API 키도 필요 없다.
//
// 표본이 작을 때 비율만 보면(1건 → 3건 = 200% 증가) 매일 경보가 뜬다. 그래서
// 최소 건수 조건과 비율 조건을 함께 걸고, 근거 수치를 항상 같이 돌려준다.

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

export function detectVocAnomalies(calls, opts = {}) {
  return [...detectRatioAlerts(calls, opts), ...detectCategorySpikes(calls, opts)]
}
