import { describe, it, expect } from 'vitest'
import {
  parseKoreanNumber,
  extractNumericClaims,
  numericSupport,
  numericNotice,
} from '../src/lib/numericSupport.js'
import { groundedness } from '../src/lib/grounding.js'
import { FAQ_DOCS } from '../src/lib/faqDocs.js'

const DOCS = FAQ_DOCS.filter((d) => ['faq02', 'faq03'].includes(d.id))
  .map((d) => `${d.title} ${d.body}`)
  .join('\n')

describe('한국어 수사 정규화', () => {
  it('만·천 단위를 값으로 바꾼다', () => {
    expect(parseKoreanNumber('4만 4천')).toBe(44000)
    expect(parseKoreanNumber('2만 2천')).toBe(22000)
    expect(parseKoreanNumber('100억')).toBe(10_000_000_000)
  })

  it('쉼표·공백 표기를 같은 값으로 본다 (문서와 답변의 표기가 다를 수 있다)', () => {
    expect(parseKoreanNumber('44,000')).toBe(44000)
    expect(parseKoreanNumber(' 12 ')).toBe(12)
  })

  it('숫자가 없으면 null (억지로 0으로 만들지 않는다)', () => {
    expect(parseKoreanNumber('없음')).toBeNull()
    expect(parseKoreanNumber('')).toBeNull()
    expect(parseKoreanNumber(null)).toBeNull()
  })
})

describe('수치 표현 추출', () => {
  it('금액·기간·비율을 단위와 함께 뽑는다', () => {
    const claims = extractNumericClaims('월 4만 4천 원이고 약정은 14개월 남아 30% 할인됩니다')
    const byUnit = Object.fromEntries(claims.map((c) => [c.unit, c.value]))
    expect(byUnit['원']).toBe(44000)
    expect(byUnit['개월']).toBe(14)
    expect(byUnit['%']).toBe(30)
  })

  it('틀리면 분쟁이 되는 단위를 critical로 표시한다', () => {
    expect(extractNumericClaims('위약금 8만 원')[0].critical).toBe(true)
    expect(extractNumericClaims('3회선 결합')[0].critical).toBe(false)
  })
})

describe('근거율이 못 잡는 거짓을 잡는다', () => {
  // 실측: 문자 2-gram 근거율은 "월 4만 4천 원"과 "월 9만 9천 원"을 거의 구분하지 못한다.
  // 그런데 콜센터에서 틀리면 가장 비싼 것이 바로 그 숫자다.
  it('환각 금액은 근거율을 통과하지만 수치 검증에서 걸린다', () => {
    const hallucinated = '인터넷+TV 결합은 월 9만 9천 원입니다.'
    expect(groundedness(hallucinated, DOCS)).toBeGreaterThan(0.35) // 근거율 게이트 통과
    const n = numericSupport(hallucinated, DOCS)
    expect(n.ok).toBe(false)
    expect(n.unsupported[0].text).toContain('9만 9천')
  })

  it('문서에 있는 금액은 통과시킨다', () => {
    expect(numericSupport('인터넷+TV 결합은 월 4만 4천 원입니다.', DOCS).ok).toBe(true)
  })

  it('표기만 다른 같은 값도 통과시킨다 (문서는 4만 4천 원, 답변은 44,000원)', () => {
    expect(numericSupport('인터넷+TV 결합은 월 44,000원입니다.', DOCS).ok).toBe(true)
  })

  it('지어낸 기간도 잡는다', () => {
    expect(numericSupport('위약금은 해지 후 6개월 이내에 청구됩니다.', DOCS).ok).toBe(false)
  })

  it('질문에 있던 숫자를 되받는 것은 환각이 아니다', () => {
    const r = numericSupport('말씀하신 12만 원은 로밍 요금으로 확인됩니다', DOCS, '요금이 12만 원 나왔어요')
    expect(r.ok).toBe(true)
  })

  it('숫자가 없는 답변은 검증 대상이 아니다', () => {
    const r = numericSupport('이전 설치가 가능하면 위약금 없이 전환됩니다.', DOCS)
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(0)
  })

  it('회선 수처럼 덜 위험한 단위는 막지 않고 표시만 한다', () => {
    // 틀려도 분쟁이 되지 않는 값까지 강등하면 정상 답변이 과하게 버려진다
    const r = numericSupport('가족 결합은 최대 9회선까지 가능합니다.', DOCS)
    expect(r.unsupported.length).toBeGreaterThan(0)
    expect(r.ok).toBe(true)
  })

  it('빈 입력에서 터지지 않는다', () => {
    expect(numericSupport('', '').ok).toBe(true)
    expect(numericSupport(null, null).checked).toBe(0)
  })
})

describe('안내 문구', () => {
  it('어느 숫자가 문제인지 그대로 보여준다', () => {
    const note = numericNotice(numericSupport('위약금은 25만 원입니다.', DOCS))
    expect(note).toContain('25만 원')
    expect(note).toContain('원문에서 확인')
  })

  it('문제가 없으면 안내하지 않는다', () => {
    expect(numericNotice(numericSupport('위약금 없이 전환됩니다.', DOCS))).toBeNull()
  })
})

describe('복합 수사를 조각내지 않는다 (한국어 금액 표기의 대부분)', () => {
  const DOC = '인터넷+TV 결합은 월 4만 4천 원, 휴대폰 회선 포함 시 월 3만 9천 원부터다. 2회선 1만 4천 원 할인.'

  it('문서의 "4만 4천 원"에서 4만·4천을 낱개로 인정하지 않는다', () => {
    // 예전에는 낱개 숫자를 하나씩 긁어 40000·4000이 따로 저장됐다.
    // 그래서 문서에 없는 "월 4만 원"이 근거 있음으로 통과했다 — 한국어 금액이 대부분
    // 복합 수사라 이 구멍 하나로 수치 게이트가 사실상 열려 있었다.
    expect(numericSupport('월 4만 원입니다', DOC).ok).toBe(false)
    expect(numericSupport('월 4천 원입니다', DOC).ok).toBe(false)
    expect(numericSupport('월 3만 원입니다', DOC).ok).toBe(false)
  })

  it('문서에 실제로 있는 복합 금액은 그대로 통과시킨다', () => {
    expect(numericSupport('월 4만 4천 원입니다', DOC).ok).toBe(true)
    expect(numericSupport('2회선은 1만 4천 원 할인', DOC).ok).toBe(true)
  })

  it('표기가 달라도 같은 값이면 통과시킨다', () => {
    expect(numericSupport('월 44,000원입니다', DOC).ok).toBe(true)
  })
})
