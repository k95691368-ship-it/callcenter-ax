// 통화 타임라인 — 타임스탬프를 "판단에 쓰는 수치"로 바꾼다. (순수 함수, LLM 없음)
//
// 왜 필요한가:
// callMetrics.js는 발화량을 **글자 수**로 잰다. 스스로 "근사치"라고 적어 두었고 실제로 그렇다.
// 글자 수는 두 가지를 원리적으로 볼 수 없다.
//   1) 침묵 — 아무도 말하지 않은 시간은 글자가 0이라 존재 자체가 안 보인다.
//      고객을 30초 기다리게 한 통화와 쉼 없이 진행된 통화가 똑같이 찍힌다.
//   2) 발화 속도 — 같은 100자라도 20초에 말했는지 60초에 말했는지가 응대 품질이다.
//      말이 빨라지는 것은 다급하거나 화가 났다는 신호다.
// Whisper는 구간마다 start/end를 함께 주므로 이 둘을 **실측**으로 바꿀 수 있다.
//
// segments.js가 응답에서 구간을 뽑아내는 일(추출)을 맡고, 이 파일은 뽑힌 구간으로
// 시간 지표를 계산하는 일(집계)을 맡는다. 여기서는 응답 스키마를 알 필요가 없다.
//
// 확인된 응답 스키마 (Cloudflare 공식 문서, 2026-07 확인):
//   @cf/openai/whisper-large-v3-turbo → text(필수) · word_count · vtt ·
//     segments[]{start,end,text,temperature,avg_logprob,compression_ratio,no_speech_prob,words[]}
//     transcription_info{language,language_probability,duration,duration_after_vad}
//   @cf/openai/whisper(base) → text(필수) · word_count · vtt · words[]{word,start,end}  (segments 없음)
// 두 모델 모두 text만 required다 — 타임스탬프가 없는 응답을 정상으로 취급해야 한다.

// 침묵으로 셀 최소 간격(초). 대화에서 1~2초 끊김은 정상 리듬이다.
// 3초부터 고객이 "끊겼나? 듣고 있나?"를 의심하기 시작하므로 여기서 자른다.
export const SILENCE_MIN_SEC = 3

// 발화 속도를 낼 때 무시할 짧은 구간. 0.4초짜리 "네."는 분당 150자로 잡히는데,
// 그런 맞장구가 수십 개면 구간별 속도 비교가 통째로 잡음에 지배당한다.
const MIN_RATE_SEC = 0.8
const MIN_RATE_CHARS = 2

// 평소 속도(중앙값) 대비 이 배수를 넘으면 "빨라진 구간"으로 본다.
// 평균이 아니라 중앙값을 쓰는 이유: 빠른 구간 자체가 평균을 끌어올려 자기 자신을 숨긴다.
export const RATE_SPIKE_RATIO = 1.3

// 숫자만 통과시킨다. Number(null)·Number('')·Number(false)는 전부 0이라
// Number.isFinite(Number(v))로 거르면 **값이 없는 것이 0초로 둔갑한다**.
// 그러면 start가 빠진 구간이 통화 맨 앞(0초)에 붙어, 있지도 않은 긴 침묵이 만들어진다.
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const r1 = (n) => Math.round(n * 10) / 10

