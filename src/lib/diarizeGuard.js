import { computeCer } from './cer.js'

// 화자 분리 원문 보존 게이트 — "원문 단어를 바꾸지 말라"는 LLM 지시가 실제로
// 지켜졌는지 결정적으로 검증한다. CER 임계를 넘으면 분리 결과를 버리고 원문을 지킨다.
// (프롬프트 지시는 약속일 뿐, 검증이 있어야 신뢰할 수 있다)

const LABEL_RE = /^\s*(상담사|상담원|고객|agent)\s*[:：]\s*/i

export function stripSpeakerLabels(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.replace(LABEL_RE, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function preservesOriginal(original, formatted, threshold = 0.15) {
  const ref = stripSpeakerLabels(original)
  const hyp = stripSpeakerLabels(formatted)
  if (!ref) return { ok: false, cer: 1 }
  const { cer } = computeCer(ref, hyp)
  return { ok: cer <= threshold, cer }
}
