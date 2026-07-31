import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { OssLlmNote, UsageNote, WorkersAiNote, ResultNotice } from '../components/ResultMeta.jsx'
import AnalysisLayers from '../components/AnalysisLayers.jsx'
import { applyLexicon } from '../lib/domainLexicon.js'
import { saveMyCall } from '../lib/myCalls.js'
import { MAX_RULE_SCORE } from '../lib/qaRules.js'
import { useRecorder } from '../lib/useRecorder.js'
import { buildPipelineReport } from '../lib/pipelineReport.js'
import { buildHandoff } from '../lib/handoff.js'
import { saveQaResult } from '../lib/qaHistory.js'
// base64 변환은 audioChunk의 것을 그대로 쓴다 — 같은 코드가 두 곳에 있으면
// 한쪽만 고쳐지는 날이 온다.
import { bufferToB64 } from '../lib/audioChunk.js'
import { loadPersisted } from '../lib/persist.js'

// 공고의 담당업무 파이프라인(녹취→STT→분석→QA→VOC)을 버튼 하나로 통과시키는 시연.
// 각 단계는 실제 프로덕션 API를 그대로 호출한다 — 별도의 시연용 가짜 경로가 없다.

// 처리 상태의 심각도를 색으로 잇는다. 새 CSS를 만들지 않고 기존 배지·배너 스타일을
// 그대로 쓴다 — 같은 뜻(높음/주의/참고)이 화면마다 다른 색이면 그 색은 정보가 아니다.
const TONE_ALERT = { high: 'voc-alert-high', warn: 'voc-alert-warn', ok: '' }
const TONE_BADGE = { high: 'churn-high', warn: 'churn-mid', ok: 'churn-low' }
const CHECK_LEVEL = {
  high: { cls: 'guide-alert-high', text: '높음' },
  warn: { cls: 'guide-alert-warn', text: '주의' },
  info: { cls: '', text: '참고' },
}

const STEPS = [
  { id: 'stt', title: '① 녹취 전사', desc: 'Whisper large-v3-turbo (Workers AI)' },
  { id: 'lex', title: '② 도메인 보정', desc: '콜센터 용어 사전 후보정 (튜닝 1단계)' },
  { id: 'dia', title: '③ 화자 분리', desc: '상담사/고객 태깅 (NLP) — QA 정확도 연결' },
  { id: 'analyze', title: '④ 통화 분석', desc: '분류·요약·감정·에스컬레이션 (LLM)' },
  { id: 'qa', title: '⑤ 품질 평가', desc: '규칙 40점 + LLM 60점 Auto QA — ④와 동시 실행' },
  { id: 'voc', title: '⑥ VOC 누적', desc: '대시보드에 분석 결과 합산' },
]

