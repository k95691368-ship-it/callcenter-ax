-- 캐시 토큰 기록 — 비용 상한이 실제 지출을 보게 하기 위해서다.
--
-- Anthropic은 캐시 읽기·생성 토큰을 input_tokens에 포함하지 않고 따로 보고하며,
-- 단가도 다르다(읽기는 입력의 10%, 생성은 125%). 이 프로젝트는 프롬프트 캐싱을 쓰므로
-- 입력의 상당 부분이 캐시 읽기로 잡히는데, 그것을 기록하지 않아 예산 계산이
-- 실제 지출보다 적게 나왔다. 비용 가드에서 과소 계산은 가장 위험한 방향이다.
--
-- 적용 전에도 기록은 계속된다 — telemetry.js가 이 컬럼 없이 다시 시도한다.
ALTER TABLE ai_calls ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE ai_calls ADD COLUMN cache_write_tokens INTEGER;
