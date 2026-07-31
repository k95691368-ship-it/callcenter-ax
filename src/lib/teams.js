// 부서 표 — "이 통화는 누가 처리하는가"의 유일한 출처.
//
// 왜 이 파일이 생겼는가:
// 부서 체계가 두 벌로 갈라져 있었다. VOC 대시보드는 원인 사전(vocThemes)의 dept로 세고,
// 티켓 초안은 라우팅 규칙(ticketDraft)의 team으로 배정했다. 그래서 같은 통화가
// 대시보드에서는 '부가서비스팀', 티켓에서는 '보상 심의팀'으로 나왔다 —
// 두 화면이 같은 질문에 다른 답을 하면 둘 다 신뢰를 잃는다.
//
// 실제 조직도는 회사마다 다르므로 이름은 일반적인 콜센터 조직 기준이다.
// 이 표만 고치면 대시보드 집계·티켓 배정·CSV가 함께 따라온다.
export const TEAMS = {
  legal: { id: 'legal', name: '법무·분쟁 대응팀', sla: '4시간 내 1차 회신', priority: 'P1' },
  retention: { id: 'retention', name: '리텐션(해지 방어)팀', sla: '당일 내 접촉', priority: 'P1' },
  billing: { id: 'billing', name: '요금정산팀', sla: '영업일 1일 내 확인 회신', priority: 'P2' },
  planAdvice: { id: 'planAdvice', name: '요금 상담팀', sla: '영업일 1일 내 안내', priority: 'P3' },
  network: { id: 'network', name: '네트워크 품질팀', sla: '영업일 2일 내 현장 확인', priority: 'P2' },
  install: { id: 'install', name: '설치·이전 지원팀', sla: '영업일 1일 내 일정 안내', priority: 'P3' },
  compensation: { id: 'compensation', name: '보상 심의팀', sla: '영업일 3일 내 심의 결과 회신', priority: 'P2' },
  vas: { id: 'vas', name: '부가서비스팀', sla: '영업일 1일 내 처리', priority: 'P3' },
  sales: { id: 'sales', name: '영업 지원팀', sla: '영업일 1일 내 안내', priority: 'P3' },
  onboarding: { id: 'onboarding', name: '가입 지원팀', sla: '영업일 1일 내 안내', priority: 'P3' },
  quality: { id: 'quality', name: 'QA · 교육팀', sla: '주간 코칭에 반영', priority: 'P3' },
  general: { id: 'general', name: '고객지원 2선', sla: '영업일 1일 내 회신', priority: 'P3' },
}

export function teamName(id) {
  return TEAMS[id]?.name || TEAMS.general.name
}

// 티켓·대시보드가 함께 쓰는 배정 결과 형태
export function routeOf(teamId, reason) {
  const t = TEAMS[teamId] || TEAMS.general
  return { id: t.id, team: t.name, sla: t.sla, priority: t.priority, reason }
}
