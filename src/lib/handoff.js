// 파이프라인 처리 상태 — "그래서 이 통화는 어떻게 처리됐는가"를 닫는 층.
//
// 왜 이 파일이 생겼는가:
// 원클릭 파이프라인은 6단계(STT→보정→화자분리→분석→QA→VOC)를 돌고 결과를 화면에
// 남기고 끝났다. 재료는 이미 다 있었다 — 분석 응답의 ticket(부서·우선순위·SLA),
// churn(이탈 위험 + 근거 발화), QA 점수·코칭. 그런데 이어지지 않아서, 실행이 끝난
// 화면을 보고도 "이 통화는 어디로 가고, 누가 언제까지, 무엇을 확인해야 하는가"에
// 답할 수 없었다. 단계별 로그는 있는데 처리 결론이 없는 상태였다.
//
// 이 파일은 새 판단을 만들지 않는다. 이미 계산된 결과를 처리 상태 하나로 모을 뿐이고,
// 대신 **실패한 단계가 그 상태에 반드시 반영되게** 한다. 분석이 실패했는데
// "리텐션 팀 이관"이라고 적으면 그 문장에는 근거가 없다 — 부서 배정은 분석 응답의
// ticket에서만 나오기 때문이다. 그래서 분석이 없으면 배정도 없다(owner=null).
//
// 순수 함수라 LLM 키가 없어도 그대로 동작한다. 데모 응답도 같은 필드를 갖고 오므로
// 처리 상태는 라이브·데모 구분 없이 계산되고, 추정치인 사실만 확인 항목으로 남는다.

export const STAGE_IDS = ['stt', 'lex', 'dia', 'analyze', 'qa', 'voc']

// 단계 이름의 단일 출처 — 화면(PipelinePage)·리포트(pipelineReport)·처리 상태가
// 같은 단계를 다른 이름으로 부르면, 실패 보고를 받은 사람이 어느 단계인지 되묻게 된다.
export const STAGE_LABELS = {
  stt: '① 녹취 전사',
  lex: '② 도메인 보정',
  dia: '③ 화자 분리',
  analyze: '④ 통화 분석',
  qa: '⑤ Auto QA',
  voc: '⑥ VOC 누적',
}

// 실패 메시지("시간당 6회까지 가능합니다")만으로는 "그래서 처리에 뭐가 비었는가"를
// 알 수 없다. 단계별로 무엇이 비는지를 함께 적어야 다음 사람이 판단할 수 있다.
export const STAGE_IMPACT = {
  stt: '전사가 없어 이후 단계가 실행되지 않았습니다.',
  lex: '콜센터 도메인 용어 보정이 적용되지 않은 전사로 이후 단계가 실행됐습니다.',
  dia: '화자 라벨 없이 뒤 단계가 실행돼 상담사·고객 발화가 섞여 계산됐을 수 있습니다.',
  analyze: '문의 유형·이탈 위험·티켓 초안이 없습니다. 담당 부서는 사람이 정해야 합니다.',
  qa: '이번 통화의 품질 점수가 없어 코칭 이력에도 남지 않았습니다.',
  voc: 'VOC 대시보드 집계에서 이 통화가 빠져 있습니다.',
}

const LEVEL_RANK = { high: 0, warn: 1, info: 2 }

