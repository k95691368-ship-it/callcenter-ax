import { json, NO_STORE, SHORT_EDGE_CACHE } from '../../_lib/http.js'
import { RAW_RETENTION_DAYS } from '../../_lib/telemetry.js'

// 운영 텔레메트리 집계 — ai_calls를 엔드포인트·모드별로 집계해 공개한다.
// 개별 호출의 입력 내용·IP는 애초에 저장하지 않으므로 집계에도 존재하지 않는다.
//
// 숫자의 의미: rows·total은 서비스 시작 이후 "누적"이다. 원본 행은 30일 뒤 지워지지만,
// 지워진 몫은 ai_call_totals(누적 카운터)에 접혀 있어 화면의 "누적 호출 수"는 줄지 않고
// since(수집 시작)도 뒤로 밀리지 않는다. 창을 좁혀 숫자가 조용히 작아지는 설계를 피했다.
const EMPTY = { ok: false, rows: [], total: 0, since: null }

// 누적 카운터 + 아직 접히지 않은 원본을 합쳐 (endpoint, mode)별로 낸다.
// 원본 쪽 조건이 created_at > (카운터가 이미 센 마지막 시각)인 이유:
//   - 그 시각 이하의 행은 카운터에 들어 있으므로 다시 세면 중복이 된다.
//   - 남은 행은 모두 그 시각 이후이므로 "최근 N일" 같은 고정 창을 쓸 때 생기는 누락
//     (정리가 아직 안 돌아 창 밖에 있는 행이 통째로 빠져 숫자가 줄어드는 현상)이 없다.
//   - created_at 인덱스를 그대로 타므로 전체 스캔이 아니다.
const AGG_SQL = `WITH counted_through AS (
     SELECT COALESCE(MAX(last_at), '') AS at FROM ai_call_totals
   )
   SELECT endpoint, mode, SUM(calls) AS calls,
          CAST(ROUND(SUM(latency_sum) * 1.0 / NULLIF(SUM(latency_calls), 0)) AS INTEGER) AS avg_latency_ms
     FROM (
       SELECT endpoint, mode, calls, latency_sum, latency_calls FROM ai_call_totals
       UNION ALL
       SELECT endpoint, mode, COUNT(*) AS calls, COALESCE(SUM(latency_ms), 0) AS latency_sum,
              COUNT(latency_ms) AS latency_calls
         FROM ai_calls
        WHERE created_at > (SELECT at FROM counted_through)
        GROUP BY endpoint, mode
     )
    GROUP BY endpoint, mode
    ORDER BY calls DESC`

// 수집 시작 시각 — 접힌 몫(first_at)과 남은 원본(created_at) 중 이른 쪽. MIN은 NULL을 무시한다.
const SINCE_SQL = `SELECT MIN(at) AS since FROM (
     SELECT MIN(first_at) AS at FROM ai_call_totals
     UNION ALL
     SELECT MIN(created_at) AS at FROM ai_calls
   )`

// 0003 마이그레이션이 아직 적용되지 않은 배포(코드는 푸시로 자동 배포되지만 마이그레이션은
// 수동)에서도 화면이 죽지 않게 남겨두는 경로. 이때는 정리도 돌지 않으므로 원본이 전부
// 남아 있고, 예전과 똑같은 숫자가 나온다.
const LEGACY_AGG_SQL = `SELECT endpoint, mode, COUNT(*) AS calls,
          CAST(ROUND(AVG(latency_ms)) AS INTEGER) AS avg_latency_ms
     FROM ai_calls GROUP BY endpoint, mode ORDER BY calls DESC`
const LEGACY_SINCE_SQL = 'SELECT MIN(created_at) AS since FROM ai_calls'

export async function onRequestGet(context) {
  const { env } = context
  if (!env.DB) return json(EMPTY, 200, { cacheControl: NO_STORE })
  try {
    const [rows, sinceRows] = await readStats(env)
    return json(
      {
        ok: true,
        rows,
        // rows에서 더한다 — 별도 COUNT(*)를 또 던지면 왕복이 늘고, 두 숫자가 어긋날 수도 있다.
        total: rows.reduce((sum, r) => sum + (Number(r.calls) || 0), 0),
        since: sinceRows[0]?.since ?? null,
        // 화면이 "누적"이라고 말해도 되는 근거를 응답 자체에 남긴다
        cumulative: true,
        raw_retention_days: RAW_RETENTION_DAYS,
      },
      200,
      { cacheControl: SHORT_EDGE_CACHE }
    )
  } catch {
    // 일시 장애의 빈 응답이 캐시에 남아 몇 분간 재생되면 안 된다
    return json(EMPTY, 200, { cacheControl: NO_STORE })
  }
}

async function readStats(env) {
  try {
    return await readPair(env, AGG_SQL, SINCE_SQL)
  } catch {
    return await readPair(env, LEGACY_AGG_SQL, LEGACY_SINCE_SQL)
  }
}

// 두 문장을 한 번의 왕복으로 처리한다 (batch가 없는 환경에서는 순차 실행으로 내려간다).
async function readPair(env, sqlA, sqlB) {
  const stmts = [env.DB.prepare(sqlA), env.DB.prepare(sqlB)]
  if (typeof env.DB.batch === 'function') {
    const [a, b] = await env.DB.batch(stmts)
    return [a?.results || [], b?.results || []]
  }
  const a = await stmts[0].all()
  const b = await stmts[1].all()
  return [a?.results || [], b?.results || []]
}
