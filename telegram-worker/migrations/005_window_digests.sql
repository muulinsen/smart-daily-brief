-- 跨频道汇总：同一关闭时刻的各频道总结完成后，由 AI 合并为一条，每条要点标注来源频道。
CREATE TABLE telegram_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('completed','failed')),
  source_ids TEXT NOT NULL DEFAULT '[]',
  input_hash TEXT NOT NULL DEFAULT '',
  summary_json TEXT,
  rendered_html TEXT,
  fallback INTEGER NOT NULL DEFAULT 0 CHECK(fallback IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  next_attempt_at TEXT,
  response_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX idx_telegram_digests_feed ON telegram_digests(status, window_end);
