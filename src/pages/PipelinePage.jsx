import { useState } from 'react'
import { Link } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { OssLlmNote, UsageNote, WorkersAiNote } from '../components/ResultMeta.jsx'
import { applyLexicon } from '../lib/domainLexicon.js'
import { saveMyCall } from '../lib/myCalls.js'
import { MAX_RULE_SCORE } from '../lib/qaRules.js'

// 공고의 담당업무 파이프라인(녹취→STT→분석→QA→VOC)을 버튼 하나로 통과시키는 시연.
// 각 단계는 실제 프로덕션 API를 그대로 호출한다 — 별도의 시연용 가짜 경로가 없다.

const STEPS = [
  { id: 'stt', title: '① 녹취 전사', desc: 'Whisper large-v3-turbo (Workers AI)' },
  { id: 'lex', title: '② 도메인 보정', desc: '콜센터 용어 사전 후보정 (튜닝 1단계)' },
  { id: 'analyze', title: '③ 통화 분석', desc: '분류·요약·감정·에스컬레이션 (LLM)' },
  { id: 'qa', title: '④ 품질 평가', desc: '규칙 40점 + LLM 60점 Auto QA' },
  { id: 'voc', title: '⑤ VOC 누적', desc: '대시보드에 분석 결과 합산' },
]

function b64FromBuffer(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export default function PipelinePage() {
  const [stage, setStage] = useState(-1) // -1 대기, 0~4 진행, 5 완료
  const [error, setError] = useState('')
  const [stt, setStt] = useState(null)
  const [lex, setLex] = useState(null)
  const [analysis, setAnalysis] = useState(null)
  const [qa, setQa] = useState(null)

  async function run() {
    setError('')
    setStt(null)
    setLex(null)
    setAnalysis(null)
    setQa(null)
    try {
      // ① STT — 내장 샘플 음성을 실제 Whisper로 전사
      setStage(0)
      const wav = await fetch('/sample-call.wav').then((r) => r.arrayBuffer())
      const sttRes = await postJson('/api/cc/stt', { audio_b64: b64FromBuffer(wav) })
      setStt(sttRes)

      // ② 도메인 보정
      setStage(1)
      const corrected = applyLexicon(sttRes.text)
      setLex(corrected)
      const transcript = corrected.text

      // ③ 통화 분석
      setStage(2)
      const a = await postJson('/api/cc/analyze', { transcript })
      setAnalysis(a)

      // ④ Auto QA
      setStage(3)
      const q = await postJson('/api/cc/qa', { transcript })
      setQa(q)

      // ⑤ VOC 누적
      setStage(4)
      saveMyCall({
        title: `파이프라인 시연: ${transcript.slice(0, 24)}`,
        category: a.category,
        sentiment: a.sentiment,
        escalate: a.escalate,
      })
      setStage(5)
    } catch (err) {
      setError(err.message)
      setStage(-1)
    }
  }

  const stageState = (i) => (stage === 5 || stage > i ? 'done' : stage === i ? 'now' : '')

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">전체 파이프라인 · 원클릭 시연</span>
        <h1>녹취에서 인사이트까지, 한 번에</h1>
        <p>
          버튼 하나로 <strong>실제 프로덕션 API</strong>가 순서대로 실행됩니다 — 내장 샘플 음성
          전사(Whisper) → 도메인 용어 보정 → LLM 통화 분석 → Auto QA 점수표 → VOC 대시보드
          누적. 시연용 가짜 경로 없이, 각 페이지에서 쓰는 그 파이프라인 그대로입니다.
        </p>
      </header>

      <div className="pipe-run">
        <button type="button" className="btn-primary" onClick={run} disabled={stage >= 0 && stage < 5}>
          {stage >= 0 && stage < 5 ? '파이프라인 실행 중...' : '▶ 전체 파이프라인 실행 (약 20~40초)'}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>

      <ol className="pipe-steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`pipe-step ${stageState(i)}`}>
            <div className="pipe-step-head">
              <span className="pipe-step-mark">{stageState(i) === 'done' ? '✓' : stageState(i) === 'now' ? '●' : i + 1}</span>
              <div>
                <strong>{s.title}</strong>
                <span className="pipe-step-desc">{s.desc}</span>
              </div>
            </div>

            {s.id === 'stt' && stt && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {stt.demo && <DemoBadge />}
                  <WorkersAiNote model={stt.model} latencyMs={stt.latency} />
                </div>
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

            {s.id === 'analyze' && analysis && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {analysis.demo && <DemoBadge />}
                  <UsageNote usage={analysis.usage} />
                  <OssLlmNote model={analysis.llm_model} />
                </div>
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
              </div>
            )}

            {s.id === 'qa' && qa && (
              <div className="pipe-result">
                <div className="result-toolbar">
                  {qa.demo && <DemoBadge />}
                  <UsageNote usage={qa.usage} />
                  <OssLlmNote model={qa.llm_model} />
                </div>
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
              </div>
            )}

            {s.id === 'voc' && stage === 5 && (
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

      {stage === 5 && (
        <div className="about-point">
          방금 실행된 5단계가 곧 채용공고의 담당업무입니다 — STT, 도메인 튜닝, 분류·요약·감정
          분석, Auto QA, VOC. 각 단계는 <Link to="/stt">개별 페이지</Link>에서 직접 입력으로도
          실험할 수 있습니다.
        </div>
      )}
    </div>
  )
}
