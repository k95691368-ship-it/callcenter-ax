// 수퍼바이저의 업무 단위 — "통화 1건"이 아니라 **기간 × 상담사**.
//
// 왜 이 파일이 생겼는가:
// 이 시스템은 전부 통화 1건 단위로 설계돼 있었다. 대시보드는 로드된 전체를 한 덩어리로
// 그렸고, "어제"나 "이번 주"를 보는 방법이 없었다. 그런데 센터장이 실제로 묻는 것은
// "어제 무슨 일이 있었나", "이번 주가 직전 주보다 나빠졌나"이다.
//
// 그 결과 vocThemes.compareThemes(현재, 이전)는 **구현돼 있으면서 호출부가 없었다**.
// 비교 함수는 만들었는데 기간을 자르는 축이 없어 도달 불가 코드로 남아 있었다.
// 이 파일은 그 축을 만든다 — 여기서 나온 current/previous를 compareThemes에 그대로 넣는다.
//
// 상담사 축도 같은 이유로 죽어 있었다. sampleCalls.js의 10건에는 agent 필드가 붙어 있는데
// 집계에 쓰는 코드가 한 줄도 없었다. 데이터는 있는데 축이 없었다.
//
// 날짜는 'YYYY-MM-DD' 문자열로만 다룬다. Date 객체로 들고 다니면 로컬/UTC가 섞여
// 자정 근처에서 하루가 밀리고, 그러면 방금 분석한 통화가 "어제" 칸으로 사라진다.

import { ISO_DATE, shiftDays, daysBetween, todayIso, toUtcMs } from './isoDate.js'
import { isRepeatCall } from './vocThemes.js'
import { MIN_ABSOLUTE } from './vocAnomaly.js'

// 날짜 계산은 isoDate.js가 가진다 — 저장 계층(myCalls)이 이 파일을 거치지 않고
// 날짜 함수만 쓸 수 있게 분리했다. 기존 호출부가 깨지지 않도록 여기서 그대로 재수출한다.
export { ISO_DATE, shiftDays, daysBetween, todayIso } from './isoDate.js'

// 프리셋. back은 기준일에서 며칠 뒤로 물러난 지점을 구간의 끝으로 삼는지다.
export const PERIOD_PRESETS = [
  { id: 'today', label: '오늘', days: 1, back: 0 },
  { id: 'yesterday', label: '어제', days: 1, back: 1 },
  { id: 'week', label: '최근 7일', days: 7, back: 0 },
  { id: 'all', label: '전체', days: null, back: 0 },
]

export const DEFAULT_PERIOD = 'all'

const callDate = (call) => {
  const d = String(call?.date || '')
  return ISO_DATE.test(d) && toUtcMs(d) !== null ? d : null
}

function sortedDates(calls) {
  const out = []
  for (const c of Array.isArray(calls) ? calls : []) {
    const d = callDate(c)
    if (d) out.push(d)
  }
  return out.sort()
}

// 기준일 — "오늘"이 가리키는 날.
//
// 실제 오늘을 그대로 쓰지 않는 이유: 내장 샘플은 2026-07-21~27에 고정돼 있어서,
// 며칠 뒤에 이 화면을 열면 "오늘"·"최근 7일"이 전부 0건이 된다. 데이터가 있는데
// 화면이 비는 것은 기간 기능이 아니라 고장으로 읽힌다.
// 그래서 데이터의 마지막 날을 기준일로 잡되, 그 사실을 화면에 표시한다(VocPage).
// 사용자가 오늘 통화를 분석하면 그 날짜가 최댓값이 되어 기준일이 자동으로 실제 오늘이 된다.
export function anchorDate(calls, fallback) {
  const dates = sortedDates(calls)
  return dates.length > 0 ? dates[dates.length - 1] : fallback || todayIso()
}

// 프리셋 하나를 실제 날짜 구간으로 바꾼다.
// 반환: { id, label, start, end, days, isAll, anchor } — start/end는 양끝 포함.
export function resolvePeriod(presetId, { calls, anchor, today } = {}) {
  const preset =
    PERIOD_PRESETS.find((p) => p.id === presetId) || PERIOD_PRESETS.find((p) => p.id === DEFAULT_PERIOD)
  const anchorIso = (anchor && ISO_DATE.test(anchor) ? anchor : null) || anchorDate(calls, today)

  if (preset.id === 'all') {
    const dates = sortedDates(calls)
    const start = dates[0] || anchorIso
    const end = dates[dates.length - 1] || anchorIso
    return {
      id: 'all',
      label: preset.label,
      start,
      end,
      days: (daysBetween(start, end) ?? 0) + 1,
      isAll: true,
      anchor: anchorIso,
    }
  }

  const end = shiftDays(anchorIso, -preset.back)
  const start = shiftDays(end, -(preset.days - 1))
  return { id: preset.id, label: preset.label, start, end, days: preset.days, isAll: false, anchor: anchorIso }
}

// 선택 구간 **직전의 같은 길이** 구간. compareThemes에 넣을 짝을 만든다.
// '전체'는 직전 구간이 존재하지 않으므로 null을 준다 — 없는 비교를 지어내지 않는다.
export function previousRange(range) {
  if (!range || range.isAll || !range.start || !range.days) return null
  const end = shiftDays(range.start, -1)
  const start = shiftDays(end, -(range.days - 1))
  return { id: `${range.id}-prev`, label: `직전 ${range.days}일`, start, end, days: range.days, isAll: false }
}

