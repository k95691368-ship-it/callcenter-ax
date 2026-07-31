// 이탈(해지) 위험 지수 — 통신사 콜센터의 핵심 KPI다.
//
// "이 통화가 해지로 이어질 위험이 얼마인가"는 분류·요약보다 운영에 직접 쓰인다.
// 위험이 높은 통화를 그날 안에 리텐션 팀으로 넘길 수 있으면 그게 곧 매출 방어다.
//
// 설계 원칙은 이 프로젝트의 다른 검증층과 같다 — LLM 판단을 그대로 쓰지 않는다.
// 결정적 규칙으로 신호를 세고, LLM 점수가 그 신호에서 크게 벗어나면 보정한다.
// 근거(어떤 표현이 몇 번 나왔는가)를 항상 함께 돌려주므로, 점수를 못 믿겠으면
// 근거를 보고 사람이 판단할 수 있다.

import { ESCALATION_RE } from './escalationTerms.js'
import { parseTurns } from './callMetrics.js'

// 신호별 가중치 — 값의 근거는 "해지로 가는 경로에서 얼마나 늦은 단계인가"다.
// 타사 비교·해지 절차 문의는 이미 결정에 가깝고, 단순 불만은 아직 되돌릴 수 있다.
export const CHURN_SIGNALS = [
  {
    id: 'cancel-intent',
    label: '해지 의사 직접 표현',
    weight: 30,
    // '해지' 뒤에 조사·부사가 끼면 통째로 놓쳤다 — "해지 좀 해주세요", "해지 부탁드립니다",
    // "해지 요청합니다"가 전부 0점 '조치 불필요'로 나왔다. 이탈 의사를 가장 분명하게
    // 말한 통화가 위험 없음으로 분류되면, 이 지표를 보는 이유 자체가 사라진다.
    // '해지'와 요청 동사 사이에 짧은 말이 끼는 것을 허용한다.
    patterns: [
      /해지(하|할|해\s*주|하겠|하려)/,
      /해지.{0,4}(해\s*주|부탁|요청|신청|원해|하고\s*싶)/,
      /끊(을|겠|어\s*주)/,
      /그만\s*(쓰|이용)/,
      /계약\s*종료/,
    ],
  },
  {
    id: 'competitor',
    label: '타사 비교·이동 언급',
    weight: 25,
    patterns: [/타사/, /다른\s*(통신사|회사|업체)/, /번호\s*이동/, /갈아타/, /옮기(려|겠|고)/],
  },
  {
    id: 'penalty',
    label: '위약금·잔여 약정 확인',
    weight: 18,
    patterns: [/위약금/, /해지\s*수수료/, /약정\s*(기간|남은|얼마)/, /할인\s*반환금/],
  },
  {
    id: 'repeat-issue',
    label: '반복 장애·재문의',
    weight: 15,
    patterns: [/또\s*(느려|끊|안|같은)/, /(두|세|네|몇)\s*번째/, /계속\s*(느려|끊|안\s*돼)/, /지난번에도/],
  },
  {
    id: 'legal',
    label: '법적 대응·외부 제보 언급',
    weight: 20,
    // 표제어·축약형을 함께 아는 공용 목록을 쓴다(사전 보정 후에도 걸리도록)
    patterns: [ESCALATION_RE, /민원\s*접수/],
  },
  {
    id: 'compensation',
    label: '보상·감면 요구',
    weight: 12,
    patterns: [/보상/, /배상/, /감면/, /환불/, /(요금|위약금).*(면제|빼|깎)/],
  },
  {
    id: 'trust-loss',
    label: '신뢰 상실 표현',
    weight: 10,
    patterns: [/못\s*믿/, /믿을\s*수\s*없/, /실망/, /최악/, /형편없/, /어이가\s*없/],
  },
]

