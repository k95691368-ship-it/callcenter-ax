import { useEffect, useMemo, useRef, useState } from 'react'
import { postJson } from '../lib/api.js'
import { guideCall } from '../lib/scriptGuide.js'
import { usePersistentState } from '../lib/persist.js'

// 통화 중 실시간 스크립트 가이드.
//
// 다른 화면은 전부 통화가 끝난 뒤를 다룬다. Auto QA는 "녹취 고지를 빠뜨렸다"고
// 알려주지만 그때는 이미 늦었다. 같은 규칙을 진행 중인 대화에 걸면 빠뜨리기 전에
// 알릴 수 있고, 상담사가 실제로 도움을 받는 건 이쪽이다.
//
// 이 화면은 LLM을 호출하지 않는다. 통화 중에 쓰려면 응답이 즉시여야 하고,
// "녹취 고지를 했는가"는 규칙으로 답할 수 있는 질문이다. 그래서 판정을 브라우저에서
// 바로 하고(타이핑 중 즉시 반영), 서버 경로가 살아 있는지는 버튼으로 따로 확인한다.

const SCENARIOS = [
  {
    label: '해지 방어 (강성)',
    text: '상담사: 안녕하세요 한빛텔레콤입니다\n고객: 인터넷이 또 끊겨요 이번이 세 번째인데 해지하겠습니다 위약금 면제 안 해주면 소비자원에 신고할 거예요',
  },
  {
    label: '요금 이의 (일반)',
    text: '상담사: 안녕하세요 한빛텔레콤 상담사 김하늘입니다 상담 품질 향상을 위해 통화 내용이 녹음됩니다\n고객: 이번 달 요금이 왜 12만 원이나 나왔는지 확인 부탁드려요',
  },
  {
    label: '반말 응대 (위반)',
    text: '고객: 지난주에 신청했는데 아직도 안 왔어요\n상담사: 그건 고객님이 잘못 보신 거예요 어쩔 수 없습니다',
  },
]

const LEVEL_LABEL = { high: '즉시', warn: '주의' }

