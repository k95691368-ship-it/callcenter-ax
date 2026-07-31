// VOC 통화 원장을 CSV 텍스트로 만든다 — 대시보드가 보고서·엑셀로 흘러가는 실무 동선.
// 엑셀 한글 호환용 BOM(﻿)은 다운로드 시점에 호출부가 붙인다.
export function buildVocCsv(calls) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // 이탈 위험·담당 부서는 대장을 받아보는 사람이 가장 먼저 정렬하는 열이다.
  // 값이 없는 통화(내장 샘플 등)는 빈 칸으로 두고 0으로 채우지 않는다 —
  // 0은 "위험 없음"이라는 뜻이 되어버려 사실과 다르다.
  const rows = [['날짜', '제목', '유형', '감정', '에스컬레이션', '이탈위험', '위험등급', '담당', '출처']]
  for (const c of Array.isArray(calls) ? calls : []) {
    const churn = c.analysis?.churn
    rows.push([
      c.date || '',
      c.title || '',
      c.analysis?.category || '',
      c.analysis?.sentiment || '',
      c.analysis?.escalate ? 'Y' : 'N',
      Number.isFinite(churn?.score) ? churn.score : '',
      churn?.level || '',
      c.analysis?.route?.team || '',
      c.mine ? '직접 분석' : '내장 샘플',
    ])
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}
