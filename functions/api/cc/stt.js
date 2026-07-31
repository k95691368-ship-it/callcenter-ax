import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
// 본문 이상(깨진 JSON·본문 상한 초과)을 원인 그대로 알리는 공용 헬퍼는 namespace로 받는다.
// 이 파일만 먼저 배포돼 헬퍼가 없는 http.js와 짝이 되면 named import는 모듈 로드 자체를
// 실패시켜 엔드포인트가 통째로 죽는다 — 안내 문구 하나 때문에 그 위험을 지지 않는다.
import * as httpLib from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'

// Workers AI에서 서빙되는 오픈소스 Whisper 계열 모델 (한국어 지원)
// 성능 평가(CER 비교) 시연을 위해 2종을 화이트리스트로 허용한다.
const MODELS = {
  turbo: '@cf/openai/whisper-large-v3-turbo',
  base: '@cf/openai/whisper',
}
// base64 기준 약 6MB 음성까지 허용 (Workers AI 입력 한도와 Functions 메모리 보호)
// 프론트(src/lib/audioChunk.js SERVER_MAX_B64_LENGTH)가 분할 임계값을 이 값에서 끌어다
// 쓰므로 export한다 — 두 숫자가 어긋나면 tests/sttPipeline.test.js가 깨진다.
export const MAX_B64_LENGTH = 8_400_000
// 바이트 배열 변환 비용이 큰 base 모델은 짧은 음성(비교 실험용)만 허용한다
export const MAX_B64_LENGTH_BASE = 3_000_000
// Whisper 추론이 Functions 실행 한도까지 매달리지 않게 거는 타임아웃
const AI_TIMEOUT_MS = 50000

const DEMO_TRANSCRIPT = `상담사: 안녕하세요, 한빛텔레콤 상담사 김하늘입니다. 상담 품질 향상을 위해 통화 내용이 녹음됩니다. 무엇을 도와드릴까요?
고객: 지금 쓰는 요금제가 너무 비싼 것 같아서요. 데이터를 많이 안 쓰는데 줄일 수 있나요?
상담사: 네, 본인 확인 먼저 진행하겠습니다. 명의자 성함과 생년월일 확인 부탁드립니다.
고객: 네, 확인했습니다.
상담사: 최근 3개월 평균 사용량 기준으로 슬림 8기가 요금제로 변경하시면 월 2만 원 절감됩니다.
고객: 그럼 그걸로 바꿔주세요.
상담사: 다음 달 1일부터 적용되도록 처리해 드리겠습니다. 더 도와드릴 부분 없으실까요?`

