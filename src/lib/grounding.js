// RAG 근거율(groundedness) — "근거 문서만 사용해 답하라"는 지시가 실제로 지켜졌는지
// 결정적으로 측정한다. 답변의 문자 2-gram 중 근거 문서에도 존재하는 비율.
// (화자 분리의 원문 보존 게이트와 같은 철학: 프롬프트 지시는 약속, 검증이 신뢰를 만든다)

function normalize(text) {
  return (text || '')
    .normalize('NFC')
    .replace(/[\s.,!?;:'"“”‘’()[\]{}~\-·…—/\\%]+/g, '')
}

export function charBigrams(text) {
  const s = normalize(text)
  const grams = new Set()
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2))
  return grams
}

// 0~1: 답변 2-gram이 근거 문서 텍스트에서 발견되는 비율
export function groundedness(answer, docsText) {
  const a = charBigrams(answer)
  if (a.size === 0) return 0
  const d = charBigrams(docsText)
  let hit = 0
  for (const g of a) if (d.has(g)) hit += 1
  return Math.round((hit / a.size) * 100) / 100
}