// 위험을 낮추는 신호 — 해결 확인·유지 의사는 감점 요인이다.
export const RETENTION_SIGNALS = [
  {
    id: 'resolved',
    label: '해결·만족 확인',
    weight: -12,
    patterns: [/해결(됐|되었|됨)/, /고맙|감사/, /만족/, /친절/, /그럼\s*(그렇게|그걸로)/],
  },
  {
    id: 'stay',
    label: '유지·재계약 의사',
    weight: -15,
    patterns: [/계속\s*(쓰|이용)/, /유지하/, /그대로\s*둘/, /재계약/, /연장하/],
  },
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// 이탈 위험은 **고객이 무엇을 말했는가**의 문제다. 상담사 발화까지 함께 훑으면
// "말씀 감사합니다"(상담사의 상투어)가 고객의 만족 신호로 잡히고, 상담사가 안내한
// "위약금은 12만원입니다"가 고객의 해지 의사처럼 계산된다.
// 화자 라벨이 있으면 고객 발화만 보고, 없으면 전문을 쓴다(그 사실을 함께 돌려준다).
function customerLines(transcript) {
  const turns = parseTurns(transcript)
  const customer = turns.filter((t) => t.speaker === 'customer').map((t) => t.text)
  if (customer.length) return { lines: customer, labeled: true }
  const lines = String(transcript || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { lines, labeled: false }
}

// 매칭된 자리 주변을 잘라 근거로 보여준다 (점수만 주면 믿을 근거가 없다).
// 잘라내기는 **그 줄 안에서만** 한다 — 줄을 넘어가면 다른 화자의 말이 근거로 인용된다.
function excerpt(line, pattern) {
  const m = line.match(pattern)
  if (!m) return line.slice(0, 40).trim()
  const at = m.index ?? 0
  return line.slice(Math.max(0, at - 12), at + m[0].length + 18).trim()
}

// 전사에서 신호를 센다.
// 반환: { risk[], retention[], labeled } — 위험과 완화 신호를 섞지 않는다.
// (섞어서 돌려주면 화면의 "위험 신호" 목록에 "해결·만족 확인"이 끼어든다)
export function scanChurnSignals(transcript) {
  const { lines, labeled } = customerLines(transcript)
  const collect = (defs) => {
    const hits = []
    for (const sig of defs) {
      // 같은 신호가 여러 번 나와도 한 번만 센다 — 반복 언급으로 점수가 부풀지 않게.
      for (const line of lines) {
        const matched = sig.patterns.find((p) => p.test(line))
        if (matched) {
          hits.push({ id: sig.id, label: sig.label, weight: sig.weight, evidence: excerpt(line, matched) })
          break
        }
      }
    }
    return hits
  }
  return { risk: collect(CHURN_SIGNALS), retention: collect(RETENTION_SIGNALS), labeled }
}

// 규칙 신호만으로 계산한 위험 점수 (0~100). LLM 없이도 항상 나오는 결정적 값.
export function ruleChurnScore(transcript) {
  const scan = scanChurnSignals(transcript)
  const raw = [...scan.risk, ...scan.retention].reduce((s, h) => s + h.weight, 0)
  return { score: clamp(raw, 0, 100), hits: scan.risk, retention: scan.retention, labeled: scan.labeled }
}

export function riskBand(score) {
  if (score >= 70) return { level: '높음', action: '리텐션 팀 당일 이관' }
  if (score >= 40) return { level: '중간', action: '해피콜 예약 · 혜택 안내' }
  if (score >= 15) return { level: '낮음', action: '통상 후속 처리' }
  return { level: '없음', action: '조치 불필요' }
}

// LLM이 준 점수를 규칙 신호로 만든 기대 구간 안으로 보정한다.
// QA 일관성 밴드와 같은 발상이다 — LLM은 통화 맥락을 읽지만 점수 스케일이 흔들리고,
// 규칙은 맥락을 못 읽지만 흔들리지 않는다. 둘을 겹쳐 쓴다.
// 규칙 신호가 강할수록(증거가 많을수록) 밴드를 좁혀 LLM 재량을 줄인다.
export function applyChurnBand(llmScore, text) {
  const rule = ruleChurnScore(text)
  const width = rule.hits.length >= 3 ? 15 : rule.hits.length >= 1 ? 25 : 40
  const low = clamp(rule.score - width, 0, 100)
  const high = clamp(rule.score + width, 0, 100)
  // LLM이 점수를 **주지 않은 것**과 0점이라고 **말한 것**은 다르다.
  // Number(x)||0으로 뭉개면 값이 빠졌을 때 0점으로 간주돼 밴드 하한(low)으로 끌려간다 —
  // 규칙이 65점(해지 의사 + 반복 장애 + 법적 대응)이라고 본 통화가 50점 '중간'으로
  // 조용히 강등되고, 화면에는 그것이 추정이라는 표시조차 없었다.
  // 값이 없으면 규칙 점수를 그대로 쓰고 추정이라고 밝힌다.
  const given = Number.isFinite(Number(llmScore)) && llmScore !== null && llmScore !== ''
  const raw = given ? clamp(Math.round(Number(llmScore)), 0, 100) : null
  const score = raw == null ? rule.score : clamp(raw, low, high)
  return {
    score,
    // 규칙 점수로 대신한 경우 — 화면이 '추정'으로 표시할 근거다
    estimated: raw == null,
    adjusted: raw != null && score !== raw,
    llmScore: raw,
    ruleScore: rule.score,
    band: { low, high },
    ...signalView(rule),
    ...riskBand(score),
  }
}

// LLM이 없을 때(데모·폴백)는 규칙 점수를 그대로 쓴다 — 추정임을 표시한다.
export function estimateChurn(text) {
  const rule = ruleChurnScore(text)
  return {
    score: rule.score,
    estimated: true,
    ruleScore: rule.score,
    ...signalView(rule),
    ...riskBand(rule.score),
  }
}

// 화면·티켓에 실을 근거. 화자 라벨이 없었다면 그 사실을 함께 넘긴다 —
// 상담사 발화가 섞여 계산됐을 수 있다는 뜻이므로 숨기면 안 된다.
function signalView(rule) {
  const strip = (h) => ({ id: h.id, label: h.label, evidence: h.evidence })
  return {
    signals: rule.hits.map(strip),
    retentionSignals: rule.retention.map(strip),
    speakerLabeled: rule.labeled,
  }
}
