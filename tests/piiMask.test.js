import { describe, it, expect } from 'vitest'
import { maskPii, maskNotice, PII_RULES } from '../src/lib/piiMask.js'
import { SAMPLE_CALLS } from '../src/lib/sampleCalls.js'

const m = (s) => maskPii(s).text

describe('가려야 할 것을 가린다', () => {
  it('주민등록번호 — 하이픈이 있든 없든', () => {
    expect(m('제 주민번호는 940101-1234567 입니다')).toBe('제 주민번호는 940101-1****** 입니다')
    expect(m('9401011234567 로 확인해주세요')).toBe('9401011****** 로 확인해주세요')
  })

  it('연락처 — 앞 국번과 끝 4자리만 남긴다 (본인확인 동선은 유지)', () => {
    expect(m('010-1234-5678 로 연락주세요')).toBe('010-****-5678 로 연락주세요')
    expect(m('01012345678 입니다')).toBe('010****5678 입니다')
    expect(m('02-123-4567 로 전화주세요')).toBe('02-***-4567 로 전화주세요')
  })

  it('카드번호 — 끝 4자리만 남긴다', () => {
    expect(m('카드번호 4532-0151-1283-0366 로 결제할게요')).toBe(
      '카드번호 ****-****-****-0366 로 결제할게요'
    )
  })

  it('계좌번호 — 같은 줄에 단서가 있을 때만 가린다', () => {
    expect(m('계좌는 국민은행 123456-01-123456 입니다')).toContain('***456')
    // 접수번호는 개인정보가 아니다 — 숫자 모양이 같아도 건드리지 않는다
    expect(m('접수번호 123456-01-123456 확인했어요')).toBe('접수번호 123456-01-123456 확인했어요')
  })

  it('이메일 — 첫 글자와 도메인만 남긴다', () => {
    expect(m('이메일은 hong.gil@example.co.kr 입니다')).toBe('이메일은 h*******@example.co.kr 입니다')
  })
})

describe('개인정보가 아닌 숫자는 건드리지 않는다 (오검출이 나면 통화 내용이 망가진다)', () => {
  const safe = [
    '이번 달 요금이 12만 원 나왔어요',
    '위약금 8만 4천 원이 발생합니다',
    '최근 3개월 평균 데이터 사용량이 6기가입니다',
    '월 4만 9천 원의 슬림 8기가 요금제',
    '2026-07-21 접수',
    '오늘 18시 전까지 연락드리겠습니다',
    '매월 15일 출금인데 25일로 변경',
    '5G 요금제요',
    '3년 약정 중 14개월 남았습니다',
  ]
  for (const s of safe) {
    it(`그대로 둔다: ${s}`, () => {
      const r = maskPii(s)
      expect(r.total).toBe(0)
      expect(r.text).toBe(s)
    })
  }

  it('내장 샘플 통화 10건에서 오검출이 없다', () => {
    for (const c of SAMPLE_CALLS) {
      expect(maskPii(c.transcript).total).toBe(0)
    }
  })
})

describe('자릿수를 보존한다 (CER 정렬과 문자 오프셋이 밀리지 않게)', () => {
  const cases = [
    '주민번호 940101-1234567',
    '연락처 010-1234-5678',
    '카드 4532-0151-1283-0366',
    '메일 hong.gil@example.co.kr',
  ]
  for (const s of cases) {
    it(`길이가 같다: ${s}`, () => {
      expect(maskPii(s).text).toHaveLength(s.length)
    })
  }

  it('여러 종류가 한 줄에 섞여 있어도 길이가 같다', () => {
    const s = '940101-1234567 / 010-1234-5678 / a@b.com'
    expect(maskPii(s).text).toHaveLength(s.length)
  })
})

describe('무엇을 얼마나 가렸는지 돌려준다', () => {
  it('종류별 건수를 센다', () => {
    const r = maskPii('940101-1234567 그리고 010-1234-5678 또 010-9999-8888')
    expect(r.total).toBe(3)
    expect(r.hits.find((h) => h.type === 'phone').count).toBe(2)
    expect(r.hits.find((h) => h.type === 'rrn').count).toBe(1)
  })

  it('가린 게 없으면 안내하지 않는다', () => {
    expect(maskNotice(maskPii('요금 문의드립니다'))).toBeNull()
  })

  it('안내 문구에 종류와 건수가 들어간다', () => {
    const note = maskNotice(maskPii('010-1234-5678'))
    expect(note).toContain('연락처')
    expect(note).toContain('1건')
  })

  it('빈 입력·null에서 터지지 않는다', () => {
    expect(maskPii('').text).toBe('')
    expect(maskPii(null).text).toBe('')
    expect(maskPii(undefined).total).toBe(0)
  })
})

describe('규칙 표 자체의 계약', () => {
  it('주민등록번호를 카드번호보다 먼저 본다 (13자리가 카드로 잡히지 않게)', () => {
    const order = PII_RULES.map((r) => r.type)
    expect(order.indexOf('rrn')).toBeLessThan(order.indexOf('card'))
  })

  it('모든 규칙에 사람이 읽을 이름이 있다 (화면 안내에 그대로 쓰인다)', () => {
    expect(PII_RULES.every((r) => r.label && r.re && typeof r.mask === 'function')).toBe(true)
  })
})
