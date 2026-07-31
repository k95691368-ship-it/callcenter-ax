// VOC 원인 추출 — "무슨 유형인가"에서 "왜 전화했는가"로.
//
// 왜 이걸 만드는가:
// 지금 대시보드는 통화를 5개 카테고리(가입·해지·요금·불만·기타)로 센다. 그런데 '불만' 안에는
// 속도 저하, 과다 청구, 응대 미흡이 섞여 있다. 센터장이 이 막대를 보고 할 수 있는 일은 없다 —
// "불만 3건"에는 넘길 부서가 없기 때문이다. VOC가 조직을 움직이려면 집계 단위가
// **원인**이어야 하고, 원인에는 처리할 **부서**가 붙어야 한다.
//
// 왜 규칙인가:
// 원인 태깅은 LLM 없이 된다. 콜센터 문의는 도메인 어휘가 좁고 반복되기 때문이다.
// 규칙은 (1) 비용이 0이고 (2) 왜 그렇게 분류됐는지 근거 문장을 그대로 보여줄 수 있고
// (3) 담당자가 사전을 직접 고칠 수 있다. LLM 분류는 이 세 가지를 모두 잃는다.
// 대신 규칙은 못 잡는 표현이 있으므로, 하나도 안 걸린 통화를 '미분류'로 드러내
// 사전을 늘려야 할 지점을 알려준다 — 조용히 0건으로 만들지 않는다.

// 고객 발화만 뽑는다. 상담사의 안내 문구("위약금이 발생합니다")까지 세면
// 모든 통화가 그 주제로 잡힌다 — 원인은 고객이 말한 것이어야 한다.
export function customerSpeech(transcript) {
  const text = String(transcript || '')
  if (!text.includes('고객:')) return text
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('고객:'))
    .map((line) => line.replace(/^\s*고객:\s*/, ''))
    .join('\n')
}

// 원인 사전. dept는 이 원인이 반복될 때 실제로 움직여야 하는 조직이다.
export const THEMES = [
  {
    id: 'speed',
    label: '인터넷 속도 저하·끊김',
    dept: '네트워크 운영팀',
    patterns: [/속도(가|는)?\s*(느|안|저하)/, /느려/, /끊[기겨김]/, /접속(이)?\s*안\s*(되|돼)/, /인터넷(이)?\s*안\s*(되|돼)/],
  },
  {
    id: 'overcharge',
    label: '요금 과다 청구',
    dept: '요금 정산팀',
    patterns: [/요금이\s*왜/, /과다/, /많이\s*나[왔온]/, /더\s*나[왔온]/, /청구(가|된)?\s*(이상|잘못)/, /사기/],
  },
  {
    id: 'roaming',
    label: '해외 로밍 요금',
    dept: '요금 정산팀',
    patterns: [/로밍/, /해외\s*(데이터|요금)/],
  },
  {
    id: 'penalty',
    label: '위약금·할인반환금',
    dept: '해지 방어팀',
    patterns: [/위약금/, /할인반환금/, /약정(이)?\s*(남|끝)/],
  },
  {
    id: 'churn',
    label: '해지·번호이동 의사',
    dept: '해지 방어팀',
    patterns: [/해지(하려|할|해\s*주)/, /번호이동/, /다른\s*회사/, /끊을?\s*거/],
  },
  {
    id: 'plan',
    label: '요금제 변경·비용 절감',
    dept: '요금 상담팀',
    patterns: [/요금제(를)?\s*(바꾸|변경|줄)/, /비싼\s*것?\s*같/, /싼\s*걸로/, /데이터를?\s*많이\s*안/],
  },
  {
    id: 'billing_date',
    label: '납부일·자동이체 변경',
    dept: '요금 정산팀',
    patterns: [/자동이체/, /납부(일|날짜)/, /출금(일|날짜)/, /월급날/],
  },
  {
    id: 'micropay',
    label: '소액결제 차단·환불',
    dept: '부가서비스팀',
    patterns: [/소액결제/, /게임\s*결제/, /결제가\s*자꾸/],
  },
  {
    id: 'bundle',
    label: '결합할인·가족결합',
    dept: '영업 지원팀',
    patterns: [/결합/, /가족\s*(회선|할인)/, /묶으/],
  },
  {
    id: 'install',
    label: '설치·이전·AS 방문',
    dept: '설치 운영팀',
    patterns: [/설치/, /기사(님)?(이|가)?\s*(와|방문|다녀)/, /이전\s*설치/, /점검/],
  },
  {
    id: 'namechange',
    label: '명의 변경 절차',
    dept: '가입 지원팀',
    patterns: [/명의\s*변경/, /명의를?\s*(바꾸|이전)/],
  },
  {
    id: 'signup',
    label: '신규 가입 상담',
    dept: '영업 지원팀',
    patterns: [/새로\s*가입/, /신규\s*가입/, /가입하려/],
  },
  {
    id: 'agent_quality',
    label: '상담 응대 미흡',
    dept: 'QA · 교육팀',
    patterns: [/안내를?\s*못/, /불친절/, /태도가/, /제대로\s*설명/, /알아서\s*하[라셔]/],
  },
  {
    id: 'legal',
    label: '외부 기관 신고·법적 대응 언급',
    dept: '고객보호 담당',
    patterns: [/소비자원/, /방송통신위원회|방통위/, /민원/, /소송/, /법적으로/, /언론(에)?\s*제보/, /신고(하|할)/],
  },
]

