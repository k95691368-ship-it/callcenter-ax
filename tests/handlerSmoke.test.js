import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'

// 모든 엔드포인트를 **실제로 실행해** 500이 나지 않는지 본다.
//
// 왜 필요한가:
// 검색의 기권 경로가 선언되지 않은 변수(`...rewriteMeta`)를 펼치다 ReferenceError로
// 터지고 있었다. 무관한 질문을 검색한 모든 요청이 500이었는데 테스트 749개가 전부
// 통과했다 — 그 경로를 실행해 본 테스트가 하나도 없었기 때문이다.
// 개별 함수를 아무리 촘촘히 검사해도, 핸들러를 끝까지 돌려보지 않으면 이런 결함은
// 배포까지 간다. 그래서 이 파일은 단언을 얇게 두고 **경로를 넓게** 밟는다.
//
// 바인딩(D1·AI·Vectorize)이 전부 없는 환경으로 돌린다. 그게 데모 경로이자
// 심사자가 API 키 없이 열어볼 때의 상태이며, 폴백 코드가 가장 많이 도는 조합이다.

const API_DIR = new URL('../functions/api/cc/', import.meta.url)

// 엔드포인트별 최소 유효 입력. 값이 없으면 400이 정상이므로 그것도 함께 확인한다.
const BODIES = {
  analyze: { transcript: '상담사: 안녕하세요 한빛텔레콤입니다\n고객: 요금이 이상해요' },
  'analyze-batch': { calls: [{ id: 'c1', transcript: '고객: 인터넷이 느려요' }] },
  qa: { transcript: '상담사: 안녕하세요 통화 내용이 녹음됩니다\n고객: 네' },
  search: { question: '해지 위약금 규정' },
  assist: { transcript: '고객: 요금제를 바꾸고 싶어요' },
  diarize: { transcript: '안녕하세요 한빛텔레콤입니다 요금이 이상해서 전화드렸어요' },
  guide: { transcript: '고객: 해지하고 싶은데요 위약금이 얼마죠' },
  stt: { audio_b64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=' },
  'voc-report': { stats: { total: 3, byCategory: [{ name: '요금', count: 2 }] } },
}

// 답이 없어야 정상인 질의 — 기권 경로를 실제로 밟는다(이번 결함이 났던 자리다).
const EXTRA_CASES = [
  { endpoint: 'search', body: { question: '점심 메뉴 추천해줘' }, label: '무관 질의(기권)' },
  { endpoint: 'search', body: { question: '오늘 서울 날씨 어때' }, label: '무관 질의(기권) 2' },
]

const endpoints = readdirSync(API_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => f.replace(/\.js$/, ''))

const ctx = (body) => ({
  request: new Request('https://example.test/api/cc/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
  env: {},
  waitUntil: () => {},
})

describe('엔드포인트 스모크 — 핸들러를 끝까지 돌려본다', () => {
  it('점검 대상이 비어 있지 않다 (디렉터리를 못 읽으면 이 파일은 아무것도 지키지 않는다)', () => {
    expect(endpoints.length).toBeGreaterThan(5)
  })

  for (const name of endpoints) {
    it(`${name}: 유효 입력에서 예외 없이 응답한다`, async () => {
      const mod = await import(new URL(`${name}.js`, API_DIR).href)
      if (typeof mod.onRequestPost !== 'function') return // GET 전용(health·stats 등)
      const body = BODIES[name] ?? {}
      const res = await mod.onRequestPost(ctx(body))
      expect(res).toBeInstanceOf(Response)
      // 입력을 준 엔드포인트는 200, 안 준 곳은 400이어야 한다 — 어느 쪽이든 500은 아니다
      expect(res.status).toBeLessThan(500)
      await expect(res.json()).resolves.toBeTypeOf('object')
    })

    it(`${name}: 빈 본문에서 예외 없이 거절한다`, async () => {
      const mod = await import(new URL(`${name}.js`, API_DIR).href)
      if (typeof mod.onRequestPost !== 'function') return
      const res = await mod.onRequestPost(ctx({}))
      expect(res.status).toBeLessThan(500)
    })
  }

  for (const c of EXTRA_CASES) {
    it(`${c.endpoint}: ${c.label}에서도 500이 아니다`, async () => {
      const mod = await import(new URL(`${c.endpoint}.js`, API_DIR).href)
      const res = await mod.onRequestPost(ctx(c.body))
      expect(res.status).toBe(200)
      const data = await res.json()
      // 기권은 "답을 못 만든 것"이 아니라 "만들지 않기로 한 것"이라 사실을 함께 말해야 한다
      expect(data.abstained).toBe(true)
      expect(data.notice).toBeTruthy()
    })
  }
})
