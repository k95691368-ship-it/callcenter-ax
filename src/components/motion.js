// 스크롤 이동은 "동작 줄이기(prefers-reduced-motion)"를 켠 사용자에게 멀미를 유발할 수
// 있다. 부드러운 스크롤을 여러 화면이 각자 하드코딩하면 한 곳만 고쳐도 나머지가 남으므로
// 판정과 이동을 여기 한 곳에 모은다. (CSS 쪽 전역 감축은 src/index.css에 있다)

export function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function behavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

// 생성 결과가 도착했을 때 결과 영역으로 시선을 옮긴다
export function revealElement(el) {
  el?.scrollIntoView({ behavior: behavior(), block: 'start' })
}

// 라우트 전환 — 스크롤이 남아 있으면 새 페이지의 중간부터 보인다
export function scrollPageToTop() {
  if (typeof window === 'undefined') return
  window.scrollTo({ top: 0, left: 0, behavior: behavior() })
}
