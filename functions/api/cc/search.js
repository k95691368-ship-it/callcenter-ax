import { json, errorJson, readJsonBody, clientKey } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import { FAQ_DOCS, rankByKeyword, cosineSim, fuseRankings } from '../../../src/lib/faqDocs.js'
import { groundedness } from '../../../src/lib/grounding.js'

// Workers AI 다국어 임베딩 모델 (한국어 지원, 오픈소스)
const EMBED_MODEL = '@cf/baai/bge-m3'
const TOP_K = 3

const TOOL = {
  name: 'record_rag_answer',
  description: '검색된 근거 문서만 사용해 상담 지식 질문에 답한다.',
  input_schema: {
    type: 'object',
    required: ['answer', 'cited_ids'],
    properties: {
      answer: {
        type: 'string',
        description: '근거 문서 내용만으로 작성한 한국어 답변 3~5문장. 문서에 없는 내용은 "문서에서 확인되지 않는다"고 명시',
      },
      cited_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '실제로 근거로 사용한 문서 id 목록',
      },
    },
  },
}

const SYSTEM = `당신은 콜센터 상담사를 돕는 지식 검색 어시스턴트입니다. 제공된 근거 문서만 사용해 답합니다.

규칙 (RAG 원칙):
1. 근거 문서에 있는 내용만으로 답하세요. 문서 밖 지식으로 보충하지 마세요.
2. 문서에 답이 없으면 "제공된 문서에서 확인되지 않습니다"라고 답하고, 가장 가까운 문서를 안내하세요.
3. 실제로 인용한 문서의 id만 cited_ids에 기록하세요.
${CALL_SAFETY_RULES}`

async function embedTexts(env, texts) {
  const out = await Promise.race([
    env.AI.run(EMBED_MODEL, { text: texts }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('임베딩 지연')), 20000)),
  ])
  const vectors = out?.data
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('임베딩 응답 형식 오류')
  return vectors
}

// 실시간 임베딩 검색(구 방식) — Vectorize 실패 시 폴백. 질문+문서 전체를 한 번에 벡터화.
async function vectorSearch(env, question, docs) {
  const [qVec, ...docVecs] = await embedTexts(env, [question, ...docs.map((d) => `${d.title}\n${d.body}`)])
  return docs.map((doc, i) => ({ ...doc, score: cosineSim(qVec, docVecs[i]) }))
    .sort((a, b) => b.score - a.score)
}

// 인덱스가 비어 있으면(콜드 스타트) 내장 FAQ 전체를 1회 업서트해 자가 시딩한다
async function seedFaqIndex(env) {
  const vecs = await embedTexts(env, FAQ_DOCS.map((d) => `${d.title}\n${d.body}`))
  await env.VECTORIZE.upsert(FAQ_DOCS.map((d, i) => ({ id: d.id, values: vecs[i] })))
}

// Vectorize 사전 인덱스 검색 — 매 요청 전체 임베딩(문서 수에 비례)의 구조적 한계를
// 돌파한다: 질의 1건만 임베딩해 사전 색인을 조회하므로 코퍼스가 수백 건이어도 동일 비용.
// 내 문서(mydoc*)는 서버 미저장 원칙에 따라 색인하지 않고 요청 내에서만 코사인 대조한다.
async function vectorizeSearch(env, question, customDocs) {
  if (!env.VECTORIZE) return null
  const [qVec, ...customVecs] = await embedTexts(env, [
    question,
    ...customDocs.map((d) => `${d.title}\n${d.body}`),
  ])
  let res = await env.VECTORIZE.query(qVec, { topK: 8 })
  if (!res?.matches?.length) {
    await seedFaqIndex(env)
    res = await env.VECTORIZE.query(qVec, { topK: 8 })
  }
  if (!res?.matches?.length) return null // 색인 전파 지연 → 실시간 임베딩 폴백
  const indexed = res.matches
    .map((m) => {
      const doc = FAQ_DOCS.find((d) => d.id === m.id)
      return doc ? { ...doc, score: m.score } : null
    })
    .filter(Boolean)
  const customs = customDocs.map((d, i) => ({ ...d, score: cosineSim(qVec, customVecs[i]) }))
  return [...indexed, ...customs].sort((a, b) => b.score - a.score)
}

// 사용자가 붙여넣은 문서를 검색 코퍼스 형식으로 정리한다 (최대 5건 × 800자)
function buildCustomDocs(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((d) => String(d ?? '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((body, i) => ({
      id: `mydoc${i + 1}`,
      title: `내 문서 ${i + 1}: ${body.slice(0, 20)}${body.length > 20 ? '…' : ''}`,
      body: body.slice(0, 800),
      mine: true,
    }))
}

// LLM 없이 쓰는 템플릿 답변 — 최상위 문서 발췌로 흐름을 유지한다
function templateAnswer(results) {
  const top = results[0]
  if (!top || !top.score) {
    return { answer: '질문과 충분히 유사한 문서를 찾지 못했습니다. 질문을 더 구체적으로 바꿔보세요.', cited_ids: [] }
  }
  return {
    answer: `관련 규정 「${top.title}」에 따르면: ${top.body.split('. ').slice(0, 2).join('. ')}. (자세한 내용은 아래 근거 문단 참조)`,
    cited_ids: [top.id],
  }
}

