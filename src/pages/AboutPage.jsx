import { Link } from 'react-router-dom'

const DUTY_MAP = [
  {
    duty: 'STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스 신규 기능 연구·개발',
    impl: '워크벤치 전체 — STT·LLM 분석·Auto QA·RAG 검색이 한 파이프라인으로 동작',
    to: '/',
    label: '홈',
  },
  {
    duty: 'Whisper 등 오픈소스 STT/ASR 모델의 성능 평가 및 서비스 적용',
    impl: 'Whisper large-v3-turbo 서버리스 전사 + 정답 스크립트 대비 CER(문자 오류율) 측정기',
    to: '/stt',
    label: '녹취 전사',
  },
  {
    duty: '콜센터 녹취·STT 데이터 기반 분류, 요약, VOC·의도 분석',
    impl: '문의 유형 분류·3줄 요약·감정·의도 키워드·후속 조치 (구조화 tool 호출) + VOC 집계 대시보드',
    to: '/analyze',
    label: '통화 분석',
  },
  {
    duty: '상담 품질 평가 자동화 (Auto QA)',
    impl: '필수 멘트 체크리스트(40점) + 금지 표현 감점 + LLM 정성 평가(60점) 이중 구조 점수표',
    to: '/qa',
    label: 'Auto QA',
  },
  {
    duty: 'RAG 기반 검색',
    impl: 'bge-m3 임베딩 → 코사인 유사도 상위 3건 → 근거 문단만 사용해 답변 + 인용 표시',
    to: '/search',
    label: 'RAG 검색',
  },
]

const PREFER_MAP = [
  { req: 'Whisper 등 STT 모델 실습 경험 (우대)', impl: 'Workers AI로 Whisper를 실제 서비스에 적용, CER 평가까지' },
  { req: 'RAG·Embedding·Vector Search 개념 이해 (우대)', impl: '임베딩 → 벡터 유사도 → 근거 강제 생성의 전 단계를 직접 구현' },
  { req: 'NLP 프로젝트 경험 (우대)', impl: '분류·요약·감정·의도 분석 + 규칙 기반 텍스트 스캐너(멘트·금지 표현)' },
  { req: '오픈소스 AI 모델/라이브러리 실습 (자격요건)', impl: 'Whisper·bge-m3 오픈소스 모델을 서버리스로 서빙' },
  { req: 'AI 서비스 개발에 대한 관심 (자격요건)', impl: '기획 → 구현 → 테스트 → 배포 → 운영 안전장치까지 전 주기 완결' },
]

const LIVE_TABLE = [
  { feature: '녹취 전사 (Whisper STT)', mode: '라이브', how: 'Workers AI 바인딩 — API 키 없이 실제 전사' },
  { feature: 'STT 성능 평가 (CER)', mode: '항상 실제 계산', how: '브라우저에서 Levenshtein 거리 계산 (순수 함수)' },
  { feature: 'RAG 검색 (임베딩·유사도)', mode: '라이브', how: 'bge-m3 임베딩 + 코사인 유사도, 실패 시 키워드 랭킹 폴백' },
  { feature: 'QA 규칙 스캔 (멘트·금지 표현)', mode: '항상 실제 계산', how: '결정적 규칙 엔진 — 데모 모드에서도 진짜로 동작' },
  { feature: 'VOC 대시보드', mode: '항상 실제 계산', how: '내장 10건 + 직접 분석한 통화를 브라우저에 누적 집계 (서버 미전송)' },
  { feature: 'LLM 분석·QA 정성 평가·RAG 답변', mode: '라이브', how: '오픈소스 LLM(Llama 3.3 70B, Workers AI) — CLAUDE_API_KEY 등록 시 Claude Opus 4.8로 자동 상향' },
]

