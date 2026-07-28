import { describe, it, expect } from 'vitest'
import {
  checkMentions,
  scanForbidden,
  agentLines,
  computeQaScore,
  MAX_RULE_SCORE,
  REQUIRED_MENTIONS,
  buildCustomMentions,
  mentionRuleSet,
} from '../src/lib/qaRules.js'

const GOOD_CALL = `상담사: 안녕하세요, 한빛텔레콤 상담사입니다. 통화 내용이 녹음됩니다.
고객: 요금제를 바꾸고 싶어요.
상담사: 본인 확인을 위해 성함과 생년월일 부탁드립니다. 변경 처리해 드리겠습니다. 더 도와드릴 부분 없으실까요? 좋은 하루 되세요.`

const BAD_CALL = `상담사: 네, 텔레콤이요.
고객: 명의 변경 어떻게 하나요?
상담사: 그건 저희가 알 수 없어요. 알아서 하셔야 돼요. 아 진짜, 무조건 됩니다.`

describe('checkMentions', () => {
  it('모범 통화는 필수 멘트 5종을 모두 이행으로 본다', () => {
    const mentions = checkMentions(agentLines(GOOD_CALL))
    expect(mentions.every((m) => m.found)).toBe(true)
  })

  it('미흡 통화는 녹취 고지·본인 확인이 미이행으로 잡힌다', () => {
    const mentions = checkMentions(agentLines(BAD_CALL))
    const byId = Object.fromEntries(mentions.map((m) => [m.id, m.found]))
    expect(byId.recording).toBe(false)
    expect(byId.identity).toBe(false)
  })
})

describe('scanForbidden', () => {
  it('금지 표현(책임 회피·반말·과잉 약속)을 검출한다', () => {
    const findings = scanForbidden(agentLines(BAD_CALL))
    const ids = findings.map((f) => f.ruleId)
    expect(ids).toContain('dismissive')
    expect(ids).toContain('informal')
    expect(ids).toContain('overpromise')
  })

  it('깨끗한 통화에서는 아무것도 검출하지 않는다', () => {
    expect(scanForbidden(agentLines(GOOD_CALL))).toEqual([])
  })
})

describe('agentLines', () => {
  it('상담사 발화만 추출한다 — 고객의 금지 표현은 평가 대상이 아니다', () => {
    const call = `상담사: 안내드리겠습니다.
고객: 아 진짜 어쩔 수 없습니다 이건!`
    expect(scanForbidden(agentLines(call))).toEqual([])
  })

  it('화자 구분이 없으면 전체 텍스트를 반환한다', () => {
    expect(agentLines('그냥 텍스트')).toBe('그냥 텍스트')
  })
})

describe('computeQaScore', () => {
  const allFound = REQUIRED_MENTIONS.map((m) => ({ ...m, found: true }))
  const noneFound = REQUIRED_MENTIONS.map((m) => ({ ...m, found: false }))

  it('만점 조건: 멘트 전부 + LLM 만점 + 감점 없음 = 100점 A', () => {
    const s = computeQaScore({
      mentions: allFound,
      findings: [],
      llm: { empathy: 20, clarity: 20, resolution: 20 },
    })
    expect(s.total).toBe(100)
    expect(s.grade).toBe('A')
    expect(s.ruleScore).toBe(MAX_RULE_SCORE)
  })

  it('금지 표현 감점은 최대 20점까지만 깎는다', () => {
    const heavy = Array.from({ length: 10 }, () => ({ deduct: 6 }))
    const s = computeQaScore({ mentions: allFound, findings: heavy, llm: { empathy: 20, clarity: 20, resolution: 20 } })
    expect(s.deduction).toBe(20)
    expect(s.total).toBe(80)
  })

  it('LLM 점수는 항목당 0~20으로 클램프한다', () => {
    const s = computeQaScore({
      mentions: allFound,
      findings: [],
      llm: { empathy: 99, clarity: -5, resolution: 20 },
    })
    expect(s.llmScore).toBe(20 + 0 + 20)
  })

  it('LLM 없이(데모)는 규칙 이행률을 60점 만점으로 환산하고 추정 표시한다', () => {
    const s = computeQaScore({ mentions: allFound, findings: [] })
    expect(s.llmEstimated).toBe(true)
    expect(s.llmScore).toBe(60)
    const zero = computeQaScore({ mentions: noneFound, findings: [] })
    expect(zero.llmScore).toBe(0)
    expect(zero.total).toBe(0)
    expect(zero.grade).toBe('D')
  })

  it('총점은 0 미만으로 내려가지 않는다', () => {
    const s = computeQaScore({ mentions: noneFound, findings: [{ deduct: 15 }], llm: { empathy: 0, clarity: 0, resolution: 0 } })
    expect(s.total).toBe(0)
  })
})

describe('buildCustomMentions', () => {
  it('유효한 입력을 정규화하고 최대 3개까지만 받는다', () => {
    const built = buildCustomMentions([
      { label: ' 청약철회 안내 ', keywords: ['청약철회', ' 14일 이내 ', ''] },
      { label: '요금 고지', keywords: ['요금'] },
      { label: '셋째', keywords: ['셋'] },
      { label: '넷째', keywords: ['넷'] },
    ])
    expect(built).toHaveLength(3)
    expect(built[0].label).toBe('청약철회 안내')
    expect(built[0].keywords).toEqual(['청약철회', '14일 이내'])
    expect(built[0].custom).toBe(true)
  })

  it('라벨이나 키워드가 비면 그 항목은 버린다 (비배열 입력도 안전)', () => {
    expect(buildCustomMentions([{ label: '', keywords: ['a'] }, { label: 'x', keywords: [] }])).toEqual([])
    expect(buildCustomMentions(null)).toEqual([])
    expect(buildCustomMentions('오염된 입력')).toEqual([])
  })
})

describe('mentionRuleSet', () => {
  it('커스텀을 합쳐도 규칙 총점은 항상 40점이다', () => {
    const set = mentionRuleSet(buildCustomMentions([{ label: '추가', keywords: ['추가'] }]))
    expect(set).toHaveLength(6)
    expect(set.reduce((s, m) => s + m.points, 0)).toBe(MAX_RULE_SCORE)
  })

  it('커스텀 없이 호출하면 내장 5개 그대로 8점씩이다', () => {
    const set = mentionRuleSet()
    expect(set).toHaveLength(5)
    expect(set.every((m) => m.points === 8)).toBe(true)
  })
})

describe('checkMentions 커스텀 키워드 판정', () => {
  it('커스텀 규칙은 키워드 포함으로 찾고, 내장 규칙은 정규식으로 찾는다', () => {
    const set = mentionRuleSet(buildCustomMentions([{ label: '청약철회 안내', keywords: ['청약철회'] }]))
    const res = checkMentions('안녕하세요. 청약철회는 14일 이내 가능합니다.', set)
    const custom = res.find((m) => m.custom)
    expect(custom.found).toBe(true)
    expect(res.find((m) => m.id === 'greeting').found).toBe(true)
    const miss = checkMentions('요금 안내입니다.', set).find((m) => m.custom)
    expect(miss.found).toBe(false)
  })
})
