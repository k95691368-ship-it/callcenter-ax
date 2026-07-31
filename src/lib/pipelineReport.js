import { MAX_RULE_SCORE } from './qaRules.js'
import { buildHandoff, formatHandoff, STAGE_LABELS } from './handoff.js'

// 파이프라인 6단계 결과를 인수인계용 텍스트 리포트 한 장으로 조립한다.
// 각 단계 결과가 없으면 해당 줄을 건너뛴다 (부분 실행에도 안전).
//
// 실패한 단계는 침묵으로 넘기지 않고 실패 사실을 적는다. 실패를 빼고 나머지만
// 옮겨 적으면, 인수인계 문서를 받은 사람은 그 단계가 통과한 줄 알게 된다.
//
// 문서 맨 앞에는 처리 상태(어디로/누가 언제까지/무엇을 확인)를 둔다. 인수인계를
// 받는 사람이 먼저 알아야 하는 건 6단계 실행 로그가 아니라 결론이기 때문이다.
export function buildPipelineReport({ stt, lex, dia, analysis, qa, stageErrors = {}, qaSaved = false, vocSaved = false }) {
  const lines = ['[콜센터 AX 파이프라인 리포트]']

  // 처리 상태는 화면과 같은 함수로 만든다 — 복사한 문서와 화면이 다른 부서를
  // 가리키면 어느 쪽이 맞는지 확인할 방법이 없다.
  const handoff = buildHandoff({ stt, lex, dia, analysis, qa, stageErrors, qaSaved, vocSaved })
  lines.push('', ...formatHandoff(handoff), '')

  const failed = (id) => {
    if (stageErrors[id]) {
      lines.push(`${STAGE_LABELS[id]}: 실패 — ${stageErrors[id]}`)
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

  if (!failed('dia') && dia?.formatted) {
    lines.push('③ 화자 분리:', dia.formatted)
    if (dia.notice) lines.push(`  ※ ${dia.notice}`)
  }

  failed('analyze')
  if (analysis?.churn && Number.isFinite(analysis.churn.score)) {
    const c = analysis.churn
    lines.push(
      `④-1 이탈 위험: ${c.score}점 (${c.level}) · 권고 조치: ${c.action}` +
        `${c.estimated ? ' · 규칙 기반 추정' : ''}${c.adjusted ? ' · 규칙 신호로 보정' : ''}`
    )
    if (c.signals?.length) lines.push(`     위험 신호: ${c.signals.map((s) => s.label).join(', ')}`)
  }
  if (analysis) {
    lines.push(
      `④ 통화 분석 — 유형: ${analysis.category} / 감정: ${analysis.sentiment}${
        analysis.escalate ? ' / ⚠ 에스컬레이션 필요' : ''
      }`
    )
    ;(analysis.summary || []).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
    if (analysis.actions?.length) lines.push(`  조치: ${analysis.actions.join(' · ')}`)
  }

  failed('qa')
  if (qa?.score) {
    const s = qa.score
    lines.push(
      `⑤ Auto QA — 총점 ${s.total}/100 (${s.grade}등급) · 규칙 ${s.ruleScore}/${MAX_RULE_SCORE} · LLM ${
        s.llmScore
      }/60${s.llmEstimated ? '(추정)' : ''} · 감점 -${s.deduction}`
    )
    if (qa.coaching) lines.push(`  코칭: ${qa.coaching}`)
  }

  // 예전에는 stageErrors.voc가 없으면 무조건 "누적 완료"라고 적었다. 그래서 분석이
  // 없는 부분 실행 리포트가 누적되지도 않은 통화를 누적됐다고 말했다 — 실제 반영
  // 여부(records.voc)로 판단한다 — 그 값은 호출부가 넘긴 실제 저장 결과다.
  if (!failed('voc')) {
    lines.push(
      handoff.records.voc
        ? '⑥ VOC 대시보드에 누적 완료 — callcenter-ax.pages.dev/voc'
        : '⑥ VOC 누적: 미실행 — 분석 결과가 없어 이번 통화는 대시보드에 반영되지 않았습니다.'
    )
  }
  // QA 이력 기록 여부도 남긴다 — 파이프라인으로 돌린 통화가 코칭 이력에서 빠지면
  // "최근 10건" 평균이 실제로 평가한 건수와 어긋난다.
  if (handoff.records.qaHistory) {
    lines.push('⑤-1 코칭 이력에 기록 완료 — callcenter-ax.pages.dev/qa')
  }

  // 인수인계 문서의 마지막은 "그래서 누가 무엇을 하는가"여야 한다.
  if (analysis?.ticket) {
    lines.push('', '─── 에스컬레이션 티켓 초안 ───', analysis.ticket.text)
  }
  return lines.join('\n')
}
