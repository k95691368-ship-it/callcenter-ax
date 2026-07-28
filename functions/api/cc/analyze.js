import { json, errorJson, readJsonBody, clientIp } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { callClaudeTool, ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { callWorkersJson, hasWorkersAi } from '../../_lib/workersLlm.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'

const MAX_CHARS = 8000

const TOOL = {
  name: 'record_call_analysis',
  description: '콜센터 통화 전사 텍스트를 분류·요약하고 감정과 후속 조치, 에스컬레이션 여부를 기록한다.',
  input_schema: {
    type: 'object',
    required: ['category', 'summary', 'sentiment', 'intent_keywords', 'actions', 'escalate'],
    properties: {
      category: {
        type: 'string',
        enum: ['가입', '해지', '요금', '불만', '기타'],
        description: '문의 유형',
      },
      summary: {
        type: 'array',
        items: { type: 'string' },
        description: '통화 내용 3줄 요약 (각 줄 40자 내외)',
      },
      sentiment: {
        type: 'string',
        enum: ['긍정', '중립', '부정', '강성'],
        description: '고객 감정. 위협·법적 언급·고성 정황은 강성',
      },
      sentiment_reason: { type: 'string', description: '감정 판정 근거 한 줄' },
      intent_keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '고객 의도 키워드 3~5개 (예: 요금제 하향, 위약금 면제)',
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
        description: '상담사/후속 부서가 해야 할 조치 제안 2~4개',
      },
      escalate: {
        type: 'boolean',
        description: '사람 담당자의 판단이 필요한 건이면 true (법적 클레임, 강성 민원, 보상·감면 요구, 분쟁 소지)',
      },
      escalate_reason: { type: ['string', 'null'], description: 'escalate가 true인 이유 한 줄' },
    },
  },
}

const SYSTEM = `당신은 콜센터 통화 분석 어시스턴트입니다. 녹취 전사 텍스트를 읽고 구조화된 분석을 기록합니다.

규칙:
1. 요약은 정확히 3줄, 통화에 실제로 나온 내용만 담으세요.
2. **에스컬레이션 원칙 (가장 중요)**: 법적 조치·언론 제보 언급, 강성 민원, 위약금 면제·보상 요구, 본인 미사용 주장(요금 이의) 건은 escalate=true로 표시하고, 조치 제안은 "전문 부서 이관·회신 기한 안내" 수준의 보수적 내용만 쓰세요. AI가 감면·보상 여부를 결론 내리지 마세요 — 반복은 대체하고 판단은 남깁니다.
3. actions는 실행 가능한 구체적 조치로 쓰세요 (예: "이전 설치 가능 여부 조회 후 회신").
${CALL_SAFETY_RULES}`

// 키가 없거나 라이브 실패 시 쓰는 규칙 기반 데모 분석 — 키워드 휴리스틱
export function demoAnalyze(transcript) {
  const t = transcript || ''
  const hot = /(소송|법적|신고|언론|제보|사기|고소)/.test(t)
  const angry = hot || /(말도 안|당장|화가|어이가 없)/.test(t)

  let category = '기타'
  if (/(해지|위약금|이전 설치)/.test(t)) category = '해지'
  else if (/(요금|청구|납부|이체|과금)/.test(t)) category = '요금'
  else if (/(가입|결합|신규|설치)/.test(t)) category = '가입'
  if (angry || /(불만|항의|세 번째|또 느려)/.test(t)) category = /(해지|위약금)/.test(t) ? '해지' : '불만'

  const escalate = hot || /(위약금.*(면제|빼)|보상|감면)/.test(t)
  const sentiment = angry ? '강성' : /(감사|친절|좋네요|만족)/.test(t) ? '긍정' : /(죄송|불편|느려|안 와)/.test(t) ? '부정' : '중립'

  return {
    demo: true,
    category,
    summary: [
      '고객이 ' + (category === '기타' ? '일반 문의' : `${category} 관련 요청`) + '으로 연락함',
      escalate ? '분쟁 소지가 있어 상담사가 전문 부서 이관을 안내함' : '상담사가 절차와 처리 방안을 안내함',
      '후속 조치와 회신 일정이 안내됨',
    ],
    sentiment,
    sentiment_reason: angry ? '위협·강한 항의 표현이 확인됨' : '발화 어조 기반 추정',
    intent_keywords: [category, escalate ? '보상·감면 요구' : '절차 문의'].filter(Boolean),
    actions: escalate
      ? ['전문 부서로 이관하고 회신 기한을 고객에게 안내', '접수 번호 문자 발송']
      : ['안내한 처리 건 진행 상태 확인', '처리 완료 후 해피콜'],
    escalate,
    escalate_reason: escalate ? '법적 언급·감면 요구 등 사람의 판단이 필요한 건' : null,
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const transcript = typeof body?.transcript === 'string' ? body.transcript.trim().slice(0, MAX_CHARS) : ''
  if (!transcript) return errorJson('통화 전사 텍스트를 입력해주세요.')

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()

  // 라이브 사다리: Claude(키 등록 시) → 오픈소스 LLM(Workers AI) → 규칙 기반 데모
  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)

  if (!canClaude && !canWorkers) {
    logCall(context, { endpoint: 'analyze', mode: 'demo', startedAt })
    return json(demoAnalyze(transcript))
  }

  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400))) {
    return json({ ...demoAnalyze(transcript), notice: '오늘의 라이브 분석 예산이 소진되어 예시 결과를 표시합니다.' })
  }

  const ip = clientIp(request)
  if (!(await checkRateLimit(env, `cc:analyze:${ip}`, 6, 3600)))
    return errorJson('통화 분석은 시간당 6회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:analyze:all', 40, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)

  try {
    const userPrompt = `[콜센터 통화 전사]\n${transcript}\n\n위 통화를 분석해 기록하세요.`
    let result
    let usage = null
    let llmModel = null
    if (canClaude) {
      const r = await callClaudeTool(env, { system: SYSTEM, user: userPrompt, tool: TOOL, maxTokens: 6144 })
      result = r.input
      usage = r.usage
    } else {
      const r = await callWorkersJson(env, {
        system: `${SYSTEM}\n\nJSON 스키마: {"category":"가입|해지|요금|불만|기타","summary":["3줄"],"sentiment":"긍정|중립|부정|강성","sentiment_reason":"...","intent_keywords":["..."],"actions":["..."],"escalate":true|false,"escalate_reason":"...또는 null"}`,
        user: userPrompt,
        maxTokens: 1024,
      })
      result = r.input
      llmModel = r.model
    }
    ensureContract(result, {
      arrays: ['summary', 'intent_keywords', 'actions'],
      strings: ['category', 'sentiment'],
    })
    result.summary = result.summary.slice(0, 3)
    result.escalate = Boolean(result.escalate)
    logCall(context, { endpoint: 'analyze', mode: canClaude ? 'live' : 'live-oss', startedAt, usage })
    return json({ demo: false, usage, llm_model: llmModel, ...result })
  } catch (err) {
    logCall(context, { endpoint: 'analyze', mode: 'fallback', startedAt })
    return json({ ...demoAnalyze(transcript), notice: `일시적인 AI 혼잡으로 예시 결과를 표시합니다. (${err.message})` })
  }
}
