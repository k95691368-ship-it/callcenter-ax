// 일일 비용 상한 — "몇 번 호출했나"가 아니라 "얼마 썼나"로 막는다.
//
// 왜 바꾸는가:
// 기존 상한은 하루 300"회"였다. 그런데 이 워크벤치의 호출은 비용이 제각각이다 —
// 전사 8,000자를 통째로 넣는 통화 분석 1회와 집계 수치만 넣는 VOC 리포트 1회는
// 실제 지출이 몇 배 차이다. 회수 기준 상한은 그 차이를 반영하지 못하므로
// "300회 안에서 안전하다"는 보장이 성립하지 않는다.
// 이미 호출마다 토큰을 기록하고 있으므로(ai_calls), 그 합계로 실제 지출을 계산해 막는다.
//
// **Claude 호출만 센다.**
// 이 프로젝트는 Claude(사용자 API 키, 유료)와 Workers AI(Cloudflare)를 함께 쓴다.
// 두 경로 모두 토큰을 기록하지만, 지켜야 할 것은 사용자의 Anthropic 크래딧이다.
// mode='live'(Claude)만 합산하고 'live-oss'·'live-base'(Workers AI)는 제외한다 —
// 다른 회사 청구서를 여기에 더하면 상한이 엉뚱한 시점에 걸린다.

// claude-opus-5 단가 (USD / 토큰)
export const INPUT_PRICE = 5 / 1_000_000
export const OUTPUT_PRICE = 25 / 1_000_000
// 캐시 읽기는 입력의 10%, 캐시 생성은 125%. 이 둘은 input_tokens에 포함되지 않고
// 따로 보고되므로, 더하지 않으면 캐싱을 쓸수록 계산이 실제보다 적어진다.
export const CACHE_READ_PRICE = INPUT_PRICE * 0.1
export const CACHE_WRITE_PRICE = INPUT_PRICE * 1.25

// 하루 상한. 운영자가 조정하는 값이다.
export const DAILY_BUDGET_USD = 3

// 호출 1회의 대략적인 비용.
// 통화 분석은 전사 8,000자(≈8k 토큰)까지 입력받고 응답이 1~2k 토큰이므로
// 최대 크기 호출 1회가 약 $0.08이다. 예약분은 그보다 조금 낮게 잡는다 —
// 너무 크게 잡으면 여유가 있는데도 미리 막힌다.
export const RESERVE_PER_CALL_USD = 0.06

// 유료(사용자 크래딧) 호출인가.
//
// 세 번 빠졌다. 예전에는 mode === 'live' 목록으로 판정했는데,
//   · 검색 성공은 `live-hybrid`·`live-keyword`로 기록된다 (Claude가 답한 유료 호출)
//   · 보존 게이트가 막은 화자 분리는 `guarded`로 기록된다 (Claude 호출은 이미 끝났다)
//   · 절단·거절 실패는 `fallback-*`로 기록된다 (상한까지 생성한 뒤 실패 — 가장 비싸다)
// 셋 다 돈이 나간 호출인데 목록에 없어 예산에서 빠졌다.
//
// 그래서 "어떤 mode가 유료인가"를 세는 대신 **무료인 것만 제외**한다.
// 토큰을 기록하는 유일한 경로가 Claude이기 때문이다 — 오픈소스 층은 usage를 null로
// 돌려주고(ladder), Whisper도 usage를 남기지 않는다. 그래도 나중에 누군가 오픈소스
// 토큰을 기록하기 시작할 때를 대비해 무료 엔진 표식은 명시적으로 배제해 둔다.
const FREE_ENGINE_RE = /(oss|turbo|base)/

export function isPaidMode(mode) {
  if (typeof mode !== 'string' || !mode) return false
  return !FREE_ENGINE_RE.test(mode)
}

export function costOf(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return (
    (inputTokens || 0) * INPUT_PRICE +
    (outputTokens || 0) * OUTPUT_PRICE +
    (cacheReadTokens || 0) * CACHE_READ_PRICE +
    (cacheWriteTokens || 0) * CACHE_WRITE_PRICE
  )
}

