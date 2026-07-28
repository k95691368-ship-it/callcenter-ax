// 텔레메트리 집계 행(엔드포인트·모드별)을 화면용 구조로 변환하는 순수 함수.
// 서버는 GROUP BY 결과만 주고, 라이브 비율·엔드포인트 합산은 여기서 계산한다.

export const ENDPOINT_LABEL = {
  stt: '녹취 전사 (Whisper STT)',
  analyze: '통화 분석 (분류·요약)',
  qa: '상담 품질 평가 (Auto QA)',
  search: 'RAG 지식 검색',
  diarize: '화자 분리',
  'voc-report': 'VOC AI 리포트',
  assist: '실시간 상담 지원',
}

// live / live-turbo / live-oss-vector 등 접두사 live면 실제 AI 호출로 본다
export function isLiveMode(mode) {
  return typeof mode === 'string' && mode.startsWith('live')
}

// live 호출 중 오픈소스 경유(live-oss*, Whisper의 live-turbo/base)와 Claude 경유를 구분한다.
// search의 Claude 경로는 live-hybrid/live-vector처럼 검색 모드가 붙으므로 'oss' 포함 여부로 가른다.
export function liveEngine(mode) {
  if (!isLiveMode(mode)) return null
  return mode.includes('oss') || mode.includes('turbo') || mode.includes('base') ? 'oss' : 'claude'
}

export function summarizeStats(rows) {
  const list = Array.isArray(rows) ? rows : []
  const byEndpoint = new Map()
  let total = 0
  let liveCalls = 0
  let claudeCalls = 0
  let ossCalls = 0

  for (const r of list) {
    const calls = Number(r.calls) || 0
    if (!r.endpoint || calls <= 0) continue
    total += calls
    if (isLiveMode(r.mode)) liveCalls += calls
    const engine = liveEngine(r.mode)
    if (engine === 'claude') claudeCalls += calls
    else if (engine === 'oss') ossCalls += calls

    const cur =
      byEndpoint.get(r.endpoint) || {
        endpoint: r.endpoint,
        calls: 0,
        liveCalls: 0,
        latencySum: 0,
        latencyCalls: 0,
      }
    cur.calls += calls
    if (isLiveMode(r.mode)) cur.liveCalls += calls
    if (typeof r.avg_latency_ms === 'number') {
      // 모드별 평균을 호출 수로 가중 평균해 엔드포인트 평균을 복원한다
      cur.latencySum += r.avg_latency_ms * calls
      cur.latencyCalls += calls
    }
    byEndpoint.set(r.endpoint, cur)
  }

  const endpoints = [...byEndpoint.values()]
    .map((e) => ({
      endpoint: e.endpoint,
      label: ENDPOINT_LABEL[e.endpoint] || e.endpoint,
      calls: e.calls,
      liveCalls: e.liveCalls,
      avgLatencyMs: e.latencyCalls ? Math.round(e.latencySum / e.latencyCalls) : null,
    }))
    .sort((a, b) => b.calls - a.calls)

  return {
    total,
    liveCalls,
    claudeCalls,
    ossCalls,
    liveRatio: total ? Math.round((liveCalls / total) * 100) : 0,
    endpoints,
  }
}
