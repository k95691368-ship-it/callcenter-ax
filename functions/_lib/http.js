export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function errorJson(message, status = 400) {
  return json({ error: message }, status)
}

export async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

// 레이트리밋 버킷 키 — IP 원문을 저장하지 않기 위해 날짜별로 회전하는 해시를 쓴다.
// 버킷 문자열은 D1(rate_limit_hits)에 남으므로, 여기에 IP가 그대로 들어가면
// "개인정보 미수집·IP 미저장" 원칙이 깨진다. 날짜를 솔트에 섞어 하루가 지나면
// 같은 IP도 다른 키가 되게 하고(장기 추적 불가), 앞 16자만 남긴다.
export async function clientKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (ip === 'unknown') return 'unknown'
  try {
    const salt = env?.RL_SALT || 'callcenter-ax'
    const day = new Date().toISOString().slice(0, 10)
    const data = new TextEncoder().encode(`${salt}:${day}:${ip}`)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 16)
  } catch {
    // 해시를 만들 수 없으면 IP를 저장하는 대신 제한을 전역으로 묶는다.
    return 'nohash'
  }
}
