import { Link } from 'react-router-dom'

const PROOFS = [
  { before: '녹취 청취 후 수기 기록', after: 'Whisper 전사', label: '오픈소스 STT + CER 성능 측정까지' },
  { before: '통화 내용 수기 분류', after: '즉시 구조화', label: '유형·요약·감정·의도·조치 한 번에' },
  { before: 'QA 평가자가 전 건 청취', after: '100점 점수표', label: '규칙 스캔 + LLM 정성 평가 이중 구조' },
  { before: '규정집 뒤지며 응대', after: '근거 인용 답변', label: '임베딩 검색 → 문서 기반 RAG 답변' },
]

const DEMOS = [
  {
    to: '/pipeline',
    tag: '원클릭 시연 ★',
    title: '전체 파이프라인',
    desc: '버튼 하나로 실제 API 6단계가 연속 실행됩니다 — 음성 전사 → 도메인 보정 → 화자 분리 → LLM 분석 → Auto QA → VOC 누적. 마이크로 내 목소리를 넣어볼 수도 있어요. 심사를 여기서 시작하세요.',
  },
  {
    to: '/stt',
    tag: '담당업무 ① STT',
    title: '녹취 전사 (Whisper)',
    desc: '상담 녹취 음성을 오픈소스 Whisper로 전사합니다. 정답 스크립트를 주면 CER(문자 오류율)로 STT 성능을 평가해요 — 음성 없이 텍스트로도 시연됩니다.',
  },
  {
    to: '/analyze',
    tag: '담당업무 ② 분류·요약·의도',
    title: '통화 분석',
    desc: '전사 텍스트를 문의 유형·3줄 요약·고객 감정·의도 키워드·후속 조치로 구조화합니다. 법적 클레임·강성 민원은 AI가 결론 내리지 않고 담당자에게 올려요.',
  },
  {
    to: '/qa',
    tag: '담당업무 ③ Auto QA',
    title: '상담 품질 평가',
    desc: '필수 안내 멘트 체크리스트와 금지 표현 규칙 스캔에 LLM 정성 평가를 합친 100점 점수표. 규칙 층은 결정적이라 키 없이도 실제로 동작합니다.',
  },
  {
    to: '/voc',
    tag: '담당업무 ⑤ VOC 분석',
    title: 'VOC 대시보드',
    desc: '분석 결과 10건을 유형·감정·일별로 집계한 대시보드. 어떤 문의가 몰리고 강성 민원이 어디서 나오는지 한눈에 보입니다.',
  },
  {
    to: '/search',
    tag: '담당업무 ④ RAG 검색',
    title: 'RAG 상담 지식 검색',
    desc: '벡터 유사도와 키워드 랭킹을 RRF로 융합한 하이브리드 검색으로 규정 문서를 찾고, 근거 문단만 사용해 답합니다. 인용 문서까지 투명하게 표시해요.',
  },
  {
    to: '/assist',
    tag: '신규 기능 제안 ★',
    title: '실시간 상담 지원 (Agent Assist)',
    desc: '공고의 "신규 기능 연구·개발"에 대응해 직접 제안한 기능 — 진행 중인 대화를 읽고 규정을 RAG 검색해 다음 응대 멘트와 에스컬레이션 주의를 실시간 제안합니다.',
  },
  {
    to: '/about',
    tag: '심사자용',
    title: '제작기 · 공고 매핑',
    desc: '채용공고 요건 ↔ 구현 기능 1:1 매핑 표, 시스템 구조도, 그리고 AI 코딩 에이전트로 기획부터 배포까지 완결한 제작 과정.',
  },
]

const PIPELINE = ['녹취 음성', 'STT 전사 (Whisper)', 'LLM 분석·Auto QA', 'VOC 집계', 'RAG 지식 검색']

export default function HubPage() {
  return (
    <div className="hub">
      <section className="hub-hero">
        <p className="hub-eyebrow">콜센터 AI 서비스 파이프라인 — 지금 실제로 동작합니다</p>
        <h1>
          녹취에서 인사이트까지,
          <br />
          <span className="accent">콜센터 AX 워크벤치</span>
        </h1>
        <p className="hub-sub">
          "STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스" — 채용공고의 담당업무 문장을
          다섯 개의 동작하는 화면으로 구현했습니다. 녹취 회사의 제품 파이프라인 순서 그대로입니다.
        </p>
        <div className="hub-cta">
          <Link to="/pipeline" className="btn-primary">
            ▶ 전체 파이프라인 원클릭 실행
          </Link>
          <Link to="/analyze" className="btn-ghost">
            강성 민원 통화 분석해 보기
          </Link>
        </div>
      </section>

      <section className="proof-strip" aria-label="자동화 효과">
        {PROOFS.map((p) => (
          <div className="proof-card" key={p.after}>
            <p className="proof-before">{p.before}</p>
            <p className="proof-after">→ {p.after}</p>
            <p className="proof-label">{p.label}</p>
          </div>
        ))}
      </section>

      <section className="hub-pipeline" aria-label="콜센터 AI 파이프라인">
        <h2>공고의 담당업무가 곧 파이프라인입니다</h2>
        <p className="hub-pipeline-sub">
          음성이 텍스트가 되고, 텍스트가 구조화된 분석이 되고, 분석이 쌓여 VOC 인사이트가 됩니다.
          반복은 AI가 대체하고 — 법적 클레임·강성 민원의 판단은 사람에게 남깁니다.
        </p>
        <ol className="pipeline-flow">
          {PIPELINE.map((step, i) => (
            <li key={step}>
              <span className="pipeline-step-num">{i + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </section>

      <section className="hub-demos">
        <h2>기능 5가지 + 제작기 — 채용공고의 담당업무 그대로</h2>
        <div className="hub-grid">
          {DEMOS.map((d) => (
            <Link key={d.to} to={d.to} className="hub-card">
              <span className="hub-card-tag">{d.tag}</span>
              <h3>{d.title}</h3>
              <p>{d.desc}</p>
              <span className="hub-card-go">직접 써보기 →</span>
            </Link>
          ))}
        </div>
      </section>

      <section className="hub-closing">
        <h2>궁금하시다면, 지금 하나만 눌러 보세요</h2>
        <p>
          모든 기능은 가상 통화 샘플이 채워져 있어 입력 없이 버튼 한 번으로 결과를 확인할 수
          있습니다. 음성 업로드 없이도 전체 흐름이 시연됩니다.
        </p>
        <div className="hub-cta">
          <Link to="/analyze" className="btn-primary">
            통화 분석해 보기
          </Link>
          <Link to="/search" className="btn-ghost">
            RAG 검색해 보기
          </Link>
        </div>
      </section>
    </div>
  )
}
