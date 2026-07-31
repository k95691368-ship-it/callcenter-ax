// VOC 통화 원장을 CSV 텍스트로 만든다 — 대시보드가 보고서·엑셀로 흘러가는 실무 동선.
// 엑셀 한글 호환용 BOM(﻿)은 다운로드 시점에 호출부가 붙인다.
import { extractThemes, isRepeatCall } from './vocThemes.js'

export function buildVocCsv(calls) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // 이탈 위험·담당 부서는 대장을 받아보는 사람이 가장 먼저 정렬하는 열이다.
  // 값이 없는 통화(내장 샘플 등)는 빈 칸으로 두고 0으로 채우지 않는다 —
  // 0은 "위험 없음"이라는 뜻이 되어버려 사실과 다르다.
  // 원인·처리부서·재문의는 화면에만 두면 회의 자료로 넘어가지 못한다.
  // 대장을 엑셀로 받아 부서별로 필터링하는 것이 실제 동선이므로 열로 함께 내보낸다.
  const rows = [
    // '상담사'는 화면 원장에 있는 열이다. 내려받은 파일에만 없으면 받은 사람이
    // 화면에서 본 상담사별 집계를 재현할 수 없고 수치 대조도 못 한다 —
    // 보이는 것과 내려받는 것은 같아야 한다.
    ['날짜', '상담사', '제목', '유형', '감정', '에스컬레이션', '원인', '처리부서', '재문의', '이탈위험', '위험등급', '담당', '출처'],
  ]
  for (const c of Array.isArray(calls) ? calls : []) {
    const churn = c.analysis?.churn
    const themes = extractThemes(c)
    rows.push([
      c.date || '',
      // 라벨이 없으면 빈 칸으로 둔다 — '미지정'을 쓰면 그 이름의 상담사가 있는 것처럼 보인다
      c.agent || '',
      c.title || '',
      c.analysis?.category || '',
      c.analysis?.sentiment || '',
      c.analysis?.escalate ? 'Y' : 'N',
      themes.map((t) => t.label).join(' / '),
      [...new Set(themes.map((t) => t.dept))].join(' / '),
      isRepeatCall(c) ? 'Y' : '',
      Number.isFinite(churn?.score) ? churn.score : '',
      churn?.level || '',
      c.analysis?.route?.team || '',
      c.mine ? '직접 분석' : '내장 샘플',
    ])
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}
