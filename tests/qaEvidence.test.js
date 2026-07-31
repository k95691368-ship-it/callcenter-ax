import { describe, it, expect } from 'vitest'
import {
  checkMentions,
  agentScript,
  agentLines,
  mentionRuleSet,
  buildCustomMentions,
  computeQaScore,
  patternLiterals,
  REQUIRED_MENTIONS,
  EVIDENCE_MAX_QUOTE,
  EVIDENCE_UNKNOWN_SPEAKER_NOTE,
  NEAR_MIN_RATIO,
} from '../src/lib/qaRules.js'
import { onRequestPost } from '../functions/api/cc/qa.js'

// QA 점수는 수퍼바이저가 상담사 앞에서 방어해야 하는 숫자다. O/X만으로는 방어가 안 된다.
// 이 파일은 "어디서 그렇게 판단했는가"에 답하는 근거층을 검증한다 —
// 근거가 실제 발화를 가리키는가, 없는 근거를 지어내지 않는가, 채점은 그대로인가.

const CALL = `고객: 요금이 왜 이렇게 올랐나요?
상담사: 안녕하세요, 한빛텔레콤 상담사입니다. 통화 내용이 녹음됩니다.
고객: 명의 변경도 하고 싶어요.
상담사: 본인 확인을 위해 성함과 생년월일 부탁드립니다. 다음 달 1일부터 적용되도록 처리해 드리겠습니다.`

const script = (t) => agentScript(t)
const byId = (mentions) => Object.fromEntries(mentions.map((m) => [m.id, m]))

// 서버가 하는 것과 같은 방식으로 검사한다 (원문 줄 번호 + 화자 라벨 여부를 함께 넘긴다)
function evaluate(transcript, ruleSet = REQUIRED_MENTIONS) {
  const s = script(transcript)
  return byId(checkMentions(s.text, ruleSet, { speakerLabeled: s.labeled, lineNumbers: s.lineNumbers }))
}

describe('agentScript — 근거의 줄 번호를 원문 기준으로 되돌린다', () => {
  it('상담사 발화만 뽑되 원문 줄 번호를 함께 남긴다', () => {
    const s = script(CALL)
    expect(s.labeled).toBe(true)
    expect(s.lineNumbers).toEqual([2, 4]) // 전사의 2·4번째 줄이 상담사 발화
    expect(s.text.split('\n')).toHaveLength(2)
  })

  it('agentLines와 같은 텍스트를 준다 (기존 계약을 깨지 않는다)', () => {
    for (const t of [CALL, '그냥 텍스트', '', null]) {
      expect(agentScript(t).text).toBe(agentLines(t))
    }
  })

  it('화자 라벨이 없으면 전문을 보고, 줄 번호는 원문 그대로다', () => {
    const s = script('첫 줄입니다\n둘째 줄입니다')
    expect(s.labeled).toBe(false)
    expect(s.lineNumbers).toEqual([1, 2])
    expect(s.text).toBe('첫 줄입니다\n둘째 줄입니다')
  })
})

describe('이행 근거 — 어느 줄, 어느 구절에서 매치됐는가', () => {
  const m = evaluate(CALL)

  it('이행 항목마다 근거 발화와 매치 구간을 준다', () => {
    const ev = m.recording.evidence
    expect(m.recording.found).toBe(true)
    expect(ev.match).toBe('녹음')
    expect(ev.line).toBe(2) // 원문 전사의 2번째 줄
    expect(ev.quote).toContain('통화 내용이 녹음됩니다')
    // 오프셋은 quote 안에서 그대로 잘라 쓸 수 있어야 한다 (화면이 다시 검색하지 않는다)
    expect(ev.quote.slice(ev.start, ev.end)).toBe(ev.match)
  })

  it('근거 발화는 실제 전사에 있는 문장이다 (지어낸 인용이 아니다)', () => {
    for (const id of ['greeting', 'identity', 'recording', 'solution']) {
      const ev = m[id].evidence
      expect(ev, id).not.toBeNull()
      expect(CALL).toContain(ev.match)
      expect(CALL).toContain(ev.quote.slice(0, 20))
    }
  })

  it('여러 패턴이 걸리면 더 앞선 발화를 근거로 삼는다', () => {
    // identity는 '본인 확인'(앞) 과 '생년월일'(뒤) 두 패턴이 모두 걸린다
    expect(m.identity.evidence.match).toBe('본인 확인')
  })

  it('화자 라벨이 있을 때만 근거를 상담사 발화로 표기한다', () => {
    expect(m.greeting.evidence.speaker).toBe('agent')
    const unlabeled = evaluate('안녕하세요, 한빛텔레콤입니다. 통화 내용이 녹음됩니다.')
    expect(unlabeled.greeting.evidence.speaker).toBe('unknown')
  })

  it('라벨 여부를 알려주지 않은 호출부에는 상담사라고 단정하지 않는다', () => {
    // scriptGuide처럼 옵션 없이 부르는 경로 — 모르면 unknown으로 남는다
    const guess = byId(checkMentions('안녕하세요. 녹음됩니다.'))
    expect(guess.greeting.evidence.speaker).toBe('unknown')
    expect(EVIDENCE_UNKNOWN_SPEAKER_NOTE).toContain('화자 미확인')
  })

  it('고객이 한 말은 근거가 되지 않는다 (라벨이 있으면 상담사 발화만 본다)', () => {
    const call = `고객: 통화 녹음되나요? 안녕하세요.
상담사: 네, 처리해 드리겠습니다.`
    const r = evaluate(call)
    expect(r.recording.found).toBe(false)
    expect(r.recording.evidence).toBeNull()
    expect(r.greeting.found).toBe(false)
  })

  it('미이행 항목에는 이행 근거가 없다', () => {
    expect(m.closing.found).toBe(false)
    expect(m.closing.evidence).toBeNull()
  })
})

