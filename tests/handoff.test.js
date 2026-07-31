import { describe, it, expect } from 'vitest'
import { buildHandoff, formatHandoff, STAGE_LABELS } from '../src/lib/handoff.js'
import { buildPipelineReport } from '../src/lib/pipelineReport.js'

// 처리 상태의 계약: **없는 근거로 처리를 말하지 않는다.**
// 분석이 실패했는데 "리텐션 팀 이관"이라고 적으면 그 문장은 지어낸 것이다 —
// 부서·우선순위·SLA는 분석 응답의 ticket에서만 나오기 때문이다.

const TICKET = {
  title: '[해지] 위약금 면제 요구 (강성)',
  route: {
    id: 'retention',
    team: '리텐션(해지 방어)팀',
    sla: '당일 내 접촉',
    priority: 'P1',
    reason: '해지 의사와 타사 이동 신호가 함께 확인된 건',
  },
  text: '제목: [해지] 위약금 면제 요구 (강성)\n담당: 리텐션(해지 방어)팀 · 우선순위 P1 · 당일 내 접촉',
}

const ANALYSIS = {
  category: '해지',
  sentiment: '강성',
  escalate: true,
  escalate_reason: '위약금 면제 요구가 확인됨',
  summary: ['해지 문의', '위약금 확인 요청', '타사 이동 언급'],
  actions: ['전문 부서 이관'],
  churn: {
    score: 78,
    level: '높음',
    action: '리텐션 팀 당일 이관',
    signals: [{ id: 'cancel-intent', label: '해지 의사 직접 표현', evidence: '해지하려고요' }],
    speakerLabeled: true,
  },
  ticket: TICKET,
}

const QA = {
  score: { total: 82, grade: 'B', ruleScore: 32, llmScore: 50, deduction: 0 },
  coaching: '처리 기한을 숫자로 안내하세요.',
  speaker_labeled: true,
  attribution: { speaker_labeled: true, withheld_count: 0, withheld_deduct: 0 },
}

const FULL = {
  stt: { text: '안녕하세요 한빛텔레콤입니다' },
  lex: { applied: [], text: '안녕하세요 한빛텔레콤입니다' },
  dia: { formatted: '상담사: 안녕하세요\n고객: 해지하려고요' },
  analysis: ANALYSIS,
  qa: QA,
  stageErrors: {},
  // 저장 성공 여부는 추론하지 않는다 — 호출부가 실제 저장 결과를 넘긴다
  qaSaved: true,
  vocSaved: true,
}

describe('buildHandoff — 어디로 / 누가 언제까지', () => {
  it('분석의 티켓 배정을 그대로 처리 상태로 옮긴다 (부서를 다시 계산하지 않는다)', () => {
    const h = buildHandoff(FULL)
    expect(h.status.id).toBe('route')
    expect(h.owner).toEqual({
      team: '리텐션(해지 방어)팀',
      priority: 'P1',
      sla: '당일 내 접촉',
      reason: '해지 의사와 타사 이동 신호가 함께 확인된 건',
    })
    expect(h.due).toBe('당일 내 접촉')
    expect(h.title).toBe(TICKET.title)
    expect(h.run.state).toBe('complete')
    expect(h.headline).toBe('리텐션(해지 방어)팀 이관')
  })

  it('에스컬레이션 대상이 아니면 1선 종결로 닫는다', () => {
    const h = buildHandoff({
      ...FULL,
      analysis: {
        ...ANALYSIS,
        escalate: false,
        escalate_reason: null,
        ticket: null,
        churn: { score: 12, level: '없음', action: '조치 불필요', signals: [], speakerLabeled: true },
      },
    })
    expect(h.status.id).toBe('close')
    expect(h.owner).toBeNull()
    expect(h.status.detail).toContain('12점')
  })
})

