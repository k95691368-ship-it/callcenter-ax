// /analyze에서 분석한 통화를 브라우저(localStorage)에 누적해 VOC 대시보드에 합산한다.
// 서버에는 아무것도 저장하지 않는다 — 개인정보 미수집 원칙 유지.

const KEY = 'cc-mycalls'
const MAX_SAVED = 50

export function loadMyCalls() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// churn·route는 있으면 함께 저장한다. 대시보드가 "무슨 유형이 몇 건"에서
// "어느 통화가 위험했고 어디로 넘어갔는가"까지 답하려면 이 두 값이 남아야 한다.
// 점수와 등급·근거 라벨만 남기고 인용 발화는 저장하지 않는다 — 원문 미저장 원칙.
export function saveMyCall({ title, category, sentiment, escalate, churn, route }) {
  try {
    const calls = loadMyCalls()
    calls.push({
      id: `m${Date.now()}`,
      date: new Date().toISOString().slice(0, 10),
      title: (title || '직접 분석한 통화').slice(0, 40),
      analysis: {
        category,
        sentiment,
        escalate: Boolean(escalate),
        ...(Number.isFinite(churn?.score)
          ? {
              churn: {
                score: churn.score,
                level: churn.level,
                estimated: Boolean(churn.estimated),
                signals: (churn.signals || []).map((s) => s.label).slice(0, 6),
              },
            }
          : {}),
        ...(route?.team ? { route: { team: route.team, priority: route.priority } } : {}),
      },
      mine: true,
    })
    localStorage.setItem(KEY, JSON.stringify(calls.slice(-MAX_SAVED)))
  } catch {
    // 저장 불가(시크릿 모드 등)여도 분석 흐름을 막지 않는다
  }
}

export function clearMyCalls() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 무시
  }
}
