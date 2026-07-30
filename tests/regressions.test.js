import { describe, it, expect } from 'vitest'
import { buildPipelineReport } from '../src/lib/pipelineReport.js'
import { planChunks, exceedsChunkLimit, MAX_CHUNKS, CHUNK_SECONDS } from '../src/lib/audioChunk.js'
import { hasSpeakerLabels } from '../src/lib/qaRules.js'
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

describe('ENDPOINT_LABEL — 기록되는 엔드포인트가 모두 한글 라벨을 갖는다', () => {
  // logCall이 실제로 쓰는 endpoint 문자열 전체. 새 엔드포인트를 추가하고 라벨을
  // 빠뜨리면 운영 지표 표에 영어 원문이 그대로 노출된다.
  const LOGGED = ['stt', 'analyze', 'analyze-batch', 'qa', 'search', 'diarize', 'voc-report', 'assist']

  it('라벨 누락이 없다', () => {
    const missing = LOGGED.filter((e) => !ENDPOINT_LABEL[e])
    expect(missing).toEqual([])
  })
})