// 최근 24시간 Claude 호출로 쓴 금액을 집계한다.
//
// calls: 이번 요청이 만들 Claude 호출 수. 이미 쓴 금액만으로 판단하면 이번 요청분만큼
// 상한을 넘겨 버린다(일괄 분석은 한 요청이 여러 호출을 한다). 예상 비용을 미리 빼고 본다.
//
// 집계 창은 자정이 아니라 롤링 24시간이다 — 자정 기준이면 23시에 상한을 채운 사람이
// 한 시간 뒤 다시 가득 쓸 수 있다.
//
// failOpen: 조회에 **실패**했을 때 어떻게 할 것인가.
//   기본값(true)은 "통과" — 비용 상한이 D1 장애로 화면을 멈추게 하지 않는다.
//   유료 호출 직전(사다리)에서는 false로 부른다. 거기서는 막아도 서비스가 멈추지 않고
//   무료 오픈소스 층으로 내려갈 뿐이라, 상한이 사라져 무제한 과금이 되는 쪽이 훨씬 나쁘다.
//
// D1이 **아예 없는 것**(로컬 개발 등)은 실패가 아니라 설정 상태다. 그때는 통과시킨다 —
// 여기서 막으면 D1 바인딩 없는 환경에서 유료 경로가 통째로 꺼진다.
export async function checkDailyBudget(env, limitUsd = DAILY_BUDGET_USD, { calls = 1, failOpen = true } = {}) {
  const reserve = Math.max(1, calls) * RESERVE_PER_CALL_USD
  if (!env?.DB) return { ok: true, spent: 0, limit: limitUsd, reserve, available: false, error: false }
  try {
    // mode별로 받아 JS에서 유료 여부를 가른다. SQL에 목록을 박으면 새 mode가 생길 때마다
    // 조용히 빠지므로(live-hybrid가 그렇게 빠졌다), 판정 규칙을 한 곳에 둔다.
    const { results } = await queryModeTotals(env)
    let spent = 0
    for (const r of results || []) {
      if (!isPaidMode(r.mode)) continue
      spent += costOf(r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens)
    }
    return { ok: spent + reserve <= limitUsd, spent, limit: limitUsd, reserve, available: true, error: false }
  } catch {
    return { ok: failOpen, spent: 0, limit: limitUsd, reserve, available: false, error: true }
  }
}

// 캐시 컬럼이 없는 배포(마이그레이션 0004 미적용)에서도 동작해야 한다.
// 그 경우 캐시분은 0으로 잡히므로 계산이 실제보다 적어지지만, 예산 검사가 통째로
// 실패해 fail-open으로 흘러가는 것보다는 낫다.
async function queryModeTotals(env) {
  const withCache = `SELECT mode,
                            SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                            SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
                            SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens
                       FROM ai_calls
                      WHERE created_at >= datetime('now', '-1 day')
                      GROUP BY mode`
  const legacy = `SELECT mode,
                         SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                         SUM(COALESCE(output_tokens, 0)) AS output_tokens
                    FROM ai_calls
                   WHERE created_at >= datetime('now', '-1 day')
                   GROUP BY mode`
  try {
    return await env.DB.prepare(withCache).all()
  } catch (err) {
    if (!/no such column/i.test(String(err?.message ?? err))) throw err
    return await env.DB.prepare(legacy).all()
  }
}

// 남은 예산 (화면·health 용). 음수는 0으로 접는다.
export function remainingUsd(budget) {
  if (!budget?.available) return null
  return Math.max(0, Math.round((budget.limit - budget.spent) * 1000) / 1000)
}

// 사용자에게 보여줄 안내. 상한에 걸렸다는 사실과 왜 그런지를 함께 말한다 —
// "지금 사용량이 많습니다"만 보여주면 운영자도 방문자도 원인을 알 수 없다.
export function budgetNotice(budget) {
  const spent = budget?.available ? ` (최근 24시간 약 $${budget.spent.toFixed(2)} / 상한 $${budget.limit})` : ''
  return `오늘의 라이브 AI 예산이 소진되어 규칙 기반 결과를 표시합니다${spent}. 24시간이 지나면 자동으로 복구됩니다.`
}
