// Auto QA 1층: 규칙 기반 평가 (결정적 — 데모 모드에서도 실제로 동작한다)
// 필수 안내 멘트 체크리스트 40점 + 금지 표현 감점.
// 서버(functions/api/cc/qa.js)와 프론트가 이 파일을 직접 공유해 기준 불일치를 막는다.

import { groundedness } from './grounding.js'

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
    // 이 목록만 화자 귀속이 애매하다 — '했잖아요','알았어요','아 진짜','그건 몰라'는
    // 화난 고객이 그대로 쓰는 말이다. 나머지 세 규칙('고객님이 잘못','해드릴 게 없',
    // '제가 다 책임' 등)은 서비스를 제공하는 쪽만 쓸 수 있는 어투라 화자 라벨이 없어도
    // 상담사 발화로 볼 수 있지만, 반말 목록은 라벨 없이 귀속을 확정할 수 없다.
    speakerAmbiguous: true,
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

export const WITHHELD_NOTE = '화자 미확인 — 감점 보류'

// 화자 라벨이 없을 때, 귀속을 확정할 수 없는 금지 표현의 감점을 보류한다.
// 예전 동작에서 깨진 상황: 라벨 없는 전사를 넣으면 agentLines가 전문을 반환하므로
// 화난 고객이 말한 "아 진짜"·"했잖아요"가 건당 -4점씩 상담사 점수에서 깎이고,
// 그 발화가 상담사 위반 근거로 표에 인용됐다. 점수는 "상담사 응대 품질"이라고
// 주장하는 수치이므로 확인할 수 없는 귀속으로 깎는 것은 사용자에게 거짓을 말하는 것이다.
// 그래서 감점만 0으로 내리고 finding 자체는 남긴다 — 표에서 아예 지우면
// "금지 표현이 발견되지 않았습니다"라는 또 다른 거짓이 되기 때문이다.
// 감점을 유지하는 대신 보류를 택한 이유: 과소 감점은 근거를 함께 보여주면 사용자가
// 스스로 판단할 수 있지만, 과대 감점은 숨은 오귀속이라 사용자가 알아챌 방법이 없다.
export function annotateSpeakerAttribution(findings = [], speakerLabeled = true) {
  if (speakerLabeled) return findings
  const ambiguous = new Set(FORBIDDEN_RULES.filter((r) => r.speakerAmbiguous).map((r) => r.id))
  return findings.map((f) =>
    ambiguous.has(f.ruleId)
      ? {
          ...f,
          deduct: 0,
          withheld: true,
          withheldDeduct: f.deduct,
          // 라벨(유형 칸)에 보류를 적어 표의 "-0"이 버그가 아니라 판단임을 읽히게 한다
          label: `${f.label} (${WITHHELD_NOTE})`,
          reason: `${f.reason} 단, 이 전사에는 화자 라벨이 없어 상담사가 말했는지 확인할 수 없으므로 점수에 반영하지 않았습니다.`,
        }
      : f
  )
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
// 밴드 폭은 신호 강도에 따라 넓히기만 한다.
// mid는 "멘트 이행률"이라는 약한 대리 신호에서 나온다. 이행률이 0이나 1에 가까우면
// mid가 어느 정도 정보를 갖지만, 0.5 근처에서는 정성 품질에 대해 거의 아무것도
// 말해주지 않는다(체크리스트를 절반 읽었다는 사실과 공감 능력은 별개다).
// 애매한 신호에도 같은 폭을 쓰면 LLM이 전사를 읽고 낸 정당한 판단을 밴드가 조용히
// 덮어쓴다. 그래서 폭은 넓히는 방향으로만 움직이고, 신호가 가장 뚜렷한 이행률 0/1에서만
// 기존 ±5를 유지한다.
//
// 다만 "폭이 넓어지므로 개입이 줄어든다"는 말은 절반만 참이다. 감점 보류(귀속 미확인)로
// penalty가 빠지면 밴드의 중심(mid)이 위로 이동하고, 그러면 예전에 구간 안이던 낮은
// 점수가 새 하한 밖으로 나가 **상향 보정**된다. 확인할 수 없는 증거로 점수를 깎지
// 않겠다는 원칙은 점수를 올려주는 근거로도 쓸 수 없으므로, 하한은 보류가 없었을 때의
// 값보다 올라가지 않게 묶는다.
const BAND_HALF_MIN = 5
const BAND_HALF_MAX = 8

export function bandHalfWidth(ratio) {
  const strength = Math.abs(clamp(ratio, 0, 1) - 0.5) * 2
  return Math.round(BAND_HALF_MAX - (BAND_HALF_MAX - BAND_HALF_MIN) * strength)
}

export function consistencyBand(mentions = [], findings = []) {
  const total = mentions.length || 1
  const ratio = mentions.filter((m) => m.found).length / total
  const list = Array.isArray(findings) ? findings : []
  // 감점이 보류된(귀속 미확인) 표현은 상담사에 대한 증거가 아니므로 밴드 신호에서도 뺀다
  const counted = list.filter((f) => (f.deduct ?? 0) > 0).length
  const midFor = (n) => clamp(Math.round(8 + ratio * 10 - Math.min(n * 2, 6)), 2, 18)
  const mid = midFor(counted)
  const half = bandHalfWidth(ratio)
  // 보류를 세지 않았을 때의 하한 — 보류 덕분에 하한이 올라가 상향 보정이 새로 생기는 것을 막는다
  const lowIfAllCounted = clamp(midFor(list.length) - half, 0, 20)
  return {
    low: Math.min(clamp(mid - half, 0, 20), lowIfAllCounted),
    high: clamp(mid + half, 0, 20),
  }
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

// ── LLM 코멘트의 "근거 인용" 검증층 ────────────────────────────────────────
// 시스템 프롬프트는 "실제 발화를 인용한 코멘트"를 요구하지만 지시는 약속일 뿐이다.
// 인용된 발화가 통화에 실제로 있는지를 결정적으로 확인한다(analyze·search의 근거율과 같은 철학).
//
// 코멘트 문장 전체의 근거율은 판별력이 없어 쓰지 않는다: 샘플 통화로 측정해보면
// 짧은 인용 + 긴 평가 문장인 정상 코멘트가 0.09까지 내려가 허위 인용(0.07~0.20)과
// 구분되지 않았다. 인용부호 안의 구간만 떼어 재면 실제 인용 0.64~1.00 대
// 허위 인용 0.07~0.20으로 갈라지므로, 임계값 0.5는 그 사이 여유 구간이다.
//
// 여닫이를 짝지어야 한다. 한 문자 클래스로 양쪽을 받으면 짧은 인용("네")을 만났을 때
// 정규식이 그 여는 따옴표를 버리고 닫는 따옴표를 여는 것으로 재해석해,
// 인용 사이의 연결어("라고만 답하고")를 인용으로 뽑고 바로 뒤의 진짜 인용은 통째로
// 삼켜버린다. 상담사의 짧은 응대를 인용하는 것은 QA 코멘트에서 아주 흔한 패턴이라
// 정상 코멘트가 허위로 낙인찍혔다. 그래서 1자 인용도 "소비"시킨다.
const QUOTE_RE =
  /"([^"\n]{1,80})"|'([^'\n]{1,80})'|“([^”\n]{1,80})”|‘([^’\n]{1,80})’|「([^」\n]{1,80})」|『([^』\n]{1,80})』/g

