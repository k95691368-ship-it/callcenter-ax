import { describe, it, expect } from 'vitest'
import {
  detectCategorySpikes,
  detectRatioAlerts,
  detectThemeSpikes,
  detectRepeatAlert,
  detectVocAnomalies,
  MIN_ABSOLUTE,
} from '../src/lib/vocAnomaly.js'

// 이상 감지는 누적된 로컬 데이터만으로 동작한다(API 키 불필요).
// 표본이 작을 때 경보를 남발하지 않는다는 계약이 핵심이다.

const call = (date, category, sentiment = '중립', escalate = false) => ({
  date,
  analysis: { category, sentiment, escalate },
})

describe('detectCategorySpikes', () => {
  it('이전 일평균의 2배를 넘고 최소 건수를 채우면 급증으로 본다', () => {
    const calls = [
      call('2026-07-25', '해지'),
      call('2026-07-26', '해지'),
      call('2026-07-27', '해지'),
      // 오늘 해지가 6건 — 이전 일평균 1건의 6배
      ...Array.from({ length: 6 }, () => call('2026-07-28', '해지')),
    ]
    const spikes = detectCategorySpikes(calls)
    expect(spikes).toHaveLength(1)
    expect(spikes[0].category).toBe('해지')
    expect(spikes[0].now).toBe(6)
    expect(spikes[0].level).toBe('high')
    expect(spikes[0].detail).toContain('이전 일평균')
  })

  it('표본이 적으면(최소 건수 미달) 비율이 커도 경보하지 않는다', () => {
    const calls = [
      call('2026-07-26', '요금'),
      call('2026-07-27', '요금'),
      // 오늘 2건 — 비율로는 2배지만 최소 건수 미달
      call('2026-07-28', '요금'),
      call('2026-07-28', '요금'),
    ]
    expect(MIN_ABSOLUTE).toBeGreaterThan(2)
    expect(detectCategorySpikes(calls)).toEqual([])
  })

  it('평소와 같은 수준이면 경보하지 않는다', () => {
    const calls = [
      ...Array.from({ length: 4 }, () => call('2026-07-26', '요금')),
      ...Array.from({ length: 4 }, () => call('2026-07-27', '요금')),
      ...Array.from({ length: 4 }, () => call('2026-07-28', '요금')),
    ]
    expect(detectCategorySpikes(calls)).toEqual([])
  })

  it('이전 구간에 없던 유형은 비율 대신 절대 건수로 판정한다', () => {
    const calls = [
      call('2026-07-26', '요금'),
      call('2026-07-27', '요금'),
      ...Array.from({ length: 4 }, () => call('2026-07-28', '불만')),
    ]
    const spikes = detectCategorySpikes(calls)
    expect(spikes).toHaveLength(1)
    expect(spikes[0].category).toBe('불만')
    expect(spikes[0].ratio).toBeNull()
    expect(spikes[0].detail).toContain('없던 유형')
  })

  it('날짜가 부족하면 판단하지 않는다', () => {
    expect(detectCategorySpikes([call('2026-07-28', '해지')])).toEqual([])
    expect(detectCategorySpikes([])).toEqual([])
    expect(detectCategorySpikes(null)).toEqual([])
  })
})

describe('detectRatioAlerts', () => {
  it('강성 비율이 임계를 넘으면 경보한다', () => {
    const calls = [
      ...Array.from({ length: 3 }, () => call('2026-07-28', '불만', '강성')),
      ...Array.from({ length: 5 }, () => call('2026-07-28', '요금', '중립')),
    ]
    const alerts = detectRatioAlerts(calls)
    expect(alerts.map((a) => a.id)).toContain('hot-ratio')
    expect(alerts[0].detail).toMatch(/\d+%/)
  })

  it('에스컬레이션 비율이 임계를 넘으면 경보한다', () => {
    const calls = [
      ...Array.from({ length: 4 }, () => call('2026-07-28', '해지', '부정', true)),
      ...Array.from({ length: 6 }, () => call('2026-07-28', '요금', '중립', false)),
    ]
    expect(detectRatioAlerts(calls).map((a) => a.id)).toContain('escalate-ratio')
  })

  it('표본이 5건 미만이면 비율을 말하지 않는다', () => {
    const calls = [call('2026-07-28', '불만', '강성'), call('2026-07-28', '불만', '강성')]
    expect(detectRatioAlerts(calls)).toEqual([])
  })

  it('평온한 집계에서는 경보가 없다', () => {
    const calls = Array.from({ length: 10 }, () => call('2026-07-28', '요금', '중립', false))
    expect(detectRatioAlerts(calls)).toEqual([])
  })
})

