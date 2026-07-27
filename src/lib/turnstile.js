// Cloudflare Turnstile (Invisible) — API 호출마다 1회용 보안 토큰을 발급받는다.
// 방문자에게는 아무 UI도 보이지 않는다. 실패 시 null을 반환하고 요청은 그대로 진행되며,
// 차단 여부는 서버(TURNSTILE_SECRET 설정 시)가 결정한다.
const SITE_KEY = '0x4AAAAAAD9ftUjgMxSP9zwt'

let scriptPromise = null
let container = null

function loadScript() {
  if (window.turnstile) return Promise.resolve()
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
  return scriptPromise
}

export async function getTurnstileToken() {
  try {
    await loadScript()
    if (!container) {
      container = document.createElement('div')
      container.style.cssText = 'position:fixed;bottom:0;right:0;width:0;height:0;overflow:hidden'
      document.body.appendChild(container)
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 15000)
      const done = (id, token) => {
        clearTimeout(timer)
        try {
          window.turnstile.remove(id)
        } catch {
          /* 이미 제거된 경우 무시 */
        }
        resolve(token)
      }
      const id = window.turnstile.render(container, {
        sitekey: SITE_KEY,
        callback: (token) => done(id, token),
        'error-callback': () => done(id, null),
      })
      if (id == null) {
        clearTimeout(timer)
        resolve(null)
      }
    })
  } catch {
    return null
  }
}
