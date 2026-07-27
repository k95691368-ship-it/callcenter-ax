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

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown'
}
