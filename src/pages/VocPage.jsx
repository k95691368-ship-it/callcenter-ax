import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SAMPLE_CALLS, CATEGORIES, SENTIMENTS } from '../lib/sampleCalls.js'
import { loadMyCalls, clearMyCalls, getMyAgent, setMyAgent } from '../lib/myCalls.js'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import { NumbersVerifiedBadge } from '../components/VerifyBadge.jsx'
import { buildVocCsv } from '../lib/vocCsv.js'
import { detectVocAnomalies, MIN_ABSOLUTE } from '../lib/vocAnomaly.js'
import { aggregateThemes, compareThemes } from '../lib/vocThemes.js'
import {
  PERIOD_PRESETS,
  DEFAULT_PERIOD,
  splitPeriod,
  formatRange,
  aggregateByAgent,
  todayIso,
  UNLABELED_AGENT,
} from '../lib/vocPeriod.js'
import { selfCheck } from '../lib/selfCheck.js'
import { estimateChurn } from '../lib/churnRisk.js'
import { routeTicket } from '../lib/ticketDraft.js'

// 감정 축은 순서형(긍정→강성)이므로 단일 색조의 순차 램프로 칠한다 (무지개 금지)
const SENTIMENT_RAMP = { 긍정: '#cfe1fc', 중립: '#8fbafa', 부정: '#4593fc', 강성: '#1b64da' }

const CATEGORY_BADGE = {
  가입: 'cat-praise',
  해지: 'cat-refund',
  요금: 'cat-ship',
  불만: 'cat-quality',
  기타: 'cat-etc',
}

// 라벨 입력칸 — App.css에 범용 input 스타일이 없어 토큰만 빌려 최소한으로 맞춘다
const INPUT_STYLE = {
  padding: '7px 12px',
  border: '1px solid var(--line)',
  borderRadius: '8px',
  background: 'var(--surface)',
  color: 'var(--ink-900)',
  fontSize: '13px',
  maxWidth: '180px',
}

