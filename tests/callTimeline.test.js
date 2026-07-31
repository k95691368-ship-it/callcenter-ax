import { describe, it, expect } from 'vitest'
import {
  stitchChunks,
  buildTimeline,
  diagnoseTimeline,
  speechChars,
  formatClock,
  SILENCE_MIN_SEC,
} from '../src/lib/callTimeline.js'
import { planChunks, CHUNK_SECONDS } from '../src/lib/audioChunk.js'

// 분할 전사 타임라인의 회귀 테스트.
// 핵심은 "청크 오프셋"이다 — 이걸 빠뜨리면 27분 통화가 0~55초에 뭉친다.

describe('stitchChunks — 청크 오프셋을 더해 전체 타임라인으로 잇는다', () => {
  it('각 청크의 start를 더한다 (안 더하면 전부 0~55초에 뭉친다)', () => {
    const { segments } = stitchChunks([
      { start: 0, end: 55, segments: [{ start: 1, end: 4, text: '안녕하세요' }] },
      { start: 55, end: 110, segments: [{ start: 2, end: 6, text: '요금제 문의드립니다' }] },
      { start: 110, end: 165, segments: [{ start: 0.5, end: 3, text: '확인해 드리겠습니다' }] },
    ])
    expect(segments.map((s) => [s.start, s.end])).toEqual([
      [1, 4],
      [57, 61],
      [110.5, 113],
    ])
    // 청크 번호를 남겨야 어느 청크에서 온 구간인지 되짚을 수 있다
    expect(segments.map((s) => s.chunk)).toEqual([0, 1, 2])
  })

  it('27분 녹취(30청크)에서 마지막 구간이 55초 안에 갇히지 않는다', () => {
    const plan = planChunks(30 * CHUNK_SECONDS, CHUNK_SECONDS)
    const { segments } = stitchChunks(
      plan.map((c) => ({ ...c, segments: [{ start: 1, end: 3, text: '발화' }] }))
    )
    expect(segments).toHaveLength(30)
    // 오프셋이 빠지면 이 값이 1이 된다 (예전 버그의 모습)
    expect(segments[29].start).toBe(29 * CHUNK_SECONDS + 1)
    expect(segments[29].start).toBeGreaterThan(1500)
  })

  it('청크 경계를 넘겨 부른 타임스탬프는 경계에서 자른다 (음수 간격 방지)', () => {
    const { segments } = stitchChunks([
      // 모델이 55초 청크에서 56.4초까지 있다고 답한 경우
      { start: 0, end: 55, segments: [{ start: 50, end: 56.4, text: '앞 청크 끝' }] },
      { start: 55, end: 110, segments: [{ start: 0, end: 2, text: '뒤 청크 시작' }] },
    ])
    expect(segments[0].end).toBe(55)
    // 자르지 않으면 55 - 56.4 = -1.4초짜리 간격이 생겨 침묵 계산이 어긋난다
    expect(segments[1].start - segments[0].end).toBe(0)
  })

  it('타임스탬프가 없는 청크는 blind 범위로 남긴다 (침묵으로 세지 않으려고)', () => {
    const { segments, blind } = stitchChunks([
      { start: 0, end: 55, segments: [{ start: 1, end: 3, text: '있음' }] },
      { start: 55, end: 110, segments: null },
      { start: 110, end: 140, segments: [] },
    ])
    expect(segments).toHaveLength(1)
    expect(blind).toEqual([
      { start: 55, end: 110 },
      { start: 110, end: 140 },
    ])
  })

  it('깨진 구간(시각 없음·빈 텍스트·역전)은 버린다', () => {
    const { segments } = stitchChunks([
      {
        start: 10,
        end: 65,
        segments: [
          { start: 1, end: 2, text: '정상' },
          { start: null, end: 3, text: '시각 없음' },
          { start: 4, end: 5, text: '   ' },
          { start: 9, end: 6, text: '역전' },
        ],
      },
    ])
    expect(segments).toEqual([{ start: 11, end: 12, text: '정상', speaker: null, chunk: 0 }])
  })

  it('빈 입력에도 터지지 않는다', () => {
    expect(stitchChunks([])).toEqual({ segments: [], blind: [] })
    expect(stitchChunks()).toEqual({ segments: [], blind: [] })
  })
})