// base 모델(@cf/openai/whisper)의 입력은 base64 문자열이 아니라 정수 배열이다.
// 예전에는 atob → Uint8Array 채우기 → [...bytes] 스프레드로 같은 데이터를 두 번 복사했다
// (2MB 입력이면 요소 200만 개짜리 사본이 하나 더 생긴다). 모델이 받는 최종 형태가
// 일반 배열이므로 중간 Uint8Array를 없애고 한 번의 루프로 바로 채운다.
// 상한(2.25MB) 입력으로 재보면 예전 방식 75~104ms, 이 방식 13~18ms였다.
// (Array.from({length})나 Array.from(bin, fn)은 63~80ms로 오히려 느려서 쓰지 않는다)
// Uint8Array를 그대로 넘기는 것은 이 모델의 문서화된 입력 형식이 아니라 시도하지 않는다.
export function b64ToByteArray(b64) {
  const bin = atob(b64)
  // eslint-disable-next-line unicorn/no-new-array -- 길이를 미리 잡는 쪽이 5배 빠르다 (위 측정)
  const out = new Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 모델 하나를 호출한다. 지연시간은 모델별로 따로 재야 비교표가 의미를 갖는다
// (예전에는 요청 시작 시각 하나로 재서 레이트리밋 조회 시간까지 모델 지연에 섞였다).
async function runModel(env, modelKey, audioB64) {
  const startedAt = Date.now()
  // 모델별 입력 형식: turbo=base64 문자열, base=정수 배열
  const input = modelKey === 'base' ? { audio: b64ToByteArray(audioB64) } : { audio: audioB64 }
  let timer
  try {
    const result = await Promise.race([
      env.AI.run(MODELS[modelKey], input),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('전사가 지연되고 있습니다. 더 짧은 음성으로 시도해주세요.')),
          AI_TIMEOUT_MS
        )
      }),
    ])
    const text = typeof result?.text === 'string' ? result.text.trim() : ''
    if (!text) throw new Error('전사 결과가 비어 있습니다. 음성이 들리는 파일인지 확인해주세요.')
    return { text, model: MODELS[modelKey], latency: Date.now() - startedAt }
  } finally {
    // 응답을 보낸 뒤에도 50초 타이머가 살아 있으면 런타임·테스트가 그만큼 붙잡힌다.
    // (비교 모드에서는 타이머가 두 개 생기므로 특히 정리해야 한다)
    clearTimeout(timer)
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  // 데모 응답도 지연시간을 담아야 하므로 요청 진입 시각을 기준으로 잡는다
  const startedAt = Date.now()
  const body = await readJsonBody(request)
  // 본문이 상한을 넘거나 깨졌으면 그 사실을 그대로 알린다 — 예전에는 어느 쪽이든
  // "음성 데이터가 없습니다"로 뭉개져서, 잘린 업로드를 파일 선택 실수로 오해하게 했다.
  const bodyIssue = httpLib.bodyErrorResponse?.(body)
  if (bodyIssue) return bodyIssue
  const audioB64 = typeof body?.audio_b64 === 'string' ? body.audio_b64 : ''
  // 2종 모델 비교는 새 필드(compare)로만 켜진다 — 예전 요청({audio_b64})이나
  // {audio_b64, model}은 응답 필드까지 그대로 유지된다(PipelinePage 하위 호환).
  const wantCompare = body?.compare === true
  // 비교는 turbo(주) vs base(대조) 고정이다. compare와 model이 함께 오면 compare가 이긴다.
  const modelKey = wantCompare ? 'turbo' : body?.model === 'base' ? 'base' : 'turbo'
  const model = MODELS[modelKey]
  if (!audioB64) return errorJson('음성 데이터가 없습니다. 파일을 다시 선택해주세요.')
  if (audioB64.length > MAX_B64_LENGTH)
    return errorJson('파일이 너무 큽니다. 6MB 이하의 음성 파일을 올려주세요.', 413)
  // base 모델이 관여하면(단독이든 비교든) 변환 비용 때문에 짧은 음성만 받는다
  if ((modelKey === 'base' || wantCompare) && audioB64.length > MAX_B64_LENGTH_BASE)
    return errorJson('모델 비교는 2MB 이하의 짧은 음성으로만 가능합니다. (기본 전사는 6MB까지)', 413)

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  // AI 바인딩이 없는 환경(로컬 vite 등)에서는 데모 전사로 흐름을 유지한다
  if (!env.AI) {
    logCall(context, { endpoint: 'stt', mode: 'demo', startedAt })
    // 데모에도 latency를 담는다. 없으면 프론트가 모델명만 표시하고 비교표의 지연 칸이
    // "—"로 비어 화면이 고장난 것처럼 보였다. 이 값은 꾸며낸 추론 시간이 아니라
    // 이 요청을 처리한 실제 시간이고, demo:true와 함께 표시되므로 실측으로 오해되지 않는다.
    const latency = Date.now() - startedAt
    const payload = {
      demo: true,
      text: DEMO_TRANSCRIPT,
      model,
      latency,
      notice: 'AI 바인딩이 없는 환경이라 예시 전사를 표시합니다. 배포 환경에서는 실제 음성이 전사됩니다.',
    }
    // 비교 요청이면 대조 모델 자리도 채운다 — 안 채우면 비교표가 영원히 나타나지 않는다.
    // 두 칸의 전사가 같은 것은 같은 예시 문장을 쓰기 때문이며, 그럴싸한 오전사를
    // 지어내면 성능 비교를 조작하는 것이 된다.
    if (wantCompare) payload.alt = { demo: true, text: DEMO_TRANSCRIPT, model: MODELS.base, latency }
    return json(payload)
  }

  // 검사 순서가 중요하다: 거부될 요청이 공유 예산을 먼저 태우면 한 IP가 전체 서비스의
  // 하루치를 소진시킬 수 있다. 좁은 제한(IP)부터 확인하고 일일 예산은 마지막에 차감한다.
  //
  // 전사는 Whisper만 쓰고 LLM(Claude)을 쓰지 않으므로 LLM 일일 예산과 버킷을 나눈다.
  // 예전에는 같은 버킷을 써서, 27분 녹취 한 건(청크 30개)이 사이트 전체의 하루 예산
  // 300건 중 30건을 태웠다 — 긴 파일 열 건이면 그날 나머지 기능이 전부 데모로 강등됐다.
  const ip = await clientKey(request, env)
  // 분할 전사(청크 최대 30개) 한 번이 다른 시도와 겹쳐도 완주할 수 있게 여유를 둔다
  if (!(await checkRateLimit(env, `cc:stt:${ip}`, 40, 3600)))
    return errorJson('녹취 전사는 시간당 40회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:stt:all', 90, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:daily:stt', 600, 86400)))
    return errorJson('오늘의 전사 예산이 소진되었습니다. 내일 다시 시도해주세요.', 429)

  // 비교는 요청 1건이지만 유료 추론 2회다. 예산을 1회분만 태우면 하루 상한이 사실상
  // 두 배가 된다. 추가 차감이 실패하면 요청 전체를 거절하는 대신 비교만 생략한다 —
  // 주 전사는 이미 예산을 확보했으므로 그것까지 버리는 게 더 낭비다.
  let doAlt = wantCompare
  if (doAlt) {
    doAlt =
      (await checkRateLimit(env, 'cc:daily:stt', 600, 86400)) &&
      (await checkRateLimit(env, `cc:stt:${ip}`, 40, 3600))
  }

  // 두 모델을 동시에 굴린다. 순차로 하면 최악 100초(타임아웃 2번)가 되어 요청 자체가
  // 끊길 수 있고, 어차피 서로 독립된 호출이다. allSettled라 대조 모델이 실패해도
  // 주 전사는 살아남는다.
  const [primary, alt] = await Promise.allSettled([
    runModel(env, modelKey, audioB64),
    doAlt ? runModel(env, 'base', audioB64) : Promise.resolve(null),
  ])

  if (primary.status === 'rejected') {
    const why = primary.reason?.message ?? '알 수 없는 오류'
    // 비교 모드에서 주 모델만 실패했다면 이미 값을 치른 대조 모델 결과라도 살린다.
    // 502로 끝내면 성공한 유료 전사 한 건을 버리고 사용자는 아무것도 받지 못한다.
    if (alt.status === 'fulfilled' && alt.value) {
      logCall(context, { endpoint: 'stt', mode: 'live-base', startedAt })
      return json({
        demo: false,
        ...alt.value,
        notice: `주 모델(${MODELS.turbo}) 전사가 실패해 대조 모델 결과만 표시합니다. (${why})`,
      })
    }
    logCall(context, { endpoint: 'stt', mode: 'fallback', startedAt })
    return errorJson(`전사에 실패했습니다. ${why}`, 502)
  }

  // mode 문자열에 모델 키가 들어 있어야 운영 지표가 오픈소스 호출로 분류한다
  // (src/lib/statsSummary.js liveEngine이 'turbo'/'base'/'oss' 포함 여부로 가른다).
  logCall(context, { endpoint: 'stt', mode: doAlt ? 'live-turbo+base' : `live-${modelKey}`, startedAt })
  const payload = { demo: false, ...primary.value }
  if (wantCompare) {
    payload.alt =
      alt.status === 'fulfilled' && alt.value
        ? alt.value
        : {
            error: doAlt
              ? `비교 모델 전사 실패: ${alt.reason?.message ?? '알 수 없는 오류'}`
              : '전사 예산이 부족해 비교 모델은 생략했습니다. 주 모델 전사만 표시합니다.',
          }
  }
  return json(payload)
}
