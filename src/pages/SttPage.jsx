import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { WorkersAiNote, ResultNotice } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import { computeCer } from '../lib/cer.js'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'

const GEN_STEPS = [
  '음성 파일을 서버로 전송하고 있어요',
  'Whisper 모델이 음성을 텍스트로 전사하고 있어요',
  '전사 결과를 정리하고 있어요',
]

const MAX_FILE_BYTES = 6 * 1024 * 1024
const MAX_COMPARE_BYTES = 2 * 1024 * 1024

// data URL에서 base64 본문만 추출한다
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result || '')
      const comma = s.indexOf(',')
      resolve(comma >= 0 ? s.slice(comma + 1) : s)
    }
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'))
    reader.readAsDataURL(file)
  })
}

// 마이크 녹음 (MediaRecorder) — 심사자가 파일 준비 없이 그 자리에서 시연할 수 있게 한다
function useRecorder({ onDone, onError }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef(null)
  const timerRef = useRef(null)

  useEffect(() => () => {
    clearInterval(timerRef.current)
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(timerRef.current)
        setRecording(false)
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const ext = (rec.mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'
        onDone(new File([blob], `마이크 녹음.${ext}`, { type: blob.type }))
      }
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
      setRecording(true)
    } catch {
      onError('마이크 권한이 필요합니다. 브라우저 주소창의 권한 요청을 허용해주세요.')
    }
  }

  function stop() {
    recorderRef.current?.stop()
  }

  return { recording, seconds, start, stop }
}

