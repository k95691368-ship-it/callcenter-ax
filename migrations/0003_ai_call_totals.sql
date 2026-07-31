-- AI 호출 누적 카운터 — ai_calls 원본을 보관 기간(30일) 뒤에 지워도 About 화면의
-- "누적 AI 호출 수"와 "수집 시작 시각"이 줄어들지 않게, (endpoint, mode)별 합계를 남긴다.
-- 원본을 지우는 이유: 정리 로직이 없어 무한히 쌓였고 집계가 매번 전체를 스캔했다.
--
-- 여기에도 입력 내용·IP는 없다 (호출 수·지연 합·시각뿐). 이 표는 삭제된 원본의 몫만
-- 담고, 아직 남아 있는 원본은 stats 조회 시 합산되므로 어느 시점에도 중복·누락이 없다.
-- 빈 표로 시작하는 것이 곧 정확한 상태이므로 backfill은 필요하지 않다.
CREATE TABLE IF NOT EXISTS ai_call_totals (
  endpoint TEXT NOT NULL,
  mode TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  -- 평균이 아니라 합·건수로 보관한다. 남은 원본과 합칠 때 가중 평균을 정확히 복원하기 위함
  -- (평균의 평균은 틀린다). latency_calls는 latency_ms가 실제로 있던 호출 수.
  latency_sum INTEGER NOT NULL DEFAULT 0,
  latency_calls INTEGER NOT NULL DEFAULT 0,
  -- first_at: 접어 넣은 가장 오래된 호출 시각 ("수집 시작"의 근거)
  -- last_at: 접어 넣은 가장 최근 호출 시각 (여기까지는 카운터가 이미 세었다는 경계)
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, mode)
);
