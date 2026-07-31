// 장시간 녹취 분할 전사 — Whisper 단발 호출(6MB·수 분) 한계를 돌파하는 클라이언트 파이프라인.
// 브라우저에서 디코드 → 16kHz 모노 리샘플 → 청크 WAV 인코딩까지 처리하므로
// 서버·모델은 그대로 두고 입력 규모의 한계만 제거한다. (음성은 여전히 서버 미보관)

export const TARGET_RATE = 16000
export const CHUNK_SECONDS = 55
export const MAX_CHUNKS = 30 // 약 27분 — 시간당 전사 예산(30회) 안에서 완주 가능한 상한

// ===== 단발 호출 / 분할 전사 판정 =====
// 이 판정은 서버 한도와 한 곳에서 맞춰야 한다. 예전에는 화면이 4MB부터 분할했는데
// 서버(functions/api/cc/stt.js MAX_B64_LENGTH)는 base64 8.4M자(원본 약 6MB)까지 받았다.
// 그래서 5MB mp3(약 5분)가 단발 1회로 끝날 수 있는데도 6청크로 쪼개져 유료 전사 호출을
// 6번 쓰고, 시간당 IP 예산도 6칸을 먹었다. tests/sttPipeline.test.js가 두 상수의 불일치를 잡는다.
export const SERVER_MAX_B64_LENGTH = 8_400_000

// base64는 원본 3바이트를 4자로 늘리고 4의 배수로 패딩한다
export function b64Length(byteLength) {
  return byteLength > 0 ? 4 * Math.ceil(byteLength / 3) : 0
}

// 단발 호출로 보낼 수 있는 원본 크기 상한.
// 서버 한도를 원본 바이트로 환산(÷4×3)한 뒤 64KB를 뺀다 — 한도에 딱 붙여 보내면
// 계산 오차 하나로 6MB를 업로드하고 413만 받는(순수 낭비) 경우가 생긴다.
export const SINGLE_SHOT_MAX_BYTES = Math.floor(SERVER_MAX_B64_LENGTH / 4) * 3 - 64 * 1024

// 크기가 맞아도 너무 긴 음성은 나눠 보낸다. 서버의 Whisper 호출 타임아웃이 50초이고,
// 55초 청크가 그 안에 끝나는 것은 확인됐지만 6분짜리 한 방이 끝난다는 보장은 없다.
// 한 번에 실패해 전부 잃는 것보다 나눠 보내는 편이 낫다.
export const SINGLE_SHOT_MAX_SECONDS = 300

// 분할이 필요한지 — 길이는 알 수 있을 때만 본다(선택 직후에는 아직 모를 수 있다)
export function needsChunking(byteLength, durationSec = null) {
  if (!(byteLength > 0)) return false
  if (byteLength > SINGLE_SHOT_MAX_BYTES) return true
  return durationSec > 0 && durationSec > SINGLE_SHOT_MAX_SECONDS
}

export function toMb(bytes, digits = 1) {
  return (Math.max(0, bytes) / 1024 / 1024).toFixed(digits)
}

export function formatDuration(sec) {
  if (!(sec > 0)) return ''
  const total = Math.round(sec)
  const m = Math.floor(total / 60)
  return m > 0 ? `${m}분 ${total % 60}초` : `${total}초`
}

