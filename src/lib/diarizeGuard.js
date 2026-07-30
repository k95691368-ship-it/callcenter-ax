import { cerWithin } from './cer.js'

// 화자 분리 원문 보존 게이트 — "원문 단어를 바꾸지 말라"는 LLM 지시가 실제로
// 지켜졌는지 결정적으로 검증한다. CER 임계를 넘으면 분리 결과를 버리고 원문을 지킨다.
// (프롬프트 지시는 약속일 뿐, 검증이 있어야 신뢰할 수 있다)

export const MAX_DIARIZE_CER = 0.15

const LABEL_RE = /^\s*(상담사|상담원|고객|agent)\s*[:：]\s*/i

export function stripSpeakerLabels(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.replace(LABEL_RE, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 반환: { ok, cer, unverifiable? }
//   ok: true  — 원문이 보존됨 (cer은 실측값)
//   ok: false — 임계 초과(cer: null) 또는 검증 자체가 불가(unverifiable: true)
// 임계를 넘는 경우 정확한 CER은 구하지 않는다. "얼마나 다른지"가 아니라
// "임계 안인지"만 판단하면 되므로, 상한 밴드 DP로 CPU를 선형에 가깝게 묶는다.
export function preservesOriginal(original, formatted, threshold = MAX_DIARIZE_CER) {
  const ref = stripSpeakerLabels(original)
  const hyp = stripSpeakerLabels(formatted)
  if (!ref) return { ok: false, cer: 1 }
  const r = cerWithin(ref, hyp, threshold)
  if (!r) return { ok: false, cer: 1 }
  if (r.unverifiable) return { ok: false, cer: null, unverifiable: true }
  return { ok: r.within, cer: r.cer }
}
