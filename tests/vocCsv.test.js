import { describe, it, expect } from 'vitest'
import { buildVocCsv } from '../src/lib/vocCsv.js'

describe('buildVocCsv', () => {
  it('헤더와 행을 만들고 출처를 구분한다', () => {
    const csv = buildVocCsv([
      { date: '2026-07-28', title: '요금 문의', analysis: { category: '요금', sentiment: '중립', escalate: false } },
      { date: '2026-07-28', title: '직접 건', analysis: { category: '불만', sentiment: '강성', escalate: true }, mine: true },
    ])
    const lines = csv.split('\n')
    expect(lines[0]).toBe('날짜,제목,유형,감정,에스컬레이션,이탈위험,위험등급,담당,출처')
    expect(lines[1]).toBe('2026-07-28,요금 문의,요금,중립,N,,,,내장 샘플')
    expect(lines[2]).toBe('2026-07-28,직접 건,불만,강성,Y,,,,직접 분석')
  })

  it('이탈 위험과 담당 부서를 열로 내보낸다 (받은 사람이 먼저 정렬하는 열)', () => {
    const csv = buildVocCsv([
      {
        date: '2026-07-28',
        title: '해지 건',
        mine: true,
        analysis: {
          category: '해지',
          sentiment: '강성',
          escalate: true,
          churn: { score: 85, level: '높음' },
          route: { team: '리텐션(해지 방어)팀', priority: 'P1' },
        },
      },
    ])
    const row = csv.split('\n')[1]
    expect(row).toContain('85')
    expect(row).toContain('높음')
    expect(row).toContain('리텐션(해지 방어)팀')
  })

  it('측정하지 않은 통화는 0이 아니라 빈 칸으로 둔다 (0은 "위험 없음"이라는 거짓말이 된다)', () => {
    const csv = buildVocCsv([
      { date: 'd', title: 't', analysis: { category: '기타', sentiment: '중립', escalate: false } },
    ])
    const cells = csv.split('\n')[1].split(',')
    expect(cells[5]).toBe('')
    expect(cells[6]).toBe('')
  })

  it('이탈 위험 0점은 빈 칸이 아니라 0으로 내보낸다 (측정했고 위험이 없었다)', () => {
    const csv = buildVocCsv([
      {
        date: 'd',
        title: 't',
        analysis: { category: '기타', sentiment: '중립', escalate: false, churn: { score: 0, level: '없음' } },
      },
    ])
    const cells = csv.split('\n')[1].split(',')
    expect(cells[5]).toBe('0')
    expect(cells[6]).toBe('없음')
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
