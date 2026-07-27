-- AI 호출 텔레메트리: 엔드포인트별 호출 기록 (개인정보 미저장)
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  mode TEXT NOT NULL, -- live | demo | fallback
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  findings_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls (created_at);
