import { describe, it, expect } from 'vitest'
import { buildPipelineReport } from '../src/lib/pipelineReport.js'
import { planChunks, exceedsChunkLimit, MAX_CHUNKS, CHUNK_SECONDS } from '../src/lib/audioChunk.js'
import {
  hasSpeakerLabels,
  auditComments,
  extractQuotes,
  quoteVerbatimRatio,
  consistencyBand,
} from '../src/lib/qaRules.js'
import { ENDPOINT_LABEL } from '../src/lib/statsSummary.js'

// 감사에서 실제로 발견된 버그들을 다시 들어오지 못하게 막는 테스트.

describe('파이프라인 리포트 — 실패를 침묵으로 넘기지 않는다', () => {
  it('실패한 단계는 실패 사실을 적는다', () => {
    const out = buildPipelineReport({
      stt: { text: '전사 결과' },
      stageErrors: { analyze: '통화 분석은 시간당 6회까지 가능합니다.' },
    })
    expect(out).toContain('④ 통화 분석: 실패')
    expect(out).toContain('시간당 6회')
  })

  it('VOC 누적이 안 됐으면 "누적 완료"라고 쓰지 않는다', () => {
    const out = buildPipelineReport({
      stt: { text: 'x' },
      stageErrors: { voc: '분석이 실패해 이번 통화는 누적하지 않았습니다.' },
    })
    expect(out).not.toContain('누적 완료')
    expect(out).toContain('⑥ VOC 누적: 실패')
  })

  it('전부 성공하면 예전과 같은 리포트를 만든다', () => {
    const out = buildPipelineReport({
      stt: { text: '전사' },
      analysis: { category: '요금', sentiment: '중립', summary: ['한 줄'], actions: ['조치'] },
      qa: { score: { total: 80, grade: 'B', ruleScore: 32, llmScore: 48, deduction: 0 } },
    })
    expect(out).toContain('⑥ VOC 대시보드에 누적 완료')
    expect(out).not.toContain('실패')
  })

  it('추정 점수는 리포트에도 추정으로 적는다', () => {
    const out = buildPipelineReport({
      qa: { score: { total: 60, grade: 'D', ruleScore: 24, llmScore: 36, deduction: 0, llmEstimated: true } },
    })
    expect(out).toContain('(추정)')
  })
})

describe('planChunks — 인수 검증', () => {
  it('청크 길이가 0이나 음수면 빈 배열을 준다 (Infinity 방지)', () => {
    expect(planChunks(130, 0)).toEqual([])
    expect(planChunks(130, -55)).toEqual([])
  })

  it('상한을 넘는 길이는 MAX_CHUNKS로 자른다', () => {
    const chunks = planChunks(MAX_CHUNKS * CHUNK_SECONDS * 3)
    expect(chunks.length).toBe(MAX_CHUNKS)
  })

  it('상한 초과 여부를 디코드 전에 판단할 수 있다', () => {
    expect(exceedsChunkLimit(MAX_CHUNKS * CHUNK_SECONDS + 1)).toBe(true)
    expect(exceedsChunkLimit(MAX_CHUNKS * CHUNK_SECONDS)).toBe(false)
    expect(exceedsChunkLimit(60)).toBe(false)
  })
})

describe('hasSpeakerLabels', () => {
  it('상담사 라벨이 있으면 true', () => {
    expect(hasSpeakerLabels('상담사: 안녕하세요\n고객: 문의요')).toBe(true)
  })

  it('라벨이 없으면 false — 이때 고객 발화까지 채점되므로 화면이 고지해야 한다', () => {
    expect(hasSpeakerLabels('안녕하세요 요금 문의입니다 했잖아요')).toBe(false)
  })

  it('전각 콜론과 agent 표기도 인식한다', () => {
    expect(hasSpeakerLabels('상담원： 네')).toBe(true)
    expect(hasSpeakerLabels('agent: hello')).toBe(true)
  })
})

