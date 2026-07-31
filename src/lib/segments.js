// 전사 구간(타임코드) — 녹취를 "글자 덩어리"에서 "시간이 붙은 발화"로 바꾼다.
//
// 왜 이게 중심 기능인가:
// 지금 전사 결과는 평문 한 덩어리다. Whisper는 구간·단어마다 시작·끝 시각을 함께 주는데
// 그걸 통째로 버리고 text만 쓴다. 시간이 사라지면 실무에서 필요한 것들이 전부 불가능해진다.
//   - 문제가 된 대목을 눌러 그 지점부터 다시 듣기
//   - 화자 라벨이 틀린 구간만 골라 고치기
//   - 분석이 인용한 문장이 통화의 어디였는지 되짚기
//   - 침묵 시간·응답 지연처럼 **시간으로만 잴 수 있는** 품질 지표
// 마지막 항목이 특히 크다. 지금 대화 지표는 글자 수를 발화 시간의 대리값으로 쓰고 있고
// (callMetrics.js가 스스로 근사치라고 적어 두었다), 콜센터 QA가 실제로 보는 것은 시간이다.

// 단어를 발화로 묶을 때 "여기서 끊겼다"고 볼 간격(초)
export const UTTERANCE_GAP_SEC = 0.8
// 이보다 긴 무음은 "대기"로 본다 (통화에서 고객이 체감하는 침묵)
export const SILENCE_SEC = 3

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

// Whisper 응답에서 구간을 뽑는다.
// turbo는 segments를, base는 words를 준다. 둘 다 없으면 null — 시간 정보가 없다는 뜻이고,
// 그때는 있는 척하지 않는다(0으로 채우면 화면이 "침묵 0초"라고 거짓말한다).
export function toSegments(result) {
  if (!result) return null

  const segs = Array.isArray(result.segments) ? result.segments : null
  if (segs?.length) {
    const out = segs
      .map((s) => ({ start: num(s.start), end: num(s.end), text: String(s.text ?? '').trim() }))
      .filter((s) => s.start != null && s.end != null && s.text)
    if (out.length) return out
  }

  const words = Array.isArray(result.words) ? result.words : null
  if (words?.length) return groupWords(words)

  return null
}

// 단어 타임스탬프를 발화 단위로 묶는다.
// 문장부호에서도 끊는다 — 간격만으로 끊으면 빠르게 말하는 구간이 통째로 한 덩어리가 된다.
export function groupWords(words, { gap = UTTERANCE_GAP_SEC } = {}) {
  const clean = words
    .map((w) => ({ word: String(w.word ?? '').trim(), start: num(w.start), end: num(w.end) }))
    .filter((w) => w.word && w.start != null && w.end != null)
  if (!clean.length) return null

  const out = []
  let cur = null
  for (const w of clean) {
    const breakHere = cur && (w.start - cur.end >= gap || /[.?!。？！]$/.test(cur.lastWord))
    if (!cur || breakHere) {
      cur = { start: w.start, end: w.end, text: w.word, lastWord: w.word }
      out.push(cur)
    } else {
      cur.text += (/^[,.?!]/.test(w.word) ? '' : ' ') + w.word
      cur.end = w.end
      cur.lastWord = w.word
    }
  }
  return out.map(({ start, end, text }) => ({ start, end, text: text.trim() }))
}

const SPEAKER_RE = /^\s*(상담사|상담원|agent|고객|customer)\s*[:：]\s*/i
const isAgent = (label) => /상담사|상담원|agent/i.test(label)

// 화자 분리 결과(라벨이 붙은 텍스트)를 구간에 얹는다.
//
// 화자 분리는 텍스트만 돌려주므로 구간과 1:1로 맞지 않을 수 있다. 순서대로 맞추되,
// 줄 수가 다르면 남는 구간은 **비워 둔다** — 억지로 채우면 틀린 화자가 붙고,
// 그 틀린 라벨이 그대로 지표와 QA 평가로 들어간다.
export function assignSpeakers(segments, labeledText) {
  if (!segments?.length) return segments
  const lines = String(labeledText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => SPEAKER_RE.test(l))
  return segments.map((s, i) => {
    const line = lines[i]
    if (!line) return { ...s, speaker: null }
    const label = line.match(SPEAKER_RE)[1]
    return { ...s, speaker: isAgent(label) ? 'agent' : 'customer' }
  })
}

// 한 구간의 화자를 사람이 고친다. 고친 사실을 함께 남긴다 —
// 자동 판정과 사람 교정을 구분하지 못하면 정확도를 스스로 속이게 된다.
export function setSpeaker(segments, index, speaker) {
  return (segments || []).map((s, i) => (i === index ? { ...s, speaker, corrected: true } : s))
}

