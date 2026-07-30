// Cloudflare Turnstile (Invisible) — API 호출마다 1회용 보안 토큰을 발급받는다.
// 방문자에게는 아무 UI도 보이지 않는다. 실패 시 null을 반환하고 요청은 그대로 진행되며,
// 차단 여부는 서버(TURNSTILE_SECRET 설정 시)가 결정한다.
const SITE_KEY = '0x4AAAAAAD9ftUjgMxSP9zwt'

let scriptPromise = null

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
    // 요청마다 새 컨테이너를 만든다. 예전에는 모듈 단위로 하나를 공유했는데,
    // 원클릭 파이프라인처럼 여러 요청이 동시에 토큰을 받으려 하면 같은 엘리먼트에
    // render가 겹쳐 대부분이 토큰 없이 끝났다. Turnstile 시크릿을 등록한 순간
    // 그 요청들이 403으로 막히는 함정이었다.
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;bottom:0;right:0;width:0;height:0;overflow:hidden'
    document.body.appendChild(box)

    return await new Promise((resolve) => {
      let settled = false
      let widgetId = null
      const finish = (token) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          if (widgetId != null) window.turnstile.remove(widgetId)
        } catch {
          /* 이미 제거된 경우 무시 */
        }
        box.remove()
        resolve(token)
      }
      const timer = setTimeout(() => finish(null), 15000)
      try {
        widgetId = window.turnstile.render(box, {
          sitekey: SITE_KEY,
          callback: (token) => finish(token),
          'error-callback': () => finish(null),
        })
      } catch {
        finish(null)
        return
      }
      if (widgetId == null) finish(null)
    })
  } catch {
    return null
  }
}