// 같은 문제로 다시 전화했다는 신호. 재문의는 1선 종결 실패의 직접 증거라
// 원인 집계와 별개로 따로 세야 한다.
export const REPEAT_PATTERNS = [
  /또\s*(느|안|그|같|저)/,
  /다시\s*(연락|전화)/,
  /[두세네](\s*)번째/,
  /지난\s*(주|번|달)에?도?\s*(왔|했|말)/,
  /벌써\s*\d+\s*번/,
  /계속\s*(이래|그래|같)/,
]

const speechOf = (call) => `${call?.title || ''}\n${customerSpeech(call?.transcript)}`

// 통화 하나에서 원인을 뽑는다. 근거 문장을 함께 돌려준다 — 왜 그렇게 분류됐는지
// 보여주지 못하면 담당자는 이 태깅을 믿지 않는다.
export function extractThemes(call) {
  const text = speechOf(call)
  const out = []
  for (const theme of THEMES) {
    const evidence = []
    for (const re of theme.patterns) {
      const m = text.match(re)
      if (m) {
        const line = text
          .split('\n')
          .find((l) => re.test(l))
        if (line && !evidence.includes(line.trim())) evidence.push(line.trim())
      }
    }
    if (evidence.length > 0) out.push({ id: theme.id, label: theme.label, dept: theme.dept, evidence })
  }
  return out
}

export function isRepeatCall(call) {
  const text = speechOf(call)
  const hit = REPEAT_PATTERNS.find((re) => re.test(text))
  if (!hit) return null
  const line = text.split('\n').find((l) => hit.test(l))
  return { evidence: (line || '').trim() }
}

// 전체 집계 — 원인별 건수, 부서별 묶음, 재문의, 미분류
export function aggregateThemes(calls) {
  const byTheme = new Map()
  const repeats = []
  const untagged = []

  for (const call of calls || []) {
    const themes = extractThemes(call)
    if (themes.length === 0) untagged.push(call)
    for (const t of themes) {
      if (!byTheme.has(t.id)) byTheme.set(t.id, { ...t, count: 0, calls: [], evidence: [] })
      const row = byTheme.get(t.id)
      row.count += 1
      row.calls.push(call)
      for (const e of t.evidence) if (row.evidence.length < 3 && !row.evidence.includes(e)) row.evidence.push(e)
    }
    const repeat = isRepeatCall(call)
    if (repeat) repeats.push({ call, ...repeat })
  }

  const themes = [...byTheme.values()].sort((a, b) => b.count - a.count)

  const deptMap = new Map()
  for (const t of themes) {
    if (!deptMap.has(t.dept)) deptMap.set(t.dept, { dept: t.dept, count: 0, themes: [] })
    const d = deptMap.get(t.dept)
    d.count += t.count
    d.themes.push({ id: t.id, label: t.label, count: t.count })
  }
  const byDept = [...deptMap.values()].sort((a, b) => b.count - a.count)

  return {
    themes,
    byDept,
    repeats,
    untagged,
    taggedRate: calls?.length ? (calls.length - untagged.length) / calls.length : 0,
  }
}

// 두 기간을 비교해 "무엇이 늘었는가"를 원인 단위로 돌려준다.
// 카테고리 급증(vocAnomaly)이 "불만이 늘었다"까지라면, 이건 "속도 저하가 늘었다"까지 간다.
export function compareThemes(currentCalls, previousCalls) {
  const now = aggregateThemes(currentCalls)
  const before = aggregateThemes(previousCalls)
  const beforeCount = new Map(before.themes.map((t) => [t.id, t.count]))
  return now.themes
    .map((t) => {
      const prev = beforeCount.get(t.id) || 0
      return { ...t, previous: prev, delta: t.count - prev, isNew: prev === 0 }
    })
    .sort((a, b) => b.delta - a.delta || b.count - a.count)
}
