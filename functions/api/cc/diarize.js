import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import { preservesOriginal, MAX_DIARIZE_CER } from '../../../src/lib/diarizeGuard.js'

// 간이 화자 분리 — Whisper 전사(화자 구분 없는 통짜 텍스트)를 상담사:/고객: 형식으로
// 재구성한다. Auto QA의 "상담사 발화만 평가" 규칙 층이 STT 결과에도 동작하게 만드는
// 파이프라인 연결 단계다. (음향 기반 diarization이 아닌 NLP 기반 근사)

const MAX_CHARS = 6000

const TOOL = {
  name: 'record_diarization',
  description: '통짜 통화 전사를 화자별(상담사/고객)로 재구성한다.',
  input_schema: {
    type: 'object',
    required: ['formatted'],
    properties: {
      formatted: {
        type: 'string',
        description: '각 발화를 "상담사: ..." 또는 "고객: ..." 줄로 재구성한 전문. 원문 단어를 바꾸지 말 것',
      },
    },
  },
}

const SYSTEM = `당신은 콜센터 녹취 전사의 화자 분리 전문가입니다. 화자 구분이 없는 전사를 발화 단위로 나누고 각 줄 앞에 "상담사: " 또는 "고객: "을 붙입니다.

규칙:
1. 원문 단어를 절대 바꾸거나 추가·삭제하지 마세요 — 줄 나누기와 화자 라벨만 붙입니다.
2. 인사·안내·처리 발화는 상담사, 문의·요구·항의 발화는 고객일 가능성이 높습니다.
3. 이미 화자 라벨이 있는 부분은 그대로 유지하세요.
${CALL_SAFETY_RULES}`

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const full = typeof body?.transcript === 'string' ? body.transcript.trim() : ''
  const transcript = full.slice(0, MAX_CHARS)
  // 잘린 사실을 응답에 실어 보낸다 — 프론트가 남은 뒷부분을 원문으로 살릴 수 있도록.
  const truncation = full.length > MAX_CHARS ? { truncated: true, processed_chars: transcript.length } : {}
  if (!transcript) return errorJson('전사 텍스트를 입력해주세요.')

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()
  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)

  // LLM이 전혀 없으면 원문 그대로 반환해 흐름을 유지한다
  if (!canClaude && !canWorkers) {
    logCall(context, { endpoint: 'diarize', mode: 'demo', startedAt })
    return json({ demo: true, formatted: transcript, ...truncation, notice: 'AI 미연결 환경이라 화자 분리 없이 원문을 유지합니다.' })
  }

  // 검사 순서가 중요하다: 거부될 요청이 공유 예산을 먼저 태우면 한 IP가 전체 서비스의
  // 하루치를 소진시킬 수 있다. 좁은 제한(IP)부터 확인하고 일일 예산은 마지막에 차감한다.
  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:diarize:${ip}`, 8, 3600)))
    return errorJson('화자 분리는 시간당 8회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:diarize:all', 50, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400))) {
    logCall(context, { endpoint: 'diarize', mode: 'budget', startedAt })
    return json({ demo: true, formatted: transcript, ...truncation, notice: '오늘의 라이브 예산이 소진되어 원문을 유지합니다.' })
  }

  try {
    const userPrompt = `[화자 구분 없는 전사]\n${transcript}\n\n화자를 분리해 기록하세요.`
    const r = await runLlmLadder(env, {
      system: SYSTEM,
      user: userPrompt,
      tool: TOOL,
      maxTokens: 6144,
      workersSchema: '{"formatted":"상담사: ...\\n고객: ... 형식의 전문"}',
      workersMaxTokens: 1536,
    })
    ensureContract(r.input, { strings: ['formatted'] })
    // 원문 보존 게이트 — LLM이 단어를 바꿨으면(CER>15%) 분리 결과를 버리고 원문을 지킨다
    const guard = preservesOriginal(transcript, r.input.formatted)
    if (!guard.ok) {
      logCall(context, { endpoint: 'diarize', mode: 'guarded', startedAt, usage: r.usage })
      return json({
        demo: true,
        formatted: transcript,
        ...truncation,
        guarded: true,
        notice: guard.unverifiable
          ? '화자 분리 결과가 너무 길어 원문 보존을 검증할 수 없어 원문을 유지합니다 (원문 보존 게이트).'
          : `화자 분리 결과가 원문과 ${Math.round(MAX_DIARIZE_CER * 100)}% 넘게 달라 원문을 유지합니다 (원문 보존 게이트).`,
      })
    }
    logCall(context, { endpoint: 'diarize', mode: r.engine === 'claude' ? 'live' : 'live-oss', startedAt, usage: r.usage })
    return json({
      demo: false,
      usage: r.usage,
      llm_model: r.model,
      formatted: r.input.formatted,
      ...truncation,
      preserved_cer: Math.round(guard.cer * 1000) / 1000,
      notice: truncation.truncated
        ? `전사가 길어 앞 ${transcript.length}자에만 화자 분리를 적용했습니다. 나머지는 원문 그대로 이어 붙였습니다.`
        : undefined,
    })
  } catch (err) {
    logCall(context, { endpoint: 'diarize', mode: 'fallback', startedAt })
    return json({ demo: true, formatted: transcript, ...truncation, notice: `일시적인 AI 혼잡으로 원문을 유지합니다. (${err.message})` })
  }
}