// 일별 추이 꺾은선 — 단일 시리즈, 2px 선, 마커 + 네이티브 툴팁, 마지막 점 직접 라벨
function TrendChart({ points }) {
  // 기간 선택이 생기면서 "그 기간에 통화가 0건"인 상태가 실제로 발생한다.
  // 예전에는 내장 샘플이 늘 있어 빈 배열이 올 수 없었고, 그래서 Math.max(...[])가
  // -Infinity가 되고 마지막 점이 undefined가 되는 경로가 그대로 남아 있었다.
  if (!points || points.length === 0) return null
  const W = 560
  const H = 180
  const PAD = { top: 18, right: 46, bottom: 28, left: 30 }
  const maxY = Math.max(...points.map((p) => p.count), 1)
  const x = (i) =>
    PAD.left + (points.length < 2 ? 0.5 : i / (points.length - 1)) * (W - PAD.left - PAD.right)
  const y = (v) => H - PAD.bottom - (v / maxY) * (H - PAD.top - PAD.bottom)
  const tickStep = Math.max(1, Math.ceil(maxY / 4))
  const gridTicks = []
  for (let v = 0; v <= maxY; v += tickStep) gridTicks.push(v)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.count)}`).join(' ')
  const last = points[points.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="voc-trend" role="img" aria-label="일별 통화 건수 추이">
      {/* 격자선을 값마다 그리면 건수가 늘수록 선이 늘어난다 — 40건이면 41줄이 겹친다.
          눈금 개수를 고정하고 간격만 데이터에 맞춰 늘린다. */}
      {gridTicks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className="voc-axis-text">
            {v}
          </text>
        </g>
      ))}
      {points.map((p, i) => (
        <text key={p.date} x={x(i)} y={H - 8} textAnchor="middle" className="voc-axis-text">
          {p.date.slice(8)}일
        </text>
      ))}
      <path d={path} fill="none" stroke="var(--blue-600)" strokeWidth="2" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={p.date} cx={x(i)} cy={y(p.count)} r="4" fill="var(--blue-600)" stroke="var(--surface)" strokeWidth="2">
          <title>{`${p.date} · ${p.count}건`}</title>
        </circle>
      ))}
      <text x={x(points.length - 1) + 8} y={y(last.count) + 4} className="voc-line-label">
        {last.count}건
      </text>
    </svg>
  )
}

export default function VocPage() {
  const [myCalls, setMyCalls] = useState(loadMyCalls)

  // 대장의 '이탈위험·담당' 열이 늘 비어 있었다. 값이 없어서가 아니라, 전사가 있는데도
  // 아무도 계산하지 않았기 때문이다 — 두 함수 모두 순수 규칙이라 AI 키 없이 즉시 나온다.
  // 직접 분석한 통화는 서버가 계산한 값을 이미 갖고 있으므로 그대로 쓴다(재계산하지 않는다).
  const calls = useMemo(
    () =>
      [...SAMPLE_CALLS, ...myCalls].map((c) => {
        if (c.analysis?.churn || !c.transcript) return c
        const churn = estimateChurn(c.transcript)
        const route = routeTicket({
          text: c.transcript,
          category: c.analysis?.category,
          churnScore: churn.score,
        })
        return { ...c, analysis: { ...c.analysis, churn, route } }
      }),
    [myCalls]
  )

  // 기간 축 — 이 대시보드의 업무 단위는 통화 1건이 아니라 "상담사 여러 명 × 기간"이다.
  // splitPeriod는 선택 구간과 **직전 동일 길이 구간**을 함께 준다. 그래야
  // 이미 구현돼 있던 compareThemes(현재, 이전)를 그대로 호출할 수 있다 —
  // 그 함수는 구간을 자르는 축이 없어서 지금까지 호출부가 하나도 없는 상태였다.
  const [periodId, setPeriodId] = useState(DEFAULT_PERIOD)
  const period = useMemo(() => splitPeriod(calls, periodId), [calls, periodId])
  const view = period.current
  const filtered = !period.range.isAll
  const realToday = todayIso()

  // 축마다 filter를 걸면 카테고리 5회 + 감정 4회 + 날짜 D회로 같은 배열을 12번 넘게
  // 다시 훑는다(축이나 날짜가 늘 때마다 순회도 함께 늘어난다). 한 번의 루프에서 Map에
  // 누적해 순회 횟수를 입력 크기와 무관하게 고정한다. 출력 구조는 그대로 — 차트와 표가
  // byCategory/bySentiment/byDate/escalated/hot/avgMin의 형태에 그대로 의존한다.
  const agg = useMemo(() => {
    const catCount = new Map(CATEGORIES.map((c) => [c, 0]))
    const sentCount = new Map(SENTIMENTS.map((s) => [s, 0]))
    const dateCount = new Map()
    const escalated = []
    const hot = []
    let timedCount = 0
    let timedSum = 0
    for (const call of view) {
      const { category, sentiment, escalate } = call.analysis
      // 알려진 축에 없는 값은 세지 않는다 — 이전 filter 방식과 같은 결과를 유지한다
      if (catCount.has(category)) catCount.set(category, catCount.get(category) + 1)
      if (sentCount.has(sentiment)) sentCount.set(sentiment, sentCount.get(sentiment) + 1)
      dateCount.set(call.date, (dateCount.get(call.date) || 0) + 1)
      if (escalate) escalated.push(call)
      if (sentiment === '강성' || sentiment === '부정') hot.push(call)
      // 직접 분석한 통화에는 통화 시간이 없으므로 내장 샘플 기준으로만 평균을 낸다
      if (typeof call.minutes === 'number') {
        timedCount += 1
        timedSum += call.minutes
      }
    }
    const byCategory = CATEGORIES.map((c) => ({ name: c, count: catCount.get(c) }))
    const bySentiment = SENTIMENTS.map((s) => ({ name: s, count: sentCount.get(s) }))
    const byDate = [...dateCount.keys()].sort().map((d) => ({ date: d, count: dateCount.get(d) }))
    const avgMin = timedSum / Math.max(timedCount, 1)
    // timedCount를 함께 돌려준다. 시간이 기록된 통화가 하나도 없을 때 avgMin은 0이 되는데,
    // 0.0분은 "짧은 통화"라는 뜻으로 읽힌다 — 미측정과 0을 화면에서 구분하기 위한 값이다.
    return { byCategory, bySentiment, byDate, escalated, hot, avgMin, timedCount }
  }, [view])

  const maxCat = Math.max(...agg.byCategory.map((c) => c.count), 1)
  const maxSent = Math.max(...agg.bySentiment.map((s) => s.count), 1)

  // 규칙으로 계산되는 것들 — LLM도 API 키도 필요 없고, 근거 수치를 그대로 보여줄 수 있다.
  // 급증 감지는 만들어 두고도 어느 화면에도 연결되지 않아, 운영자가 볼 방법이 없었다.
  const anomalies = useMemo(() => detectVocAnomalies(view), [view])
  // 카테고리는 '불만' 한 칸이지만 그 안에는 속도 저하·과다 청구·응대 미흡이 섞여 있다.
  // 넘길 부서가 다르므로, 집계 단위가 원인이어야 조직이 움직인다.
  const themes = useMemo(() => aggregateThemes(view), [view])
  const maxTheme = Math.max(...themes.themes.map((t) => t.count), 1)
  // 사각지대 자가 점검 — 못 잡은 통화에서 사전 후보를 스스로 뽑는다
  const check = useMemo(() => selfCheck(view), [view])
  // 상담사 축 — 샘플의 agent 필드는 지금까지 어떤 집계에도 쓰이지 않았다
  const agents = useMemo(() => aggregateByAgent(view), [view])

  // 원인 단위 기간 비교 — "무엇이 늘었나"에 부서까지 붙여서 답한다
  const diff = useMemo(
    () => (period.comparable ? compareThemes(period.current, period.previous) : []),
    [period]
  )
  const rises = diff.filter((d) => d.delta > 0).slice(0, 5)
  // diff는 증감 내림차순이라 감소분은 뒤쪽에 몰린다. 감소가 가장 큰 것부터 보이게 뒤집는다.
  const falls = diff.filter((d) => d.delta < 0).slice(-3).reverse()
  // 막대 기준값은 행마다 다시 계산하면 렌더할 때마다 diff를 n번 훑는다 — 한 번만 구한다
  const maxDiffCount = Math.max(...diff.map((d) => d.count), 1)

  // AI 인사이트 리포트 — 집계 수치만 서버로 보낸다 (통화 원문 미전송)
  const [report, setReport] = useState(null)
  const [reporting, setReporting] = useState(false)
  const [reportError, setReportError] = useState('')

  // 내 상담사 라벨 (브라우저에만 저장) — 앞으로 저장될 통화에만 붙는다
  const [agentDraft, setAgentDraft] = useState(getMyAgent)
  const [agentNotice, setAgentNotice] = useState('')

  // 통화 원장을 CSV로 내려받는다 (엑셀 한글 호환 BOM 포함, 브라우저 내 처리)
  // 화면에서 기간을 좁혀 놓고 내려받으면 전체가 나오던 예전 동작은 회의 자료를 만들 때
  // 곧바로 숫자 불일치가 된다 — 보이는 것과 받는 것을 같게 한다.
  function downloadCsv() {
    // 엑셀은 BOM이 없으면 UTF-8 CSV를 시스템 인코딩으로 읽어 한글이 깨진다.
    // 소스에 보이지 않는 문자를 직접 넣지 않으려고 코드포인트로 만든다.
    const BOM = String.fromCharCode(0xfeff)
    const blob = new Blob([BOM + buildVocCsv(view)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `voc-리포트-${period.range.start}_${period.range.end}.csv`
    // 앵커를 DOM에 붙이지 않으면 일부 브라우저가 클릭을 무시하고, 다운로드 처리는
    // 비동기라 click 직후 URL을 해제하면 저장이 조용히 실패한다.
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function generateReport() {
    setReporting(true)
    setReportError('')
    try {
      const data = await postJson('/api/cc/voc-report', {
        total: view.length,
        byCategory: agg.byCategory,
        bySentiment: agg.bySentiment,
        escalatedCount: agg.escalated.length,
        escalatedTitles: agg.escalated.map((c) => c.title),
      })
      setReport(data)
    } catch (err) {
      setReportError(err.message)
    } finally {
      setReporting(false)
    }
  }

  function saveAgentLabel() {
    const saved = setMyAgent(agentDraft)
    setAgentDraft(saved)
    setAgentNotice(
      saved
        ? `앞으로 저장되는 통화는 '${saved}'로 묶입니다. 이미 저장된 기록은 그대로 둡니다.`
        : '라벨을 지웠습니다. 앞으로 저장되는 통화는 미지정으로 묶입니다.'
    )
  }

  const pctText = (n, d) => `${Math.round((n / d) * 100)}%`

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ⑤ VOC 분석 · 집계 대시보드</span>
        <h1>VOC 대시보드</h1>
        <p>
          통화 분석 결과가 쌓이면 이런 그림이 됩니다 — 내장 가상 통화{' '}
          <strong>{SAMPLE_CALLS.length}건</strong>
          {myCalls.length > 0 && (
            <>
              {' '}+ <strong>내가 분석한 통화 {myCalls.length}건</strong>
            </>
          )}
          을 <strong>기간 · 상담사 · 원인</strong>으로 집계했습니다.{' '}
          <Link to="/analyze">통화 분석</Link>을 돌릴 때마다 이 대시보드에 실시간으로 누적됩니다
          (브라우저에만 저장, 서버 미전송).{' '}
          <button type="button" className="preset-chip" onClick={downloadCsv}>
            ⬇ CSV 내보내기 (선택 기간 · 엑셀 호환)
          </button>
          {myCalls.length > 0 && (
            <>
              {' '}
              <button
                type="button"
                className="preset-chip"
                onClick={() => {
                  clearMyCalls()
                  setMyCalls([])
                }}
              >
                내 분석 기록 지우기
              </button>
            </>
          )}
        </p>
      </header>

      {/* 기간 선택 — 수퍼바이저의 질문은 "이 통화가 어땠나"가 아니라
          "어제가 그저께보다 나빠졌나"이다. 이 축이 없으면 그 질문에 답할 방법이 없다. */}
      <div className="tab-row" role="group" aria-label="집계 기간 선택">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`tab${periodId === p.id ? ' active' : ''}`}
            aria-pressed={periodId === p.id}
            onClick={() => setPeriodId(p.id)}
          >
            {p.label}
          </button>
        ))}
        <span className="usage-note" style={{ alignSelf: 'center' }}>
          {formatRange(period.range)} · {view.length}건
          {filtered && ` (전체 ${calls.length}건 중)`}
        </span>
      </div>

      {period.anchor !== realToday && (
        <p className="result-empty-sub">
          기준일은 <strong>{period.anchor}</strong>(데이터의 마지막 통화 날짜)입니다 — 실제 오늘은{' '}
          {realToday}입니다. 내장 샘플은 날짜가 고정된 가상 데이터라, 실제 오늘을 기준으로 잡으면
          '오늘'·'최근 7일'이 전부 0건이 됩니다. 직접 분석한 통화가 쌓이면 기준일은 자동으로 실제
          날짜를 따라갑니다.
        </p>
      )}

      <div className="stat-row voc-stats">
        <div className="stat-tile">
          <span className="stat-label">분석된 통화</span>
          <span className="stat-value">
            {view.length}건
            {filtered && <em className="stat-note"> 전체 {calls.length}건 중</em>}
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">부정·강성 비율</span>
          {/* 표본이 작을 때 비율만 말하지 않는다 — 3건 중 1건을 "33%"로 적으면
              분모가 보이지 않아 실제보다 큰 사실처럼 읽힌다 (vocAnomaly의 MIN_ABSOLUTE와 같은 감각) */}
          <span className="stat-value">
            {view.length >= MIN_ABSOLUTE ? pctText(agg.hot.length, view.length) : `${agg.hot.length}건`}
            <em className="stat-note">
              {view.length >= MIN_ABSOLUTE
                ? ` ${agg.hot.length}건 / ${view.length}건`
                : ` 표본 ${view.length}건 — 비율 생략`}
            </em>
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">에스컬레이션</span>
          <span className="stat-value">
            {agg.escalated.length}건<em className="stat-note"> 판단 필요 건</em>
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">평균 통화 시간</span>
          <span className="stat-value">
            {agg.timedCount > 0 ? `${agg.avgMin.toFixed(1)}분` : '—'}
            <em className="stat-note">
              {agg.timedCount > 0 ? ` 시간 기록 ${agg.timedCount}건` : ' 시간이 기록된 통화 없음'}
            </em>
          </span>
        </div>
      </div>

      {view.length === 0 && (
        <section className="voc-card voc-card-wide">
          <h2>이 기간에는 통화가 없습니다</h2>
          <p className="result-empty-sub">
            {formatRange(period.range)} 구간에 집계할 통화가 없습니다. 없는 구간을 0으로 채우거나
            가까운 날짜의 통화를 끌어오지 않습니다 — 빈 구간은 빈 채로 보여주는 것이 사실입니다.
            다른 기간을 선택하거나 <Link to="/analyze">통화 분석</Link>으로 기록을 쌓아보세요.
          </p>
        </section>
      )}

      {/* 대시보드는 "무엇이 달라졌는지"를 먼저 말해야 한다 — 막대를 눈으로 비교하게 두면 급증을 놓친다 */}
      {anomalies.length > 0 && (
        <section className="voc-alerts" aria-label="이상 감지">
          {anomalies.map((a) => (
            <div className={`voc-alert voc-alert-${a.level}`} key={a.id}>
              <strong>{a.level === 'high' ? '🔴' : '🟡'} {a.label}</strong>
              <span>{a.detail}</span>
            </div>
          ))}
          <p className="voc-alert-note">
            규칙으로 계산한 경보입니다 (최소 {MIN_ABSOLUTE}건 이상 + 이전 일평균의 2배 이상). LLM·API
            호출 없이 브라우저에서 판정하므로 비용이 들지 않고, 근거 수치를 그대로 보여줍니다.
            {agg.byDate.length < 3 && ' 선택한 기간이 3일 미만이라 일평균 대비 급증 판정은 하지 않았습니다.'}
          </p>
        </section>
      )}

      <div className="voc-grid">
        {/* 기간 비교 — 이미 있던 compareThemes를 여기에 연결한다.
            카테고리 급증 경보가 "불만이 늘었다"까지라면, 이 표는 "속도 저하가 늘었고
            네트워크 품질팀 일이다"까지 간다. */}
        <section className="voc-card voc-card-wide">
          <h2>
            직전 구간과 무엇이 달라졌나
            <span className="voc-card-sub">
              (선택 {formatRange(period.range)} vs 직전{' '}
              {period.comparable ? formatRange(period.prevRange) : '—'} · 원인 단위 비교)
            </span>
          </h2>

          {!period.comparable ? (
            <p className="result-empty-sub">
              '전체'는 비교할 직전 구간이 없습니다 — 없는 구간을 지어내지 않습니다. 위에서{' '}
              <strong>오늘 · 어제 · 최근 7일</strong> 중 하나를 고르면 같은 길이의 직전 구간과
              원인 단위로 비교합니다.
            </p>
          ) : (
            <>
              <div className="stat-row">
                <div className="stat-tile">
                  <span className="stat-label">선택 구간</span>
                  <span className="stat-value">
                    {period.current.length}건<em className="stat-note"> {formatRange(period.range)}</em>
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">직전 구간</span>
                  <span className="stat-value">
                    {period.previous.length}건
                    <em className="stat-note"> {formatRange(period.prevRange)}</em>
                  </span>
                </div>
                <div className="stat-tile">
                  <span className="stat-label">총 건수 증감</span>
                  <span className="stat-value">
                    {period.current.length - period.previous.length > 0 ? '+' : ''}
                    {period.current.length - period.previous.length}건
                  </span>
                </div>
              </div>

              {rises.length === 0 && falls.length === 0 ? (
                <p className="result-empty-sub">
                  두 구간 사이에 원인 단위 증감이 없습니다
                  {period.previous.length === 0 &&
                    ' — 직전 구간에 통화가 한 건도 없어 비교 기준이 없습니다'}
                  .
                </p>
              ) : (
                <div className="theme-list">
                  {rises.map((d) => (
                    <div className="theme-row" key={`up-${d.id}`}>
                      <div className="theme-head">
                        <strong>▲ {d.label}</strong>
                        <span className="theme-dept">{d.dept}</span>
                        {d.isNew && <span className="theme-dept">신규</span>}
                        <span className="theme-count">
                          {d.previous}건 → {d.count}건 (+{d.delta})
                        </span>
                      </div>
                      <span className="rank-track">
                        <span
                          className="rank-fill"
                          style={{ width: `${(d.count / maxDiffCount) * 100}%` }}
                        />
                      </span>
                      {/* 표본이 작으면 "몇 배"라고 말하지 않는다. 1건 → 2건은 100% 증가지만
                          운영상 의미는 거의 없고, 그 표현이 회의 자료에 그대로 옮겨진다. */}
                      {d.count < MIN_ABSOLUTE ? (
                        <p className="theme-evi">
                          표본 {d.count}건 — 배수·비율로 말하기에는 적은 수입니다. 건수 그대로 봐주세요.
                        </p>
                      ) : (
                        d.evidence[0] && <p className="theme-evi">“{d.evidence[0]}”</p>
                      )}
                    </div>
                  ))}
                  {falls.map((d) => (
                    <div className="theme-row" key={`down-${d.id}`}>
                      <div className="theme-head">
                        <strong>▼ {d.label}</strong>
                        <span className="theme-dept">{d.dept}</span>
                        {d.isGone && <span className="theme-dept">이번 구간 0건</span>}
                        <span className="theme-count">
                          {d.previous}건 → {d.count}건 ({d.delta})
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="result-empty-sub">
                감소한 원인도 함께 남깁니다. 지난 구간에 몰렸던 원인이 이번에 0건이 되면 표에서
                사라지는 것이 아니라 <strong>가장 큰 변화</strong>로 보여야 합니다 — 조치가 먹혔다는
                증거이거나, 집계가 끊겼다는 신호이기 때문입니다.
              </p>
            </>
          )}
        </section>

        {/* 상담사 축 — 데이터에는 있었지만 어떤 집계에도 쓰이지 않던 필드다 */}
        <section className="voc-card voc-card-wide">
          <h2>
            상담사별 — {formatRange(period.range)}
            <span className="voc-card-sub">
              (표본 {MIN_ABSOLUTE}건 미만이면 비율을 만들지 않습니다)
            </span>
          </h2>
          {agents.rows.length === 0 ? (
            <p className="result-empty-sub">이 기간에 집계할 통화가 없습니다.</p>
          ) : (
            <div className="req-table-wrap">
              <table className="req-table">
                <thead>
                  <tr>
                    <th>상담사</th>
                    <th>통화</th>
                    <th>부정·강성</th>
                    <th>에스컬레이션</th>
                    <th>재문의</th>
                    <th>평균 시간</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.rows.map((r) => (
                    <tr key={r.agent}>
                      <td>
                        {r.agent}
                        {!r.labeled && <em className="stat-note"> 라벨 없음</em>}
                      </td>
                      <td>{r.count}건</td>
                      <td>
                        {r.negative}건
                        {r.enoughSample ? (
                          ` (${pctText(r.negative, r.count)})`
                        ) : (
                          <em className="stat-note"> 표본 부족</em>
                        )}
                      </td>
                      <td>
                        {r.escalated}건
                        {r.enoughSample && ` (${pctText(r.escalated, r.count)})`}
                      </td>
                      <td>
                        {r.repeat}건
                        {r.enoughSample && ` (${pctText(r.repeat, r.count)})`}
                      </td>
                      <td>{r.avgMinutes === null ? '—' : `${r.avgMinutes.toFixed(1)}분`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="result-empty-sub">
            상담사 {agents.labeledAgents}명
            {agents.unlabeled > 0 && (
              <>
                {' '}· <strong>{UNLABELED_AGENT} {agents.unlabeled}건</strong> — 상담사 라벨이 없는
                통화입니다. 아무에게나 배정하지 않고 미지정으로 둡니다(잘못 붙은 라벨은 없는 라벨보다
                나쁩니다).
              </>
            )}
            . 표본 {MIN_ABSOLUTE}건 미만인 상담사에게는 비율을 붙이지 않습니다 — 1건 중 1건이 부정이면
            "부정률 100%"가 되고, 그 숫자는 그대로 평가에 쓰입니다.
          </p>
          <div className="chip-row">
            <label htmlFor="my-agent" className="usage-note">
              내가 분석한 통화에 붙일 상담사 라벨
            </label>
            <input
              id="my-agent"
              type="text"
              value={agentDraft}
              maxLength={20}
              placeholder="예: 상담사 G"
              style={INPUT_STYLE}
              onChange={(e) => setAgentDraft(e.target.value)}
            />
            <button type="button" className="preset-chip" onClick={saveAgentLabel}>
              저장
            </button>
          </div>
          <p className="result-empty-sub">
            {agentNotice ||
              '브라우저에만 저장되며, 여기서 정한 뒤 저장되는 통화부터 이 이름으로 묶입니다. 이미 저장된 기록은 소급해서 고치지 않습니다 — 지난 기록을 나중에 다시 쓰기 시작하면 집계를 믿을 수 없게 됩니다.'}
          </p>
        </section>

        <section className="voc-card voc-card-wide">
          <h2>
            무엇 때문에 전화했나 — 원인별 집계
            <span className="voc-card-sub">
              (규칙 기반 · 근거 문장 표시 · 원인마다 처리 부서가 붙습니다)
            </span>
          </h2>
          <p className="result-empty-sub">
            유형이 '불만' 한 칸이어도 안에는 속도 저하·과다 청구·응대 미흡이 섞여 있습니다. 넘길
            부서가 서로 다르므로, 집계 단위가 <strong>원인</strong>이어야 조직이 움직입니다.
          </p>
          <div className="theme-list">
            {themes.themes.slice(0, 8).map((t) => (
              <div className="theme-row" key={t.id}>
                <div className="theme-head">
                  <strong>{t.label}</strong>
                  <span className="theme-dept">{t.dept}</span>
                  <span className="theme-count">{t.count}건</span>
                </div>
                <span className="rank-track">
                  <span className="rank-fill" style={{ width: `${(t.count / maxTheme) * 100}%` }} />
                </span>
                {t.evidence[0] && <p className="theme-evi">“{t.evidence[0]}”</p>}
              </div>
            ))}
          </div>
          <div className="theme-depts">
            {themes.byDept.map((d) => (
              <span className="theme-dept-chip" key={d.dept}>
                {d.dept} <b>{d.count}건</b>
              </span>
            ))}
          </div>
          <p className="result-empty-sub">
            분류된 통화 {Math.round(themes.taggedRate * 100)}%
            {themes.untagged.length > 0 && (
              <>
                {' '}· 사전에 없는 표현이라 분류하지 못한 통화 <strong>{themes.untagged.length}건</strong> —
                억지로 '기타'에 넣지 않고 드러냅니다. 반복되면 원인 사전에 추가할 지점입니다.
              </>
            )}
          </p>
        </section>

        {/* 자가 점검 — 규칙 기반 시스템의 진짜 위험은 틀리는 것이 아니라 모르는 채로 조용한 것이다 */}
        <section className="voc-card voc-card-wide">
          <h2>
            자가 점검 — 이 사전이 지금 못 하고 있는 것
            <span className="voc-card-sub">(분류기가 아니라, 분류기의 사각지대를 찾는 층)</span>
          </h2>
          <div className="stat-row">
            <div className="stat-tile">
              <span className="stat-label">원인이 잡힌 통화</span>
              <span className="stat-value">{Math.round(check.taggedRate * 100)}%</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">담당 부서 미정</span>
              <span className="stat-value">{check.routedDefault}건</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">재문의 비율</span>
              <span className="stat-value">{Math.round(check.repeatRate * 100)}%</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">가려진 개인정보</span>
              <span className="stat-value">{check.piiFound}건</span>
            </div>
          </div>
          <ul className="plain-list">
            {check.gaps.map((g) => (
              <li key={g.id}>
                <strong>{g.level === 'warn' ? '⚠ ' : '✓ '}{g.label}</strong> — {g.detail}
              </li>
            ))}
          </ul>
          {check.suggestions.length > 0 && (
            <div className="lexicon-box">
              <h3>사전에 추가할 후보</h3>
              <p className="result-empty-sub">
                분류하지 못한 통화에서 반복된 표현입니다. 사람이 판단할 수 있도록 근거 문장을 함께
                보여줍니다 — 승인할 것만 <code>src/lib/vocThemes.js</code>의 원인 사전에 넣으면
                다음 집계부터 잡힙니다.
              </p>
              {check.suggestions.map((s) => (
                <div className="theme-row" key={s.term}>
                  <div className="theme-head">
                    <strong>{s.term}</strong>
                    <span className="theme-count">{s.count}건</span>
                  </div>
                  {s.examples[0] && <p className="theme-evi">“{s.examples[0]}”</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {themes.repeats.length > 0 && (
          <section className="voc-card voc-card-wide">
            <h2>
              같은 문제로 다시 걸려온 통화 {themes.repeats.length}건
              <span className="voc-card-sub">(1선 종결 실패의 직접 증거)</span>
            </h2>
            {themes.repeats.map((r) => (
              <div className="review-card escalated voc-esc" key={r.call.id}>
                <div className="review-head">
                  <span className="escalate-badge">🔁 재문의</span>
                  <span className="usage-note">
                    {r.call.date} · {r.call.agent || '내 분석'}
                  </span>
                </div>
                <p className="review-original">{r.call.title}</p>
                <p className="theme-evi">“{r.evidence}”</p>
              </div>
            ))}
            <p className="result-empty-sub">
              재문의는 응대 품질이 아니라 <strong>처리 완결성</strong>의 지표입니다. 같은 원인이 반복되면
              통화당 처리시간을 줄이는 것보다 그 원인을 없애는 편이 총 통화 수를 줄입니다.
            </p>
          </section>
        )}

        <section className="voc-card">
          <h2>문의 유형별 건수</h2>
          <div className="rank-bars">
            {agg.byCategory.map((c) => (
              <div className="rank-row" key={c.name}>
                <span className="rank-label">{c.name}</span>
                <span className="rank-track">
                  <span className="rank-fill" style={{ width: `${(c.count / maxCat) * 100}%` }} />
                </span>
                <span className="rank-value">{c.count}건</span>
              </div>
            ))}
          </div>
        </section>

        <section className="voc-card">
          <h2>고객 감정 분포 <span className="voc-card-sub">(긍정 → 강성 순차 척도)</span></h2>
          <div className="rank-bars">
            {agg.bySentiment.map((s) => (
              <div className="rank-row" key={s.name}>
                <span className="rank-label">{s.name}</span>
                <span className="rank-track">
                  <span
                    className="rank-fill"
                    style={{ width: `${(s.count / maxSent) * 100}%`, background: SENTIMENT_RAMP[s.name] }}
                  />
                </span>
                <span className="rank-value">{s.count}건</span>
              </div>
            ))}
          </div>
        </section>

        <section className="voc-card voc-card-wide">
          <h2>일별 통화 추이 ({formatRange(period.range)})</h2>
          {agg.byDate.length > 0 ? (
            <TrendChart points={agg.byDate} />
          ) : (
            <p className="result-empty-sub">이 기간에는 그릴 통화가 없습니다.</p>
          )}
        </section>

        <section className="voc-card voc-card-wide">
          <h2>AI 인사이트 리포트 <span className="voc-card-sub">(집계 수치 + 에스컬레이션 통화 제목 최대 6건 전송 — 통화 전문 미전송, 서버 미저장)</span></h2>
          {!report && (
            <>
              <p className="result-empty-sub">
                <strong>{formatRange(period.range)}</strong> 구간의 집계를 LLM이 읽고 "무엇이 몰리고,
                어디서 강성이 나오는지"와 실행 가능한 권고 액션을 리포트로 작성합니다.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={generateReport}
                disabled={reporting || view.length === 0}
                aria-busy={reporting}
              >
                {reporting ? '리포트 작성 중... (5~15초)' : '📋 AI 인사이트 리포트 생성'}
              </button>
              {view.length === 0 && (
                <p className="result-empty-sub">
                  선택한 기간에 통화가 없어 보낼 집계가 없습니다 — 빈 집계로 호출하지 않습니다.
                </p>
              )}
              {reportError && <p className="form-error" role="alert">{reportError}</p>}
            </>
          )}
          {report && (
            <div className="voc-report">
              <ResultNotice text={report.notice} />
              <div className="result-toolbar">
                {report.demo && <DemoBadge />}
                <UsageNote usage={report.usage} />
                <OssLlmNote model={report.llm_model} />
                <NumbersVerifiedBadge verified={report.numbers_verified} />
              </div>
              <p className="voc-report-headline">{report.headline}</p>
              <strong>핵심 발견</strong>
              <ul className="plain-list">
                {report.findings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
              <strong>권고 액션</strong>
              <ul className="plain-list">
                {report.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
              <button type="button" className="preset-chip" onClick={() => setReport(null)}>
                다시 생성
              </button>
            </div>
          )}
        </section>

        <section className="voc-card voc-card-wide">
          <h2>에스컬레이션 대기 건 — 사람의 판단이 필요한 통화</h2>
          {agg.escalated.length === 0 ? (
            <p className="result-empty-sub">이 기간에는 담당자 확인 대상 통화가 없습니다.</p>
          ) : (
            agg.escalated.map((c) => (
              <div className="review-card escalated voc-esc" key={c.id}>
                <div className="review-head">
                  <span className={`cat-badge ${CATEGORY_BADGE[c.analysis.category] || 'cat-etc'}`}>{c.analysis.category}</span>
                  <span className="escalate-badge">⚠ 담당자 확인 필요</span>
                  <span className="usage-note">
                    {c.date} · {c.agent || '내 분석'}
                  </span>
                </div>
                <p className="review-original">{c.title}</p>
              </div>
            ))
          )}
        </section>
      </div>

      <section className="analysis-block voc-table-block">
        <h2>통화 원장 (표 데이터) — {formatRange(period.range)} · {view.length}건</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>일자</th>
                <th>상담사</th>
                <th>제목</th>
                <th>유형</th>
                <th>감정</th>
                <th>이탈위험</th>
                <th>담당</th>
                <th>시간</th>
                <th>에스컬레이션</th>
              </tr>
            </thead>
            <tbody>
              {view.map((c) => (
                <tr key={c.id}>
                  <td>{c.date.slice(5)}</td>
                  <td>{c.agent || UNLABELED_AGENT}</td>
                  <td>
                    {c.transcript ? (
                      <details className="voc-transcript">
                        <summary>{c.title}</summary>
                        <pre>{c.transcript}</pre>
                      </details>
                    ) : (
                      <span>
                        {c.title} <em className="stat-note">내 분석</em>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`cat-badge ${CATEGORY_BADGE[c.analysis.category] || 'cat-etc'}`}>{c.analysis.category}</span>
                  </td>
                  <td>{c.analysis.sentiment}</td>
                  <td>
                    {Number.isFinite(c.analysis.churn?.score) ? (
                      <span
                        className={`churn-level churn-${c.analysis.churn.score >= 70 ? 'high' : c.analysis.churn.score >= 40 ? 'mid' : 'low'}`}
                        title={(c.analysis.churn.signals || []).map((s) => s.label).join(', ') || '위험 신호 없음'}
                      >
                        {c.analysis.churn.score} · {c.analysis.churn.level}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{c.analysis.route?.team || '—'}</td>
                  <td>{typeof c.minutes === 'number' ? `${c.minutes}분` : '—'}</td>
                  <td>{c.analysis.escalate ? '⚠ 대기' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="result-empty-sub">
          각 통화 제목을 누르면 전문이 열립니다. 통화를 <Link to="/analyze">통화 분석</Link>이나{' '}
          <Link to="/qa">Auto QA</Link>에 붙여넣어 직접 실험해보세요. 모든 통화는 가상 시나리오입니다.
          <br />
          이탈위험·담당은 전사에서 <strong>규칙으로 계산</strong>한 값입니다(AI 키 불필요). 위험 점수에
          마우스를 올리면 어떤 신호가 잡혔는지 보입니다. 직접 분석한 통화는 분석 시점에 서버가 낸 값을
          그대로 씁니다.
        </p>
      </section>
    </div>
  )
}
