import { useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'

const GEN_STEPS = [
  '질문과 지식 문서를 임베딩 벡터로 변환하고 있어요',
  '코사인 유사도로 근거 문서를 찾고 있어요',
  '근거 문단만 사용해 답변을 작성하고 있어요',
]

const SAMPLE_QUESTIONS = [
  '이사 가는 고객이 해지하면 위약금을 꼭 내야 하나요?',
  '고객이 해외 안 갔는데 로밍 요금이 나왔다고 합니다. 어떻게 처리하죠?',
  '가족 회선을 결합에 추가하려면 뭐가 필요한가요?',
  '미성년자가 결제한 소액결제 환불이 되나요?',
]

// 내 문서를 브라우저에만 보관해 새로고침·재방문에도 유지한다 (서버 미저장 원칙 그대로)
const CUSTOM_DOCS_KEY = 'cc-custom-docs'
function loadCustomText() {
  try {
    return localStorage.getItem(CUSTOM_DOCS_KEY) || ''
  } catch {
    return ''
  }
}

export default function SearchPage() {
  const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0])
  const [customText, setCustomTextRaw] = useState(loadCustomText)
  function setCustomText(v) {
    setCustomTextRaw(v)
    try {
      if (v.trim()) localStorage.setItem(CUSTOM_DOCS_KEY, v)
      else localStorage.removeItem(CUSTOM_DOCS_KEY)
    } catch {
      // 시크릿 모드 등 저장 불가 환경에서도 검색 흐름은 유지
    }
  }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const resultRef = useRef(null)

  // 빈 줄로 구분해 문서 여러 건을 붙여넣을 수 있다 (최대 5건)
  const customDocs = customText
    .split(/\n\s*\n/)
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, 5)

  async function search(e) {
    e.preventDefault()
    if (!question.trim()) {
      setError('질문을 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await postJson('/api/cc/search', {
        question,
        ...(customDocs.length ? { custom_docs: customDocs } : {}),
      })
      setResult(data)
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const maxScore = result ? Math.max(...result.results.map((r) => r.score), 0.001) : 1

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ④ RAG · 검색 증강 생성</span>
        <h1>RAG 상담 지식 검색</h1>
        <p>
          상담사가 통화 중 규정을 물으면, <strong>bge-m3 벡터 유사도</strong>와{' '}
          <strong>키워드 랭킹</strong>을 RRF(Reciprocal Rank Fusion)로 융합한{' '}
          <strong>하이브리드 검색</strong>으로 지식 문서를 찾고, LLM이{' '}
          <strong>검색된 근거 문단만 사용해</strong> 답합니다. 문서에 없으면 "없다"고 답하는 것이
          원칙입니다 — 환각을 구조로 막는 RAG 설계입니다.
        </p>
      </header>

      <div className="tool-layout">
        <form className="tool-form" onSubmit={search}>
          <label>
            상담사 질문
            <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} />
          </label>
          <div className="batch-meta search-samples">
            {SAMPLE_QUESTIONS.map((q) => (
              <button key={q} type="button" className="preset-chip" onClick={() => setQuestion(q)}>
                {q.length > 24 ? q.slice(0, 24) + '…' : q}
              </button>
            ))}
          </div>
          <details className="custom-docs">
            <summary>
              ＋ 내 문서 추가해서 검색 (선택){customDocs.length > 0 && ` — ${customDocs.length}건 인식됨`}
            </summary>
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={6}
              placeholder={'회사 규정·FAQ를 붙여넣으세요. 빈 줄로 문서를 구분합니다 (최대 5건).\n\n예) 프리미엄 요금제는 가입 후 14일 이내 무료 해지가 가능하다. 이후에는...'}
              aria-label="내 문서"
            />
            <p className="result-empty-sub">
              붙여넣은 문서는 질문과 함께 실시간 임베딩되어 내장 규정 8건과 같은 코퍼스에서
              검색됩니다 — 서버에 저장되지 않고, 이 브라우저에만 보관되어 다음 방문에도
              유지됩니다.
              {customText.trim() && (
                <>
                  {' '}
                  <button type="button" className="preset-chip" onClick={() => setCustomText('')}>
                    내 문서 비우기
                  </button>
                </>
              )}
            </p>
          </details>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? '검색 중... (5~20초)' : '지식 검색하기'}
          </button>
          {error && <p className="form-error" role="alert">{error}</p>}
          <p className="result-empty-sub">
            기본 지식 문서는 가상 통신사 "한빛텔레콤"의 상담 규정 8건입니다 (자작 데이터).
          </p>
        </form>

        <div className="tool-result" ref={resultRef}>
          {!result && !loading && (
            <div className="result-empty">
              <p>질문을 검색하면 근거 문서와 함께 답변이 표시됩니다.</p>
              <p className="result-empty-sub">
                어떤 문서를 근거로 답했는지(인용 id)까지 투명하게 보여줍니다.
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
                <OssLlmNote model={result.llm_model} />
                <span className="usage-note">
                  검색:{' '}
                  {result.mode === 'hybrid'
                    ? `하이브리드 — ${result.embed_model} 벡터 + 키워드 RRF 융합${
                        result.vector_backend === 'vectorize'
                          ? ' · Vectorize 사전 인덱스'
                          : result.vector_backend === 'realtime'
                            ? ' · 실시간 임베딩'
                            : ''
                      }`
                    : result.mode === 'vector'
                      ? `${result.embed_model} 임베딩 · 코사인 유사도`
                      : '키워드 랭킹 (임베딩 폴백)'}
                </span>
              </div>

              <div className="highlight-box rag-answer">
                <strong>
                  답변
                  {typeof result.grounding === 'number' && (
                    <span
                      className="chip mine-chip"
                      style={{ marginLeft: 8 }}
                      title="답변의 문자 2-gram이 검색된 근거 문서에서 발견되는 비율 — 지시가 아니라 검증으로 확인한 수치입니다."
                    >
                      근거율 {Math.round(result.grounding * 100)}%
                    </span>
                  )}
                </strong>
                <p>{result.answer}</p>
                {result.cited_ids?.length > 0 && (
                  <p className="result-empty-sub">
                    인용 문서: {result.cited_ids.map((id) => `[${id}]`).join(' ')}
                  </p>
                )}
              </div>

              <section className="analysis-block">
                <h2>근거 문서 (유사도 상위 {result.results.length}건)</h2>
                <div className="rank-bars">
                  {result.results.map((r) => (
                    <div className="rank-row" key={r.id}>
                      <span className="rank-label">
                        {result.cited_ids?.includes(r.id) ? '📎 ' : ''}
                        {r.mine && <span className="chip mine-chip">내 문서</span>}[{r.id}] {r.title}
                      </span>
                      <span className="rank-track">
                        <span
                          className="rank-fill"
                          style={{ width: `${Math.max(6, (r.score / maxScore) * 100)}%` }}
                        />
                      </span>
                      <span className="rank-value">{r.score.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
                {result.results.map((r) => (
                  <details className="faq-doc" key={r.id}>
                    <summary>
                      [{r.id}] {r.title}
                    </summary>
                    <p>{r.body}</p>
                  </details>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
