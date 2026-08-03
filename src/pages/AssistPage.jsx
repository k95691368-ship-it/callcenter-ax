import { useEffect, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import { maskPii, maskNotice } from '../lib/piiMask.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import CharCount from '../components/CharCount.jsx'
import { revealElement } from '../components/motion.js'

// 서버가 조용히 잘라내는 상한 (functions/api/cc/assist.js의 MAX_CHARS)
const MAX_DIALOGUE_CHARS = 4000

const GEN_STEPS = [
  '진행 중인 대화의 맥락을 읽고 있어요',
  '마지막 고객 발화로 관련 규정을 검색하고 있어요 (RAG)',
  '다음 응대 멘트를 작성하고 있어요',
  '에스컬레이션 필요 여부를 점검하고 있어요',
]

// 가상 시나리오 — 위약금 항의가 격해지는 중, 상담사가 다음 말을 골라야 하는 순간
const SAMPLE_DIALOGUE = `상담사: 안녕하세요, 한빛텔레콤 상담사입니다. 무엇을 도와드릴까요?
고객: 이사 때문에 인터넷을 해지하려는데 위약금이 12만 원이나 나온다는 게 말이 됩니까?
상담사: 불편을 드려 죄송합니다. 약정 기간이 남아 있으면 위약금이 발생할 수 있습니다.
고객: 아니 이사 가는 게 내 잘못이에요? 이거 해결 안 해주면 소비자원에 신고할 겁니다.`

export default function AssistPage() {
  const [dialogue, setDialogue] = useState(SAMPLE_DIALOGUE)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  // 이번 요청에서 가린 개인정보 (없으면 표시하지 않는다)
  const [masked, setMasked] = useState(null)
  const [copiedIdx, setCopiedIdx] = useState(-1)
  // 복사 실패를 좌측 폼의 setError로 보내면 화면 반대편에 떠서, 어느 멘트의 복사가
  // 실패했는지조차 알 수 없다. 실패한 제안 옆에 붙도록 인덱스로 들고 있는다.
  const [copyFailIdx, setCopyFailIdx] = useState(-1)
  const copyTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])
  const resultRef = useRef(null)

  async function suggest(e) {
    e.preventDefault()
    if (!dialogue.trim()) {
      setError('진행 중인 대화를 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      // 상담사가 붙여넣는 진행 중 대화에도 본인확인 발화가 들어간다 — 가린 뒤 보낸다
      const safe = maskPii(dialogue)
      setMasked(safe)
      const data = await postJson('/api/cc/assist', { dialogue: safe.text })
      setResult(data)
      requestAnimationFrame(() => revealElement(resultRef.current))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function copySuggestion(text, i) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(i)
      setCopyFailIdx(-1)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopiedIdx(-1), 1500)
    } catch {
      setCopyFailIdx(i)
    }
  }

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">신규 기능 제안 · 실시간 상담 지원 (Agent Assist)</span>
        <h1>통화 중, 다음 한마디를 제안합니다</h1>
        <p>
          <strong>"콜센터 AI 서비스 신규 기능 연구·개발"</strong> 관점에서 직접 제안한
          기능입니다. 진행 중인 대화를 읽고 — 마지막 고객 발화로 <strong>규정을 RAG 검색</strong>
          하고, 근거에 기반한 <strong>다음 응대 멘트 2안</strong>과{' '}
          <strong>에스컬레이션 주의</strong>를 실시간으로 제안합니다. STT·NLP·RAG·LLM 네 기술이
          한 화면에서 결합되는 지점입니다.
        </p>
      </header>

      <div className="tool-layout">
        <form className="tool-form" onSubmit={suggest}>
          <label>
            진행 중인 상담 대화 — 상담사:/고객: 형식
            <textarea value={dialogue} onChange={(e) => setDialogue(e.target.value)} rows={11} />
          </label>
          <CharCount value={dialogue} max={MAX_DIALOGUE_CHARS} />
          <div className="batch-meta">
            <button type="button" className="preset-chip" onClick={() => setDialogue(SAMPLE_DIALOGUE)}>
              샘플: 위약금 항의 격화 중
            </button>
          </div>
          <button type="submit" className="btn-primary" disabled={loading} aria-busy={loading}>
            {loading ? '제안 생성 중... (5~20초)' : '다음 응대 제안받기'}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>

        <div className="tool-result" ref={resultRef}>
          {!result && !loading && (
            <div className="result-empty">
              <p>샘플로 "위약금 항의가 격해지는 중"인 대화가 채워져 있어요.</p>
              <p className="result-empty-sub">
                AI가 이전 설치 규정을 찾아 제안하는지, 소비자원 언급에 에스컬레이션 주의를 띄우는지
                확인해보세요.
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

              {result.caution && (
                <div className="highlight-box escalate-box">
                  <strong>⚠ 주의</strong>
                  <p>{result.caution}</p>
                </div>
              )}

              <section className="analysis-block">
                <h2>다음 응대 제안</h2>
                <ul className="plain-list assist-suggestions">
                  {(result.suggestions || []).map((s, i) => (
                    <li key={i} className="assist-suggestion">
                      <p>"{s}"</p>
                      <div className="copy-row">
                        <button type="button" className="preset-chip" onClick={() => copySuggestion(s, i)}>
                          {copiedIdx === i ? '✓ 복사됨' : '멘트 복사'}
                        </button>
                        {copyFailIdx === i && (
                          <span className="copy-error" role="alert">
                            복사 실패 — 위 멘트를 직접 선택해 복사해주세요.
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="analysis-block">
                <h2>근거 규정 (RAG 검색 상위 {result.docs?.length ?? 0}건)</h2>
                {(result.docs || []).map((d) => (
                  <div key={d.id} className={`highlight-box${result.cited_ids?.includes(d.id) ? ' rag-answer' : ''}`}>
                    <strong>
                      [{d.id}] {d.title}
                      {result.cited_ids?.includes(d.id) ? ' · 인용됨' : ''}
                    </strong>
                    <p>{d.body}</p>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
