// /analyze에서 분석한 통화를 브라우저(localStorage)에 누적해 VOC 대시보드에 합산한다.
// 서버에는 아무것도 저장하지 않는다 — 개인정보 미수집 원칙 유지.

// 날짜 함수만 필요하다 — vocPeriod를 거치면 원인 사전·급증 규칙까지 딸려 온다
import { todayIso } from './isoDate.js'

const KEY = 'cc-mycalls'
const AGENT_KEY = 'cc-my-agent'
const MAX_SAVED = 50
const MAX_AGENT_LEN = 20

// 저장된 기록을 대시보드가 바로 쓸 수 있는 형태로 맞춘다.
//
// 왜 필요한가: 이 저장 형식은 지금까지 두 번 늘어났다(churn·route 추가, 그리고 agent·로컬 날짜).
// 사용자의 브라우저에는 옛 형식 기록이 그대로 남아 있고, 그건 지워서는 안 되는 자산이다.
// 그래서 마이그레이션 대신 읽는 쪽에서 최소한만 보정한다 — 없는 필드는 만들어 주지 않고
// (없는 것을 지어내면 집계가 거짓말을 한다), 있으면 그대로 통과시킨다.
function normalize(row) {
  if (!row || typeof row !== 'object') return null
  return {
    ...row,
    date: typeof row.date === 'string' ? row.date : '',
    title: typeof row.title === 'string' ? row.title : '직접 분석한 통화',
    // analysis가 없는 기록이 하나라도 섞이면 대시보드 집계 루프가 통째로 터진다.
    // 필드를 채우지는 않는다 — 빈 객체는 "분류값이 없다"는 사실을 그대로 전달한다.
    analysis: row.analysis && typeof row.analysis === 'object' ? row.analysis : {},
    mine: true,
  }
}

export function loadMyCalls() {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(arr)) return []
    return arr.map(normalize).filter(Boolean)
  } catch {
    return []
  }
}

// 내 상담사 라벨 — 대시보드의 상담사 축은 이 값으로만 채워질 수 있다.
//
// 내장 샘플에는 agent 필드가 있지만 사용자가 분석한 통화에는 붙을 자리가 없었다.
// 라벨을 정해 두면 이후 저장되는 통화에 붙고, 정하지 않으면 '미지정'으로 묶인다.
// 이미 저장된 기록을 소급해서 고치지는 않는다 — 지난 기록을 나중에 다시 쓰기 시작하면
// 집계를 믿을 수 없게 된다.
export function getMyAgent() {
  try {
    return String(localStorage.getItem(AGENT_KEY) || '').slice(0, MAX_AGENT_LEN)
  } catch {
    return ''
  }
}

export function setMyAgent(label) {
  const clean = String(label || '').trim().slice(0, MAX_AGENT_LEN)
  try {
    if (clean) localStorage.setItem(AGENT_KEY, clean)
    else localStorage.removeItem(AGENT_KEY)
  } catch {
    // 저장 불가(시크릿 모드 등)여도 화면을 막지 않는다
  }
  return clean
}

// churn·route는 있으면 함께 저장한다. 대시보드가 "무슨 유형이 몇 건"에서
// "어느 통화가 위험했고 어디로 넘어갔는가"까지 답하려면 이 두 값이 남아야 한다.
// 점수와 등급·근거 라벨만 남기고 인용 발화는 저장하지 않는다 — 원문 미저장 원칙.
export function saveMyCall({ title, category, sentiment, escalate, churn, route, agent }) {
  try {
    const calls = loadMyCalls()
    // 상담사 라벨: 호출부가 준 값 > 사용자가 정해 둔 기본 라벨 > 없음.
    // 없으면 필드를 만들지 않는다 — 빈 문자열을 넣으면 대시보드에 이름 없는 상담사가 생긴다.
    const label = String(agent ?? getMyAgent() ?? '').trim().slice(0, MAX_AGENT_LEN)
    calls.push({
      id: `m${Date.now()}`,
      // 로컬 날짜로 기록한다. 예전에는 toISOString()(UTC)을 잘라 썼는데, KST(+9) 기준
      // 자정~오전 9시에 분석한 통화가 전날 날짜로 저장됐다. 기간 필터가 없던 때는 티가 안
      // 났지만, 이제는 오전 근무 중에 분석한 통화가 "오늘"에서 빠져 "어제"에 들어간다.
      date: todayIso(),
      title: (title || '직접 분석한 통화').slice(0, 40),
      ...(label ? { agent: label } : {}),
      analysis: {
        category,
        sentiment,
        escalate: Boolean(escalate),
        ...(Number.isFinite(churn?.score)
          ? {
              churn: {
                score: churn.score,
                level: churn.level,
                estimated: Boolean(churn.estimated),
                signals: (churn.signals || []).map((s) => s.label).slice(0, 6),
              },
            }
          : {}),
        ...(route?.team ? { route: { team: route.team, priority: route.priority } } : {}),
      },
      mine: true,
    })
    localStorage.setItem(KEY, JSON.stringify(calls.slice(-MAX_SAVED)))
    return true
  } catch {
    // 저장 불가(시크릿 모드 등)여도 분석 흐름을 막지 않는다.
    // 성공 여부는 돌려준다 — 삼키기만 하면 호출부가 "VOC 대시보드에 누적 완료"라고
    // 적고, /voc를 열면 그 통화가 없다.
    return false
  }
}

export function clearMyCalls() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 무시
  }
}
