// GET 응답 캐시 정책 — 엔드포인트마다 문자열을 흩어 놓으면 정책이 서로 어긋나므로 한곳에 모은다.
export const NO_STORE = 'no-store'
// 집계는 몇 초 늦어도 해가 없다. 반대로 캐시가 없으면 About 화면을 여는 사람마다,
// 새로고침마다 D1을 왕복한다 — 짧은 s-maxage로 그 왕복을 접는다.
export const SHORT_EDGE_CACHE = 'public, max-age=15, s-maxage=60, stale-while-revalidate=120'

// 캐시 헤더가 아예 없으면 브라우저 휴리스틱 캐싱에 맡겨져, 같은 URL의 응답이 언제까지
// 재사용될지 알 수 없었다(실시간이어야 할 상태가 stale로 보이거나, 캐시해도 되는 집계가
// 매번 재요청됨). 캐시 가능 여부는 응답을 만드는 쪽이 명시한다.
export function json(data, status = 200, { cacheControl } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' }
  if (cacheControl) headers['Cache-Control'] = cacheControl
  return new Response(JSON.stringify(data), { status, headers })
}

export function errorJson(message, status = 400) {
  // 거절 응답이 중간 캐시에 남으면 제한이 풀린 뒤에도 같은 거절이 재생될 수 있다.
  return json({ error: message }, status, { cacheControl: NO_STORE })
}

// 본문 상한 기본값 — 이 프로젝트에서 가장 큰 본문은 stt의 base64 음성(약 8.4MB)이다.
// 기본값을 그보다 낮추면 정상 요청이 막히므로 넉넉히 두되, 무한은 아니게 한다.
// (엔드포인트별로 더 좁은 상한을 주고 싶으면 readJsonBody(request, { maxBytes })를 쓴다)
export const DEFAULT_MAX_BODY_BYTES = 12_000_000

// 표식 키를 심볼로 둔다 — JSON.parse는 심볼 키를 만들 수 없으므로, 클라이언트가 본문에
// 같은 이름을 넣어 "본문 오류"인 척할 수 없다.
const BODY_ERROR_KEY = Symbol('bodyError')
const OVER_LIMIT = Symbol('over-limit')
// 오류 표식은 "필드가 없는 객체"라서, 기존 호출부의 body?.field 검사를 그대로 통과한다
// (동작이 바뀌지 않는다). 새 호출부만 bodyError로 원인을 구분하면 된다.
const bodyErrorMarker = (kind) => ({ [BODY_ERROR_KEY]: kind })

// 파싱 실패와 "본문이 비었음"을 구분한다. 예전에는 둘 다 null이라, 깨진 JSON을 보낸
// 요청에도 호출부가 "통화 전사 텍스트를 입력해주세요" 같은 엉뚱한 안내를 내보냈다.
export function bodyError(body) {
  return body && typeof body === 'object' ? body[BODY_ERROR_KEY] || null : null
}

// 호출부가 그대로 반환할 수 있는 응답. 본문 이상이 없으면 null.
export function bodyErrorResponse(body) {
  const kind = bodyError(body)
  if (kind === 'too-large')
    return errorJson('요청 본문이 너무 큽니다. 더 작은 단위로 나눠 보내주세요.', 413)
  if (kind === 'invalid-json')
    return errorJson('요청 형식이 올바르지 않습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 400)
  return null
}

export async function readJsonBody(request, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const raw = request?.headers?.get?.('Content-Length')
  const declared = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  const hasLength = Number.isFinite(declared) && declared >= 0
  // 상한을 넘는 본문은 파싱조차 하지 않는다. 예전에는 request.json()이 본문 전체를 먼저
  // 파싱한 뒤 호출부가 길이를 검사했으므로(stt의 base64 길이 검사), 초대형 본문 하나로
  // 파싱 단계에서 메모리를 태울 수 있었다.
  if (hasLength && declared > maxBytes) return bodyErrorMarker('too-large')

  const canText = typeof request?.text === 'function'
  const canStream = typeof request?.body?.getReader === 'function'
  // text()도 body 스트림도 없는 요청 객체(일부 테스트 목 등)는 예전처럼 json()으로 읽는다.
  // 상한 검사는 위에서 이미 끝났으므로 여기서 파싱해도 안전하다.
  if (!canText && !canStream) {
    if (typeof request?.json !== 'function') return null
    try {
      return await request.json()
    } catch {
      return bodyErrorMarker('invalid-json')
    }
  }

  let text
  try {
    // 길이를 아는 요청은 런타임의 text()에 맡기고, 모르는 요청만 상한을 세며 직접 읽는다.
    text = hasLength && canText ? await request.text() : await readCappedText(request, maxBytes)
  } catch {
    // 본문을 끝까지 읽지 못한 요청은 JSON으로 만들 수 없다 — 파싱 실패와 같이 취급한다.
    return bodyErrorMarker('invalid-json')
  }
  if (text === OVER_LIMIT) return bodyErrorMarker('too-large')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return bodyErrorMarker('invalid-json')
  }
}

// Content-Length가 없는(chunked) 요청은 길이를 미리 알 수 없다. 읽는 도중 상한을 넘는
// 순간 스트림을 끊어, 헤더를 숨긴 요청이 상한을 우회하지 못하게 한다.
async function readCappedText(request, maxBytes) {
  const reader = request?.body?.getReader?.()
  if (!reader) return await request.text()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength ?? value.length ?? 0
    if (total > maxBytes) {
      try {
        reader.cancel?.()
      } catch {
        // 이미 닫힌 스트림이면 무시한다
      }
      return OVER_LIMIT
    }
    chunks.push(value)
  }
  // 청크 경계가 UTF-8 글자 중간을 자를 수 있으므로 바이트를 먼저 합친 뒤 한 번에 디코딩한다
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength ?? c.length ?? 0
  }
  return new TextDecoder().decode(merged)
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
