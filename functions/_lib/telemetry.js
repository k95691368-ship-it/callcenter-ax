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

// 캐시 토큰까지 기록하는 문장. 캐시 읽기·생성은 input_tokens에 포함되지 않고 단가도
// 다르므로(읽기 10%, 생성 125%), 빼놓으면 비용 상한이 실제 지출보다 적게 계산한다.
const INSERT_SQL =
  `INSERT INTO ai_calls (endpoint, mode, latency_ms, input_tokens, output_tokens, findings_count,
                         cache_read_tokens, cache_write_tokens)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

// 마이그레이션 0004가 아직 적용되지 않은 배포에서도 기록 자체는 계속돼야 한다.
// 컬럼이 없으면 INSERT가 실패하고, logCall은 오류를 삼키므로 지표가 통째로 사라진다 —
// 그건 "비용을 못 본다"보다 나쁘다. 옛 문장으로 한 번 더 시도한다.
const LEGACY_INSERT_SQL =
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

// 폴백 사유 — 시스템이 "왜 실패했는지"를 알면서도 기록하지 않던 것을 남긴다.
//
// claude.js는 거절(refusal)·절단(max_tokens)·데드라인·HTTP 오류를 err.code로 구분해
// 던지는데, 엔드포인트의 catch는 그걸 전부 'fallback' 한 단어로 뭉개 기록했다.
// 그래서 운영 지표에는 "폴백 8회"만 남고, 그 8회가 안전 정책 거절인지 우리 상한이
// 작아서 잘린 것인지 알 방법이 없었다 — 고칠 수 있는 실패와 고칠 수 없는 실패를
// 구분하지 못한다는 뜻이다.
//
// mode는 D1에 그대로 저장되고 화면 라벨의 키가 되므로 짧은 소문자·하이픈만 쓴다
// (tests/privacy.test.js가 이 형태를 고정한다).
const KNOWN_FAILURES = new Set(['refusal', 'max-tokens', 'deadline', 'timeout', 'http', 'no-key', 'contract'])

export function failureMode(err) {
  const raw = String(err?.code || '').replace(/_/g, '-')
  if (KNOWN_FAILURES.has(raw)) return `fallback-${raw}`
  // 계약 검증 실패는 code가 없다 — 메시지로 구분되는 유일한 유형이라 여기서 알아본다.
  if (/응답에서 결과를 찾을 수 없|필드가 없|형식이 올바르지/.test(String(err?.message || '')))
    return 'fallback-contract'
  return 'fallback'
}


// 폴백 안내 문구 — 원인을 사실대로 말한다.
//
// 예전에는 모든 폴백을 "일시적인 AI 혼잡"으로 적었다. 그래서 예산이 소진돼 하루 종일
// 데모로 나가는 상태를 사용자가 "새로고침하면 낫겠지"로 읽었고, 괄호 안의 원문에는
// "오픈소스 LLM으로 답합니다"가 붙어 있어 규칙 데모 결과를 LLM 결과로 오인하게 했다.
// 고칠 수 있는 실패(혼잡·지연)와 정책에 의한 강등(예산)은 사용자가 할 일이 다르다.
export function fallbackNotice(err, what = '예시 결과') {
  const detail = String(err?.message ?? '').trim()
  if (err?.code === 'budget')
    return `오늘의 유료 AI 예산이 소진되어 ${what}를 표시합니다. 24시간이 지나면 자동으로 복구됩니다.`
  return `일시적인 AI 혼잡으로 ${what}를 표시합니다.${detail ? ` (${detail})` : ''}`
}

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
  const latency = r.startedAt ? Date.now() - r.startedAt : null
  const core = [r.endpoint, r.mode, latency, r.usage?.input_tokens ?? null, r.usage?.output_tokens ?? null, r.findingsCount ?? null]
  const insert = env.DB.prepare(INSERT_SQL)
    .bind(...core, r.usage?.cache_read_input_tokens ?? null, r.usage?.cache_creation_input_tokens ?? null)
    .run()
    // 캐시 컬럼이 없는 배포(마이그레이션 0004 미적용)에서는 옛 문장으로 남긴다.
    // 캐시 토큰은 잃지만 호출 기록 자체를 잃는 것보다 낫다.
    .catch(() => env.DB.prepare(LEGACY_INSERT_SQL).bind(...core).run().catch(() => {}))
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