describe('buildHandoff — 실패는 처리 상태에 반영된다', () => {
  const analyzeFailed = {
    ...FULL,
    analysis: null,
    stageErrors: { analyze: '통화 분석은 시간당 6회까지 가능합니다.', voc: '분석이 실패해 이번 통화는 누적하지 않았습니다.' },
  }

  it('분석이 실패하면 담당 부서를 만들지 않는다', () => {
    const h = buildHandoff(analyzeFailed)
    expect(h.owner).toBeNull()
    expect(h.due).toBeNull()
    expect(h.status.id).toBe('manual')
    expect(h.ticketText).toBeNull()
    // 실패했는데 특정 팀 이름이 처리 상태 어디에도 나오면 안 된다
    expect(JSON.stringify(h)).not.toContain('리텐션')
  })

  it('부분 실행이면 헤드라인에서부터 "부분 실행"이라고 말한다', () => {
    const h = buildHandoff(analyzeFailed)
    expect(h.run.state).toBe('partial')
    expect(h.headline.startsWith('부분 실행 ·')).toBe(true)
    expect(h.run.label).toContain('실패')
    expect(h.run.label).toContain(STAGE_LABELS.analyze)
  })

  it('실패 메시지만 옮기지 않고 "무엇이 비었는가"를 함께 적는다', () => {
    const h = buildHandoff(analyzeFailed)
    const check = h.checks.find((c) => c.id === 'stage-analyze')
    expect(check.level).toBe('high')
    expect(check.detail).toContain('담당 부서는 사람이 정해야 합니다')
    expect(check.detail).toContain('시간당 6회')
  })

  it('분석이 실패하면 티켓 복사 버튼을 제시하지 않는다 (빈 문서를 주지 않기 위해)', () => {
    const ids = buildHandoff(analyzeFailed).actions.map((a) => a.id)
    expect(ids).not.toContain('copy-ticket')
    expect(ids).not.toContain('open-voc')
    expect(ids).toContain('copy-report')
  })

  it('화자 분리가 실패하면 뒤 단계 점수의 신뢰도를 확인 항목으로 남긴다', () => {
    const h = buildHandoff({ ...FULL, dia: null, stageErrors: { dia: '분리 실패' } })
    expect(h.checks.some((c) => c.id === 'speaker')).toBe(true)
    expect(h.run.state).toBe('partial')
    // 화자 분리가 빠져도 분석이 살아 있으면 배정 자체는 유효하다
    expect(h.owner.team).toBe('리텐션(해지 방어)팀')
  })

  it('QA가 실패하면 코칭 이력에 남지 않았다고 적는다', () => {
    const h = buildHandoff({ ...FULL, qa: null, stageErrors: { qa: '평가 실패' } })
    expect(h.quality).toBeNull()
    expect(h.records.qaHistory).toBe(false)
    expect(h.actions.map((a) => a.id)).not.toContain('open-qa')
  })

  it('아무것도 실행되지 않았으면 그렇다고 말한다 (예외를 던지지 않는다)', () => {
    const h = buildHandoff()
    expect(h.run.state).toBe('none')
    expect(h.run.label).toBe('실행 결과 없음')
    expect(h.status.id).toBe('manual')
    expect(h.owner).toBeNull()
  })
})

