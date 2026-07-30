import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import {
  checkMentions,
  scanForbidden,
  agentLines,
  computeQaScore,
  buildCustomMentions,
  mentionRuleSet,
  REQUIRED_MENTIONS,
  applyConsistencyBand,
  hasSpeakerLabels,
} from '../../../src/lib/qaRules.js'

const MAX_CHARS = 8000

const TOOL = {
  name: 'record_qa_review',
  description: '상담사 응대 품질을 정성 평가한다. 점수는 각 항목 0~20 정수.',
  input_schema: {
    type: 'object',
    required: ['empathy', 'clarity', 'resolution', 'comments', 'coaching'],
    properties: {
      empathy: { type: 'integer', description: '공감·경청 (0~20): 사과·공감 표현, 고객 말 끊지 않기' },
      clarity: { type: 'integer', description: '전달 명확성 (0~20): 금액·일정·절차를 구체적 수치로 안내했는가' },
      resolution: { type: 'integer', description: '문제 해결력 (0~20): 원인 파악, 대안 제시, 다음 단계 확정' },
      comments: {
        type: 'array',
        items: { type: 'string' },
        description: '각 점수의 근거가 된 실제 발화를 인용한 코멘트 2~4개 (인용 없는 추정 금지)',
      },
      coaching: { type: 'string', description: '상담사에게 주는 코칭 한 줄 (행동 중심, 인신공격 금지)' },
    },
  },
}

const SYSTEM = `당신은 콜센터 QA(품질 평가) 전문가입니다. 통화 전사에서 상담사의 응대 품질을 평가합니다.

규칙:
1. 통화에 실제로 나온 발화만 근거로 쓰세요. 없는 내용을 추정해 감점·가점하지 마세요.
2. 점수는 반드시 아래 행동 앵커에 맞춰 매기세요 (각 항목 0~20):
   - 0~4: 결정적 결함 — 반말·책임 회피·잘못된 안내가 실제 발화로 확인됨
   - 5~8: 미흡 — 사과·해결 시도는 있으나 구체성 없음
   - 9~12: 보통 — 기본 응대는 수행, 선제적 안내 부족
   - 13~16: 양호 — 구체 수치·절차 안내, 공감 표현 확인됨
   - 17~20: 모범 — 선제 안내 + 대안 제시 + 다음 단계 확정까지 모두 확인됨
3. 점수를 매기기 전에 근거 발화를 먼저 인용하고, 인용된 발화만으로 점수를 정하세요.
4. 코칭은 "무엇을 어떻게 바꿔라" 형태의 행동 지침 한 줄로 쓰세요.
${CALL_SAFETY_RULES}`

// 데모·폴백용 LLM 정성 평가 모사 — 규칙 층 결과에 비례한 보수적 추정치
function demoLlmReview(mentions, findings) {
  const ratio = mentions.filter((m) => m.found).length / mentions.length
  const penalty = Math.min(findings.length * 3, 8)
  const base = Math.round(8 + ratio * 10 - penalty)
  const score = Math.max(2, Math.min(18, base))
  return {
    empathy: score,
    clarity: score,
    resolution: score,
    comments: [
      `필수 안내 멘트 ${mentions.filter((m) => m.found).length}/${mentions.length}개 이행이 확인되었습니다.`,
      findings.length > 0
        ? `금지 표현 ${findings.length}건이 규칙 스캔에서 발견되어 정성 점수를 보수적으로 추정했습니다.`
        : '금지 표현이 발견되지 않았습니다.',
    ],
    coaching:
      findings.length > 0
        ? '규칙 스캔에 걸린 표현을 대체 화법으로 바꾸는 연습이 필요합니다.'
        : '현재 응대 구조를 유지하되, 처리 기한을 숫자로 못박아 안내하면 더 좋습니다.',
  }
}