describe('근접 발화 — 근거가 있을 때만 준다', () => {
  it('규칙과 부분적으로 겹치는 발화가 있으면 코칭용으로 짚어준다', () => {
    const r = evaluate('상담사: 궁금하신 점 있으실까요?')
    // '더 궁금'이 아니라 '궁금'만 있어 이행은 아니다
    expect(r.closing.found).toBe(false)
    expect(r.closing.near.partial).toBe(true)
    expect(r.closing.near.match).toBe('궁금')
    expect(r.closing.near.overlap).toBeGreaterThanOrEqual(NEAR_MIN_RATIO)
    expect(r.closing.near.speaker).toBe('agent')
  })

  it('겹치는 발화가 없으면 null이다 — 비슷해 보이는 발화를 추측으로 만들지 않는다', () => {
    const r = evaluate('상담사: 안녕하세요.')
    expect(r.recording.found).toBe(false)
    expect(r.recording.near).toBeNull() // '녹음'·'녹취'와 겹치는 글자가 없다
    expect(r.identity.near).toBeNull()
  })

  it('어미만 겹치는 발화는 근접으로 치지 않는다 (한국어 어미 편승 방지)', () => {
    // '반갑습니다'(첫인사 규칙)와 "…포함되어 있습니다"는 '습니다' 3글자가 겹친다.
    // 위치를 가리지 않고 재던 구현은 이 문장을 첫인사의 "가장 가까웠던 발화"로 뽑았다.
    const r = evaluate('상담사: 이번 달 청구서에 부가서비스 항목이 포함되어 있습니다.')
    expect(r.greeting.found).toBe(false)
    expect(r.greeting.near).toBeNull()
  })

  it('근접 발화도 화자 귀속을 단정하지 않는다', () => {
    const r = evaluate('궁금하신 점 있으실까요?') // 라벨 없는 전사
    expect(r.closing.near.speaker).toBe('unknown')
  })

  it('부분 일치는 겹친 구간만 강조한다 (발화 전체를 근거로 부풀리지 않는다)', () => {
    const r = evaluate('상담사: 처리 확인해 드렸습니다.')
    const near = r.identity.near
    expect(near.match).toBe('확인') // 규칙 /성함.*확인/·/본인\s*확인/ 의 '확인'만 겹친다
    expect(near.quote.slice(near.start, near.end)).toBe('확인')
  })
})

describe('커스텀 멘트도 같은 방식으로 근거를 남긴다', () => {
  const set = mentionRuleSet(buildCustomMentions([{ label: '청약철회 안내', keywords: ['청약철회'] }]))

  it('키워드 이행에도 근거 위치가 붙는다', () => {
    const r = evaluate('상담사: 청약철회는 14일 이내 가능합니다.', set)
    const c = r['custom-1']
    expect(c.custom).toBe(true)
    expect(c.found).toBe(true)
    expect(c.evidence.match).toBe('청약철회')
    expect(c.evidence.quote.slice(c.evidence.start, c.evidence.end)).toBe('청약철회')
    expect(c.evidence.line).toBe(1)
  })

  it('키워드와 부분만 겹치면 근접 발화로만 남는다', () => {
    const r = evaluate('상담사: 청약 철회는 별도 안내드립니다.', set)
    const c = r['custom-1']
    expect(c.found).toBe(false) // 띄어쓰기가 달라 키워드 포함이 아니다
    expect(c.near.match).toBe('청약')
    expect(c.near.overlap).toBe(0.5)
  })
})

describe('근거층은 채점을 바꾸지 않는다', () => {
  it('이행 판정(found)은 예전 그대로다', () => {
    const m = evaluate(CALL)
    expect(Object.fromEntries(Object.entries(m).map(([id, x]) => [id, x.found]))).toEqual({
      greeting: true,
      identity: true,
      recording: true,
      solution: true,
      closing: false,
    })
  })

  it('점수는 evidence·near를 붙이기 전과 같다 (근거는 가산점이 아니다)', () => {
    const withEvidence = Object.values(evaluate(CALL))
    // 근거 필드를 떼어낸 예전 모양
    const bare = withEvidence.map((x) => ({
      id: x.id,
      label: x.label,
      points: x.points,
      example: x.example,
      found: x.found,
    }))
    expect(computeQaScore({ mentions: withEvidence, findings: [] })).toEqual(
      computeQaScore({ mentions: bare, findings: [] })
    )
    expect(computeQaScore({ mentions: withEvidence, findings: [] }).ruleScore).toBe(32)
  })

  it('기존 반환 필드를 그대로 유지한다 (추가만 한다)', () => {
    const m = evaluate(CALL).greeting
    expect(m).toMatchObject({ id: 'greeting', label: '첫인사·소속 밝히기', points: 8 })
    expect(typeof m.example).toBe('string')
    expect(typeof m.found).toBe('boolean')
  })
})

