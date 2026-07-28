// VOC 리포트 숫자 검증 — "주어진 집계 수치만 근거로 쓰라"는 지시가 지켜졌는지
// 결정적으로 확인한다. 리포트에 등장하는 숫자가 입력 집계(또는 그 파생 퍼센트)에
// 없으면 환각 수치로 표시한다.

export function extractNumbers(text) {
  const out = []
  const re = /\d[\d,]*(?:\.\d+)?/g
  let m
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

// 집계에서 허용 숫자 집합을 만든다: 원본 수치 + 파생 퍼센트(정수·소수1자리) + 소형 서수(0~10)
export function allowedNumbers(stats) {
  const allowed = new Set()
  for (let i = 0; i <= 10; i++) allowed.add(i)
  const counts = [
    stats.total,
    stats.escalatedCount,
    ...(stats.byCategory || []).map((c) => c.count),
    ...(stats.bySentiment || []).map((s) => s.count),
  ].filter((n) => Number.isFinite(n))
  for (const n of counts) {
    allowed.add(n)
    if (stats.total > 0) {
      const pct = (n / stats.total) * 100
      allowed.add(Math.round(pct))
      allowed.add(Math.round(pct * 10) / 10)
    }
  }
  return allowed
}

// 리포트 텍스트를 검사해 집계에 없는 숫자 목록을 돌려준다
export function verifyReportNumbers(texts, stats) {
  const allowed = allowedNumbers(stats)
  const unknown = new Set()
  for (const t of Array.isArray(texts) ? texts : [texts]) {
    for (const n of extractNumbers(t)) {
      if (!allowed.has(n)) unknown.add(n)
    }
  }
  return { ok: unknown.size === 0, unknown: [...unknown] }
}
