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
