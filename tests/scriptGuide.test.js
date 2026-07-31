import { describe, it, expect } from 'vitest'
import { guideCall, CALL_STAGES } from '../src/lib/scriptGuide.js'

// 통화 중 가이드는 LLM 없이 즉시 답해야 한다. 순수 함수로 고정한다.

const OPENING_DONE = '상담사: 안녕하세요 한빛텔레콤입니다 상담 품질 향상을 위해 통화 내용이 녹음됩니다'
const THROUGH_VERIFY = `${OPENING_DONE}\n고객: 네\n상담사: 본인 확인을 위해 성함과 생년월일 확인 부탁드립니다`

describe('guideCall — 단계 판정', () => {
  it('아무것도 안 한 상태에서는 오프닝 단계다', () => {
    const g = guideCall('고객: 여보세요')
    expect(g.stage.id).toBe('open')
    expect(g.progress.done).toBe(0)
  })

  it('오프닝을 끝내면 본인 확인 단계로 넘어간다', () => {
    expect(guideCall(OPENING_DONE).stage.id).toBe('verify')
  })

  it('본인 확인까지 끝내면 해결 안내 단계다', () => {
    expect(guideCall(THROUGH_VERIFY).stage.id).toBe('resolve')
  })

  it('이행률을 백분율로 준다', () => {
    const g = guideCall(THROUGH_VERIFY)
    expect(g.progress.done).toBe(3)
    expect(g.progress.total).toBe(5)
    expect(g.progress.ratio).toBe(60)
  })
})

describe('guideCall — 다음 행동 제안', () => {
  it('미이행 멘트를 그대로 말할 수 있는 스크립트와 함께 준다', () => {
    const g = guideCall('고객: 여보세요')
    expect(g.nextActions.length).toBeGreaterThan(0)
    const first = g.nextActions[0]
    expect(first.script.length).toBeGreaterThan(5)
    expect(first.urgent).toBe(true)
    expect(first.stageLabel).toBe('오프닝')
  })

  it('이미 한 것은 제안하지 않는다', () => {
    const ids = guideCall(OPENING_DONE).nextActions.map((a) => a.id)
    expect(ids).not.toContain('greeting')
    expect(ids).not.toContain('recording')
    expect(ids).toContain('identity')
  })

  it('현재 단계가 아닌 제안은 urgent가 아니다', () => {
    const g = guideCall('고객: 여보세요')
    expect(g.nextActions.some((a) => a.urgent === false)).toBe(true)
  })

  it('전부 이행하면 더 제안하지 않는다', () => {
    const all = [
      '상담사: 안녕하세요 한빛텔레콤입니다 통화 내용이 녹음됩니다',
      '상담사: 본인 확인 부탁드립니다',
      '상담사: 말씀하신 건 처리해 드리겠습니다',
      '상담사: 더 도와드릴 부분 없으실까요 좋은 하루 되세요',
    ].join('\n')
    const g = guideCall(all)
    expect(g.nextActions).toEqual([])
    expect(g.progress.ratio).toBe(100)
  })
})

describe('guideCall — 경보', () => {
  it('금지 표현이 나오면 즉시 경보하고 대체 행동을 제시한다', () => {
    const g = guideCall('상담사: 그건 고객님이 잘못 보신 거예요')
    const forbidden = g.alerts.filter((a) => a.kind === 'forbidden')
    expect(forbidden.length).toBeGreaterThan(0)
    expect(forbidden[0].action.length).toBeGreaterThan(5)
    expect(forbidden[0].evidence).toBeTruthy()
  })

  it('고객의 법적 대응 언급은 최고 등급 경보와 응대 스크립트를 준다', () => {
    const g = guideCall('고객: 이거 소송 걸겠습니다')
    const risk = g.alerts.find((a) => a.kind === 'risk')
    expect(risk).toBeTruthy()
    expect(risk.level).toBe('high')
    expect(risk.script).toContain('전담 부서')
  })

  it('해지 의사에는 만류가 아니라 이유 확인을 제안한다', () => {
    const g = guideCall('고객: 해지하겠습니다')
    const risk = g.alerts.find((a) => a.label.includes('해지'))
    expect(risk.detail).toContain('이유 확인')
  })

  it('보상 요구에는 확정 약속을 하지 말라고 알린다', () => {
    const g = guideCall('고객: 보상해 주세요')
    const risk = g.alerts.find((a) => a.label.includes('보상'))
    expect(risk.detail).toContain('확정 약속')
  })

  it('상담사 발화는 고객 위험 신호로 세지 않는다', () => {
    // 상담사가 절차를 안내하며 "해지"를 말한 것을 고객의 해지 의사로 잡으면 안 된다
    const g = guideCall('고객: 요금이 궁금해요\n상담사: 해지 절차를 안내드릴까요')
    expect(g.alerts.filter((a) => a.kind === 'risk')).toEqual([])
  })

  it('평범한 통화에는 경보가 없다', () => {
    expect(guideCall(THROUGH_VERIFY).alerts).toEqual([])
  })
})

describe('guideCall — 경계', () => {
  it('빈 입력에서도 구조를 지킨다', () => {
    const g = guideCall('')
    expect(g.stage.id).toBe('open')
    expect(Array.isArray(g.nextActions)).toBe(true)
    expect(Array.isArray(g.alerts)).toBe(true)
  })

  it('null·undefined에서 터지지 않는다', () => {
    expect(() => guideCall(null)).not.toThrow()
    expect(() => guideCall(undefined)).not.toThrow()
  })

  it('단계 정의가 필수 멘트를 빠짐없이 덮는다', () => {
    const covered = CALL_STAGES.flatMap((s) => s.mentionIds)
    expect(new Set(covered).size).toBe(covered.length) // 중복 없음
    expect(covered).toEqual(expect.arrayContaining(['greeting', 'recording', 'identity', 'solution', 'closing']))
  })
})
