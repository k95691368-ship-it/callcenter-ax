// 장시간 녹취 분할 전사 — Whisper 단발 호출(6MB·수 분) 한계를 돌파하는 클라이언트 파이프라인.
// 브라우저에서 디코드 → 16kHz 모노 리샘플 → 청크 WAV 인코딩까지 처리하므로
// 서버·모델은 그대로 두고 입력 규모의 한계만 제거한다. (음성은 여전히 서버 미보관)

export const TARGET_RATE = 16000
export const CHUNK_SECONDS = 55
export const MAX_CHUNKS = 30 // 약 27분 — 시간당 전사 예산(30회) 안에서 완주 가능한 상한

// 전체 길이를 청크 경계 목록으로 나눈다 (순수 함수)
export function planChunks(durationSec, chunkSec = CHUNK_SECONDS) {
  if (!(durationSec > 0)) return []
  const n = Math.ceil(durationSec / chunkSec)
  return Array.from({ length: n }, (_, i) => ({
    start: i * chunkSec,
    end: Math.min((i + 1) * chunkSec, durationSec),
  }))
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
