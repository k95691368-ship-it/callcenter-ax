// Auto QA 1층: 규칙 기반 평가 (결정적 — 데모 모드에서도 실제로 동작한다)
// 필수 안내 멘트 체크리스트 40점 + 금지 표현 감점.
// 서버(functions/_lib/qacheck.js)와 프론트가 같은 규칙을 공유해 기준 불일치를 막는다.

export const REQUIRED_MENTIONS = [
  {
    id: 'greeting',
    label: '첫인사·소속 밝히기',
    points: 8,
    example: '"안녕하세요, 한빛텔레콤 상담사 OO입니다"',
    patterns: [/안녕하세요/, /안녕하십니까/, /반갑습니다/],
  },
  {
    id: 'identity',
    label: '본인 확인',
    points: 8,
    example: '"본인 확인을 위해 성함과 생년월일 확인 부탁드립니다"',
    patterns: [/본인\s*확인/, /명의자\s*확인/, /생년월일/, /성함.*확인/],
  },
  {
    id: 'recording',
    label: '녹취 고지',
    points: 8,
    example: '"상담 품질 향상을 위해 통화 내용이 녹음됩니다"',
    patterns: [/녹음/, /녹취/],
  },
  {
    id: 'solution',
    label: '해결 안내·처리 확인',
    points: 8,
    example: '"말씀하신 건은 이렇게 처리해 드리겠습니다"',
    patterns: [/처리(해|하겠|되|가\s*완료)/, /안내(해\s*드리|드리)/, /도와드리/, /접수(해|하겠|되)/],
  },
  {
    id: 'closing',
    label: '마무리 인사·추가 문의 확인',
    points: 8,
    example: '"더 도와드릴 부분 없으실까요? 좋은 하루 되세요"',
    patterns: [/더\s*(궁금|도와드릴|필요하신|문의)/, /좋은\s*하루/, /이용해\s*주셔서\s*감사/],
  },
]

export const MAX_RULE_SCORE = REQUIRED_MENTIONS.reduce((s, m) => s + m.points, 0)

// 금지 표현 규칙 — 발견 건당 감점. 목록은 데모용 요약이며 실제 QA 기준 전체를 대체하지 않는다.
export const FORBIDDEN_RULES = [
  {
    id: 'blame',
    severity: 'high',
    deduct: 6,
    label: '고객 탓 돌리기',
    reason: '문제 원인을 고객에게 돌리는 표현은 민원을 악화시킵니다.',
    words: ['고객님이 잘못', '고객님 잘못', '고객님 책임', '그러게 왜', '제대로 보셨어야'],
  },
  {
    id: 'dismissive',
    severity: 'high',
    deduct: 5,
    label: '책임 회피·무성의 응대',
    reason: '해결 노력 없이 규정·타 부서만 언급하는 응대는 감점 대상입니다.',
    words: ['어쩔 수 없습니다', '저희가 알 수 없', '규정이라 안 됩', '알아서 하셔야', '해드릴 게 없'],
  },
  {
    id: 'informal',
    severity: 'medium',
    deduct: 4,
    label: '반말·비존칭 표현',
    reason: '상담 중 반말·비존칭은 기본 응대 품질 위반입니다.',
    words: ['그렇다니까', '했잖아요', '알았어요', '그건 몰라', '아 진짜'],
  },
  {
    id: 'overpromise',
    severity: 'medium',
    deduct: 4,
    label: '확정 약속·과잉 보장',
    reason: '보장할 수 없는 결과를 단정하면 후속 분쟁의 원인이 됩니다.',
    words: ['무조건 됩니다', '100% 보장', '절대 문제 없', '제가 다 책임'],
  },
]

// 상담사 발화만 대상으로 필수 멘트 이행 여부를 점검한다.
export function checkMentions(text) {
  const t = text || ''
  return REQUIRED_MENTIONS.map((m) => ({
    id: m.id,
    label: m.label,
    points: m.points,
    example: m.example,
    found: m.patterns.some((p) => p.test(t)),
  }))
}

// 금지 표현 스캔 — 겹치는 매치는 더 긴 표현 하나로만 보고한다.
export function scanForbidden(text) {
  const findings = []
  if (!text) return findings
  for (const rule of FORBIDDEN_RULES) {
    for (const word of rule.words) {
      let idx = text.indexOf(word)
      while (idx !== -1) {
        findings.push({
          ruleId: rule.id,
          severity: rule.severity,
          deduct: rule.deduct,
          label: rule.label,
          reason: rule.reason,
          word,
          index: idx,
          excerpt: text.slice(Math.max(0, idx - 15), idx + word.length + 15),
        })
        idx = text.indexOf(word, idx + word.length)
      }
    }
  }
  findings.sort((a, b) => a.index - b.index || b.word.length - a.word.length)
  const deduped = []
  let lastEnd = -1
  for (const f of findings) {
    if (f.index < lastEnd) continue
    deduped.push(f)
    lastEnd = f.index + f.word.length
  }
  return deduped
}

// 통화 텍스트에서 상담사 발화만 추출한다. 화자 구분이 없으면 전체를 반환한다.
export function agentLines(transcript) {
  const lines = (transcript || '').split('\n')
  const agent = lines.filter((l) => /^\s*(상담사|상담원|agent)\s*[:：]/i.test(l))
  if (agent.length === 0) return transcript || ''
  return agent.map((l) => l.replace(/^\s*(상담사|상담원|agent)\s*[:：]\s*/i, '')).join('\n')
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// 최종 점수 합산: 규칙 40점 + LLM 정성 60점(공감·명확성·문제해결 각 20) − 금지 표현 감점.
// llm이 없으면(데모·폴백) 규칙 이행률을 60점 만점으로 환산해 보수적으로 추정한다.
export function computeQaScore({ mentions = [], findings = [], llm = null }) {
  const ruleScore = mentions.reduce((s, m) => s + (m.found ? m.points : 0), 0)
  const deduction = clamp(findings.reduce((s, f) => s + (f.deduct || 0), 0), 0, 20)

  let llmScore
  let llmEstimated = false
  if (llm) {
    llmScore =
      clamp(Math.round(llm.empathy ?? 0), 0, 20) +
      clamp(Math.round(llm.clarity ?? 0), 0, 20) +
      clamp(Math.round(llm.resolution ?? 0), 0, 20)
  } else {
    llmScore = Math.round((ruleScore / MAX_RULE_SCORE) * 60)
    llmEstimated = true
  }

  const total = clamp(ruleScore + llmScore - deduction, 0, 100)
  const grade = total >= 90 ? 'A' : total >= 80 ? 'B' : total >= 70 ? 'C' : 'D'
  return { ruleScore, llmScore, llmEstimated, deduction, total, grade }
}
