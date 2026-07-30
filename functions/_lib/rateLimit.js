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

async function checkRateLimitInner(env, bucket, maxHits, windowSeconds) {
  await env.DB.prepare(
    `DELETE FROM rate_limit_hits WHERE bucket = ? AND created_at < datetime('now', '-' || ? || ' seconds')`
  )
    .bind(bucket, windowSeconds)
    .run()

  // 가끔 전역 청소: 다시 조회되지 않는 콜드 버킷의 오래된 행이 누적되는 것을 막는다.
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM rate_limit_hits WHERE created_at < datetime('now', '-1 day')")
      .run()
      .catch(() => {})
  }

  // 검사와 기록을 한 문장으로 합친다. 예전에는 SELECT COUNT로 확인한 뒤 INSERT를 했는데,
  // 동시 요청이 모두 "아직 여유 있음"을 읽고 전부 INSERT해 상한을 넘길 수 있었다.
  // 조건부 INSERT는 D1이 문장 하나로 처리하므로 그 경쟁이 사라진다.
  const res = await env.DB.prepare(
    `INSERT INTO rate_limit_hits (bucket)
     SELECT ? WHERE (SELECT COUNT(*) FROM rate_limit_hits WHERE bucket = ?) < ?`
  )
    .bind(bucket, bucket, maxHits)
    .run()

  // 행이 실제로 삽입됐다면 상한 안이었다는 뜻이다.
  return (res?.meta?.changes ?? 0) > 0
}