// 처리 상태를 만든다.
// 입력은 PipelinePage가 들고 있는 6단계 상태 그대로다(추가 호출·추가 계산 없음).
export function buildHandoff({ stt, lex, dia, analysis, qa, stageErrors, qaSaved = false } = {}) {
  const errors = stageErrors || {}

  const present = {
    stt: Boolean(stt?.text),
    lex: Boolean(lex),
    dia: Boolean(dia?.formatted),
    analyze: Boolean(analysis),
    qa: Boolean(qa?.score),
    // VOC 누적은 분석이 성공한 통화만 대상이다 (PipelinePage가 그렇게 동작한다).
    voc: Boolean(analysis) && !errors.voc,
  }

  const failed = STAGE_IDS.filter((id) => errors[id]).map((id) => ({
    id,
    label: STAGE_LABELS[id],
    message: String(errors[id]),
    impact: STAGE_IMPACT[id],
  }))
  const done = STAGE_IDS.filter((id) => present[id] && !errors[id])
  const pending = STAGE_IDS.filter((id) => !present[id] && !errors[id])

  // 실행 상태와 처리 결론은 다른 축이다. 둘을 한 문장에 뭉치면 "완료"가 "성공"으로
  // 읽힌다 — 실패한 단계가 있어도 남은 단계는 계속 도는 파이프라인이라 더 그렇다.
  const state = done.length === 0 ? 'none' : failed.length || pending.length ? 'partial' : 'complete'
  const run = {
    state,
    total: STAGE_IDS.length,
    done,
    pending,
    failed,
    label: runLabel(state, failed, pending),
  }

  const analyzed = present.analyze && !errors.analyze
  const ticket = analyzed ? analysis.ticket || null : null
  const churn = analyzed && Number.isFinite(analysis?.churn?.score) ? analysis.churn : null
  const score = present.qa && !errors.qa ? qa.score : null

  // 어디로 / 누가 / 언제까지 — 전부 분석 응답의 ticket.route에서만 나온다.
  // 여기서 규칙으로 부서를 다시 계산하지 않는다. 그렇게 하면 화면에 보이는 티켓 초안과
  // 처리 상태가 서로 다른 부서를 가리킬 수 있고, 두 답이 다르면 둘 다 못 믿게 된다.
  const owner = ticket?.route
    ? {
        team: ticket.route.team,
        priority: ticket.route.priority,
        sla: ticket.route.sla,
        reason: ticket.route.reason,
      }
    : null

  const status = buildStatus({ analyzed, owner, churn, failedAnalyze: failed.find((f) => f.id === 'analyze') })

  return {
    run,
    status,
    // 부분 실행이면 헤드라인에서부터 그렇게 읽혀야 한다. 상태 문구만 보고
    // "이관하면 되는군"으로 끝나면, 그 판단의 근거가 반쪽이라는 사실이 사라진다.
    headline: state === 'partial' ? `부분 실행 · ${status.label}` : status.label,
    owner,
    // "언제까지"는 SLA 문구 그대로 쓴다. 날짜로 환산하면 영업일·접수 시각을 모르는
    // 상태에서 없는 정보를 지어내는 셈이 된다.
    due: owner?.sla || null,
    title: ticket?.title || null,
    ticketText: ticket?.text || null,
    churn: churn
      ? {
          score: churn.score,
          level: churn.level,
          action: churn.action,
          estimated: Boolean(churn.estimated),
          signals: (churn.signals || []).map((s) => s.label),
        }
      : null,
    quality: score
      ? {
          total: score.total,
          grade: score.grade,
          estimated: Boolean(score.llmEstimated),
          coaching: qa.coaching || null,
        }
      : null,
    // 이 실행이 어디에 남았는가 — 남지 않았으면 남지 않았다고 적는다.
    records: {
      voc: present.voc,
      qaHistory: Boolean(qaSaved) && Boolean(score),
    },
    checks: buildChecks({ failed, analyzed, analysis, churn, qa, score, dia }),
    actions: buildActions({ ticket, present, qaSaved: Boolean(qaSaved) && Boolean(score) }),
  }
}

function runLabel(state, failed, pending) {
  if (state === 'none') return '실행 결과 없음'
  if (state === 'complete') return '6단계 전부 완료'
  if (failed.length) {
    return `부분 실행 — ${failed.length}개 단계 실패 (${failed.map((f) => f.label).join(', ')})`
  }
  // 아직 돌지 않은 단계는 개수만 적는다. 이름까지 나열하면 리포트 본문의 단계 제목과
  // 같은 문자열이 두 번 등장해, 문서를 훑는 사람이 그 단계 결과가 있다고 착각한다.
  return `부분 실행 — ${pending.length}개 단계 미실행`
}

