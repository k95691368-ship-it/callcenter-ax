// STT 성능 평가 — CER(Character Error Rate, 문자 오류율)
// CER = 편집거리(정답, 전사) / 정답 문자 수. 낮을수록 좋다.
// 공백·문장부호는 발음과 무관하므로 제거 후 문자 단위로 비교한다(통상적 CER 관례).

export function normalizeForCer(text) {
  return (text || '')
    .normalize('NFC')
    .replace(/[\s ]+/g, '')
    .replace(/[.,!?;:'"“”‘’()[\]{}~\-·…—/\\]/g, '')
}

// 두 문자열의 Levenshtein 편집거리 — 행 2개만 유지하는 DP로 메모리를 아낀다.
export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1, // 삭제
        curr[j - 1] + 1, // 삽입
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // 교체
      )
    }
    prev = curr
  }
  return prev[b.length]
}

// 상한이 있는 편집거리 — "거리가 k 이내인가"만 알면 되는 검증용 경로.
// 전체 DP는 O(n·m)이라 6000자 두 개를 비교하면 3,600만 셀이 되어 엣지 런타임의
// CPU 한도를 넘겨 요청 자체가 죽는다. 그래서 세 단계로 줄인다.
//   ① 길이 차이가 k를 넘으면 DP 없이 초과 확정
//   ② 공통 접두·접미를 잘라낸다 (원문이 보존된 정상 케이스는 여기서 거의 0이 된다)
//   ③ 남은 부분만 밴드 폭 k로 DP — O(n·k)
// 그래도 셀 수가 예산을 넘으면 계산을 포기하고 null을 돌려준다.
// null은 "초과"가 아니라 "검증 불가"다 — 호출부가 통과시키지 않도록 구분해서 다뤄야 한다.
export function levenshteinCapped(a, b, k, cellBudget = 400_000) {
  if (a === b) return 0
  if (!(k >= 0)) return null
  if (Math.abs(a.length - b.length) > k) return k + 1

  let head = 0
  const shorter = Math.min(a.length, b.length)
  while (head < shorter && a[head] === b[head]) head++
  let tail = 0
  while (tail < shorter - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const s = a.slice(head, a.length - tail)
  const t = b.slice(head, b.length - tail)
  if (!s.length) return t.length <= k ? t.length : k + 1
  if (!t.length) return s.length <= k ? s.length : k + 1

  const band = Math.min(t.length, 2 * k + 1)
  if (s.length * band > cellBudget) return null

  const OVER = k + 1
  let prev = new Int32Array(t.length + 1)
  let curr = new Int32Array(t.length + 1)
  for (let j = 0; j <= t.length; j++) prev[j] = j <= k ? j : OVER

  for (let i = 1; i <= s.length; i++) {
    const lo = Math.max(1, i - k)
    const hi = Math.min(t.length, i + k)
    curr[0] = i <= k ? i : OVER
    if (lo > 1) curr[lo - 1] = OVER
    let rowMin = OVER
    for (let j = lo; j <= hi; j++) {
      const sub = prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      const del = prev[j] + 1
      const ins = curr[j - 1] + 1
      const v = Math.min(sub, del, ins)
      curr[j] = v > OVER ? OVER : v
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (hi < t.length) curr[hi + 1] = OVER
    // 이 행의 최솟값이 이미 k를 넘었으면 남은 행을 봐도 줄어들지 않는다.
    if (rowMin > k) return OVER
    const swap = prev
    prev = curr
    curr = swap
  }
  const d = prev[t.length]
  return d <= k ? d : OVER
}

// 상한 기반 CER 판정 — 임계 초과 여부만 필요한 검증 게이트용.
// 반환: { within, cer, refLength } 또는 검증 불가 시 { within: false, cer: null, unverifiable: true }
export function cerWithin(reference, hypothesis, maxCer) {
  const ref = normalizeForCer(reference)
  const hyp = normalizeForCer(hypothesis)
  if (!ref.length) return null
  const k = Math.floor(maxCer * ref.length)
  const d = levenshteinCapped(ref, hyp, k)
  if (d === null) return { within: false, cer: null, refLength: ref.length, unverifiable: true }
  if (d > k) return { within: false, cer: null, refLength: ref.length }
  return { within: true, cer: d / ref.length, distance: d, refLength: ref.length }
}

// 반환: { cer: 0~1 이상 가능(전사가 정답보다 훨씬 길 때), distance, refLength, accuracy }
export function computeCer(reference, hypothesis) {
  const ref = normalizeForCer(reference)
  const hyp = normalizeForCer(hypothesis)
  if (!ref.length) return null
  const distance = levenshtein(ref, hyp)
  const cer = distance / ref.length
  return {
    distance,
    refLength: ref.length,
    cer,
    accuracy: Math.max(0, 1 - cer),
  }
}
