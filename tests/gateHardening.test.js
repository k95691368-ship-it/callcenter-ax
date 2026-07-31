import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isRefusalAnswer, groundingVerdict } from '../functions/api/cc/search.js'
import { fallbackNotice } from '../functions/_lib/telemetry.js'

// 감사에서 확인된 것: 만들어 둔 방어층이 스스로 열리거나, 아예 연결되지 않았거나,
// 문구가 사실과 달랐다. 셋 다 "코드가 하는 말과 하는 일이 다른" 같은 종류의 실패다.

describe('거절 면제가 환각의 통로가 되지 않는다', () => {
  const FABRICATED =
    '약정 해지 시 위약금은 25만 원이며 3개월 내 청구됩니다. 이전 설치는 불가하고 별도 수수료 5만 원이 발생합니다. 가족 결합은 최대 9회선까지 가능하며 회선당 3만 원 할인됩니다. 다만 자세한 내용은 문서에 없습니다.'
  const REAL_REFUSAL = '제공된 문서에서 확인되지 않습니다. 가장 가까운 문서는 요금제 변경 규정입니다.'
  const REFUSAL_WITH_TAIL =
    '제공된 문서에서 확인되지 않습니다. 참고로 결합 할인 문서에는 회선 수별 할인액이 정리되어 있으니 그쪽을 확인해 주세요. 추가로 필요하시면 담당 부서로 문의하십시오.'

  it('지어낸 답변 끝에 "문서에 없습니다"를 붙여도 면제되지 않는다', () => {
    // 예전에는 이 문장이 거절로 분류돼 근거율 하한 게이트를 통째로 빠져나갔다
    expect(isRefusalAnswer(FABRICATED)).toBe(false)
    expect(groundingVerdict(0.1, FABRICATED)).toBe('reject')
  })

  it('진짜 거절은 여전히 강등하지 않는다 (없다고 말해야 할 자리에 발췌를 넣지 않는다)', () => {
    expect(isRefusalAnswer(REAL_REFUSAL)).toBe(true)
    expect(groundingVerdict(0.1, REAL_REFUSAL)).not.toBe('reject')
  })

  it('앞에서 거절하고 뒤에 안내를 덧붙인 답변도 거절로 본다', () => {
    expect(isRefusalAnswer(REFUSAL_WITH_TAIL)).toBe(true)
  })

  it('길이로 재지 않는다 — 짧은 창작도 면제되지 않는다', () => {
    const shortFabrication = '위약금은 25만 원입니다. 문서 기준입니다.'
    expect(isRefusalAnswer(shortFabrication)).toBe(false)
  })
})

describe('검색 자신도 게이트가 실제 경로에 붙어 있다', () => {
  // assessRetrieval을 만들어 놓고 골든셋 평가에서만 썼다 — "근거가 없으면 LLM을 부르기
  // 전에 물러난다"는 주장이 코드에서 성립하지 않았다.
  const src = readFileSync(new URL('../functions/api/cc/search.js', import.meta.url), 'utf8')

  it('search 엔드포인트가 assessRetrieval을 부른다', () => {
    expect(src).toContain('assessRetrieval(')
  })

  it('물러나는 분기가 LLM 사다리보다 먼저 온다 (호출 후에 판단하면 비용을 못 아낀다)', () => {
    const abstainAt = src.indexOf("level === 'none'")
    const ladderAt = src.indexOf('runLlmLadder(')
    expect(abstainAt).toBeGreaterThan(-1)
    expect(abstainAt).toBeLessThan(ladderAt)
  })

  it('물러날 때 답을 지어내지 않고 근거 없음을 말한다', () => {
    const at = src.indexOf("level === 'none'")
    const block = src.slice(at, at + 800)
    expect(block).toContain('abstained: true')
    expect(block).toMatch(/확인되지 않는/)
  })
})

describe('폴백 문구가 원인을 사실대로 말한다', () => {
  it('예산 소진을 "일시적 혼잡"이라고 하지 않는다', () => {
    const err = Object.assign(new Error('오늘의 유료 AI 예산이 소진되었습니다.'), { code: 'budget' })
    const note = fallbackNotice(err, '예시 결과')
    expect(note).toContain('예산')
    expect(note).not.toContain('혼잡')
    expect(note).toContain('24시간')
  })

  it('실제 혼잡·지연은 그대로 혼잡이라고 말한다', () => {
    const note = fallbackNotice(new Error('응답이 지연되고 있습니다'), '예시 결과')
    expect(note).toContain('혼잡')
    expect(note).toContain('지연')
  })

  it('원인 문구가 없어도 빈 괄호를 남기지 않는다', () => {
    expect(fallbackNotice(new Error(''), '예시 결과')).not.toContain('()')
    expect(fallbackNotice(null, '예시 결과')).not.toContain('()')
  })

  it('엔드포인트가 문구를 직접 짜지 않는다 (한 곳에서 만든다)', () => {
    for (const f of ['analyze', 'analyze-batch', 'qa', 'assist', 'search', 'diarize', 'voc-report']) {
      const s = readFileSync(new URL(`../functions/api/cc/${f}.js`, import.meta.url), 'utf8')
      expect(s).not.toContain('일시적인 AI 혼잡으로')
    }
  })
})
