const MODEL = 'claude-opus-5'

// 사용자가 Cloudflare에 등록한 시크릿 이름 그대로 읽는다.
// (기본 CLAUDE_API_KEY도 함께 지원 — 어느 이름으로 등록해도 동작)
const KEY_VARS = ['CLAUDE_API_KEY', 'callcenter-ax.pages.dev']
const KEY_PREFIX = 'sk-ant-'

// 시크릿 이름이 도메인이라, 그 변수에 키 대신 도메인 문자열이 들어가는 사고가 실제로
// 가능하다. 그 값을 그대로 x-api-key로 보내면 401이 나고 ladder가 원인을 삼켜 조용히
// 오픈소스로 강등되며, hasApiKey는 true를 돌려줘 health가 claude_key: true로 거짓
// 보고했다. 키가 아닌 것이 분명한 값(도메인·URL·공백 포함)은 없는 것으로 취급한다.
function keyLike(raw) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return ''
  if (v.startsWith(KEY_PREFIX)) return v
  if (/\s/.test(v)) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return ''
  if (/^[\w-]+(\.[\w-]+)+$/.test(v)) return ''
  return v
}

export function getApiKey(env) {
  const values = KEY_VARS.map((name) => keyLike(env?.[name]))
  // 접두사가 맞는 값을 먼저 고른다 — 앞 변수에 엉뚱한 값이 들어 있어도 뒤 변수의 진짜
  // 키를 쓸 수 있다. 기존 `a || b`는 앞의 쓰레기 값을 먼저 집어 401을 만들었다.
  return values.find((v) => v.startsWith(KEY_PREFIX)) || values.find(Boolean) || ''
}

export function hasApiKey(env) {
  return Boolean(getApiKey(env))
}

// ── 토큰 예산 ────────────────────────────────────────────────────────────────
// Opus 5는 thinking이 기본 활성이고 max_tokens는 thinking+응답 합산 상한이다.
// 호출부는 응답 길이만 보고 상한을 잡으므로(6000자 원문을 그대로 되돌려줘야 하는
// diarize가 6144) thinking이 더해지는 순간 상시 절단됐고, 절단은 ladder에서 오픈소스
// 재호출로 이어져 Claude 토큰 요금과 Workers AI 비용을 함께 물었다.
// max_tokens는 상한일 뿐 실제 생성량만 과금되므로, 여유를 두는 쪽이 항상 싸다.
const DEFAULT_MAX_TOKENS = 8192
const THINKING_HEADROOM = 8192
const MIN_BUDGET = 8192
// 한 번의 시도 타임아웃(40초) 안에 끝날 수 없을 만큼 큰 상한은 의미가 없어 여기서 자른다.
const MAX_BUDGET = 24000

// ── 시간 예산 ────────────────────────────────────────────────────────────────
const ATTEMPT_TIMEOUT_MS = 40000
// 남은 시간이 이보다 적으면 요청을 걸어도 응답 전에 데드라인을 넘긴다 — 즉시 실패시킨다.
const MIN_ATTEMPT_MS = 1500
const RETRY_WAIT_MS = 1500
// retry-after를 존중하되 상한을 둔다 — 공급자가 분 단위를 주면 엣지 한도를 넘긴다.
const RETRY_WAIT_CAP_MS = 10000
// 재시도가 의미 있으려면 최소한 이만큼은 남아 있어야 한다.
const MIN_RETRY_WINDOW_MS = 8000

const TIMEOUT_MESSAGE = 'AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.'

function fail(message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

function budgetFor(requested) {
  const base = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_MAX_TOKENS
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, base + THINKING_HEADROOM))
}

// deadlineAt이 없으면(직접 호출·테스트) 시간 제약 없이 동작한다.
function remainingMs(deadlineAt) {
  return deadlineAt ? deadlineAt - Date.now() : Infinity
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 재시도 전에 첫 응답 본문을 반드시 정리한다 — 방치하면 연결이 열린 채 남는다.
async function discardBody(res) {
  try {
    if (res?.body?.cancel) await res.body.cancel()
    else if (typeof res?.text === 'function') await res.text()
  } catch {
    // 본문 정리 실패는 흐름을 막을 이유가 없다
  }
}

// 429/5xx의 retry-after(초 또는 HTTP-date)를 존중한다. 헤더가 없거나 못 읽으면 기본 대기.
function retryWaitMs(res) {
  let raw = null
  try {
    raw = res?.headers?.get?.('retry-after') ?? null
  } catch {
    raw = null
  }
  if (raw == null || raw === '') return RETRY_WAIT_MS
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_WAIT_CAP_MS)
  const at = Date.parse(String(raw))
  if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_WAIT_CAP_MS)
  return RETRY_WAIT_MS
}

