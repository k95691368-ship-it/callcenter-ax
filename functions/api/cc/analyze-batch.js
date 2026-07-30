import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import { demoAnalyze } from './analyze.js'
import { MAX_BATCH_CALLS, MAX_CALL_CHARS } from '../../../src/lib/batchSplit.js'

// 일괄 분석 — 분석 코어의 "단건 처리" 한계 돌파.
// 여러 통화를 LLM 호출 "1회"로 함께 구조화한다 (레이트리밋 1회 소비로 최대 5건).
// 상담 후처리(after-call work)가 건별이 아니라 묶음으로 흐르는 실무 동선에 대응.

const TOOL = {
  name: 'record_batch_analysis',
  description: '여러 콜센터 통화를 한 번에 분석해 건별 결과 배열로 기록한다.',
  input_schema: {
    type: 'object',
    required: ['calls'],
    properties: {
      calls: {
        type: 'array',
        description: '입력 통화와 같은 순서·같은 개수의 분석 결과 배열',
        items: {
          type: 'object',
          required: ['category', 'sentiment', 'summary', 'escalate'],
          properties: {
            category: { type: 'string', description: '가입|해지|요금|불만|기타 중 하나' },
            sentiment: { type: 'string', description: '긍정|중립|부정|강성 중 하나' },
            summary: { type: 'string', description: '핵심 한 줄 요약' },
            escalate: { type: 'boolean', description: '법적 클레임·강성 민원 등 사람 판단 필요 여부' },
            escalate_reason: { type: 'string', description: '에스컬레이션 사유 (없으면 빈 문자열)' },
          },
        },
      },
    },
  },
}

const SYSTEM = `당신은 콜센터 통화 일괄 분석가입니다. 여러 통화를 받아 건별로 분류·요약합니다.

규칙:
1. 반드시 입력 통화와 같은 순서, 같은 개수로 결과를 기록하세요.
2. 각 통화에 실제로 나온 내용만 근거로 쓰세요.
3. 법적 클레임·언론 제보·강성 민원·보상 요구는 escalate=true로 올리세요.
${CALL_SAFETY_RULES}`

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const transcripts = (Array.isArray(body?.transcripts) ? body.transcripts : [])
    .map((t) => (typeof t === 'string' ? t.trim().slice(0, MAX_CALL_CHARS) : ''))
    .filter(Boolean)
    .slice(0, MAX_BATCH_CALLS)
  if (transcripts.length < 2) return errorJson('일괄 분석은 통화 2건 이상부터 가능합니다. (빈 줄 2개로 구분)')

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()
  const demoAll = () => ({
    demo: true,
    calls: transcripts.map((t) => {
      const d = demoAnalyze(t)
      return {
        category: d.category,
        sentiment: d.sentiment,
        summary: (d.summary || [])[0] || '',
        escalate: Boolean(d.escalate),
        escalate_reason: d.escalate_reason || '',
      }
    }),
  })

  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)
  if (!canClaude && !canWorkers) {
    logCall(context, { endpoint: 'analyze-batch', mode: 'demo', startedAt })
    return json(demoAll())
  }
  // 검사 순서가 중요하다: 거부될 요청이 공유 예산을 먼저 태우면 한 IP가 전체 서비스의
  // 하루치를 소진시킬 수 있다. 좁은 제한(IP)부터 확인하고 일일 예산은 마지막에 차감한다.
  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:analyzebatch:${ip}`, 4, 3600)))
    return errorJson('일괄 분석은 시간당 4회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:analyzebatch:all', 20, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400))) {
    logCall(context, { endpoint: 'analyze-batch', mode: 'budget', startedAt })
    return json({ ...demoAll(), notice: '오늘의 라이브 예산이 소진되어 예시 결과를 표시합니다.' })
  }

  try {
    const userPrompt = transcripts
      .map((t, i) => `[통화 ${i + 1}]\n${t}`)
      .join('\n\n')
      .concat(`\n\n위 ${transcripts.length}건을 순서대로 모두 분석해 기록하세요.`)
    const r = await runLlmLadder(env, {
      system: SYSTEM,
      user: userPrompt,
      tool: TOOL,
      maxTokens: 6144,
      workersSchema:
        '{"calls":[{"category":"가입|해지|요금|불만|기타","sentiment":"긍정|중립|부정|강성","summary":"한 줄","escalate":true|false,"escalate_reason":"...또는 빈 문자열"}] — 입력과 같은 개수·순서}',
      workersMaxTokens: 1536,
    })
    const result = r.input
    ensureContract(result, { arrays: ['calls'] })
    if (result.calls.length !== transcripts.length)
      throw new Error('결과 개수가 입력과 다릅니다. 다시 시도해주세요.')
    const calls = result.calls.map((c) => ({
      category: String(c?.category || '기타'),
      sentiment: String(c?.sentiment || '중립'),
      summary: String(c?.summary || ''),
      escalate: Boolean(c?.escalate),
      escalate_reason: String(c?.escalate_reason || ''),
    }))
    logCall(context, {
      endpoint: 'analyze-batch',
      mode: r.engine === 'claude' ? 'live' : 'live-oss',
      startedAt,
      usage: r.usage,
      findingsCount: calls.length,
    })
    return json({ demo: false, usage: r.usage, llm_model: r.model, calls })
  } catch (err) {
    logCall(context, { endpoint: 'analyze-batch', mode: 'fallback', startedAt })
    return json({ ...demoAll(), notice: `일시적인 AI 혼잡으로 예시 결과를 표시합니다. (${err.message})` })
  }
}