const clampScore = (n) => Math.max(0, Math.min(20, Math.round(Number(n) || 0)))

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const transcript = typeof body?.transcript === 'string' ? body.transcript.trim().slice(0, MAX_CHARS) : ''
  if (!transcript) return errorJson('통화 전사 텍스트를 입력해주세요.')

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()

  // 1층: 규칙 기반 스캔 — 결정적이므로 데모·라이브 관계없이 항상 실제로 수행한다.
  // 커스텀 체크리스트가 오면 40점을 내장+커스텀에 균등 재배분해 같은 만점을 유지한다.
  const customs = buildCustomMentions(body?.custom_mentions)
  const ruleSet = customs.length ? mentionRuleSet(customs) : REQUIRED_MENTIONS
  const agentText = agentLines(transcript)
  const mentions = checkMentions(agentText, ruleSet)
  const findings = scanForbidden(agentText)
  // 화자 라벨이 없으면 고객 발화까지 상담사 감점으로 잡힌다. 점수를 바꾸지는 않되
  // 그 사실을 응답에 실어 화면이 표시할 수 있게 한다.
  const speakerLabeled = hasSpeakerLabels(transcript)

  const respond = (llm, extra = {}) => {
    const score = computeQaScore({ mentions, findings, llm })
    return json({ mentions, findings, score, speaker_labeled: speakerLabeled, ...extra })
  }

  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)

  if (!canClaude && !canWorkers) {
    const demo = demoLlmReview(mentions, findings)
    logCall(context, { endpoint: 'qa', mode: 'demo', startedAt, findingsCount: findings.length })
    // llm을 null로 넘겨 점수가 "추정치"로 표시되게 한다. 데모 객체를 그대로 넘기면
    // computeQaScore가 실측 LLM 평가와 구분하지 못해 추정 라벨이 사라진다.
    return respond(null, { demo: true, comments: demo.comments, coaching: demo.coaching })
  }

  // 검사 순서가 중요하다: 거부될 요청이 공유 예산을 먼저 태우면 한 IP가 전체 서비스의
  // 하루치를 소진시킬 수 있다. 좁은 제한(IP)부터 확인하고 일일 예산은 마지막에 차감한다.
  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:qa:${ip}`, 6, 3600)))
    return errorJson('품질 평가는 시간당 6회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:qa:all', 40, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400))) {
    const demo = demoLlmReview(mentions, findings)
    logCall(context, { endpoint: 'qa', mode: 'budget', startedAt, findingsCount: findings.length })
    return respond(null, {
      demo: true,
      comments: demo.comments,
      coaching: demo.coaching,
      notice: '오늘의 라이브 평가 예산이 소진되어 정성 평가는 추정치로 표시합니다.',
    })
  }

  try {
    const userPrompt = `[통화 전사]\n${transcript}\n\n[규칙 스캔 결과 참고]\n필수 멘트 이행: ${mentions
      .map((m) => `${m.label}=${m.found ? 'O' : 'X'}`)
      .join(', ')}\n금지 표현: ${findings.length ? findings.map((f) => `"${f.word}"`).join(', ') : '없음'}\n\n상담사 응대 품질을 평가해 기록하세요.`
    const r = await runLlmLadder(env, {
      system: SYSTEM,
      user: userPrompt,
      tool: TOOL,
      maxTokens: 6144,
      workersSchema:
        '{"empathy":0~20 정수,"clarity":0~20 정수,"resolution":0~20 정수,"comments":["근거 2~4개"],"coaching":"한 줄"}',
      workersMaxTokens: 1024,
    })
    const result = r.input
    ensureContract(result, { arrays: ['comments'], strings: ['coaching'] })
    // 일관성 밴드 — 결정적 규칙 신호로 만든 기대 구간을 벗어난 점수를 보정해
    // 같은 통화의 실행 간 점수 편차를 좁힌다 (보정 시 정직하게 표시)
    const banded = applyConsistencyBand(
      {
        empathy: clampScore(result.empathy),
        clarity: clampScore(result.clarity),
        resolution: clampScore(result.resolution),
      },
      { mentions, findings }
    )
    const llm = banded.llm
    logCall(context, {
      endpoint: 'qa',
      mode: r.engine === 'claude' ? 'live' : 'live-oss',
      startedAt,
      usage: r.usage,
      findingsCount: findings.length,
    })
    return respond(llm, {
      demo: false,
      usage: r.usage,
      llm_model: r.model,
      llm_adjusted: banded.adjusted,
      comments: result.comments.slice(0, 4),
      coaching: result.coaching,
    })
  } catch (err) {
    const demo = demoLlmReview(mentions, findings)
    logCall(context, { endpoint: 'qa', mode: 'fallback', startedAt, findingsCount: findings.length })
    return respond(null, {
      demo: true,
      comments: demo.comments,
      coaching: demo.coaching,
      notice: `일시적인 AI 혼잡으로 정성 평가는 추정치로 표시합니다. (${err.message})`,
    })
  }
}
