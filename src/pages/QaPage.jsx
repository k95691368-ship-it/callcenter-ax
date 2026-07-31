import { useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import CharCount from '../components/CharCount.jsx'
import { VerifyBadge } from '../components/VerifyBadge.jsx'
import { revealElement } from '../components/motion.js'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'
import { MAX_RULE_SCORE, MAX_CUSTOM_MENTIONS } from '../lib/qaRules.js'
import { usePersistentState } from '../lib/persist.js'

// 서버가 조용히 잘라내는 상한 (functions/api/cc/qa.js의 MAX_CHARS)
const MAX_TRANSCRIPT_CHARS = 8000

const EMPTY_CUSTOM = Array.from({ length: MAX_CUSTOM_MENTIONS }, () => ({ label: '', keywords: '' }))

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

  const [copied, setCopied] = useState(false)
  // 복사 실패를 좌측 폼의 setError로 보내면 화면 반대편에 떠서 버튼을 누른 사람이
  // 알아채지 못한다. 버튼 옆에 붙는 별도 상태로 분리한다.
  const [copyError, setCopyError] = useState('')
  const copyTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])
  // 콜센터별 커스텀 체크리스트 — 라벨 + 키워드(쉼표 구분)를 서버 규칙 스캔에 합류시킨다.
  // 브라우저에만 보관되어 재방문에도 유지된다 (서버 미저장).
  const [customRules, setCustomRules] = usePersistentState('cc-qa-custom', EMPTY_CUSTOM)

  function setCustomRule(i, field, value) {
    setCustomRules((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))
  }

  function customPayload() {
    return customRules
      .filter((r) => r.label.trim() && r.keywords.trim())
      .map((r) => ({ label: r.label, keywords: r.keywords.split(',').map((k) => k.trim()).filter(Boolean) }))
  }

  // QA 점수표를 코칭 공유용 텍스트로 복사한다
  async function copyResult() {
    if (!result) return
    const s = result.score
    const lines = [
      `[Auto QA] 총점 ${s.total}/100 (${s.grade}등급) — 규칙 ${s.ruleScore}/${MAX_RULE_SCORE} · LLM ${s.llmScore}/60 · 감점 -${s.deduction}`,
      `필수 멘트: ${result.mentions.map((m) => `${m.label} ${m.found ? 'O' : 'X'}`).join(', ')}`,
      ...(result.findings.length ? [`금지 표현: ${result.findings.map((f) => `"${f.word}"(-${f.deduct})`).join(', ')}`] : []),
      ...(result.coaching ? [`코칭: ${result.coaching}`] : []),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setCopyError('')
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopyError('복사 실패 — 점수표를 직접 선택해 복사해주세요.')
    }
  }

  async function evaluate(e) {
    e.preventDefault()
    if (!text.trim()) {
      setError('통화 전사 텍스트를 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const custom = customPayload()
      const data = await postJson('/api/cc/qa', {
        transcript: text,
        ...(custom.length ? { custom_mentions: custom } : {}),
      })
      setResult(data)
      requestAnimationFrame(() => revealElement(resultRef.current))
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
          <CharCount value={text} max={MAX_TRANSCRIPT_CHARS} />
          <div className="batch-meta">
            <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[9].transcript)}>
              샘플: 응대 미흡 사례
            </button>
            <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[0].transcript)}>
              샘플: 모범 응대
            </button>
          </div>
          <details className="custom-docs qa-custom">
            <summary>+ 체크리스트 커스터마이즈 — 우리 콜센터만의 필수 멘트 추가 (최대 {MAX_CUSTOM_MENTIONS}개)</summary>
            <p className="result-empty-sub">
              콜센터마다 QA 기준이 다릅니다. 항목 이름과 감지 키워드(쉼표 구분)를 넣으면 규칙 40점이
              내장 5개 + 커스텀 항목에 균등 재배분되어 함께 평가됩니다.
            </p>
            {customRules.map((r, i) => (
              <div className="qa-custom-row" key={i}>
                <input
                  type="text"
                  placeholder={`항목 이름 (예: 청약철회 안내)`}
                  value={r.label}
                  maxLength={30}
                  onChange={(e) => setCustomRule(i, 'label', e.target.value)}
                />
                <input
                  type="text"
                  placeholder="감지 키워드, 쉼표 구분 (예: 청약철회, 14일 이내)"
                  value={r.keywords}
                  onChange={(e) => setCustomRule(i, 'keywords', e.target.value)}
                />
              </div>
            ))}
          </details>
          <button type="submit" className="btn-primary" disabled={loading} aria-busy={loading}>
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
                <OssLlmNote model={result.llm_model} />
                {/* 라벨이 없을 때만 경고를 띄우면, 라벨이 있어 상담사 발화만 채점된
                    정상 경로에서는 그 사실이 화면에 남지 않는다 — 통과도 표시한다. */}
                {result.speaker_labeled === true && (
                  <VerifyBadge title="전사에서 상담사:/고객: 화자 라벨을 확인했습니다. 규칙 스캔과 감점은 상담사 발화에만 적용됩니다.">
                    화자 라벨 확인 · 상담사 발화만 채점
                  </VerifyBadge>
                )}
              </div>

              {result.speaker_labeled === false && (
                <ResultNotice text="이 전사에는 화자 라벨(상담사:/고객:)이 없어 고객 발화까지 함께 평가되었습니다. /stt의 화자 분리를 먼저 적용하면 상담사 발화만 채점됩니다." />
              )}
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
                    <span className="stat-label">
                      LLM 정성 평가{score.llmEstimated ? ' (추정)' : result.llm_adjusted ? ' (일관성 보정)' : ''}
                    </span>
                    <span className="stat-value">{score.llmScore}/60</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">금지 표현 감점</span>
                    <span className="stat-value">-{score.deduction}</span>
                  </div>
                </div>
              </div>

              <div className="copy-row">
                <button type="button" className="btn-ghost qa-copy" onClick={copyResult}>
                  {copied ? '✓ 복사됨' : '점수표 복사 (코칭 공유용)'}
                </button>
                {copyError && (
                  <span className="copy-error" role="alert">
                    {copyError}
                  </span>
                )}
              </div>

              <section className="analysis-block">
                <h2>필수 안내 멘트 체크리스트 (규칙 기반)</h2>
                <ul className="qa-checklist">
                  {result.mentions.map((m) => (
                    <li key={m.id} className={m.found ? 'ok' : 'miss'}>
                      <span className="qa-check-mark">{m.found ? '✓' : '✗'}</span>
                      <span>
                        {m.custom && <span className="chip mine-chip">커스텀</span>}
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
