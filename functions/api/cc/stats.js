import { json } from '../../_lib/http.js'

// 운영 텔레메트리 집계 — ai_calls를 엔드포인트·모드별로 집계해 공개한다.
// 개별 호출의 입력 내용·IP는 애초에 저장하지 않으므로 집계에도 존재하지 않는다.
export async function onRequestGet(context) {
  const { env } = context
  if (!env.DB) return json({ ok: false, rows: [], total: 0, since: null })
  try {
    const { results } = await env.DB.prepare(
      `SELECT endpoint, mode, COUNT(*) AS calls,
              CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avg_latency_ms
       FROM ai_calls GROUP BY endpoint, mode`
    ).all()
    const meta = await env.DB.prepare(
      'SELECT MIN(created_at) AS since, COUNT(*) AS total FROM ai_calls'
    ).first()
    return json({
      ok: true,
      rows: results || [],
      total: meta?.total ?? 0,
      since: meta?.since ?? null,
    })
  } catch {
    return json({ ok: false, rows: [], total: 0, since: null })
  }
}
