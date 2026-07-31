import { callClaudeTool, hasApiKey } from './claude.js'
import { callWorkersJson, hasWorkersAi } from './workersLlm.js'
import { checkDailyBudget } from './budget.js'

// 유료 Claude 호출의 일일 상한 — 소진되면 서비스를 멈추는 게 아니라
// 오픈소스 LLM으로 자연 강등되어 과금 폭주를 구조적으로 차단한다.
//
// 기준을 "회수"에서 "금액"으로 바꿨다.
// 예전에는 하루 150"회"였다. 그런데 호출마다 비용이 제각각이다 — 전사 8,000자를 통째로
// 넣는 통화 분석과 집계 수치만 넣는 VOC 리포트는 실제 지출이 몇 배 차이다.
// 회수 상한은 그 차이를 반영하지 못하므로 "150회 안에서는 안전하다"가 성립하지 않는다.
// 이미 호출마다 토큰을 기록하고 있으니(ai_calls) 그 합계로 실제 지출을 계산해 막는다.
// 강등 동작은 그대로다 — 상한에 걸려도 오픈소스 층이 답한다.

// 사다리 전체의 데드라인. 엣지 실행 한도(약 100초)를 넘기면 클라이언트는 524를 받고
// 그 요청의 logCall이 실행되지 않아 텔레메트리에 흔적조차 남지 않는다. 예전 최악 경로는
// Claude 40s + 대기 1.5s + 재시도 40s + 오픈소스 40s ≈ 121초로 실제로 한도를 넘겼다.
// 기준 시각은 이 함수 진입 시점이고, 각 단계는 min(단계 타임아웃, 남은 시간)을 쓴다.
const LADDER_DEADLINE_MS = 70000
const OSS_TIMEOUT_MS = 40000
// 남은 시간이 이보다 적으면 오픈소스를 시도해도 응답 전에 한도를 넘긴다 — 건너뛰고
// 즉시 실패로 넘겨 상위(엔드포인트)의 규칙 기반 폴백과 logCall이 제 시간에 돌게 한다.
const OSS_MIN_WINDOW_MS = 6000

// 단계별 타임아웃을 남은 시간으로 조여 준다. callWorkersJson 자체의 40초 레이스보다
// 짧을 때만 의미가 있고, 이기든 지든 타이머는 정리한다(대기 중인 타이머가 남으면
// 응답을 보낸 뒤에도 워커가 붙잡혀 있다).
async function withDeadline(promise, ms, message) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// LLM 층의 진짜 3단 사다리.
// 기존에는 키 유무로 Claude "또는" 오픈소스를 골랐기 때문에, Claude 호출이
// 일시 장애(429/529 등)로 실패하면 곧장 규칙 데모로 추락했다.
// 이제 Claude 실패 시 오픈소스 LLM(Workers AI)을 한 번 더 시도한 뒤에야 폴백한다.
// 반환: { input, usage, model, engine: 'claude' | 'oss' }
export async function runLlmLadder(env, { system, user, tool, maxTokens, workersSchema, workersMaxTokens }) {
  const deadlineAt = Date.now() + LADDER_DEADLINE_MS
  let claudeErr = null
  if (hasApiKey(env)) {
    // 예산 검사는 fail-open이면 안 된다 — D1 장애 때 상한이 사라져 무제한 과금이 된다.
    // 검사할 수 없으면 유료 호출을 건너뛰고 오픈소스 층으로 내려간다.
    const budget = await checkDailyBudget(env, undefined, { failOpen: false })
    if (budget.ok) {
      try {
        const r = await callClaudeTool(env, { system, user, tool, maxTokens, deadlineAt })
        return { input: r.input, usage: r.usage, model: null, engine: 'claude' }
      } catch (err) {
        claudeErr = err
      }
    } else {
      // 문구에 "오픈소스로 답한다"를 넣으면, 오픈소스마저 없어 규칙 데모로 내려간 경우에도
      // 사용자가 LLM이 답했다고 믿는다. 여기서는 사실만 말하고, 무엇으로 답했는지는
      // 실제로 답한 층이 말한다.
      claudeErr = new Error('오늘의 유료 AI 예산이 소진되었습니다.')
      claudeErr.code = 'budget'
    }
  }
  const left = deadlineAt - Date.now()
  if (hasWorkersAi(env) && left >= OSS_MIN_WINDOW_MS) {
    try {
      const r = await withDeadline(
        callWorkersJson(env, {
          system: `${system}\n\nJSON 스키마: ${workersSchema}`,
          user,
          maxTokens: workersMaxTokens,
        }),
        Math.min(OSS_TIMEOUT_MS, left),
        '오픈소스 LLM 응답이 지연되고 있습니다.'
      )
      return { input: r.input, usage: null, model: r.model, engine: 'oss' }
    } catch (ossErr) {
      // 두 층이 모두 실패했을 때 사용자에게 보여줄 원인은 위층(Claude)의 것이다.
      // 이 catch가 없으면 아래층 오류가 위층 오류를 덮어써, 무엇이 먼저 무너졌는지 사라진다.
      if (claudeErr) {
        claudeErr.cause = ossErr
        throw claudeErr
      }
      throw ossErr
    }
  }
  // 시간이 없어 오픈소스를 건너뛴 경우도 여기로 온다.
  if (claudeErr) throw claudeErr
  throw new Error(
    hasWorkersAi(env)
      ? '시간 내에 AI 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.'
      : '사용 가능한 AI 엔진이 없습니다.'
  )
}
