import { describe, it, expect } from 'vitest'
import {
  toSegments,

  assignSpeakers,
  setSpeaker,
  timeMetrics,
  diagnoseTime,
  findSegment,
  formatTime,
  segmentsToText,
} from '../src/lib/segments.js'

// Whisper large-v3-turbo 응답 형태
const TURBO = {
  text: '...',
  segments: [
    { start: 0.0, end: 3.2, text: '안녕하세요 한빛텔레콤입니다' },
    { start: 3.6, end: 8.1, text: '인터넷이 자꾸 끊겨서요 벌써 세 번째예요' },
    { start: 16.0, end: 19.5, text: '단자함 노후가 원인으로 기록되어 있습니다' },
    { start: 20.0, end: 22.0, text: '이번엔 확실히 고쳐주세요' },
  ],
}
const LABELS = '상담사: a\n고객: b\n상담사: c\n고객: d'

describe('시간 정보를 살린다', () => {
  it('turbo의 segments를 그대로 쓴다', () => {
    expect(toSegments(TURBO)).toHaveLength(4)
    expect(toSegments(TURBO)[0]).toMatchObject({ start: 0, end: 3.2 })
  })

  it('base의 words는 발화 단위로 묶는다 (간격과 문장부호에서 끊는다)', () => {
    const segs = toSegments({
      words: [
        { word: '여보세요', start: 0, end: 0.6 },
        { word: '네', start: 0.7, end: 0.9 },
        { word: '요금이', start: 2.5, end: 3.0 },
        { word: '나왔죠?', start: 3.0, end: 3.4 },
        { word: '확인해', start: 3.6, end: 4.0 },
      ],
    })
    expect(segs).toHaveLength(3) // 간격(0.9→2.5)에서 한 번, 물음표에서 한 번
    expect(segs[0].text).toBe('여보세요 네')
  })

  it('시간 정보가 없으면 null — 0으로 채워 있는 척하지 않는다', () => {
    expect(toSegments({ text: '평문만 있는 전사' })).toBeNull()
    expect(toSegments(null)).toBeNull()
    expect(toSegments({ segments: [] })).toBeNull()
  })

  it('시각이 깨진 항목은 버린다 (NaN 좌표가 지표를 오염시킨다)', () => {
    const segs = toSegments({ segments: [{ start: 'x', end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }] })
    expect(segs).toHaveLength(1)
  })
})

describe('화자 배정과 교정', () => {
  it('화자 분리 결과를 구간에 순서대로 얹는다', () => {
    const s = assignSpeakers(toSegments(TURBO), LABELS)
    expect(s.map((x) => x.speaker)).toEqual(['agent', 'customer', 'agent', 'customer'])
  })

  it('줄 수가 모자라면 남는 구간은 비워 둔다 (틀린 라벨보다 낫다)', () => {
    const s = assignSpeakers(toSegments(TURBO), '상담사: a\n고객: b')
    expect(s[2].speaker).toBeNull()
    expect(s[3].speaker).toBeNull()
  })

  it('사람이 고친 구간은 교정 표시를 남긴다 (자동 판정과 구분해야 정확도를 속이지 않는다)', () => {
    const s = setSpeaker(assignSpeakers(toSegments(TURBO), LABELS), 0, 'customer')
    expect(s[0]).toMatchObject({ speaker: 'customer', corrected: true })
    expect(s[1].corrected).toBeUndefined()
  })
})

describe('시간으로만 잴 수 있는 지표', () => {
  const segs = assignSpeakers(toSegments(TURBO), LABELS)
  const m = timeMetrics(segs)

  it('통화 길이와 발화 시간을 실측한다', () => {
    expect(m.totalSec).toBe(22)
    expect(m.agentSec).toBeCloseTo(6.7, 1)
    expect(m.customerSec).toBeCloseTo(6.5, 1)
  })

  it('긴 무음을 잡는다 (8.1초 → 16.0초 사이 7.9초)', () => {
    expect(m.longestSilenceSec).toBeCloseTo(7.9, 1)
  })

  it('고객 발화 뒤 상담사 응답까지 걸린 시간을 잰다', () => {
    expect(m.maxResponseDelaySec).toBeCloseTo(7.9, 1)
  })

  it('화자 라벨이 없으면 비율을 만들지 않는다 (0%는 사실이 아니다)', () => {
    const bare = timeMetrics(toSegments(TURBO))
    expect(bare.agentRatio).toBeNull()
    expect(bare.totalSec).toBe(22)
  })

  it('구간이 하나뿐이면 지표를 내지 않는다', () => {
    expect(timeMetrics([{ start: 0, end: 1, text: 'a' }])).toBeNull()
    expect(timeMetrics([])).toBeNull()
    expect(timeMetrics(null)).toBeNull()
  })

  it('교정하면 지표가 다시 계산된다', () => {
    const fixed = setSpeaker(segs, 1, 'agent')
    expect(timeMetrics(fixed).agentSec).toBeGreaterThan(m.agentSec)
  })
})

describe('시간 진단', () => {
  it('긴 무음과 느린 응답을 사람 말로 알린다', () => {
    const d = diagnoseTime(timeMetrics(assignSpeakers(toSegments(TURBO), LABELS)))
    expect(d.some((x) => x.id === 'slow-response')).toBe(true)
    expect(d.every((x) => x.label && x.detail)).toBe(true)
  })

  it('문제가 없으면 그렇다고 말한다', () => {
    const clean = [
      { start: 0, end: 2, text: 'a', speaker: 'agent' },
      { start: 2.3, end: 5, text: 'b', speaker: 'customer' },
      { start: 5.3, end: 7, text: 'c', speaker: 'agent' },
    ]
    expect(diagnoseTime(timeMetrics(clean))[0].level).toBe('ok')
  })

  it('지표가 없으면 빈 목록 (없는 진단을 지어내지 않는다)', () => {
    expect(diagnoseTime(null)).toEqual([])
  })
})

describe('근거 → 원음 역추적', () => {
  const segs = toSegments(TURBO)

  it('인용 문장이 있던 구간을 찾는다', () => {
    expect(findSegment(segs, '단자함 노후가 원인')).toBe(2)
  })

  it('표현이 조금 달라도 찾는다 (요약은 문장을 바꾼다)', () => {
    expect(findSegment(segs, '인터넷이 끊긴다고 세 번째 문의')).toBe(1)
  })

  it('겹치는 게 거의 없으면 찾았다고 말하지 않는다 (엉뚱한 구간으로 보내는 것이 더 나쁘다)', () => {
    expect(findSegment(segs, '점심 메뉴 추천해줘')).toBe(-1)
    expect(findSegment(segs, '')).toBe(-1)
    expect(findSegment(null, '아무거나')).toBe(-1)
  })
})

describe('표시 형식', () => {
  it('초를 분:초로 적는다', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(75)).toBe('1:15')
    expect(formatTime(-5)).toBe('0:00')
  })

  it('구간을 화자 라벨이 붙은 전사로 되돌린다', () => {
    const text = segmentsToText(assignSpeakers(toSegments(TURBO), LABELS))
    expect(text.split('\n')[0]).toContain('상담사:')
    expect(text.split('\n')[1]).toContain('고객:')
  })
})
