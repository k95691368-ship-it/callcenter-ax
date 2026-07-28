import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SAMPLE_CALLS, CATEGORIES, SENTIMENTS } from '../lib/sampleCalls.js'
import { loadMyCalls, clearMyCalls } from '../lib/myCalls.js'
import { postJson } from '../lib/api.js'
import DemoBadge from '../components/DemoBadge.jsx'
import { UsageNote, ResultNotice, OssLlmNote } from '../components/ResultMeta.jsx'
import { buildVocCsv } from '../lib/vocCsv.js'

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
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.count)}`).join(' ')
  const last = points[points.length - 1]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="voc-trend" role="img" aria-label="일별 통화 건수 추이">
      {Array.from({ length: maxY + 1 }, (_, v) => (
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
  const calls = useMemo(() => [...SAMPLE_CALLS, ...myCalls], [myCalls])

  const agg = useMemo(() => {
    const byCategory = CATEGORIES.map((c) => ({
      name: c,
      count: calls.filter((k) => k.analysis.category === c).length,
    }))
    const bySentiment = SENTIMENTS.map((s) => ({
      name: s,
      count: calls.filter((k) => k.analysis.sentiment === s).length,
    }))
    const dates = [...new Set(calls.map((c) => c.date))].sort()
    const byDate = dates.map((d) => ({ date: d, count: calls.filter((c) => c.date === d).length }))
    const escalated = calls.filter((c) => c.analysis.escalate)
    const hot = calls.filter((c) => c.analysis.sentiment === '강성' || c.analysis.sentiment === '부정')
    // 직접 분석한 통화에는 통화 시간이 없으므로 내장 샘플 기준으로만 평균을 낸다
    const timed = calls.filter((c) => typeof c.minutes === 'number')
    const avgMin = timed.reduce((s, c) => s + c.minutes, 0) / Math.max(timed.length, 1)
    return { byCategory, bySentiment, byDate, escalated, hot, avgMin }
  }, [calls])

  const maxCat = Math.max(...agg.byCategory.map((c) => c.count), 1)
  const maxSent = Math.max(...agg.bySentiment.map((s) => s.count), 1)

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
    a.click()
    URL.revokeObjectURL(url)
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

      <div className="voc-grid">
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
          <h2>일별 통화 추이 (7/21 ~ 7/27)</h2>
          <TrendChart points={agg.byDate} />
        </section>

        <section className="voc-card voc-card-wide">
          <h2>AI 인사이트 리포트 <span className="voc-card-sub">(집계 수치만 전송 — 통화 원문 미전송)</span></h2>
          {!report && (
            <>
              <p className="result-empty-sub">
                위 집계를 LLM이 읽고 "무엇이 몰리고, 어디서 강성이 나오는지"와 실행 가능한 권고
                액션을 리포트로 작성합니다.
              </p>
              <button type="button" className="btn-primary" onClick={generateReport} disabled={reporting}>
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
                <span className={`cat-badge ${CATEGORY_BADGE[c.analysis.category]}`}>{c.analysis.category}</span>
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
                    <span className={`cat-badge ${CATEGORY_BADGE[c.analysis.category]}`}>{c.analysis.category}</span>
                  </td>
                  <td>{c.analysis.sentiment}</td>
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
        </p>
      </section>
    </div>
  )
}
