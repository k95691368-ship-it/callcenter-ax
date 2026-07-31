// bucket이 windowSeconds 안에 maxHits에 도달했으면 false, 아니면 기록 후 true.
//
// D1 바인딩이 아예 없는 환경(로컬 개발 등)은 "제한을 두지 않는 배포"로 보고 통과시킨다.
// 그건 운영자가 정한 정적인 상태이므로 여기서 기능을 막을 일이 아니다.
//
// 반면 DB는 있는데 쿼리가 실패한 경우는 일시 장애다. 이때의 처리는 버킷 성격에 따라 다르다.
//   failOpen: true (기본)  — 남용 방지 제한. 장애가 서비스를 500으로 만들지 않게 통과.
//   failOpen: false        — 유료 호출 예산. 검사 불가가 곧 무제한 과금이므로 막는다.
//                            (호출부는 이때 오픈소스 층으로 강등해 서비스 자체는 유지한다)
export async function checkRateLimit(env, bucket, maxHits, windowSeconds, { failOpen = true } = {}) {
  if (!env.DB) return true
  try {
    return await checkRateLimitInner(env, bucket, maxHits, windowSeconds)
  } catch {
    return failOpen
  }
}

const EXPIRE_SQL = `DELETE FROM rate_limit_hits WHERE bucket = ? AND created_at < datetime('now', '-' || ? || ' seconds')`
// 검사와 기록을 한 문장으로 합친다. 예전에는 SELECT COUNT로 확인한 뒤 INSERT를 했는데,
// 동시 요청이 모두 "아직 여유 있음"을 읽고 전부 INSERT해 상한을 넘길 수 있었다.
// 조건부 INSERT는 D1이 문장 하나로 처리하므로 그 경쟁이 사라진다.
const HIT_SQL = `INSERT INTO rate_limit_hits (bucket)
     SELECT ? WHERE (SELECT COUNT(*) FROM rate_limit_hits WHERE bucket = ?) < ?`
const SWEEP_SQL = "DELETE FROM rate_limit_hits WHERE created_at < datetime('now', '-1 day')"

async function checkRateLimitInner(env, bucket, maxHits, windowSeconds) {
  const db = env.DB
  const expire = db.prepare(EXPIRE_SQL).bind(bucket, windowSeconds)
  const hit = db.prepare(HIT_SQL).bind(bucket, bucket, maxHits)
  // 가끔 전역 청소: 다시 조회되지 않는 콜드 버킷의 오래된 행이 누적되는 것을 막는다.
  const sweeping = Math.random() < 0.02

  // 두 문장을 한 왕복으로 보낸다.
  //
  // 엔드포인트마다 이 함수를 3회 부른다(IP·엔드포인트 전체·일일 전체). 문장을 따로 보내면
  // 본 작업이 시작되기도 전에 D1 왕복 6회를 쓰고, 그 지연이 응답 시간의 앞부분을 그대로
  // 차지한다. batch는 문장을 순서대로 실행하므로 만료 삭제가 먼저 도는 순서도 유지된다.
  //
  // 순서가 곧 정확성이다 — 만료 행을 지우기 전에 세면 이미 지난 창의 요청이 상한에
  // 계속 잡혀 창이 끝나도 풀리지 않는다.
  if (typeof db.batch === 'function') {
    const stmts = sweeping ? [db.prepare(SWEEP_SQL), expire, hit] : [expire, hit]
    const res = await db.batch(stmts)
    return (res?.[res.length - 1]?.meta?.changes ?? 0) > 0
  }

  // batch를 지원하지 않는 런타임(구형 로컬 D1·일부 목)에서는 예전처럼 순차로 보낸다.
  // 느릴 뿐 판정 결과는 같아야 하므로 계약을 바꾸지 않는다.
  await expire.run()
  if (sweeping) await db.prepare(SWEEP_SQL).run().catch(() => {})
  const res = await hit.run()
  // 행이 실제로 삽입됐다면 상한 안이었다는 뜻이다.
  return (res?.meta?.changes ?? 0) > 0
}
