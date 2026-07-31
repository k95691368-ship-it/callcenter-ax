import { describe, it, expect, vi } from 'vitest'
import {
  b64Length,
  needsChunking,
  describeUpload,
  planChunks,
  toMb,
  formatDuration,
  SERVER_MAX_B64_LENGTH,
  SINGLE_SHOT_MAX_BYTES,
  SINGLE_SHOT_MAX_SECONDS,
  CHUNK_SECONDS,
  MAX_CHUNKS,
} from '../src/lib/audioChunk.js'
import { onRequestPost, b64ToByteArray, MAX_B64_LENGTH } from '../functions/api/cc/stt.js'

// 감사에서 드러난 STT 파이프라인 결함들의 회귀 테스트.
// (DOM 없이 검증 가능한 순수 계산 + 서버 응답 계약)

const MB = 1024 * 1024

describe('분할 임계값 — 서버 한도와 한 곳에서 맞춘다', () => {
  it('프론트 상수가 서버 한도와 같다 (한쪽만 바뀌면 여기서 깨진다)', () => {
    expect(SERVER_MAX_B64_LENGTH).toBe(MAX_B64_LENGTH)
  })

  it('단발 상한을 base64로 부풀려도 서버 한도를 넘지 않는다 (413 헛업로드 방지)', () => {
    expect(b64Length(SINGLE_SHOT_MAX_BYTES)).toBeLessThanOrEqual(MAX_B64_LENGTH)
    // 여유가 있더라도 4MB 시절처럼 크게 남기지는 않는다 (유료 호출 낭비의 원인)
    expect(SINGLE_SHOT_MAX_BYTES).toBeGreaterThan(5 * MB)
  })

  it('base64 길이 계산은 팽창률 4/3과 패딩을 반영한다', () => {
    expect(b64Length(3)).toBe(4)
    expect(b64Length(4)).toBe(8) // 패딩 포함
    expect(b64Length(0)).toBe(0)
    expect(b64Length(-1)).toBe(0)
  })
})

describe('needsChunking — 4MB~6MB가 불필요하게 6청크로 쪼개지지 않는다', () => {
  it('예전 임계값(4MB)에 걸렸던 5MB 파일은 단발 1회로 간다', () => {
    expect(needsChunking(4 * MB)).toBe(false)
    expect(needsChunking(5 * MB)).toBe(false)
  })

  it('서버 한도를 넘는 크기는 분할한다', () => {
    expect(needsChunking(SINGLE_SHOT_MAX_BYTES)).toBe(false)
    expect(needsChunking(SINGLE_SHOT_MAX_BYTES + 1)).toBe(true)
    expect(needsChunking(7 * MB)).toBe(true)
  })

  it('크기가 작아도 너무 길면 분할한다 (50초 타임아웃에 걸리는 저비트레이트 파일)', () => {
    expect(needsChunking(2 * MB, SINGLE_SHOT_MAX_SECONDS + 1)).toBe(true)
    expect(needsChunking(2 * MB, SINGLE_SHOT_MAX_SECONDS)).toBe(false)
  })

  it('길이를 아직 모르면(null) 크기만으로 판단한다', () => {
    expect(needsChunking(2 * MB, null)).toBe(false)
    expect(needsChunking(0)).toBe(false)
  })
})

