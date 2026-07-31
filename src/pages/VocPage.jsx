import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SAMPLE_CALLS, CATEGORIES, SENTIMENTS } from '../lib/sampleCalls.js'
import { loadMyCalls, clearMyCalls } from '../lib/myCalls.js'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import { NumbersVerifiedBadge } from '../components/VerifyBadge.jsx'
import { buildVocCsv } from '../lib/vocCsv.js'
import { detectVocAnomalies } from '../lib/vocAnomaly.js'
import { aggregateThemes } from '../lib/vocThemes.js'
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

// 일별 추이 꺾은선 — 단일 시리즈, 2px 선, 마커 + 네이티브 툴팁, 마지막 점 직접 라벨
function TrendChart({ points }) {
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
    for (const call of calls) {
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
    return { byCategory, bySentiment, byDate, escalated, hot, avgMin }
  }, [calls])

  const maxCat = Math.max(...agg.byCategory.map((c) => c.count), 1)
  const maxSent = Math.max(...agg.bySentiment.map((s) => s.count), 1)

  // 규칙으로 계산되는 것들 — LLM도 API 키도 필요 없고, 근거 수치를 그대로 보여줄 수 있다.
  // 급증 감지는 만들어 두고도 어느 화면에도 연결되지 않아, 운영자가 볼 방법이 없었다.
  const anomalies = useMemo(() => detectVocAnomalies(calls), [calls])
  // 카테고리는 '불만' 한 칸이지만 그 안에는 속도 저하·과다 청구·응대 미흡이 섞여 있다.
  // 넘길 부서가 다르므로, 집계 단위가 원인이어야 조직이 움직인다.
  const themes = useMemo(() => aggregateThemes(calls), [calls])
  const maxTheme = Math.max(...themes.themes.map((t) => t.count), 1)

  // AI 인사이트 리포트 — 집계 수치만 서버로 보낸다 (통화 원문 미전송)
  const [report, setReport] = useState(null)
  const [reporting, setReporting] = useState(false)
  const [reportError, setReportError] = useState('')

  // 통화 원장을 CSV로 내려받는다 (엑셀 한글 호환 BOM 포함, 브라우저 내 처리)
  function downloadCsv() {
    const blob = new Blob(['\ufeff' + buildVocCsv(calls)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `voc-리포트-${new Date().toISOString().slice(0, 10)}.csv`
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
        total: calls.length,
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

  return (
    <div className="tool-page">
      <header className="tool-header">
        <span className="tool-tag">담당업무 ⑤ VOC 분석 · 집계 대시보드</span>
        <h1>VOC 대시보드</h1>
        <p>
          통화 분석 결과가 쌓이면 이런 그림이 됩니다 — 내장 가상 통화 <strong>10건</strong>
          {myCalls.length > 0 && (
            <>
              {' '}+ <strong>내가 분석한 통화 {myCalls.length}건</strong>
            </>
          )}
          을 유형·감정·일별로 집계했습니다. <Link to="/analyze">통화 분석</Link>을 돌릴 때마다 이
          대시보드에 실시간으로 누적됩니다 (브라우저에만 저장, 서버 미전송).{' '}
          <button type="button" className="preset-chip" onClick={downloadCsv}>
            ⬇ CSV 내보내기 (엑셀 호환)
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

      <div className="stat-row voc-stats">
        <div className="stat-tile">
          <span className="stat-label">분석된 통화</span>
          <span className="stat-value">{calls.length}건</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">부정·강성 비율</span>
          <span className="stat-value">{Math.round((agg.hot.length / calls.length) * 100)}%</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">에스컬레이션</span>
          <span className="stat-value">
            {agg.escalated.length}건<em className="stat-note"> 판단 필요 건</em>
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">평균 통화 시간</span>
          <span className="stat-value">{agg.avgMin.toFixed(1)}분</span>
        </div>
      </div>

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
            규칙으로 계산한 경보입니다 (최소 {3}건 이상 + 이전 일평균의 2배 이상). LLM·API 호출
            없이 브라우저에서 판정하므로 비용이 들지 않고, 근거 수치를 그대로 보여줍니다.
          </p>
        </section>
      )}

      <div className="voc-grid">
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
          <h2>일별 통화 추이 ({agg.byDate[0]?.date.slice(5).replace('-', '/')} ~ {agg.byDate[agg.byDate.length - 1]?.date.slice(5).replace('-', '/')})</h2>
          <TrendChart points={agg.byDate} />
        </section>

        <section className="voc-card voc-card-wide">
          <h2>AI 인사이트 리포트 <span className="voc-card-sub">(집계 수치 + 에스컬레이션 통화 제목 최대 6건 전송 — 통화 전문 미전송, 서버 미저장)</span></h2>
          {!report && (
            <>
              <p className="result-empty-sub">
                위 집계를 LLM이 읽고 "무엇이 몰리고, 어디서 강성이 나오는지"와 실행 가능한 권고
                액션을 리포트로 작성합니다.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={generateReport}
                disabled={reporting}
                aria-busy={reporting}
              >
                {reporting ? '리포트 작성 중... (5~15초)' : '📋 AI 인사이트 리포트 생성'}
              </button>
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
          {agg.escalated.map((c) => (
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
          ))}
        </section>
      </div>

      <section className="analysis-block voc-table-block">
        <h2>통화 원장 (표 데이터)</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>일자</th>
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
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>{c.date.slice(5)}</td>
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
