// 배포 스모크 테스트 — AI 비용·레이트리밋을 소비하지 않는 결정적 점검만 수행한다.
// 사용: npm run smoke  (기본 프로덕션) / SMOKE_BASE=http://localhost:8788 npm run smoke
const BASE = process.env.SMOKE_BASE || 'https://callcenter-ax.pages.dev'

const results = []
let failed = false

async function check(name, fn) {
  try {
    await fn()
    results.push(`  OK   ${name}`)
  } catch (err) {
    results.push(`  FAIL ${name} — ${err.message}`)
    failed = true
  }
}

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) })
  return res
}

await check('홈 200 + SPA 루트', async () => {
  const res = await get('/')
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const html = await res.text()
  if (!html.includes('id="root"')) throw new Error('root 엘리먼트 없음')
})

await check('404 경로 SPA 폴백 (200)', async () => {
  const res = await get('/no-such-page')
  if (res.status !== 200) throw new Error(`status ${res.status}`)
})

await check('헬스체크 — 바인딩 상태', async () => {
  const res = await get('/api/cc/health')
  const d = await res.json()
  if (!d.ok) throw new Error('ok:false')
  if (typeof d.workers_ai !== 'boolean' || typeof d.d1 !== 'boolean') throw new Error('바인딩 필드 누락')
  if (!d.llm_engine) throw new Error('llm_engine 누락')
})

await check('운영 지표 집계', async () => {
  const res = await get('/api/cc/stats')
  const d = await res.json()
  if (!d.ok || !Array.isArray(d.rows)) throw new Error('집계 응답 형식 오류')
})

await check('정적 자산 (OG 이미지·샘플 음성·robots)', async () => {
  for (const p of ['/og.png', '/sample-call.wav', '/robots.txt']) {
    const res = await get(p)
    if (res.status !== 200) throw new Error(`${p} → ${res.status}`)
  }
})

await check('보안 응답 헤더 (nosniff·frame·referrer·permissions)', async () => {
  const res = await get('/')
  const need = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']
  for (const h of need) {
    if (!res.headers.get(h)) throw new Error(`${h} 누락`)
  }
})

// 규칙 전용 엔드포인트라 AI 비용이 들지 않는다 — 스모크에서 판정 내용까지 확인할 수 있는
// 유일한 기능이므로, 응답 형태만 보지 말고 실제로 맞게 판단하는지까지 검사한다.
await check('통화 중 가이드 (규칙 엔진 — AI 비용 없이 동작 확인)', async () => {
  const res = await fetch(`${BASE}/api/cc/guide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dialogue: '상담사: 안녕하세요 한빛텔레콤입니다\n고객: 해지하고 싶은데요',
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (res.status !== 200) throw new Error(`status ${res.status}`)
  const d = await res.json()
  if (d.engine !== 'rules') throw new Error(`engine=${d.engine} (rules여야 함)`)
  // 첫인사는 했고 녹취 고지는 안 한 상태 → 다음 할 일로 녹취 고지가 나와야 한다
  if (!d.nextActions?.some((a) => a.id === 'recording')) throw new Error('녹취 고지 제안 누락')
  // 고객의 해지 의사는 경보로 잡혀야 한다
  if (!d.alerts?.some((a) => a.kind === 'risk')) throw new Error('이탈 위험 경보 누락')
})

await check('빈 입력 검증 (400) — analyze·assist·analyze-batch·guide', async () => {
  for (const ep of ['/api/cc/analyze', '/api/cc/assist', '/api/cc/analyze-batch', '/api/cc/guide']) {
    const res = await fetch(`${BASE}${ep}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    })
    if (res.status !== 400) throw new Error(`${ep} → ${res.status} (400이어야 함)`)
  }
})

console.log(`스모크 테스트 — ${BASE}`)
console.log(results.join('\n'))
console.log(failed ? '결과: 실패' : '결과: 전부 통과')
if (failed) process.exit(1)
