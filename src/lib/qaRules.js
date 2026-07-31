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

// ── 이행 근거(evidence) ──────────────────────────────────────────────────────
// QA 점수는 수퍼바이저가 상담사 앞에서 방어해야 하는 숫자다. "녹취 고지 O"만 주면
// 방어할 수 없다 — 물어보는 것은 언제나 "어디서 그렇게 판단했는가"다.
// 그래서 이행 판정과 **같은 규칙**으로 매치 위치를 되돌려준다. 점수 계산에는 관여하지
// 않는다(근거를 드러낼 뿐 채점을 바꾸지 않는다).

// 매치 앞뒤로 함께 보여줄 문자 수. 발화 한 줄이 통째로 짧으면 줄 전체가 인용된다.
export const EVIDENCE_CONTEXT = 60
// 인용 구간 상한. 줄바꿈 없는 8000자 전사가 들어오면 "그 줄"이 곧 전문이므로 잘라야 한다.
export const EVIDENCE_MAX_QUOTE = 200

// 화자 라벨이 없는 전사에서는 근거 발화가 상담사의 것인지 확정할 수 없다.
// 그때 "상담사가 이렇게 말했다"고 적으면 감점 보류(annotateSpeakerAttribution)와
// 같은 종류의 거짓이 된다 — 확인한 만큼만 말한다.
export const EVIDENCE_UNKNOWN_SPEAKER_NOTE = '화자 미확인 — 상담사 발화로 단정할 수 없음'

const countNewlines = (s, end) => {
  let n = 0
  for (let i = 0; i < end; i += 1) if (s[i] === '\n') n += 1
  return n
}

// 매치 위치 → 화면에 그대로 쓸 수 있는 근거 객체.
// quote 안의 [start, end) 가 매치 구간이므로 프론트는 slice만으로 강조할 수 있다.
// lineNumbers는 "검사한 텍스트의 n번째 줄 = 원문 전사의 몇 번째 줄"인지의 대응표다
// (상담사 발화만 뽑아 검사하므로 이 표가 없으면 원문 줄 번호를 되돌릴 수 없다).
function evidenceAt(text, index, rawLength, { lineNumbers = null, speakerLabeled = null } = {}) {
  // 탐욕적 정규식(/성함.*확인/)은 한 줄 전체를 매치할 수 있다. 강조 구간도 상한을 둔다.
  const length = Math.max(0, Math.min(rawLength, EVIDENCE_MAX_QUOTE))
  const lineIdx = countNewlines(text, index)
  const lineStart = index > 0 ? text.lastIndexOf('\n', index - 1) + 1 : 0
  const nl = text.indexOf('\n', index + Math.max(length, 1))
  const lineEnd = nl === -1 ? text.length : nl
  const rawLine = text.slice(lineStart, lineEnd)
  const at = index - lineStart
  const from = Math.max(0, at - EVIDENCE_CONTEXT)
  const to = Math.min(rawLine.length, at + length + EVIDENCE_CONTEXT, from + EVIDENCE_MAX_QUOTE)

  // 줄바꿈을 공백으로 바꾸는 것은 1:1 치환이라 오프셋이 어긋나지 않는다.
  // (\s 는 개행도 먹으므로 /본인\s*확인/ 같은 규칙은 드물게 두 줄에 걸쳐 매치된다)
  let quote = rawLine.slice(from, to).replace(/\n/g, ' ')
  const lead = quote.length - quote.trimStart().length
  quote = quote.slice(lead)
  const start = Math.max(0, at - from - lead)
  const end = Math.min(quote.length, start + length)
  // 뒤쪽 공백만 떨어낸다 — 앞쪽을 더 자르면 start가 어긋난다
  quote = quote.slice(0, end) + quote.slice(end).replace(/\s+$/, '')

  // 매치가 두 발화에 걸쳤는가. 규칙의 \s가 개행을 먹으므로 /본인\s*확인/은
  // "상담사: 본인 / 상담사: 확인 부탁드립니다" 두 줄을 가로질러 걸린다.
  // 그때 개행을 공백으로 바꿔 이어 붙이면 **전사 어디에도 없는 문장**이 인용된다 —
  // 이 층이 지켜야 할 단 하나의 불변식("근거는 실제로 있었던 발화다")이 깨지는 자리다.
  // 인용을 자르지 않고 사실을 함께 실어 보낸다: 자르면 규칙이 무엇을 보고 판정했는지
  // 알 수 없게 되고, 자르지 않고 침묵하면 없던 발화를 지어낸 것이 된다.
  const spansLines = text.slice(index, index + length).includes('\n')

  return {
    // 원문 전사 기준 줄 번호(1-based). 대응표가 없으면 검사한 텍스트 기준 줄 번호.
    line: lineNumbers?.[lineIdx] ?? lineIdx + 1,
    index,
    match: text.slice(index, index + length).replace(/\n/g, ' '),
    quote,
    start,
    end,
    clippedStart: from > 0,
    clippedEnd: to < rawLine.length,
    spansLines,
    speaker: speakerLabeled === true ? 'agent' : 'unknown',
  }
}

