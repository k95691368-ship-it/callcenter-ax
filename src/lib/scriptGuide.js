// 통화 중 실시간 스크립트 가이드 — 사후 평가를 사전 예방으로 옮긴다.
//
// Auto QA는 통화가 끝난 뒤 "녹취 고지를 안 했다"고 알려준다. 그때는 이미 늦었다.
// 같은 규칙을 진행 중인 대화에 적용하면, 빠뜨리기 전에 알려줄 수 있다.
// 상담사가 실제로 받는 도움은 이쪽이다.
//
// 전부 규칙 계산이라 LLM 호출이 없다 — 통화 중에 쓰려면 응답이 즉시여야 하므로
// 그편이 오히려 맞다. (LLM 제안이 필요하면 기존 /assist가 담당한다)

import { REQUIRED_MENTIONS, checkMentions, scanForbidden, agentLines } from './qaRules.js'
import { scanChurnSignals } from './churnRisk.js'

// 통화의 진행 단계와 각 단계에서 끝내야 할 필수 멘트.
// 순서는 실제 상담 흐름을 따른다 — 본인 확인 없이 해결 안내로 넘어가면 안 된다.
export const CALL_STAGES = [
  {
    id: 'open',
    label: '오프닝',
    mentionIds: ['greeting', 'recording'],
    scripts: [
      '안녕하세요, 한빛텔레콤 상담사 OOO입니다.',
      '상담 품질 향상을 위해 통화 내용이 녹음됩니다.',
    ],
  },
  {
    id: 'verify',
    label: '본인 확인',
    mentionIds: ['identity'],
    scripts: ['본인 확인을 위해 명의자 성함과 생년월일 확인 부탁드립니다.'],
  },
  {
    id: 'resolve',
    label: '해결 안내',
    mentionIds: ['solution'],
    scripts: [
      '말씀하신 건은 이렇게 처리해 드리겠습니다 — 처리 기한은 O일입니다.',
      '확인된 내용을 정리해 드리면 ~ 이 맞으실까요?',
    ],
  },
  {
    id: 'close',
    label: '마무리',
    mentionIds: ['closing'],
    scripts: ['더 도와드릴 부분 없으실까요?', '이용해 주셔서 감사합니다. 좋은 하루 되세요.'],
  },
]

// 위험 신호가 잡히면 상담사가 그 자리에서 해야 할 행동을 알려준다.
// "위험합니다"만 띄우면 아무 소용이 없다 — 무엇을 말해야 하는지가 필요하다.
const RISK_PLAYBOOK = {
  legal: {
    label: '법적 대응·외부 기관 언급',
    action: '현장에서 결론 내지 말고 전문 부서 이관을 안내하세요.',
    script: '말씀 주신 내용은 전담 부서에서 정확히 확인해 회신드리겠습니다. 접수번호를 문자로 보내드릴까요?',
  },
  'cancel-intent': {
    label: '해지 의사',
    action: '만류보다 이유 확인이 먼저입니다. 원인을 좁혀야 대안을 낼 수 있습니다.',
    script: '불편하셨던 부분을 조금 더 자세히 여쭤봐도 될까요? 확인 후 가능한 방법을 찾아보겠습니다.',
  },
  competitor: {
    label: '타사 이동 언급',
    action: '리텐션 대상입니다. 현재 혜택과 잔여 약정을 정확한 숫자로 안내하세요.',
    script: '현재 이용 중이신 조건과 남은 약정을 정확히 확인해 안내드리겠습니다.',
  },
  'repeat-issue': {
    label: '반복 장애·재문의',
    action: '이전 접수 이력을 먼저 확인하고, 반복임을 인정하는 말로 시작하세요.',
    script: '같은 문제로 다시 연락 주시게 해서 죄송합니다. 이전 접수 건부터 확인하겠습니다.',
  },
  compensation: {
    label: '보상·감면 요구',
    action: '확정 약속을 하지 마세요. 심의 절차와 회신 기한만 안내합니다.',
    script: '보상 여부는 심의 절차를 거쳐 결정되며, 결과는 O일 이내 회신드리겠습니다.',
  },
  'trust-loss': {
    label: '신뢰 상실 표현',
    action: '해명보다 공감이 먼저입니다. 반박하지 마세요.',
    script: '그렇게 느끼셨다면 정말 죄송합니다. 끝까지 확인해서 도와드리겠습니다.',
  },
}

// 진행 중인 대화를 읽고 다음에 할 일을 돌려준다.
// 반환: { stage, mentions, nextActions[], alerts[], progress }
export function guideCall(dialogue) {
  const text = String(dialogue || '')
  const agentText = agentLines(text)
  const mentions = checkMentions(agentText, REQUIRED_MENTIONS)
  const doneIds = new Set(mentions.filter((m) => m.found).map((m) => m.id))

  // 현재 단계 = 아직 못 끝낸 가장 앞 단계. 모두 끝냈으면 마무리 단계로 본다.
  const pending = CALL_STAGES.filter((s) => s.mentionIds.some((id) => !doneIds.has(id)))
  const stage = pending[0] || CALL_STAGES[CALL_STAGES.length - 1]

  // 다음 행동 — 현재 단계의 미이행 멘트를 스크립트와 함께 제시한다
  const nextActions = []
  for (const s of pending.slice(0, 2)) {
    const missing = s.mentionIds.filter((id) => !doneIds.has(id))
    for (const id of missing) {
      const rule = REQUIRED_MENTIONS.find((m) => m.id === id)
      if (!rule) continue
      nextActions.push({
        id,
        stage: s.id,
        stageLabel: s.label,
        label: rule.label,
        script: s.scripts[s.mentionIds.indexOf(id)] || s.scripts[0] || rule.example,
        urgent: s.id === stage.id,
      })
    }
  }

  // 경보 — 이미 벌어진 일(금지 표현)과 지금 다뤄야 할 일(고객 위험 신호)
  const alerts = []
  for (const f of scanForbidden(agentText)) {
    alerts.push({
      kind: 'forbidden',
      level: f.severity === 'high' ? 'high' : 'warn',
      label: `금지 표현: ${f.label}`,
      detail: f.reason,
      evidence: f.excerpt,
      action: '같은 표현을 반복하지 말고, 사실 확인 → 대안 제시 순으로 바꿔 말하세요.',
    })
  }
  const { risk } = scanChurnSignals(text)
  for (const sig of risk) {
    const play = RISK_PLAYBOOK[sig.id]
    if (!play) continue
    alerts.push({
      kind: 'risk',
      level: sig.id === 'legal' ? 'high' : 'warn',
      label: play.label,
      detail: play.action,
      evidence: sig.evidence,
      script: play.script,
    })
  }

  const total = REQUIRED_MENTIONS.length
  return {
    stage: { id: stage.id, label: stage.label },
    mentions,
    nextActions,
    alerts,
    progress: { done: doneIds.size, total, ratio: total ? Math.round((doneIds.size / total) * 100) : 0 },
  }
}
