import { getTurnstileToken } from './turnstile.js'

export async function postJson(path, body) {
  const token = await getTurnstileToken()
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-turnstile-token': token } : {}),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error || `요청 실패 (${res.status})`)
  }
  return data
}
