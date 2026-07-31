import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { logCall } from '../../_lib/telemetry.js'
import { guideCall } from '../../../src/lib/scriptGuide.js'

// 통화 중 실시간 스크립트 가이드.
//
// 다른 엔드포인트와 달리 LLM을 전혀 호출하지 않는다. 이유는 두 가지다.
//   1. 통화 중에 쓰는 기능이라 응답이 즉시여야 한다. 수 초 지연은 쓸 수 없다는 뜻이다.
//   2. 규칙으로 답할 수 있는 질문("녹취 고지를 했는가")에 LLM을 부르는 것은 낭비다.
// "과금도 외부 호출도 없으니 레이트리밋도 없다"고 적어 두었는데, 그 판단이 틀렸다.
// 이 엔드포인트는 요청마다 D1에 텔레메트리를 INSERT한다 — 인증도 상한도 없는 쓰기다.
// 두 가지가 걸린다: 누구나 D1 쓰기를 무제한 유발할 수 있고(운영 비용·용량),
// 공개 지표(About의 "누적 AI 호출")를 원하는 만큼 부풀릴 수 있다.
// 통화 중에 쓰는 기능이라 사람이 낼 수 있는 빈도는 넉넉히 열어 두되, 상한은 둔다.
//
// LLM이 필요한 제안(다음 응대 멘트 생성·근거 규정 검색)은 /api/cc/assist가 담당한다.
// 이 둘은 경쟁이 아니라 역할 분담이다: 여기는 "빠뜨린 절차", 저기는 "무슨 말을 할까".

const MAX_CHARS = 8000

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const dialogue = typeof body?.dialogue === 'string' ? body.dialogue.trim().slice(0, MAX_CHARS) : ''
  if (!dialogue) return errorJson('진행 중인 대화를 입력해주세요.')

  // 통화 한 건을 진행하며 몇 초마다 눌러도 넉넉한 값이다. LLM을 부르지 않으므로
  // 다른 엔드포인트(시간당 6~10회)보다 훨씬 크게 잡되, 무제한으로 두지는 않는다.
  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:guide:${ip}`, 240, 3600)))
    return errorJson('요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.', 429)

  const startedAt = Date.now()
  const guide = guideCall(dialogue)
  // 텔레메트리는 남긴다 — 이 기능이 실제로 쓰이는지는 알아야 한다(입력 내용은 저장하지 않는다)
  logCall(context, { endpoint: 'guide', mode: 'rules', startedAt })
  return json({ demo: false, engine: 'rules', ...guide })
}
