import { describe, it, expect } from 'vitest'
import { summarizeStats, isLiveMode, ENDPOINT_LABEL } from '../src/lib/statsSummary.js'

describe('isLiveMode', () => {
  it('live 접두사 모드를 모두 라이브로 판정한다', () => {
    expect(isLiveMode('live')).toBe(true)
    expect(isLiveMode('live-turbo')).toBe(true)
    expect(isLiveMode('live-oss-vector')).toBe(true)
  })

  it('demo·fallback·비문자열은 라이브가 아니다', () => {
    expect(isLiveMode('demo')).toBe(false)
    expect(isLiveMode('fallback')).toBe(false)
    expect(isLiveMode(null)).toBe(false)
  })
})

describe('summarizeStats', () => {
  it('빈 입력이면 0으로 안전하게 반환한다', () => {
    const s = summarizeStats([])
    expect(s.total).toBe(0)
    expect(s.liveRatio).toBe(0)
    expect(s.endpoints).toEqual([])
    expect(summarizeStats(null).total).toBe(0)
  })

  it('같은 엔드포인트의 여러 모드를 합산하고 호출 수 내림차순 정렬한다', () => {
    const s = summarizeStats([
      { endpoint: 'stt', mode: 'live-turbo', calls: 6, avg_latency_ms: 1600 },
      { endpoint: 'stt', mode: 'live-base', calls: 2, avg_latency_ms: 2400 },
      { endpoint: 'analyze', mode: 'live-oss', calls: 10, avg_latency_ms: 3000 },
    ])
    expect(s.endpoints[0].endpoint).toBe('analyze')
    expect(s.endpoints[1].calls).toBe(8)
    expect(s.total).toBe(18)
  })

  it('지연은 호출 수 가중 평균으로 복원한다', () => {
    const s = summarizeStats([
      { endpoint: 'stt', mode: 'live-turbo', calls: 3, avg_latency_ms: 1000 },
      { endpoint: 'stt', mode: 'live-base', calls: 1, avg_latency_ms: 3000 },
    ])
    expect(s.endpoints[0].avgLatencyMs).toBe(1500)
  })

  it('라이브 비율은 live 접두사 호출만 센다', () => {
    const s = summarizeStats([
      { endpoint: 'qa', mode: 'live', calls: 3, avg_latency_ms: 2000 },
      { endpoint: 'qa', mode: 'demo', calls: 1, avg_latency_ms: 5 },
    ])
    expect(s.liveCalls).toBe(3)
    expect(s.liveRatio).toBe(75)
  })

  it('모르는 엔드포인트는 원문 그대로, 아는 것은 한글 라벨을 붙인다', () => {
    const s = summarizeStats([
      { endpoint: 'search', mode: 'live-oss-vector', calls: 1, avg_latency_ms: 900 },
      { endpoint: 'unknown-x', mode: 'demo', calls: 1, avg_latency_ms: null },
    ])
    const search = s.endpoints.find((e) => e.endpoint === 'search')
    expect(search.label).toBe(ENDPOINT_LABEL.search)
    const unknown = s.endpoints.find((e) => e.endpoint === 'unknown-x')
    expect(unknown.label).toBe('unknown-x')
    expect(unknown.avgLatencyMs).toBe(null)
  })
})
