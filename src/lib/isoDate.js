// 날짜 문자열 계산 — 'YYYY-MM-DD' 하나만 다룬다.
//
// Date 객체로 들고 다니면 로컬/UTC가 섞여 자정 근처에서 하루가 밀리고, 그러면 방금
// 분석한 통화가 "어제" 칸으로 사라진다. 그래서 이 모듈은 문자열을 받아 문자열을 준다.
//
// 왜 별도 파일인가:
// 이 함수들은 원래 vocPeriod.js에 있었다. 그런데 통화를 저장만 하는 myCalls.js가
// todayIso 하나를 쓰려고 vocPeriod를 import하면서 vocThemes(원인 사전) → callMetrics,
// vocAnomaly(급증 규칙) → teams 까지 딸려 왔다. 통화 한 건을 localStorage에 넣는 일이
// VOC 분석 엔진 전체에 의존하게 된 것이고, 의존 방향이 뒤집혀 있었다
// (영속 계층이 분석 계층을 부른다).
// 날짜 계산은 어느 쪽에도 속하지 않는 바닥이므로 여기로 내린다. 앞으로 vocThemes에
// 부작용 있는 초기화가 한 줄이라도 들어가면 저장 경로가 그 영향을 받게 되는데,
// 그 연결을 미리 끊어 둔다.

const DAY_MS = 86400000

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// 'YYYY-MM-DD' → UTC 자정 ms. 형식이 아니면 null (조용히 0으로 만들지 않는다 —
// 0은 1970년이 되어 모든 기간 필터에서 빠지거나 들어가는 유령 데이터가 된다).
export function toUtcMs(iso) {
  const s = String(iso || '')
  if (!ISO_DATE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d)
  // '2026-02-31'처럼 존재하지 않는 날짜는 Date.UTC가 다음 달로 굴려 버린다.
  // 굴러간 값을 그대로 쓰면 기간 경계가 조용히 어긋나므로 되돌려 확인한다.
  return new Date(ms).toISOString().slice(0, 10) === s ? ms : null
}

// 날짜 문자열을 delta일만큼 민다. UTC ms 산술이라 서머타임·타임존 영향을 받지 않는다.
export function shiftDays(iso, delta) {
  const ms = toUtcMs(iso)
  if (ms === null) return null
  return new Date(ms + delta * DAY_MS).toISOString().slice(0, 10)
}

// a에서 b까지 며칠인가 (b - a). 같은 날이면 0.
export function daysBetween(a, b) {
  const from = toUtcMs(a)
  const to = toUtcMs(b)
  if (from === null || to === null) return null
  return Math.round((to - from) / DAY_MS)
}

// 오늘 날짜 — **로컬 기준**이다.
// new Date().toISOString()은 UTC라서 KST(+9)의 자정~오전 9시에 분석한 통화가
// 전날 날짜로 기록된다. 기간 필터가 없던 때는 티가 나지 않았지만, 이제는 오전 근무
// 시간대에 분석한 통화가 "오늘"에서 빠지고 "어제"에 들어간다.
export function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
