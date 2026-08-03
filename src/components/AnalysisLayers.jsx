// 분석 결과의 "규칙 계층" 표시 — 이탈 위험 · 대화 지표 · 티켓 초안.
//
// 왜 컴포넌트로 뽑는가:
// 이 세 가지는 서버(analyze.js)가 LLM 응답 위에 규칙으로 얹어 항상 함께 보내는 값이다.
// 그런데 파이프라인 화면에만 렌더 코드가 있고, 정작 전용 통화 분석 화면은 같은 응답을
// 받아 놓고 category/sentiment/escalate만 쓰고 나머지를 버렸다 — 서버가 계산해 보낸
// 이탈 위험도, 티켓 초안도 그 화면에서는 존재하지 않는 것과 같았다.
// 두 화면이 각자 렌더를 들고 있으면 한쪽만 고쳐져 또 어긋난다. 한 곳에서 그린다.
import { useEffect, useRef, useState } from 'react'

// 위험 구간을 색으로 구분한다 (숫자만 있으면 급한 건인지 한눈에 안 보인다)
export function churnTone(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'mid'
  return 'low'
}

// 이탈 위험 — 규칙 신호로 계산되므로 AI 키가 없어도 실제 값이 나온다.
// 점수만 보여주면 믿을 근거가 없으므로 신호와 인용 발화를 함께 노출한다.
export function ChurnBox({ churn }) {
  if (!churn || !Number.isFinite(churn.score)) return null
  return (
    <div className="churn-box">
      <div className="churn-head">
        <span className={`churn-level churn-${churnTone(churn.score)}`}>
          이탈 위험 {churn.score}점 · {churn.level}
        </span>
        <span className="usage-note">
          {churn.action}
          {churn.estimated ? ' · 규칙 기반 실측' : churn.adjusted ? ' · 규칙 신호로 보정됨' : ''}
        </span>
      </div>
      {churn.signals?.length > 0 && (
        <ul className="plain-list churn-signals">
          {churn.signals.map((sig) => (
            <li key={sig.id}>
              <strong>{sig.label}</strong>
              {sig.evidence && <span className="churn-quote"> "{sig.evidence}"</span>}
            </li>
          ))}
        </ul>
      )}
      {churn.retentionSignals?.length > 0 && (
        <p className="result-empty-sub">
          완화 신호: {churn.retentionSignals.map((s) => s.label).join(', ')}
        </p>
      )}
      {churn.speakerLabeled === false && (
        <p className="result-empty-sub">
          화자 라벨이 없어 전사 전체를 훑었습니다 — 상담사 발화가 신호로 잡혔을 수 있습니다.
        </p>
      )}
    </div>
  )
}

// 대화 지표 — 화자 라벨이 있을 때만 계산된다(없으면 표시하지 않는다)
export function CallMetricsBox({ metrics, diagnosis }) {
  if (!metrics) return null
  return (
    <div className="metrics-box">
      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-label">발화 비율 (상담사/고객)</span>
          <span className="stat-value">
            {metrics.agentCharRatio}% / {metrics.customerCharRatio}%
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">대화 턴</span>
          <span className="stat-value">{metrics.turns}회</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">확인 질문 / 공감</span>
          <span className="stat-value">
            {metrics.questionTurns} / {metrics.empathyTurns}턴
          </span>
        </div>
      </div>
      {(diagnosis || []).map((d) => (
        <p key={d.id} className={`metric-diag metric-${d.level}`}>
          <strong>{d.label}</strong> — {d.detail}
        </p>
      ))}
    </div>
  )
}

// 티켓 초안 — 분석에서 끝내지 않고 "다음 사람이 쓸 문서"까지 만든다
export function TicketDraftBox({ ticket, onError }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  useEffect(() => () => clearTimeout(timerRef.current), [])
  if (!ticket) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(ticket.text)
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      onError?.('클립보드 복사에 실패했습니다.')
    }
  }

  return (
    <details className="custom-docs ticket-draft">
      <summary>
        🎫 에스컬레이션 티켓 초안 — {ticket.route.priority} {ticket.route.team} ({ticket.route.sla})
      </summary>
      <pre className="ticket-text">{ticket.text}</pre>
      <button type="button" className="btn-ghost" onClick={copy}>
        {copied ? '✓ 티켓 초안 복사됨' : '티켓 초안 복사'}
      </button>
    </details>
  )
}

// 요약·조치의 수치 검증 결과.
//
// 근거율(2-gram)은 표현이 원문과 얼마나 겹치는지를 본다. 그런데 요약은 원래 바꿔 말하는
// 것이라 그 값이 낮게 나오고(실측 0.33), 무엇보다 숫자 하나만 바뀐 문장을 구분하지 못한다.
// 콜센터에서 틀리면 가장 비싼 것이 그 숫자다 — 위약금 액수, 처리 기한.
//
// 통과했을 때도 "몇 개를 대조했는지"를 보여준다. 검증층이 작동할 때만 보이면
// 평가자는 그런 층이 있는지조차 알 수 없다.
export function NumericCheckBox({ numeric }) {
  if (!numeric || !numeric.checked) return null
  const bad = (numeric.unsupported || []).filter((c) => c.critical)
  if (bad.length === 0) {
    return (
      <p className="numeric-check numeric-ok">
        수치 근거 확인 — 요약·조치의 숫자 {numeric.checked}개가 모두 통화 원문에 있습니다.
      </p>
    )
  }
  return (
    <div className="numeric-check numeric-bad">
      <strong>원문에서 확인되지 않는 수치 {bad.length}개</strong>
      <ul className="plain-list">
        {bad.map((c) => (
          <li key={`${c.unit}:${c.value}`}>
            <span className="numeric-claim">{c.text}</span> — 통화에서 이 값을 찾지 못했습니다
          </li>
        ))}
      </ul>
      <span className="guide-detail">금액·기간은 원문에서 확인한 뒤 안내하세요.</span>
    </div>
  )
}

// 네 계층을 한 번에 (analyze 응답을 그대로 넘기면 된다)
export default function AnalysisLayers({ analysis, onError }) {
  if (!analysis) return null
  return (
    <>
      <NumericCheckBox numeric={analysis.numeric} />
      <ChurnBox churn={analysis.churn} />
      <CallMetricsBox metrics={analysis.metrics} diagnosis={analysis.metrics_diagnosis} />
      <TicketDraftBox ticket={analysis.ticket} onError={onError} />
    </>
  )
}
