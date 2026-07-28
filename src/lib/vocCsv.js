// VOC 통화 원장을 CSV 텍스트로 만든다 — 대시보드가 보고서·엑셀로 흘러가는 실무 동선.
// 엑셀 한글 호환용 BOM(﻿)은 다운로드 시점에 호출부가 붙인다.
export function buildVocCsv(calls) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [['날짜', '제목', '유형', '감정', '에스컬레이션', '출처']]
  for (const c of Array.isArray(calls) ? calls : []) {
    rows.push([
      c.date || '',
      c.title || '',
      c.analysis?.category || '',
      c.analysis?.sentiment || '',
      c.analysis?.escalate ? 'Y' : 'N',
      c.mine ? '직접 분석' : '내장 샘플',
    ])
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}
