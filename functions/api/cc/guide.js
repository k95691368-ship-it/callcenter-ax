import { json, errorJson, readJsonBody } from '../../_lib/http.js'
import { logCall } from '../../_lib/telemetry.js'
import { guideCall } from '../../../src/lib/scriptGuide.js'

// 통화 중 실시간 스크립트 가이드.
//
// 다른 엔드포인트와 달리 LLM을 전혀 호출하지 않는다. 이유는 두 가지다.
//   1. 통화 중에 쓰는 기능이라 응답이 즉시여야 한다. 수 초 지연은 쓸 수 없다는 뜻이다.
//   2. 규칙으로 답할 수 있는 질문("녹취 고지를 했는가")에 LLM을 부르는 것은 낭비다.
// 그래서 레이트리밋도 두지 않는다 — 과금도, 외부 호출도 없기 때문이다.
// 대신 입력 길이 상한은 둔다(CPU 보호).
//
// LLM이 필요한 제안(다음 응대 멘트 생성·근거 규정 검색)은 /api/cc/assist가 담당한다.
// 이 둘은 경쟁이 아니라 역할 분담이다: 여기는 "빠뜨린 절차", 저기는 "무슨 말을 할까".

const MAX_CHARS = 8000

export async function onRequestPost(context) {
  const { request } = context
  const body = await readJsonBody(request)
  const dialogue = typeof body?.dialogue === 'string' ? body.dialogue.trim().slice(0, MAX_CHARS) : ''
  if (!dialogue) return errorJson('진행 중인 대화를 입력해주세요.')

  const startedAt = Date.now()
  const guide = guideCall(dialogue)
  // 텔레메트리는 남긴다 — 이 기능이 실제로 쓰이는지는 알아야 한다(입력 내용은 저장하지 않는다)
  logCall(context, { endpoint: 'guide', mode: 'rules', startedAt })
  return json({ demo: false, engine: 'rules', ...guide })
}