// 인용은 축자(逐字)여야 한다 — 그래서 2-gram 겹침이 아니라 "전사에 그대로 있는가"로 잰다.
//
// 2-gram 방식은 짧은 한국어 문장에서 무너진다. 실측: 전사에 없는 "환불해 드리겠습니다"·
// "알겠습니다"·"확인됩니다"가 전부 0.5~0.75로 통과했다 — `습니`·`니다` 같은 보편 어미
// 2-gram만 맞아도 임계를 넘기 때문이다. 하지 않은 약속의 날조가 잡아야 할 1순위인데
// 정확히 그것이 빠져나갔다. 반대로 축자 일치는 어미 편승이 원리적으로 불가능하고,
// 길이가 짧아도 정확하다("네"는 전사에 있으면 1.0, 없으면 0).
export const QUOTE_VERBATIM_MIN = 0.8

// 이 길이 미만의 인용은 부분 일치를 인정하지 않고 정확히 들어 있어야 통과시킨다.
// 짧은 문장에서는 부분 일치조차 어미로 채워진다: "알겠습니다"(5자)는 전사의
// "드리겠습니다"와 "겠습니다" 4자가 겹쳐 비율 0.8을 그냥 넘는다.
// 짧은 인용은 애초에 정확히 맞추기 쉬우므로 관용을 둘 이유도 없다.
export const QUOTE_EXACT_BELOW = 10