describe('detectThemeSpikes — "불만이 늘었다"가 아니라 "무엇이 늘었고 어디로 넘길지"', () => {
  const voiced = (date, line, category = '불만') => ({
    date,
    title: '',
    transcript: `고객: ${line}`,
    analysis: { category, sentiment: '부정', escalate: false },
  })

  it('원인별로 급증을 잡고 처리 부서를 함께 돌려준다', () => {
    const calls = [
      voiced('2026-07-26', '요금제 바꾸고 싶어요', '요금'),
      voiced('2026-07-27', '자동이체 날짜 변경할게요', '요금'),
      voiced('2026-07-28', '인터넷이 자꾸 끊겨요'),
      voiced('2026-07-28', '속도가 너무 느려요'),
      voiced('2026-07-28', '어제부터 인터넷이 안 돼요'),
    ]
    const spikes = detectThemeSpikes(calls)
    const speed = spikes.find((s) => s.theme === 'speed')
    expect(speed).toBeTruthy()
    expect(speed.now).toBe(3)
    expect(speed.dept).toBe('네트워크 운영팀')
    expect(speed.label).toContain('네트워크 운영팀')
    expect(speed.detail).toContain('공유가 필요')
  })

  it('같은 카테고리라도 원인이 다르면 따로 센다', () => {
    // 넷 다 '불만'이지만 속도 3건 + 과다청구 1건이다. 카테고리로만 보면 구분되지 않는다.
    const calls = [
      voiced('2026-07-26', '요금제 문의요', '요금'),
      voiced('2026-07-27', '납부일 바꿔주세요', '요금'),
      voiced('2026-07-28', '인터넷이 끊겨요'),
      voiced('2026-07-28', '속도가 느려요'),
      voiced('2026-07-28', '접속이 안 돼요'),
      voiced('2026-07-28', '요금이 왜 이렇게 많이 나왔죠'),
    ]
    const ids = detectThemeSpikes(calls).map((s) => s.theme)
    expect(ids).toContain('speed')
    expect(ids).not.toContain('overcharge') // 1건은 최소 건수 미달 — 남발하지 않는다
  })

  it('표본이 적으면 원인 급증도 경보하지 않는다', () => {
    const calls = [
      voiced('2026-07-27', '요금제 문의', '요금'),
      voiced('2026-07-28', '인터넷이 끊겨요'),
      voiced('2026-07-28', '느려요'),
    ]
    expect(detectThemeSpikes(calls)).toEqual([])
  })

  it('날짜가 부족하거나 빈 입력이면 판단하지 않는다', () => {
    expect(detectThemeSpikes([])).toEqual([])
    expect(detectThemeSpikes(null)).toEqual([])
  })
})

describe('detectRepeatAlert — 1선 종결이 안 되고 있다는 신호', () => {
  const repeat = (line) => ({
    date: '2026-07-28',
    title: '',
    transcript: `고객: ${line}`,
    analysis: { category: '불만', sentiment: '부정', escalate: false },
  })

  it('재문의 비율이 임계를 넘으면 경보한다', () => {
    const calls = [
      repeat('또 느려졌어요'),
      repeat('벌써 세 번째예요'),
      repeat('지난주에도 말했는데요'),
      repeat('요금제 바꿔주세요'),
      repeat('가입하려고요'),
      repeat('납부일 변경할게요'),
    ]
    const alerts = detectRepeatAlert(calls)
    expect(alerts[0].id).toBe('repeat-ratio')
    expect(alerts[0].detail).toContain('1선 종결')
  })

  it('첫 문의만 있으면 경보하지 않는다', () => {
    const calls = Array.from({ length: 6 }, () => repeat('신규 가입하려고요'))
    expect(detectRepeatAlert(calls)).toEqual([])
  })

  it('표본이 5건 미만이면 비율을 말하지 않는다', () => {
    expect(detectRepeatAlert([repeat('또 느려졌어요')])).toEqual([])
  })
})

describe('detectVocAnomalies', () => {
  it('비율 경보와 급증 경보를 함께 돌려준다', () => {
    const calls = [
      call('2026-07-26', '요금'),
      call('2026-07-27', '요금'),
      ...Array.from({ length: 5 }, () => call('2026-07-28', '해지', '강성', true)),
      ...Array.from({ length: 5 }, () => call('2026-07-28', '요금', '중립', false)),
    ]
    const out = detectVocAnomalies(calls)
    expect(out.length).toBeGreaterThan(0)
    for (const a of out) {
      expect(a).toHaveProperty('label')
      expect(a).toHaveProperty('detail')
      expect(['high', 'warn']).toContain(a.level)
    }
  })

  it('분석 정보가 없는 항목이 섞여 있어도 터지지 않는다', () => {
    expect(() => detectVocAnomalies([{ date: '2026-07-28' }, null, {}])).not.toThrow()
  })
})
