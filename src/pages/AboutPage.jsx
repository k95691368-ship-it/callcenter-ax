import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { summarizeStats } from '../lib/statsSummary.js'

const DUTY_MAP = [
  {
    duty: 'STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스 신규 기능 연구·개발',
    impl: '워크벤치 전체 — STT·LLM 분석·Auto QA·RAG 검색이 한 파이프라인으로 동작',
    to: '/',
    label: '홈',
  },
  {
    duty: 'Whisper 등 오픈소스 STT/ASR 모델의 성능 평가, 도메인 튜닝 및 서비스 적용',
    impl: 'Whisper 2종 전사·CER 측정 + 콜센터 용어 사전 후보정(도메인 튜닝 1단계)으로 보정 전/후 CER 개선 정량 표시. 오전사→정정 쌍을 직접 추가하는 커스텀 사전 실험 지원',
    to: '/stt',
    label: '녹취 전사',
  },
  {
    duty: '콜센터 도메인에 특화된 AI 처리 파이프라인 설계',
    impl: '원클릭 파이프라인 — 음성→STT→도메인 보정→분석→QA→VOC가 실제 API로 연속 실행',
    to: '/pipeline',
    label: '파이프라인',
  },
  {
    duty: '콜센터 녹취·STT 데이터 기반 분류, 요약, VOC·의도 분석',
    impl: '문의 유형 분류·3줄 요약·감정·의도 키워드·후속 조치 (구조화 tool 호출) + VOC 집계 대시보드',
    to: '/analyze',
    label: '통화 분석',
  },
  {
    duty: '상담 품질 평가 자동화 (Auto QA)',
    impl: '필수 멘트 체크리스트(40점) + 금지 표현 감점 + LLM 정성 평가(60점) 이중 구조 점수표. 콜센터별 커스텀 멘트 규칙 추가 가능',
    to: '/qa',
    label: 'Auto QA',
  },
  {
    duty: 'STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스 "신규 기능" 연구·개발',
    impl: '실시간 상담 지원(Agent Assist) — 진행 중 대화를 읽고 규정 RAG 검색 + 다음 응대 멘트 제안 + 에스컬레이션 주의. 담당업무 문구에서 출발해 직접 제안·구현한 신규 기능',
    to: '/assist',
    label: '상담 지원',
  },
  {
    duty: 'RAG 기반 검색',
    impl: 'bge-m3 벡터 + 키워드 랭킹 RRF 융합 하이브리드 검색 → 근거 문단만 사용해 답변 + 인용 표시. 내 문서를 붙여넣으면 실시간 인덱싱되어 같은 코퍼스에서 검색',
    to: '/search',
    label: 'RAG 검색',
  },
]

const PREFER_MAP = [
  { req: 'Whisper 등 STT 모델 실습 경험', impl: 'Workers AI로 Whisper를 실제 서비스에 적용, CER 평가까지' },
  { req: 'RAG·Embedding·Vector Search 개념 이해', impl: '임베딩 → 벡터 유사도 → 근거 강제 생성의 전 단계를 직접 구현' },
  { req: 'NLP 프로젝트 경험', impl: '분류·요약·감정·의도 분석 + 규칙 기반 텍스트 스캐너(멘트·금지 표현)' },
  { req: '오픈소스 AI 모델/라이브러리 실습', impl: 'Whisper·bge-m3 오픈소스 모델을 서버리스로 서빙' },
  { req: 'AI 서비스 개발에 대한 관심', impl: '기획 → 구현 → 테스트 → 배포 → 운영 안전장치까지 전 주기 완결' },
]

