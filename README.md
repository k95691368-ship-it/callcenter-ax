# 콜센터 AX 워크벤치

**라이브 데모: https://callcenter-ax.pages.dev** · 원클릭 시연: [/pipeline](https://callcenter-ax.pages.dev/pipeline)

콜센터 녹취·CTI 솔루션 기업 ㈜포오스의 **"인공지능 융합" 파트(신입)** 지원용 취업 포트폴리오.
채용공고의 담당업무 — *"STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스: 콜센터 녹취·STT
데이터 기반 분류, 요약, 검색, VOC·의도 분석 및 상담 품질 평가 자동화(Auto QA)"* — 를
동작하는 파이프라인 그대로 구현했다.

## 원클릭 파이프라인

[/pipeline](https://callcenter-ax.pages.dev/pipeline)에서 버튼 하나로 실제 프로덕션 API
6단계가 연속 실행된다 (시연용 가짜 경로 없음):

```
내장 음성 → ① Whisper STT → ② 도메인 용어 보정(튜닝 1단계) → ③ 화자 분리(NLP)
         → ④ LLM 통화 분석 → ⑤ Auto QA 점수표 → ⑥ VOC 대시보드 누적
```

**🎙 내 목소리로 실행**: 그 자리에서 마이크로 녹음하면 같은 6단계를 내 목소리가 통과한다
(녹음 미리듣기 제공, 서버 미보관).

## 데모 구성 — 전 기능 라이브

| 화면 | 공고 담당업무 | 동작 방식 |
|---|---|---|
| [/stt](https://callcenter-ax.pages.dev/stt) | 오픈소스 STT 적용·**성능 평가·도메인 튜닝** | **Whisper large-v3-turbo** 전사(마이크 녹음·파일·내장 샘플) + **CER 측정** + **2종 모델 비교** + 도메인 용어 보정(전/후 CER 개선 표시) + LLM 화자 분리 |
| [/analyze](https://callcenter-ax.pages.dev/analyze) | 분류·요약·**의도 분석** | 유형/3줄 요약/감정/의도/조치 구조화 분석 + **에스컬레이션 판단**(법적·강성 건은 사람에게) |
| [/qa](https://callcenter-ax.pages.dev/qa) | **Auto QA** | 필수 멘트 체크(40점)·금지 표현 감점(규칙, 항상 실동작) + LLM 정성 평가(60점) 이중 구조 + **콜센터별 커스텀 체크리스트**(40점 균등 재배분) |
| [/voc](https://callcenter-ax.pages.dev/voc) | **VOC 분석** | 내장 10건 + 직접 분석 건 실시간 누적 집계(SVG 차트) + **AI 인사이트 리포트**(집계 수치만 전송) |
| [/search](https://callcenter-ax.pages.dev/search) | **RAG 검색** | **하이브리드 검색**(bge-m3 벡터 + 키워드 랭킹 **RRF 융합**) → 근거 문단 강제 답변+인용. **내 문서 붙여넣기 실시간 인덱싱** |
| [/about](https://callcenter-ax.pages.dev/about) | — | 공고 ↔ 구현 매핑표 · 구조도 · 라이브/데모 정직 구분표 · **실측 운영 지표**(D1 텔레메트리 집계: 호출 수·라이브 비율·평균 지연) |

실측 예시: 테스트 음성(26자)을 turbo가 2.1초에 전사(CER 2.6%), base whisper는
"한빛텔레콤"→"한 밑에 내 콤"으로 붕괴 → 도메인 보정 적용 시 CER 0% — 모델 성능 평가와
도메인 튜닝의 필요성을 한 화면에서 정량으로 보여준다.

## AI 엔진 — 3단 폴백 사다리

```
1순위  Claude Opus 5 (claude-opus-5) — CLAUDE_API_KEY 등록 시, tool 강제 호출
2순위  오픈소스 Llama 3.3 70B (Workers AI) — 키 없이 즉시 라이브 (현재 동작)
3순위  규칙 기반 데모 — 모든 AI 실패 시에도 흐름 유지
```

STT(Whisper)·임베딩(bge-m3)·LLM(Llama)까지 **오픈소스 전 스택**으로 대응하고, 어떤 엔진이
답했는지 결과에 배지로 표시한다.

## 시스템 구조

```
브라우저 (React 19 + Vite, 토스 디자인 언어)
   │  CER·도메인 보정·QA 규칙 스캐너(서버와 공유) · Turnstile 토큰
   ▼
Cloudflare Pages Functions  /api/cc/{stt, diarize, analyze, qa, search, voc-report, health}
   ├─ Workers AI  : Whisper ×2 (STT) · bge-m3 (임베딩) · Llama 3.3 70B (LLM 폴백)
   ├─ Claude Opus 5 : tool 강제 호출 → ensureContract 응답 계약 검증
   └─ D1 : 레이트리밋 버킷 · AI 호출 텔레메트리 (개인정보 미저장)
```

안전장치: 데모 폴백 / IP·전체·일일 예산 3중 레이트리밋 / Turnstile(무설정 시 fail-open) /
40초 타임아웃 + 1회 재시도 + 우아한 강등 / 응답 계약 검증 / 토큰·비용 실측 표시 / 텔레메트리.

## 데이터 원칙

- 모든 통화·상담사·기업명("한빛텔레콤")은 **가상 창작물** — 실제 통화 데이터·실존 기업 미사용
- 업로드 음성은 전사 후 즉시 폐기, 개인정보 미수집, 텔레메트리에 입력 내용·IP 미저장
- RAG에 붙여넣은 내 문서·VOC 리포트용 집계는 서버에 저장하지 않음

## 실행법

```bash
npm install
npm run dev        # 프론트만 (API는 데모 폴백)
npm run dev:full   # 빌드 + wrangler pages dev (Functions 포함)
npm test           # vitest 75개 (QA 점수·커스텀 규칙·CER·도메인 보정·RRF 융합·계약 검증·JSON 파서·운영 지표)
npm run lint       # oxlint
git push           # Cloudflare Pages Git 연동 자동 빌드·배포 (wrangler.toml 바인딩 자동 적용)
```

라이브 LLM을 Claude Opus 5로 상향(선택):
`npx wrangler pages secret put CLAUDE_API_KEY --project-name callcenter-ax`

## 문서

- [기획안.md](기획안.md) — 회사·공고 분석 → 기능 매핑 → 기술 선택 이유
- [개선기획안.md](개선기획안.md) — 이틀간의 배포 후 개선 사이클 15회 기록
- [docs/기능정리.md](docs/기능정리.md) — 전체 구현 기능 상세 설명
- [docs/녹음스크립트.md](docs/녹음스크립트.md) — 내 목소리로 STT 시연용 대본 5종
