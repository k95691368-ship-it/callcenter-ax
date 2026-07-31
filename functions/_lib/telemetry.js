// AI 호출 기록 — 응답을 막지 않도록 waitUntil로 비동기 기록하고, 실패해도 무시한다.
// 개인정보(IP·입력 내용)는 저장하지 않는다.

// 원본 행 보관 기간. ai_calls에는 정리 로직이 없어 무한히 쌓였고, About의 집계가 매번
// 전체를 스캔했다. 이 기간이 지난 행은 (endpoint, mode)별 누적 카운터(ai_call_totals)로
// 접어 넣고 지운다 — 카운터가 남으므로 "누적 호출 수"와 "수집 시작 시각"은 줄지 않는다.
export const RAW_RETENTION_DAYS = 30
// 크론이 없는 Pages Functions에서는 트래픽에 비례해 청소한다 (rate_limit_hits와 같은 방식).
const PRUNE_CHANCE = 0.01

// 한 요청에 한 줄만 남기기 위한 예약대. 키가 요청 컨텍스트이므로 요청이 끝나면 사라진다.
const PENDING = new WeakMap()

const INSERT_SQL =
  'INSERT INTO ai_calls (endpoint, mode, latency_ms, input_tokens, output_tokens, findings_count) VALUES (?, ?, ?, ?, ?, ?)'

// 오래된 원본을 누적 카운터로 접어 넣는다. 같은 (endpoint, mode)가 이미 있으면 더한다.
// latency는 평균이 아니라 합·건수로 보관해야, 나중에 남은 원본과 합칠 때 가중 평균이
// 정확히 복원된다 (평균의 평균은 틀린다).
const ROLLUP_SQL = `INSERT INTO ai_call_totals (endpoint, mode, calls, latency_sum, latency_calls, first_at, last_at)
   SELECT endpoint, mode, COUNT(*), COALESCE(SUM(latency_ms), 0), COUNT(latency_ms),
          MIN(created_at), MAX(created_at)
     FROM ai_calls
    WHERE created_at < ?
    GROUP BY endpoint, mode
   ON CONFLICT(endpoint, mode) DO UPDATE SET
     calls = calls + excluded.calls,
     latency_sum = latency_sum + excluded.latency_sum,
     latency_calls = latency_calls + excluded.latency_calls,
     first_at = MIN(first_at, excluded.first_at),
     last_at = MAX(last_at, excluded.last_at)`

const DELETE_SQL = 'DELETE FROM ai_calls WHERE created_at < ?'

export function logCall(context, { endpoint, mode, startedAt, usage, findingsCount }) {
  const env = context?.env
  if (!env?.DB) return
  const next = { endpoint, mode, startedAt, usage, findingsCount }

  // qa·analyze는 성공을 기록한 뒤 응답을 만들다 예외가 나면 catch에서 fallback을 한 번 더
  // 기록했다 — 한 요청이 두 줄로 남아 누적 호출 수가 부풀고 라이브 비율이 왜곡됐다.
  // 같은 요청의 두 번째 기록은 새 줄을 만들지 않는다.
  const slot = PENDING.get(context)
  if (slot) {
    // 아직 쓰기 전이면, 사용자가 실제로 받은 결과(mode)로 갱신만 한다.
    // 이미 썼다면(중간에 await가 끼어든 경우) 손대지 않는다 — 줄이 늘어나는 쪽이 더 나쁘다.
    if (!slot.written) slot.record = mergeRecord(slot.record, next)
    return
  }

  const fresh = { record: next, written: false }
  PENDING.set(context, fresh)
  // 같은 tick 안의 두 번째 호출까지 반영한 뒤 한 줄만 쓰기 위해 마이크로태스크로 미룬다.
  // waitUntil은 지금 등록해야 런타임이 요청을 살려둔다.
  const done = Promise.resolve()
    .then(() => {
      fresh.written = true
      return writeCall(env, fresh.record)
    })
    .catch(() => {})
  try {
    context.waitUntil(done)
  } catch {
    // waitUntil 미지원 환경(로컬 등)에서는 결과를 기다리지 않고 흘려보낸다
  }
}

// mode는 마지막 결과가 진실이지만, 이미 실제로 소모된 토큰·지연은 잃지 않게 유지한다
// (라이브 호출이 끝난 뒤 폴백으로 응답한 경우 토큰은 실제로 나갔다).
function mergeRecord(prev, next) {
  return {
    endpoint: next.endpoint || prev.endpoint,
    mode: next.mode || prev.mode,
    startedAt: prev.startedAt ?? next.startedAt,
    usage: next.usage ?? prev.usage,
    findingsCount: next.findingsCount ?? prev.findingsCount,
  }
}

function writeCall(env, r) {
  const insert = env.DB.prepare(INSERT_SQL)
    .bind(
      r.endpoint,
      r.mode,
      r.startedAt ? Date.now() - r.startedAt : null,
      r.usage?.input_tokens ?? null,
      r.usage?.output_tokens ?? null,
      r.findingsCount ?? null
    )
    .run()
    .catch(() => {})
  // 정리는 기록이 끝난 뒤에 붙인다 — 청소가 이번 요청의 기록을 지연시킬 이유가 없다.
  return insert.then(() => maybePrune(env))
}

function maybePrune(env) {
  if (Math.random() >= PRUNE_CHANCE) return
  return pruneAiCalls(env).catch(() => {})
}

// 보관 기간이 지난 원본을 누적 카운터로 접어 넣고 삭제한다.
// 롤업과 삭제가 한 트랜잭션으로 묶이지 않으면 삭제만 성공해 카운터에 구멍이 난다.
// batch()가 없는 환경에서는 아무것도 지우지 않는 편이 안전하다.
export async function pruneAiCalls(env, { days = RAW_RETENTION_DAYS, now = Date.now() } = {}) {
  const db = env?.DB
  if (typeof db?.batch !== 'function') return false
  // 경계 시각을 JS에서 한 번 계산해 두 문장에 같은 값을 바인딩한다. 문장마다
  // datetime('now')를 쓰면 초가 넘어가는 순간 롤업되지 않은 행이 삭제될 수 있다.
  const cutoff = sqlTimestamp(now - days * 86_400_000)
  await db.batch([db.prepare(ROLLUP_SQL).bind(cutoff), db.prepare(DELETE_SQL).bind(cutoff)])
  return true
}

// created_at 기본값이 datetime('now')이므로 같은 형식('YYYY-MM-DD HH:MM:SS', UTC)으로 맞춘다.
// 형식이 어긋나면 문자열 비교가 조용히 틀린 범위를 고른다.
function sqlTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}