const LIVE_TABLE = [
  { feature: '녹취 전사 (Whisper STT)', mode: '라이브', how: 'Workers AI 바인딩 — API 키 없이 실제 전사' },
  { feature: 'STT 성능 평가 (CER)', mode: '항상 실제 계산', how: '브라우저에서 Levenshtein 거리 계산 (순수 함수)' },
  { feature: 'STT 도메인 보정 (튜닝 1단계)', mode: '항상 실제 계산', how: '콜센터 용어 사전 후보정 + 보정 전/후 CER 비교' },
  { feature: 'RAG 검색 (하이브리드)', mode: '라이브', how: 'bge-m3 벡터 + 키워드 랭킹 RRF 융합, 임베딩 실패 시 키워드 폴백' },
  { feature: 'QA 규칙 스캔 (멘트·금지 표현)', mode: '항상 실제 계산', how: '결정적 규칙 엔진 — 데모 모드에서도 진짜로 동작' },
  { feature: 'VOC 대시보드', mode: '항상 실제 계산', how: '내장 10건 + 직접 분석한 통화를 브라우저에 누적 집계 (서버 미전송)' },
  { feature: 'LLM 분석·QA 정성 평가·RAG 답변', mode: '라이브', how: 'Claude Opus 5 → 실패·예산 소진 시 오픈소스 LLM(Llama 3.3 70B) → 규칙 데모로 이어지는 3단 사다리 (현재 엔진은 위 배지 참고)' },
  { feature: '실시간 상담 지원 (Agent Assist)', mode: '라이브', how: 'RAG 근거 검색 + LLM 응대 제안 — 신규 기능 제안·구현' },
  { feature: '화자 분리 (상담사/고객 태깅)', mode: '라이브', how: 'LLM 재구성 + 원문 보존 게이트(CER 15% 초과 시 원문 유지)' },
  { feature: 'VOC AI 인사이트 리포트', mode: '라이브', how: '집계 수치 + 에스컬레이션 통화 제목(마스킹 후, 최대 6건) 전송 → LLM 리포트 + 숫자 환각 검증(허용 집합 대조)' },
  { feature: '일괄 통화 분석', mode: '라이브', how: '통화 최대 5건을 LLM 호출 1회로 묶어 구조화 (결과 개수·순서 검증)' },
]