// 처리 결론은 세 가지뿐이다: 이관 / 1선 종결 / 자동 배정 불가.
// 네 번째("아마 리텐션 팀")를 만들지 않는 것이 이 함수의 존재 이유다.
function buildStatus({ analyzed, owner, churn, failedAnalyze }) {
  if (!analyzed) {
    return {
      id: 'manual',
      label: '자동 배정 불가 — 사람이 직접 확인',
      detail: failedAnalyze
        ? `${STAGE_LABELS.analyze} 단계가 완료되지 않아 담당 부서·우선순위를 정할 수 없습니다 — ${failedAnalyze.message}`
        : `${STAGE_LABELS.analyze} 결과가 없어 담당 부서·우선순위를 정할 수 없습니다.`,
      tone: 'high',
    }
  }
  if (owner) {
    return {
      id: 'route',
      label: `${owner.team} 이관`,
      detail: `${owner.priority} · ${owner.sla} · 배정 근거: ${owner.reason}`,
      tone: owner.priority === 'P1' ? 'high' : 'warn',
    }
  }
  return {
    id: 'close',
    label: '1선 종결 가능',
    detail: churn
      ? `에스컬레이션 대상이 아니고 이탈 위험도 ${churn.score}점(${churn.level})으로 이관 기준 아래입니다.`
      : '에스컬레이션 대상으로 분류되지 않았습니다.',
    tone: 'ok',
  }
}

// "무엇을 확인해야 하는가" — 사람이 손으로 해야 하는 일만 남긴다.
// AI가 결론 낸 것을 다시 적는 자리가 아니라, AI가 결론 내면 안 되는 것을 적는 자리다.
function buildChecks({ failed, analyzed, analysis, churn, qa, score, dia }) {
  const checks = []

  for (const f of failed) {
    checks.push({
      id: `stage-${f.id}`,
      level: f.id === 'analyze' || f.id === 'stt' ? 'high' : 'warn',
      label: `${f.label} 미완료`,
      detail: `${f.impact} (사유: ${f.message})`,
    })
  }

  if (analyzed && analysis.escalate) {
    checks.push({
      id: 'escalate',
      level: 'high',
      label: '에스컬레이션 사유 확인',
      // 감면·보상 판단은 AI가 내리지 않는다는 원칙(analyze.js SYSTEM 2번)을 처리 상태에서도 유지한다.
      detail: `${analysis.escalate_reason || '사람의 판단이 필요한 건으로 분류됐습니다.'} — 감면·보상 여부는 담당자가 판단합니다.`,
    })
  }

  if (churn && churn.score >= 40) {
    checks.push({
      id: 'churn',
      level: churn.score >= 70 ? 'high' : 'warn',
      label: `이탈 위험 ${churn.score}점 (${churn.level})`,
      detail: `${churn.action}${
        churn.signals?.length ? ` · 근거 신호: ${churn.signals.map((s) => s.label).join(', ')}` : ''
      }`,
    })
  }

  // 화자 라벨이 없으면 이탈 위험·QA 점수 모두 상담사 발화를 고객 발화로 셌을 수 있다.
  // 세 곳(분리 실패·churn·QA)이 같은 원인을 가리키므로 한 줄로 합쳐 적는다.
  const unlabeled =
    churn?.speakerLabeled === false || (qa && qa.speaker_labeled === false) || failed.some((f) => f.id === 'dia')
  if (unlabeled) {
    checks.push({
      id: 'speaker',
      level: 'warn',
      label: '화자 라벨 없이 계산됨',
      detail: '이탈 위험 신호와 QA 규칙 스캔이 전사 전체를 훑었습니다 — 상담사 발화가 고객 발화로 잡혔을 수 있습니다.',
    })
  }

  if (qa?.attribution?.withheld_count > 0) {
    checks.push({
      id: 'withheld',
      level: 'warn',
      label: `감점 보류 ${qa.attribution.withheld_count}건`,
      detail: '금지 표현이 스캔에 걸렸으나 상담사 발화로 확정할 수 없어 점수에 반영하지 않았습니다 — 원본 확인이 필요합니다.',
    })
  }

  if (score && score.total < 70) {
    checks.push({
      id: 'quality',
      level: 'warn',
      label: `품질 점수 ${score.total}점 (${score.grade}등급) — 코칭 대상`,
      detail: qa?.coaching || '코칭 이력에서 반복 누락 항목을 함께 확인하세요.',
    })
  }

  if (dia?.truncated) {
    checks.push({
      id: 'truncated',
      level: 'warn',
      label: '전사 길이 상한 초과',
      detail: `앞 ${dia.processed_chars}자만 화자 분리가 적용됐고 나머지는 라벨 없이 이어 붙었습니다.`,
    })
  }

  // 추정치는 실측과 섞어 보여주지 않는다 — 어디까지가 실제 측정인지 밝힌다.
  const estimated = []
  if (analyzed && analysis.demo) estimated.push('분류·요약')
  if (churn?.estimated) estimated.push('이탈 위험')
  if (score?.llmEstimated) estimated.push('정성 평가')
  if (estimated.length) {
    checks.push({
      id: 'estimated',
      level: 'info',
      label: `추정치 포함 (${estimated.join(', ')})`,
      detail: 'AI가 연결되지 않은 구간은 규칙 기반 추정값입니다 — 이관 판단 전에 원본을 확인하세요.',
    })
  }

  if (!checks.length) {
    checks.push({
      id: 'none',
      level: 'info',
      label: '추가 확인 사항 없음',
      detail: '에스컬레이션 사유·이탈 위험·품질 점수 모두 사람이 다시 볼 기준에 걸리지 않았습니다.',
    })
  }

  return checks.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
}

