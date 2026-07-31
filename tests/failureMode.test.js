import { describe, it, expect } from 'vitest'
import { failureMode } from '../functions/_lib/telemetry.js'
import {
  isFallbackMode,
  failureLabel,
  summarizeStats,
  FAILURE_LABEL,
} from '../src/lib/statsSummary.js'

// 시스템이 "왜 실패했는지"를 알면서 기록하지 않던 것을 남기기 시작했다.
// 이 테스트가 지키는 것은 두 가지다:
//   ① 사유가 붙어도 폴백은 여전히 폴백으로 세어진다 (개선이 퇴행처럼 보이면 안 된다)
//   ② mode 문자열이 D1·화면 라벨 키로 안전한 형태를 유지한다

describe('failureMode — 실패 원인 분류', () => {
  it('claude.js가 붙인 code를 사유가 담긴 mode로 바꾼다', () => {
    const cases = [
      ['refusal', 'fallback-refusal'],
      ['max_tokens', 'fallback-max-tokens'],
      ['deadline', 'fallback-deadline'],
      ['timeout', 'fallback-timeout'],
      ['http', 'fallback-http'],
      ['no_key', 'fallback-no-key'],
    ]
    for (const [code, expected] of cases) {
      const err = new Error('x')
      err.code = code
      expect(failureMode(err)).toBe(expected)
    }
  })

  it('계약 위반은 code가 없어도 메시지로 알아본다', () => {
    expect(failureMode(new Error('AI 응답에서 결과를 찾을 수 없습니다.'))).toBe('fallback-contract')
  })

  it('모르는 실패는 분류하지 않고 fallback으로 둔다 (아는 척하지 않는다)', () => {
    expect(failureMode(new Error('알 수 없는 오류'))).toBe('fallback')
    expect(failureMode(null)).toBe('fallback')
    expect(failureMode(undefined)).toBe('fallback')
  })

  it('임의의 code를 그대로 mode에 싣지 않는다 (저장·라벨 키 오염 방지)', () => {
    const err = new Error('x')
    err.code = 'DROP TABLE; 한글'
    expect(failureMode(err)).toBe('fallback')
  })

  it('만들어지는 mode는 소문자·숫자·하이픈만 쓴다', () => {
    for (const code of ['refusal', 'max_tokens', 'deadline', 'timeout', 'http', 'no_key']) {
      const err = new Error('x')
      err.code = code
      expect(failureMode(err)).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('분류된 모든 mode에 화면 라벨이 있다', () => {
    for (const code of ['refusal', 'max_tokens', 'deadline', 'timeout', 'http', 'no_key']) {
      const err = new Error('x')
      err.code = code
      expect(FAILURE_LABEL[failureMode(err)]).toBeTruthy()
    }
    expect(FAILURE_LABEL['fallback-contract']).toBeTruthy()
  })
})

describe('집계가 사유 붙은 폴백을 놓치지 않는다', () => {
  it('fallback-* 도 폴백으로 센다', () => {
    expect(isFallbackMode('fallback')).toBe(true)
    expect(isFallbackMode('fallback-refusal')).toBe(true)
    expect(isFallbackMode('live')).toBe(false)
    expect(isFallbackMode('guarded')).toBe(false)
    expect(isFallbackMode(null)).toBe(false)
  })

  it('사유별로 나눠 세고 합계는 그대로 유지한다', () => {
    const rows = [
      { endpoint: 'analyze', mode: 'live', calls: 10 },
      { endpoint: 'analyze', mode: 'fallback-refusal', calls: 2 },
      { endpoint: 'diarize', mode: 'fallback-max-tokens', calls: 3 },
      { endpoint: 'qa', mode: 'fallback', calls: 1 },
    ]
    const s = summarizeStats(rows)
    expect(s.fallbackCalls).toBe(6)
    expect(s.classifiedFailures).toBe(5)
    expect(s.failures[0]).toMatchObject({ mode: 'fallback-max-tokens', calls: 3, classified: true })
    expect(s.failures.find((f) => f.mode === 'fallback').classified).toBe(false)
  })

  it('폴백이 없으면 빈 목록이다', () => {
    const s = summarizeStats([{ endpoint: 'analyze', mode: 'live', calls: 5 }])
    expect(s.failures).toEqual([])
    expect(s.classifiedFailures).toBe(0)
  })

  it('라벨이 없는 mode는 mode 문자열을 그대로 보여준다', () => {
    expect(failureLabel('fallback-refusal')).toBe('AI 안전 정책 거절')
    expect(failureLabel('fallback-unknown-x')).toBe('fallback-unknown-x')
  })

  it('사유가 붙어도 라이브 비율 계산은 흔들리지 않는다', () => {
    const s = summarizeStats([
      { endpoint: 'analyze', mode: 'live', calls: 3 },
      { endpoint: 'analyze', mode: 'fallback-deadline', calls: 1 },
    ])
    expect(s.total).toBe(4)
    expect(s.liveRatio).toBe(75)
  })
})