describe('describeUpload — 업로드 전에 처리 방식·유료 호출 수를 알린다', () => {
  it('단발 경로는 1회로 처리된다고 알린다', () => {
    const p = describeUpload({ bytes: 5 * MB, durationSec: 300, maxUploadBytes: 40 * MB })
    expect(p.mode).toBe('single')
    expect(p.calls).toBe(1)
    expect(p.blocked).toBe(false)
    expect(p.sizeText).toBe('5.00MB')
    expect(p.durationText).toBe('5분 0초')
    expect(p.detail).toContain('단발 전사 1회')
  })

  it('분할 경로는 청크 수와 호출 횟수를 숫자로 알린다', () => {
    const p = describeUpload({ bytes: 10 * MB, durationSec: 600, maxUploadBytes: 40 * MB })
    expect(p.mode).toBe('chunked')
    expect(p.chunks).toBe(planChunks(600).length)
    expect(p.calls).toBe(p.chunks)
    expect(p.detail).toContain(`${p.chunks}청크`)
    expect(p.detail).toContain(`호출 ${p.chunks}회`)
  })

  it('길이를 모르면 청크 수를 지어내지 않는다', () => {
    const p = describeUpload({ bytes: 10 * MB, maxUploadBytes: 40 * MB })
    expect(p.mode).toBe('chunked')
    expect(p.chunks).toBe(0)
    expect(p.detail).toContain('디코딩 후 확정')
  })

  it('업로드 상한과 길이 상한 초과는 미리 막을 수 있게 blocked로 알린다', () => {
    const tooLarge = describeUpload({ bytes: 50 * MB, maxUploadBytes: 40 * MB })
    expect(tooLarge.mode).toBe('too-large')
    expect(tooLarge.blocked).toBe(true)
    expect(tooLarge.calls).toBe(0)

    const tooLong = describeUpload({
      bytes: 10 * MB,
      durationSec: MAX_CHUNKS * CHUNK_SECONDS + 1,
      maxUploadBytes: 40 * MB,
    })
    expect(tooLong.mode).toBe('too-long')
    expect(tooLong.blocked).toBe(true)
    expect(tooLong.detail).toContain(`청크 ${MAX_CHUNKS}개`)
  })

  it('파일이 없을 때(0바이트)도 계산이 터지지 않는다', () => {
    const p = describeUpload({})
    expect(p.sizeText).toBe('0.00MB')
    expect(p.durationText).toBe('')
  })
})

describe('표시 계산', () => {
  it('MB 표기는 소수 자리를 지정할 수 있다', () => {
    expect(toMb(2 * MB, 0)).toBe('2')
    expect(toMb(1536 * 1024)).toBe('1.5')
    expect(toMb(-1)).toBe('0.0')
  })

  it('길이 표기는 분·초로 나눈다', () => {
    expect(formatDuration(59)).toBe('59초')
    expect(formatDuration(125)).toBe('2분 5초')
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(NaN)).toBe('')
  })
})

describe('b64ToByteArray — base 모델 입력 변환', () => {
  it('예전 구현(atob → Uint8Array → 스프레드)과 같은 값을 만든다', () => {
    // btoa는 Latin-1만 받으므로 바이트 값을 직접 만든다 (실제 입력도 오디오 바이트다)
    const b64 = btoa(String.fromCharCode(0, 1, 127, 128, 200, 255, 65))
    const bin = atob(b64)
    const old = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) old[i] = bin.charCodeAt(i)
    expect(b64ToByteArray(b64)).toEqual([...old])
  })

  it('모델이 요구하는 일반 배열을 준다 (Uint8Array가 아니다)', () => {
    const out = b64ToByteArray(btoa('abc'))
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([97, 98, 99])
  })
})

// ===== 서버 응답 계약 =====
// PipelinePage(수정 금지)가 보내는 요청과 읽는 필드가 그대로 살아 있어야 한다.

// readJsonBody는 Content-Length가 있으면 text()로 본문을 읽는다 (스트림 상한 검사 경로)
function ctx(body, env = {}) {
  const text = JSON.stringify(body)
  const headers = { 'content-length': String(new TextEncoder().encode(text).byteLength) }
  return {
    request: {
      text: async () => text,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    },
    env,
  }
}
const AUDIO = btoa('fake-audio-bytes')