describe('buildTimeline — 글자 수 근사치가 아니라 시간 실측', () => {
  // 발화 2+3+4=9초, 간격 5초(3~8)와 4초(11~15) → 둘 다 3초 이상이라 침묵 2회
  const segs = [
    { start: 1, end: 3, text: '가나다' },
    { start: 8, end: 11, text: '라마바사' },
    { start: 15, end: 19, text: '아자차카타' },
  ]

  it('총 발화 시간과 통화 길이를 나눠 계산한다', () => {
    const t = buildTimeline(segs)
    expect(t.speechSec).toBe(9)
    // durationSec이 없으면 마지막 발화 끝(19초)이 통화 길이다
    expect(t.callSec).toBe(19)
    expect(t.segments).toBe(3)
  })

  it('durationSec이 있으면 마지막 발화 뒤의 무음까지 통화 길이에 넣는다', () => {
    // 구간만 보면 19초짜리 통화지만 실제 파일은 30초다 — 뒤 11초 무음은 구간에 흔적이 없다
    const t = buildTimeline(segs, { durationSec: 30 })
    expect(t.callSec).toBe(30)
    expect(t.trailingSilenceSec).toBe(11)
    expect(t.speechRatio).toBe(30) // 9 / 30
  })

  it('침묵 구간을 위치와 길이로 준다 (합계만 주면 어디를 들을지 모른다)', () => {
    const t = buildTimeline(segs)
    expect(t.silences).toEqual([
      { start: 3, end: 8, sec: 5 },
      { start: 11, end: 15, sec: 4 },
    ])
    expect(t.silenceCount).toBe(2)
    expect(t.silenceSec).toBe(9)
    expect(t.longestSilenceSec).toBe(5)
    expect(t.longestSilenceAt).toBe(3)
  })

  it('임계값 미만의 짧은 쉼은 침묵으로 세지 않는다 (정상 대화 리듬)', () => {
    const t = buildTimeline([
      { start: 0, end: 2, text: '가나' },
      { start: 3.5, end: 5, text: '다라' }, // 1.5초 쉼 — 정상
    ])
    expect(t.silenceCount).toBe(0)
    expect(t.longestSilenceSec).toBe(0)
    // 임계값은 조정 가능해야 한다
    expect(buildTimeline(segs, { silenceMinSec: 4.5 }).silenceCount).toBe(1)
    expect(SILENCE_MIN_SEC).toBe(3)
  })

  it('첫 발화 전 무음은 상담 중 침묵과 따로 낸다 (연결음 구간)', () => {
    const t = buildTimeline(segs)
    expect(t.leadingSilenceSec).toBe(1)
    // 앞뒤 여백이 침묵 합계에 섞이면 "침묵 40초"가 사실은 녹음 여백인 경우가 생긴다
    expect(t.silenceSec).toBe(9)
  })

  it('겹치는 구간을 합쳐서 발화 시간이 통화 길이를 넘지 않게 한다', () => {
    const t = buildTimeline([
      { start: 0, end: 10, text: '가나다' },
      { start: 5, end: 12, text: '라마바' }, // 5초 겹침
    ])
    // 단순 합산이면 10 + 7 = 17초가 되어 통화 길이(12초)를 넘는다
    expect(t.speechSec).toBe(12)
    expect(t.callSec).toBe(12)
    expect(t.speechRatio).toBe(100)
  })

  it('타임스탬프가 없으면 null — 0으로 채우지 않는다', () => {
    expect(buildTimeline([])).toBeNull()
    expect(buildTimeline(null)).toBeNull()
    // 시각이 없는 구간만 있으면 계산 대상이 없다
    expect(buildTimeline([{ text: '시각 없음' }])).toBeNull()
  })
})

describe('발화 속도 — 말이 빨라지는 구간을 찾는다', () => {
  it('분당 글자 수를 실측으로 낸다', () => {
    // 6글자를 3초에 → 분당 120자
    const t = buildTimeline([{ start: 0, end: 3, text: '가나다라마바' }])
    expect(t.charsPerMin).toBe(120)
  })

  it('공백·문장부호는 글자 수에서 뺀다', () => {
    expect(speechChars('안녕하세요, 고객님!')).toBe(8)
    expect(speechChars('  ')).toBe(0)
    expect(speechChars(null)).toBe(0)
  })

  it('평소 속도(중앙값)보다 크게 빨라진 구간을 짚는다', () => {
    const t = buildTimeline([
      { start: 0, end: 5, text: '가나다라마가나다라마' }, // 10자/5초 = 120
      { start: 6, end: 11, text: '가나다라마가나다라마' }, // 120
      { start: 12, end: 17, text: '가나다라마가나다라마' }, // 120
      // 30자를 5초에 = 분당 360자 (중앙값의 3배)
      { start: 18, end: 23, text: '가나다라마가나다라마가나다라마가나다라마가나다라마가나다라마' },
    ])
    expect(t.medianCharsPerMin).toBe(120)
    expect(t.fastSegments).toHaveLength(1)
    expect(t.fastSegments[0].cpm).toBe(360)
    expect(t.fastSegments[0].start).toBe(18)
  })

  it('짧은 맞장구("네.")는 속도 통계에서 뺀다 — 잡음이 중앙값을 지배한다', () => {
    const t = buildTimeline([
      { start: 0, end: 0.4, text: '네' }, // 0.8초 미만 → 제외
      { start: 2, end: 7, text: '가나다라마가나다라마' },
      { start: 8, end: 13, text: '가나다라마가나다라마' },
    ])
    expect(t.ratedSegments).toBe(2)
    expect(t.medianCharsPerMin).toBe(120)
    expect(t.fastSegments).toHaveLength(0)
  })
})