export async function onRequestPost(context) {
  const { request, env } = context
  const body = await readJsonBody(request)
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 300) : ''
  if (!question) return errorJson('질문을 입력해주세요.')
  const customDocs = buildCustomDocs(body?.custom_docs)
  const corpus = [...FAQ_DOCS, ...customDocs]

  if (!(await verifyTurnstile(env, request)))
    return errorJson('보안 검증에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 403)

  const startedAt = Date.now()

  const ip = await clientKey(request, env)
  if (!(await checkRateLimit(env, `cc:search:${ip}`, 10, 3600)))
    return errorJson('지식 검색은 시간당 10회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:search:all', 60, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)

  // 1단계: 검색 — Vectorize 사전 인덱스 우선 → 실시간 임베딩 폴백, 키워드 랭킹과 RRF 융합
  let results
  let mode = 'hybrid'
  let vectorBackend = null
  if (env.AI) {
    try {
      let vectorRank = null
      try {
        vectorRank = await vectorizeSearch(env, question, customDocs)
        if (vectorRank) vectorBackend = 'vectorize'
      } catch {
        vectorRank = null
      }
      if (!vectorRank) {
        vectorRank = await vectorSearch(env, question, corpus)
        vectorBackend = 'realtime'
      }
      const keywordRank = rankByKeyword(question, corpus)
      results = fuseRankings([vectorRank, keywordRank], { topK: TOP_K })
    } catch {
      results = null
    }
  }
  if (!results) {
    mode = 'keyword'
    vectorBackend = null
    results = rankByKeyword(question, corpus).slice(0, TOP_K)
  }
  const publicResults = results.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    mine: Boolean(r.mine),
    score: Math.round((r.score || 0) * 1000) / 1000,
    ...(r.rrf != null ? { rrf: r.rrf } : {}),
  }))

  // 2단계: 답변 생성 사다리 — Claude(키 등록 시) → 오픈소스 LLM → 발췌 템플릿
  const canClaude = hasApiKey(env)
  const canWorkers = hasWorkersAi(env)
  // 엔진이 아예 없으면 예산을 차감할 이유가 없다 — 불필요한 D1 왕복을 건너뛴다.
  const budgetOk = canClaude || canWorkers ? await checkRateLimit(env, 'cc:daily:all', 300, 86400) : true
  if ((!canClaude && !canWorkers) || !budgetOk) {
    const t = templateAnswer(results)
    logCall(context, { endpoint: 'search', mode: `demo-${mode}`, startedAt })
    return json({
      demo: true,
      mode,
      embed_model: mode === 'keyword' ? null : EMBED_MODEL,
      vector_backend: vectorBackend,
      results: publicResults,
      ...t,
      notice: budgetOk ? undefined : '오늘의 라이브 답변 예산이 소진되어 발췌 답변을 표시합니다.',
    })
  }

  try {
    const context_docs = results
      .map((r) => `[문서 id=${r.id}] ${r.title}\n${r.body}`)
      .join('\n\n')
    const userPrompt = `[근거 문서 (유사도 상위 ${results.length}건)]\n${context_docs}\n\n[상담사 질문]\n${question}\n\n근거 문서만 사용해 답변을 기록하세요.`
    const r = await runLlmLadder(env, {
      system: SYSTEM,
      user: userPrompt,
      tool: TOOL,
      maxTokens: 1024,
      workersSchema: '{"answer":"3~5문장 한국어 답변","cited_ids":["실제 인용한 문서 id"]}',
      workersMaxTokens: 768,
    })
    const result = r.input
    ensureContract(result, { arrays: ['cited_ids'], strings: ['answer'] })
    // 근거율 게이트 — 답변 표현이 검색 문서와 실제로 겹치는 비율을 결정적으로 측정
    const grounding = groundedness(result.answer, results.map((x) => `${x.title} ${x.body}`).join(' '))
    logCall(context, {
      endpoint: 'search',
      mode: r.engine === 'claude' ? `live-${mode}` : `live-oss-${mode}`,
      startedAt,
      usage: r.usage,
    })
    return json({
      demo: false,
      mode,
      embed_model: mode === 'keyword' ? null : EMBED_MODEL,
      vector_backend: vectorBackend,
      usage: r.usage,
      llm_model: r.model,
      results: publicResults,
      answer: result.answer,
      cited_ids: result.cited_ids.filter((id) => results.some((x) => x.id === id)),
      grounding,
      ...(grounding < 0.35
        ? { notice: '답변의 문서 근거율이 낮습니다 — 아래 근거 문단 원문을 직접 확인해주세요.' }
        : {}),
    })
  } catch (err) {
    const t = templateAnswer(results)
    logCall(context, { endpoint: 'search', mode: 'fallback', startedAt })
    return json({
      demo: true,
      mode,
      embed_model: mode === 'keyword' ? null : EMBED_MODEL,
      vector_backend: vectorBackend,
      results: publicResults,
      ...t,
      notice: `일시적인 AI 혼잡으로 발췌 답변을 표시합니다. (${err.message})`,
    })
  }
}
