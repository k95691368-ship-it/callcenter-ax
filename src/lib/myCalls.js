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

export function saveMyCall({ title, category, sentiment, escalate }) {
  try {
    const calls = loadMyCalls()
    calls.push({
      id: `m${Date.now()}`,
      date: new Date().toISOString().slice(0, 10),
      title: (title || '직접 분석한 통화').slice(0, 40),
      analysis: { category, sentiment, escalate: Boolean(escalate) },
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
