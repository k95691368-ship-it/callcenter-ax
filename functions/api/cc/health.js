import { json } from '../../_lib/http.js'
import { hasApiKey } from '../../_lib/claude.js'

// 운영 헬스체크 — 바인딩·키 상태를 공개한다 (비밀값 자체는 노출하지 않음).
// About 페이지가 이 값으로 "지금 어떤 엔진이 살아있는지"를 실시간 표시한다.
export async function onRequestGet(context) {
  const { env } = context
  let db = false
  try {
    if (env.DB) {
      await env.DB.prepare('SELECT 1').first()
      db = true
    }
  } catch {
    db = false
  }
  return json({
    ok: true,
    workers_ai: Boolean(env.AI),
    d1: db,
    claude_key: hasApiKey(env),
    llm_engine: hasApiKey(env) ? 'claude-opus-5' : env.AI ? 'llama-3.3-70b (오픈소스)' : 'demo',
  })
}
