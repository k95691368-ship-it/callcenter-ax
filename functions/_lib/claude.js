const MODEL = 'claude-opus-5'

export function hasApiKey(env) {
  return Boolean(env.CLAUDE_API_KEY)
}

// tool 강제 호출로 구조화된 JSON을 받는 공용 헬퍼.
// Opus 5는 thinking이 기본 활성화이고 max_tokens가 thinking+응답을 합산하므로
// 호출부의 maxTokens에 여유를 두고, effort=medium으로 분류·요약 작업의 비용을 조절한다.
// 반환값: { input: tool_use 블록의 input 객체, usage: 토큰 사용량 }
export async function callClaudeTool(env, { system, user, tool, maxTokens = 8192 }) {
  const apiKey = env.CLAUDE_API_KEY
  if (!apiKey) throw new Error('CLAUDE_API_KEY가 설정되지 않았습니다.')

  const doFetch = () =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // 외부 API 지연이 Functions 실행 한도까지 매달리지 않게 타임아웃을 건다
      signal: AbortSignal.timeout(40000),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        output_config: { effort: 'medium' },
        system,
        messages: [{ role: 'user', content: user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      }),
    })

  let res
  try {
    res = await doFetch()
    // 일시적 과부하(429/529/5xx)는 짧게 기다렸다 1회 재시도
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500))
      res = await doFetch()
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error('AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.')
    }
    throw err
  }

  if (!res.ok) {
    throw new Error(`AI 서비스가 혼잡합니다 (${res.status}). 잠시 후 다시 시도해주세요.`)
  }

  const data = await res.json()
  // max_tokens로 잘린 tool 입력은 불완전한 JSON일 수 있으므로 toolUse 존재 여부와 무관하게 거부한다.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('AI 응답이 너무 길어 중단되었습니다. 입력을 줄여 다시 시도해주세요.')
  }
  const toolUse = Array.isArray(data.content)
    ? data.content.find((block) => block.type === 'tool_use')
    : null
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw new Error('AI 응답에서 결과를 찾을 수 없습니다. 잠시 후 다시 시도해주세요.')
  }
  const usage = data.usage
    ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
    : null
  return { input: toolUse.input, usage }
}

// live 응답이 프론트가 기대하는 계약(필수 배열/문자열)을 지키는지 검증한다.
// tool_choice 강제로도 스키마 준수가 보장되지 않으므로, 어긴 응답은 폴백으로 돌려보낸다.
export function ensureContract(input, { arrays = [], strings = [] } = {}) {
  for (const key of arrays) {
    if (!Array.isArray(input[key])) {
      throw new Error(`AI 응답이 불완전합니다(${key} 누락). 다시 시도해주세요.`)
    }
  }
  for (const key of strings) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      throw new Error(`AI 응답이 불완전합니다(${key} 누락). 다시 시도해주세요.`)
    }
  }
  return input
}

// 공용 상담 도메인 안전 규칙 — 모든 LLM 프롬프트에 포함
export const CALL_SAFETY_RULES = `[상담 데이터 처리 안전 규칙 — 반드시 지킬 것]
- 통화 내용에 등장하는 이름·전화번호·주소 등 개인정보는 결과에 그대로 옮기지 말고 "고객"으로 일반화할 것
- 법적 분쟁, 소송 언급, 강성 민원, 보상 요구 건은 AI가 결론 내리지 말고 에스컬레이션으로 표시할 것
- 상담사나 고객에 대한 인신공격성 평가 금지 — 행동과 표현만 평가할 것
- 근거 없는 사실 단정 금지 — 통화 텍스트에 없는 내용을 지어내지 말 것`
