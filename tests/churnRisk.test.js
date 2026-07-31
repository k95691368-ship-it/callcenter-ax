import { describe, it, expect } from 'vitest'
import {
  scanChurnSignals,
  ruleChurnScore,
  riskBand,
  applyChurnBand,
  estimateChurn,
} from '../src/lib/churnRisk.js'

// 이탈 위험 지수는 API 키가 없어도 동작하는 결정적 층이다.
// 점수만 맞추는 테스트가 아니라 "근거가 함께 나오는가"까지 고정한다.

const CALM = '상담사: 안녕하세요 무엇을 도와드릴까요\n고객: 요금제 종류가 궁금해서요'
const CANCEL = '고객: 해지하려고 하는데요 위약금이 얼마인가요 타사로 번호이동 하려고요'
const LEGAL = '고객: 이거 소송 걸겠습니다 소비자원에 신고할 거예요 보상해 주세요'
const RESOLVED = '고객: 아 해결됐네요 감사합니다 계속 쓸게요'

describe('scanChurnSignals', () => {
  it('해지·타사·위약금 신호를 각각 잡는다', () => {
    const ids = scanChurnSignals(CANCEL).risk.map((h) => h.id)
    expect(ids).toContain('cancel-intent')
    expect(ids).toContain('competitor')
    expect(ids).toContain('penalty')
  })

  it('신호마다 원문 근거를 함께 돌려준다 (점수만으로는 믿을 수 없다)', () => {
    const { risk } = scanChurnSignals(CANCEL)
    for (const h of risk) {
      expect(h.evidence.length).toBeGreaterThan(0)
      expect(CANCEL.replace(/\s/g, '')).toContain(h.evidence.replace(/\s/g, '').slice(0, 6))
    }
  })

  it('근거는 줄을 넘어가지 않는다 — 다른 화자의 말을 인용하면 근거가 아니다', () => {
    const t = '고객: 해지하겠습니다\n상담사: 불편을 드려 죄송합니다'
    for (const h of scanChurnSignals(t).risk) {
      expect(h.evidence).not.toContain('상담사')
      expect(h.evidence).not.toContain('\n')
    }
  })

  it('상담사 발화는 고객 신호로 세지 않는다', () => {
    // 상담사의 "말씀 감사합니다"가 고객 만족으로, 안내한 "위약금"이 고객 의사로 잡히면 안 된다
    const t = '고객: 요금제 종류가 궁금해요\n상담사: 말씀 감사합니다 위약금은 12만원입니다 해지 절차를 안내드릴까요'
    const scan = scanChurnSignals(t)
    expect(scan.risk).toEqual([])
    expect(scan.retention).toEqual([])
    expect(scan.labeled).toBe(true)
  })

  it('화자 라벨이 없으면 전문을 훑되 그 사실을 알려준다', () => {
    const scan = scanChurnSignals('해지하고 싶은데요 위약금이 얼마죠')
    expect(scan.labeled).toBe(false)
    expect(scan.risk.length).toBeGreaterThan(0)
  })

  it('같은 신호가 여러 번 나와도 한 번만 센다', () => {
    const { risk } = scanChurnSignals('고객: 해지 해지 해지하겠습니다 해지요')
    expect(risk.filter((h) => h.id === 'cancel-intent')).toHaveLength(1)
  })

  it('위험 신호가 없는 통화는 빈 목록이다', () => {
    expect(scanChurnSignals(CALM).risk).toEqual([])
  })

  it('완화 신호는 위험 신호와 섞지 않는다', () => {
    const scan = scanChurnSignals(RESOLVED)
    expect(scan.retention.length).toBeGreaterThan(0)
    expect(scan.risk).toEqual([])
  })
})