// 발화 글자 수 — 공백·문장부호를 뺀 글자 수.
// 한국어는 한 글자가 곧 한 음절이라 이 값이 음절 수와 같다(영문이 섞이면 음절보다 커진다).
export function speechChars(text) {
  return String(text || '').replace(/[\s\p{P}]/gu, '').length
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// 두 시각 사이가 "전사가 없는 구간"과 겹치는지.
// 겹친다면 그 침묵은 침묵이 아니라 **모르는 시간**이다 — 침묵으로 세면 안 된다.
function overlapsBlind(start, end, blind) {
  return blind.some((b) => {
    const bs = num(b?.start)
    const be = num(b?.end)
    return bs != null && be != null && start < be && end > bs
  })
}

// ===== 분할 전사 이어붙이기 =====
// 청크별 타임스탬프는 **청크 내부 기준(0초 시작)**이다. 오프셋을 더하지 않으면
// 27분 통화의 구간이 전부 0~55초에 뭉쳐서 침묵도 속도도 전부 거짓이 된다.
// audioChunk.js planChunks가 주는 청크의 start를 그대로 오프셋으로 쓴다.
//
// 입력: [{ start, end, segments }] — start/end는 전체 통화 기준 청크 경계(초),
//       segments는 그 청크를 전사한 응답의 구간(청크 내부 기준). 없으면 null/생략.
// 출력: { segments(전체 기준·시간순), blind(타임스탬프를 못 받은 청크의 시간 범위) }
export function stitchChunks(chunkResults = []) {
  const segments = []
  const blind = []

  chunkResults.forEach((c, i) => {
    const base = num(c?.start) ?? 0
    const limit = num(c?.end)
    const list = Array.isArray(c?.segments) ? c.segments : null

    // 데모 응답이거나 타임스탬프가 없는 청크. 이 구간은 "조용했다"가 아니라 "모른다"이므로
    // 침묵 계산에서 빼려고 범위를 기록해 둔다.
    if (!list?.length) {
      if (limit != null && limit > base) blind.push({ start: base, end: limit })
      return
    }

    for (const s of list) {
      const st = num(s?.start)
      const en = num(s?.end)
      const text = String(s?.text ?? '').trim()
      if (st == null || en == null || en < st || !text) continue

      let start = base + st
      let end = base + en
      // 모델이 청크 길이를 아주 살짝 넘겨 부르는 경우가 있다. 그대로 두면 다음 청크의
      // 첫 구간과 겹쳐 음(-)의 간격이 생기고, 침묵 계산이 어긋난다 — 경계에서 자른다.
      if (limit != null) {
        start = Math.min(start, limit)
        end = Math.min(end, limit)
      }
      segments.push({ start, end, text, speaker: s?.speaker ?? null, chunk: i })
    }
  })

  segments.sort((a, b) => a.start - b.start || a.end - b.end)
  return { segments, blind }
}

// ===== 시간 지표 =====
// 반환: 구간이 하나도 없으면 null — 타임스탬프가 없다는 뜻이고, 그때는 계산하지 않는다.
// 계산할 수 없는 것을 0으로 보여주면 "침묵 0초"라는 거짓말이 된다(이 프로젝트의 기존 원칙).
export function buildTimeline(segments, options = {}) {
  const { durationSec = null, silenceMinSec = SILENCE_MIN_SEC, blind = [] } = options

  // 오디오 실제 길이를 알면 그것이 상한이다. Whisper는 무음 구간에서 환각 텍스트를
  // 만들면서 오디오 끝을 넘긴 end를 부르는 일이 있는데, 그대로 두면 아래 callSec이
  // 그 값을 따라간다 — 실측: 30초 음성이 "통화 길이 10분 · 발화 밀도 100%"가 됐다.
  // 음수 시작도 같은 이유로 0에서 자른다("첫 발화까지 -5초"가 나왔다).
  const hardEnd = num(durationSec)
  const clamp = (v) => {
    if (v == null) return null
    const lo = Math.max(0, v)
    return hardEnd == null ? lo : Math.min(lo, hardEnd)
  }

  const list = (segments || [])
    .map((s) => ({
      start: clamp(num(s?.start)),
      end: clamp(num(s?.end)),
      text: String(s?.text ?? ''),
      speaker: s?.speaker ?? null,
      // 자르기 전 길이가 0이었거나 자르면서 0이 된 구간 — 시간에는 기여하지 않으면서
      // 글자만 남아 발화 속도(분당 글자)를 부풀린다. 표시는 하되 속도 계산에서 뺀다.
      rawSec: (num(s?.end) ?? 0) - (num(s?.start) ?? 0),
    }))
    .filter((s) => s.start != null && s.end != null && s.end >= s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (!list.length) return null

  // 겹치는 구간을 먼저 합친다. 합치지 않고 길이를 더하면 겹친 만큼 발화 시간이
  // 부풀어 "발화 시간 > 통화 길이" 같은 값이 나온다.
  const merged = []
  for (const s of list) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ start: s.start, end: s.end })
  }

  const speechSec = merged.reduce((a, m) => a + (m.end - m.start), 0)
  const firstStart = merged[0].start
  const lastEnd = merged[merged.length - 1].end
  // 통화 길이는 0초부터 잰다. durationSec(음성 파일의 실제 길이)이 있으면 그쪽이 진짜다 —
  // 마지막 발화 뒤의 무음은 전사에 흔적이 없어서 구간만으로는 영영 안 보인다.
  const callSec = Math.max(num(durationSec) ?? 0, lastEnd)

  const blindSec = (blind || []).reduce((a, b) => {
    const bs = num(b?.start)
    const be = num(b?.end)
    return a + (bs != null && be != null && be > bs ? be - bs : 0)
  }, 0)
  // 전사를 못 받은 구간을 뺀 "실제로 관측된" 시간. 비율은 이 위에서만 의미가 있다.
  const coveredSec = Math.max(0, callSec - blindSec)

  // 침묵 구간 — 발화와 발화 사이의 빈틈. 위치를 함께 준다(합계만 주면 어디를 들어봐야
  // 할지 알 수 없어 QA가 결국 통화 전체를 다시 듣게 된다).
  const silences = []
  for (let i = 0; i < merged.length - 1; i++) {
    const gapStart = merged[i].end
    const gapEnd = merged[i + 1].start
    const sec = gapEnd - gapStart
    if (sec < silenceMinSec) continue
    if (overlapsBlind(gapStart, gapEnd, blind)) continue
    silences.push({ start: r1(gapStart), end: r1(gapEnd), sec: r1(sec) })
  }
  const silenceSec = silences.reduce((a, s) => a + s.sec, 0)
  const longest = silences.reduce((m, s) => (s.sec > m.sec ? s : m), { sec: 0, start: null })

  // 첫 발화 전 / 마지막 발화 후의 무음은 상담 중 침묵과 성격이 다르다(연결음·종료 대기).
  // 같은 통에 넣으면 "침묵 40초"가 실제로는 녹음 앞뒤 여백인 경우가 생긴다 — 따로 낸다.
  //
  // 여기에도 blind를 적용한다. 위 침묵 계산에만 걸어두고 여기서 빠뜨리면, 첫 청크의
  // 타임스탬프를 못 받았을 때 그 구간이 통째로 "첫 발화까지 57초"로 둔갑한다 —
  // 실제로는 그 시간에 무슨 말이 오갔는지 **모른다**. 모르는 것은 null로 둔다.
  const leadingSec = overlapsBlind(0, firstStart, blind) ? null : firstStart
  const trailingSec = overlapsBlind(lastEnd, callSec, blind) ? null : Math.max(0, callSec - lastEnd)

  // 발화 속도 — 분당 글자(한국어에서는 분당 음절).
  //
  // 분자(글자)와 분모(시간)의 기준을 맞춘다. 길이가 0인 구간은 speechSec에 1초도
  // 보태지 않으면서 글자는 전부 보태므로, 그대로 두면 속도가 실제보다 높게 나온다 —
  // 실측: 0초 구간 하나 때문에 분당 48자가 174자로 찍혔다(3.6배).
  // 그런 구간은 "얼마나 빨리 말했는가"를 판단할 근거 자체가 없으므로 분자에서도 뺀다.
  const timed = list.filter((s) => s.end > s.start)
  const totalChars = timed.reduce((a, s) => a + speechChars(s.text), 0)
  const charsPerMin = speechSec > 0 && totalChars > 0 ? Math.round((totalChars / speechSec) * 60) : null

  const rated = list
    .map((s) => ({ start: s.start, end: s.end, sec: s.end - s.start, chars: speechChars(s.text), text: s.text, speaker: s.speaker }))
    .filter((s) => s.sec >= MIN_RATE_SEC && s.chars >= MIN_RATE_CHARS)
    .map((s) => ({ ...s, cpm: Math.round((s.chars / s.sec) * 60) }))
  const medianCpm = median(rated.map((s) => s.cpm))
  const fastSegments = medianCpm
    ? rated
        .filter((s) => s.cpm >= medianCpm * RATE_SPIKE_RATIO)
        .map((s) => ({ start: r1(s.start), cpm: s.cpm, text: s.text, speaker: s.speaker }))
    : []

  return {
    segments: list.length,
    callSec: r1(callSec),
    speechSec: r1(speechSec),
    // 발화가 통화의 몇 %인지. 관측된 시간(coveredSec) 기준이다.
    speechRatio: coveredSec > 0 ? Math.round((speechSec / coveredSec) * 1000) / 10 : null,
    silences,
    silenceCount: silences.length,
    silenceSec: r1(silenceSec),
    longestSilenceSec: r1(longest.sec),
    longestSilenceAt: longest.start,
    // null(= 그 구간을 모른다)은 0으로 반올림되지 않게 그대로 통과시킨다
    leadingSilenceSec: leadingSec == null ? null : r1(leadingSec),
    trailingSilenceSec: trailingSec == null ? null : r1(trailingSec),
    charsPerMin,
    medianCharsPerMin: medianCpm == null ? null : Math.round(medianCpm),
    fastSegments,
    ratedSegments: rated.length,
    // 분할 전사에서 일부 청크의 타임스탬프를 못 받았다는 뜻. 화면이 이 사실을 말해야 한다.
    partial: blindSec > 0,
    blindSec: r1(blindSec),
    coveredSec: r1(coveredSec),
  }
}