export default function PipelinePage() {
  const [stage, setStage] = useState(-1) // -1 대기, 0~5 진행, 6 완료
  const [error, setError] = useState('')
  const [stt, setStt] = useState(null)
  const [lex, setLex] = useState(null)
  const [dia, setDia] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [qa, setQa] = useState(null)
  // 이번 실행의 QA 결과가 코칭 이력에 남았는지 — 처리 상태에 "어디에 기록됐는가"로 들어간다
  const [qaSaved, setQaSaved] = useState(false)
  const [copied, setCopied] = useState('')

  // 단계별 실패를 기록하되 파이프라인 전체를 멈추지는 않는다 (STT 실패만 치명적)
  const [stageErrors, setStageErrors] = useState({})

  // 6단계 결과를 처리 상태 한 덩어리로 요약한다 — 화면과 리포트가 같은 함수를 쓴다.
  // 실패한 단계는 이 안에서 상태에 반영되므로, 분석이 실패하면 담당 부서도 비어 있다.
  const handoff = buildHandoff({ stt, lex, dia, analysis, qa, stageErrors, qaSaved })

  // 6단계 결과 전체를 인수인계 문서 한 장으로 복사한다
  const copyTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(copyTimerRef.current), [])

  // 복사 대상이 두 가지(리포트 한 장 / 티켓 초안)라 어느 것이 복사됐는지 구분해 표시한다.
  // 하나의 boolean을 공유하면 티켓을 복사했는데 리포트 버튼에 "복사됨"이 뜬다.
  async function copyText(id, text) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(''), 1500)
    } catch {
      setError('클립보드 복사에 실패했습니다.')
    }
  }

  // 마이크 모드 — 녹음을 끝내면 자기 목소리로 파이프라인이 바로 실행된다
  const [micUrl, setMicUrl] = useState('')
  const micUrlRef = useRef('')
  useEffect(() => () => {
    if (micUrlRef.current) URL.revokeObjectURL(micUrlRef.current)
  }, [])
  const recorder = useRecorder({
    onDone: (file) => {
      if (micUrlRef.current) URL.revokeObjectURL(micUrlRef.current)
      const url = URL.createObjectURL(file)
      micUrlRef.current = url
      setMicUrl(url)
      run(file)
    },
    onError: setError,
  })

  async function run(micAudio) {
    setError('')
    setStt(null)
    setLex(null)
    setDia(null)
    setAnalysis(null)
    setQa(null)
    setQaSaved(false)
    setStageErrors({})
    try {
      // ① STT — 내장 샘플 또는 방금 녹음한 목소리를 실제 Whisper로 전사
      setStage(0)
      const buf =
        micAudio instanceof File
          ? await micAudio.arrayBuffer()
          : await fetch('/sample-call.wav').then((r) => r.arrayBuffer())
      const sttRes = await postJson('/api/cc/stt', { audio_b64: bufferToB64(buf) })
      setStt(sttRes)

      // ② 도메인 보정
      setStage(1)
      const corrected = applyLexicon(sttRes.text)
      setLex(corrected)

      // ③ 화자 분리 — 실패해도 보정 전사로 다음 단계를 계속한다
      setStage(2)
      let transcript = corrected.text
      try {
        const base = corrected.text.trim()
        const d = await postJson('/api/cc/diarize', { transcript: base })
        setDia(d)
        // 서버는 6000자까지만 처리한다. 잘린 뒷부분을 원문으로 이어 붙이지 않으면
        // 뒤 단계(분석·QA)가 통화의 앞부분만 보고 판단하게 된다.
        const tail = d.truncated ? base.slice(d.processed_chars) : ''
        transcript = tail ? `${d.formatted}\n${tail}` : d.formatted
      } catch (err) {
        setStageErrors((e) => ({ ...e, dia: err.message }))
      }

      // ④⑤ 분석과 QA는 같은 전사를 읽으므로 동시에 실행한다 — 대기시간 단축.
      // 한쪽이 실패해도 다른 쪽 결과는 살린다.
      setStage(3)
      // QA에는 /qa 화면에 저장해 둔 커스텀 체크리스트를 함께 보낸다. 보내지 않으면
      // 같은 통화가 화면에 따라 다른 점수를 받아, 어느 쪽이 맞는지 알 수 없게 된다.
      // 키·형태는 QaPage의 저장 방식과 같아야 한다 ('cc-qa-custom', keywords는 쉼표 문자열).
      const customMentions = (loadPersisted('cc-qa-custom', []) || [])
        .filter((m) => m?.label?.trim() && m?.keywords?.trim())
        .map((m) => ({
          label: m.label,
          keywords: m.keywords.split(',').map((k) => k.trim()).filter(Boolean),
        }))
      const qaBody = customMentions.length ? { transcript, custom_mentions: customMentions } : { transcript }
      const [aRes, qRes] = await Promise.allSettled([
        postJson('/api/cc/analyze', { transcript }),
        postJson('/api/cc/qa', qaBody),
      ])
      if (aRes.status === 'fulfilled') setAnalysis(aRes.value)
      else setStageErrors((e) => ({ ...e, analyze: aRes.reason?.message || '분석 실패' }))
      if (qRes.status === 'fulfilled') {
        setQa(qRes.value)
        // 평가 결과를 코칭 이력에도 남긴다. 예전에는 /qa 화면에서만 저장해서,
        // 파이프라인으로 돌린 통화는 "최근 N건 평균"에서 통째로 빠졌다 —
        // 같은 평가를 두 경로로 돌렸는데 한쪽만 세는 이력은 코칭 근거가 될 수 없다.
        // 라벨은 /qa에 저장해 둔 상담사 라벨을 그대로 쓴다(없으면 실행 경로를 적는다).
        // 전사 원문은 저장하지 않는다 — qaHistory가 점수·누락 항목만 남긴다.
        const label = String(loadPersisted('cc-qa-agent-label', '') || '').trim()
        saveQaResult(qRes.value, { label: label || '파이프라인 실행' })
        setQaSaved(true)
      } else setStageErrors((e) => ({ ...e, qa: qRes.reason?.message || '평가 실패' }))

      // ⑥ VOC 누적 — 분석이 성공한 경우에만
      setStage(5)
      if (aRes.status === 'fulfilled') {
        saveMyCall({
          title: `파이프라인 시연: ${transcript.slice(0, 24)}`,
          category: aRes.value.category,
          sentiment: aRes.value.sentiment,
          escalate: aRes.value.escalate,
          churn: aRes.value.churn,
          route: aRes.value.ticket?.route,
        })
      } else {
        setStageErrors((e) => ({ ...e, voc: '분석이 실패해 이번 통화는 누적하지 않았습니다.' }))
      }
      setStage(6)
    } catch (err) {
      setError(err.message)
      setStage(-1)
    }
  }

  // 분석·QA는 병렬 구간이라 stage 3 동안 ④⑤가 함께 진행 표시된다
  const stageState = (i) =>
    stage === 6 || stage > i ? 'done' : stage === i || (stage === 3 && i === 4) ? 'now' : ''

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">전체 파이프라인 · 원클릭 시연</span>
        <h1>녹취에서 인사이트까지, 한 번에</h1>
        <p>
          버튼 하나로 <strong>실제 프로덕션 API</strong>가 순서대로 실행됩니다 — 내장 샘플 음성
          전사(Whisper) → 도메인 용어 보정 → LLM 통화 분석 → Auto QA 점수표 → VOC 대시보드
          누적. 시연용 가짜 경로 없이, 각 페이지에서 쓰는 그 파이프라인 그대로입니다.{' '}
          <strong>🎙 내 목소리로 실행</strong>을 누르면 지금 이 자리에서 녹음한 목소리가 같은
          6단계를 통과합니다.
        </p>
      </header>

      <div className="pipe-run">
        <div className="hub-cta">
          <button
            type="button"
            className="btn-primary"
            onClick={() => run()}
            disabled={(stage >= 0 && stage < 6) || recorder.recording}
          >
            {stage >= 0 && stage < 6 ? '파이프라인 실행 중...' : '▶ 내장 샘플로 실행 (약 30~50초)'}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={recorder.recording ? recorder.stop : recorder.start}
            disabled={stage >= 0 && stage < 6}
          >
            {recorder.recording ? `■ 녹음 끝내고 바로 실행 (${recorder.seconds}초)` : '🎙 내 목소리로 실행'}
          </button>
        </div>
        {recorder.recording && (
          <p className="result-empty-sub">
            상담 상황을 연기해 보세요 — 예: "고객님, 본인 확인을 위해 성함 부탁드립니다."
            녹음을 멈추면 그 목소리로 6단계가 바로 실행됩니다.
          </p>
        )}
        {micUrl && !recorder.recording && <audio controls src={micUrl} className="stt-audio" />}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>

      <ol className="pipe-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`pipe-step ${stageState(i)}`}>
            <div className="pipe-step-head">
              <span className="pipe-step-mark">
                {stageErrors[s.id] ? '!' : stageState(i) === 'done' ? '✓' : stageState(i) === 'now' ? '●' : i + 1}
              </span>
              <div>
                <strong>{s.title}</strong>
                <span className="pipe-step-desc">{s.desc}</span>
              </div>
            </div>
            {stageErrors[s.id] && (
              <p className="pipe-step-error">이 단계는 건너뛰고 계속 진행했습니다 — {stageErrors[s.id]}</p>
            )}

            {s.id === 'stt' && stt && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {stt.demo && <DemoBadge />}
                  <WorkersAiNote model={stt.model} latencyMs={stt.latency} />
                </div>
                <ResultNotice text={stt.notice} />
                <p className="pipe-text">"{stt.text}"</p>
              </div>
            )}

            {s.id === 'lex' && lex && (
              <div className="pipe-result">
                {lex.applied.length > 0 ? (
                  <>
                    <div className="chip-row">
                      {lex.applied.map((a) => (
                        <span className="chip" key={a.term}>→ {a.term} ×{a.count}</span>
                      ))}
                    </div>
                    <p className="pipe-text">"{lex.text}"</p>
                  </>
                ) : (
                  <p className="result-empty-sub">보정할 도메인 용어 없음 — 전사가 이미 정확합니다.</p>
                )}
              </div>
            )}

            {s.id === 'dia' && dia && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {dia.demo && <DemoBadge />}
                  <UsageNote usage={dia.usage} />
                  <OssLlmNote model={dia.llm_model} />
                </div>
                <ResultNotice text={dia.notice} />
                <p className="pipe-text">{dia.formatted}</p>
              </div>
            )}

            {s.id === 'analyze' && analysis && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {analysis.demo && <DemoBadge />}
                  <UsageNote usage={analysis.usage} />
                  <OssLlmNote model={analysis.llm_model} />
                </div>
                <ResultNotice text={analysis.notice} />
                <div className="chip-row">
                  <span className="cat-badge cat-ship">유형: {analysis.category}</span>
                  <span className="cat-badge cat-etc">감정: {analysis.sentiment}</span>
                  {analysis.escalate && <span className="escalate-badge">⚠ 담당자 확인 필요</span>}
                </div>
                <ul className="plain-list">
                  {(analysis.summary || []).map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>

                {/* 이탈 위험 · 대화 지표 · 티켓 초안 — 통화 분석 화면과 같은 컴포넌트로 그린다.
                    두 화면이 각자 렌더를 들고 있으면 한쪽만 고쳐져 어긋난다. */}
                <AnalysisLayers analysis={analysis} onError={setError} />
              </div>
            )}

            {s.id === 'qa' && qa && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {qa.demo && <DemoBadge />}
                  <UsageNote usage={qa.usage} />
                  <OssLlmNote model={qa.llm_model} />
                </div>
                <ResultNotice text={qa.notice} />
                <div className="stat-row">
                  <div className="stat-tile">
                    <span className="stat-label">총점</span>
                    <span className="stat-value">{qa.score.total}점 ({qa.score.grade})</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">규칙 멘트</span>
                    <span className="stat-value">{qa.score.ruleScore}/{MAX_RULE_SCORE}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">LLM 정성</span>
                    <span className="stat-value">{qa.score.llmScore}/60</span>
                  </div>
                </div>
                {qa.coaching && <p className="result-empty-sub">코칭: {qa.coaching}</p>}
                {qaSaved && (
                  <p className="result-empty-sub">
                    이 평가가 코칭 이력에 기록되었습니다 — 점수와 누락 항목만 이 브라우저에 남습니다.{' '}
                    <Link className="req-link" to="/qa">
                      코칭 이력에서 확인 →
                    </Link>
                  </p>
                )}
              </div>
            )}

            {/* "누적되었습니다"는 실제로 누적된 경우에만 쓴다 — 에러가 없다는 것과
                분석 결과가 있다는 것은 다르다(records.voc가 둘을 함께 본다). */}
            {s.id === 'voc' && stage === 6 && handoff.records.voc && (
              <div className="pipe-result">
                <p className="result-empty-sub">
                  이 분석이 VOC 대시보드에 누적되었습니다.{' '}
                  <Link className="req-link" to="/voc">
                    대시보드에서 확인 →
                  </Link>
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>

      {stage === 6 && (
        <>
          {/* 처리 상태 — 6단계를 돌렸다는 사실이 아니라 "그래서 이 통화가 어떻게 되는가"를
              닫는 자리. 값은 전부 앞 단계 응답에서 오고, 실패한 단계는 그대로 반영된다. */}
          <section className="analysis-block">
            <h2>처리 상태 — 이 통화는 어떻게 처리되는가</h2>
            <div className="voc-alerts">
              <div className={`voc-alert ${TONE_ALERT[handoff.status.tone] || ''}`}>
                <strong>{handoff.headline}</strong>
                <span>{handoff.status.detail}</span>
              </div>
            </div>

            <div className="churn-box">
              <div className="churn-head">
                <span className={`churn-level ${TONE_BADGE[handoff.status.tone] || 'churn-low'}`}>
                  {handoff.owner ? `${handoff.owner.priority} · ${handoff.owner.team}` : '담당 미배정'}
                </span>
                <span className="usage-note">
                  {handoff.due ? `처리 기한: ${handoff.due}` : '자동 배정 근거 없음 — 담당자는 사람이 정해야 합니다'}
                </span>
                <span className="usage-note">{handoff.run.label}</span>
              </div>
              {handoff.title && <p className="pipe-text">{handoff.title}</p>}

              <ul className="plain-list guide-alerts">
                {handoff.checks.map((c) => (
                  <li key={c.id} className={CHECK_LEVEL[c.level].cls}>
                    <strong>
                      <span className="guide-level">{CHECK_LEVEL[c.level].text}</span>
                      {c.label}
                    </strong>
                    <span className="guide-detail">{c.detail}</span>
                  </li>
                ))}
              </ul>

              <p className="result-empty-sub">
                기록: VOC 대시보드 {handoff.records.voc ? '반영됨' : '미반영'} · 코칭 이력{' '}
                {handoff.records.qaHistory ? '기록됨' : '미기록'} — 서버에는 아무것도 저장하지 않습니다.
              </p>
            </div>

            {/* 다음 행동은 존재하는 결과에서만 만든다. 분석이 실패했는데 "티켓 초안 복사"를
                띄우면 누른 사람이 빈 문서를 받는다 — 그래서 버튼 목록도 handoff가 정한다. */}
            <div className="hub-cta result-actions">
              {handoff.actions.map((a) =>
                a.to ? (
                  <Link key={a.id} to={a.to} className="btn-ghost">
                    {a.label} →
                  </Link>
                ) : (
                  <button
                    key={a.id}
                    type="button"
                    className="btn-ghost"
                    onClick={() =>
                      copyText(
                        a.id,
                        a.id === 'copy-ticket'
                          ? handoff.ticketText
                          : buildPipelineReport({ stt, lex, dia, analysis, qa, stageErrors, qaSaved })
                      )
                    }
                  >
                    {copied === a.id ? '✓ 복사됨' : a.label}
                  </button>
                )
              )}
            </div>
          </section>

          <div className="about-point">
            방금 실행된 6단계가 곧 채용공고의 담당업무입니다 — STT, 도메인 튜닝, 화자 분리(NLP),
            분류·요약·감정 분석, Auto QA, VOC. 각 단계는 <Link to="/stt">개별 페이지</Link>에서
            직접 입력으로도 실험할 수 있습니다.
          </div>
        </>
      )}
    </div>
  )
}