export default function AboutPage() {
  // 실시간 인프라 상태 — /api/cc/health가 바인딩·키 상태를 반환한다
  const [health, setHealth] = useState(null)
  // 실측 운영 지표 — /api/cc/stats가 D1 텔레메트리 집계를 반환한다
  const [stats, setStats] = useState(null)
  useEffect(() => {
    // 두 요청은 D1 집계라 수 초가 걸릴 수 있다. 응답 전에 다른 화면으로 이동하면
    // 언마운트된 컴포넌트에 setState가 실행되므로, cleanup에서 요청을 취소한다.
    // (abort는 fetch를 reject시키므로 아래 catch가 그대로 삼킨다)
    const ac = new AbortController()
    fetch('/api/cc/health', { signal: ac.signal })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {})
    fetch('/api/cc/stats', { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) setStats({ summary: summarizeStats(d.rows), since: d.since })
      })
      .catch(() => {})
    return () => ac.abort()
  }, [])

  return (
    <div className="tool-page about-page">
      <header className="tool-header">
        <span className="tool-tag">평가자용 제작기</span>
        <h1>담당업무를 그대로 구현한 포트폴리오입니다</h1>
        <p>
          콜센터 AX(AI Transformation)를 주제로 만든 포트폴리오입니다. 현장 담당업무의
          다섯 줄 — STT, 분류·요약, VOC·의도 분석, Auto QA, RAG — 를 각각 동작하는 화면으로
          만들었고, 아래 표에서 1:1로 대응을 확인할 수 있습니다.
        </p>
      </header>

      <section className="about-section">
        <h2>1. 담당업무 ↔ 구현 기능</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>담당업무</th>
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
        <h2>2. 요건별 증명 (신입 기준)</h2>
        <div className="req-table-wrap">
          <table className="req-table">
            <thead>
              <tr>
                <th>요건</th>
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
              <span>화면 8종 · CER 계산 · Turnstile 토큰 · 규칙 스캐너 공유</span>
            </div>
            <span className="arch-arrow">→</span>
            <div className="arch-box arch-core">
              <strong>Cloudflare Pages Functions</strong>
              <span>/api/cc/stt·diarize·analyze(+batch)·qa·search·assist·voc-report·stats·health — 검증·폴백·레이트리밋의 관문</span>
            </div>
            <span className="arch-arrow">→</span>
            <div className="arch-box">
              <strong>Workers AI (오픈소스 모델)</strong>
              <span>Whisper large-v3-turbo·whisper (STT) · bge-m3 (임베딩) · Llama 3.3 70B (LLM 폴백)</span>
            </div>
          </div>
          <div className="arch-row">
            <div className="arch-box">
              <strong>Claude Opus 5</strong>
              <span>tool 강제 호출 → 구조화 JSON → ensureContract 계약 검증</span>
            </div>
            <div className="arch-box">
              <strong>Cloudflare D1 · Vectorize</strong>
              <span>레이트리밋(IP 해시 카운터, 날짜별 회전) · 텔레메트리(입력·IP 미저장) · RAG 사전 인덱스</span>
            </div>
            <div className="arch-box">
              <strong>안전장치</strong>
              <span>데모 폴백 · 일일 예산 캡 · 타임아웃+재시도 · 우아한 강등</span>
            </div>
          </div>
          <p className="arch-notes">
            업로드 음성은 전사 후 즉시 폐기합니다. 텔레메트리에는 입력 내용·IP를 저장하지
            않고, 레이트리밋도 IP 원문 대신 날짜별로 회전하는 해시만 최대 24시간 보관합니다.
            모든 샘플 통화·기업명("한빛텔레콤")은 가상 창작물입니다.
          </p>
        </div>
      </section>

      <section className="about-section">
        <h2>4. 무엇이 라이브이고 무엇이 데모인가 (정직한 구분)</h2>
        {health && (
          <div className="chip-row" aria-label="실시간 인프라 상태">
            <span className={`cat-badge ${health.workers_ai ? 'cat-praise' : 'cat-quality'}`}>
              {health.workers_ai ? '● Workers AI 정상' : '○ Workers AI 미연결'}
            </span>
            <span className={`cat-badge ${health.d1 ? 'cat-praise' : 'cat-quality'}`}>
              {health.d1 ? '● D1 정상' : '○ D1 미연결'}
            </span>
            <span className="cat-badge cat-ship">현재 LLM 엔진: {health.llm_engine}</span>
            <span className="usage-note">지금 이 순간의 실제 상태 (/api/cc/health)</span>
          </div>
        )}

        {/* 바인딩이 있다는 것과 기능이 실제로 동작한다는 것은 다르다.
            예산이 소진되면 엔진 배지는 여전히 "claude-opus-5"인데 응답은 데모로 나간다.
            시스템이 그 차이를 스스로 판정해 말하도록 자가 점검 결과를 그대로 싣는다. */}
        {health?.capabilities && (
          <div className="capability-list">
            <p className="about-note">
              자가 점검 — 이 시스템이 지금 자기가 무엇을 할 수 있다고 판단하는지입니다.
              ● 실제 동작 · ◐ 대체 경로로 동작 · ○ 동작하지 않음
            </p>
            <ul className="plain-list">
              {health.capabilities.map((c) => (
                <li key={c.id} className={`capability capability-${c.state}`}>
                  <strong>
                    {{ ready: '●', degraded: '◐', off: '○' }[c.state]} {c.label}
                  </strong>
                  <span className="capability-detail">{c.detail}</span>
                </li>
              ))}
            </ul>
            {health.budget?.shared_daily_left != null && (
              <p className="result-empty-sub">
                오늘 남은 예산 — 유료 AI $
                {health.budget.claude_budget_left_usd?.toFixed(2) ?? '—'}/$
                {health.budget.claude_budget_limit_usd} · 공유 호출{' '}
                {health.budget.shared_daily_left}/{health.budget.shared_daily_cap}회
              </p>
            )}
          </div>
        )}
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

      {stats && stats.summary.total > 0 && (
        <section className="about-section">
          <h2>5. 실측 운영 지표 — 이 사이트가 실제로 호출된 기록</h2>
          <p className="about-note">
            D1 텔레메트리(ai_calls)의 실시간 집계입니다. 입력 내용·IP는 저장하지 않으므로
            집계에도 존재하지 않습니다{stats.since ? ` · 수집 시작 ${stats.since.slice(0, 10)} (UTC)` : ''}.
          </p>
          <div className="chip-row" aria-label="운영 지표 요약">
            {/* 서버가 "누적이라고 말해도 되는가"를 cumulative로 함께 보낸다. 원시 로그는
                보존 기간이 지나면 지워지므로, 누적 카운터 표가 없는 경로에서는 이 숫자가
                최근 구간의 합계일 뿐이다. 그 플래그를 버리고 늘 "누적"이라 적으면
                서버가 굳이 남긴 근거를 화면이 무시하는 셈이 된다. */}
            <span className="cat-badge cat-ship">
              {stats.cumulative ? '누적' : `최근 ${stats.raw_retention_days ?? ''}일`} AI 호출 {stats.summary.total}회
            </span>
            <span className="cat-badge cat-praise">라이브 호출 비율 {stats.summary.liveRatio}%</span>
            {stats.summary.claudeCalls > 0 && (
              <span className="cat-badge cat-refund">Claude Opus 5 경유 {stats.summary.claudeCalls}회</span>
            )}
            {stats.summary.ossCalls > 0 && (
              <span className="cat-badge cat-etc">오픈소스 모델 경유 {stats.summary.ossCalls}회</span>
            )}
            {stats.summary.fallbackCalls > 0 && (
              <span className="cat-badge cat-quality" title="AI 실패 시 데모로 우아하게 강등된 횟수 — 실패를 숨기지 않고 공개합니다">
                폴백 발동 {stats.summary.fallbackCalls}회
              </span>
            )}
            {stats.summary.guardedCalls > 0 && (
              <span className="cat-badge cat-quality" title="원문 보존 게이트가 LLM 변형을 차단한 횟수">
                보존 게이트 차단 {stats.summary.guardedCalls}회
              </span>
            )}
            <span className="usage-note">지금 이 순간의 실제 수치 (/api/cc/stats)</span>
          </div>

          {/* 폴백을 한 덩어리로 세면 "몇 번 실패했다"까지만 알 수 있다. 고칠 수 있는 실패
              (우리 상한이 작았다)와 고칠 수 없는 실패(공급자 거절)를 구분해야 다음에
              무엇을 할지가 정해진다. 시스템이 자기 실패를 분류해 말하는 자리다. */}
          {stats.summary.failures?.length > 0 && (
            <div className="failure-breakdown">
              <p className="about-note">
                폴백 사유 분해 — 실패를 숨기지 않는 것에서 한 걸음 더, 왜 실패했는지까지 남깁니다.
                {stats.summary.classifiedFailures === 0 &&
                  ' (아래 "기타 실패"는 사유 기록을 넣기 전의 기록입니다)'}
              </p>
              <div className="chip-row">
                {stats.summary.failures.map((f) => (
                  <span
                    key={f.mode}
                    className={`cat-badge ${f.classified ? 'cat-quality' : 'cat-etc'}`}
                    title={f.classified ? `텔레메트리 mode=${f.mode}` : '사유가 기록되지 않은 옛 실패'}
                  >
                    {f.label} {f.calls}회
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="req-table-wrap">
            <table className="req-table">
              <thead>
                <tr>
                  <th>기능</th>
                  <th>누적 호출</th>
                  <th>라이브 호출</th>
                  <th>평균 지연</th>
                </tr>
              </thead>
              <tbody>
                {stats.summary.endpoints.map((e) => (
                  <tr key={e.endpoint}>
                    <td>{e.label}</td>
                    <td className="req-name">{e.calls}회</td>
                    <td>{e.liveCalls}회</td>
                    <td className="req-basis">
                      {e.avgLatencyMs != null ? `${(e.avgLatencyMs / 1000).toFixed(1)}초` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="about-section">
        <h2>{stats && stats.summary.total > 0 ? '6' : '5'}. 제작기 — AI 코딩 에이전트와 이틀간</h2>
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
            <strong>④ 첫날 배포</strong>
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