export const UNVERIFIED_QUOTE_NOTE = ' ⚠ 인용 근거 미확인: 이 인용을 통화 전사에서 찾지 못했습니다.'

// 비교 전 정규화 — 공백·구두점 차이로 축자 인용이 어긋나는 것을 막는다
const normalizeQuote = (s) => String(s ?? '').replace(/[\s.,!?…·"'“”‘’「」『』]/g, '')

// 인용이 전사에 얼마나 그대로 들어 있는지 (0~1).
// 전체 LCS를 구하지 않고, 긴 조각부터 짧은 조각 순으로 "그대로 있는지"만 확인한다 —
// 인용은 최대 80자라 탐색 범위가 작고, indexOf는 엔진 수준에서 빠르다.
export function quoteVerbatimRatio(quote, transcript) {
  const q = normalizeQuote(quote)
  const t = normalizeQuote(transcript)
  if (!q || !t) return 0
  if (t.includes(q)) return 1
  for (let len = q.length - 1; len > 0; len--) {
    for (let i = 0; i + len <= q.length; i++) {
      if (t.includes(q.slice(i, i + len))) return len / q.length
    }
  }
  return 0
}

// 인용 하나가 근거로 인정되는가.
// 긴 인용에는 사소한 표현 차이를 허용하되(0.8), 짧은 인용은 정확 포함만 인정한다.
export function isQuoteVerified(quote, transcript) {
  const q = normalizeQuote(quote)
  const t = normalizeQuote(transcript)
  if (!q || !t) return false
  if (t.includes(q)) return true
  if (q.length < QUOTE_EXACT_BELOW) return false
  return quoteVerbatimRatio(q, t) >= QUOTE_VERBATIM_MIN
}

export function extractQuotes(comment) {
  return [...String(comment ?? '').matchAll(QUOTE_RE)]
    .map((m) => (m.slice(1).find((g) => g !== undefined) ?? '').trim())
    .filter(Boolean)
}

// 코멘트별 인용 근거율을 재고, 통화에 없는 발화를 인용한 코멘트에 표시를 붙인다.
// 인용을 아예 안 한 코멘트는 "허위"가 아니라 "검증 불가"이므로 별도로 센다(scores=null).
// 한계: 2-gram 겹침은 조작된 *표현*을 잡지만 조작된 *숫자*는 잡지 못한다
// ("6기가"를 "10기가"로 바꿔 인용하면 주변 표현이 그대로여서 0.81로 통과한다).
export function auditComments(comments = [], transcript = '') {
  const list = Array.isArray(comments) ? comments : []
  const scores = []
  const flagged = []
  let sum = 0
  const marked = list.map((c, i) => {
    const quotes = extractQuotes(c)
    if (quotes.length === 0) {
      scores.push(null)
      return c
    }
    const best = Math.max(...quotes.map((q) => quoteVerbatimRatio(q, transcript)))
    scores.push(best)
    sum += best
    if (quotes.some((q) => isQuoteVerified(q, transcript))) return c
    flagged.push(i)
    return `${c}${UNVERIFIED_QUOTE_NOTE}`
  })
  const quoted = scores.filter((s) => s !== null).length
  return {
    comments: marked,
    grounding: {
      threshold: QUOTE_VERBATIM_MIN,
      scores,
      quoted,
      unquoted: list.length - quoted,
      verified: quoted - flagged.length,
      unverified: flagged.length,
      flagged,
      // 인용이 있는 코멘트만의 평균 — 인용 없는 코멘트를 0으로 섞으면 허위 인용과 뭉개진다
      average: quoted ? Math.round((sum / quoted) * 100) / 100 : null,
    },
  }
}
