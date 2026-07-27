import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'

const GEN_STEPS = [
  '통화 내용을 읽고 문의 유형을 분류하고 있어요',
  '핵심 내용을 3줄로 요약하고 있어요',
  '고객 감정과 후속 조치를 판단하고 있어요',
  '사람의 판단이 필요한 건인지 선별하고 있어요',
]

const CATEGORY_COLOR = {
  가입: 'cat-praise',
  해지: 'cat-refund',
  요금: 'cat-ship',
  불만: 'cat-quality',
  기타: 'cat-etc',
}

const SENTIMENT_COLOR = {
  긍정: 'cat-praise',
  중립: 'cat-etc',
  부정: 'cat-ship',
  강성: 'cat-quality',
}

const PRESETS = [
  { label: '요금제 변경 (일반)', call: SAMPLE_CALLS[0] },
  { label: '로밍 요금 항의 (강성)', call: SAMPLE_CALLS[2] },
  { label: '위약금 감면 요구', call: SAMPLE_CALLS[7] },
]

export default function AnalyzePage() {
  const navigate = useNavigate()
  const [text, setText] = useState(SAMPLE_CALLS[2].transcript)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const resultRef = useRef(null)

  // /stt에서 "분석으로 보내기"로 넘어온 전사를 이어받는다
  useEffect(() => {
    const handed = sessionStorage.getItem('cc-transcript')
    if (handed) {
      setText(handed)
      sessionStorage.removeItem('cc-transcript')
    }
  }, [])

  async function analyze(e) {
    e.preventDefault()
    if (!text.trim()) {
      setError('통화 전사 텍스트를 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await postJson('/api/cc/analyze', { transcript: text })
      setResult(data)
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function sendToQa() {
    sessionStorage.setItem('cc-transcript', text)
    navigate('/qa')
  }

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ② LLM·NLP · 분류/요약/VOC·의도 분석</span>
        <h1>통화 분석</h1>
        <p>
          전사 텍스트를 구조화 LLM 호출로 분석합니다 — 문의 유형 분류, 3줄 요약, 고객 감정,
          의도 키워드, 후속 조치까지. 법적 클레임·강성 민원은 AI가 결론 내리지 않고{' '}
          <strong>담당자 에스컬레이션으로 올립니다</strong> — 반복은 대체하고, 판단은 남기는
          설계입니다.
        </p>
      </header>

      <div className="tool-layout">
        <form className="tool-form" onSubmit={analyze}>
          <label>
            통화 전사 텍스트 — 상담사:/고객: 형식 권장
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={13} />
          </label>
          <div className="batch-meta">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="preset-chip" onClick={() => setText(p.call.transcript)}>
                {p.label}
              </button>
            ))}
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '분석 중... (10~30초)' : '통화 분석하기'}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>

        <div className="tool-result" ref={resultRef}>
          {!result && !loading && (
            <div className="result-empty">
              <p>샘플로 "로밍 요금 항의(강성)" 통화가 채워져 있어요.</p>
              <p className="result-empty-sub">
                AI가 이 건을 강성 민원으로 감지해 "담당자 확인 필요"로 올리는지 지켜보세요.
              </p>
            </div>
          )}
          {loading && <GenProgress steps={GEN_STEPS} />}
          {result && !loading && (
            <>
              <ResultNotice text={result.notice} />
              <div className="result-toolbar">
                {result.demo && <DemoBadge />}
                <UsageNote usage={result.usage} />
              </div>

              <div className="chip-row analysis-badges">
                <span className={`cat-badge ${CATEGORY_COLOR[result.category] || 'cat-etc'}`}>
                  유형: {result.category}
                </span>
                <span className={`cat-badge ${SENTIMENT_COLOR[result.sentiment] || 'cat-etc'}`}>
                  감정: {result.sentiment}
                </span>
                {result.escalate && (
                  <span className="escalate-badge" title={result.escalate_reason || '담당자 판단 필요'}>
                    ⚠ 담당자 확인 필요
                  </span>
                )}
              </div>
              {result.sentiment_reason && <p className="result-empty-sub">감정 판정 근거: {result.sentiment_reason}</p>}

              <section className="analysis-block">
                <h2>3줄 요약</h2>
                <ol className="plain-list">
                  {(result.summary || []).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>

              <section className="analysis-block">
                <h2>고객 의도 키워드</h2>
                <div className="chip-row">
                  {(result.intent_keywords || []).map((k) => (
                    <span className="chip" key={k}>
                      {k}
                    </span>
                  ))}
                </div>
              </section>

              <section className="analysis-block">
                <h2>후속 조치 제안</h2>
                <ul className="plain-list">
                  {(result.actions || []).map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </section>

              {result.escalate && (
                <div className="highlight-box escalate-box">
                  <strong>에스컬레이션 사유</strong>
                  <p>{result.escalate_reason || '사람 담당자의 판단이 필요한 건입니다.'}</p>
                </div>
              )}

              <button type="button" className="btn-ghost" onClick={sendToQa}>
                이 통화를 Auto QA로 평가하기 →
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
