import { describe, it, expect } from 'vitest'
import { buildPipelineReport } from '../src/lib/pipelineReport.js'

const FULL = {
  stt: { text: '안녕하세요 한빛텔레콤입니다' },
  lex: { applied: [{ term: '한빛텔레콤', count: 1 }] },
  dia: { formatted: '상담사: 안녕하세요 한빛텔레콤입니다' },
  analysis: {
    category: '요금',
    sentiment: '중립',
    escalate: false,
    summary: ['요금제 변경 문의', '다음 달 적용 안내'],
    actions: ['변경 접수'],
  },
  qa: {
    score: { total: 85, grade: 'B', ruleScore: 32, llmScore: 55, deduction: 2 },
    coaching: '처리 기한을 숫자로 안내하세요.',
  },
}

describe('buildPipelineReport', () => {
  it('6단계 결과를 모두 담은 리포트를 만든다', () => {
    const r = buildPipelineReport(FULL)
    expect(r).toContain('① STT 전사')
    expect(r).toContain('→ 한빛텔레콤 ×1')
    expect(r).toContain('③ 화자 분리')
    expect(r).toContain('유형: 요금 / 감정: 중립')
    expect(r).toContain('총점 85/100 (B등급)')
    expect(r).toContain('코칭: 처리 기한을 숫자로 안내하세요.')
  })

  it('에스컬레이션 건은 경고를 표시한다', () => {
    const r = buildPipelineReport({ ...FULL, analysis: { ...FULL.analysis, escalate: true } })
    expect(r).toContain('⚠ 에스컬레이션 필요')
  })

  it('보정이 없으면 "보정할 용어 없음"으로 표시한다', () => {
    const r = buildPipelineReport({ ...FULL, lex: { applied: [] } })
    expect(r).toContain('보정할 용어 없음')
  })

  it('부분 결과(null 단계)에도 안전하다', () => {
    const r = buildPipelineReport({ stt: FULL.stt, lex: null, dia: null, analysis: null, qa: null })
    expect(r).toContain('① STT 전사')
    expect(r).not.toContain('③ 화자 분리')
    expect(r).not.toContain('⑤ Auto QA')
  })
})