// 규칙이 텍스트에서 처음 걸리는 지점. 여러 패턴이 걸리면 더 앞선 발화를 근거로 삼는다
// (같은 위치면 더 긴 매치 — 근거는 길수록 읽는 사람이 판단하기 쉽다).
function firstRuleMatch(text, rule) {
  let best = null
  const better = (index, length) =>
    !best || index < best.index || (index === best.index && length > best.length)
  if (rule.patterns) {
    for (const p of rule.patterns) {
      const m = text.match(p)
      // /g 플래그가 붙은 정규식은 index를 주지 않는다 — NaN 오프셋이 응답에 새지 않게 막는다
      if (m && typeof m.index === 'number' && better(m.index, m[0].length)) {
        best = { index: m.index, length: m[0].length }
      }
    }
  } else {
    for (const k of rule.keywords || []) {
      const i = text.indexOf(k)
      if (i !== -1 && better(i, k.length)) best = { index: i, length: k.length }
    }
  }
  return best
}

// 미이행 항목의 "가장 가까웠던 발화"를 찾기 위한 리터럴 조각.
// 정규식 소스에서 메타문자를 걷어내고 글자 덩어리만 남긴다 —
// /처리(해|하겠|되|가\s*완료)/ → ['처리','하겠','완료'].
// 1글자 조각은 버린다(조사·어미 한 글자가 아무 발화에나 걸려 근거가 소음이 된다).
export function patternLiterals(pattern) {
  const src = pattern instanceof RegExp ? pattern.source : String(pattern ?? '')
  return [
    ...new Set(
      src
        .replace(/\\[a-zA-Z]/g, '|') // \s \d \w … 문자 클래스는 경계로 취급
        .split(/[()[\]{}|*+?.^$\\\s]+/)
        .filter((s) => s.length >= 2)
    ),
  ]
}

const ruleLiterals = (rule) =>
  rule.patterns ? [...new Set(rule.patterns.flatMap(patternLiterals))] : (rule.keywords || []).filter((k) => k.length >= 2)

// 근접 발화로 인정할 최소 겹침 — 규칙 조각의 절반 이상이, 최소 2글자 연속으로 겹쳐야 한다.
// 이보다 느슨하면 "확인"의 '확' 한 글자로 아무 발화나 근거로 끌려온다.
export const NEAR_MIN_RATIO = 0.5
export const NEAR_MIN_CHARS = 2

// 규칙 조각의 **앞에서부터** 이어지는 겹침만 센다 (없으면 null).
//
// 위치를 가리지 않고 겹침을 재던 첫 구현은 어미에 편승했다: 8000자 상담 전사를 넣으면
// '반갑습니다'와 "…포함되어 있습니다"가 '습니다' 3글자로 0.6이 나와, 첫인사의
// "가장 가까웠던 발화"로 아무 문장이나 뽑혔다. 한국어는 어간이 앞, 어미가 뒤에 오므로
// 뒤쪽만 겹치는 것은 의미가 아니라 문법이 겹친 것이다(같은 함정을 quoteVerbatimRatio의
// 2-gram 방식에서 이미 겪었다). 앞에서부터의 겹침만 세면 어미 편승이 원리적으로 불가능하다.
// 대가: '청약철회'의 뒷부분('철회')만 나온 발화는 근접으로 잡지 못한다 —
// 소음을 근거라고 내미는 쪽이 놓치는 쪽보다 나쁘므로 이 손해를 택한다.
function sharedPrefix(token, line) {
  for (let len = token.length; len >= NEAR_MIN_CHARS; len -= 1) {
    const at = line.indexOf(token.slice(0, len))
    if (at !== -1) return { at, len }
  }
  return null
}

