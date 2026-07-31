import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
// 부드러운 스크롤 판정은 motion.js 한 곳에서만 한다 — 여기서 behavior를 직접 지정하면
// CSS의 scroll-behavior:auto !important 보다 인자가 우선해 '동작 줄이기'가 무시된다.
import { revealElement } from '../components/motion.js'
import { WorkersAiNote, ResultNotice } from '../components/ResultMeta.jsx'
import GenProgress from '../components/GenProgress.jsx'
import { computeCer } from '../lib/cer.js'
import { applyLexicon, buildCustomLexicon, MAX_CUSTOM_TERMS } from '../lib/domainLexicon.js'
import { maskPii, maskNotice } from '../lib/piiMask.js'
import SegmentTimeline from '../components/SegmentTimeline.jsx'
import { assignSpeakers, setSpeaker } from '../lib/segments.js'
import {
  stitchChunks,
  buildTimeline,
  diagnoseTimeline,
  formatClock,
  SILENCE_MIN_SEC,
} from '../lib/callTimeline.js'
import { SAMPLE_CALLS } from '../lib/sampleCalls.js'
import { useRecorder } from '../lib/useRecorder.js'
import {
  chunkAudioFile,
  bufferToB64,
  describeUpload,
  formatDuration,
  needsChunking,
  toMb,
  CHUNK_SECONDS,
  MAX_CHUNKS,
  SINGLE_SHOT_MAX_BYTES,
  SINGLE_SHOT_MAX_SECONDS,
} from '../lib/audioChunk.js'
// 화면에 적는 상한은 코드 상수에서 계산한다 — 문구와 동작이 어긋나지 않게.
const CHUNK_LIMIT_MIN = Math.floor((MAX_CHUNKS * CHUNK_SECONDS) / 60)
const SINGLE_SHOT_MAX_MB = toMb(SINGLE_SHOT_MAX_BYTES)
const SINGLE_SHOT_MAX_MIN = Math.floor(SINGLE_SHOT_MAX_SECONDS / 60)
import { usePersistentState } from '../lib/persist.js'

const MODELS_LABEL = '@cf/openai/whisper-large-v3-turbo'

// 단발 전사가 이런 이유로 실패하면 분할 전사로 다시 시도해 볼 값이 있다(길이·지연 계열).
// 예산 초과(429)나 보안 검증 실패(403)는 다시 보내도 같은 결과라 재시도하지 않는다.
const RETRY_AS_CHUNKED = /지연|너무 큽니다/

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

const TABS = [
  { id: 'file', label: '녹음·파일 업로드' },
  { id: 'text', label: '텍스트 직접 입력 (음성 없이 시연)' },
]

