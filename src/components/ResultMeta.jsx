// AI 생성 결과에 붙는 공통 메타 표시: 토큰 사용량·추정 비용, 안내문

// claude-opus-4-8 단가 (USD / 토큰)
const INPUT_PRICE = 5 / 1_000_000
const OUTPUT_PRICE = 25 / 1_000_000

export function UsageNote({ usage }) {
  if (!usage || usage.input_tokens == null) return null
  const cost = usage.input_tokens * INPUT_PRICE + usage.output_tokens * OUTPUT_PRICE
  return (
    <span className="usage-note" title="이번 생성 1회의 실측 토큰 사용량과 추정 비용입니다.">
      claude-opus-4-8 · 입력 {usage.input_tokens.toLocaleString('ko-KR')} · 출력{' '}
      {usage.output_tokens.toLocaleString('ko-KR')} 토큰 · 약 ${cost.toFixed(3)}
    </span>
  )
}

// Workers AI 호출(STT·임베딩) 메타 — 모델명과 실측 지연시간 표시
export function WorkersAiNote({ model, latencyMs }) {
  if (!model) return null
  return (
    <span className="usage-note" title="Cloudflare Workers AI에서 서빙되는 오픈소스 모델입니다.">
      {model} · {latencyMs != null ? `${(latencyMs / 1000).toFixed(1)}초` : 'Workers AI'}
    </span>
  )
}

export function ResultNotice({ text }) {
  if (!text) return null
  return <p className="result-notice">{text}</p>
}
