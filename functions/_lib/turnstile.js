// Turnstile 서버 검증 — 요청이 진짜 브라우저에서 왔는지 Cloudflare에 확인한다.
// TURNSTILE_SECRET 미설정 시(로컬 개발 등) 검증 없이 통과시킨다(fail-open).
export async function verifyTurnstile(env, request) {
  const secret = env.TURNSTILE_SECRET
  if (!secret) return true

  const token = request.headers.get('x-turnstile-token')
  if (!token) return false

  try {
    const params = new URLSearchParams({ secret, response: token })
    const ip = request.headers.get('CF-Connecting-IP')
    if (ip) params.set('remoteip', ip)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      body: params,
    })
    const data = await res.json()
    return data.success === true
  } catch {
    // 검증 서비스 장애가 데모 전체를 막지 않도록 통과시킨다
    return true
  }
}