// 수치를 사람이 읽는 진단으로. 근거가 되는 실제 값을 항상 함께 돌려준다 — 판단은 사람이 한다.
// (segments.js diagnoseTime은 화자 기준 지표를 본다. 여기서는 화자 라벨 없이도 나오는
//  시간 지표 — 침묵 위치·발화 밀도·속도 변화 — 만 다룬다.)
export function diagnoseTimeline(t) {
  if (!t) return []
  const out = []

  if (t.partial) {
    out.push({
      id: 'partial-timeline',
      level: 'info',
      label: '일부 구간 타임스탬프 없음',
      detail: `${t.blindSec}초 분량은 시간 정보를 받지 못해 계산에서 제외했습니다 — 침묵·속도는 나머지 ${t.coveredSec}초 기준입니다.`,
    })
  }

  if (t.longestSilenceSec >= 10) {
    out.push({
      id: 'long-silence',
      level: 'warn',
      label: `${t.longestSilenceSec}초 침묵`,
      detail: `${formatClock(t.longestSilenceAt)} 지점에서 가장 길게 끊겼습니다 — 고객이 통화가 끊긴 줄 알 수 있는 길이입니다. 조회가 길어지면 상황을 말로 알려야 합니다.`,
    })
  } else if (t.silenceCount > 0) {
    out.push({
      id: 'silence',
      level: 'info',
      label: `${SILENCE_MIN_SEC}초 이상 침묵 ${t.silenceCount}회`,
      detail: `합계 ${t.silenceSec}초, 가장 긴 구간은 ${formatClock(t.longestSilenceAt)}에서 ${t.longestSilenceSec}초입니다.`,
    })
  } else {
    out.push({
      id: 'no-silence',
      level: 'ok',
      label: '긴 침묵 없음',
      detail: `${SILENCE_MIN_SEC}초 이상 끊긴 구간이 없습니다 — 대기를 체감할 만한 공백이 없었습니다.`,
    })
  }

  // 발화 밀도가 낮다는 것은 통화 시간의 상당 부분을 아무도 말하지 않았다는 뜻이다.
  if (t.speechRatio != null && t.speechRatio < 55) {
    out.push({
      id: 'low-density',
      level: 'warn',
      label: `발화 밀도 ${t.speechRatio}%`,
      detail: `통화 ${formatClock(t.callSec)} 중 실제 발화는 ${formatClock(t.speechSec)}입니다 — 대기·조회 시간이 통화의 절반에 가깝습니다.`,
    })
  }

  if (t.fastSegments.length > 0 && t.medianCharsPerMin) {
    const top = t.fastSegments.reduce((m, s) => (s.cpm > m.cpm ? s : m))
    out.push({
      id: 'rate-spike',
      level: 'warn',
      label: `발화 속도 급상승 ${t.fastSegments.length}구간`,
      detail: `평소 분당 ${t.medianCharsPerMin}자에서 최대 분당 ${top.cpm}자까지 빨라졌습니다 (${formatClock(top.start)}) — 다급하거나 감정이 올라간 구간일 수 있어 원음 확인이 필요합니다.`,
    })
  }

  // null이면 진단하지 않는다 — 모르는 구간을 두고 "응대가 늦었다"고 말할 수 없다
  if (t.leadingSilenceSec != null && t.leadingSilenceSec >= 5) {
    out.push({
      id: 'late-open',
      level: 'info',
      label: `첫 발화까지 ${t.leadingSilenceSec}초`,
      detail: '녹음 시작 후 첫 발화까지 공백이 있었습니다 — 연결음 구간인지 응대 지연인지 확인이 필요합니다.',
    })
  }

  return out
}

// 초를 m:ss로. 통화는 분 단위로 읽는 것이 자연스럽다.
export function formatClock(sec) {
  const s = Math.max(0, Math.round(num(sec) ?? 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
