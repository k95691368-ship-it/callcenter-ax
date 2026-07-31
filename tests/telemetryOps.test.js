import { describe, it, expect } from 'vitest'
import {
  json,
  errorJson,
  readJsonBody,
  bodyError,
  bodyErrorResponse,
  DEFAULT_MAX_BODY_BYTES,
  NO_STORE,
  SHORT_EDGE_CACHE,
} from '../functions/_lib/http.js'
import { logCall, pruneAiCalls, RAW_RETENTION_DAYS } from '../functions/_lib/telemetry.js'
import { onRequestGet as statsGet } from '../functions/api/cc/stats.js'
import { summarizeStats } from '../src/lib/statsSummary.js'

// 텔레메트리 운영(보관·집계·캐시·본문 상한)의 회귀 테스트.
// 여기서 고정하는 것은 "한 요청 = 한 줄", "누적 숫자는 줄지 않는다", "거절은 파싱 전에",
// "상태 응답은 캐시되지 않는다" — 전부 조용히 깨지는 종류의 계약이다.

function fakeDb(extra = {}) {
  const runs = []
  const prepared = []
  const db = {
    runs,
    prepared,
    prepare(sql) {
      prepared.push(sql)
      return {
        sql,
        bind: (...args) => ({
          sql,
          args,
          run: async () => {
            runs.push({ sql, args })
            return { meta: { changes: 1 } }
          },
        }),
      }
    },
    ...extra,
  }
  return db
}

function fakeContext(db) {
  const waits = []
  return { env: { DB: db }, waitUntil: (p) => waits.push(p), waits }
}

const settle = async (ctx) => {
  await Promise.all(ctx.waits)
  await Promise.resolve()
}

const inserts = (db) => db.runs.filter((r) => /INSERT INTO ai_calls\b/.test(r.sql))

describe('logCall — 한 요청에 한 줄', () => {
  it('같은 요청에서 두 번 호출해도 한 줄만 남는다', async () => {
    const db = fakeDb()
    const ctx = fakeContext(db)
    logCall(ctx, { endpoint: 'qa', mode: 'live', startedAt: Date.now() - 120, usage: { input_tokens: 11, output_tokens: 22 }, findingsCount: 2 })
    logCall(ctx, { endpoint: 'qa', mode: 'fallback', startedAt: Date.now() - 120, findingsCount: 2 })
    await settle(ctx)
    expect(inserts(db)).toHaveLength(1)
  })

  it('두 번째 기록의 mode(사용자가 실제로 받은 결과)로 갱신된다', async () => {
    const db = fakeDb()
    const ctx = fakeContext(db)
    logCall(ctx, { endpoint: 'analyze', mode: 'live', startedAt: Date.now() - 50, usage: { input_tokens: 7, output_tokens: 9 } })
    logCall(ctx, { endpoint: 'analyze', mode: 'fallback', startedAt: Date.now() - 50 })
    await settle(ctx)
    const [row] = inserts(db)
    expect(row.args[1]).toBe('fallback')
    // 라이브 호출이 이미 끝난 뒤 폴백으로 응답한 경우이므로 토큰은 실제로 소모됐다 — 잃지 않는다
    expect(row.args[3]).toBe(7)
    expect(row.args[4]).toBe(9)
  })

  it('요청이 다르면 각각 기록된다 (요청 간 억제가 아니다)', async () => {
    const db = fakeDb()
    const a = fakeContext(db)
    const b = fakeContext(db)
    logCall(a, { endpoint: 'stt', mode: 'live-turbo', startedAt: Date.now() })
    logCall(b, { endpoint: 'stt', mode: 'live-turbo', startedAt: Date.now() })
    await settle(a)
    await settle(b)
    expect(inserts(db)).toHaveLength(2)
  })

  it('findingsCount 0도 그대로 기록된다 (누락이 아니다)', async () => {
    const db = fakeDb()
    const ctx = fakeContext(db)
    logCall(ctx, { endpoint: 'qa', mode: 'live', startedAt: Date.now(), findingsCount: 0 })
    await settle(ctx)
    expect(inserts(db)[0].args[5]).toBe(0)
  })

  it('허용된 컬럼만 기록한다 (개인정보 불변식)', async () => {
    const db = fakeDb()
    const ctx = fakeContext(db)
    logCall(ctx, { endpoint: 'search', mode: 'live-vector', startedAt: Date.now() })
    await settle(ctx)
    const columns = inserts(db)[0].sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(',').map((c) => c.trim())
    expect(columns).toEqual(['endpoint', 'mode', 'latency_ms', 'input_tokens', 'output_tokens', 'findings_count', 'cache_read_tokens', 'cache_write_tokens'])
  })

  it('DB가 없으면 아무 일도 하지 않는다', () => {
    expect(() => logCall({ env: {} }, { endpoint: 'stt', mode: 'demo' })).not.toThrow()
  })
})