// 한 번의 요청(+429/5xx 1회 재시도)을 수행하고 파싱된 응답 본문을 돌려준다.
async function requestJson(apiKey, { system, user, tool, budget, deadlineAt }) {
  const doFetch = () => {
    const left = remainingMs(deadlineAt)
    // 남은 시간이 없으면 요청을 걸지 않는다 — 걸어도 엣지 한도를 넘겨 524가 되고
    // 그 경우 상위의 logCall이 실행되지 않아 텔레메트리가 0으로 남는다.
    if (left <= MIN_ATTEMPT_MS) throw fail(TIMEOUT_MESSAGE, 'deadline')
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // 외부 API 지연이 Functions 실행 한도까지 매달리지 않게 타임아웃을 건다.
      // 남은 데드라인이 더 짧으면 그쪽을 따른다.
      signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, left)),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: budget,
        output_config: { effort: 'medium' },
        // 시스템 프롬프트에 캐시 브레이크포인트 — tools+system 접두사가 5분간 캐시되어
        // 반복 호출(파이프라인·연속 시연)의 입력 비용과 지연을 줄인다.
        // 접두사가 최소 캐시 토큰(Opus 5는 512)에 못 미치면 조용히 무시되므로 손해가 없다.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
      }),
    })
  }

  let res
  try {
    res = await doFetch()
    // 일시적 과부하(429/529/5xx)는 잠깐 기다렸다 1회 재시도
    if (res.status === 429 || res.status >= 500) {
      const wait = retryWaitMs(res)
      await discardBody(res)
      // 대기까지 하고 나면 응답을 받을 시간이 없는 경우엔 재시도하지 않는다.
      if (remainingMs(deadlineAt) > wait + MIN_RETRY_WINDOW_MS) {
        if (wait > 0) await sleep(wait)
        res = await doFetch()
      }
    }
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw fail(TIMEOUT_MESSAGE, 'timeout')
    }
    throw err
  }

  if (!res.ok) {
    await discardBody(res)
    throw fail(`AI 서비스가 혼잡합니다 (${res.status}). 잠시 후 다시 시도해주세요.`, 'http')
  }
  return await res.json()
}

// tool 강제 호출로 구조화된 JSON을 받는 공용 헬퍼.
// Opus 5는 thinking이 기본 활성이고 max_tokens가 thinking+응답을 합산하므로 호출부의
// maxTokens에 여유분을 더해 상한을 잡고, effort=medium으로 분류·요약 작업의 비용을 조절한다.
// deadlineAt(절대 시각, ms)을 주면 모든 시도·대기를 그 안으로 제한한다.
// 반환값: { input: tool_use 블록의 input 객체, usage: 토큰 사용량 }
export async function callClaudeTool(env, { system, user, tool, maxTokens = DEFAULT_MAX_TOKENS, deadlineAt = null }) {
  const apiKey = getApiKey(env)
  if (!apiKey) throw fail('CLAUDE_API_KEY가 설정되지 않았습니다.', 'no_key')

  const budget = budgetFor(maxTokens)
  let data = await requestJson(apiKey, { system, user, tool, budget, deadlineAt })

  // 절단을 곧장 실패로 넘기면 ladder가 오픈소스를 재호출해 Claude 토큰 요금과
  // Workers AI 비용을 동시에 내고, 사용자는 폴백 결과를 본다. 상한을 키워 한 번 더
  // 시도해 이미 지불한 유료 호출을 살린다.
  if (data.stop_reason === 'max_tokens') {
    const bigger = Math.min(MAX_BUDGET, budget * 2)
    if (bigger > budget && remainingMs(deadlineAt) >= MIN_RETRY_WINDOW_MS) {
      data = await requestJson(apiKey, { system, user, tool, budget: bigger, deadlineAt })
    }
  }

  // 안전 분류기가 거절하면 HTTP 200 + stop_reason: 'refusal' + 빈/부분 content가 온다.
  // 이 앱은 소송·고소·언론 제보 같은 강성 민원 전사를 다뤄 현실적인 경로인데, 전용
  // 분기가 없던 탓에 뒤따르는 tool_use 탐색이 실패해 "결과를 찾을 수 없습니다"라는
  // 무관한 오류로 둔갑했다. content보다 stop_reason을 먼저 본다.
  if (data.stop_reason === 'refusal') {
    const err = fail(
      'AI 안전 정책에 따라 이 내용은 자동 분석이 거절되었습니다. 민감한 표현을 줄여 다시 시도해주세요.',
      'refusal'
    )
    err.category = data.stop_details?.category ?? null
    throw err
  }
  // max_tokens로 잘린 tool 입력은 불완전한 JSON일 수 있으므로 toolUse 존재 여부와 무관하게 거부한다.
  if (data.stop_reason === 'max_tokens') {
    throw fail('AI 응답이 너무 길어 중단되었습니다. 입력을 줄여 다시 시도해주세요.', 'max_tokens')
  }

  const toolUse = Array.isArray(data.content)
    ? data.content.find((block) => block.type === 'tool_use')
    : null
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    throw fail('AI 응답에서 결과를 찾을 수 없습니다. 잠시 후 다시 시도해주세요.', 'no_tool_use')
  }
  const usage = data.usage
    ? {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
        ...(data.usage.cache_read_input_tokens
          ? { cache_read_input_tokens: data.usage.cache_read_input_tokens }
          : {}),
      }
    : null
  return { input: toolUse.input, usage }
}

