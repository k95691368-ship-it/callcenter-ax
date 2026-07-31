// QA 코칭 이력 — 한 통화의 점수에서 "이 상담사가 반복해서 놓치는 것"으로.
//
// Auto QA가 점수를 매겨도, 통화 한 건의 점수는 코칭에 쓰기 어렵다. 실제로 필요한 건
// "지난 10건에서 녹취 고지를 7번 빠뜨렸다" 같은 반복 패턴이다. 평가 결과를 누적하면
// 그 패턴이 계산으로 나온다 — LLM 재호출 없이, 이미 받은 결과만으로.
//
// 저장은 브라우저에만 한다(서버 미저장 원칙). 상담사 이름 같은 개인정보는 받지 않고,
// 사용자가 직접 붙인 라벨만 쓴다.

const KEY = 'cc-qa-history'
const MAX_SAVED = 60

export function loadQaHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// result는 /api/cc/qa 응답 그대로 넘긴다. 저장은 지표만 뽑아 최소한으로 한다 —
// 통화 전사 원문은 저장하지 않는다(개인정보 미수집).
export function saveQaResult(result, { label = '', at = null } = {}) {
  if (!result?.score) return loadQaHistory()
  try {
    const list = loadQaHistory()
    list.push({
      id: `q${list.length + 1}-${(at || new Date().toISOString()).slice(0, 19)}`,
      date: (at || new Date().toISOString()).slice(0, 10),
      label: String(label || '').slice(0, 30),
      total: result.score.total,
      grade: result.score.grade,
      ruleScore: result.score.ruleScore,
      llmScore: result.score.llmScore,
      estimated: Boolean(result.score.llmEstimated),
      deduction: result.score.deduction,
      // 놓친 멘트와 걸린 금지 표현의 식별자만 남긴다
      missed: (result.mentions || []).filter((m) => !m.found).map((m) => m.label),
      violations: (result.findings || []).map((f) => f.label),
      speakerLabeled: result.speaker_labeled !== false,
    })
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_SAVED)))
    return loadQaHistory()
  } catch {
    // 저장 불가 환경(시크릿 모드 등)에서도 평가 흐름은 막지 않는다
    return loadQaHistory()
  }
}

export function clearQaHistory() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 무시
  }
}

function tally(lists) {
  const map = new Map()
  for (const item of lists.flat()) {
    if (!item) continue
    map.set(item, (map.get(item) || 0) + 1)
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1))
}

// 이력에서 코칭 카드를 만든다. 표본이 적으면 추세를 말하지 않는다 —
// 2건으로 "하락 추세"라고 하면 그건 분석이 아니라 노이즈다.
export function summarizeQaHistory(history) {
  const list = (history || []).filter((h) => Number.isFinite(h?.total))
  if (!list.length) return null

  const avg = Math.round(list.reduce((s, h) => s + h.total, 0) / list.length)
  const estimatedCount = list.filter((h) => h.estimated).length

  // 추세: 앞 절반과 뒤 절반의 평균을 비교 (최소 4건부터)
  let trend = null
  if (list.length >= 4) {
    const half = Math.floor(list.length / 2)
    const early = list.slice(0, half)
    const late = list.slice(-half)
    const earlyAvg = early.reduce((s, h) => s + h.total, 0) / early.length
    const lateAvg = late.reduce((s, h) => s + h.total, 0) / late.length
    const delta = Math.round(lateAvg - earlyAvg)
    trend = {
      delta,
      direction: delta >= 3 ? 'up' : delta <= -3 ? 'down' : 'flat',
      earlyAvg: Math.round(earlyAvg),
      lateAvg: Math.round(lateAvg),
    }
  }

  const missed = tally(list.map((h) => h.missed || []))
  const violations = tally(list.map((h) => h.violations || []))

  const cards = []
  const top = missed[0]
  if (top && top.count >= 2) {
    cards.push({
      id: `coach-missed-${top.label}`,
      level: top.count / list.length >= 0.5 ? 'high' : 'warn',
      label: `반복 누락: ${top.label}`,
      detail: `최근 ${list.length}건 중 ${top.count}건에서 빠졌습니다 — 이 항목을 응대 스크립트 앞으로 옮기는 편이 좋습니다.`,
    })
  }
  const topV = violations[0]
  if (topV && topV.count >= 2) {
    cards.push({
      id: `coach-violation-${topV.label}`,
      level: 'high',
      label: `반복 금지 표현: ${topV.label}`,
      detail: `최근 ${list.length}건 중 ${topV.count}건에서 발견됐습니다 — 대체 화법 연습이 필요합니다.`,
    })
  }
  if (trend?.direction === 'down') {
    cards.push({
      id: 'coach-trend-down',
      level: 'warn',
      label: '점수 하락 추세',
      detail: `초반 평균 ${trend.earlyAvg}점 → 최근 평균 ${trend.lateAvg}점 (${trend.delta}점).`,
    })
  }
  if (trend?.direction === 'up') {
    cards.push({
      id: 'coach-trend-up',
      level: 'ok',
      label: '점수 개선 추세',
      detail: `초반 평균 ${trend.earlyAvg}점 → 최근 평균 ${trend.lateAvg}점 (+${trend.delta}점).`,
    })
  }
  if (!cards.length) {
    cards.push({
      id: 'coach-none',
      level: 'ok',
      label: '반복 패턴 없음',
      detail: `최근 ${list.length}건에서 2회 이상 반복된 누락·금지 표현이 없습니다.`,
    })
  }

  return {
    count: list.length,
    avg,
    estimatedCount,
    latest: list[list.length - 1],
    trend,
    missedTop: missed.slice(0, 5),
    violationTop: violations.slice(0, 5),
    cards,
    // 추세선용 (날짜, 점수) — 화면에서 그대로 그릴 수 있게
    points: list.map((h, i) => ({ i, date: h.date, total: h.total, estimated: h.estimated })),
  }
}
