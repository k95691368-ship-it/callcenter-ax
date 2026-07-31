import { describe, it, expect } from 'vitest'
import {
  PERIOD_PRESETS,
  UNLABELED_AGENT,
  aggregateByAgent,
  anchorDate,
  daysBetween,
  filterByRange,
  formatRange,
  inRange,
  previousRange,
  resolvePeriod,
  shiftDays,
  splitPeriod,
  todayIso,
} from '../src/lib/vocPeriod.js'
import { compareThemes } from '../src/lib/vocThemes.js'
import { SAMPLE_CALLS } from '../src/lib/sampleCalls.js'
import { MIN_ABSOLUTE } from '../src/lib/vocAnomaly.js'

// 이 대시보드의 업무 단위는 "통화 1건"이 아니라 "상담사 여러 명 × 기간"이다.
// 기간을 자르는 축이 없으면 vocThemes.compareThemes(현재, 이전)는 호출할 수조차 없다 —
// 그래서 이 파일이 지키는 것은 결국 "compareThemes에 넣을 두 구간이 정확한가"이다.

const call = (date, extra = {}) => ({ id: `${date}-${extra.title || ''}`, date, ...extra })

describe('날짜 산술 — 하루가 밀리면 집계가 통째로 어긋난다', () => {
  it('월·연 경계를 넘어간다', () => {
    expect(shiftDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('윤년 2월을 정확히 센다', () => {
    expect(shiftDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29)
  })

  it('형식이 아니거나 존재하지 않는 날짜는 null이다 (0으로 만들면 1970년 유령 데이터가 된다)', () => {
    expect(shiftDays('', 1)).toBeNull()
    expect(shiftDays('2026-7-1', 1)).toBeNull()
    expect(shiftDays('2026-02-31', 0)).toBeNull()
    expect(daysBetween('2026-01-01', 'nope')).toBeNull()
  })

  it('오늘 날짜를 로컬 기준으로 만든다 (UTC로 자르면 KST 오전에 하루가 밀린다)', () => {
    // new Date(2026, 7, 1, 0, 30)은 로컬 8월 1일 0시 30분이다.
    // toISOString().slice(0,10)을 쓰면 KST에서 '2026-07-31'이 되어, 오전에 분석한 통화가
    // "오늘"에서 빠지고 "어제"로 들어간다.
    expect(todayIso(new Date(2026, 7, 1, 0, 30))).toBe('2026-08-01')
    expect(todayIso(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})

describe('기준일 — "오늘"이 가리키는 날', () => {
  it('데이터의 마지막 통화 날짜를 기준일로 잡는다', () => {
    expect(anchorDate(SAMPLE_CALLS)).toBe('2026-07-27')
  })

  it('통화가 없으면 넘겨받은 오늘로 떨어진다', () => {
    expect(anchorDate([], '2026-07-31')).toBe('2026-07-31')
    expect(anchorDate(null, '2026-07-31')).toBe('2026-07-31')
  })

  it('날짜가 깨진 기록은 기준일 계산에 끼지 않는다', () => {
    expect(anchorDate([call('2026-07-20'), call('내일'), call('2026-07-22')])).toBe('2026-07-22')
  })
})

describe('프리셋 → 실제 날짜 구간', () => {
  const opts = { anchor: '2026-07-27' }

  it('오늘 / 어제 / 최근 7일을 기준일에서 잘라낸다', () => {
    expect(resolvePeriod('today', opts)).toMatchObject({ start: '2026-07-27', end: '2026-07-27', days: 1 })
    expect(resolvePeriod('yesterday', opts)).toMatchObject({ start: '2026-07-26', end: '2026-07-26', days: 1 })
    // 7일은 기준일을 포함한 7일이다 — 21일부터 27일까지
    expect(resolvePeriod('week', opts)).toMatchObject({ start: '2026-07-21', end: '2026-07-27', days: 7 })
  })

  it("'전체'는 데이터의 처음과 끝을 그대로 쓴다", () => {
    const all = resolvePeriod('all', { calls: SAMPLE_CALLS })
    expect(all).toMatchObject({ start: '2026-07-21', end: '2026-07-27', isAll: true, days: 7 })
  })

  it('모르는 프리셋 id는 전체로 떨어진다 (빈 화면 대신 전부 보여준다)', () => {
    expect(resolvePeriod('지난분기', { calls: SAMPLE_CALLS }).isAll).toBe(true)
  })

  it('프리셋 목록에 오늘·어제·최근 7일·전체가 모두 있다', () => {
    expect(PERIOD_PRESETS.map((p) => p.id)).toEqual(['today', 'yesterday', 'week', 'all'])
  })
})

describe('직전 동일 길이 구간 — compareThemes에 넣을 짝', () => {
  it('선택 구간 바로 앞에 같은 길이로 붙는다 (하루도 겹치지 않는다)', () => {
    const week = resolvePeriod('week', { anchor: '2026-07-27' })
    const prev = previousRange(week)
    expect(prev).toMatchObject({ start: '2026-07-14', end: '2026-07-20', days: 7 })
    expect(prev.end < week.start).toBe(true)
    expect(daysBetween(prev.end, week.start)).toBe(1)
  })

  it('하루짜리 구간의 직전은 그 전날이다', () => {
    expect(previousRange(resolvePeriod('today', { anchor: '2026-07-27' }))).toMatchObject({
      start: '2026-07-26',
      end: '2026-07-26',
    })
  })

  it("'전체'에는 직전 구간이 없다 — 없는 비교를 지어내지 않는다", () => {
    expect(previousRange(resolvePeriod('all', { calls: SAMPLE_CALLS }))).toBeNull()
    expect(splitPeriod(SAMPLE_CALLS, 'all').comparable).toBe(false)
  })
})

describe('구간으로 통화 나누기', () => {
  const calls = [
    call('2026-07-20', { title: '이전' }),
    call('2026-07-26', { title: '직전' }),
    call('2026-07-27', { title: '오늘' }),
  ]

  it('양끝을 포함한다 (경계 하루가 빠지면 그날 집계가 통째로 사라진다)', () => {
    const week = resolvePeriod('week', { anchor: '2026-07-27' })
    expect(inRange(call('2026-07-21'), week)).toBe(true)
    expect(inRange(call('2026-07-27'), week)).toBe(true)
    expect(inRange(call('2026-07-20'), week)).toBe(false)
    expect(inRange(call('2026-07-28'), week)).toBe(false)
  })

  it('선택 구간과 직전 구간을 함께 돌려준다', () => {
    const split = splitPeriod(calls, 'today', { anchor: '2026-07-27' })
    expect(split.current.map((c) => c.title)).toEqual(['오늘'])
    expect(split.previous.map((c) => c.title)).toEqual(['직전'])
    expect(split.comparable).toBe(true)
  })

  it('날짜가 깨진 기록은 어느 날에도 밀어 넣지 않는다 (전체에서는 보인다)', () => {
    const broken = [...calls, call('', { title: '날짜없음' })]
    expect(splitPeriod(broken, 'today', { anchor: '2026-07-27' }).current).toHaveLength(1)
    expect(filterByRange(broken, resolvePeriod('all', { calls: broken }))).toHaveLength(4)
  })

  it('빈 입력·null에서 터지지 않는다', () => {
    expect(() => splitPeriod(null, 'week')).not.toThrow()
    expect(splitPeriod([], 'week').current).toEqual([])
    expect(filterByRange(null, null)).toEqual([])
  })

  it('구간 표기를 사람이 읽는 형태로 만든다', () => {
    expect(formatRange(resolvePeriod('week', { anchor: '2026-07-27' }))).toBe('07/21 ~ 07/27')
    expect(formatRange(resolvePeriod('today', { anchor: '2026-07-27' }))).toBe('07/27')
  })
})

describe('compareThemes 연결 — 이 축이 없어서 도달할 수 없던 코드', () => {
  const speed = (date) => call(date, { title: '속도', transcript: '고객: 인터넷이 자꾸 끊겨요' })
  const plan = (date) => call(date, { title: '요금제', transcript: '고객: 요금제를 바꾸고 싶어요' })

  it('splitPeriod의 결과를 그대로 넣으면 원인 단위 증감이 나온다', () => {
    const calls = [
      plan('2026-07-26'),
      plan('2026-07-26'),
      speed('2026-07-27'),
      speed('2026-07-27'),
      speed('2026-07-27'),
    ]
    const split = splitPeriod(calls, 'today', { anchor: '2026-07-27' })
    const diff = compareThemes(split.current, split.previous)
    const top = diff[0]
    expect(top.id).toBe('speed')
    expect(top.delta).toBe(3)
    expect(top.isNew).toBe(true)
    // 원인에는 넘길 부서가 붙어 있어야 증감이 조치로 이어진다
    expect(top.dept).toBeTruthy()
  })

  it('이번 구간에 0건이 된 원인이 표에서 사라지지 않는다', () => {
    // 지난 구간에 몰렸던 원인이 이번에 0건이 되는 것은 가장 큰 변화다.
    // 예전에는 현재 구간의 원인만 훑어서 이 행이 통째로 사라졌고, 화면에는
    // 아무 변화도 없는 것처럼 보였다.
    const calls = [speed('2026-07-26'), speed('2026-07-26'), plan('2026-07-27')]
    const split = splitPeriod(calls, 'today', { anchor: '2026-07-27' })
    const gone = compareThemes(split.current, split.previous).find((d) => d.id === 'speed')
    expect(gone).toBeTruthy()
    expect(gone.count).toBe(0)
    expect(gone.previous).toBe(2)
    expect(gone.delta).toBe(-2)
    expect(gone.isGone).toBe(true)
    // 이전 구간의 발화를 이번 구간의 근거처럼 보여주지 않는다
    expect(gone.evidence).toEqual([])
  })

  it('증가가 감소보다 앞에 온다 (먼저 볼 것이 먼저 있어야 한다)', () => {
    const calls = [speed('2026-07-26'), plan('2026-07-27'), plan('2026-07-27')]
    const diff = compareThemes(
      splitPeriod(calls, 'today', { anchor: '2026-07-27' }).current,
      splitPeriod(calls, 'today', { anchor: '2026-07-27' }).previous
    )
    expect(diff[0].delta).toBeGreaterThan(diff[diff.length - 1].delta)
  })
})

describe('상담사 축 — 데이터에는 있었지만 아무도 세지 않던 필드', () => {
  it('내장 샘플의 agent 필드로 묶는다', () => {
    const { rows, total, labeledAgents, unlabeled } = aggregateByAgent(SAMPLE_CALLS)
    expect(total).toBe(SAMPLE_CALLS.length)
    expect(labeledAgents).toBe(6) // 상담사 A~F
    expect(unlabeled).toBe(0)
    expect(rows[0].count).toBeGreaterThanOrEqual(rows[rows.length - 1].count)
    // 건수 합이 원본과 같다 — 집계가 새지 않는다
    expect(rows.reduce((s, r) => s + r.count, 0)).toBe(SAMPLE_CALLS.length)
  })

  it('라벨이 없으면 미지정으로 묶되 그 사실을 남긴다', () => {
    const mixed = [
      call('2026-07-27', { agent: '상담사 A' }),
      call('2026-07-27', { agent: '  ' }),
      call('2026-07-27', {}),
    ]
    const agg = aggregateByAgent(mixed)
    expect(agg.unlabeled).toBe(2)
    expect(agg.labeledAgents).toBe(1)
    // 미지정은 사람이 아니므로 순위 경쟁에 끼우지 않고 항상 맨 아래에 둔다
    expect(agg.rows[agg.rows.length - 1].agent).toBe(UNLABELED_AGENT)
    expect(agg.rows[agg.rows.length - 1].labeled).toBe(false)
  })

  it(`표본이 ${MIN_ABSOLUTE}건 미만이면 비율을 만들지 않는다 (1건 중 1건 = 100%가 평가에 쓰인다)`, () => {
    const one = aggregateByAgent([
      call('2026-07-27', { agent: '상담사 Z', analysis: { sentiment: '강성', escalate: true } }),
    ])
    const row = one.rows[0]
    expect(row.count).toBe(1)
    expect(row.negative).toBe(1) // 건수는 그대로 센다
    expect(row.enoughSample).toBe(false)
    // 0%가 아니라 null — 화면이 "표본 부족"과 "0%"를 구분해서 말할 수 있어야 한다
    expect(row.negativeRate).toBeNull()
    expect(row.escalateRate).toBeNull()
    expect(row.repeatRate).toBeNull()
  })

  it(`표본이 ${MIN_ABSOLUTE}건 이상이면 비율을 낸다`, () => {
    const calls = Array.from({ length: MIN_ABSOLUTE }, (_, i) =>
      call('2026-07-27', { agent: '상담사 Z', analysis: { sentiment: i === 0 ? '부정' : '중립' } })
    )
    const row = aggregateByAgent(calls).rows[0]
    expect(row.enoughSample).toBe(true)
    expect(row.negativeRate).toBeCloseTo(1 / MIN_ABSOLUTE)
  })

  it('통화 시간이 기록되지 않았으면 0분이 아니라 미측정이다', () => {
    const rows = aggregateByAgent([call('2026-07-27', { agent: '상담사 Z' })]).rows
    expect(rows[0].avgMinutes).toBeNull()
    const timed = aggregateByAgent([
      call('2026-07-27', { agent: '상담사 Y', minutes: 4 }),
      call('2026-07-27', { agent: '상담사 Y', minutes: 6 }),
    ]).rows
    expect(timed[0].avgMinutes).toBe(5)
  })

  it('재문의를 상담사별로 센다 (1선 종결 실패가 어디에 몰리는가)', () => {
    const rows = aggregateByAgent(SAMPLE_CALLS).rows
    expect(rows.reduce((s, r) => s + r.repeat, 0)).toBe(1) // 샘플의 재발 통화 1건
  })

  it('기간을 자른 뒤에도 그대로 동작한다 (기간 × 상담사가 최종 목표다)', () => {
    const split = splitPeriod(SAMPLE_CALLS, 'today', { anchor: '2026-07-27' })
    const agg = aggregateByAgent(split.current)
    expect(agg.total).toBe(1)
    expect(agg.rows[0].agent).toBe('상담사 F') // 07-27 통화는 c10 한 건
  })

  it('빈 입력·null에서 터지지 않는다', () => {
    expect(aggregateByAgent([]).rows).toEqual([])
    expect(aggregateByAgent(null).total).toBe(0)
  })
})
