import { json, errorJson, readJsonBody, clientIp } from '../../_lib/http.js'
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
const MAX_B64_LENGTH = 8_400_000

const DEMO_TRANSCRIPT = `상담사: 안녕하세요, 한빛텔레콤 상담사 김하늘입니다. 상담 품질 향상을 위해 통화 내용이 녹음됩니다. 무엇을 도와드릴까요?
고객: 지금 쓰는 요금제가 너무 비싼 것 같아서요. 데이터를 많이 안 쓰는데 줄일 수 있나요?
상담사: 네, 본인 확인 먼저 진행하겠습니다. 명의자 성함과 생년월일 확인 부탁드립니다.
고객: 네, 확인했습니다.
상담사: 최근 3개월 평균 사용량 기준으로 슬림 8기가 요금제로 변경하시면 월 2만 원 절감됩니다.
고객: 그럼 그걸로 바꿔주세요.
상담사: 다음 달 1일부터 적용되도록 처리해 드리겠습니다. 더 도와드릴 부분 없으실까요?`

// base 모델(@cf/openai/whisper)은 base64가 아니라 바이트 배열을 받는다
function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 바이트 배열 변환 비용이 큰 base 모델은 짧은 음성(비교 실험용)만 허용한다
const MAX_B64_LENGTH_BASE = 3_000_000

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const audioB64 = typeof body?.audio_b64 === 'string' ? body.audio_b64 : ''
  const modelKey = body?.model === 'base' ? 'base' : 'turbo'
  const model = MODELS[modelKey]
  if (!audioB64) return errorJson('음성 데이터가 없습니다. 파일을 다시 선택해주세요.')
  if (audioB64.length > MAX_B64_LENGTH)
    return errorJson('파일이 너무 큽니다. 6MB 이하의 음성 파일을 올려주세요.', 413)
  if (modelKey === 'base' && audioB64.length > MAX_B64_LENGTH_BASE)
    return errorJson('모델 비교는 2MB 이하의 짧은 음성으로만 가능합니다. (기본 전사는 6MB까지)', 413)

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()

  // AI 바인딩이 없는 환경(로컬 vite 등)에서는 데모 전사로 흐름을 유지한다
  if (!env.AI) {
    logCall(context, { endpoint: 'stt', mode: 'demo', startedAt })
    return json({
      demo: true,
      text: DEMO_TRANSCRIPT,
      model,
      notice: 'AI 바인딩이 없는 환경이라 예시 전사를 표시합니다. 배포 환경에서는 실제 음성이 전사됩니다.',
    })
  }

  if (!(await checkRateLimit(env, 'cc:daily:all', 300, 86400)))
    return errorJson('오늘의 전사 예산이 소진되었습니다. 내일 다시 시도해주세요.', 429)
  const ip = clientIp(request)
  if (!(await checkRateLimit(env, `cc:stt:${ip}`, 10, 3600)))
    return errorJson('녹취 전사는 시간당 10회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:stt:all', 60, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)

  try {
    // 모델별 입력 형식: turbo=base64 문자열, base=바이트 배열
    const input = modelKey === 'base' ? { audio: [...b64ToBytes(audioB64)] } : { audio: audioB64 }
    // Whisper 추론이 Functions 실행 한도까지 매달리지 않게 타임아웃을 건다
    const result = await Promise.race([
      env.AI.run(model, input),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('전사가 지연되고 있습니다. 더 짧은 음성으로 시도해주세요.')), 50000)
      ),
    ])
    const text = typeof result?.text === 'string' ? result.text.trim() : ''
    if (!text) throw new Error('전사 결과가 비어 있습니다. 음성이 들리는 파일인지 확인해주세요.')
    logCall(context, { endpoint: 'stt', mode: `live-${modelKey}`, startedAt })
    return json({ demo: false, text, model, latency: Date.now() - startedAt })
  } catch (err) {
    logCall(context, { endpoint: 'stt', mode: 'fallback', startedAt })
    return errorJson(`전사에 실패했습니다. ${err.message}`, 502)
  }
}
