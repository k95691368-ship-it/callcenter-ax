import { describe, it, expect } from 'vitest'
import {
  THEMES,
  customerSpeech,
  extractThemes,
  isRepeatCall,
  aggregateThemes,
  compareThemes,
} from '../src/lib/vocThemes.js'
import { TEAMS, teamName } from '../src/lib/teams.js'
import { routeTicket } from '../src/lib/ticketDraft.js'
import { estimateChurn } from '../src/lib/churnRisk.js'
import { SAMPLE_CALLS } from '../src/lib/sampleCalls.js'

const call = (title, transcript, extra = {}) => ({ id: title, title, transcript, ...extra })

describe('고객 발화만 골라낸다', () => {
  it('상담사 안내 문구는 원인 판정에서 제외한다', () => {
    // 상담사는 거의 모든 통화에서 "위약금이 발생합니다"를 안내한다.
    // 그것까지 세면 모든 통화가 위약금 문의가 된다 — 원인은 고객이 말한 것이어야 한다.
    const t = '상담사: 해지 시 위약금 8만 원이 발생합니다.\n고객: 네 알겠습니다.'
    expect(customerSpeech(t)).toBe('네 알겠습니다.')
    expect(extractThemes(call('요금 안내', t)).map((x) => x.id)).not.toContain('penalty')
  })

  it('화자 표기가 없는 전사는 통째로 본다 (형식이 달라도 동작한다)', () => {
    expect(customerSpeech('인터넷이 자꾸 끊겨요')).toBe('인터넷이 자꾸 끊겨요')
  })
})

describe('원인 추출', () => {
  it('같은 카테고리 안의 서로 다른 원인을 분리한다', () => {
    // 셋 다 카테고리로는 '불만' 한 칸에 들어가지만, 넘겨야 할 부서가 전부 다르다
    const speed = extractThemes(call('불만', '고객: 인터넷이 자꾸 끊겨요'))
    const bill = extractThemes(call('불만', '고객: 이번 달 요금이 왜 12만 원이 나왔죠?'))
    const agent = extractThemes(call('불만', '고객: 어떤 서류가 필요한지 안내를 못 해주신다고요?'))
    expect(speed[0].team).toBe('network')
    expect(bill[0].team).toBe('billing')
    expect(agent[0].team).toBe('quality')
    // 부서 이름은 teams.js 한 곳에서 온다 — 티켓 배정과 같은 표를 쓴다
    expect(speed[0].dept).toBe(teamName('network'))
  })

  it('왜 그렇게 분류됐는지 근거 문장을 함께 돌려준다', () => {
    const [t] = extractThemes(call('속도', '고객: 어제부터 인터넷이 느려요'))
    expect(t.evidence[0]).toContain('느려')
  })

  it('한 통화에 원인이 여럿이면 모두 잡는다', () => {
    const ids = extractThemes(call('해지', '고객: 위약금 때문에 해지하려고요. 소비자원에 신고할 거예요')).map((x) => x.id)
    expect(ids).toEqual(expect.arrayContaining(['penalty', 'churn', 'legal']))
  })

  it('사전에 없는 표현은 억지로 분류하지 않는다', () => {
    expect(extractThemes(call('기타', '고객: 안녕하세요 그냥 인사드리려고요'))).toEqual([])
  })

  it('모든 원인에 처리할 부서가 붙어 있다 (부서 없는 원인은 넘길 곳이 없다)', () => {
    expect(THEMES.every((t) => t.team && t.label && t.patterns.length > 0)).toBe(true)
  })

  it('원인이 가리키는 부서가 부서 표에 실제로 있다 (오타 하나로 배정이 사라지지 않게)', () => {
    expect(THEMES.every((t) => TEAMS[t.team])).toBe(true)
  })
})

describe('재문의(1선 종결 실패) 감지', () => {
  it('같은 문제로 다시 걸었다는 신호를 잡는다', () => {
    expect(isRepeatCall(call('재발', '고객: 지난주에 기사님까지 왔다 갔는데 또 느려졌어요'))).toBeTruthy()
    expect(isRepeatCall(call('재발', '고객: 벌써 세 번째예요'))).toBeTruthy()
    expect(isRepeatCall(call('재발', '고객: 벌써 3 번 전화했어요'))).toBeTruthy()
  })

  it('첫 문의는 재문의로 세지 않는다', () => {
    expect(isRepeatCall(call('신규', '고객: 인터넷 신규 가입하려고요'))).toBeNull()
  })

  it('근거 문장을 남긴다', () => {
    const r = isRepeatCall(call('재발', '고객: 지난주에도 말했는데 그대로예요'))
    expect(r.evidence).toContain('지난주')
  })
})

