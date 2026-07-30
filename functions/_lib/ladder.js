import { callClaudeTool, hasApiKey } from './claude.js'
import { callWorkersJson, hasWorkersAi } from './workersLlm.js'
import { checkRateLimit } from './rateLimit.js'

// 유료 Claude 호출만의 일일 상한 — 소진되면 서비스를 멈추는 게 아니라
// 오픈소스 LLM으로 자연 강등되어 과금 폭주를 구조적으로 차단한다.
const CLAUDE_DAILY_CAP = 150

// LLM 층의 진짜 3단 사다리.
// 기존에는 키 유무로 Claude "또는" 오픈소스를 골랐기 때문에, Claude 호출이
// 일시 장애(429/529 등)로 실패하면 곧장 규칙 데모로 추락했다.
// 이제 Claude 실패 시 오픈소스 LLM(Workers AI)을 한 번 더 시도한 뒤에야 폴백한다.
// 반환: { input, usage, model, engine: 'claude' | 'oss' }
export async function runLlmLadder(env, { system, user, tool, maxTokens, workersSchema, workersMaxTokens }) {
  let claudeErr = null
  if (hasApiKey(env)) {
    // 예산 버킷은 fail-open이면 안 된다 — D1 장애 때 상한이 사라져 무제한 과금이 된다.
    // 검사할 수 없으면 유료 호출을 건너뛰고 오픈소스 층으로 내려간다.
    if (await checkRateLimit(env, 'cc:claude:daily', CLAUDE_DAILY_CAP, 86400, { failOpen: false })) {
      try {
        const r = await callClaudeTool(env, { system, user, tool, maxTokens })
        return { input: r.input, usage: r.usage, model: null, engine: 'claude' }
      } catch (err) {
        claudeErr = err
      }
    } else {
      claudeErr = new Error('오늘의 Claude 예산이 소진되어 오픈소스 LLM으로 답합니다.')
    }
  }
  if (hasWorkersAi(env)) {
    try {
      const r = await callWorkersJson(env, {
        system: `${system}\n\nJSON 스키마: ${workersSchema}`,
        user,
        maxTokens: workersMaxTokens,
      })
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
  throw claudeErr || new Error('사용 가능한 AI 엔진이 없습니다.')
}
