import { describe, it, expect } from 'vitest'
import { applyLexicon } from '../src/lib/domainLexicon.js'
import { routeTicket } from '../src/lib/ticketDraft.js'
import { estimateChurn } from '../src/lib/churnRisk.js'
import { extractThemes } from '../src/lib/vocThemes.js'
import { ESCALATION_TERMS, ESCALATION_RE, termsPattern } from '../src/lib/escalationTerms.js'

// 도메인 사전이 표제어를 정규화하면, 축약형만 아는 하류 규칙이 통째로 빗나간다.
// 이건 사전이 정확해질수록 하류가 더 많이 놓치는 구조라 시간이 갈수록 나빠진다.
// 그래서 "사전을 통과한 통화와 원문의 판정이 같은가"를 직접 확인한다.

const LEGAL_CALL =
  '상담사: 안녕하세요, 한빛텔레콤입니다.\n고객: 인터넷이 자꾸 느려요. 이거 안 고쳐주면 방통위에 신고하겠습니다.'

describe('사전 보정이 판정을 바꾸지 않는다', () => {
  it('보정 전후로 배정 부서·우선순위가 같다', () => {
    // 실측(수정 전): 법무·분쟁 대응팀 P1 → 네트워크 품질팀 P2로 강등됐다.
    // 가장 급한 통화가 조용히 일반 통화가 되는 자리라 무게가 다르다.
    const raw = routeTicket({ text: LEGAL_CALL })
    const fixed = routeTicket({ text: applyLexicon(LEGAL_CALL).text })
    expect(raw.team).toBe('법무·분쟁 대응팀')
    expect(fixed.team).toBe(raw.team)
    expect(fixed.priority).toBe(raw.priority)
  })

  it('보정 전후로 이탈 위험 점수가 같다', () => {
    // 실측(수정 전): 20점 → 0점
    const raw = estimateChurn(LEGAL_CALL)
    const fixed = estimateChurn(applyLexicon(LEGAL_CALL).text)
    expect(raw.score).toBeGreaterThan(0)
    expect(fixed.score).toBe(raw.score)
  })

  it('보정 전후로 원인 분류가 같다', () => {
    const ids = (t) => extractThemes({ transcript: t }).map((x) => x.id).sort()
    expect(ids(applyLexicon(LEGAL_CALL).text)).toEqual(ids(LEGAL_CALL))
  })

  it('사전이 아는 모든 표제어에 대해 축약형과 정식 명칭이 함께 걸린다', () => {
    // 목록에 한쪽만 넣는 실수를 막는다 — 이번 결함이 정확히 그것이었다.
    for (const pair of [['방통위', '방송통신위원회']]) {
      for (const term of pair) expect(ESCALATION_RE.test(`고객: ${term}에 신고하겠습니다`)).toBe(true)
    }
  })
})

describe('공용 어휘 목록', () => {
  it('세 규칙이 같은 목록을 쓴다 (한 곳만 고쳐지는 일이 없게)', () => {
    // 목록에 새 낱말을 넣으면 세 판정 모두에 즉시 반영돼야 한다
    const term = ESCALATION_TERMS.find((t) => t === '소비자원')
    expect(term).toBeTruthy()
    const call = `고객: ${term}에 접수하겠습니다`
    expect(routeTicket({ text: call }).team).toBe('법무·분쟁 대응팀')
    expect(estimateChurn(call).score).toBeGreaterThan(0)
    expect(extractThemes({ transcript: call }).some((t) => t.id === 'legal')).toBe(true)
  })

  it('정규식 메타문자가 든 낱말이 들어와도 깨지지 않는다', () => {
    const re = termsPattern(['가(나', '다.라'])
    expect(re.test('가(나')).toBe(true)
    expect(re.test('다X라')).toBe(false) // '.'이 이스케이프돼 임의 문자로 동작하지 않는다
  })
})