describe('집계 — 원인·부서·재문의·미분류', () => {
  const agg = aggregateThemes(SAMPLE_CALLS)

  it('내장 샘플 10건을 모두 분류한다', () => {
    expect(agg.taggedRate).toBe(1)
    expect(agg.untagged).toEqual([])
  })

  it('원인을 건수 내림차순으로 돌려준다', () => {
    const counts = agg.themes.map((t) => t.count)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('부서별로 묶어 "어디로 넘길 일이 몇 건인지"를 만든다', () => {
    const churn = agg.byDept.find((d) => d.dept === teamName('retention'))
    expect(churn.count).toBeGreaterThan(0)
    expect(churn.themes.length).toBeGreaterThan(1) // 해지 의사 + 위약금이 한 부서로 모인다
  })

  it('부서 합계는 원인 건수의 합과 같다 (집계가 새지 않는다)', () => {
    const themeSum = agg.themes.reduce((s, t) => s + t.count, 0)
    const deptSum = agg.byDept.reduce((s, d) => s + d.count, 0)
    expect(deptSum).toBe(themeSum)
  })

  it('재발 통화를 따로 센다', () => {
    expect(agg.repeats).toHaveLength(1)
    expect(agg.repeats[0].call.title).toContain('재발')
  })

  it('분류 못 한 통화를 감춘 채 0건으로 만들지 않는다', () => {
    const withUnknown = aggregateThemes([...SAMPLE_CALLS, call('미상', '고객: 음 그냥요')])
    expect(withUnknown.untagged).toHaveLength(1)
    expect(withUnknown.taggedRate).toBeLessThan(1)
  })

  it('빈 입력에서 터지지 않는다', () => {
    expect(aggregateThemes([]).themes).toEqual([])
    // 통화가 0건이면 분류율은 0%가 아니라 잴 수 없는 값이다 (화면은 '—'로 그린다)
    expect(aggregateThemes(null).taggedRate).toBe(null)
  })
})

describe('대시보드와 티켓이 같은 부서를 말한다 (두 벌로 갈라지지 않게)', () => {
  // 예전에는 부서 체계가 두 벌이었다. 같은 통화를 대시보드는 '부가서비스팀'으로 세고
  // 티켓은 '보상 심의팀'으로 배정했다 — 두 화면이 같은 질문에 다른 답을 하면 둘 다 신뢰를 잃는다.
  it('내장 샘플 전 건에서 원인의 부서와 티켓 배정이 어긋나지 않는다', () => {
    for (const c of SAMPLE_CALLS) {
      const churn = estimateChurn(c.transcript)
      const route = routeTicket({
        text: c.transcript,
        category: c.analysis.category,
        churnScore: churn.score,
      })
      const themeDepts = extractThemes(c).map((t) => t.dept)
      // 에스컬레이션 우선 규칙(법무·리텐션)은 주제와 무관하게 먼저 가는 것이 설계다
      const isOverride = [teamName('legal'), teamName('retention')].includes(route.team)
      expect(isOverride || themeDepts.includes(route.team)).toBe(true)
    }
  })

  it('소액결제 차단 요청은 부가서비스팀으로 간다 (환불 한 단어에 끌려가지 않는다)', () => {
    const t = '고객: 아이 휴대폰에서 게임 결제가 자꾸 돼서요. 소액결제를 막고 싶어요.\n고객: 이미 결제된 건 환불이 되나요?'
    expect(routeTicket({ text: t, category: '기타' }).team).toBe(teamName('vas'))
  })

  it('상담사만 언급한 절차는 배정을 바꾸지 못한다', () => {
    const t = '상담사: 환불은 결제 대행사 절차가 별도로 필요합니다.\n고객: 인터넷이 자꾸 끊겨요'
    expect(routeTicket({ text: t, category: '불만' }).team).toBe(teamName('network'))
  })

  it('소송을 언급하면 주제와 무관하게 법무가 먼저 본다', () => {
    const t = '고객: 요금이 왜 이렇게 나왔죠? 소비자원에 신고하고 소송할 겁니다'
    expect(routeTicket({ text: t, category: '불만' }).team).toBe(teamName('legal'))
  })
})

describe('기간 비교 — 카테고리가 아니라 원인 단위로 무엇이 늘었는지', () => {
  const before = [call('a', '고객: 요금제 바꾸고 싶어요'), call('b', '고객: 자동이체 날짜 변경이요')]
  const now = [
    call('c', '고객: 인터넷이 끊겨요'),
    call('d', '고객: 또 느려졌어요'),
    call('e', '고객: 속도가 느려요'),
    call('f', '고객: 요금제 바꾸고 싶어요'),
  ]

  it('증가폭이 큰 원인을 앞에 둔다', () => {
    const diff = compareThemes(now, before)
    expect(diff[0].id).toBe('speed')
    expect(diff[0].delta).toBe(3)
  })

  it('이전 구간에 없던 원인은 신규로 표시한다', () => {
    expect(compareThemes(now, before).find((d) => d.id === 'speed').isNew).toBe(true)
  })

  it('그대로인 원인은 증감 0으로 남는다 (사라지지 않는다)', () => {
    const plan = compareThemes(now, before).find((d) => d.id === 'plan')
    expect(plan.delta).toBe(0)
    expect(plan.isNew).toBe(false)
  })
})