// 문자열로 옮겨도 뜻이 남는 값(문자열·숫자·불리언)만 문자열화한다.
// 객체·배열은 String()이 "[object Object]"를 만들어 화면에 그대로 노출되므로 제외한다.
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return null
}

// live 응답이 프론트가 기대하는 계약(필수 배열/문자열)을 지키는지 검증한다.
// tool_choice 강제로도 스키마 준수가 보장되지 않으므로, 어긴 응답은 폴백으로 돌려보낸다.
// - arrays: 배열이어야 하는 키. 요소는 원시값이면 문자열로 바꾸고, 객체 요소는
//   그대로 둔다(analyze-batch의 calls처럼 요소가 원래 레코드인 배열이 있다).
// - stringArrays: 요소까지 텍스트여야 하는 키. Array.isArray만 보던 탓에 요소가 객체여도
//   통과해 호출부의 join(' ')이 "[object Object]"를 만들고 근거율까지 왜곡됐다.
// - strings: 비어 있지 않은 문자열이어야 하는 키.
export function ensureContract(input, { arrays = [], strings = [], stringArrays = [] } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('AI 응답이 불완전합니다(형식 오류). 다시 시도해주세요.')
  }
  const incomplete = (key) => new Error(`AI 응답이 불완전합니다(${key} 누락). 다시 시도해주세요.`)

  for (const key of arrays) {
    if (!Array.isArray(input[key])) throw incomplete(key)
    input[key] = input[key].map((el) => {
      const text = textOf(el)
      return text === null ? el : text
    })
  }
  for (const key of stringArrays) {
    if (!Array.isArray(input[key])) throw incomplete(key)
    const texts = input[key].map(textOf)
    // 텍스트가 와야 할 자리에 레코드가 왔다면 응답 자체가 계약을 벗어난 것이다 —
    // 억지로 문자열화해 화면에 내보내지 말고 폴백으로 돌려보낸다.
    if (texts.some((t) => t === null)) throw incomplete(key)
    input[key] = texts
  }
  for (const key of strings) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw incomplete(key)
  }
  return input
}

// 공용 상담 도메인 안전 규칙 — 모든 LLM 프롬프트에 포함
export const CALL_SAFETY_RULES = `[상담 데이터 처리 안전 규칙 — 반드시 지킬 것]
- 통화 내용에 등장하는 이름·전화번호·주소 등 개인정보는 결과에 그대로 옮기지 말고 "고객"으로 일반화할 것
- 법적 분쟁, 소송 언급, 강성 민원, 보상 요구 건은 AI가 결론 내리지 말고 에스컬레이션으로 표시할 것
- 상담사나 고객에 대한 인신공격성 평가 금지 — 행동과 표현만 평가할 것
- 근거 없는 사실 단정 금지 — 통화 텍스트에 없는 내용을 지어내지 말 것`
