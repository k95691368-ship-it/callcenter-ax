import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import { verifyReportNumbers } from '../../../src/lib/reportNumbers.js'

// VOC 집계를 LLM이 읽고 경영 보고용 인사이트 리포트를 쓴다 — "분석이 쌓여
// 인사이트가 된다"의 마지막 단계. 개인 통화 내용이 아닌 집계 수치만 전달한다.

const TOOL = {
  name: 'record_voc_report',
  description: 'VOC 집계 수치를 근거로 콜센터 운영 인사이트 리포트를 기록한다.',
  input_schema: {
    type: 'object',
    required: ['headline', 'findings', 'recommendations'],
    properties: {
      headline: { type: 'string', description: '리포트 핵심 한 줄 (수치 포함)' },
      findings: {
        type: 'array',
        items: { type: 'string' },
        description: '집계에서 읽어낸 핵심 발견 2~3개 (반드시 주어진 수치만 근거로)',
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
        description: '운영 개선 권고 액션 2개 (실행 가능한 수준으로 구체적으로)',
      },
    },
  },
}

const SYSTEM = `당신은 콜센터 운영 분석가입니다. VOC 집계 수치를 근거로 짧은 운영 리포트를 작성합니다.

규칙:
1. 주어진 집계 수치만 근거로 쓰세요 — 없는 수치를 지어내지 마세요.
2. findings는 "무엇이 몰리는가, 어디서 강성이 나오는가" 관점으로.
3. recommendations는 담당자가 내일 실행할 수 있는 구체적 액션으로.
${CALL_SAFETY_RULES}`

function demoReport(stats) {
  const top = [...(stats.byCategory || [])].sort((a, b) => b.count - a.count)[0]
  return {
    demo: true,
    headline: `총 ${stats.total}건 중 ${top ? `'${top.name}' 유형이 ${top.count}건으로 최다` : '유형별 분포 확인 필요'}, 에스컬레이션 ${stats.escalatedCount}건 대기`,
    findings: [
      top ? `${top.name} 문의가 ${top.count}건으로 가장 많아 반복 문의 소지가 있습니다.` : '집계 데이터가 부족합니다.',
      `강성·부정 감정 통화가 전체의 일부를 차지해 품질 모니터링이 필요합니다.`,
    ],
    recommendations: [
      top ? `${top.name} 유형의 자주 묻는 절차를 상담 스크립트/ARS 안내로 선제 제공` : '유형별 분류 데이터 축적',
      '에스컬레이션 대기 건의 회신 기한 준수 여부를 일일 점검',
    ],
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  // 집계 항목은 개수만 자르는 것으로는 부족하다. 이름 문자열이 그대로 프롬프트에
  // 들어가므로 길이를 제한하지 않으면 요청 하나로 수 MB짜리 유료 프롬프트를 만들 수 있다.
  // 숫자도 함께 정규화해 문자열이 섞여 들어오는 것을 막는다(리포트 숫자 검증의 전제).
  const normalizeBuckets = (raw) =>
    (Array.isArray(raw) ? raw : []).slice(0, 8).map((b) => ({
      name: String(b?.name ?? '').slice(0, 20),
      count: Math.max(0, Math.min(Number(b?.count) || 0, 100000)),
    }))
  const stats = {
    total: Math.max(0, Math.min(Number(body?.total) || 0, 100000)),
    byCategory: normalizeBuckets(body?.byCategory),
    bySentiment: normalizeBuckets(body?.bySentiment),
    escalatedCount: Math.max(0, Math.min(Number(body?.escalatedCount) || 0, 100000)),
    escalatedTitles: (Array.isArray(body?.escalatedTitles) ? body.escalatedTitles : [])
      .slice(0, 6)
      .map((t) => String(t ?? '').slice(0, 40)),
  }
  if (stats.total <= 0) return errorJson('집계할 통화 데이터가 없습니다.')

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()
  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)

  if (!canClaude && !canWorkers) {
    logCall(context, { endpoint: 'voc-report', mode: 'demo', startedAt })
    return json(demoReport(stats))
  }
  // 검사 순서가 중요하다: 거부될 요청이 공유 예산을 먼저 태우면 한 IP가 전체 서비스의
  // 하루치를 소진시킬 수 있다. 좁은 제한(IP)부터 확인하고 일일 예산은 마지막에 차감한다.
  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:vocreport:${ip}`, 6, 3600)))
    return errorJson('리포트 생성은 시간당 6회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:vocreport:all', 40, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400))) {
    logCall(context, { endpoint: 'voc-report', mode: 'budget', startedAt })
    return json({ ...demoReport(stats), notice: '오늘의 라이브 예산이 소진되어 예시 리포트를 표시합니다.' })
  }

  const userPrompt = `[VOC 집계]
총 통화: ${stats.total}건
유형별: ${stats.byCategory.map((c) => `${c.name} ${c.count}건`).join(', ')}
감정별: ${stats.bySentiment.map((s) => `${s.name} ${s.count}건`).join(', ')}
에스컬레이션 대기: ${stats.escalatedCount}건${stats.escalatedTitles.length ? ` (${stats.escalatedTitles.join(' / ')})` : ''}

위 집계만 근거로 운영 리포트를 기록하세요.`

  try {
    const r = await runLlmLadder(env, {
      system: SYSTEM,
      user: userPrompt,
      tool: TOOL,
      maxTokens: 4096,
      workersSchema: '{"headline":"한 줄","findings":["발견 2~3개"],"recommendations":["권고 2개"]}',
      workersMaxTokens: 1024,
    })
    const result = r.input
    ensureContract(result, { stringArrays: ['findings', 'recommendations'], strings: ['headline'] })
    // 숫자 검증 게이트 — 리포트 속 숫자가 실제 집계(또는 파생 퍼센트)에 존재하는지 대조.
    // 권고(recommendations)도 함께 검사한다. 예전에는 headline·findings만 봤는데,
    // 권고문에도 "3일 내", "20% 감축" 같은 숫자가 들어가므로 검증 밖에 두면
    // 화면의 "숫자 검증 통과"가 검사하지 않은 문장까지 보증하는 것처럼 읽힌다.
    const numCheck = verifyReportNumbers(
      [result.headline, ...result.findings, ...result.recommendations],
      stats
    )
    logCall(context, { endpoint: 'voc-report', mode: r.engine === 'claude' ? 'live' : 'live-oss', startedAt, usage: r.usage })
    return json({
      demo: false,
      usage: r.usage,
      llm_model: r.model,
      headline: result.headline,
      findings: result.findings.slice(0, 3),
      recommendations: result.recommendations.slice(0, 3),
      numbers_verified: numCheck.ok,
      ...(numCheck.ok
        ? {}
        : { notice: `리포트에 집계에 없는 수치(${numCheck.unknown.join(', ')})가 포함되어 있습니다 — 집계 원본과 대조해 확인해주세요.` }),
    })
  } catch (err) {
    logCall(context, { endpoint: 'voc-report', mode: 'fallback', startedAt })
    return json({ ...demoReport(stats), notice: `일시적인 AI 혼잡으로 예시 리포트를 표시합니다. (${err.message})` })
  }
}
