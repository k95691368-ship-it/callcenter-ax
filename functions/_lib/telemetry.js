// AI 호출 기록 — 응답을 막지 않도록 waitUntil로 비동기 기록하고, 실패해도 무시한다.
// 개인정보(IP·입력 내용)는 저장하지 않는다.
export function logCall(context, { endpoint, mode, startedAt, usage, findingsCount }) {
  const env = context.env
  if (!env?.DB) return
  const insert = env.DB.prepare(
    'INSERT INTO ai_calls (endpoint, mode, latency_ms, input_tokens, output_tokens, findings_count) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(
      endpoint,
      mode,
      startedAt ? Date.now() - startedAt : null,
      usage?.input_tokens ?? null,
      usage?.output_tokens ?? null,
      findingsCount ?? null
    )
    .run()
    .catch(() => {})
  try {
    context.waitUntil(insert)
  } catch {
    // waitUntil 미지원 환경(로컬 등)에서는 결과를 기다리지 않고 흘려보낸다
  }
}
