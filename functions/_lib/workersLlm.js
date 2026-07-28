// Workers AI 오픈소스 LLM 폴백 — CLAUDE_API_KEY가 없어도 라이브 AI 분석을 제공한다.
// 서열: Claude Opus 5(키 등록 시) → 이 모듈(오픈소스 Llama, 키 불필요) → 규칙 기반 데모.
// 공고의 "오픈소스 AI 모델 활용" 요건에 대응하는 층이기도 하다.

export const WORKERS_LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export function hasWorkersAi(env) {
  return Boolean(env.AI)
}

// 응답 텍스트에서 첫 '{'부터 마지막 '}'까지를 JSON으로 파싱한다.
// 오픈소스 모델은 JSON 앞뒤에 설명을 붙이는 일이 잦아 방어적으로 잘라낸다.
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('AI 응답이 비어 있습니다.')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('AI 응답에서 JSON을 찾을 수 없습니다.')
  return JSON.parse(text.slice(start, end + 1))
}

// 시스템+유저 프롬프트로 JSON 객체를 받아온다. 반환: { input, model }
export async function callWorkersJson(env, { system, user, maxTokens = 1024 }) {
  if (!env.AI) throw new Error('AI 바인딩이 없습니다.')
  const result = await Promise.race([
    env.AI.run(WORKERS_LLM_MODEL, {
      messages: [
        {
          role: 'system',
          content: `${system}\n\n[출력 형식 — 반드시 지킬 것]\n다른 설명 없이 유효한 JSON 객체 하나만 출력하세요. 마크다운 코드펜스 금지.`,
        },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('오픈소스 LLM 응답이 지연되고 있습니다.')), 40000)
    ),
  ])
  // Workers AI 응답 형태는 모델에 따라 {response} 또는 OpenAI 호환 {choices[0].message.content}
  const text =
    typeof result?.response === 'string' && result.response
      ? result.response
      : typeof result?.choices?.[0]?.message?.content === 'string'
        ? result.choices[0].message.content
        : ''
  return { input: extractJson(text), model: WORKERS_LLM_MODEL }
}
