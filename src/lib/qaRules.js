// Auto QA 1층: 규칙 기반 평가 (결정적 — 데모 모드에서도 실제로 동작한다)
// 필수 안내 멘트 체크리스트 40점 + 금지 표현 감점.
// 서버(functions/api/cc/qa.js)와 프론트가 이 파일을 직접 공유해 기준 불일치를 막는다.

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

export const MAX_CUSTOM_MENTIONS = 3

// 사용자 입력({label, keywords[]})을 검증·정규화해 커스텀 멘트 규칙으로 만든다.
// 콜센터마다 다른 QA 기준(예: 가입 상담의 "청약철회 안내")을 심사자가 직접 실험할 수 있다.
export function buildCustomMentions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw.slice(0, MAX_CUSTOM_MENTIONS)) {
    const label = typeof r?.label === 'string' ? r.label.trim().slice(0, 30) : ''
    const keywords = (Array.isArray(r?.keywords) ? r.keywords : [])
      .map((k) => (typeof k === 'string' ? k.trim().slice(0, 20) : ''))
      .filter(Boolean)
      .slice(0, 5)
    if (!label || keywords.length === 0) continue
    out.push({
      id: `custom-${out.length + 1}`,
      label,
      custom: true,
      example: keywords.map((k) => `"${k}"`).join(', '),
      keywords,
    })
  }
  return out
}

// 내장+커스텀 멘트에 규칙 점수 40점을 균등 재배분한다 (합계는 항상 MAX_RULE_SCORE 유지)
export function mentionRuleSet(customs = []) {
  const all = [...REQUIRED_MENTIONS, ...customs]
  const per = Math.floor(MAX_RULE_SCORE / all.length)
  let remainder = MAX_RULE_SCORE - per * all.length
  return all.map((m) => {
    const bonus = remainder > 0 ? 1 : 0
    if (remainder > 0) remainder -= 1
    return { ...m, points: per + bonus }
  })
}

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
// 내장 규칙은 정규식, 커스텀 규칙은 키워드 포함 여부로 판정한다.
export function checkMentions(text, ruleSet = REQUIRED_MENTIONS) {
  const t = text || ''
  return ruleSet.map((m) => ({
    id: m.id,
    label: m.label,
    points: m.points,
    example: m.example,
    ...(m.custom ? { custom: true } : {}),
    found: m.patterns ? m.patterns.some((p) => p.test(t)) : m.keywords.some((k) => t.includes(k)),
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

// 화자 라벨이 실제로 있는지 — 없으면 아래 agentLines가 전체 텍스트를 돌려주므로
// 금지 표현 스캔이 고객 발화까지 상담사 감점으로 집계한다("했잖아요", "아 진짜"는
// 화난 고객의 말이다). 점수를 조용히 왜곡하지 않도록 호출부가 이 사실을 표시해야 한다.
export function hasSpeakerLabels(transcript) {
  return (transcript || '').split('\n').some((l) => /^\s*(상담사|상담원|agent)\s*[:：]/i.test(l))
}

// 통화 텍스트에서 상담사 발화만 추출한다. 화자 구분이 없으면 전체를 반환한다.
export function agentLines(transcript) {
  const lines = (transcript || '').split('\n')
  const agent = lines.filter((l) => /^\s*(상담사|상담원|agent)\s*[:：]/i.test(l))
  if (agent.length === 0) return transcript || ''
  return agent.map((l) => l.replace(/^\s*(상담사|상담원|agent)\s*[:：]\s*/i, '')).join('\n')
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// LLM 정성 점수의 실행 간 편차를 줄이는 일관성 밴드.
// 결정적인 규칙 신호(멘트 이행률·금지 표현 수)로 기대 구간을 만들고,
// LLM 점수가 구간을 크게 벗어나면 경계로 보정한다 (보정 여부는 정직하게 표시).
export function consistencyBand(mentions = [], findings = []) {
  const total = mentions.length || 1
  const ratio = mentions.filter((m) => m.found).length / total
  const penalty = Math.min(findings.length * 2, 6)
  const mid = clamp(Math.round(8 + ratio * 10 - penalty), 2, 18)
  return { low: clamp(mid - 5, 0, 20), high: clamp(mid + 5, 0, 20) }
}

export function applyConsistencyBand(llm, { mentions = [], findings = [] } = {}) {
  const { low, high } = consistencyBand(mentions, findings)
  const out = {}
  let adjusted = false
  for (const key of ['empathy', 'clarity', 'resolution']) {
    const raw = clamp(Math.round(llm?.[key] ?? 0), 0, 20)
    const banded = clamp(raw, low, high)
    if (banded !== raw) adjusted = true
    out[key] = banded
  }
  return { llm: out, adjusted, band: { low, high } }
}

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