describe('경계 — 근거 추출이 응답을 깨뜨리지 않는다', () => {
  it('빈 전사에서도 터지지 않고 근거는 비어 있다', () => {
    const r = byId(checkMentions('', REQUIRED_MENTIONS, {}))
    expect(Object.values(r).every((m) => m.found === false && m.evidence === null && m.near === null)).toBe(true)
  })

  it('줄바꿈 없는 긴 전사에서도 인용을 상한까지만 자른다', () => {
    const long = `상담사: ${'요금 안내를 드립니다. '.repeat(200)}통화 내용이 녹음됩니다.`
    const ev = evaluate(long).recording.evidence
    expect(ev.match).toBe('녹음')
    expect(ev.quote.length).toBeLessThanOrEqual(EVIDENCE_MAX_QUOTE)
    expect(ev.clippedStart).toBe(true)
    expect(ev.quote.slice(ev.start, ev.end)).toBe('녹음')
  })

  it('두 줄에 걸쳐 매치돼도(\\s가 개행을 먹는다) 오프셋이 맞는다', () => {
    const r = evaluate('상담사: 본인\n상담사: 확인 부탁드립니다')
    const ev = r.identity.evidence
    expect(ev.line).toBe(1)
    expect(ev.match).toBe('본인 확인') // 개행은 공백으로 치환 (1:1이라 오프셋 유지)
    expect(ev.quote.slice(ev.start, ev.end)).toBe(ev.match)
  })

  it('정규식에서 리터럴 조각만 뽑는다 (메타문자가 근거 조각이 되면 소음이 된다)', () => {
    expect(patternLiterals(/처리(해|하겠|되|가\s*완료)/)).toEqual(['처리', '하겠', '완료'])
    expect(patternLiterals(/성함.*확인/)).toEqual(['성함', '확인'])
    expect(patternLiterals(/녹음/)).toEqual(['녹음'])
    expect(patternLiterals(null)).toEqual([])
  })
})

// ── 서버 응답 계약 (데모 모드: API 키 없이도 근거가 나와야 한다) ──────────────
function ctx(body, env = {}) {
  const text = JSON.stringify(body)
  const headers = { 'content-length': String(new TextEncoder().encode(text).byteLength) }
  return {
    request: {
      text: async () => text,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    },
    env,
  }
}

describe('/api/cc/qa — 근거는 키 없이도 나온다 (규칙층이 만든다)', () => {
  it('데모 응답의 이행 항목마다 근거 발화가 실려 온다', async () => {
    const res = await onRequestPost(ctx({ transcript: CALL }))
    const data = await res.json()
    expect(data.demo).toBe(true)
    const m = byId(data.mentions)
    expect(m.recording.evidence.quote).toContain('녹음됩니다')
    expect(m.recording.evidence.line).toBe(2)
    expect(m.recording.evidence.speaker).toBe('agent')
    // 이행 건수와 근거를 짚은 건수가 같아야 화면이 통과 배지를 띄운다
    expect(data.mention_evidence).toEqual({ found: 4, cited: 4, near: 0 })
  })

  it('화자 라벨이 없으면 근거의 화자를 상담사로 단정하지 않는다', async () => {
    const res = await onRequestPost(ctx({ transcript: '안녕하세요. 통화 내용이 녹음됩니다.' }))
    const data = await res.json()
    expect(data.speaker_labeled).toBe(false)
    expect(byId(data.mentions).greeting.evidence.speaker).toBe('unknown')
  })

  it('커스텀 체크리스트의 근거도 함께 온다', async () => {
    const res = await onRequestPost(
      ctx({
        transcript: CALL,
        custom_mentions: [{ label: '요금 안내', keywords: ['요금'] }],
      })
    )
    const data = await res.json()
    const c = byId(data.mentions)['custom-1']
    // 고객 발화의 '요금'은 근거가 아니다 — 상담사 발화에는 없으므로 미이행
    expect(c.found).toBe(false)
    expect(c.evidence).toBeNull()
  })

  it('기존 응답 필드(mentions·findings·score·speaker_labeled·attribution)는 그대로다', async () => {
    const res = await onRequestPost(ctx({ transcript: CALL }))
    const data = await res.json()
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['mentions', 'findings', 'score', 'speaker_labeled', 'attribution'])
    )
    expect(data.score.ruleScore).toBe(32)
    expect(data.score.total).toBe(80)
  })
})
