import { describe, it, expect } from 'vitest'
import { buildVocCsv } from '../src/lib/vocCsv.js'

describe('buildVocCsv', () => {
  it('헤더와 행을 만들고 출처를 구분한다', () => {
    const csv = buildVocCsv([
      { date: '2026-07-28', title: '요금 문의', analysis: { category: '요금', sentiment: '중립', escalate: false } },
      { date: '2026-07-28', title: '직접 건', analysis: { category: '불만', sentiment: '강성', escalate: true }, mine: true },
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('날짜,제목,유형,감정,에스컬레이션,출처')
    expect(lines[1]).toBe('2026-07-28,요금 문의,요금,중립,N,내장 샘플')
    expect(lines[2]).toBe('2026-07-28,직접 건,불만,강성,Y,직접 분석')
  })

  it('쉼표·따옴표가 든 제목을 CSV 규칙대로 이스케이프한다', () => {
    const csv = buildVocCsv([
      { date: 'd', title: '항의, "환불" 요구', analysis: { category: '불만', sentiment: '부정', escalate: false } },
    ])
    expect(csv.split('\n')[1]).toContain('"항의, ""환불"" 요구"')
  })

  it('빈·비배열 입력은 헤더만 반환한다', () => {
    expect(buildVocCsv([]).split('\n')).toHaveLength(1)
    expect(buildVocCsv(null).split('\n')).toHaveLength(1)
  })
})
