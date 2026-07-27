import { useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'
import { MAX_RULE_SCORE } from '../lib/qaRules.js'

const GEN_STEPS = [
  '필수 안내 멘트 이행을 규칙으로 스캔하고 있어요',
  '금지 표현을 규칙으로 스캔하고 있어요',
  'LLM이 공감·명확성·해결력을 정성 평가하고 있어요',
  '점수표와 코칭 코멘트를 정리하고 있어요',
]

const GRADE_CLASS = { A: 'qa-grade-a', B: 'qa-grade-b', C: 'qa-grade-c', D: 'qa-grade-d' }

// 점수 게이지 — 단일 값 표시용 반원 게이지 (텍스트 라벨이 값을 직접 전달한다)
function ScoreGauge({ total, grade }) {
  const r = 70
  const half = Math.PI * r
  const filled = (Math.max(0, Math.min(100, total)) / 100) * half
  return (
    <div className={`qa-gauge ${GRADE_CLASS[grade] || ''}`} role="img" aria-label={`총점 ${total}점, 등급 ${grade}`}>
      <svg viewBox="0 0 180 104" width="180" height="104">
        <path d="M 20 94 A 70 70 0 0 1 160 94" fill="none" stroke="var(--line)" strokeWidth="14" strokeLinecap="round" />
        <path
          d="M 20 94 A 70 70 0 0 1 160 94"
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${half}`}
        />
      </svg>
      <div className="qa-gauge-text">
        <strong>{total}</strong>
        <span>/ 100 · {grade}등급</span>
      </div>
    </div>
  )
}

export default function QaPage() {
  const [text, setText] = useState(SAMPLE_CALLS[9].transcript)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const resultRef = useRef(null)

  useEffect(() => {
    const handed = sessionStorage.getItem('cc-transcript')
    if (handed) {
      setText(handed)
      sessionStorage.removeItem('cc-transcript')
    }
  }, [])

  async function evaluate(e) {
    e.preventDefault()
    if (!text.trim()) {
      setError('통화 전사 텍스트를 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await postJson('/api/cc/qa', { transcript: text })
      setResult(data)
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const score = result?.score

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ③ Auto QA · 상담 품질 평가 자동화</span>
        <h1>상담 품질 평가 (Auto QA)</h1>
        <p>
          <strong>규칙 기반 사전 스캔</strong>(필수 안내 멘트 {MAX_RULE_SCORE}점 + 금지 표현 감점)과{' '}
          <strong>LLM 정성 평가</strong>(공감·명확성·해결력 60점)를 합친 이중 구조 100점 점수표입니다.
          규칙 층은 결정적이라 데모 모드에서도 실제로 동작합니다.
        </p>
      </header>

      <div className="tool-layout">
        <form className="tool-form" onSubmit={evaluate}>
          <label>
            통화 전사 텍스트 — 상담사:/고객: 형식이면 상담사 발화만 평가
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={13} />
          </label>
          <div className="batch-meta">
            <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[9].transcript)}>
              샘플: 응대 미흡 사례
            </button>
            <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[0].transcript)}>
              샘플: 모범 응대
            </button>
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '평가 중... (10~30초)' : '품질 평가하기'}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>

        <div className="tool-result" ref={resultRef}>
          {!result && !loading && (
            <div className="result-empty">
              <p>샘플로 "응대 미흡 사례"가 채워져 있어요 — 반말, 책임 회피, 확정 약속이 섞인 통화입니다.</p>
              <p className="result-empty-sub">규칙 스캐너가 몇 건을 잡아내는지, 점수가 어떻게 깎이는지 확인해보세요.</p>
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

              <div className="qa-score-head">
                <ScoreGauge total={score.total} grade={score.grade} />
                <div className="stat-row qa-breakdown">
                  <div className="stat-tile">
                    <span className="stat-label">규칙: 필수 멘트</span>
                    <span className="stat-value">
                      {score.ruleScore}/{MAX_RULE_SCORE}
                    </span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">LLM 정성 평가{score.llmEstimated ? ' (추정)' : ''}</span>
                    <span className="stat-value">{score.llmScore}/60</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">금지 표현 감점</span>
                    <span className="stat-value">-{score.deduction}</span>
                  </div>
                </div>
              </div>

              <section className="analysis-block">
                <h2>필수 안내 멘트 체크리스트 (규칙 기반)</h2>
                <ul className="qa-checklist">
                  {result.mentions.map((m) => (
                    <li key={m.id} className={m.found ? 'ok' : 'miss'}>
                      <span className="qa-check-mark">{m.found ? '✓' : '✗'}</span>
                      <span>
                        <strong>{m.label}</strong> ({m.points}점) — 예: {m.example}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="analysis-block">
                <h2>금지 표현 스캔 (규칙 기반)</h2>
                {result.findings.length === 0 ? (
                  <p className="adcheck ok">✓ 금지 표현이 발견되지 않았습니다</p>
                ) : (
                  <div className="req-table-wrap">
                    <table className="scan-table">
                      <thead>
                        <tr>
                          <th>표현</th>
                          <th>유형</th>
                          <th>감점</th>
                          <th>맥락</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.findings.map((f, i) => (
                          <tr key={i}>
                            <td className="scan-word">"{f.word}"</td>
                            <td>
                              <span className={f.severity === 'high' ? 'sev sev-high' : 'sev sev-mid'}>{f.label}</span>
                            </td>
                            <td>-{f.deduct}</td>
                            <td className="scan-reason">…{f.excerpt}…</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="analysis-block">
                <h2>LLM 평가 코멘트{result.demo ? ' (추정)' : ''}</h2>
                <ul className="plain-list">
                  {(result.comments || []).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                {result.coaching && (
                  <div className="highlight-box">
                    <strong>코칭 한 줄</strong>
                    <p>{result.coaching}</p>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
