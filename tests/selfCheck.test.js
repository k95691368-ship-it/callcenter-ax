import { describe, it, expect } from 'vitest'
import { selfCheck, suggestThemeTerms } from '../src/lib/selfCheck.js'
import { SAMPLE_CALLS } from '../src/lib/sampleCalls.js'

const call = (title, transcript) => ({ id: title, title, transcript })

// 사전에 없는 새 유형 — 실제 콜센터에서 신규 상품·장애가 생기면 이렇게 들어온다
const UNKNOWN = [
  call('유심 문의', '고객: 유심이 인식이 안 돼서요. 유심 재발급 받으려면 어떻게 하나요?'),
  call('유심 교체', '고객: 유심 교체하고 싶은데요. 유심 어디서 받나요?'),
  call('유심 분실', '고객: 유심을 잃어버렸어요. 유심 다시 받을 수 있나요?'),
]

describe('자가 점검 — 시스템이 자기 사각지대를 안다', () => {
  it('내장 샘플에서는 사각지대가 없다고 말한다', () => {
    const r = selfCheck(SAMPLE_CALLS)
    expect(r.taggedRate).toBe(1)
    expect(r.routedDefault).toBe(0)
    expect(r.gaps.some((g) => g.id === 'gap-none')).toBe(true)
  })

  it('사전에 없는 유형이 들어오면 미분류로 드러낸다 (조용히 0건으로 만들지 않는다)', () => {
    const r = selfCheck([...SAMPLE_CALLS, ...UNKNOWN])
    expect(r.untaggedCount).toBe(UNKNOWN.length)
    expect(r.taggedRate).toBeLessThan(1)
  })

  it('미분류가 많아지면 경고를 올린다', () => {
    const r = selfCheck(UNKNOWN)
    expect(r.gaps.some((g) => g.id === 'gap-untagged' && g.level === 'warn')).toBe(true)
  })

  it('빈 입력·null에서 터지지 않는다', () => {
    expect(selfCheck([]).total).toBe(0)
    expect(selfCheck(null).taggedRate).toBe(0)
    expect(selfCheck([]).gaps.length).toBeGreaterThan(0)
  })
})

describe('사전 후보 추천 — 못 잡은 것에서 무엇을 배워야 하는지', () => {
  it('반복되는 새 표현을 후보로 올린다', () => {
    const s = suggestThemeTerms(UNKNOWN)
    expect(s[0].term).toBe('유심')
    expect(s[0].count).toBe(3)
  })

  it('근거 문장을 함께 준다 (후보만 던지면 사람이 판단할 수 없다)', () => {
    expect(suggestThemeTerms(UNKNOWN)[0].examples[0]).toContain('유심')
  })

  it('한 통화에서 같은 말을 여러 번 해도 1건으로 센다 (한 사람이 순위를 만들지 못하게)', () => {
    const one = [call('반복', '고객: 유심 유심 유심 유심이요')]
    expect(suggestThemeTerms(one, { minCount: 1 })[0].count).toBe(1)
  })

  it('한 번만 나온 말은 후보로 올리지 않는다 (우연한 단어로 사전을 늘리지 않게)', () => {
    const s = suggestThemeTerms([call('단발', '고객: 프린터 문의드려요')])
    expect(s).toEqual([])
  })

  it('사전이 이미 아는 말은 후보에서 뺀다 (있는 걸 추가하라고 하면 신뢰를 잃는다)', () => {
    const known = [
      call('a', '고객: 위약금이 얼마인가요'),
      call('b', '고객: 위약금 좀 깎아주세요'),
    ]
    expect(suggestThemeTerms(known).map((s) => s.term)).not.toContain('위약금')
  })

  it('조사가 달라도 같은 말로 묶는다 (속도가/속도를/속도는)', () => {
    const s = suggestThemeTerms([
      call('a', '고객: 셋톱 화면이 안 나와요'),
      call('b', '고객: 셋톱을 바꿔주세요'),
      call('c', '고객: 셋톱은 언제 오나요'),
    ])
    expect(s[0].term).toBe('셋톱')
    expect(s[0].count).toBe(3)
  })

  it('어느 통화에나 나오는 말은 후보가 되지 않는다', () => {
    const s = suggestThemeTerms([
      call('a', '고객: 안녕하세요 문의드려요 감사합니다'),
      call('b', '고객: 안녕하세요 확인 부탁드려요 감사합니다'),
    ])
    expect(s.map((x) => x.term)).not.toContain('안녕하세요')
    expect(s.map((x) => x.term)).not.toContain('감사합니다')
  })

  it('상담사 발화에서는 후보를 뽑지 않는다 (안내 문구가 사전이 되면 안 된다)', () => {
    const s = suggestThemeTerms([
      call('a', '상담사: 접수번호를 문자로 보내드리겠습니다\n고객: 네'),
      call('b', '상담사: 접수번호를 문자로 보내드리겠습니다\n고객: 알겠어요'),
    ])
    expect(s.map((x) => x.term)).not.toContain('접수번호')
  })
})
