// 일괄 분석 입력 파서 — 빈 줄 2개(또는 그 이상)로 구분된 여러 통화를 나눈다.
export const MAX_BATCH_CALLS = 5
export const MAX_CALL_CHARS = 2000

export function splitCalls(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH_CALLS)
    .map((t) => t.slice(0, MAX_CALL_CHARS))
}
