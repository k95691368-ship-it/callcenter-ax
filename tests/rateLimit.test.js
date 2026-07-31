import { describe, it, expect } from 'vitest'
import { checkRateLimit } from '../functions/_lib/rateLimit.js'

// 이 모듈은 27곳에서 부르는 남용·과금 방어의 바닥인데 전용 테스트가 없었다.
// 여기서 지키려는 것은 세 가지다.
//   1. 상한을 넘으면 실제로 막는가 (조건부 INSERT의 changes로 판정하는가)
//   2. D1이 **없는 것**과 D1이 **실패한 것**을 구분하는가 — 전자는 설정, 후자는 장애다
//   3. failOpen:false 버킷(유료 예산)이 장애 때 열리지 않는가
// 3번이 특히 중요하다: 검사 불가가 곧 무제한 과금이 되는 자리라, 여기가 조용히
// fail-open으로 바뀌면 아무도 모르는 채로 상한이 사라진다.

// D1 목 — 실행된 SQL을 기록해 왕복 횟수와 순서까지 확인할 수 있게 한다.
function db({ count = 0, max = Infinity, failOn = null } = {}) {
  const state = { rows: count, sql: [], batches: 0 }
  const run = (sql, binds) => {
    state.sql.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40))
    if (failOn && sql.includes(failOn)) throw new Error('D1 장애')
    if (sql.startsWith('INSERT')) {
      // 조건부 INSERT: 현재 행 수가 상한 미만일 때만 삽입된다
      const limit = binds?.[2] ?? max
      if (state.rows < limit) {
        state.rows += 1
        return { meta: { changes: 1 } }
      }
      return { meta: { changes: 0 } }
    }
    return { meta: { changes: 0 } }
  }
  const stmt = (sql) => ({
    bind: (...binds) => ({ run: async () => run(sql, binds), all: async () => ({ results: [] }) }),
    run: async () => run(sql, []),
    all: async () => ({ results: [] }),
  })
  return {
    state,
    env: {
      DB: {
        prepare: stmt,
        batch: async (stmts) => {
          state.batches += 1
          return Promise.all(stmts.map((s) => s.run()))
        },
      },
    },
  }
}

describe('checkRateLimit — 상한 판정', () => {
  it('여유가 있으면 통과시키고 기록한다', async () => {
    const { env, state } = db({ count: 0 })
    expect(await checkRateLimit(env, 'cc:test', 3, 3600)).toBe(true)
    expect(state.rows).toBe(1)
  })

  it('상한에 도달하면 막는다 (그리고 그때는 기록도 늘지 않는다)', async () => {
    const { env, state } = db({ count: 3 })
    expect(await checkRateLimit(env, 'cc:test', 3, 3600)).toBe(false)
    // 막힌 요청이 카운터를 더 밀어 올리면, 창이 끝나도 계속 막히는 잠금이 생긴다
    expect(state.rows).toBe(3)
  })

  it('상한 직전 한 번은 통과하고 그다음은 막힌다', async () => {
    const { env } = db({ count: 0 })
    const results = []
    for (let i = 0; i < 4; i += 1) results.push(await checkRateLimit(env, 'cc:test', 3, 3600))
    expect(results).toEqual([true, true, true, false])
  })

  it('검사와 기록이 한 문장이다 — 동시 요청이 같은 여유를 읽고 함께 통과할 수 없다', async () => {
    // 예전 구현(SELECT COUNT 후 INSERT)에서는 동시 요청이 모두 "여유 있음"을 읽고
    // 전부 INSERT해 상한을 넘겼다. 조건부 INSERT는 그 경쟁을 구조적으로 없앤다.
    const { env, state } = db({ count: 0 })
    const all = await Promise.all(Array.from({ length: 10 }, () => checkRateLimit(env, 'cc:test', 3, 3600)))
    expect(all.filter(Boolean)).toHaveLength(3)
    expect(state.rows).toBe(3)
  })
})

describe('checkRateLimit — 바인딩 없음과 장애를 구분한다', () => {
  it('D1 바인딩이 아예 없으면 통과시킨다 (제한을 두지 않은 배포는 운영자의 설정이다)', async () => {
    expect(await checkRateLimit({}, 'cc:test', 1, 3600)).toBe(true)
    expect(await checkRateLimit({ DB: null }, 'cc:test', 1, 3600)).toBe(true)
  })

  it('D1은 있는데 쿼리가 실패하면 기본값은 통과다 (일시 장애가 화면을 500으로 만들지 않게)', async () => {
    const { env } = db({ failOn: 'INSERT' })
    expect(await checkRateLimit(env, 'cc:test', 1, 3600)).toBe(true)
  })

  it('failOpen:false 버킷은 장애 때 막는다 — 검사 불가가 곧 무제한 과금이기 때문이다', async () => {
    const { env } = db({ failOn: 'INSERT' })
    expect(await checkRateLimit(env, 'cc:paid', 1, 3600, { failOpen: false })).toBe(false)
  })

  it('failOpen:false여도 바인딩이 없는 것은 막지 않는다 (설정과 장애는 다르다)', async () => {
    expect(await checkRateLimit({}, 'cc:paid', 1, 3600, { failOpen: false })).toBe(true)
  })
})

describe('checkRateLimit — 왕복 횟수', () => {
  it('검사 1회가 D1 왕복 1회다 (만료 삭제와 조건부 INSERT를 한 번에 보낸다)', async () => {
    // 엔드포인트마다 검사를 3회 부르므로, 왕복이 검사당 2회면 본 작업 전에 6회를 쓴다.
    // 이 단언이 깨졌다면 지연이 두 배로 늘었다는 뜻이다.
    const { env, state } = db({ count: 0 })
    await checkRateLimit(env, 'cc:test', 3, 3600)
    expect(state.batches).toBe(1)
  })
})
