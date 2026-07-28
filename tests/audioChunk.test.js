import { describe, it, expect } from 'vitest'
import { planChunks, encodeWav } from '../src/lib/audioChunk.js'

describe('planChunks (장시간 녹취 분할 계획)', () => {
  it('55초 단위로 나누고 마지막 청크는 남은 길이만큼이다', () => {
    const plan = planChunks(130, 55)
    expect(plan).toEqual([
      { start: 0, end: 55 },
      { start: 55, end: 110 },
      { start: 110, end: 130 },
    ])
  })

  it('청크보다 짧으면 1개, 0·음수·NaN이면 빈 배열이다', () => {
    expect(planChunks(30, 55)).toEqual([{ start: 0, end: 30 }])
    expect(planChunks(0)).toEqual([])
    expect(planChunks(-5)).toEqual([])
    expect(planChunks(NaN)).toEqual([])
  })
})

describe('encodeWav (16bit PCM 모노 인코딩)', () => {
  it('표준 WAV 헤더를 만든다', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000)
    const v = new DataView(buf)
    const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n))
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 4)).toBe('WAVE')
    expect(str(36, 4)).toBe('data')
    expect(v.getUint32(24, true)).toBe(16000) // 샘플레이트
    expect(v.getUint16(22, true)).toBe(1) // 모노
    expect(v.getUint16(34, true)).toBe(16) // 16bit
    expect(v.getUint32(40, true)).toBe(8) // 샘플 4개 × 2바이트
    expect(buf.byteLength).toBe(44 + 8)
  })

  it('샘플을 16bit 정수로 클리핑해 담는다', () => {
    const buf = encodeWav(new Float32Array([1, -1, 2, -2]), 16000)
    const v = new DataView(buf)
    expect(v.getInt16(44, true)).toBe(0x7fff)
    expect(v.getInt16(46, true)).toBe(-0x8000)
    expect(v.getInt16(48, true)).toBe(0x7fff) // 클리핑
    expect(v.getInt16(50, true)).toBe(-0x8000) // 클리핑
  })
})
