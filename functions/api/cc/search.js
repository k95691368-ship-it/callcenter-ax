import { json, errorJson, readJsonBody, clientIp } from '../../_lib/http.js'
import { checkRateLimit } from '../../_lib/rateLimit.js'
import { ensureContract, hasApiKey, CALL_SAFETY_RULES } from '../../_lib/claude.js'
import { hasWorkersAi } from '../../_lib/workersLlm.js'
import { runLlmLadder } from '../../_lib/ladder.js'
import { logCall } from '../../_lib/telemetry.js'
import { verifyTurnstile } from '../../_lib/turnstile.js'
import { FAQ_DOCS, rankByKeyword, cosineSim, fuseRankings } from '../../../src/lib/faqDocs.js'

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

// 임베딩 기반 검색 — 질문+문서 전체를 한 번에 벡터화해 코사인 유사도 내림차순 전체 랭킹.
// 내장 FAQ에 사용자가 붙여넣은 문서(mydoc*)를 합쳐 실시간 인덱싱한다.
async function vectorSearch(env, question, docs) {
  const texts = [question, ...docs.map((d) => `${d.title}\n${d.body}`)]
  const out = await Promise.race([
    env.AI.run(EMBED_MODEL, { text: texts }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('임베딩 지연')), 20000)),
  ])
  const vectors = out?.data
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('임베딩 응답 형식 오류')
  const [qVec, ...docVecs] = vectors
  return docs.map((doc, i) => ({ ...doc, score: cosineSim(qVec, docVecs[i]) }))
    .sort((a, b) => b.score - a.score)
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

  const ip = clientIp(request)
  if (!(await checkRateLimit(env, `cc:search:${ip}`, 10, 3600)))
    return errorJson('지식 검색은 시간당 10회까지 가능합니다. 잠시 후 다시 시도해주세요.', 429)
  if (!(await checkRateLimit(env, 'cc:search:all', 60, 3600)))
    return errorJson('사용량이 많아 잠시 후 다시 시도해주세요.', 429)

  // 1단계: 검색 — 벡터+키워드 하이브리드(RRF 융합) 우선, 임베딩 실패 시 키워드 랭킹으로 강등
  let results
  let mode = 'hybrid'
  if (env.AI) {
    try {
      const vectorRank = await vectorSearch(env, question, corpus)
      const keywordRank = rankByKeyword(question, corpus)
      results = fuseRankings([vectorRank, keywordRank], { topK: TOP_K })
    } catch {
      results = null
    }
  }
  if (!results) {
    mode = 'keyword'
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
  const budgetOk = await checkRateLimit(env, 'cc:daily:all', 300, 86400)
  if ((!canClaude && !canWorkers) || !budgetOk) {
    const t = templateAnswer(results)
    logCall(context, { endpoint: 'search', mode: `demo-${mode}`, startedAt })
    return json({
      demo: true,
      mode,
      embed_model: mode === 'keyword' ? null : EMBED_MODEL,
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
      usage: r.usage,
      llm_model: r.model,
      results: publicResults,
      answer: result.answer,
      cited_ids: result.cited_ids.filter((id) => results.some((x) => x.id === id)),
    })
  } catch (err) {
    const t = templateAnswer(results)
    logCall(context, { endpoint: 'search', mode: 'fallback', startedAt })
    return json({
      demo: true,
      mode,
      embed_model: mode === 'keyword' ? null : EMBED_MODEL,
      results: publicResults,
      ...t,
      notice: `일시적인 AI 혼잡으로 발췌 답변을 표시합니다. (${err.message})`,
    })
  }
}
