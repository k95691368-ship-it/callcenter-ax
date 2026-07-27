import { describe, it, expect } from 'vitest'
import { normalizeForCer, levenshtein, computeCer } from '../src/lib/cer.js'

describe('normalizeForCer', () => {
  it('공백과 문장부호를 제거한다', () => {
    expect(normalizeForCer('안녕하세요, 고객님! (반갑습니다)')).toBe('안녕하세요고객님반갑습니다')
  })
})

describe('levenshtein', () => {
  it('동일 문자열은 거리 0', () => {
    expect(levenshtein('상담사', '상담사')).toBe(0)
  })

  it('삽입·삭제·교체를 각각 1로 센다', () => {
    expect(levenshtein('요금제', '요금제도')).toBe(1)
    expect(levenshtein('요금제', '요금')).toBe(1)
    expect(levenshtein('요금제', '요금표')).toBe(1)
  })

  it('빈 문자열 거리는 상대 길이와 같다', () => {
    expect(levenshtein('', '녹취')).toBe(2)
    expect(levenshtein('녹취', '')).toBe(2)
  })
})

describe('computeCer', () => {
  it('완벽한 전사는 CER 0, 정확도 100%', () => {
    const r = computeCer('본인 확인 부탁드립니다.', '본인 확인 부탁드립니다')
    expect(r.cer).toBe(0)
    expect(r.accuracy).toBe(1)
  })

  it('오류 문자 수 / 정답 길이로 계산한다', () => {
    // 정답 10자 중 1자 교체 → CER 10%
    const r = computeCer('0123456789', '0123456788')
    expect(r.refLength).toBe(10)
    expect(r.distance).toBe(1)
    expect(r.cer).toBeCloseTo(0.1)
  })

  it('정답이 비어 있으면 null을 반환한다', () => {
    expect(computeCer('  ', '전사 결과')).toBeNull()
  })

  it('전사가 정답보다 훨씬 길면 CER이 1을 넘을 수 있고 정확도는 0에서 멈춘다', () => {
    const r = computeCer('네', '네네네네네네')
    expect(r.cer).toBeGreaterThan(1)
    expect(r.accuracy).toBe(0)
  })
})