describe('pruneAiCalls — 보관 기간 정리', () => {
  function batchDb() {
    const batches = []
    return {
      batches,
      prepare: (sql) => ({ sql, bind: (...args) => ({ sql, args }) }),
      batch: async (stmts) => {
        batches.push(stmts)
        return stmts.map(() => ({ meta: { changes: 0 } }))
      },
    }
  }

  it('롤업과 삭제를 한 batch(트랜잭션)로 묶는다 — 삭제만 성공하면 카운터에 구멍이 난다', async () => {
    const db = batchDb()
    const ok = await pruneAiCalls({ DB: db }, { now: Date.parse('2026-07-30T00:00:00Z') })
    expect(ok).toBe(true)
    expect(db.batches).toHaveLength(1)
    const [rollup, del] = db.batches[0]
    expect(rollup.sql).toMatch(/INSERT INTO ai_call_totals/)
    expect(rollup.sql).toMatch(/ON CONFLICT\(endpoint, mode\) DO UPDATE/)
    expect(del.sql).toMatch(/^DELETE FROM ai_calls WHERE created_at < \?$/)
  })

  it('두 문장이 정확히 같은 경계 시각을 쓴다 (초가 넘어가도 새는 행이 없게)', async () => {
    const db = batchDb()
    await pruneAiCalls({ DB: db }, { days: 30, now: Date.parse('2026-07-30T00:00:00Z') })
    const [rollup, del] = db.batches[0]
    expect(rollup.args[0]).toBe('2026-06-30 00:00:00')
    expect(del.args[0]).toBe(rollup.args[0])
  })

  it('보관 기간 기본값은 30일이고 created_at 형식과 맞는다', async () => {
    expect(RAW_RETENTION_DAYS).toBe(30)
    const db = batchDb()
    await pruneAiCalls({ DB: db }, { now: Date.parse('2026-07-30T12:34:56Z') })
    expect(db.batches[0][0].args[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('batch를 지원하지 않으면 아무것도 지우지 않는다', async () => {
    const db = fakeDb()
    expect(await pruneAiCalls({ DB: db })).toBe(false)
    expect(db.prepared).toHaveLength(0)
  })

  it('logCall이 기록 경로에서 원본을 지우지는 않는다 (정리는 확률적 별도 경로)', async () => {
    const db = fakeDb()
    const ctx = fakeContext(db)
    logCall(ctx, { endpoint: 'qa', mode: 'live', startedAt: Date.now() })
    await settle(ctx)
    expect(db.runs.some((r) => /DELETE/.test(r.sql))).toBe(false)
  })
})

describe('json / errorJson — 캐시 헤더', () => {
  it('기본 응답에는 캐시 헤더를 붙이지 않는다 (기존 POST 응답 그대로)', () => {
    expect(json({ a: 1 }).headers.get('Cache-Control')).toBe(null)
  })

  it('요청한 캐시 정책이 헤더로 나간다', () => {
    expect(json({ a: 1 }, 200, { cacheControl: SHORT_EDGE_CACHE }).headers.get('Cache-Control')).toBe(SHORT_EDGE_CACHE)
  })

  it('집계 캐시는 짧은 s-maxage를 쓴다', () => {
    expect(SHORT_EDGE_CACHE).toMatch(/s-maxage=\d{1,2}\b/)
  })

  it('오류·제한 응답은 캐시되지 않는다 (풀린 뒤에도 거절이 재생되면 안 된다)', () => {
    const res = errorJson('시간당 6회까지 가능합니다.', 429)
    expect(res.status).toBe(429)
    expect(res.headers.get('Cache-Control')).toBe(NO_STORE)
  })
})

describe('readJsonBody — 본문 상한과 파싱 실패 구분', () => {
  function req(text, { contentLength } = {}) {
    const called = { text: 0 }
    return {
      called,
      headers: {
        get: (h) => (String(h).toLowerCase() === 'content-length' ? contentLength ?? null : null),
      },
      text: async () => {
        called.text += 1
        return text
      },
    }
  }

  it('Content-Length가 상한을 넘으면 본문을 읽지도 않고 거절한다', async () => {
    const r = req('x', { contentLength: String(DEFAULT_MAX_BODY_BYTES + 1) })
    const body = await readJsonBody(r)
    expect(bodyError(body)).toBe('too-large')
    expect(r.called.text).toBe(0)
  })

  it('엔드포인트가 더 좁은 상한을 줄 수 있다', async () => {
    const r = req('{"transcript":"..."}', { contentLength: '5000' })
    expect(bodyError(await readJsonBody(r, { maxBytes: 1000 }))).toBe('too-large')
    expect(r.called.text).toBe(0)
  })

  it('기본 상한은 stt의 base64 음성(약 8.4MB)보다 넉넉하다 — 정상 요청을 막지 않는다', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(8_400_000)
  })

  it('정상 JSON은 그대로 파싱된다', async () => {
    const body = await readJsonBody(req('{"transcript":"한빛텔레콤 상담"}', { contentLength: '40' }))
    expect(body.transcript).toBe('한빛텔레콤 상담')
  })

  it('깨진 JSON은 빈 본문과 구분된다', async () => {
    const broken = await readJsonBody(req('{"transcript":', { contentLength: '14' }))
    expect(bodyError(broken)).toBe('invalid-json')
    expect(await readJsonBody(req('', { contentLength: '0' }))).toBe(null)
  })

  it('오류 표식은 기존 호출부의 body?.field 검사를 그대로 통과한다 (동작 불변)', async () => {
    const broken = await readJsonBody(req('nope', { contentLength: '4' }))
    expect(broken?.transcript).toBe(undefined)
    expect(typeof broken?.audio_b64).toBe('undefined')
  })

  it('bodyErrorResponse가 원인별 상태코드를 준다', async () => {
    const tooLarge = await readJsonBody(req('x', { contentLength: '99999999' }))
    expect(bodyErrorResponse(tooLarge).status).toBe(413)
    const broken = await readJsonBody(req('{', { contentLength: '1' }))
    expect(bodyErrorResponse(broken).status).toBe(400)
    expect(bodyErrorResponse({ transcript: 'ok' })).toBe(null)
  })

  it('text()도 스트림도 없는 요청 객체는 예전처럼 json()으로 읽는다 (하위 호환)', async () => {
    const r = { headers: { get: () => null }, json: async () => ({ transcript: '옛 경로' }) }
    expect((await readJsonBody(r)).transcript).toBe('옛 경로')
    const broken = { headers: { get: () => null }, json: async () => { throw new Error('bad json') } }
    expect(bodyError(await readJsonBody(broken))).toBe('invalid-json')
  })

  it('Content-Length가 없어도 상한을 넘는 순간 스트림을 끊는다', async () => {
    const bytes = new TextEncoder().encode('x'.repeat(5000))
    const cancelled = { value: false }
    let i = 0
    const r = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= bytes.length) return { done: true }
            const value = bytes.slice(i, i + 1000)
            i += 1000
            return { done: false, value }
          },
          cancel: async () => {
            cancelled.value = true
          },
        }),
      },
      text: async () => {
        throw new Error('스트림 경로가 text()로 새면 안 된다')
      },
    }
    expect(bodyError(await readJsonBody(r, { maxBytes: 2000 }))).toBe('too-large')
    expect(cancelled.value).toBe(true)
    expect(i).toBeLessThan(bytes.length) // 끝까지 읽지 않았다
  })

  it('Content-Length가 없는 정상 요청은 청크를 이어 붙여 파싱한다 (UTF-8 경계 포함)', async () => {
    const bytes = new TextEncoder().encode('{"transcript":"한빛텔레콤"}')
    let i = 0
    const r = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (i >= bytes.length) return { done: true }
            const value = bytes.slice(i, i + 5) // 한글 한 글자(3바이트) 중간을 자르는 크기
            i += 5
            return { done: false, value }
          },
        }),
      },
    }
    const body = await readJsonBody(r)
    expect(body.transcript).toBe('한빛텔레콤')
  })
})

