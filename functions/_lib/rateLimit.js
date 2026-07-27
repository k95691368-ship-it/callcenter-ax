// bucket이 windowSeconds 안에 maxHits에 도달했으면 false, 아니면 기록 후 true.
// D1 바인딩이 없으면(로컬 미설정 등) 제한 없이 통과시킨다.
export async function checkRateLimit(env, bucket, maxHits, windowSeconds) {
  if (!env.DB) return true
  try {
    return await checkRateLimitInner(env, bucket, maxHits, windowSeconds)
  } catch {
    // D1 오류(테이블 미생성 등)가 API 전체를 500으로 만들지 않도록 fail-open
    return true
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

  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM rate_limit_hits WHERE bucket = ?')
    .bind(bucket)
    .first()
  if (row.count >= maxHits) return false

  await env.DB.prepare('INSERT INTO rate_limit_hits (bucket) VALUES (?)').bind(bucket).run()
  return true
}
