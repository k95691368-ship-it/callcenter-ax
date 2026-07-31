// 구간 타임라인 — 전사를 "시간이 붙은 발화"로 다루는 화면.
//
// 평문 전사로는 할 수 없던 세 가지를 여기서 한다:
//   1) 문제가 된 대목을 눌러 그 지점부터 다시 듣기
//   2) 화자 라벨이 틀린 구간만 골라 고치기 (고친 사실을 표시로 남긴다)
//   3) 시간으로만 잴 수 있는 지표 — 침묵·응답 지연·발화 편중
import { formatTime, timeMetrics, diagnoseTime } from '../lib/segments.js'

const SPEAKER_LABEL = { agent: '상담사', customer: '고객' }

export default function SegmentTimeline({ segments, onSeek, onSpeakerChange, activeIndex = -1 }) {
  if (!segments?.length) return null
  const metrics = timeMetrics(segments)
  const diagnosis = diagnoseTime(metrics)
  const unlabeled = segments.filter((s) => !s.speaker).length

  return (
    <section className="seg-block">
      <h2>
        구간 전사 {segments.length}개
        <span className="voc-card-sub">(구간을 누르면 그 지점부터 다시 들을 수 있습니다)</span>
      </h2>

      {metrics && (
        <>
          <div className="stat-row">
            <div className="stat-tile">
              <span className="stat-label">통화 길이</span>
              <span className="stat-value">{formatTime(metrics.totalSec)}</span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">발화 비율 (상담사/고객)</span>
              <span className="stat-value">
                {metrics.agentRatio == null ? '—' : `${metrics.agentRatio}% / ${metrics.customerRatio}%`}
              </span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">무음 합계 · 최장</span>
              <span className="stat-value">
                {metrics.silenceSec}초 · {metrics.longestSilenceSec}초
              </span>
            </div>
            <div className="stat-tile">
              <span className="stat-label">응답 지연 (평균/최대)</span>
              <span className="stat-value">
                {metrics.avgResponseDelaySec == null
                  ? '—'
                  : `${metrics.avgResponseDelaySec}초 / ${metrics.maxResponseDelaySec}초`}
              </span>
            </div>
          </div>
          <p className="result-empty-sub">
            글자 수로 추정한 값이 아니라 <strong>타임스탬프 실측</strong>입니다. 화자 라벨이 없는
            구간이 있으면 비율은 계산하지 않습니다 — 0%로 보여주면 사실과 다릅니다.
            {unlabeled > 0 && ` (라벨 없는 구간 ${unlabeled}개)`}
          </p>
          <ul className="plain-list">
            {diagnosis.map((d) => (
              <li key={d.id}>
                <strong>{d.level === 'warn' ? '⚠ ' : '✓ '}{d.label}</strong> — {d.detail}
              </li>
            ))}
          </ul>
        </>
      )}

      <ol className="seg-list">
        {segments.map((s, i) => (
          <li key={`${s.start}-${i}`} className={`seg-row${i === activeIndex ? ' seg-active' : ''}`}>
            <button type="button" className="seg-time" onClick={() => onSeek?.(s.start, i)} title="이 지점부터 재생">
              {formatTime(s.start)}
            </button>
            <span className={`seg-speaker seg-${s.speaker || 'unknown'}`}>
              {SPEAKER_LABEL[s.speaker] || '미지정'}
              {s.corrected && <em className="seg-fixed"> 교정됨</em>}
            </span>
            <span className="seg-text">{s.text}</span>
            {onSpeakerChange && (
              <span className="seg-fix">
                {['agent', 'customer'].map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className="copy-mini"
                    disabled={s.speaker === sp}
                    onClick={() => onSpeakerChange(i, sp)}
                    title={`이 구간을 ${SPEAKER_LABEL[sp]} 발화로 고칩니다`}
                  >
                    {SPEAKER_LABEL[sp]}
                  </button>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="result-empty-sub">
        화자 라벨을 고치면 위 지표가 즉시 다시 계산됩니다. 자동 판정과 사람 교정을 구분해
        표시하므로, 정확도를 스스로 속이지 않습니다.
      </p>
    </section>
  )
}
