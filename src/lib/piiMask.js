// 개인정보 마스킹 — 녹취 전사에서 가장 먼저 처리해야 하는 것.
//
// 왜 이걸 만드는가:
// 콜센터 통화에는 본인확인이 반드시 들어간다. 주민등록번호, 카드번호, 계좌번호,
// 연락처가 전사 텍스트에 그대로 남는다. 그 텍스트는 지금 화면·클립보드·세션 저장소·
// 분석 API·QA 평가·티켓 초안·CSV로 퍼진다. 마스킹이 없으면 "서버에 저장하지 않는다"는
// 원칙을 지켜도 개인정보가 화면과 파일로 계속 새어 나간다.
//
// 설계 원칙:
// 1) **자릿수를 보존한다.** 940101-1234567 → 940101-1****** 처럼 길이를 유지하면
//    CER 정렬 인덱스와 문자 오프셋이 밀리지 않는다. 전사 정확도 측정·사전 보정과
//    같은 텍스트 위에서 계속 돌 수 있다.
// 2) **과검출이 안전한 방향이다.** 체크섬을 통과하지 못하는 번호도 마스킹한다 —
//    "검증에 실패했으니 그냥 보여준다"는 개인정보 처리에서 가장 나쁜 선택이다.
//    대신 금액·날짜·요금제처럼 개인정보가 아닌 숫자를 건드리지 않도록 패턴을 좁게 잡고,
//    맥락이 필요한 항목(계좌번호)은 같은 줄의 단서를 요구한다.
// 3) **무엇을 얼마나 가렸는지 돌려준다.** 조용히 바꾸면 사용자는 마스킹이 동작하는지
//    알 수 없고, 과검출도 발견하지 못한다.

// 뒤 n자리는 남긴다 — 상담사가 "끝 네 자리 확인" 하는 실무 동선을 지키기 위해서다
function keepTail(s, n) {
  let seen = 0
  return [...s]
    .reverse()
    .map((ch) => {
      if (!/\d/.test(ch)) return ch
      seen += 1
      return seen <= n ? ch : '*'
    })
    .reverse()
    .join('')
}

const digitsOf = (s) => s.replace(/\D/g, '')

function luhnOk(digits) {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i])
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return digits.length > 0 && sum % 10 === 0
}

// 같은 줄에 단서가 있는지 (계좌번호처럼 숫자만으로는 구분되지 않는 항목에 쓴다)
function lineHas(text, index, re) {
  const start = text.lastIndexOf('\n', index) + 1
  const endRaw = text.indexOf('\n', index)
  const end = endRaw === -1 ? text.length : endRaw
  return re.test(text.slice(start, end))
}

// 규칙 순서가 중요하다: 주민등록번호를 먼저 가려야 13자리 숫자가 카드번호로 잡히지 않는다.
export const PII_RULES = [
  {
    type: 'rrn',
    label: '주민등록번호',
    // 생년월일 6자리 + 성별 1~4 + 6자리. 월·일이 말이 되는 값일 때만.
    re: /\b(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[-\s]?([1-4])\d{6}\b/g,
    mask: (m) => `${m.slice(0, 6)}${m.includes('-') ? '-' : m.includes(' ') ? ' ' : ''}${m.replace(/[-\s]/g, '').slice(6, 7)}******`,
  },
  {
    type: 'card',
    label: '카드번호',
    // 13~19자리를 4자리씩 끊어 적는 흔한 형태. 체크섬을 통과하거나 카드 맥락이면 가린다.
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m, text, index) =>
      luhnOk(digitsOf(m)) || lineHas(text, index, /(카드|결제|승인|체크카드|신용)/),
    mask: (m) => keepTail(m, 4),
  },
  {
    type: 'phone',
    label: '연락처',
    re: /\b(01[016-9]|0[2-6]\d?)[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    mask: (m) => {
      // 앞 국번(010)과 끝 4자리는 남긴다 — 본인확인 동선에 필요하고, 그것만으로는 식별되지 않는다
      const head = m.match(/^(01[016-9]|0[2-6]\d?)/)[0]
      return head + keepTail(m.slice(head.length), 4)
    },
  },
  {
    type: 'account',
    label: '계좌번호',
    // 숫자만으로는 접수번호·주문번호와 구분되지 않는다 — 같은 줄에 단서가 있을 때만.
    re: /\b\d{2,6}[-\s]?\d{2,6}[-\s]?\d{2,7}\b/g,
    accept: (m, text, index) => {
      const d = digitsOf(m)
      return d.length >= 10 && d.length <= 14 && lineHas(text, index, /(계좌|입금|이체|송금|은행|출금계좌)/)
    },
    mask: (m) => keepTail(m, 3),
  },
  {
    type: 'email',
    label: '이메일',
    re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g,
    mask: (m) => {
      const [id, domain] = m.split('@')
      // 한 글자 아이디에 별표를 억지로 붙이면 길이가 늘어 오프셋이 밀린다.
      // 그런 아이디는 첫 글자를 남기는 것 자체가 의미가 없으므로 통째로 가린다.
      const hidden = id.length <= 1 ? '*' : id[0] + '*'.repeat(id.length - 1)
      return `${hidden}@${domain}`
    },
  },
]

// 반환: { text, hits: [{type, label, count}], total }
export function maskPii(input) {
  let text = String(input ?? '')
  const hits = []

  for (const rule of PII_RULES) {
    let count = 0
    // 치환 결과의 길이가 원본과 같으므로(자릿수 보존) 인덱스가 밀리지 않는다.
    text = text.replace(rule.re, (m, ...rest) => {
      const index = rest[rest.length - 2]
      if (rule.accept && !rule.accept(m, text, index)) return m
      count += 1
      return rule.mask(m)
    })
    if (count > 0) hits.push({ type: rule.type, label: rule.label, count })
  }

  return { text, hits, total: hits.reduce((s, h) => s + h.count, 0) }
}

// 화면에 한 줄로 보여줄 안내 (없으면 null)
export function maskNotice(result) {
  if (!result?.total) return null
  return `개인정보 ${result.total}건을 가렸습니다 — ${result.hits
    .map((h) => `${h.label} ${h.count}건`)
    .join(', ')}. 이후의 분석·평가·저장은 모두 가려진 텍스트로 진행됩니다.`
}