export default function GuidePage() {
  // 진행 중 대화는 브라우저에만 남긴다 (서버 미저장 원칙 그대로)
  const [dialogue, setDialogue] = usePersistentState('cc-guide-draft', SCENARIOS[0].text)
  const [serverCheck, setServerCheck] = useState(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const liveRef = useRef(null)

  // 타이핑마다 다시 판정한다 — 규칙 계산이라 비용이 없다
  const guide = useMemo(() => guideCall(dialogue), [dialogue])

  // 다음에 할 일이 바뀌면 스크린리더에도 알린다
  useEffect(() => {
    if (liveRef.current) liveRef.current.textContent = guide.nextActions[0]?.label ?? '필수 멘트 모두 이행'
  }, [guide])

  async function verifyOnServer() {
    setChecking(true)
    setError('')
    try {
      const d = await postJson('/api/cc/guide', { dialogue })
      setServerCheck(d)
    } catch (err) {
      setError(err.message)
    } finally {
      setChecking(false)
    }
  }

  const copyScript = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      setError('클립보드 복사에 실패했습니다.')
    }
  }

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">신규 기능 연구·개발 · 통화 중 지원</span>
        <h1>통화 중 스크립트 가이드</h1>
        <p>
          진행 중인 대화를 읽고 <strong>지금 어느 단계인지</strong>, <strong>아직 빠뜨린 필수 멘트가
          무엇인지</strong>, <strong>고객 발화에 어떤 위험 신호가 있는지</strong>를 즉시 알려줍니다.
          사후 평가(Auto QA)를 사전 예방으로 옮긴 화면입니다.{' '}
          <strong>AI 호출이 없습니다</strong> — 통화 중에 쓰려면 응답이 즉시여야 하고, "녹취
          고지를 했는가"는 규칙으로 답할 수 있는 질문이기 때문입니다. 타이핑하는 즉시 반영됩니다.
        </p>
      </header>

      <div className="tool-layout">
        <form className="tool-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            진행 중인 대화 (상담사: / 고객: 로 구분)
            <textarea
              value={dialogue}
              onChange={(e) => setDialogue(e.target.value)}
              rows={12}
              aria-label="진행 중인 대화"
            />
          </label>
          <div className="batch-meta search-samples">
            {SCENARIOS.map((s) => (
              <button key={s.label} type="button" className="preset-chip" onClick={() => setDialogue(s.text)}>
                {s.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost" onClick={verifyOnServer} disabled={checking} aria-busy={checking}>
            {checking ? '서버 확인 중...' : '같은 판정을 서버에서도 확인 (/api/cc/guide)'}
          </button>
          {serverCheck && (
            <p className="result-empty-sub">
              서버 응답: engine={serverCheck.engine} · 단계 {serverCheck.stage?.label} · 이행{' '}
              {serverCheck.progress?.done}/{serverCheck.progress?.total} · 경보{' '}
              {serverCheck.alerts?.length ?? 0}건 — 브라우저 판정과 같은 규칙 모듈을 씁니다.
            </p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </form>

        <div className="tool-result">
          <div className="result-toolbar">
            <span className="cat-badge cat-ship">현재 단계: {guide.stage.label}</span>
            <span className="usage-note">
              필수 멘트 {guide.progress.done}/{guide.progress.total} ({guide.progress.ratio}%)
            </span>
          </div>
          <div className="guide-progress" role="img" aria-label={`필수 멘트 이행률 ${guide.progress.ratio}%`}>
            <span className="guide-progress-fill" style={{ width: `${guide.progress.ratio}%` }} />
          </div>
          <p className="sr-only" aria-live="polite" ref={liveRef} />

          <section className="analysis-block">
            <h2>지금 해야 할 것</h2>
            {guide.nextActions.length === 0 ? (
              <p className="result-empty-sub">필수 멘트를 모두 이행했습니다. 마무리 확인만 남았습니다.</p>
            ) : (
              <ul className="plain-list guide-actions">
                {guide.nextActions.map((a) => (
                  <li key={a.id} className={a.urgent ? 'guide-urgent' : ''}>
                    <strong>
                      {a.urgent && <span className="guide-now">지금</span>} [{a.stageLabel}] {a.label}
                    </strong>
                    <span className="guide-script">"{a.script}"</span>
                    <button type="button" className="preset-chip" onClick={() => copyScript(a.script)}>
                      멘트 복사
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="analysis-block">
            <h2>경보 {guide.alerts.length > 0 && `(${guide.alerts.length})`}</h2>
            {guide.alerts.length === 0 ? (
              <p className="result-empty-sub">금지 표현과 고객 위험 신호가 발견되지 않았습니다.</p>
            ) : (
              <ul className="plain-list guide-alerts">
                {guide.alerts.map((a, i) => (
                  <li key={`${a.kind}-${a.label}-${i}`} className={`guide-alert-${a.level}`}>
                    <strong>
                      <span className="guide-level">{LEVEL_LABEL[a.level] || a.level}</span> {a.label}
                    </strong>
                    <span className="guide-detail">{a.detail}</span>
                    {a.evidence && <span className="churn-quote">"{a.evidence}"</span>}
                    {a.script && (
                      <>
                        <span className="guide-script">"{a.script}"</span>
                        <button type="button" className="preset-chip" onClick={() => copyScript(a.script)}>
                          멘트 복사
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="result-empty-sub">
            판정 규칙은 Auto QA(<code>/qa</code>)와 같은 모듈을 공유합니다 — 통화 중 안내와 사후
            평가의 기준이 어긋나지 않습니다. 입력한 대화는 이 브라우저에만 남습니다.
          </p>
        </div>
      </div>
    </div>
  )
}
