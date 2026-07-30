import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { WorkersAiNote, ResultNotice } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import { computeCer } from '../lib/cer.js'
import { applyLexicon, buildCustomLexicon, MAX_CUSTOM_TERMS } from '../lib/domainLexicon.js'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'
import { useRecorder } from '../lib/useRecorder.js'
import { chunkAudioFile, bufferToB64, CHUNK_SECONDS, MAX_CHUNKS } from '../lib/audioChunk.js'
// 화면에 적는 상한은 코드 상수에서 계산한다 — 문구와 동작이 어긋나지 않게.
const CHUNK_LIMIT_MIN = Math.floor((MAX_CHUNKS * CHUNK_SECONDS) / 60)
import { usePersistentState } from '../lib/persist.js'

const CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024
const MODELS_LABEL = '@cf/openai/whisper-large-v3-turbo'

const GEN_STEPS = [
  '음성 파일을 서버로 전송하고 있어요',
  'Whisper 모델이 음성을 텍스트로 전사하고 있어요',
  '전사 결과를 정리하고 있어요',
]

const MAX_COMPARE_BYTES = 2 * 1024 * 1024
// 브라우저 디코딩·리샘플은 원본 크기의 몇 배를 메모리에 올린다. 상한이 없으면
// 30MB짜리 파일 하나로 탭이 죽으므로, 분할 전사에 들어가기 전에 먼저 막는다.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024
// CER은 O(n·m) DP다. 타이핑마다 재계산되므로 긴 전사에서는 계산을 건너뛴다.
const MAX_CER_CELLS = 2_000_000

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
  const [diarizing, setDiarizing] = useState(false)
  const [diaMeta, setDiaMeta] = useState(null)
  const [audioUrl, setAudioUrl] = useState('')
  const resultRef = useRef(null)
  // 전사 요청이 진행 중인지 — 버튼 disabled만으로는 막히지 않는 이중 실행을 막는다.
  // (샘플 데모는 wav를 받는 동안 loading이 아직 false여서 두 번 클릭이 가능했다)
  const busyRef = useRef(false)
  const audioUrlRef = useRef('')

  // 선택·녹음된 음성을 미리 들어볼 수 있게 objectURL을 관리한다
  function setFileWithPreview(f) {
    setFile(f)
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      const next = f ? URL.createObjectURL(f) : ''
      audioUrlRef.current = next
      return next
    })
  }

  // 페이지를 떠날 때 마지막 objectURL을 해제한다 — 교체할 때만 해제하면
  // 마지막 것이 document 수명 동안 Blob을 붙잡고 남는다.
  useEffect(
    () => () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    },
    []
  )

  const recorder = useRecorder({
    onDone: (f) => {
      setFileWithPreview(f)
      setError('')
    },
    onError: setError,
  })

  const transcript = tab === 'file' ? (result?.text ?? '') : text
  // CER은 화자 라벨이 붙기 전 전사로 계산한다. 라벨("상담사: ")이 섞인 텍스트를
  // 정답 스크립트와 비교하면 줄마다 편집거리가 늘어 turbo가 base보다 나쁜 것처럼 뒤집힌다.
  const cerBase = tab === 'file' ? (result?.plainText ?? result?.text ?? '') : text

  // 긴 전사에서는 DP 셀 수가 폭발해 타이핑마다 메인 스레드가 멈춘다 — 계산을 건너뛴다.
  const cerTooLong = useMemo(
    () => refScript.trim().length * cerBase.trim().length > MAX_CER_CELLS,
    [refScript, cerBase]
  )

  const cer = useMemo(() => {
    if (!refScript.trim() || !cerBase.trim() || cerTooLong) return null
    return computeCer(refScript, cerBase)
  }, [refScript, cerBase, cerTooLong])

  const altCer = useMemo(() => {
    if (!refScript.trim() || !altResult?.text || cerTooLong) return null
    return computeCer(refScript, altResult.text)
  }, [refScript, altResult, cerTooLong])

  // 우리 콜센터만의 오전사→정정 쌍 — 심사자가 도메인 튜닝을 직접 실험할 수 있다.
  // 브라우저에만 보관되어 재방문에도 유지된다 (서버 미저장).
  const [customTerms, setCustomTerms] = usePersistentState(
    'cc-stt-lexicon',
    Array.from({ length: MAX_CUSTOM_TERMS }, () => ({ wrong: '', term: '' }))
  )
  function setCustomTerm(i, field, value) {
    setCustomTerms((rows) => rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))
  }

  // 도메인 용어 보정(튜닝 1단계) — 보정이 일어난 경우에만 전/후 CER을 비교한다
  const corrected = useMemo(
    () => applyLexicon(cerBase, buildCustomLexicon(customTerms)),
    [cerBase, customTerms]
  )
  const correctedCer = useMemo(() => {
    if (!refScript.trim() || corrected.applied.length === 0 || cerTooLong) return null
    return computeCer(refScript, corrected.text)
  }, [refScript, corrected, cerTooLong])

  // 장시간 녹취 분할 전사 — 6MB·단발 호출 한계를 클라이언트 분할로 돌파한다
  const [chunkNote, setChunkNote] = useState('')
  async function transcribeLong(theFile) {
    setLoading(true)
    setError('')
    setAltResult(null)
    const texts = []
    let chunkCount = 0
    let demoChunks = 0
    const startedAt = Date.now()
    const commit = (note) => {
      const merged = texts.filter(Boolean).join(' ')
      if (!merged) return false
      setResult({
        // 청크가 데모 전사(AI 미연결)로 돌아왔다면 라이브라고 표시하지 않는다
        demo: demoChunks > 0,
        text: merged,
        plainText: merged,
        model: `${MODELS_LABEL} · 분할 전사 ${texts.length}/${chunkCount}청크`,
        latency: Date.now() - startedAt,
        chunked: texts.length,
        notice: note,
      })
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      return true
    }
    try {
      setChunkNote('긴 녹취를 디코딩·분할하고 있어요 (16kHz 모노 리샘플)...')
      const chunks = await chunkAudioFile(theFile)
      chunkCount = chunks.length
      for (let i = 0; i < chunks.length; i++) {
        setChunkNote(`청크 ${i + 1}/${chunks.length} 전사 중 (${Math.round(chunks[i].start)}~${Math.round(chunks[i].end)}초)...`)
        const r = await postJson('/api/cc/stt', { audio_b64: bufferToB64(chunks[i].wav) })
        if (r.demo) demoChunks += 1
        texts.push((r.text || '').trim())
      }
      if (!commit(undefined)) {
        setError('전사 결과가 비어 있습니다. 무음이거나 인식 가능한 발화가 없는 파일로 보입니다.')
      }
    } catch (err) {
      const message =
        err.name === 'EncodingError' || err.name === 'NotSupportedError'
          ? '이 형식은 브라우저가 디코드하지 못했습니다. mp3/wav/m4a로 시도해주세요.'
          : err.message
      // 여기서 그냥 throw하면 이미 성공한 청크 수십 개가 통째로 버려진다.
      // 30분을 기다린 사용자가 빈 화면을 받는 대신, 완료된 분량이라도 살려서 보여준다.
      const saved = commit(`${chunkCount}청크 중 ${texts.length}청크까지 전사한 뒤 중단됐습니다. (${message})`)
      setError(saved ? `전사가 중간에 중단됐습니다 — 완료된 부분만 표시합니다. (${message})` : message)
    } finally {
      setLoading(false)
      setChunkNote('')
    }
  }

  async function runTranscribe(theFile, withCompare) {
    if (busyRef.current) return
    if (!theFile) {
      setError('음성 파일을 선택하거나 마이크로 녹음해주세요.')
      return
    }
    if (theFile.size === 0) {
      setError('빈 파일입니다. 다른 음성 파일을 선택해주세요.')
      return
    }
    if (theFile.size > MAX_UPLOAD_BYTES) {
      setError(`파일이 너무 큽니다 (${Math.round(theFile.size / 1024 / 1024)}MB). ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 이하로 올려주세요.`)
      return
    }
    if (withCompare && theFile.size > MAX_COMPARE_BYTES) {
      setError('모델 비교는 2MB 이하의 짧은 음성으로만 가능합니다. 비교를 끄거나 짧게 녹음해주세요.')
      return
    }
    busyRef.current = true
    try {
      // 단발 호출 한도(6MB)를 넘는 긴 녹취는 오류가 아니라 분할 전사로 자동 전환한다.
      // 비교 모드는 위에서 2MB로 이미 걸러졌으므로 여기 오는 건 비교가 아닌 경로다.
      if (theFile.size > CHUNK_THRESHOLD_BYTES) {
        await transcribeLong(theFile)
        return
      }
      setLoading(true)
      setError('')
      setAltResult(null)
      try {
        const audio_b64 = await fileToBase64(theFile)
        const data = await postJson('/api/cc/stt', { audio_b64 })
        setResult({ ...data, plainText: data.text })
        requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
        if (withCompare) {
          // 같은 음성을 base whisper로도 전사해 CER을 비교한다 (성능 평가 시연)
          try {
            const alt = await postJson('/api/cc/stt', { audio_b64, model: 'base' })
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
    } finally {
      busyRef.current = false
    }
  }

  function transcribe(e) {
    e.preventDefault()
    runTranscribe(file, compare)
  }

  // 내장 샘플 음성(합성 목소리) 원클릭 시연 — 정답 스크립트까지 채워 CER이 바로 계산된다
  const SAMPLE_SCRIPT = '안녕하세요. 한빛텔레콤 상담사입니다. 상담 품질 향상을 위해 통화 내용이 녹음됩니다.'
  async function runSampleDemo() {
    if (busyRef.current || loading) return
    // wav를 받는 동안에도 버튼을 잠근다 — 예전에는 이 사이에 두 번 클릭하면
    // 비교 모드 전사가 2회 병렬로 나가 유료 호출 4건이 발생했다.
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/sample-call.wav')
      // 404가 SPA 폴백으로 HTML을 돌려주면 blob()은 성공한다 — 상태코드를 반드시 본다.
      if (!res.ok) throw new Error(`샘플 음성을 불러오지 못했습니다 (${res.status}).`)
      const blob = await res.blob()
      if (blob.size === 0) throw new Error('샘플 음성이 비어 있습니다.')
      const f = new File([blob], '내장 샘플 음성.wav', { type: 'audio/wav' })
      setFileWithPreview(f)
      setRefScript(SAMPLE_SCRIPT)
      setCompare(true)
      setLoading(false)
      await runTranscribe(f, true)
    } catch (err) {
      setLoading(false)
      setError(err.message || '샘플 음성을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.')
    }
  }

  // 화자 분리 — 통짜 전사를 상담사:/고객: 형식으로 재구성 (Auto QA 규칙 층 연결용)
  async function diarize() {
    const base = result?.text?.trim()
    if (!base) return
    setDiarizing(true)
    setError('')
    try {
      const data = await postJson('/api/cc/diarize', { transcript: base })
      // 서버는 6000자까지만 처리한다. 잘린 뒷부분을 원문 그대로 이어 붙여야
      // 화자 분리 한 번에 긴 전사의 뒷부분이 소실되지 않는다.
      const tail = data.truncated ? base.slice(data.processed_chars) : ''
      const merged = tail ? `${data.formatted}\n${tail}` : data.formatted
      // 함수형 업데이트 — 응답을 기다리는 동안 사용자가 전사를 고쳤을 수 있다.
      setResult((prev) => ({ ...prev, text: merged, plainText: prev.plainText ?? prev.text }))
      setDiaMeta(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setDiarizing(false)
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
              <p className="mic-title">가장 빠른 시연 — 클릭 한 번</p>
              <button type="button" className="btn-ghost sample-demo-btn" onClick={runSampleDemo} disabled={loading || recorder.recording}>
                ▶ 내장 샘플 음성으로 2종 모델 전사 + CER 비교
              </button>
              <p className="mic-title">또는 지금 바로 마이크로 시연</p>
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
              또는 음성 파일 선택 (mp3/wav/m4a/ogg · 4MB 초과 긴 녹취는 자동 분할 전사, 최대 약 {CHUNK_LIMIT_MIN}분)
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg,.webm"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setError('')
                  // accept는 대화상자의 힌트일 뿐이다. "모든 파일"로 바꿔 고르거나
                  // 드래그하면 PDF도 들어오므로, 서버로 보내기 전에 여기서 막는다.
                  if (f && !(f.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|flac|aac)$/i.test(f.name))) {
                    setFileWithPreview(null)
                    e.target.value = ''
                    setError('음성 파일이 아닙니다. mp3/wav/m4a/ogg/webm 파일을 선택해주세요.')
                    return
                  }
                  if (f && f.size === 0) {
                    setFileWithPreview(null)
                    e.target.value = ''
                    setError('빈 파일입니다. 다른 음성 파일을 선택해주세요.')
                    return
                  }
                  setFileWithPreview(f)
                }}
              />
            </label>
            {file && (
              <>
                <p className="batch-meta">
                  <span className="batch-count ok">
                    {file.name} · {(file.size / 1024 / 1024).toFixed(2)}MB
                  </span>
                </p>
                {audioUrl && <audio controls src={audioUrl} className="stt-audio" />}
              </>
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
          {loading && !chunkNote && <GenProgress steps={GEN_STEPS} />}
          {loading && chunkNote && (
            <div className="result-empty">
              <p>장시간 녹취 분할 전사 진행 중</p>
              <p className="result-empty-sub">{chunkNote}</p>
            </div>
          )}
          {tab === 'file' && result && !loading && (
            <>
              <ResultNotice text={result.notice} />
              <div className="result-toolbar">
                {result.demo && <DemoBadge />}
                <WorkersAiNote model={result.model} latencyMs={result.latency} />
              </div>
              <label className="stt-out-label">
                {diarizing ? '전사 결과 (화자 분리 중에는 수정할 수 없어요)' : '전사 결과 (수정 가능)'}
                <textarea
                  value={result.text}
                  // 화자 분리 응답이 돌아오면 텍스트를 교체하므로, 그동안의 편집은
                  // 어차피 덮인다. 잠가두는 편이 "고친 게 사라지는" 경험보다 정직하다.
                  readOnly={diarizing}
                  onChange={(e) => setResult((prev) => ({ ...prev, text: e.target.value }))}
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
              {diaMeta && <ResultNotice text={diaMeta.notice} />}
              <div className="batch-meta">
                <button type="button" className="preset-chip" onClick={diarize} disabled={diarizing}>
                  {diarizing ? '화자 분리 중...' : '👥 화자 분리 (상담사/고객 태깅)'}
                </button>
                {diaMeta && !diaMeta.demo && (
                  <span className="usage-note">화자 분리 적용됨 — QA의 상담사 발화 평가가 정확해집니다</span>
                )}
              </div>
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
              <details className="custom-docs qa-custom">
                <summary>
                  + 도메인 사전 커스터마이즈 — 오전사→정정 쌍 추가 (최대 {MAX_CUSTOM_TERMS}개)
                </summary>
                <p className="result-empty-sub">
                  내장 사전(한빛텔레콤·위약금 등 7종)에 우리 도메인의 용어를 얹어 보정 효과를
                  직접 실험해 보세요. 보정 전/후 CER 개선 폭이 즉시 다시 계산됩니다.
                </p>
                {customTerms.map((r, i) => (
                  <div className="qa-custom-row" key={i}>
                    <input
                      type="text"
                      placeholder="Whisper 오전사 (예: 한 밑에 내 콤)"
                      value={r.wrong}
                      maxLength={30}
                      onChange={(e) => setCustomTerm(i, 'wrong', e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="정정할 용어 (예: 한빛텔레콤)"
                      value={r.term}
                      maxLength={30}
                      onChange={(e) => setCustomTerm(i, 'term', e.target.value)}
                    />
                  </div>
                ))}
              </details>
              {cerTooLong && (
                <ResultNotice text="전사와 정답 스크립트가 길어 CER 계산을 생략했습니다. (편집거리 계산이 브라우저를 멈추게 하므로, 짧은 구간으로 나눠 비교해 주세요)" />
              )}
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
              {corrected.applied.length > 0 && (
                <div className="lexicon-box">
                  <h3>도메인 용어 보정 — 튜닝 1단계</h3>
                  <p className="result-empty-sub">
                    콜센터 도메인 사전으로 전사 오류를 후보정했습니다 (모델 재학습 없는 경량
                    도메인 최적화).
                  </p>
                  <div className="chip-row">
                    {corrected.applied.map((a) => (
                      <span className={`chip${a.custom ? ' mine-chip' : ''}`} key={a.term}>
                        → {a.term} ×{a.count}
                        {a.custom ? ' (커스텀)' : ''}
                      </span>
                    ))}
                  </div>
                  <p className="lexicon-text">{corrected.text}</p>
                  {cer && correctedCer && (
                    <div className="stat-row">
                      <div className="stat-tile">
                        <span className="stat-label">보정 전 CER</span>
                        <span className="stat-value">{(cer.cer * 100).toFixed(1)}%</span>
                      </div>
                      <div className="stat-tile">
                        <span className="stat-label">보정 후 CER</span>
                        <span className="stat-value">{(correctedCer.cer * 100).toFixed(1)}%</span>
                      </div>
                      <div className="stat-tile">
                        <span className="stat-label">개선 폭</span>
                        <span className="stat-value">
                          {cer.cer > 0 ? `-${(((cer.cer - correctedCer.cer) / cer.cer) * 100).toFixed(0)}%` : '—'}
                        </span>
                      </div>
                    </div>
                  )}
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
