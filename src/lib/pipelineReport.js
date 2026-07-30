import { MAX_RULE_SCORE } from './qaRules.js'

// 파이프라인 6단계 결과를 인수인계용 텍스트 리포트 한 장으로 조립한다.
// 각 단계 결과가 없으면 해당 줄을 건너뛴다 (부분 실행에도 안전).
//
// 실패한 단계는 침묵으로 넘기지 않고 실패 사실을 적는다. 실패를 빼고 나머지만
// 옮겨 적으면, 인수인계 문서를 받은 사람은 그 단계가 통과한 줄 알게 된다.
export function buildPipelineReport({ stt, lex, dia, analysis, qa, stageErrors = {} }) {
  const lines = ['[콜센터 AX 파이프라인 리포트]']
  const failed = (id, label) => {
    if (stageErrors[id]) {
      lines.push(`${label}: 실패 — ${stageErrors[id]}`)
      return true
    }
    return false
  }

  if (stt?.text) lines.push(`① STT 전사: "${stt.text}"`)

  if (lex) {
    lines.push(
      lex.applied?.length
        ? `② 도메인 보정: ${lex.applied.map((a) => `→ ${a.term} ×${a.count}`).join(', ')}`
        : '② 도메인 보정: 보정할 용어 없음 (전사 정확)'
    )
  }

  if (!failed('dia', '③ 화자 분리') && dia?.formatted) {
    lines.push('③ 화자 분리:', dia.formatted)
    if (dia.notice) lines.push(`  ※ ${dia.notice}`)
  }

  failed('analyze', '④ 통화 분석')
  if (analysis) {
    lines.push(
      `④ 통화 분석 — 유형: ${analysis.category} / 감정: ${analysis.sentiment}${
        analysis.escalate ? ' / ⚠ 에스컬레이션 필요' : ''
      }`
    )
    ;(analysis.summary || []).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
    if (analysis.actions?.length) lines.push(`  조치: ${analysis.actions.join(' · ')}`)
  }

  failed('qa', '⑤ Auto QA')
  if (qa?.score) {
    const s = qa.score
    lines.push(
      `⑤ Auto QA — 총점 ${s.total}/100 (${s.grade}등급) · 규칙 ${s.ruleScore}/${MAX_RULE_SCORE} · LLM ${
        s.llmScore
      }/60${s.llmEstimated ? '(추정)' : ''} · 감점 -${s.deduction}`
    )
    if (qa.coaching) lines.push(`  코칭: ${qa.coaching}`)
  }

  if (!failed('voc', '⑥ VOC 누적')) {
    lines.push('⑥ VOC 대시보드에 누적 완료 — callcenter-ax.pages.dev/voc')
  }
  return lines.join('\n')
}
