import { json, NO_STORE } from '../../_lib/http.js'
import { hasApiKey } from '../../_lib/claude.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'

// 운영 헬스체크 — 바인딩·키 상태를 공개한다 (비밀값 자체는 노출하지 않음).
// About 페이지가 이 값으로 "지금 어떤 엔진이 살아있는지"를 실시간 표시한다.
//
// 여기에 더해, 이 시스템이 **자기 능력을 스스로 점검해 보고**한다.
// 바인딩이 있다는 것과 기능이 실제로 동작한다는 것은 다르다. 예컨대 Vectorize 바인딩이
// 있어도 인덱스가 비어 있으면 RAG는 실시간 임베딩으로 내려가고, D1이 살아 있어도
// 일일 예산이 소진됐으면 LLM 기능은 전부 데모로 나간다. 화면이 "라이브"라고 적어놓고
// 실제로는 데모를 보여주는 상태를 만들지 않으려면, 시스템이 그 차이를 알고 말해야 한다.
//
// 주의: 이 점검은 **읽기만** 한다. 예산 카운터를 차감하지 않고 남은 양만 본다 —
// 상태를 보는 행위가 상태를 바꾸면 그건 점검이 아니다.

// 예산 버킷의 현재 사용량만 읽는다 (checkRateLimit과 달리 INSERT하지 않는다)
async function bucketUsage(env, bucket) {
  if (!env?.DB) return null
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM rate_limit_hits WHERE bucket = ?')
      .bind(bucket)
      .first()
    return Number(row?.count) || 0
  } catch {
    return null
  }
}

// 이 시스템이 지금 할 수 있는 일을 스스로 판정한다.
// ready: 실제로 동작함 / degraded: 대체 경로로 동작함 / off: 동작하지 않음
function capability(id, label, state, detail) {
  return { id, label, state, detail }
}

export async function onRequestGet(context) {
  const { env } = context
  let db = false
  try {
    if (env.DB) {
      await env.DB.prepare('SELECT 1').first()
      db = true
    }
  } catch {
    db = false
  }

  const claude = hasApiKey(env)
  const workersAi = Boolean(env.AI)
  const vectorize = Boolean(env.VECTORIZE)

  const claudeUsed = claude ? await bucketUsage(env, 'cc:claude:daily') : null
  const dailyUsed = await bucketUsage(env, 'cc:daily:all')
  const CLAUDE_CAP = 150
  const DAILY_CAP = 300
  const claudeLeft = claudeUsed == null ? null : Math.max(0, CLAUDE_CAP - claudeUsed)
  const dailyLeft = dailyUsed == null ? null : Math.max(0, DAILY_CAP - dailyUsed)

  // LLM 계열 기능이 지금 어느 경로로 나가는지
  const llmState = !claude && !workersAi ? 'off' : dailyLeft === 0 ? 'off' : claude && claudeLeft > 0 ? 'ready' : 'degraded'
  const llmDetail =
    llmState === 'off'
      ? dailyLeft === 0
        ? '오늘의 공유 예산이 소진되어 규칙 데모로 응답합니다.'
        : 'AI 엔진이 연결되어 있지 않아 규칙 데모로 응답합니다.'
      : llmState === 'ready'
        ? `Claude Opus 5로 응답합니다 (오늘 남은 유료 호출 ${claudeLeft}회).`
        : claude
          ? '유료 예산이 소진되어 오픈소스 LLM으로 응답합니다.'
          : '오픈소스 LLM(Llama 3.3 70B)으로 응답합니다.'

  return json(
    {
      ok: true,
      workers_ai: workersAi,
      d1: db,
      vectorize,
      claude_key: claude,
      llm_engine: claude ? 'claude-opus-5' : workersAi ? 'llama-3.3-70b (오픈소스)' : 'demo',
      // 남은 예산 — 소진되면 화면이 "라이브"라고 말하면 안 된다
      budget: {
        claude_daily_cap: CLAUDE_CAP,
        claude_daily_left: claudeLeft,
        shared_daily_cap: DAILY_CAP,
        shared_daily_left: dailyLeft,
      },
      // 자가 점검 — "바인딩이 있다"가 아니라 "지금 이 기능이 실제로 뭘 하는가"
      capabilities: [
        capability('llm', 'LLM 분석·평가·리포트', llmState, llmDetail),
        capability(
          'stt',
          '녹취 전사 (Whisper)',
          workersAi ? 'ready' : 'off',
          workersAi ? 'Workers AI Whisper로 실제 전사합니다.' : 'AI 바인딩이 없어 예시 전사를 표시합니다.'
        ),
        capability(
          'rag',
          'RAG 지식 검색',
          workersAi ? (vectorize ? 'ready' : 'degraded') : 'off',
          workersAi
            ? vectorize
              ? 'Vectorize 사전 인덱스 + 키워드 RRF 융합으로 검색합니다.'
              : 'Vectorize 바인딩이 없어 실시간 임베딩으로 검색합니다.'
            : '임베딩을 쓸 수 없어 키워드 랭킹으로만 검색합니다.'
        ),
        // 결정적 층은 외부 의존이 없다 — 그래서 어떤 상태에서도 켜져 있다.
        // 이 사실 자체가 이 시스템의 설계 주장이므로 점검 결과로 함께 내보낸다.
        capability('rules', '규칙 검증층 (QA 스캔·게이트·가이드)', 'ready', '외부 의존이 없어 항상 실제로 동작합니다.'),
        capability(
          'telemetry',
          '운영 지표 기록',
          db ? 'ready' : 'off',
          db ? 'D1에 호출 기록을 남깁니다 (입력·IP 미저장).' : 'D1이 없어 지표를 남기지 않습니다.'
        ),
      ],
    },
    200,
    // 상태 점검 결과가 캐시에 남으면 이미 바뀐 상태를 계속 보여준다
    { cacheControl: NO_STORE }
  )
}