export default function SttPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState('file')
  const [file, setFile] = useState(null)
  const [compare, setCompare] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [altResult, setAltResult] = useState(null)
  const [text, setText] = useState('')
  const [refScript, setRefScript] = useState('')
  const resultRef = useRef(null)

  const recorder = useRecorder({
    onDone: (f) => {
      setFile(f)
      setError('')
    },
    onError: setError,
  })

  const transcript = tab === 'file' ? (result?.text ?? '') : text

  const cer = useMemo(() => {
    if (!refScript.trim() || !transcript.trim()) return null
    return computeCer(refScript, transcript)
  }, [refScript, transcript])

  const altCer = useMemo(() => {
    if (!refScript.trim() || !altResult?.text) return null
    return computeCer(refScript, altResult.text)
  }, [refScript, altResult])

  async function transcribe(e) {
    e.preventDefault()
    if (!file) {
      setError('음성 파일을 선택하거나 마이크로 녹음해주세요.')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setError('파일이 너무 큽니다. 6MB 이하의 음성 파일을 올려주세요.')
      return
    }
    if (compare && file.size > MAX_COMPARE_BYTES) {
      setError('모델 비교는 2MB 이하의 짧은 음성으로만 가능합니다. 비교를 끄거나 짧게 녹음해주세요.')
      return
    }
    setLoading(true)
    setError('')
    setAltResult(null)
    try {
      const audio_b64 = await fileToBase64(file)
      const data = await postJson('/api/cc/stt', { audio_b64, content_type: file.type })
      setResult(data)
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      if (compare) {
        // 같은 음성을 base whisper로도 전사해 CER을 비교한다 (성능 평가 시연)
        try {
          const alt = await postJson('/api/cc/stt', { audio_b64, content_type: file.type, model: 'base' })
          setAltResult(alt)
        } catch (altErr) {
          setAltResult({ failed: true, notice: `비교 모델 전사 실패: ${altErr.message}` })
        }
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function sendToAnalyze() {
    if (!transcript.trim()) {
      setError('먼저 전사 결과나 텍스트를 준비해주세요.')
      return
    }
    sessionStorage.setItem('cc-transcript', transcript)
    navigate('/analyze')
  }

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ① STT · 오픈소스 Whisper</span>
        <h1>녹취 전사 (STT)</h1>
        <p>
          상담 녹취 음성을 오픈소스 <strong>Whisper</strong>(Cloudflare Workers AI)로 전사합니다.
          정답 스크립트를 붙여넣으면 <strong>CER(문자 오류율)</strong>로 전사 품질을 측정하고,
          Whisper <strong>2종 모델을 같은 음성으로 비교</strong>할 수도 있습니다 — 공고의
          "오픈소스 STT 모델 성능 평가" 업무 그대로입니다. 업로드 음성은 전사 후 저장하지
          않습니다.
        </p>
      </header>

      <div className="tab-row" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'file'}
          className={tab === 'file' ? 'tab active' : 'tab'}
          onClick={() => setTab('file')}
        >
          녹음·파일 업로드
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'text'}
          className={tab === 'text' ? 'tab active' : 'tab'}
          onClick={() => setTab('text')}
        >
          텍스트 직접 입력 (음성 없이 시연)
        </button>
      </div>

      <div className="tool-layout">
        {tab === 'file' ? (
          <form className="tool-form" onSubmit={transcribe}>
            <div className="mic-box">
              <p className="mic-title">지금 바로 마이크로 시연</p>
              {!recorder.recording ? (
                <button type="button" className="btn-primary mic-btn" onClick={recorder.start} disabled={loading}>
                  ● 녹음 시작
                </button>
              ) : (
                <button type="button" className="btn-primary mic-btn mic-live" onClick={recorder.stop}>
                  ■ 녹음 종료 ({recorder.seconds}초)
                </button>
              )}
              <p className="result-empty-sub">
                예: "안녕하세요, 한빛텔레콤 상담사입니다. 상담 품질 향상을 위해 통화 내용이
                녹음됩니다." 라고 말해보세요.
              </p>
            </div>

            <label>
              또는 음성 파일 선택 (mp3/wav/m4a/ogg · 6MB 이하)
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null)
                  setError('')
                }}
              />
            </label>
            {file && (
              <p className="batch-meta">
                <span className="batch-count ok">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(2)}MB
                </span>
              </p>
            )}
            <label className="channel-check compare-check">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              Whisper 2종 모델 비교 (large-v3-turbo vs whisper · 2MB 이하 짧은 음성)
            </label>
            <button type="submit" className="btn-primary" disabled={loading || recorder.recording}>
              {loading ? '전사 중... (10~30초)' : compare ? '2종 모델로 전사·비교하기' : 'Whisper로 전사하기'}
            </button>
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
        ) : (
          <form className="tool-form" onSubmit={(e) => e.preventDefault()}>
            <label>
              통화 텍스트 — 상담사:/고객: 형식 권장
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} />
            </label>
            <div className="batch-meta">
              <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[0].transcript)}>
                샘플 채우기: 요금제 변경 문의
              </button>
              <button type="button" className="preset-chip" onClick={() => setText(SAMPLE_CALLS[2].transcript)}>
                샘플 채우기: 강성 민원
              </button>
            </div>
            <button type="button" className="btn-primary" onClick={sendToAnalyze}>
              이 텍스트를 통화 분석으로 보내기 →
            </button>
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
        )}

        <div className="tool-result" ref={resultRef}>
          {tab === 'file' && !result && !loading && (
            <div className="result-empty">
              <p>마이크로 녹음하거나 음성 파일을 올리면 Whisper 전사 결과가 여기에 표시됩니다.</p>
              <p className="result-empty-sub">
                Workers AI 바인딩으로 동작해 API 키 없이도 실제 전사가 됩니다.
              </p>
            </div>
          )}
          {loading && <GenProgress steps={GEN_STEPS} />}
          {tab === 'file' && result && !loading && (
            <>
              <ResultNotice text={result.notice} />
              <div className="result-toolbar">
                {result.demo && <DemoBadge />}
                <WorkersAiNote model={result.model} latencyMs={result.latency} />
              </div>
              <label className="stt-out-label">
                전사 결과 (수정 가능)
                <textarea
                  value={result.text}
                  onChange={(e) => setResult({ ...result, text: e.target.value })}
                  rows={8}
                />
              </label>
              {altResult && !altResult.failed && (
                <div className="stt-alt">
                  <div className="result-toolbar">
                    <WorkersAiNote model={altResult.model} latencyMs={altResult.latency} />
                  </div>
                  <p className="stt-alt-text">{altResult.text}</p>
                </div>
              )}
              {altResult?.failed && <ResultNotice text={altResult.notice} />}
              <button type="button" className="btn-primary" onClick={sendToAnalyze}>
                이 전사를 통화 분석으로 보내기 →
              </button>
            </>
          )}

          {transcript.trim() && (
            <section className="cer-box">
              <h2>STT 성능 평가 — CER(문자 오류율)</h2>
              <p className="result-empty-sub">
                실제로 말한 내용(정답 스크립트)을 붙여넣으면 전사 결과와 문자 단위로 비교합니다.
                공백·문장부호는 제외하고 계산합니다.
              </p>
              <textarea
                value={refScript}
                onChange={(e) => setRefScript(e.target.value)}
                rows={4}
                placeholder="정답 스크립트를 붙여넣으세요"
                aria-label="정답 스크립트"
              />
              {cer && (
                <div className="stat-row">
                  <div className="stat-tile">
                    <span className="stat-label">CER (낮을수록 좋음)</span>
                    <span className="stat-value">{(cer.cer * 100).toFixed(1)}%</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">문자 정확도</span>
                    <span className="stat-value">{(cer.accuracy * 100).toFixed(1)}%</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">편집거리 / 정답 길이</span>
                    <span className="stat-value">
                      {cer.distance} / {cer.refLength}자
                    </span>
                  </div>
                </div>
              )}
              {cer && altCer && altResult && !altResult.failed && (
                <div className="req-table-wrap cer-compare">
                  <table className="req-table">
                    <thead>
                      <tr>
                        <th>모델</th>
                        <th>CER</th>
                        <th>정확도</th>
                        <th>지연</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>whisper-large-v3-turbo</td>
                        <td className="req-name">{(cer.cer * 100).toFixed(1)}%</td>
                        <td>{(cer.accuracy * 100).toFixed(1)}%</td>
                        <td>{result?.latency != null ? `${(result.latency / 1000).toFixed(1)}초` : '—'}</td>
                      </tr>
                      <tr>
                        <td>whisper (base)</td>
                        <td className="req-name">{(altCer.cer * 100).toFixed(1)}%</td>
                        <td>{(altCer.accuracy * 100).toFixed(1)}%</td>
                        <td>{altResult.latency != null ? `${(altResult.latency / 1000).toFixed(1)}초` : '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