// 시간으로만 잴 수 있는 지표. 글자 수 대리값이 아니라 실측이다.
export function timeMetrics(segments) {
  const list = (segments || []).filter((s) => s.start != null && s.end != null)
  if (list.length < 2) return null

  const sorted = [...list].sort((a, b) => a.start - b.start)
  const totalSec = sorted[sorted.length - 1].end - sorted[0].start
  let agentSec = 0
  let customerSec = 0
  let silenceSec = 0
  let longestSilence = 0
  const delays = []

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    const dur = Math.max(0, s.end - s.start)
    if (s.speaker === 'agent') agentSec += dur
    else if (s.speaker === 'customer') customerSec += dur

    const next = sorted[i + 1]
    if (!next) continue
    const gap = next.start - s.end
    if (gap <= 0) continue
    if (gap >= SILENCE_SEC) {
      silenceSec += gap
      longestSilence = Math.max(longestSilence, gap)
    }
    // 고객 발화 뒤 상담사가 답하기까지 걸린 시간 — 체감 대기의 실제 값
    if (s.speaker === 'customer' && next.speaker === 'agent') delays.push(gap)
  }

  const spoken = agentSec + customerSec
  const round1 = (n) => Math.round(n * 10) / 10
  return {
    totalSec: round1(totalSec),
    agentSec: round1(agentSec),
    customerSec: round1(customerSec),
    // 화자 라벨이 없으면 비율을 만들지 않는다 (0%로 보여주면 사실과 다르다)
    agentRatio: spoken > 0 ? Math.round((agentSec / spoken) * 1000) / 10 : null,
    customerRatio: spoken > 0 ? Math.round((customerSec / spoken) * 1000) / 10 : null,
    silenceSec: round1(silenceSec),
    longestSilenceSec: round1(longestSilence),
    avgResponseDelaySec: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    maxResponseDelaySec: delays.length ? round1(Math.max(...delays)) : null,
    segments: sorted.length,
  }
}

// 시간 기반 진단 — 숫자만 보여주면 무엇이 문제인지 판단을 사람에게 떠넘기게 된다.
export function diagnoseTime(m) {
  if (!m) return []
  const out = []
  if (m.longestSilenceSec >= 10) {
    out.push({
      id: 'long-silence',
      level: 'warn',
      label: `${m.longestSilenceSec}초 무음 구간`,
      detail: '고객이 통화가 끊긴 줄 알 수 있는 길이입니다. 조회가 길어지면 상황을 말로 알려야 합니다.',
    })
  }
  if (m.maxResponseDelaySec != null && m.maxResponseDelaySec >= 5) {
    out.push({
      id: 'slow-response',
      level: 'warn',
      label: `응답까지 최대 ${m.maxResponseDelaySec}초`,
      detail: '고객 말이 끝난 뒤 상담사 응답이 늦은 구간이 있습니다.',
    })
  }
  if (m.agentRatio != null && m.agentRatio >= 75) {
    out.push({
      id: 'agent-dominant',
      level: 'warn',
      label: `상담사 발화 ${m.agentRatio}%`,
      detail: '상담사가 대화를 대부분 차지했습니다 — 고객이 상황을 설명할 여지가 적었을 수 있습니다.',
    })
  }
  if (out.length === 0 && m.segments > 0) {
    out.push({ id: 'time-ok', level: 'ok', label: '시간 지표 이상 없음', detail: '긴 무음·응답 지연·발화 편중이 발견되지 않았습니다.' })
  }
  return out
}

// 분석이 인용한 문장이 통화의 어디였는지 되짚는다 (근거 → 원음).
// 완전 일치를 기대할 수 없으므로(요약은 표현을 바꾼다) 겹치는 글자 수가 가장 많은 구간을 고른다.
export function findSegment(segments, quote) {
  const q = String(quote || '').replace(/\s/g, '')
  if (!q || !segments?.length) return -1
  let best = -1
  let bestScore = 0
  segments.forEach((s, i) => {
    const t = String(s.text || '').replace(/\s/g, '')
    if (!t) return
    let score = 0
    for (let n = 0; n < q.length - 1; n++) if (t.includes(q.slice(n, n + 2))) score += 1
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  // 2-gram이 3개도 안 겹치면 "찾았다"고 말하지 않는다 — 엉뚱한 구간으로 보내는 것이 더 나쁘다
  return bestScore >= 3 ? best : -1
}

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// 구간을 사람이 읽는 전사 텍스트로 (화자 라벨이 있으면 함께)
export function segmentsToText(segments) {
  return (segments || [])
    .map((s) => (s.speaker ? `${s.speaker === 'agent' ? '상담사' : '고객'}: ${s.text}` : s.text))
    .join('\n')
}
