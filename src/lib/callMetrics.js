// 통화 대화 지표 — 화자 라벨이 붙은 전사에서 계산하는 결정적 운영 지표.
//
// 콜센터 QA는 "무슨 말을 했는가"만 보지 않는다. 상담사가 고객보다 훨씬 많이 말했는지,
// 고객이 길게 호소하는데 짧게 끊어 답했는지, 질문으로 확인했는지 같은 대화 구조가
// 응대 품질의 큰 부분이다. 이 지표들은 LLM 없이 텍스트만으로 계산되므로
// API 키가 없어도 항상 실제 값이 나온다 — 데모가 아니라 실측이다.
//
// 시간 기반 지표(침묵 구간·발화 속도)는 Whisper 타임스탬프가 있어야 하므로 여기서는
// 문자 수를 대리 지표로 쓴다. 한국어는 글자당 발화 시간이 비교적 일정해 대화 균형을
// 보는 목적에는 충분하다. (근사치임을 화면에도 표시한다)

const AGENT_RE = /^\s*(상담사|상담원|agent)\s*[:：]\s*/i
const CUSTOMER_RE = /^\s*(고객|customer)\s*[:：]\s*/i

// 질문으로 끝나는 발화 — 확인·탐색 질문을 얼마나 했는지 본다
const QUESTION_RE = /(\?|까요|나요|신가요|실까요|가요|런가요)\s*$/

// 공감·완충 표현 — QA의 필수 멘트와는 별개로, 대화 중 얼마나 자주 나왔는지 센다
const EMPATHY_RE =
  /(죄송|불편을\s*드려|이해합니다|그러셨|많이\s*기다리|말씀\s*감사|공감|번거로우|번거롭)/

// 고객 말을 끊는 신호 — 상담사 발화가 접속 부사 없이 곧바로 정정·반박으로 시작
const INTERRUPT_RE = /^(아니|그게\s*아니|그건\s*아니|잠깐|잠시만요|아니요)/

export function parseTurns(transcript) {
  const turns = []
  for (const raw of String(transcript || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (AGENT_RE.test(line)) {
      turns.push({ speaker: 'agent', text: line.replace(AGENT_RE, '').trim() })
    } else if (CUSTOMER_RE.test(line)) {
      turns.push({ speaker: 'customer', text: line.replace(CUSTOMER_RE, '').trim() })
    } else if (turns.length) {
      // 라벨 없는 줄은 앞 발화의 연속으로 본다 (전사가 줄바꿈으로 끊긴 경우)
      turns[turns.length - 1].text += ' ' + line
    }
  }
  return turns.filter((t) => t.text)
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0)

// 반환: 라벨이 없으면 null (계산할 수 없는 것을 0으로 보여주면 거짓말이 된다)
export function computeCallMetrics(transcript) {
  const turns = parseTurns(transcript)
  const agentTurns = turns.filter((t) => t.speaker === 'agent')
  const customerTurns = turns.filter((t) => t.speaker === 'customer')
  if (!agentTurns.length || !customerTurns.length) return null

  const chars = (list) => list.reduce((s, t) => s + t.text.replace(/\s/g, '').length, 0)
  const agentChars = chars(agentTurns)
  const customerChars = chars(customerTurns)
  const totalChars = agentChars + customerChars

  const longestCustomer = customerTurns.reduce(
    (max, t) => Math.max(max, t.text.replace(/\s/g, '').length),
    0
  )

  // 상담사가 연속으로 말한 최대 턴 수 — 고객이 끼어들 틈이 없었는지 본다
  let monologue = 0
  let run = 0
  for (const t of turns) {
    run = t.speaker === 'agent' ? run + 1 : 0
    monologue = Math.max(monologue, run)
  }

  const questions = agentTurns.filter((t) => QUESTION_RE.test(t.text)).length
  const empathy = agentTurns.filter((t) => EMPATHY_RE.test(t.text)).length
  const interrupts = agentTurns.filter((t) => INTERRUPT_RE.test(t.text)).length

  return {
    turns: turns.length,
    agentTurns: agentTurns.length,
    customerTurns: customerTurns.length,
    agentCharRatio: pct(agentChars, totalChars),
    customerCharRatio: pct(customerChars, totalChars),
    avgAgentTurnChars: Math.round(agentChars / agentTurns.length),
    avgCustomerTurnChars: Math.round(customerChars / customerTurns.length),
    longestCustomerTurnChars: longestCustomer,
    agentMonologueMax: monologue,
    questionTurns: questions,
    empathyTurns: empathy,
    interruptTurns: interrupts,
    totalChars,
  }
}

// 지표를 사람이 읽는 진단으로 바꾼다. 임계값은 콜센터 QA에서 통용되는 감각을 기준으로
// 정했고, 근거가 되는 실제 수치를 항상 함께 돌려준다 — 판단은 사람이 하도록.
export function diagnoseCallMetrics(m) {
  if (!m) return []
  const out = []

  if (m.agentCharRatio >= 75) {
    out.push({
      id: 'agent-dominant',
      level: 'warn',
      label: '상담사 발화 편중',
      detail: `상담사가 전체 발화의 ${m.agentCharRatio}%를 차지했습니다 — 고객이 말할 여지가 부족했는지 확인이 필요합니다.`,
    })
  } else if (m.customerCharRatio >= 70) {
    out.push({
      id: 'customer-dominant',
      level: 'info',
      label: '고객 발화 편중',
      detail: `고객이 전체 발화의 ${m.customerCharRatio}%를 차지했습니다 — 호소가 길었던 통화로 보입니다.`,
    })
  } else {
    out.push({
      id: 'balanced',
      level: 'ok',
      label: '대화 균형 양호',
      detail: `상담사 ${m.agentCharRatio}% / 고객 ${m.customerCharRatio}%로 균형이 유지됐습니다.`,
    })
  }

  if (m.agentMonologueMax >= 3) {
    out.push({
      id: 'monologue',
      level: 'warn',
      label: '연속 발화 구간',
      detail: `상담사가 ${m.agentMonologueMax}턴 연속으로 말했습니다 — 중간 확인 질문을 넣는 편이 좋습니다.`,
    })
  }

  if (m.longestCustomerTurnChars >= 120) {
    out.push({
      id: 'long-complaint',
      level: 'info',
      label: '장문 호소 발화',
      detail: `고객의 가장 긴 발화가 ${m.longestCustomerTurnChars}자입니다 — 요약 확인("~말씀이신 거죠?")이 유효한 구간입니다.`,
    })
  }

  if (m.questionTurns === 0) {
    out.push({
      id: 'no-question',
      level: 'warn',
      label: '확인 질문 없음',
      detail: '상담사의 질문형 발화가 없었습니다 — 요구사항을 되짚는 질문이 필요합니다.',
    })
  }

  if (m.empathyTurns === 0) {
    out.push({
      id: 'no-empathy',
      level: 'warn',
      label: '공감 표현 없음',
      detail: '공감·완충 표현이 발견되지 않았습니다.',
    })
  }

  if (m.interruptTurns > 0) {
    out.push({
      id: 'interrupt',
      level: 'warn',
      label: '말 끊기 정황',
      detail: `부정으로 시작하는 상담사 발화가 ${m.interruptTurns}건 있었습니다 — 고객 말을 끊었는지 원문 확인이 필요합니다.`,
    })
  }

  return out
}