export function inRange(call, range) {
  if (!range || range.isAll) return true
  const d = callDate(call)
  // 날짜가 없거나 형식이 깨진 기록은 어느 날에도 속할 수 없다. '전체'에서는 보이고
  // 기간 구간에서는 빠진다 — 임의의 날짜로 밀어 넣으면 그날 집계가 조용히 틀어진다.
  if (!d) return false
  return d >= range.start && d <= range.end // ISO 문자열은 사전순 비교가 곧 날짜 비교다
}

export function filterByRange(calls, range) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : []
  if (!range || range.isAll) return list
  return list.filter((c) => inRange(c, range))
}

// 프리셋 하나로 "선택 구간 + 직전 동일 길이 구간"을 함께 돌려준다.
// compareThemes(split.current, split.previous)로 바로 넘길 수 있게 하는 것이 이 함수의 목적이다.
export function splitPeriod(calls, presetId = DEFAULT_PERIOD, opts = {}) {
  const range = resolvePeriod(presetId, { calls, ...opts })
  const prevRange = previousRange(range)
  return {
    range,
    prevRange,
    anchor: range.anchor,
    current: filterByRange(calls, range),
    previous: prevRange ? filterByRange(calls, prevRange) : [],
    // 비교가 성립하는지.
    // '전체'는 비교 대상 구간 자체가 없고, 구간이 있어도 그 구간에 통화가 0건이면
    // 비교가 아니다 — 모든 원인이 '신규 +N'으로 찍혀 없던 급증을 보고하게 된다.
    // (내장 샘플만 있는 초기 상태에서 '최근 7일'을 누르면 바로 이 경우가 된다.)
    comparable: Boolean(prevRange) && filterByRange(calls, prevRange).length > 0,
  }
}

// 'MM/DD ~ MM/DD' 표기. 하루짜리 구간은 한 번만 쓴다.
export function formatRange(range) {
  if (!range || !range.start || !range.end) return ''
  const short = (d) => d.slice(5).replace('-', '/')
  return range.start === range.end ? short(range.start) : `${short(range.start)} ~ ${short(range.end)}`
}

// ── 상담사 축 ───────────────────────────────────────────────────────────────

export const UNLABELED_AGENT = '미지정'

// 내장 샘플은 agent 필드를 갖고 있고, 사용자가 분석한 통화는 라벨을 정해 둔 경우에만 갖는다.
// 없는 것을 아무 상담사에게 붙이지 않는다 — 잘못 붙은 라벨은 없는 라벨보다 나쁘다.
export function agentOf(call) {
  const raw = typeof call?.agent === 'string' ? call.agent.trim() : ''
  return raw || UNLABELED_AGENT
}

// 상담사별 집계.
//
// 표본이 작을 때 비율만 말하지 않는다: 1건 중 1건이 부정이면 "부정률 100%"가 되고,
// 그 숫자는 그대로 상담사 평가에 쓰인다. vocAnomaly가 급증 판정에 MIN_ABSOLUTE를 거는 것과
// 같은 이유로, 건수가 minSample 미만이면 비율 자체를 만들지 않고 null을 준다
// (0%가 아니라 null — 화면이 "표본 부족"과 "0%"를 구분해서 말할 수 있어야 한다).
export function aggregateByAgent(calls, { minSample = MIN_ABSOLUTE } = {}) {
  const map = new Map()

  for (const call of Array.isArray(calls) ? calls : []) {
    if (!call) continue
    const agent = agentOf(call)
    if (!map.has(agent))
      map.set(agent, {
        agent,
        labeled: agent !== UNLABELED_AGENT,
        count: 0,
        negative: 0,
        escalated: 0,
        repeat: 0,
        timedCount: 0,
        minutesSum: 0,
      })
    const row = map.get(agent)
    row.count += 1
    const sentiment = call.analysis?.sentiment
    if (sentiment === '부정' || sentiment === '강성') row.negative += 1
    if (call.analysis?.escalate) row.escalated += 1
    if (isRepeatCall(call)) row.repeat += 1
    if (Number.isFinite(call.minutes)) {
      row.timedCount += 1
      row.minutesSum += call.minutes
    }
  }

  const rows = [...map.values()]
    .map((r) => {
      const enough = r.count >= minSample
      return {
        ...r,
        enoughSample: enough,
        negativeRate: enough ? r.negative / r.count : null,
        escalateRate: enough ? r.escalated / r.count : null,
        repeatRate: enough ? r.repeat / r.count : null,
        // 평균 통화시간은 비율이 아니라 관측값이므로 표본이 적어도 그대로 보여준다.
        // 대신 시간이 기록된 통화가 없으면 0분이 아니라 null이다(미측정과 0분은 다르다).
        avgMinutes: r.timedCount > 0 ? r.minutesSum / r.timedCount : null,
      }
    })
    .sort((a, b) => {
      // '미지정'은 사람이 아니므로 순위 경쟁에 끼우지 않고 항상 맨 아래에 둔다
      if (a.labeled !== b.labeled) return a.labeled ? -1 : 1
      return b.count - a.count || (a.agent < b.agent ? -1 : 1)
    })

  return {
    rows,
    minSample,
    total: rows.reduce((s, r) => s + r.count, 0),
    unlabeled: map.get(UNLABELED_AGENT)?.count || 0,
    labeledAgents: rows.filter((r) => r.labeled).length,
  }
}