// 파일을 고른 직후 "이 파일이 어떻게 처리되는가"를 미리 알려주기 위한 계산 (순수 함수).
// 서버가 조용히 자르거나, 분할 전사가 유료 호출을 몇 번 쓰는지 전사가 끝난 뒤에야
// 알게 되던 것을 막는다.
export function describeUpload({
  bytes = 0,
  durationSec = null,
  maxUploadBytes = 0,
  chunkSec = CHUNK_SECONDS,
} = {}) {
  const sizeText = `${toMb(bytes, 2)}MB`
  const durationText = formatDuration(durationSec)
  const limitMin = Math.floor((MAX_CHUNKS * chunkSec) / 60)
  const base = { sizeText, durationText }

  if (maxUploadBytes > 0 && bytes > maxUploadBytes) {
    return {
      ...base,
      mode: 'too-large',
      chunks: 0,
      calls: 0,
      blocked: true,
      detail: `업로드 상한 ${toMb(maxUploadBytes, 0)}MB를 넘습니다 — 파일을 나눠 올려주세요`,
    }
  }
  if (durationSec > 0 && exceedsChunkLimit(durationSec, chunkSec)) {
    return {
      ...base,
      mode: 'too-long',
      chunks: 0,
      calls: 0,
      blocked: true,
      detail: `약 ${limitMin}분(청크 ${MAX_CHUNKS}개)까지 지원합니다 — 이 파일은 ${durationText}입니다`,
    }
  }
  if (!needsChunking(bytes, durationSec)) {
    return {
      ...base,
      mode: 'single',
      chunks: 1,
      calls: 1,
      blocked: false,
      detail: `단발 전사 1회로 처리됩니다 (한 번에 ${toMb(SINGLE_SHOT_MAX_BYTES)}MB · ${Math.floor(SINGLE_SHOT_MAX_SECONDS / 60)}분까지)`,
    }
  }
  // 길이를 모르면 청크 수를 셀 수 없다. 아는 척하는 숫자보다 "디코딩 후 확정"이 정직하다.
  const chunks = durationSec > 0 ? planChunks(durationSec, chunkSec).length : 0
  return {
    ...base,
    mode: 'chunked',
    chunks,
    calls: chunks,
    blocked: false,
    detail:
      chunks > 0
        ? `자동 분할 전사 — ${chunkSec}초씩 ${chunks}청크(전사 호출 ${chunks}회)로 나눠 보냅니다`
        : `자동 분할 전사 — ${chunkSec}초씩 나눠 보냅니다 (청크 수는 디코딩 후 확정)`,
  }
}

// 전체 길이를 청크 경계 목록으로 나눈다 (순수 함수)
// chunkSec을 검증하지 않으면 0에서 length: Infinity, 음수에서 조용한 빈 배열이 나온다.
export function planChunks(durationSec, chunkSec = CHUNK_SECONDS) {
  if (!(durationSec > 0) || !(chunkSec > 0)) return []
  const n = Math.min(Math.ceil(durationSec / chunkSec), MAX_CHUNKS)
  return Array.from({ length: n }, (_, i) => ({
    start: i * chunkSec,
    end: Math.min((i + 1) * chunkSec, durationSec),
  }))
}

// 상한을 넘는 길이인지 먼저 알려준다 (디코드·리샘플 비용을 치르기 전에 판단하기 위해)
export function exceedsChunkLimit(durationSec, chunkSec = CHUNK_SECONDS) {
  return durationSec > MAX_CHUNKS * chunkSec
}

// Float32 샘플을 16bit PCM 모노 WAV로 인코딩한다 (순수 함수)
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  writeStr(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  let o = 44
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

export function bufferToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP))
  }
  return btoa(bin)
}

// 브라우저 전용: 파일을 디코드해 16kHz 모노로 리샘플한 뒤 청크 WAV 목록으로 나눈다
export async function chunkAudioFile(file, { chunkSec = CHUNK_SECONDS } = {}) {
  const raw = await file.arrayBuffer()
  const Ctx = window.AudioContext || window.webkitAudioContext
  const probe = new Ctx()
  let decoded
  try {
    decoded = await probe.decodeAudioData(raw)
  } finally {
    probe.close()
  }
  // 길이 검사를 리샘플·인코딩 전에 한다. 예전에는 전체를 렌더하고 청크 WAV까지
  // 다 만든 뒤에 상한을 확인해서, 30분 파일 하나로 수백 MB를 할당한 다음
  // "지원하지 않는다"는 오류를 냈다.
  if (!(decoded.duration > 0)) {
    throw new Error('음성 길이가 0초입니다. 다른 파일을 선택해주세요.')
  }
  if (exceedsChunkLimit(decoded.duration, chunkSec)) {
    const limitMin = Math.floor((MAX_CHUNKS * chunkSec) / 60)
    throw new Error(`약 ${limitMin}분(청크 ${MAX_CHUNKS}개) 이하 녹취까지 지원합니다. 파일을 나눠 올려주세요.`)
  }
  const frames = Math.ceil(decoded.duration * TARGET_RATE)
  const off = new OfflineAudioContext(1, frames, TARGET_RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const mono = (await off.startRendering()).getChannelData(0)
  return planChunks(decoded.duration, chunkSec).map(({ start, end }) => ({
    start,
    end,
    wav: encodeWav(mono.subarray(Math.floor(start * TARGET_RATE), Math.floor(end * TARGET_RATE)), TARGET_RATE),
  }))
}