export default function AboutPage() {
  return (
    <div className="tool-page about-page">
      <header className="tool-header">
        <span className="tool-tag">심사자용 제작기</span>
        <h1>이 포트폴리오는 채용공고를 그대로 구현했습니다</h1>
        <p>
          콜센터 녹취·CTI 솔루션 기업의 <strong>"인공지능 융합" 파트(신입)</strong> 지원용
          포트폴리오입니다. 공고 담당업무의 다섯 줄 — STT, 분류·요약, VOC·의도 분석, Auto QA,
          RAG — 를 각각 동작하는 화면으로 만들었고, 아래 표에서 1:1로 대응을 확인할 수 있습니다.
        </p>
      </header>

      <section className="about-section">
        <h2>1. 공고 담당업무 ↔ 구현 기능</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>공고 담당업무 (원문 요지)</th>
                <th>구현</th>
                <th>바로가기</th>
              </tr>
            </thead>
            <tbody>
              {DUTY_MAP.map((r) => (
                <tr key={r.label}>
                  <td className="req-basis">{r.duty}</td>
                  <td>{r.impl}</td>
                  <td>
                    <Link className="req-link" to={r.to}>
                      {r.label} →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="about-section">
        <h2>2. 자격요건·우대사항 대응 (신입 기준)</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>공고 요건</th>
                <th>이 포트폴리오의 증명</th>
              </tr>
            </thead>
            <tbody>
              {PREFER_MAP.map((r) => (
                <tr key={r.req}>
                  <td className="req-basis">{r.req}</td>
                  <td>{r.impl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="about-section">
        <h2>3. 시스템 구조</h2>
        <div className="arch">
          <div className="arch-row">
            <div className="arch-box">
              <strong>브라우저 (React 19)</strong>
              <span>화면 5종 · CER 계산 · Turnstile 토큰 · 규칙 스캐너 공유</span>
            </div>
            <span className="arch-arrow">→</span>
            <div className="arch-box arch-core">
              <strong>Cloudflare Pages Functions</strong>
              <span>/api/cc/stt · analyze · qa · search — 검증·폴백·레이트리밋의 관문</span>
            </div>
            <span className="arch-arrow">→</span>
            <div className="arch-box">
              <strong>Workers AI (오픈소스 모델)</strong>
              <span>Whisper large-v3-turbo (STT) · bge-m3 (임베딩)</span>
            </div>
          </div>
          <div className="arch-row">
            <div className="arch-box">
              <strong>Claude Opus 4.8</strong>
              <span>tool 강제 호출 → 구조화 JSON → ensureContract 계약 검증</span>
            </div>
            <div className="arch-box">
              <strong>Cloudflare D1</strong>
              <span>레이트리밋 버킷 · AI 호출 텔레메트리 (개인정보 미저장)</span>
            </div>
            <div className="arch-box">
              <strong>안전장치</strong>
              <span>데모 폴백 · 일일 예산 캡 · 타임아웃+재시도 · 우아한 강등</span>
            </div>
          </div>
          <p className="arch-notes">
            업로드 음성은 전사 후 즉시 폐기합니다. 텔레메트리에는 입력 내용·IP를 저장하지
            않습니다. 모든 샘플 통화·기업명("한빛텔레콤")은 가상 창작물입니다.
          </p>
        </div>
      </section>

      <section className="about-section">
        <h2>4. 무엇이 라이브이고 무엇이 데모인가 (정직한 구분)</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>기능</th>
                <th>현재 상태</th>
                <th>방식</th>
              </tr>
            </thead>
            <tbody>
              {LIVE_TABLE.map((r) => (
                <tr key={r.feature}>
                  <td>{r.feature}</td>
                  <td className="req-name">{r.mode}</td>
                  <td className="req-basis">{r.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="about-section">
        <h2>5. 제작기 — AI 코딩 에이전트와 하루 만에</h2>
        <div className="about-process">
          <div className="about-step">
            <strong>① 공고 분석</strong>
            <p>공고 원문과 회사의 제품 구성(녹취·상담원평가·음성인식)을 분석해 기능을 공고 문장에 1:1로 매핑한 기획안 작성.</p>
          </div>
          <div className="about-step">
            <strong>② 검증된 구조 재사용</strong>
            <p>전작 포트폴리오(커머스 AX 워크벤치)의 안전장치 — 데모 폴백, 레이트리밋, 응답 계약 검증, 텔레메트리 — 를 그대로 이식.</p>
          </div>
          <div className="about-step">
            <strong>③ 구현·테스트</strong>
            <p>QA 점수 계산·CER·규칙 스캐너·검색 랭킹은 순수 함수로 분리해 vitest 단위 테스트. AI 코딩 에이전트(Claude Code)와 페어로 진행.</p>
          </div>
          <div className="about-step">
            <strong>④ 당일 배포</strong>
            <p>Cloudflare Pages + wrangler 원커맨드 배포. 완벽보다 배포를 앞세우고 개선기획안으로 사이클을 돌립니다.</p>
          </div>
        </div>
        <p className="about-point">
          이 페이지의 모든 주장에는 과장이 없습니다 — 표의 "라이브/데모" 구분 그대로이며, 코드와
          테스트는 GitHub 저장소에서 확인할 수 있습니다.
        </p>
      </section>
    </div>
  )
}