describe('분할 전사 + 타임라인 통합 — 오프셋이 지표까지 이어진다', () => {
  it('청크를 넘어가는 침묵을 실제 길이로 잡는다', () => {
    // 1청크 끝에서 말이 끝나고 2청크 중반에 다시 시작 → 실제 침묵은 청크 경계를 넘는다
    const { segments, blind } = stitchChunks([
      { start: 0, end: 55, segments: [{ start: 10, end: 20, text: '가나다라마' }] },
      { start: 55, end: 110, segments: [{ start: 15, end: 25, text: '바사아자차' }] },
    ])
    const t = buildTimeline(segments, { durationSec: 110, blind })
    // 20초 → 70초 = 50초 침묵. 오프셋이 없으면 20초 → 15초(음수)로 계산돼 사라진다.
    expect(t.silences).toEqual([{ start: 20, end: 70, sec: 50 }])
    expect(t.longestSilenceSec).toBe(50)
    expect(t.callSec).toBe(110)
    expect(t.speechSec).toBe(20)
  })

  it('전사를 못 받은 청크의 시간은 침묵이 아니라 "모름"으로 다룬다', () => {
    const { segments, blind } = stitchChunks([
      { start: 0, end: 55, segments: [{ start: 10, end: 20, text: '가나다라마' }] },
      { start: 55, end: 110, segments: null }, // 데모 응답 등
      { start: 110, end: 165, segments: [{ start: 5, end: 15, text: '바사아자차' }] },
    ])
    const t = buildTimeline(segments, { durationSec: 165, blind })
    // 20초~115초 사이의 빈틈은 blind 청크를 지나므로 침묵으로 세지 않는다
    expect(t.silences).toEqual([])
    expect(t.partial).toBe(true)
    expect(t.blindSec).toBe(55)
    expect(t.coveredSec).toBe(110)
    // 비율은 관측된 시간 기준 — 모르는 55초를 분모에 넣으면 발화 밀도가 거짓으로 낮아진다
    expect(t.speechRatio).toBe(18.2) // 20 / 110
  })
})

describe('diagnoseTimeline — 수치를 판단으로', () => {
  it('10초 이상 침묵은 위치와 함께 경고한다', () => {
    const t = buildTimeline([
      { start: 0, end: 5, text: '가나다라마' },
      { start: 80, end: 85, text: '바사아자차' },
    ])
    const d = diagnoseTimeline(t)
    const silence = d.find((x) => x.id === 'long-silence')
    expect(silence.level).toBe('warn')
    expect(silence.label).toBe('75초 침묵')
    expect(silence.detail).toContain('0:05') // 침묵이 시작된 지점
  })

  it('긴 침묵이 없으면 그렇다고 말한다', () => {
    const t = buildTimeline([
      { start: 0, end: 5, text: '가나다라마' },
      { start: 6, end: 11, text: '바사아자차' },
    ])
    expect(diagnoseTimeline(t).some((x) => x.id === 'no-silence')).toBe(true)
  })

  it('발화 밀도가 낮으면 대기·조회 시간을 지적한다', () => {
    const t = buildTimeline([{ start: 0, end: 10, text: '가나다라마' }], { durationSec: 100 })
    expect(diagnoseTimeline(t).some((x) => x.id === 'low-density')).toBe(true)
  })

  it('타임라인이 없으면 빈 배열 (없는 진단을 지어내지 않는다)', () => {
    expect(diagnoseTimeline(null)).toEqual([])
  })
})

describe('formatClock', () => {
  it('분:초로 읽는다', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(1625)).toBe('27:05')
    // 음수·NaN에도 화면이 깨지지 않아야 한다
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(null)).toBe('0:00')
  })
})