describe('/api/cc/stt 응답 계약', () => {
  it('데모 응답에 latency가 있다 (없으면 화면이 모델명만 표시하고 지연 칸이 비었다)', async () => {
    const res = await onRequestPost(ctx({ audio_b64: AUDIO }))
    const data = await res.json()
    expect(data.demo).toBe(true)
    expect(typeof data.latency).toBe('number')
    expect(data.latency).toBeGreaterThanOrEqual(0)
    expect(data.text).toContain('한빛텔레콤')
    expect(data.model).toContain('whisper')
    expect(data.notice).toBeTruthy()
    expect(data.alt).toBeUndefined() // compare를 안 보냈으면 예전 모양 그대로
  })

  it('예전 요청({audio_b64})은 예전 필드를 그대로 받는다 (PipelinePage 하위 호환)', async () => {
    const run = vi.fn(async () => ({ text: ' 전사 결과 ' }))
    const res = await onRequestPost(ctx({ audio_b64: AUDIO }, { AI: { run } }))
    const data = await res.json()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toContain('turbo')
    expect(typeof run.mock.calls[0][1].audio).toBe('string') // turbo는 base64 문자열
    expect(data).toMatchObject({ demo: false, text: '전사 결과' })
    expect(typeof data.latency).toBe('number')
    expect(data.alt).toBeUndefined()
  })

  it('compare:true 한 번으로 2종 모델을 전사한다 (예전엔 같은 오디오를 2회 업로드했다)', async () => {
    const run = vi.fn(async (model) => ({ text: model.includes('turbo') ? 'turbo 전사' : 'base 전사' }))
    const res = await onRequestPost(ctx({ audio_b64: AUDIO, compare: true }, { AI: { run } }))
    const data = await res.json()
    expect(run).toHaveBeenCalledTimes(2)
    expect(data.text).toBe('turbo 전사')
    expect(data.alt.text).toBe('base 전사')
    expect(data.alt.model).toBe('@cf/openai/whisper')
    expect(typeof data.alt.latency).toBe('number')
    // base 모델은 정수 배열을 받아야 한다
    const baseCall = run.mock.calls.find((c) => !c[0].includes('turbo'))
    expect(Array.isArray(baseCall[1].audio)).toBe(true)
  })

  it('비교 모델만 실패하면 주 전사는 살린다', async () => {
    const run = vi.fn(async (model) => {
      if (!model.includes('turbo')) throw new Error('모델 과부하')
      return { text: 'turbo 전사' }
    })
    const res = await onRequestPost(ctx({ audio_b64: AUDIO, compare: true }, { AI: { run } }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.text).toBe('turbo 전사')
    expect(data.alt.error).toContain('모델 과부하')
    expect(data.alt.text).toBeUndefined()
  })

  it('주 모델만 실패하면 값을 치른 대조 모델 결과를 버리지 않는다', async () => {
    const run = vi.fn(async (model) => {
      if (model.includes('turbo')) throw new Error('turbo 과부하')
      return { text: 'base 전사' }
    })
    const res = await onRequestPost(ctx({ audio_b64: AUDIO, compare: true }, { AI: { run } }))
    const data = await res.json()
    expect(res.status).toBe(200)
    expect(data.text).toBe('base 전사')
    expect(data.model).toBe('@cf/openai/whisper')
    expect(data.notice).toContain('turbo 과부하')
  })

  it('주 모델이 실패하면 502로 알린다', async () => {
    const run = vi.fn(async () => ({ text: '' }))
    const res = await onRequestPost(ctx({ audio_b64: AUDIO }, { AI: { run } }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('전사에 실패했습니다')
  })

  it('데모에서도 비교 자리를 채운다 (안 채우면 비교표가 나타나지 않는다)', async () => {
    const res = await onRequestPost(ctx({ audio_b64: AUDIO, compare: true }))
    const data = await res.json()
    expect(data.alt.text).toBe(data.text)
    expect(data.alt.demo).toBe(true)
    expect(typeof data.alt.latency).toBe('number')
  })

  it('길이 상한을 넘는 입력은 413으로 거절한다 (조용히 자르지 않는다)', async () => {
    const res = await onRequestPost(ctx({ audio_b64: 'A'.repeat(MAX_B64_LENGTH + 1) }))
    expect(res.status).toBe(413)
  })

  it('비교 요청은 base 모델 한도(2MB급)를 넘으면 거절한다', async () => {
    const res = await onRequestPost(ctx({ audio_b64: 'A'.repeat(4_000_000), compare: true }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('모델 비교')
  })

  it('오디오가 없으면 400이다', async () => {
    const res = await onRequestPost(ctx({}))
    expect(res.status).toBe(400)
  })
})
