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
    if (await checkRateLimit(env, 'cc:claude:daily', CLAUDE_DAILY_CAP, 86400)) {
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
    const r = await callWorkersJson(env, {
      system: `${system}\n\nJSON 스키마: ${workersSchema}`,
      user,
      maxTokens: workersMaxTokens,
    })
    return { input: r.input, usage: null, model: r.model, engine: 'oss' }
  }
  throw claudeErr || new Error('사용 가능한 AI 엔진이 없습니다.')
}
