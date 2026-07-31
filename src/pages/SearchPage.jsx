import { useMemo, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import { maskPii } from '../lib/piiMask.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import CharCount, { LimitNote } from '../components/CharCount.jsx'
import { revealElement } from '../components/motion.js'

// 서버가 조용히 잘라내는 상한 (functions/api/cc/search.js) — 질문 300자,
// 내 문서는 최대 5건이며 문서당 앞 800자만 코퍼스에 들어간다
const MAX_QUESTION_CHARS = 300
const MAX_CUSTOM_DOCS = 5
const MAX_CUSTOM_DOC_CHARS = 800

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
  const customRaw = useMemo(
    () =>
      customText
        .split(/\n\s*\n/)
        .map((d) => d.trim())
        .filter(Boolean),
    [customText]
  )
  const customDocs = useMemo(() => customRaw.slice(0, MAX_CUSTOM_DOCS), [customRaw])
  // 서버는 5건을 넘는 문서와 문서당 800자 뒤쪽을 조용히 버린다 — 보내기 전에 알린다
  const droppedDocs = Math.max(0, customRaw.length - MAX_CUSTOM_DOCS)
  const longDocs = customDocs.filter((d) => d.length > MAX_CUSTOM_DOC_CHARS).length
  const docsWarning = [
    droppedDocs > 0 ? `상한 초과 — 앞 ${MAX_CUSTOM_DOCS}건만 검색에 포함됩니다.` : '',
    longDocs > 0
      ? `상한을 넘는 문서가 있어 각 문서의 앞 ${MAX_CUSTOM_DOC_CHARS.toLocaleString('ko-KR')}자만 색인됩니다.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')

  async function search(e) {
    e.preventDefault()
    if (!question.trim()) {
      setError('질문을 입력해주세요.')
      return
    }
    setLoading(true)
    setError('')
    try {
      // 질문과 '내 문서' 모두 사용자가 입력한 원문이다 — 서버로 나가기 전에 가린다.
      //
      // customDocs는 **문자열 배열**이다(빈 줄로 자른 조각). 객체로 스프레드하면
      // 글자 단위로 펼쳐진 {0:'사',1:'내',…}가 되고 body는 undefined가 된다.
      // 서버(buildCustomDocs)는 String(d)로 받으므로 그 객체는 "[object Object]"가 되어,
      // 내 문서 검색이 통째로 무효가 된다. 문자열로 두고 그대로 가린다.
      const safeDocs = customDocs.map((d) => maskPii(d).text)
      const data = await postJson('/api/cc/search', {
        question: maskPii(question).text,
        ...(safeDocs.length ? { custom_docs: safeDocs } : {}),
      })
      setResult(data)
      requestAnimationFrame(() => revealElement(resultRef.current))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // 순위를 정한 값으로 막대를 그린다 — 하이브리드 모드는 RRF, 키워드 폴백은 가중치.
  const rankValue = (r) => (r.rrf != null ? r.rrf : r.score || 0)
  const maxRank = result ? Math.max(...result.results.map(rankValue), 0.001) : 1

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
          <CharCount value={question} max={MAX_QUESTION_CHARS} />
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
              placeholder={`회사 규정·FAQ를 붙여넣으세요. 빈 줄로 문서를 구분합니다 (최대 ${MAX_CUSTOM_DOCS}건).\n\n예) 프리미엄 요금제는 가입 후 14일 이내 무료 해지가 가능하다. 이후에는...`}
              aria-label="내 문서"
            />
            <LimitNote warning={docsWarning}>
              문서 {customRaw.length}건 인식 · 최대 {MAX_CUSTOM_DOCS}건, 문서당{' '}
              {MAX_CUSTOM_DOC_CHARS.toLocaleString('ko-KR')}자
            </LimitNote>
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
          <button type="submit" className="btn-primary" disabled={loading} aria-busy={loading}>
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
                <h2>
                  근거 문서 (상위 {result.results.length}건 ·{' '}
                  {result.results.some((r) => r.rrf != null) ? 'RRF 융합 순위' : '키워드 순위'})
                </h2>
                <div className="rank-bars">
                  {/* 정렬은 RRF로 하는데 막대를 코사인 점수로 그리면 1위 문서가 2위보다
                      짧은 막대를 갖는 화면이 나온다. 순위를 정한 값으로 막대도 그린다. */}
                  {result.results.map((r) => (
                    <div className="rank-row" key={r.id}>
                      <span className="rank-label">
                        {result.cited_ids?.includes(r.id) ? '📎 ' : ''}
                        {r.mine && <span className="chip mine-chip">내 문서</span>}[{r.id}] {r.title}
                      </span>
                      <span className="rank-track">
                        <span
                          className="rank-fill"
                          style={{ width: `${Math.max(6, (rankValue(r) / maxRank) * 100)}%` }}
                        />
                      </span>
                      <span
                        className="rank-value"
                        title={r.rrf != null ? 'RRF 융합 점수 (정렬 기준)' : '키워드 랭킹 가중치'}
                      >
                        {r.rrf != null ? rankValue(r).toFixed(4) : rankValue(r).toFixed(1)}
                      </span>
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
