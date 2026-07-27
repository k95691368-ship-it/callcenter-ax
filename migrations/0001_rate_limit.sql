CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket ON rate_limit_hits (bucket, created_at);