// 미이행 항목의 근접 발화. **규칙과 실제로 겹치는 발화가 있을 때만** 돌려준다 —
// 없으면 null이다. 추측으로 "아마 이 발화가 그 뜻이었을 것"이라고 말하지 않는다.
// 이행 근거가 아니라 코칭용 참고이므로 partial:true와 겹친 비율을 함께 준다.
function nearestMiss(text, rule, options) {
  const tokens = ruleLiterals(rule)
  // 조각이 하나도 없으면 근접 탐색을 **수행하지 못한 것**이지 "겹치는 발화가 없는 것"이
  // 아니다(1글자 키워드만 넣은 커스텀 규칙이 여기 걸린다). 둘을 같은 null로 뭉개면
  // 화면이 "찾아봤지만 없다"고 단정하게 되므로 이유를 붙여 구분한다.
  if (!text) return null
  if (tokens.length === 0) return { skipped: 'no-literal' }
  const lines = text.split('\n')
  let best = null
  let offset = 0
  for (const line of lines) {
    for (const token of tokens) {
      const hit = sharedPrefix(token, line)
      if (!hit) continue
      const ratio = hit.len / token.length
      if (ratio < NEAR_MIN_RATIO) continue
      if (!best || ratio > best.ratio || (ratio === best.ratio && hit.len > best.len)) {
        best = { ratio, len: hit.len, index: offset + hit.at, token, line }
      }
    }
    offset += line.length + 1 // '\n' 한 칸
  }
  if (!best) return null

  // 겹친 비율을 화면에 숫자로 내보내지 않는다.
  //
  // 그 값은 `겹친 길이 / 조각 길이`인데, 규칙 조각에는 2글자짜리가 흔하다
  // ('감사'·'확인'·'드리'·'안내'). 2글자 조각은 통째로 걸리거나 안 걸리거나뿐이라
  // 걸리기만 하면 **항상 1.0**이다. 실측으로 "네 감사합니다"·"궁금하신 점 있으실까요?"가
  // 모두 1.0이었다. 그걸 '부분 일치 100%'로 띄우면 바로 옆의 ✗(미이행)와 정면으로
  // 부딪히고, 수퍼바이저가 "100%인데 왜 감점이냐"고 물으면 답할 말이 없다.
  // 판정력 없는 수치를 판정력 있는 것처럼 보이게 하는 것이 이 프로젝트가 경계하는 바다.
  //
  // 대신 규칙 **전체** 대비 무엇이 나타났는지를 준다 — 이건 실제로 판정력이 있다:
  // "규칙 표현 3개 중 1개('감사')만 나타남"은 왜 미이행인지 그 자체로 설명한다.
  const literalsHit = tokens.filter((t) => sharedPrefix(t, best.line)).length
  return {
    ...evidenceAt(text, best.index, best.len, options),
    partial: true,
    // 실제로 겹친 문자열 (sharedPrefix가 맞춘 것은 조각의 앞에서부터 best.len 글자다)
    matched: best.token.slice(0, best.len),
    // 그 문자열이 나온 규칙 조각 전체. matched와 다르면 조각의 앞부분만 겹친 것이라,
    // 화면이 "'청약철회' 중 '청약'만"처럼 무엇이 모자랐는지 그대로 말할 수 있다.
    literal: best.token,
    literals: tokens.length,
    literalsHit,
  }
}

