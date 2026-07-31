import { describe, it, expect } from 'vitest'
import { routeTicket, ticketTitle, buildTicketDraft, DEFAULT_ROUTE } from '../src/lib/ticketDraft.js'
import { estimateChurn } from '../src/lib/churnRisk.js'

describe('routeTicket — 부서 라우팅', () => {
  it('법적 언급이 있으면 다른 조건보다 먼저 법무팀으로 간다', () => {
    const r = routeTicket({ text: '해지하고 소송 걸겠습니다 타사로 갈게요', category: '해지', churnScore: 90 })
    expect(r.team).toContain('법무')
    expect(r.priority).toBe('P1')
  })

  it('해지+타사 이동은 리텐션팀으로 간다', () => {
    const r = routeTicket({ text: '해지하고 다른 통신사로 옮기려고요', category: '해지' })
    expect(r.team).toContain('리텐션')
  })

  it('이탈 위험 점수만 높아도 리텐션팀으로 간다', () => {
    const r = routeTicket({ text: '그만 쓰려고요', category: '기타', churnScore: 75 })
    expect(r.team).toContain('리텐션')
  })

  it('요금 유형은 요금정산팀으로 간다', () => {
    expect(routeTicket({ text: '청구서가 이상해요', category: '요금' }).team).toContain('요금')
  })

  it('품질 장애는 네트워크팀으로 간다', () => {
    expect(routeTicket({ text: '인터넷이 또 느려요', category: '불만' }).team).toContain('네트워크')
  })

  it('해당 규칙이 없으면 기본 라우트로 간다', () => {
    expect(routeTicket({ text: '요금제 종류가 궁금해요', category: '기타' })).toEqual(DEFAULT_ROUTE)
  })

  it('인수가 없어도 터지지 않는다', () => {
    expect(routeTicket()).toEqual(DEFAULT_ROUTE)
    expect(routeTicket({})).toEqual(DEFAULT_ROUTE)
  })
})

describe('ticketTitle', () => {
  it('유형과 핵심 요구로 제목을 만든다', () => {
    const t = ticketTitle({ category: '해지', sentiment: '부정', intentKeywords: ['위약금 면제 요구'] })
    expect(t).toBe('[해지] 위약금 면제 요구')
  })

  it('강성이면 제목에 표시한다 (분류·정렬에 쓰인다)', () => {
    expect(ticketTitle({ category: '불만', sentiment: '강성', intentKeywords: ['보상 요구'] })).toContain('(강성)')
  })

  it('키워드가 없으면 요약 첫 줄을 쓴다', () => {
    expect(ticketTitle({ category: '요금', summary: ['이중 청구 확인 요청'] })).toContain('이중 청구')
  })

  it('아무것도 없으면 자리표시 제목을 쓴다', () => {
    expect(ticketTitle({})).toBe('[기타] 내용 확인 필요')
  })

  it('긴 제목은 40자로 자른다', () => {
    const t = ticketTitle({ category: '기타', intentKeywords: ['가'.repeat(100)] })
    expect(t.length).toBeLessThanOrEqual(50)
  })
})

describe('buildTicketDraft', () => {
  const TRANSCRIPT =
    '고객: 해지하려고 합니다 위약금 면제해 주세요 안 그러면 소비자원에 신고할 거예요\n상담사: 확인해 보겠습니다'

  it('담당·우선순위·SLA·배정 근거를 모두 담는다', () => {
    const d = buildTicketDraft({ transcript: TRANSCRIPT, category: '해지', sentiment: '강성' })
    expect(d.text).toContain('담당:')
    expect(d.text).toContain('우선순위')
    expect(d.text).toContain('배정 근거:')
    expect(d.route.priority).toBe('P1')
  })

  it('이탈 위험과 근거 발화를 인용한다 — 담당자가 원문을 다시 듣지 않아도 되게', () => {
    const churn = estimateChurn(TRANSCRIPT)
    const d = buildTicketDraft({ transcript: TRANSCRIPT, category: '해지', churn })
    expect(d.text).toContain('이탈 위험')
    expect(d.text).toContain('근거 발화')
    expect(d.text).toContain('규칙 기반 추정')
  })

  it('없는 값은 줄 자체를 넣지 않는다 (빈 항목으로 문서를 채우지 않는다)', () => {
    const d = buildTicketDraft({ transcript: '고객: 안녕하세요', category: '기타' })
    expect(d.text).not.toContain('통화 요약')
    expect(d.text).not.toContain('요청 조치')
    expect(d.text).not.toContain('이탈 위험')
    expect(d.text).not.toContain('근거 발화')
  })

  it('요약은 3줄, 조치는 4개까지만 넣는다', () => {
    const d = buildTicketDraft({
      transcript: '고객: 문의',
      summary: ['1', '2', '3', '4', '5'],
      actions: ['a', 'b', 'c', 'd', 'e', 'f'],
    })
    expect(d.text.match(/^ {2}\d\. /gm)).toHaveLength(3)
    expect(d.text.match(/^ {2}- /gm)).toHaveLength(4)
  })

  it('AI가 감면 여부를 결론 내지 않는다는 고지를 항상 붙인다', () => {
    const d = buildTicketDraft({ transcript: '고객: 문의' })
    expect(d.text).toContain('담당자가 판단')
  })

  it('인수가 없어도 티켓을 만든다', () => {
    const d = buildTicketDraft()
    expect(d.title).toBeTruthy()
    expect(d.text).toBeTruthy()
  })
})
