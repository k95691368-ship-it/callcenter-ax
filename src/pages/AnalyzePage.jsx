import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import CharCount, { LimitNote } from '../components/CharCount.jsx'
import { revealElement } from '../components/motion.js'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'
import { saveMyCall } from '../lib/myCalls.js'
import AnalysisLayers from '../components/AnalysisLayers.jsx'
import { maskPii, maskNotice } from '../lib/piiMask.js'
import { splitCalls, MAX_BATCH_CALLS, MAX_CALL_CHARS } from '../lib/batchSplit.js'

// 서버가 조용히 잘라내는 상한 (functions/api/cc/analyze.js의 MAX_CHARS)
const MAX_TRANSCRIPT_CHARS = 8000

const BATCH_SAMPLE = [SAMPLE_CALLS[0], SAMPLE_CALLS[2], SAMPLE_CALLS[7]]
  .map((c) => c.transcript)
  .join('\n\n')

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

  const [copied, setCopied] = useState(false)
  // 복사 실패를 좌측 폼의 setError로 보내면 화면 반대편에 떠서 버튼을 누른 사람이
  // 알아채지 못한다. 버튼 옆에 붙는 별도 상태로 분리한다.
  const [copyError, setCopyError] = useState('')
  // 이번 요청에서 무엇을 가렸는지 (가린 게 없으면 아무것도 표시하지 않는다)
  const [masked, setMasked] = useState(null)
  const copyTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  // 분석 결과를 실무 인수인계 형식 텍스트로 복사한다
  async function copyResult() {
    if (!result) return
    const lines = [
      `[통화 분석] 유형: ${result.category} / 감정: ${result.sentiment}${result.escalate ? ' / ⚠ 에스컬레이션 필요' : ''}`,
      ...(result.summary || []).map((s, i) => `${i + 1}. ${s}`),
      `조치: ${(result.actions || []).join(' · ')}`,
      ...(result.escalate && result.escalate_reason ? [`에스컬레이션 사유: ${result.escalate_reason}`] : []),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
      setCopyError('')
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopyError('복사 실패 — 결과를 직접 선택해 복사해주세요.')
    }
  }

  async function analyze(e) {
    e.preventDefault()
    if (!text.trim()) {
      setError('통화 전사 텍스트를 입력해주세요.')
      return
    }
    // 단건과 일괄이 동시에 나가면 유료 LLM 호출 두 건이 병렬로 떠나고, 어느 쪽이
    // 실패했는지 알 수 없는 상태가 된다. 한 번에 하나만 진행시킨다.
    if (loading || batchLoading) return
    setLoading(true)
    setError('')
    try {
      // 붙여넣기 경로에서도 개인정보를 가린 뒤 보낸다.
      // 녹취 화면에서 넘어온 텍스트는 이미 가려져 있지만, 여기에 직접 붙여넣는 사람도 있다 —
      // 마스킹이 한쪽 경로에만 있으면 없는 것과 크게 다르지 않다.
      const safe = maskPii(text)
      setMasked(safe)
      const data = await postJson('/api/cc/analyze', { transcript: safe.text })
      setResult(data)
      // 분석 결과를 브라우저에 누적 → VOC 대시보드에 합산 (서버 저장 없음)
      // churn·route까지 남겨야 VOC 대장의 '이탈위험·위험등급·담당' 열이 채워진다.
      // 지금까지 4개 필드만 저장해서, 서버가 계산한 위험도가 저장 단계에서 사라지고
      // 대장에서는 그 열이 항상 빈칸이었다 — 값이 없는 게 아니라 버려지고 있었다.
      saveMyCall({
        // 제목도 가려진 텍스트에서 뽑는다 — 원문에서 뽑으면 첫 줄에 있던 주민번호가
        // 그대로 브라우저 원장에 저장되고 VOC 리포트 경로로 다시 서버에 나간다.
        // 화면이 "가린 텍스트로만 저장된다"고 약속한 바로 그 요청에서 생기던 구멍이다.
        title: safe.text.replace(/^(상담사|고객)\s*[:：]\s*/, '').split('\n')[0],
        category: data.category,
        sentiment: data.sentiment,
        escalate: data.escalate,
        churn: data.churn,
        route: data.ticket?.route,
      })
      requestAnimationFrame(() => revealElement(resultRef.current))
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

  // 일괄 분석 — 여러 통화를 LLM 호출 1회로 함께 구조화 (단건 처리 한계 돌파)
  const [batchText, setBatchText] = useState(BATCH_SAMPLE)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchResult, setBatchResult] = useState(null)
  const [batchSaved, setBatchSaved] = useState(false)
  // 일괄 분석 에러를 단건과 같은 error 상태에 담으면 서로를 덮어써, 좌측 폼에 뜬 메시지가
  // 어느 요청의 것인지 알 수 없었다. 섹션별로 분리해 각자 옆에 표시한다.
  const [batchError, setBatchError] = useState('')

  // 버튼 라벨에서 매 렌더 호출하면 무관한 리렌더에도 정규식 분할이 반복 실행된다.
  const batchParts = useMemo(() => splitCalls(batchText), [batchText])
  // splitCalls는 이미 5건·2000자로 잘라낸 결과다. 무엇이 잘려 나갔는지 알리려면
  // 자르기 전의 원본 분할이 필요하다.
  const batchRaw = useMemo(
    () =>
      batchText
        .split(/\n\s*\n/)
        .map((t) => t.trim())
        .filter(Boolean),
    [batchText]
  )
  const droppedCalls = Math.max(0, batchRaw.length - MAX_BATCH_CALLS)
  const longCalls = batchRaw.slice(0, MAX_BATCH_CALLS).filter((t) => t.length > MAX_CALL_CHARS).length
  const batchWarning = [
    droppedCalls > 0 ? `상한 초과 — 앞 ${MAX_BATCH_CALLS}건만 전송되고 나머지는 제외됩니다.` : '',
    longCalls > 0
      ? `상한을 넘는 통화가 있어 각 통화의 앞 ${MAX_CALL_CHARS.toLocaleString('ko-KR')}자만 분석됩니다.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')

  async function analyzeBatch() {
    const parts = batchParts
    if (parts.length < 2) {
      setBatchError('일괄 분석은 통화 2건 이상부터 가능합니다. 통화 사이를 빈 줄로 구분해주세요.')
      return
    }
    if (loading || batchLoading) return
    setBatchLoading(true)
    setBatchError('')
    setBatchSaved(false)
    try {
      // 일괄 경로도 같다 — 건별로 가린 뒤 보낸다
      const safeParts = parts.map((p) => maskPii(p).text)
      const data = await postJson('/api/cc/analyze-batch', { transcripts: safeParts })
      // inputs에 원문을 담아 두면 VOC 저장 제목이 원문에서 뽑혀 마스킹이 무의미해진다
      setBatchResult({ ...data, inputs: safeParts })
    } catch (err) {
      setBatchError(err.message)
    } finally {
      setBatchLoading(false)
    }
  }

  function saveBatchToVoc() {
    if (!batchResult) return
    batchResult.calls.forEach((c, i) => {
      // 일괄 분석도 건별로 churn·route를 계산해 보낸다(withTriage) — 함께 저장한다
      saveMyCall({
        title: (batchResult.inputs[i] || '').replace(/^(상담사|고객)\s*[:：]\s*/, '').split('\n')[0],
        category: c.category,
        sentiment: c.sentiment,
        escalate: c.escalate,
        churn: c.churn,
        route: c.route,
      })
    })
    setBatchSaved(true)
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
          <CharCount value={text} max={MAX_TRANSCRIPT_CHARS} />
          <div className="batch-meta">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="preset-chip" onClick={() => setText(p.call.transcript)}>
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={loading || batchLoading}
            aria-busy={loading}
          >
            {loading ? '분석 중... (10~30초)' : batchLoading ? '일괄 분석이 끝나면 가능합니다' : '통화 분석하기'}
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
              {masked?.total > 0 && <ResultNotice text={`🔒 ${maskNotice(masked)}`} />}
              <div className="result-toolbar">
                {result.demo && <DemoBadge />}
                <UsageNote usage={result.usage} />
                <OssLlmNote model={result.llm_model} />
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
                <h2>
                  3줄 요약
                  {typeof result.grounding === 'number' && (
                    <span
                      className="chip mine-chip"
                      style={{ marginLeft: 8 }}
                      title="요약 표현이 통화 원문과 겹치는 비율 — 지시가 아니라 검증으로 확인한 수치입니다."
                    >
                      원문 근거율 {Math.round(result.grounding * 100)}%
                    </span>
                  )}
                </h2>
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

              {/* 서버는 LLM 응답 위에 규칙 계층(이탈 위험·대화 지표·티켓 초안)을 얹어 항상 함께
                  보낸다. 이 화면은 그 값을 받아 놓고 쓰지 않아, 통화 분석 전용 화면인데도
                  파이프라인 화면보다 적게 보여주고 있었다. */}
              <AnalysisLayers analysis={result} onError={setCopyError} />

              <div className="hub-cta result-actions">
                <button type="button" className="btn-ghost" onClick={copyResult}>
                  {copied ? '✓ 복사됨' : '결과 복사 (인수인계용)'}
                </button>
                <button type="button" className="btn-ghost" onClick={sendToQa}>
                  이 통화를 Auto QA로 평가하기 →
                </button>
                {copyError && (
                  <span className="copy-error" role="alert">
                    {copyError}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <section className="about-section batch-section">
        <h2>일괄 분석 — 여러 통화를 LLM 호출 1회로</h2>
        <p className="about-note">
          상담 후처리는 건별이 아니라 묶음으로 흐릅니다. 통화 사이를 빈 줄로 구분해 최대{' '}
          {MAX_BATCH_CALLS}건까지 붙여넣으면 <strong>한 번의 호출</strong>로 전부 분류·요약됩니다
          (통화당 {MAX_CALL_CHARS.toLocaleString('ko-KR')}자까지 · 샘플 3건이 채워져 있어요).
        </p>
        <textarea
          className="batch-textarea"
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          rows={8}
          aria-label="일괄 분석할 통화들"
        />
        {/* 서버는 5건·통화당 2000자를 넘는 입력을 조용히 버린다 — 보내기 전에 알린다 */}
        <LimitNote warning={batchWarning}>
          빈 줄로 구분된 통화 {batchRaw.length}건 인식 · 최대 {MAX_BATCH_CALLS}건, 통화당{' '}
          {MAX_CALL_CHARS.toLocaleString('ko-KR')}자
        </LimitNote>
        <div className="hub-cta result-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={analyzeBatch}
            disabled={loading || batchLoading}
            aria-busy={batchLoading}
          >
            {batchLoading
              ? '일괄 분석 중... (10~30초)'
              : loading
                ? '단건 분석이 끝나면 가능합니다'
                : `일괄 분석하기 (${batchParts.length}건)`}
          </button>
          {batchResult && (
            <button type="button" className="btn-ghost" onClick={saveBatchToVoc} disabled={batchSaved}>
              {batchSaved ? '✓ VOC에 누적됨' : 'VOC 대시보드에 일괄 누적'}
            </button>
          )}
        </div>
        {batchError && (
          <p className="form-error" role="alert">
            {batchError}
          </p>
        )}
        {batchResult && (
          <>
            <ResultNotice text={batchResult.notice} />
            <div className="result-toolbar">
              {batchResult.demo && <DemoBadge />}
              <UsageNote usage={batchResult.usage} />
              <OssLlmNote model={batchResult.llm_model} />
              {!batchResult.demo && (
                <span className="usage-note">{batchResult.calls.length}건을 호출 1회로 처리</span>
              )}
            </div>
            <div className="req-table-wrap">
              <table className="req-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>유형</th>
                    <th>감정</th>
                    <th>한 줄 요약</th>
                    <th>에스컬레이션</th>
                  </tr>
                </thead>
                <tbody>
                  {batchResult.calls.map((c, i) => (
                    <tr key={i}>
                      <td className="req-name">{i + 1}</td>
                      <td>
                        <span className={`cat-badge ${CATEGORY_COLOR[c.category] || 'cat-etc'}`}>{c.category}</span>
                      </td>
                      <td>
                        <span className={`cat-badge ${SENTIMENT_COLOR[c.sentiment] || 'cat-etc'}`}>{c.sentiment}</span>
                      </td>
                      <td className="req-basis">{c.summary}</td>
                      <td>{c.escalate ? <span className="escalate-badge" title={c.escalate_reason}>⚠ 필요</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