describe('QA 인용 검증 — 어미 편승과 따옴표 재해석', () => {
  const CALL = [
    '상담사: 안녕하세요, 한빛텔레콤 상담사입니다. 통화 내용이 녹음됩니다.',
    '고객: 요금이 왜 이렇게 올랐나요?',
    '상담사: 본인 확인 부탁드립니다. 다음 달 1일부터 적용되도록 처리해 드리겠습니다.',
  ].join('\n')

  it('하지 않은 약속을 지어낸 인용을 잡는다 (2-gram 방식이 놓치던 1순위 사례)', () => {
    // 전사에 없는 문장인데 "습니/니다" 같은 보편 어미만 겹쳐 0.5~0.75로 통과하던 것들
    for (const fake of ['환불해 드리겠습니다', '알겠습니다', '확인됩니다', '규정입니다']) {
      const r = auditComments([`상담사가 "${fake}"라고 답했습니다.`], CALL)
      expect(r.grounding.flagged).toEqual([0])
    }
  })

  it('전사에 그대로 있는 인용은 통과한다', () => {
    const r = auditComments(['"본인 확인 부탁드립니다"라고 요청했습니다.'], CALL)
    expect(r.grounding.flagged).toEqual([])
    expect(r.grounding.scores[0]).toBe(1)
  })

  it('짧은 인용이 뒤따르는 진짜 인용을 삼키지 않는다', () => {
    // 여닫이를 짝짓지 않으면 "네"의 닫는 따옴표가 여는 것으로 재해석돼
    // 연결어("라고만 답하고")가 인용으로 뽑히고 진짜 인용은 측정조차 되지 않았다.
    const quotes = extractQuotes('상담사는 "네"라고만 답하고 "본인 확인 부탁드립니다"를 이행했습니다.')
    expect(quotes).toContain('네')
    expect(quotes).toContain('본인 확인 부탁드립니다')
    expect(quotes).not.toContain('라고만 답하고')
  })

  it('짧아도 전사에 있으면 허위로 몰지 않는다', () => {
    const r = auditComments(['고객이 "네"라고 답했습니다.'], '고객: 네')
    expect(r.grounding.flagged).toEqual([])
  })

  it('축자 비율은 부분 일치를 비율로 돌려준다', () => {
    expect(quoteVerbatimRatio('본인 확인 부탁드립니다', CALL)).toBe(1)
    expect(quoteVerbatimRatio('전혀 다른 문장입니다', '아무 관련 없는 내용')).toBeLessThan(0.8)
    expect(quoteVerbatimRatio('', CALL)).toBe(0)
    expect(quoteVerbatimRatio('무엇이든', '')).toBe(0)
  })
})

describe('일관성 밴드 — 감점 보류가 상향 보정을 만들지 않는다', () => {
  it('보류로 penalty가 빠져도 하한은 올라가지 않는다', () => {
    const mentions = [{ found: false }, { found: false }, { found: false }, { found: false }, { found: false }]
    const held = [{ deduct: 0 }, { deduct: 0 }, { deduct: 0 }]
    const counted = [{ deduct: 4 }, { deduct: 4 }, { deduct: 4 }]
    // 확인할 수 없는 증거로 점수를 깎지 않겠다는 원칙은 점수를 올려주는 근거도 될 수 없다
    expect(consistencyBand(mentions, held).low).toBeLessThanOrEqual(consistencyBand(mentions, counted).low)
  })
})

describe('ENDPOINT_LABEL — 기록되는 엔드포인트가 모두 한글 라벨을 갖는다', () => {
  // logCall이 실제로 쓰는 endpoint 문자열 전체. 새 엔드포인트를 추가하고 라벨을
  // 빠뜨리면 운영 지표 표에 영어 원문이 그대로 노출된다.
  const LOGGED = ['stt', 'analyze', 'analyze-batch', 'qa', 'search', 'diarize', 'voc-report', 'assist']

  it('라벨 누락이 없다', () => {
    const missing = LOGGED.filter((e) => !ENDPOINT_LABEL[e])
    expect(missing).toEqual([])
  })
})
