import { MAX_RULE_SCORE } from './qaRules.js'

// 파이프라인 6단계 결과를 인수인계용 텍스트 리포트 한 장으로 조립한다.
// 각 단계 결과가 없으면 해당 줄을 건너뛴다 (부분 실행에도 안전).
export function buildPipelineReport({ stt, lex, dia, analysis, qa }) {
  const lines = ['[콜센터 AX 파이프라인 리포트]']

  if (stt?.text) lines.push(`① STT 전사: "${stt.text}"`)

  if (lex) {
    lines.push(
      lex.applied?.length
        ? `② 도메인 보정: ${lex.applied.map((a) => `→ ${a.term} ×${a.count}`).join(', ')}`
        : '② 도메인 보정: 보정할 용어 없음 (전사 정확)'
    )
  }

  if (dia?.formatted) lines.push('③ 화자 분리:', dia.formatted)

  if (analysis) {
    lines.push(
      `④ 통화 분석 — 유형: ${analysis.category} / 감정: ${analysis.sentiment}${
        analysis.escalate ? ' / ⚠ 에스컬레이션 필요' : ''
      }`
    )
    ;(analysis.summary || []).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
    if (analysis.actions?.length) lines.push(`  조치: ${analysis.actions.join(' · ')}`)
  }

  if (qa?.score) {
    const s = qa.score
    lines.push(
      `⑤ Auto QA — 총점 ${s.total}/100 (${s.grade}등급) · 규칙 ${s.ruleScore}/${MAX_RULE_SCORE} · LLM ${s.llmScore}/60 · 감점 -${s.deduction}`
    )
    if (qa.coaching) lines.push(`  코칭: ${qa.coaching}`)
  }

  lines.push('⑥ VOC 대시보드에 누적 완료 — callcenter-ax.pages.dev/voc')
  return lines.join('\n')
}