// 다음 행동 — 존재하는 결과에서만 만든다.
// 분석이 실패했는데 "티켓 초안 복사" 버튼을 띄우면 누른 사람은 빈 문서를 받는다.
function buildActions({ ticket, present, qaSaved }) {
  const actions = [{ id: 'copy-report', label: '인수인계 리포트 복사 (한 장)' }]
  if (ticket?.text) actions.unshift({ id: 'copy-ticket', label: '티켓 초안 복사' })
  if (present.voc) actions.push({ id: 'open-voc', label: 'VOC 대시보드에서 보기', to: '/voc' })
  if (qaSaved) actions.push({ id: 'open-qa', label: '코칭 이력에서 보기', to: '/qa' })
  return actions
}

// 인수인계 문서에 실을 텍스트 블록. 화면과 같은 값을 같은 문장으로 적는다 —
// 복사한 문서와 화면이 다른 말을 하면 어느 쪽이 맞는지 확인할 방법이 없다.
export function formatHandoff(handoff) {
  if (!handoff) return []
  const lines = ['─── 처리 상태 (이 통화는 어떻게 처리되는가) ───', `상태: ${handoff.headline}`]
  lines.push(`  ${handoff.status.detail}`)
  if (handoff.owner) {
    lines.push(`담당: ${handoff.owner.team} · 우선순위 ${handoff.owner.priority} · 처리 기한 ${handoff.owner.sla}`)
  } else if (handoff.status.id === 'close') {
    lines.push('담당: 추가 이관 없음 — 1선에서 종결합니다.')
  } else {
    // 배정할 근거가 없는 것과 배정이 필요 없는 것은 다르다. 한 문장으로 뭉치면
    // 실패해서 비어 있는 칸이 "이관 불필요"로 읽힌다.
    lines.push('담당: 미배정 — 자동 배정 근거가 없어 사람이 정해야 합니다.')
  }
  lines.push(`실행: ${handoff.run.label}`)
  if (handoff.quality) {
    lines.push(
      `품질: ${handoff.quality.total}점 (${handoff.quality.grade}등급)${handoff.quality.estimated ? ' · 추정' : ''}`
    )
  }
  lines.push('확인 필요:')
  for (const c of handoff.checks) {
    const mark = c.level === 'high' ? '[높음]' : c.level === 'warn' ? '[주의]' : '[참고]'
    lines.push(`  ${mark} ${c.label} — ${c.detail}`)
  }
  lines.push(
    `기록: VOC 대시보드 ${handoff.records.voc ? '반영' : '미반영'} · 코칭 이력 ${
      handoff.records.qaHistory ? '기록' : '미기록'
    }`
  )
  return lines
}