describe('ruleChurnScore', () => {
  it('평온한 문의는 0점이다', () => {
    expect(ruleChurnScore(CALM).score).toBe(0)
  })

  it('해지+타사+위약금은 높은 점수를 준다', () => {
    expect(ruleChurnScore(CANCEL).score).toBeGreaterThanOrEqual(70)
  })

  it('해결·유지 신호는 점수를 낮춘다', () => {
    expect(ruleChurnScore(RESOLVED).score).toBe(0)
  })

  it('점수는 0~100을 벗어나지 않는다', () => {
    const all = `${CANCEL} ${LEGAL} 또 느려요 세 번째입니다 최악이네요 못 믿겠어요`
    const s = ruleChurnScore(all).score
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })

  it('빈 입력·null에서 터지지 않는다', () => {
    expect(ruleChurnScore('').score).toBe(0)
    expect(ruleChurnScore(null).score).toBe(0)
    expect(ruleChurnScore(undefined).score).toBe(0)
  })
})

describe('riskBand', () => {
  it('구간별 조치가 붙는다', () => {
    expect(riskBand(85).level).toBe('높음')
    expect(riskBand(50).level).toBe('중간')
    expect(riskBand(20).level).toBe('낮음')
    expect(riskBand(0).level).toBe('없음')
    expect(riskBand(85).action).toContain('리텐션')
  })
})

describe('applyChurnBand — LLM 점수를 규칙 신호로 보정', () => {
  it('규칙 신호가 많으면 밴드를 좁혀 LLM 재량을 줄인다', () => {
    const wide = applyChurnBand(50, CALM)
    const narrow = applyChurnBand(50, CANCEL)
    expect(narrow.band.high - narrow.band.low).toBeLessThan(wide.band.high - wide.band.low)
  })

  it('규칙 신호와 동떨어진 LLM 점수는 경계로 끌어온다', () => {
    // 해지·타사·위약금이 명확한데 LLM이 0점을 주면 보정되어야 한다
    const r = applyChurnBand(0, CANCEL)
    expect(r.adjusted).toBe(true)
    expect(r.score).toBeGreaterThan(0)
    expect(r.llmScore).toBe(0)
  })

  it('밴드 안의 점수는 그대로 둔다', () => {
    const rule = ruleChurnScore(CANCEL).score
    const r = applyChurnBand(rule, CANCEL)
    expect(r.adjusted).toBe(false)
    expect(r.score).toBe(rule)
  })

  it('보정 결과에도 근거 신호가 남는다', () => {
    const r = applyChurnBand(90, LEGAL)
    expect(r.signals.length).toBeGreaterThan(0)
    expect(r.signals[0]).toHaveProperty('label')
    expect(r.signals[0]).toHaveProperty('evidence')
  })

  it('숫자가 아닌 LLM 값도 안전하게 처리한다', () => {
    expect(applyChurnBand(undefined, CALM).score).toBeGreaterThanOrEqual(0)
    expect(applyChurnBand('높음', CALM).score).toBeGreaterThanOrEqual(0)
  })
})

describe('estimateChurn — 키 없이 동작하는 경로', () => {
  it('추정임을 명시한다', () => {
    const r = estimateChurn(CANCEL)
    expect(r.estimated).toBe(true)
    expect(r.score).toBe(ruleChurnScore(CANCEL).score)
    expect(r.level).toBeTruthy()
    expect(r.action).toBeTruthy()
  })
})

describe('해지 의사를 조사·부사 때문에 놓치지 않는다', () => {
  it('"해지 좀 해주세요"류가 0점으로 나오지 않는다', () => {
    // 이탈 의사를 가장 분명하게 말한 통화가 위험 없음으로 분류되면
    // 이 지표를 보는 이유 자체가 사라진다.
    for (const t of ['해지 좀 해주세요', '해지 부탁드립니다', '해지 요청합니다', '해지 원해요']) {
      expect(estimateChurn(`고객: ${t}`).score).toBeGreaterThan(0)
    }
  })

  it('해지 의사가 아닌 문장까지 잡지는 않는다', () => {
    expect(estimateChurn('고객: 해지 절차가 궁금해서요').score).toBe(0)
    expect(estimateChurn('고객: 요금제만 바꾸고 싶어요').score).toBe(0)
  })
})
