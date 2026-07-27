# 콜센터 AX 워크벤치

**라이브 데모: https://callcenter-ax.pages.dev**

콜센터 녹취·CTI 솔루션 기업 ㈜포오스의 **"인공지능 융합" 파트(신입)** 지원용 취업 포트폴리오.
채용공고의 담당업무 — *"STT, LLM, NLP, RAG 기술을 활용한 콜센터 AI 서비스: 콜센터 녹취·STT
데이터 기반 분류, 요약, 검색, VOC·의도 분석 및 상담 품질 평가 자동화(Auto QA)"* — 를
동작하는 파이프라인 그대로 구현했다.

## 데모 구성

| 화면 | 공고 담당업무 | 동작 방식 | 상태 |
|---|---|---|---|
| [/stt](https://callcenter-ax.pages.dev/stt) | 오픈소스 STT 적용·성능 평가 | Workers AI **Whisper large-v3-turbo** 전사 + **CER(문자 오류율)** 측정기 | **라이브** (키 불필요) |
| [/analyze](https://callcenter-ax.pages.dev/analyze) | 분류·요약·의도 분석 | Claude Opus 4.8 tool 강제 호출 → 유형/3줄 요약/감정/의도/조치/에스컬레이션 | 키 등록 시 라이브, 미등록 시 규칙 기반 데모 |
| [/qa](https://callcenter-ax.pages.dev/qa) | Auto QA | 필수 멘트 체크(40점) + 금지 표현 감점(규칙, **항상 실동작**) + LLM 정성 평가(60점) | 규칙 층 라이브 / LLM 층 키 필요 |
| [/voc](https://callcenter-ax.pages.dev/voc) | VOC 분석 | 가상 통화 10건 집계 대시보드 (유형·감정·일별 SVG 차트) | 내장 샘플 |
| [/search](https://callcenter-ax.pages.dev/search) | RAG 검색 | **bge-m3 임베딩** → 코사인 유사도 → 근거 문단 강제 답변 + 인용 표시 | 검색 라이브 / 답변 생성 키 필요 |
| [/about](https://callcenter-ax.pages.dev/about) | — | 공고 ↔ 구현 매핑표, 구조도, 라이브/데모 정직 구분표, 제작기 | — |

실측 예시: Windows 음성합성으로 만든 테스트 음성(26자)을 Whisper가 2.1초에 전사, CER 2.6%
(1글자 오차)로 측정됨.

## 시스템 구조

```
브라우저 (React 19 + Vite)
   │  CER 계산 · QA 규칙 스캐너(서버와 공유) · Turnstile 토큰
   ▼
Cloudflare Pages Functions  /api/cc/{stt, analyze, qa, search}
   ├─ Workers AI  : Whisper large-v3-turbo (STT) · bge-m3 (임베딩)
   ├─ Claude Opus 4.8 : tool 강제 호출 → ensureContract 응답 계약 검증
   └─ D1 : 레이트리밋 버킷 · AI 호출 텔레메트리 (개인정보 미저장)
```

안전장치(전작 ax-workbench에서 상속): 데모 폴백 / IP·전체·일일 예산 3중 레이트리밋 /
Turnstile(무설정 시 fail-open) / 40초 타임아웃 + 1회 재시도 + 우아한 강등 / 응답 계약 검증 /
토큰·비용 실측 표시 / 텔레메트리.

## 데이터 원칙

- 모든 통화·상담사·기업명("한빛텔레콤")은 **가상 창작물** — 실제 통화 데이터·실존 기업 미사용
- 업로드 음성은 전사 후 즉시 폐기, 개인정보 미수집, 텔레메트리에 입력 내용·IP 미저장

## 실행법

```bash
npm install
npm run dev        # 프론트만 (API는 데모 폴백)
npm run dev:full   # 빌드 + wrangler pages dev (Functions 포함)
npm test           # vitest 46개 (QA 점수·CER·검색 랭킹·계약 검증·레이트리밋)
npm run lint       # oxlint
npx wrangler pages deploy   # 배포 (wrangler.toml의 AI·D1 바인딩 자동 적용)
```

라이브 LLM 활성화(선택): `npx wrangler pages secret put CLAUDE_API_KEY --project-name callcenter-ax`

## 녹음 스크립트 (내 목소리로 STT 시연하기)

`docs/녹음스크립트.md`의 대본 5개 중 아무거나 휴대폰으로 녹음해 `/stt`에 올리면
전사 → CER 측정 → 통화 분석 → Auto QA까지 전체 파이프라인을 실제 음성으로 시연할 수 있다.
