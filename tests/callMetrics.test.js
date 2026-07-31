import { describe, it, expect } from 'vitest'
import { parseTurns, computeCallMetrics, diagnoseCallMetrics } from '../src/lib/callMetrics.js'

// 대화 지표는 화자 라벨만 있으면 계산되는 실측값이다(API 키 불필요).
// 계산할 수 없을 때 0을 보여주지 않는다는 계약이 중요하다 — 0은 거짓말이 된다.

const LABELED = [
  '상담사: 안녕하세요 한빛텔레콤입니다 무엇을 도와드릴까요',
  '고객: 요금이 왜 이렇게 많이 나왔죠 지난달보다 두 배예요',
  '상담사: 불편을 드려 죄송합니다 확인해 보겠습니다',
  '고객: 빨리 좀 확인해 주세요',
  '상담사: 데이터 초과 사용분이 청구되었습니다 요금제를 상향하시겠어요',
].join('\n')

describe('parseTurns', () => {
  it('상담사·고객 발화를 순서대로 나눈다', () => {
    const turns = parseTurns(LABELED)
    expect(turns).toHaveLength(5)
    expect(turns[0].speaker).toBe('agent')
    expect(turns[1].speaker).toBe('customer')
    expect(turns[0].text).not.toContain('상담사:')
  })

  it('라벨 없는 줄은 앞 발화의 연속으로 붙인다 (줄바꿈으로 끊긴 전사)', () => {
    const turns = parseTurns('상담사: 안녕하세요\n계속 이어지는 말입니다\n고객: 네')
    expect(turns).toHaveLength(2)
    expect(turns[0].text).toContain('계속 이어지는')
  })

  it('빈 입력에서 빈 배열을 준다', () => {
    expect(parseTurns('')).toEqual([])
    expect(parseTurns(null)).toEqual([])
  })
})

describe('computeCallMetrics', () => {
  it('라벨이 없으면 null을 준다 — 계산할 수 없는 것을 0으로 보여주지 않는다', () => {
    expect(computeCallMetrics('안녕하세요 요금 문의입니다')).toBeNull()
  })

  it('한쪽 화자만 있으면 null을 준다', () => {
    expect(computeCallMetrics('상담사: 안녕하세요\n상담사: 확인하겠습니다')).toBeNull()
  })

  it('발화 비율이 100%로 합산된다', () => {
    const m = computeCallMetrics(LABELED)
    expect(Math.round(m.agentCharRatio + m.customerCharRatio)).toBe(100)
  })

  it('턴 수를 정확히 센다', () => {
    const m = computeCallMetrics(LABELED)
    expect(m.turns).toBe(5)
    expect(m.agentTurns).toBe(3)
    expect(m.customerTurns).toBe(2)
  })

  it('상담사 연속 발화 구간을 잡는다', () => {
    const m = computeCallMetrics('고객: 네\n상담사: 하나\n상담사: 둘\n상담사: 셋\n고객: 알겠어요')
    expect(m.agentMonologueMax).toBe(3)
  })

  it('질문형 발화와 공감 표현을 센다', () => {
    const m = computeCallMetrics(LABELED)
    expect(m.questionTurns).toBeGreaterThan(0)
    expect(m.empathyTurns).toBeGreaterThan(0)
  })

  it('말 끊기 정황(부정으로 시작하는 상담사 발화)을 센다', () => {
    const m = computeCallMetrics('고객: 그게 아니라\n상담사: 아니요 그건 아닙니다\n고객: 네')
    expect(m.interruptTurns).toBe(1)
  })

  it('가장 긴 고객 발화 길이를 잡는다', () => {
    const long = '가'.repeat(150)
    const m = computeCallMetrics(`상담사: 네\n고객: ${long}\n고객: 짧게`)
    expect(m.longestCustomerTurnChars).toBe(150)
  })
})

describe('diagnoseCallMetrics', () => {
  it('null이면 진단이 없다', () => {
    expect(diagnoseCallMetrics(null)).toEqual([])
  })

  it('상담사 발화가 편중되면 경고한다', () => {
    const m = computeCallMetrics(`상담사: ${'가'.repeat(400)}\n고객: 네`)
    const ids = diagnoseCallMetrics(m).map((d) => d.id)
    expect(ids).toContain('agent-dominant')
  })

  it('균형이 맞으면 양호로 판정한다', () => {
    const m = computeCallMetrics(`상담사: ${'가'.repeat(50)}\n고객: ${'나'.repeat(50)}`)
    const ids = diagnoseCallMetrics(m).map((d) => d.id)
    expect(ids).toContain('balanced')
  })

  it('확인 질문·공감이 없으면 각각 경고한다', () => {
    const m = computeCallMetrics('상담사: 처리했습니다\n고객: 네')
    const ids = diagnoseCallMetrics(m).map((d) => d.id)
    expect(ids).toContain('no-question')
    expect(ids).toContain('no-empathy')
  })

  it('진단에는 근거 수치가 들어간다', () => {
    const m = computeCallMetrics(LABELED)
    for (const d of diagnoseCallMetrics(m)) {
      expect(d.detail.length).toBeGreaterThan(0)
      expect(['ok', 'info', 'warn']).toContain(d.level)
    }
  })
})
