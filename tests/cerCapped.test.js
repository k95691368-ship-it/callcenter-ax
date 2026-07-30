import { describe, it, expect } from 'vitest'
import { levenshteinCapped, cerWithin, levenshtein } from '../src/lib/cer.js'
import { preservesOriginal } from '../src/lib/diarizeGuard.js'

// 검증층은 "정확한 차이"가 아니라 "임계 안인가"만 알면 된다.
// 전체 DP는 입력이 길어지면 엣지 런타임의 CPU 한도를 넘겨 요청 자체를 죽이므로,
// 상한 밴드 DP로 바꿨다. 아래 테스트는 그 등가성과 상한 동작을 고정한다.

describe('levenshteinCapped', () => {
  it('상한 안에서는 전체 DP와 같은 값을 준다', () => {
    const pairs = [
      ['요금제', '요금제도'],
      ['상담사입니다', '상담사 입니다'],
      ['가입 문의드립니다', '가입 문의 드립니다'],
      ['abcdef', 'abcdef'],
      ['abcdef', 'azcdef'],
    ]
    for (const [a, b] of pairs) {
      const exact = levenshtein(a, b)
      expect(levenshteinCapped(a, b, exact + 2)).toBe(exact)
    }
  })

  it('상한을 넘으면 정확한 값 대신 초과 신호를 준다', () => {
    const d = levenshteinCapped('안녕하세요 고객님', '전혀 다른 문장입니다 완전히', 1)
    expect(d).toBeGreaterThan(1)
  })

  it('길이 차이만으로 초과가 확정되면 DP 없이 판정한다', () => {
    expect(levenshteinCapped('짧다', '아주 많이 긴 문자열입니다 계속 이어집니다', 2)).toBe(3)
  })

  it('같은 문자열은 0이다', () => {
    expect(levenshteinCapped('동일한 문장', '동일한 문장', 0)).toBe(0)
  })

  it('공통 접두·접미가 긴 경우도 정확하다', () => {
    const head = '가'.repeat(500)
    const tail = '나'.repeat(500)
    expect(levenshteinCapped(`${head}A${tail}`, `${head}B${tail}`, 5)).toBe(1)
  })

  it('예산을 넘는 비교는 계산을 포기하고 null을 돌려준다', () => {
    // 서로 완전히 다른 3000자 두 개 — 밴드 폭까지 크면 셀 수가 예산을 넘는다
    const a = '가나다라마'.repeat(600)
    const b = '바사아자차'.repeat(600)
    expect(levenshteinCapped(a, b, 2000, 1000)).toBeNull()
  })

  it('긴 입력에서도 즉시 끝난다 (CPU 한도 보호)', () => {
    const a = '상담사 안녕하세요 요금제 문의 감사합니다 '.repeat(300) // 6000자 급
    const b = a.replace('요금제', '요금 제')
    const started = Date.now()
    const d = levenshteinCapped(a, b, Math.floor(a.length * 0.15))
    expect(d).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('cerWithin', () => {
  it('임계 안이면 실측 CER을 함께 준다', () => {
    const r = cerWithin('0123456789', '0123456788', 0.15)
    expect(r.within).toBe(true)
    expect(r.cer).toBeCloseTo(0.1, 5)
  })

  it('임계를 넘으면 within=false이고 정확한 CER은 계산하지 않는다', () => {
    const r = cerWithin('안녕하세요 요금 문의입니다', '완전히 다른 내용을 지어냈습니다 전부', 0.15)
    expect(r.within).toBe(false)
    expect(r.cer).toBeNull()
  })

  it('빈 원문은 null이다', () => {
    expect(cerWithin('   ', '무언가', 0.15)).toBeNull()
  })
})

describe('preservesOriginal — 검증 불가 처리', () => {
  it('검증할 수 없을 만큼 크면 통과시키지 않고 unverifiable로 표시한다', () => {
    const original = '가나다라마바사'.repeat(500)
    const forged = '아자차카타파하'.repeat(500)
    const g = preservesOriginal(original, forged)
    expect(g.ok).toBe(false)
  })

  it('임계 초과 시 cer은 null이고 통과하지 않는다', () => {
    const g = preservesOriginal('원문 그대로 유지해야 한다', '상담사: 전혀 다른 말을 지어냈습니다 완전히 다르게')
    expect(g.ok).toBe(false)
    expect(g.cer).toBeNull()
  })
})
