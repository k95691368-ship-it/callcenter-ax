import { useEffect, useState } from 'react'

// 생성 대기 중 단계 표시 — 4개 생성 페이지가 공용으로 사용한다.
// 실제 서버 진행률이 아니라 시간 기반 연출이지만, 10~30초 대기의 체감을 크게 줄인다.
export default function GenProgress({ steps, interval = 3500 }) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    setStep(0)
    const timer = setInterval(() => {
      setStep((s) => Math.min(s + 1, steps.length - 1))
    }, interval)
    return () => clearInterval(timer)
  }, [steps, interval])

  return (
    <div className="result-empty gen-progress" aria-live="polite">
      <ol className="gen-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>
            {i < step ? '✓' : i === step ? '●' : '○'} {s}
          </li>
        ))}
      </ol>
    </div>
  )
}