describe('buildHandoff — 확인 항목', () => {
  it('에스컬레이션 건은 감면·보상 판단을 사람에게 남긴다', () => {
    const c = buildHandoff(FULL).checks.find((x) => x.id === 'escalate')
    expect(c.level).toBe('high')
    expect(c.detail).toContain('담당자가 판단합니다')
  })

  it('이탈 위험이 높으면 권고 조치와 근거 신호를 함께 올린다', () => {
    const c = buildHandoff(FULL).checks.find((x) => x.id === 'churn')
    expect(c.level).toBe('high')
    expect(c.detail).toContain('리텐션 팀 당일 이관')
    expect(c.detail).toContain('해지 의사 직접 표현')
  })

  it('이탈 위험이 기준 아래면 확인 항목으로 올리지 않는다', () => {
    const h = buildHandoff({
      ...FULL,
      analysis: { ...ANALYSIS, churn: { ...ANALYSIS.churn, score: 20, level: '낮음' } },
    })
    expect(h.checks.some((c) => c.id === 'churn')).toBe(false)
  })

  it('추정치가 섞이면 어느 값이 추정인지 밝힌다 (실측과 섞어 보여주지 않는다)', () => {
    const h = buildHandoff({
      ...FULL,
      analysis: { ...ANALYSIS, demo: true, churn: { ...ANALYSIS.churn, estimated: true } },
      qa: { ...QA, score: { ...QA.score, llmEstimated: true } },
    })
    const c = h.checks.find((x) => x.id === 'estimated')
    expect(c.label).toContain('분류·요약')
    expect(c.label).toContain('이탈 위험')
    expect(c.label).toContain('정성 평가')
  })

  it('감점 보류가 있으면 원본 확인이 필요하다고 남긴다', () => {
    const h = buildHandoff({
      ...FULL,
      qa: { ...QA, speaker_labeled: false, attribution: { speaker_labeled: false, withheld_count: 2 } },
    })
    expect(h.checks.find((c) => c.id === 'withheld').label).toContain('2건')
    expect(h.checks.some((c) => c.id === 'speaker')).toBe(true)
  })

  it('품질 점수가 미달이면 코칭 대상으로 표시한다', () => {
    const h = buildHandoff({ ...FULL, qa: { ...QA, score: { ...QA.score, total: 61, grade: 'D' } } })
    expect(h.checks.find((c) => c.id === 'quality').detail).toBe('처리 기한을 숫자로 안내하세요.')
  })

  it('걸리는 항목이 없으면 없다고 말한다 (빈 목록으로 두지 않는다)', () => {
    const h = buildHandoff({
      ...FULL,
      analysis: {
        ...ANALYSIS,
        escalate: false,
        ticket: null,
        churn: { score: 5, level: '없음', action: '조치 불필요', signals: [], speakerLabeled: true },
      },
    })
    expect(h.checks).toHaveLength(1)
    expect(h.checks[0].id).toBe('none')
  })

  it('심각한 항목이 위로 정렬된다', () => {
    const checks = buildHandoff({
      ...FULL,
      analysis: { ...ANALYSIS, demo: true },
    }).checks
    expect(checks[0].level).toBe('high')
    expect(checks[checks.length - 1].level).toBe('info')
  })
})

describe('formatHandoff — 화면과 문서가 같은 말을 한다', () => {
  it('담당·기한·확인 항목을 문서에 그대로 적는다', () => {
    const text = formatHandoff(buildHandoff(FULL)).join('\n')
    expect(text).toContain('상태: 리텐션(해지 방어)팀 이관')
    expect(text).toContain('담당: 리텐션(해지 방어)팀 · 우선순위 P1 · 처리 기한 당일 내 접촉')
    expect(text).toContain('[높음] 에스컬레이션 사유 확인')
    expect(text).toContain('기록: VOC 대시보드 반영 · 코칭 이력 기록')
  })

  it('배정이 없는 것과 이관이 필요 없는 것을 구분해 적는다', () => {
    const failed = formatHandoff(buildHandoff({ ...FULL, analysis: null, stageErrors: { analyze: 'x' } })).join('\n')
    expect(failed).toContain('담당: 미배정')
    const closed = formatHandoff(
      buildHandoff({ ...FULL, analysis: { ...ANALYSIS, escalate: false, ticket: null } })
    ).join('\n')
    expect(closed).toContain('담당: 추가 이관 없음')
  })
})

describe('buildPipelineReport — 처리 상태가 인수인계 문서에 들어간다', () => {
  it('리포트 한 장이 "어디로 · 누가 언제까지"로 시작한다', () => {
    const r = buildPipelineReport(FULL)
    expect(r).toContain('─── 처리 상태 (이 통화는 어떻게 처리되는가) ───')
    expect(r).toContain('처리 기한 당일 내 접촉')
    expect(r).toContain('⑤-1 코칭 이력에 기록 완료')
    // 기존 단계별 본문도 그대로 남는다
    expect(r).toContain('① STT 전사')
    expect(r).toContain('④ 통화 분석 — 유형: 해지')
  })

  it('분석이 실패한 리포트는 담당 부서를 지어내지 않는다', () => {
    const r = buildPipelineReport({
      stt: { text: '전사' },
      stageErrors: { analyze: '통화 분석은 시간당 6회까지 가능합니다.', voc: '분석이 실패해 이번 통화는 누적하지 않았습니다.' },
    })
    expect(r).toContain('부분 실행')
    expect(r).toContain('담당: 미배정')
    expect(r).not.toContain('리텐션')
    expect(r).not.toContain('누적 완료')
  })

  it('분석 결과가 없으면 VOC 누적을 완료라고 적지 않는다 (예전에는 그렇게 적었다)', () => {
    const r = buildPipelineReport({ stt: { text: '전사' } })
    expect(r).not.toContain('누적 완료')
    expect(r).toContain('⑥ VOC 누적: 미실행')
  })
})