describe('stats — 누적 집계와 캐시', () => {
  const ROLLUP_ROWS = [
    { endpoint: 'qa', mode: 'live', calls: 12, avg_latency_ms: 4000 },
    { endpoint: 'stt', mode: 'live-turbo', calls: 8, avg_latency_ms: 2000 },
    { endpoint: 'qa', mode: 'fallback', calls: 1, avg_latency_ms: null },
  ]

  function statsEnv({ mergedFails = false, withBatch = false } = {}) {
    const seen = []
    const resultFor = (sql) => {
      if (/ai_call_totals/.test(sql) && mergedFails) throw new Error('D1_ERROR: no such table: ai_call_totals')
      if (/AS since/.test(sql)) return { results: [{ since: '2026-07-27 09:15:00' }] }
      return { results: ROLLUP_ROWS }
    }
    const DB = {
      seen,
      prepare(sql) {
        seen.push(sql)
        return { sql, all: async () => resultFor(sql) }
      },
    }
    if (withBatch) DB.batch = async (stmts) => stmts.map((s) => resultFor(s.sql))
    return { DB }
  }

  it('rows·total·since를 화면이 쓰는 이름으로 낸다', async () => {
    const res = await statsGet({ env: statsEnv() })
    const d = await res.json()
    expect(d.ok).toBe(true)
    expect(d.rows).toHaveLength(3)
    expect(Object.keys(d.rows[0]).sort()).toEqual(['avg_latency_ms', 'calls', 'endpoint', 'mode'])
    expect(d.total).toBe(21)
    expect(d.since).toBe('2026-07-27 09:15:00')
  })

  it('집계 SQL이 누적 카운터와 남은 원본을 합치고, 원본에는 시간 조건을 건다', async () => {
    const env = statsEnv()
    await statsGet({ env })
    const agg = env.DB.seen.find((s) => /avg_latency_ms/.test(s))
    expect(agg).toMatch(/FROM ai_call_totals/)
    expect(agg).toMatch(/UNION ALL/)
    expect(agg).toMatch(/FROM ai_calls\s+WHERE created_at > /)
    expect(agg).toMatch(/GROUP BY endpoint, mode/)
    // 평균은 합/건수로 복원한다 (AVG의 평균을 다시 평균내면 틀린다)
    expect(agg).toMatch(/SUM\(latency_sum\)/)
    expect(agg).not.toMatch(/AVG\(/)
  })

  it('수집 시작 시각은 접힌 카운터와 남은 원본 중 이른 쪽이다', async () => {
    const env = statsEnv()
    await statsGet({ env })
    const since = env.DB.seen.find((s) => /AS since/.test(s))
    expect(since).toMatch(/MIN\(first_at\)/)
    expect(since).toMatch(/MIN\(created_at\)/)
  })

  it('batch가 있으면 한 번의 왕복으로 두 문장을 처리한다', async () => {
    const env = statsEnv({ withBatch: true })
    let calls = 0
    const inner = env.DB.batch
    env.DB.batch = async (stmts) => {
      calls += 1
      return inner(stmts)
    }
    const d = await (await statsGet({ env })).json()
    expect(calls).toBe(1)
    expect(d.total).toBe(21)
  })

  it('누적 카운터 표가 없는 배포(마이그레이션 미적용)에서도 예전 집계로 답한다', async () => {
    const env = statsEnv({ mergedFails: true })
    const d = await (await statsGet({ env })).json()
    expect(d.ok).toBe(true)
    expect(d.total).toBe(21)
    expect(env.DB.seen.some((s) => /AVG\(latency_ms\)/.test(s))).toBe(true)
  })

  it('응답에 짧은 캐시를 붙인다', async () => {
    const res = await statsGet({ env: statsEnv() })
    expect(res.headers.get('Cache-Control')).toBe(SHORT_EDGE_CACHE)
  })

  it('실패·빈 응답은 캐시하지 않는다 (몇 분간 빈 화면이 재생되면 안 된다)', async () => {
    const noDb = await statsGet({ env: {} })
    expect(noDb.headers.get('Cache-Control')).toBe(NO_STORE)
    expect((await noDb.json()).ok).toBe(false)

    const broken = await statsGet({
      env: { DB: { prepare: () => { throw new Error('D1 down') } } },
    })
    expect(broken.headers.get('Cache-Control')).toBe(NO_STORE)
    const d = await broken.json()
    expect(d).toEqual({ ok: false, rows: [], total: 0, since: null })
  })

  it('누적임을 응답에 명시한다 (화면의 "누적 호출 수"가 거짓말이 되지 않게)', async () => {
    const d = await (await statsGet({ env: statsEnv() })).json()
    expect(d.cumulative).toBe(true)
    expect(d.raw_retention_days).toBe(RAW_RETENTION_DAYS)
  })

  it('About 화면의 요약 함수가 이 rows를 그대로 소화한다', async () => {
    const d = await (await statsGet({ env: statsEnv() })).json()
    const s = summarizeStats(d.rows)
    expect(s.total).toBe(21)
    expect(s.liveCalls).toBe(20)
    expect(s.fallbackCalls).toBe(1)
    expect(s.endpoints.find((e) => e.endpoint === 'qa').avgLatencyMs).toBe(4000)
  })
})
