import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadMyCalls, saveMyCall, clearMyCalls } from '../src/lib/myCalls.js'

// VOC 대시보드의 "내 분석 기록"은 브라우저에만 저장된다(서버 미저장 원칙).
// 절단 한도·파싱 실패 폴백·저장 불가 환경이 모두 조용히 동작해야 하므로 고정해 둔다.

function stubStorage() {
  const map = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  })
  return map
}

describe('myCalls', () => {
  beforeEach(() => {
    stubStorage()
  })

  it('비어 있으면 빈 배열을 준다', () => {
    expect(loadMyCalls()).toEqual([])
  })

  it('저장한 통화를 다시 읽어온다', () => {
    saveMyCall({ title: '요금제 문의', category: '요금', sentiment: '중립', escalate: false })
    const calls = loadMyCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].title).toBe('요금제 문의')
    expect(calls[0].analysis).toEqual({ category: '요금', sentiment: '중립', escalate: false })
    expect(calls[0].mine).toBe(true)
    expect(calls[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('제목을 40자로 자른다', () => {
    saveMyCall({ title: '가'.repeat(100), category: '기타', sentiment: '중립' })
    expect(loadMyCalls()[0].title.length).toBe(40)
  })

  it('제목이 없으면 기본 제목을 쓴다', () => {
    saveMyCall({ category: '기타', sentiment: '중립' })
    expect(loadMyCalls()[0].title).toBe('직접 분석한 통화')
  })

  it('escalate를 불리언으로 정규화한다', () => {
    saveMyCall({ title: 'a', category: '불만', sentiment: '강성', escalate: 'yes' })
    expect(loadMyCalls()[0].analysis.escalate).toBe(true)
  })

  it('50건을 넘기면 최신 50건만 남긴다 (localStorage 무한 증가 방지)', () => {
    for (let i = 0; i < 55; i++) {
      saveMyCall({ title: `통화 ${i}`, category: '기타', sentiment: '중립' })
    }
    const calls = loadMyCalls()
    expect(calls).toHaveLength(50)
    // 오래된 쪽이 잘려야 한다 — 최신 기록이 사라지면 방금 분석한 통화가 대시보드에 없다
    expect(calls[calls.length - 1].title).toBe('통화 54')
    expect(calls.some((c) => c.title === '통화 0')).toBe(false)
  })

  it('저장된 값이 깨져 있으면 빈 배열로 복구한다', () => {
    localStorage.setItem('cc-mycalls', '{잘못된 JSON')
    expect(loadMyCalls()).toEqual([])
  })

  it('배열이 아닌 값이 저장돼 있어도 빈 배열을 준다', () => {
    localStorage.setItem('cc-mycalls', '{"a":1}')
    expect(loadMyCalls()).toEqual([])
  })

  it('이탈 위험과 담당 부서를 함께 저장한다 (대장이 "어느 통화가 위험했나"에 답하도록)', () => {
    saveMyCall({
      title: '해지 문의',
      category: '해지',
      sentiment: '강성',
      escalate: true,
      churn: {
        score: 85,
        level: '높음',
        estimated: true,
        signals: [{ label: '해지 의사 직접 표현', evidence: '해지하겠습니다' }],
      },
      route: { team: '리텐션(해지 방어)팀', priority: 'P1' },
    })
    const [row] = loadMyCalls()
    expect(row.analysis.churn.score).toBe(85)
    expect(row.analysis.churn.level).toBe('높음')
    expect(row.analysis.route.team).toContain('리텐션')
    // 근거 라벨만 남기고 인용 발화는 저장하지 않는다 (원문 미저장 원칙)
    expect(row.analysis.churn.signals).toEqual(['해지 의사 직접 표현'])
    expect(JSON.stringify(row)).not.toContain('해지하겠습니다')
  })

  it('이탈 위험이 없으면 필드 자체를 만들지 않는다 (0점과 미측정을 구분)', () => {
    saveMyCall({ title: 'a', category: '기타', sentiment: '중립' })
    expect(loadMyCalls()[0].analysis).not.toHaveProperty('churn')
    expect(loadMyCalls()[0].analysis).not.toHaveProperty('route')
  })

  it('clearMyCalls가 기록을 비운다', () => {
    saveMyCall({ title: 'a', category: '기타', sentiment: '중립' })
    clearMyCalls()
    expect(loadMyCalls()).toEqual([])
  })

  it('저장이 불가능한 환경(시크릿 모드 등)에서도 예외를 던지지 않는다', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    })
    expect(() => saveMyCall({ title: 'a', category: '기타', sentiment: '중립' })).not.toThrow()
    expect(() => clearMyCalls()).not.toThrow()
  })
})
