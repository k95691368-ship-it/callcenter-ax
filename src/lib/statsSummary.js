// 텔레메트리 집계 행(엔드포인트·모드별)을 화면용 구조로 변환하는 순수 함수.
// 서버는 GROUP BY 결과만 주고, 라이브 비율·엔드포인트 합산은 여기서 계산한다.

export const ENDPOINT_LABEL = {
  stt: '녹취 전사 (Whisper STT)',
  analyze: '통화 분석 (분류·요약)',
  'analyze-batch': '일괄 통화 분석',
  qa: '상담 품질 평가 (Auto QA)',
  search: 'RAG 지식 검색',
  diarize: '화자 분리',
  'voc-report': 'VOC AI 리포트',
  assist: '실시간 상담 지원',
}

// 폴백 사유 라벨 — 시스템이 "왜 실패했는지"를 화면에서도 구분해 말한다.
// 고칠 수 있는 실패(우리 상한이 작았다)와 고칠 수 없는 실패(공급자 거절)를
// 같은 "폴백"으로 묶어 보여주면, 지표를 봐도 다음에 무엇을 할지 알 수 없다.
export const FAILURE_LABEL = {
  'fallback-refusal': 'AI 안전 정책 거절',
  'fallback-max-tokens': '응답 절단 (상한 초과)',
  'fallback-deadline': '시간 예산 초과',
  'fallback-timeout': '응답 지연',
  'fallback-http': '공급자 오류 (HTTP)',
  'fallback-no-key': 'API 키 없음',
  'fallback-contract': '응답 계약 위반',
  fallback: '기타 실패',
}

// live / live-turbo / live-oss-vector 등 접두사 live면 실제 AI 호출로 본다
export function isLiveMode(mode) {
  return typeof mode === 'string' && mode.startsWith('live')
}

// 폴백 계열인가 — 사유가 붙은 fallback-* 도 폴백으로 센다.
// 이 판정이 빠지면 사유를 기록하기 시작한 순간 "폴백 0회"로 보여 개선이 퇴행처럼 읽힌다.
export function isFallbackMode(mode) {
  return typeof mode === 'string' && (mode === 'fallback' || mode.startsWith('fallback-'))
}

export function failureLabel(mode) {
  return FAILURE_LABEL[mode] || mode
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
  let fallbackCalls = 0
  let guardedCalls = 0
  const failureReasons = new Map()

  for (const r of list) {
    const calls = Number(r.calls) || 0
    if (!r.endpoint || calls <= 0) continue
    total += calls
    if (isLiveMode(r.mode)) liveCalls += calls
    if (isFallbackMode(r.mode)) {
      fallbackCalls += calls
      failureReasons.set(r.mode, (failureReasons.get(r.mode) || 0) + calls)
    }
    if (r.mode === 'guarded') guardedCalls += calls
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

  // 사유가 붙은 폴백만 따로 낸다. 사유 없는 'fallback'은 옛 기록이거나 분류되지 않은
  // 실패라 섞어 보여주면 "원인을 안다"는 인상만 주고 실제로는 모르는 상태가 된다.
  const failures = [...failureReasons.entries()]
    .map(([mode, calls]) => ({ mode, label: failureLabel(mode), calls, classified: mode !== 'fallback' }))
    .sort((a, b) => b.calls - a.calls)

  return {
    total,
    liveCalls,
    claudeCalls,
    ossCalls,
    fallbackCalls,
    guardedCalls,
    failures,
    classifiedFailures: failures.filter((f) => f.classified).reduce((s, f) => s + f.calls, 0),
    liveRatio: total ? Math.round((liveCalls / total) * 100) : 0,
    endpoints,
  }
}