// 상담사 발화만 대상으로 필수 멘트 이행 여부를 점검한다.
// 내장 규칙은 정규식, 커스텀 규칙은 키워드 포함 여부로 판정한다.
//
// options.lineNumbers: 검사 텍스트의 줄 → 원문 전사의 줄 번호 대응표 (agentScript가 만든다)
// options.speakerLabeled: 전사에 화자 라벨이 있었는가. **true를 명시할 때만** 근거를
//   상담사 발화로 표기한다. 기본값을 true로 두면 라벨을 확인하지 않은 호출부가
//   조용히 "상담사가 말했다"는 거짓을 만들어내므로, 모르면 'unknown'으로 남긴다.
export function checkMentions(text, ruleSet = REQUIRED_MENTIONS, options = {}) {
  const t = text || ''
  const opts = { lineNumbers: options?.lineNumbers ?? null, speakerLabeled: options?.speakerLabeled ?? null }
  return ruleSet.map((m) => {
    // 판정식은 예전 그대로다 — 근거를 덧붙이는 작업이지 채점을 바꾸는 작업이 아니다
    const found = m.patterns ? m.patterns.some((p) => p.test(t)) : m.keywords.some((k) => t.includes(k))
    const hit = found ? firstRuleMatch(t, m) : null
    return {
      id: m.id,
      label: m.label,
      points: m.points,
      example: m.example,
      ...(m.custom ? { custom: true } : {}),
      found,
      // 이행 근거: 어느 줄, 어느 구절에서 매치됐는가
      evidence: hit ? evidenceAt(t, hit.index, hit.length, opts) : null,
      // 미이행 항목의 근접 발화 (겹치는 발화가 없으면 null)
      near: found ? null : nearestMiss(t, m, opts),
    }
  })
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

// 상담사 발화 줄의 형태. 판별(hasSpeakerLabels)과 추출(agentScript)이 어긋나면
// "라벨이 있다고 표시했는데 상담사 발화는 못 찾는" 상태가 되므로 한 곳에서 쓴다.
const AGENT_LINE_RE = /^\s*(상담사|상담원|agent)\s*[:：]/i
const AGENT_PREFIX_RE = /^\s*(상담사|상담원|agent)\s*[:：]\s*/i

// 화자 라벨이 실제로 있는지 — 없으면 아래 agentLines가 전체 텍스트를 돌려주므로
// 금지 표현 스캔이 고객 발화까지 상담사 감점으로 집계한다("했잖아요", "아 진짜"는
// 화난 고객의 말이다). 점수를 조용히 왜곡하지 않도록 호출부가 이 사실을 표시해야 한다.
export function hasSpeakerLabels(transcript) {
  return (transcript || '').split('\n').some((l) => AGENT_LINE_RE.test(l))
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

// 통화 텍스트에서 상담사 발화만 뽑되, **원문 줄 번호를 함께** 돌려준다.
// 근거를 화면에 보여주려면 "검사한 텍스트의 3번째 줄"이 아니라 "전사의 7번째 줄"이라고
// 말해야 수퍼바이저가 원문에서 그 자리를 찾을 수 있다. agentLines는 텍스트만 반환하므로
// 그 대응이 사라진다 — 그래서 대응표를 만드는 함수를 따로 둔다.
// 반환: { text, lineNumbers[], labeled }
export function agentScript(transcript) {
  const src = transcript || ''
  const all = src.split('\n')
  const picked = []
  all.forEach((line, i) => {
    if (AGENT_LINE_RE.test(line)) picked.push({ no: i + 1, text: line.replace(AGENT_PREFIX_RE, '') })
  })
  // 화자 구분이 없으면 전체를 그대로 본다 — 이때 줄 번호는 원문 줄 번호와 같다
  if (picked.length === 0) return { text: src, lineNumbers: all.map((_, i) => i + 1), labeled: false }
  return { text: picked.map((p) => p.text).join('\n'), lineNumbers: picked.map((p) => p.no), labeled: true }
}

// 통화 텍스트에서 상담사 발화만 추출한다. 화자 구분이 없으면 전체를 반환한다.
export function agentLines(transcript) {
  return agentScript(transcript).text
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