// 지연 표시 — 데모 응답의 시간은 추론 시간이 아니라 요청 처리 시간이므로 그렇게 적는다
function latencyText(ms, demo) {
  if (ms == null) return '—'
  return `${(ms / 1000).toFixed(1)}초${demo ? ' (데모)' : ''}`
}

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
  // 구간을 눌렀을 때 그 지점부터 재생하려면 오디오 요소를 직접 잡아야 한다
  const audioRef = useRef(null)
  const [activeSeg, setActiveSeg] = useState(-1)
  // 미리듣기 요소가 읽어 준 길이 — 분할 여부·청크 수를 업로드 전에 정확히 알리는 데 쓴다.
  // 디코딩 비용을 따로 치르지 않고 얻는 값이라 공짜다. (읽히기 전에는 null)
  const [durationSec, setDurationSec] = useState(null)
  const resultRef = useRef(null)
  const tabRefs = useRef({})
  // 전사 요청이 진행 중인지 — 버튼 disabled만으로는 막히지 않는 이중 실행을 막는다.
  // (샘플 데모는 wav를 받는 동안 loading이 아직 false여서 두 번 클릭이 가능했다)
  const busyRef = useRef(false)
  const audioUrlRef = useRef('')

  // 선택·녹음된 음성을 미리 들어볼 수 있게 objectURL을 관리한다
  function setFileWithPreview(f) {
    setFile(f)
    // 새 파일의 길이를 알기 전까지는 이전 파일의 길이를 남겨두면 안 된다 —
    // 30초 파일 뒤에 20분 파일을 고르면 "단발 1회"라고 잘못 안내한다.
    setDurationSec(null)
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

  // 이 화면 밖으로 나가는 텍스트는 여기 한 곳에서 만든다:
  //   원문 → 개인정보 마스킹 → 도메인 사전 보정
  //
  // 두 가지가 이 한 줄에 걸려 있다.
  // (1) 콜센터 통화에는 본인확인이 반드시 들어가 주민번호·카드·연락처가 전사에 남는다.
  //     가리지 않으면 분석 API·QA 평가·티켓·세션 저장소·클립보드로 그대로 퍼진다.
  // (2) 예전에는 사전 보정본(corrected)이 미리보기에만 쓰였고, 정작 다음 단계로 넘어간 것은
  //     보정 전 원문이었다 — 보정 효과를 측정만 하고 쓰지는 않은 셈이다.
  const masked = useMemo(() => maskPii(transcript), [transcript])
  const outbound = useMemo(
    () => applyLexicon(masked.text, buildCustomLexicon(customTerms)).text,
    [masked.text, customTerms]
  )

  // 시간 지표 — 타임스탬프가 있을 때만 계산된다(없으면 null).
  //
  // callMetrics.js는 발화량을 글자 수로 재고 스스로 "근사치"라고 적어 두었다. 글자 수로는
  // 침묵과 발화 속도를 원리적으로 볼 수 없다 — 아무도 말하지 않은 시간은 글자가 0이라
  // 존재 자체가 안 보이고, 같은 100자를 20초에 말했는지 60초에 말했는지도 구분되지 않는다.
  // 구간 타임스탬프가 있으면 그 둘을 실측으로 바꿀 수 있다.
  //
  // durationSec은 서버가 준 음성 파일의 실제 길이만 쓴다. 미리듣기 상태값(durationSec)은
  // 전사 후 다른 파일을 고르면 바뀌어 있어서, 끝난 전사의 통화 길이를 엉뚱하게 늘린다.
  const timeline = useMemo(
    () => buildTimeline(result?.segments, { durationSec: result?.duration ?? null, blind: result?.blind ?? [] }),
    [result?.segments, result?.duration, result?.blind]
  )
  const timeDiagnosis = useMemo(() => diagnoseTimeline(timeline), [timeline])

  // 장시간 녹취 분할 전사 — 6MB·단발 호출 한계를 클라이언트 분할로 돌파한다
  const [chunkNote, setChunkNote] = useState('')
  async function transcribeLong(theFile, leadNote = '') {
    setLoading(true)
    setError('')
    setAltResult(null)
    const texts = []
    // 청크별 전사 구간을 청크 경계(start/end)와 함께 모은다. 경계가 곧 오프셋이다.
    const chunkSegments = []
    let chunkCount = 0
    let demoChunks = 0
    // 파일 전체 길이와 청크 목록 — 전사가 중간에 끊겨도 이 둘은 변하지 않는다.
    // 이것이 없으면 중단 시 "시도한 만큼"이 곧 통화 길이가 되어 화면이 짧게 거짓말한다.
    let totalSec = null
    let allChunks = []
    const startedAt = Date.now()
    const commit = (note) => {
      const merged = texts.filter(Boolean).join(' ')
      if (!merged) return false
      // 각 청크의 타임스탬프는 **청크 내부 기준(0초 시작)**이라 그대로 쓰면
      // 27분 통화의 구간이 전부 0~55초에 뭉친다. 청크 start를 더해 전체 타임라인으로 잇는다.
      const { segments, blind } = stitchChunks(chunkSegments)
      setResult({
        // 청크가 데모 전사(AI 미연결)로 돌아왔다면 라이브라고 표시하지 않는다
        demo: demoChunks > 0,
        text: merged,
        plainText: merged,
        model: `${MODELS_LABEL} · 분할 전사 ${texts.length}/${chunkCount}청크`,
        latency: Date.now() - startedAt,
        chunked: texts.length,
        segments: segments.length ? segments : null,
        // 시도조차 못 한 청크(중단 지점 이후)도 '모르는 시간'이다. 넣지 않으면
        // blind가 비어 partial=false가 되어, 남은 구간이 화면에서 통째로 사라진 채
        // "일부 구간 타임스탬프 없음" 경고도 뜨지 않는다.
        blind: [
          ...blind,
          ...allChunks.slice(chunkSegments.length).map((c) => ({ start: c.start, end: c.end })),
        ],
        // 통화 길이는 디코딩으로 이미 알고 있다 — 서버에 물을 필요가 없다.
        // **시도한 마지막 청크의 끝이 아니라 파일 전체의 끝**을 쓴다. 전자를 쓰면
        // 20분 통화가 12번째 청크에서 레이트리밋에 걸렸을 때 화면이 "통화 길이 10:05"를
        // 표시한다 — 남은 9분이 존재 자체로 사라지고, 그 사실을 말하는 경고도 뜨지 않는다.
        // 돌리지 못한 구간은 아래에서 blind로 넘겨 "모르는 시간"으로 남긴다.
        duration: totalSec ?? (chunkSegments.length ? chunkSegments[chunkSegments.length - 1].end : null),
        notice: [leadNote, note].filter(Boolean).join(' ') || undefined,
      })
      requestAnimationFrame(() => revealElement(resultRef.current))
      return true
    }
    try {
      setChunkNote('긴 녹취를 디코딩·분할하고 있어요 (16kHz 모노 리샘플)...')
      const chunks = await chunkAudioFile(theFile)
      chunkCount = chunks.length
      // 파일 전체 길이 — 중단되더라도 이 값은 변하지 않는다
      totalSec = chunks.length ? chunks[chunks.length - 1].end : null
      allChunks = chunks
      for (let i = 0; i < chunks.length; i++) {
        setChunkNote(`청크 ${i + 1}/${chunks.length} 전사 중 (${Math.round(chunks[i].start)}~${Math.round(chunks[i].end)}초)...`)
        const r = await postJson('/api/cc/stt', { audio_b64: bufferToB64(chunks[i].wav) })
        if (r.demo) demoChunks += 1
        texts.push((r.text || '').trim())
        // 시도한 청크는 전사 성공 여부와 관계없이 모두 기록한다. 타임스탬프를 못 받은
        // 청크(데모 응답 등)의 시간은 "조용했다"가 아니라 "모른다"로 다뤄야 하고,
        // 그러려면 그 청크가 통화의 어느 구간이었는지가 남아 있어야 한다.
        chunkSegments.push({ start: chunks[i].start, end: chunks[i].end, segments: r.segments ?? null })
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
      // 단발 호출 한도를 넘는 긴 녹취는 오류가 아니라 분할 전사로 자동 전환한다.
      // 판정 기준을 서버 한도에서 끌어오므로(needsChunking), 예전처럼 4MB 파일을
      // 단발로 보낼 수 있는데도 6청크로 쪼개 유료 호출을 6번 쓰는 일이 없다.
      //
      // 비교 모드는 크기(2MB)로만 걸러진다. 길이 기준이 생긴 뒤로는 2MB 안에서도
      // 5분을 넘는 저비트레이트 파일(48kbps 2MB ≈ 6분)이 분할 경로로 들어올 수 있는데,
      // transcribeLong은 비교를 하지 않으므로 체크박스는 켜진 채 비교표만 조용히
      // 사라진다. 사라지게 두지 말고 무엇이 생략됐는지 알린다.
      if (needsChunking(theFile.size, durationSec)) {
        if (withCompare) {
          setCompare(false)
          setError(
            `길이가 길어 분할 전사로 진행합니다 (약 ${formatDuration(durationSec) || '5분 초과'}). ` +
              '2종 모델 비교는 5분 이하 음성에서만 가능해 이번에는 생략했습니다.'
          )
        }
        await transcribeLong(theFile)
        return
      }
      setLoading(true)
      setError('')
      setAltResult(null)
      try {
        const audio_b64 = await fileToBase64(theFile)
        // 비교는 한 요청으로 처리한다 — 예전에는 같은 base64를 두 번 올려 대역폭이
        // 두 배였고 시간당 예산도 2슬롯을 먹었다. compare 필드가 없으면 서버는
        // 예전과 똑같이 동작한다(다른 화면 하위 호환).
        const data = await postJson('/api/cc/stt', withCompare ? { audio_b64, compare: true } : { audio_b64 })
        setResult({ ...data, plainText: data.text })
        requestAnimationFrame(() => revealElement(resultRef.current))
        if (withCompare) {
          if (data.alt?.text) setAltResult(data.alt)
          else if (data.alt?.error) setAltResult({ failed: true, notice: data.alt.error })
          // alt 자리가 아예 없는 응답은 서버가 이유를 notice로 설명한 경우다(주 모델 실패 등).
          // 거기에 "비교 실패"를 덧붙이면 같은 사실을 서로 다른 말로 두 번 알리게 된다.
          else setAltResult(data.notice ? null : { failed: true, notice: '비교 모델 전사 결과를 받지 못했습니다.' })
        }
      } catch (err) {
        // 크기는 한도 안이지만 너무 길어 50초 타임아웃에 걸리는 파일이 있다.
        // 그때 오류만 남기면 "분할하면 성공하는 파일"을 실패로 끝내는 셈이라,
        // 길이·지연 계열 실패에 한해 분할 전사로 한 번 더 시도한다.
        if (!withCompare && RETRY_AS_CHUNKED.test(err.message)) {
          await transcribeLong(theFile, `단발 전사가 실패해 분할 전사로 다시 처리했습니다. (${err.message})`)
          return
        }
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
  // 구간을 눌렀을 때 그 지점부터 재생한다. 오디오가 없으면(텍스트 탭) 아무 일도 하지 않는다.
  function seekTo(sec, index) {
    setActiveSeg(index)
    const el = audioRef.current
    if (!el) return
    el.currentTime = Math.max(0, Number(sec) || 0)
    el.play?.().catch(() => {
      // 자동재생이 막힌 브라우저 — 위치만 옮겨두면 사용자가 재생 버튼을 누르면 된다
    })
  }

  // 화자 라벨 교정. 고친 결과로 시간 지표가 즉시 다시 계산된다(SegmentTimeline이 파생 계산).
  function fixSpeaker(index, speaker) {
    setResult((prev) => (prev?.segments ? { ...prev, segments: setSpeaker(prev.segments, index, speaker) } : prev))
  }

  async function diarize() {
    const base = result?.text?.trim()
    if (!base) return
    setDiarizing(true)
    setError('')
    try {
      // 화자 분리도 네트워크를 타는 경로다 — 개인정보를 가린 뒤에 보낸다
      const data = await postJson('/api/cc/diarize', { transcript: maskPii(base).text })
      // 서버는 6000자까지만 처리한다. 잘린 뒷부분을 원문 그대로 이어 붙여야
      // 화자 분리 한 번에 긴 전사의 뒷부분이 소실되지 않는다.
      const tail = data.truncated ? base.slice(data.processed_chars) : ''
      const merged = tail ? `${data.formatted}\n${tail}` : data.formatted
      // 함수형 업데이트 — 응답을 기다리는 동안 사용자가 전사를 고쳤을 수 있다.
      // 화자 분리 결과를 구간에도 얹는다 — 구간에 화자가 붙어야 발화 비율·응답 지연을
      // 시간으로 잴 수 있다. 줄 수가 구간 수와 다르면 남는 구간은 비워 둔다(틀린 라벨보다 낫다).
      setResult((prev) => ({
        ...prev,
        text: merged,
        plainText: prev.plainText ?? prev.text,
        segments: prev.segments ? assignSpeakers(prev.segments, merged) : prev.segments,
      }))
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
    // 원문이 아니라 "가리고 보정한" 텍스트를 넘긴다
    sessionStorage.setItem('cc-transcript', outbound)
    navigate('/analyze')
  }

  // 탭 사이 좌우 이동 — ARIA 탭 패턴에서 탭들은 하나의 정지점이고 방향키로 옮겨간다.
  // roving tabindex(선택된 탭만 0)와 짝을 맞춰야 Tab 키가 탭 개수만큼 멈추지 않는다.
  function onTabKeyDown(e) {
    const ids = TABS.map((t) => t.id)
    const i = ids.indexOf(tab)
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? ids[(i + 1) % ids.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? ids[(i - 1 + ids.length) % ids.length]
          : e.key === 'Home'
            ? ids[0]
            : e.key === 'End'
              ? ids[ids.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    setTab(next)
    // 포커스를 따라 옮겨야 스크린리더가 새 탭을 읽는다. 렌더 뒤에 옮긴다.
    requestAnimationFrame(() => tabRefs.current[next]?.focus())
  }

  // 업로드 전에 처리 방식을 미리 알린다 (조용한 절단·예상 밖의 유료 호출 방지)
  const uploadPlan = useMemo(
    () =>
      file
        ? describeUpload({ bytes: file.size, durationSec, maxUploadBytes: MAX_UPLOAD_BYTES })
        : null,
    [file, durationSec]
  )

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

      <div className="tab-row" role="tablist" aria-label="전사 입력 방식">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`stt-tab-${t.id}`}
            // 패널과의 연결을 명시한다 — 예전에는 role만 있어서 스크린리더가
            // "탭"이라고만 읽고 어느 영역을 제어하는지 알려주지 못했다.
            // 선택된 탭에만 붙인다: 비활성 패널은 렌더되지 않으므로 없는 id를 가리키면
            // 검사 도구가 잘못된 aria 값으로 잡고, 보조기술도 얻는 게 없다.
            aria-controls={tab === t.id ? `stt-panel-${t.id}` : undefined}
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            ref={(el) => {
              tabRefs.current[t.id] = el
            }}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
            onKeyDown={onTabKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="tool-layout">
        {tab === 'file' ? (
          <form
            className="tool-form"
            onSubmit={transcribe}
            role="tabpanel"
            id="stt-panel-file"
            aria-labelledby="stt-tab-file"
          >
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
              또는 음성 파일 선택 (mp3/wav/m4a/ogg · {SINGLE_SHOT_MAX_MB}MB 또는 {SINGLE_SHOT_MAX_MIN}분을
              넘는 녹취는 자동 분할 전사, 최대 약 {CHUNK_LIMIT_MIN}분)
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
            {file && uploadPlan && (
              <>
                {/* 크기·길이·처리 방식(유료 호출 몇 회)을 보내기 전에 알려준다.
                    예전에는 서버가 조용히 자르거나 6청크로 쪼개는 것을 전사가 끝난 뒤에야 알 수 있었다. */}
                <p className="batch-meta">
                  <span className={uploadPlan.blocked ? 'batch-count' : 'batch-count ok'}>
                    {file.name} · {uploadPlan.sizeText}
                    {uploadPlan.durationText ? ` · ${uploadPlan.durationText}` : ''}
                  </span>
                  <span className="usage-note">{uploadPlan.detail}</span>
                </p>
                {compare && file.size > MAX_COMPARE_BYTES && (
                  <p className="batch-meta">
                    <span className="usage-note">
                      모델 비교는 {toMb(MAX_COMPARE_BYTES, 0)}MB 이하만 가능합니다 — 비교를 끄거나 짧은
                      음성으로 시연해주세요.
                    </span>
                  </p>
                )}
                {audioUrl && (
                  <audio
                    ref={audioRef}
                    controls
                    src={audioUrl}
                    className="stt-audio"
                    // 브라우저가 미리듣기용으로 이미 읽는 메타데이터에서 길이를 받는다 —
                    // 추가 디코딩 비용 없이 분할 여부·청크 수를 정확히 안내할 수 있다.
                    onLoadedMetadata={(e) => {
                      const d = e.currentTarget.duration
                      setDurationSec(Number.isFinite(d) && d > 0 ? d : null)
                    }}
                  />
                )}
              </>
            )}
            <label className="channel-check compare-check">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
              Whisper 2종 모델 비교 (large-v3-turbo vs whisper · 2MB 이하 짧은 음성)
            </label>
            <button
              type="submit"
              className="btn-primary"
              disabled={loading || recorder.recording}
              aria-busy={loading}
            >
              {loading ? '전사 중... (10~30초)' : compare ? '2종 모델로 전사·비교하기' : 'Whisper로 전사하기'}
            </button>
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
        ) : (
          <form
            className="tool-form"
            onSubmit={(e) => e.preventDefault()}
            role="tabpanel"
            id="stt-panel-text"
            aria-labelledby="stt-tab-text"
          >
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
              {/* 무엇을 가렸는지 말해주지 않으면 마스킹이 도는지도, 과검출인지도 알 수 없다 */}
              {/* 시간으로만 잴 수 있는 지표 — 화자 라벨이 없어도 나온다.
                  타임스탬프가 없으면(데모·구형 응답) 계산하지 않고 그 사실을 대신 말한다. */}
              {timeline ? (
                <section className="seg-block">
                  {/* 데모 응답에도 구간 시각이 실려 온다(stt.js DEMO_SEGMENTS). 그것을
                      '실측'이라고 적으면, 예시용으로 적어 넣은 4.2초 간격이 실제로 잰 침묵으로
                      읽힌다 — 계산할 수 없는 것을 보여주지 않는다는 원칙과 정면으로 부딪힌다.
                      숨기지 않고 무엇을 근거로 잰 값인지를 정확히 밝힌다. */}
                  <h2>통화 시간 지표 — {result.demo ? '예시 구간 시각 기준' : '타임스탬프 실측'}</h2>
                  <p className="result-empty-sub">
                    {result.demo
                      ? '예시 전사에 함께 들어 있는 구간 시각으로 계산한 시연값입니다 — 실제 음성을 잰 값이 아닙니다. 배포 환경에서 음성을 올리면 Whisper가 돌려준 실제 시각으로 같은 지표가 계산됩니다.'
                      : '글자 수로 추정한 값이 아니라 Whisper가 구간마다 돌려준 시작·끝 시각으로 잰 값입니다. 화자 라벨이 없어도 계산됩니다.'}
                    {timeline.partial &&
                      ` 일부 구간(${timeline.blindSec}초)은 시간 정보를 받지 못해 제외했고, 아래 수치는 관측된 ${timeline.coveredSec}초 기준입니다.`}
                  </p>
                  <div className="stat-row">
                    <div className="stat-tile">
                      <span className="stat-label">통화 길이</span>
                      <span className="stat-value">{formatClock(timeline.callSec)}</span>
                    </div>
                    <div className="stat-tile">
                      <span className="stat-label">실제 발화 시간</span>
                      <span className="stat-value">
                        {formatClock(timeline.speechSec)}
                        {timeline.speechRatio != null && ` · ${timeline.speechRatio}%`}
                      </span>
                    </div>
                    <div className="stat-tile">
                      <span className="stat-label">{SILENCE_MIN_SEC}초 이상 침묵 (횟수 · 최장)</span>
                      <span className="stat-value">
                        {timeline.silenceCount}회 · {timeline.longestSilenceSec}초
                      </span>
                    </div>
                    <div className="stat-tile">
                      <span className="stat-label">발화 속도 (분당 글자)</span>
                      <span className="stat-value">
                        {timeline.charsPerMin == null ? '—' : `${timeline.charsPerMin}자`}
                      </span>
                    </div>
                  </div>

                  {/* 합계만 주면 어디를 다시 들어야 할지 알 수 없어 결국 통화 전체를 듣게 된다.
                      침묵이 시작된 시각을 눌러 그 지점부터 재생한다. */}
                  {timeline.silences.length > 0 && (
                    <>
                      <p className="result-empty-sub">
                        고객을 기다리게 한 구간 — 시각을 누르면 그 지점부터 들을 수 있습니다.
                      </p>
                      <div className="chip-row">
                        {timeline.silences.map((s) => (
                          <button
                            key={s.start}
                            type="button"
                            className="preset-chip"
                            onClick={() => seekTo(s.start, -1)}
                            title="이 침묵이 시작된 지점부터 재생"
                          >
                            {formatClock(s.start)}에서 {s.sec}초
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  <ul className="plain-list">
                    {timeDiagnosis.map((d) => (
                      <li key={d.id}>
                        <strong>
                          {d.level === 'warn' ? '⚠ ' : d.level === 'ok' ? '✓ ' : 'ℹ '}
                          {d.label}
                        </strong>{' '}
                        — {d.detail}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : (
                // 계산할 수 없는 것을 0으로 보여주지 않는다 — 왜 못 하는지를 말한다.
                <ResultNotice
                  // 데모 분기를 따로 두지 않는다 — 서버는 데모 응답에도 구간을 주므로
                  // 그 분기는 도달할 수 없었고, 도달하지 못하는 문구는 검증되지 않는다.
                  text="이 응답에는 구간 타임스탬프가 없어 시간 지표를 계산하지 않았습니다. 대화 균형은 아래 글자 수 기반 지표로만 볼 수 있습니다."
                />
              )}
              {/* 시간이 붙은 구간 — 평문 전사로는 할 수 없던 것들이 여기서 가능해진다 */}
              <SegmentTimeline
                segments={result?.segments}
                activeIndex={activeSeg}
                onSeek={seekTo}
                onSpeakerChange={fixSpeaker}
              />
              {masked.total > 0 && (
                <div className="pii-box">
                  <strong>🔒 개인정보 자동 마스킹 {masked.total}건</strong>
                  <p>{maskNotice(masked)}</p>
                  <p className="result-empty-sub">
                    가려진 자리는 자릿수를 그대로 유지하므로(940101-1******) CER 측정과 사전 보정이
                    같은 텍스트 위에서 계속 동작합니다. 음성을 글자로 바꾸는 단계는 서버가 처리하지만
                    저장하지 않으며, 그 이후의 분석·평가·이관·저장은 모두 가려진 텍스트로 진행됩니다.
                  </p>
                </div>
              )}
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
                        <td>{latencyText(result?.latency, result?.demo)}</td>
                      </tr>
                      <tr>
                        <td>whisper (base)</td>
                        <td className="req-name">{(altCer.cer * 100).toFixed(1)}%</td>
                        <td>{(altCer.accuracy * 100).toFixed(1)}%</td>
                        <td>{latencyText(altResult.latency, altResult.demo)}</td>
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
