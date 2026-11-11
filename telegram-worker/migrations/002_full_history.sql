ALTER TABLE telegram_sources
  ADD COLUMN retain_all_history INTEGER NOT NULL DEFAULT 0 CHECK(retain_all_history IN (0,1));

CREATE TABLE telegram_history_backfills (
  source_id INTEGER PRIMARY KEY,
  next_offset_id INTEGER NOT NULL DEFAULT 0,
  messages_seen INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
) STRICT;

-- 只提供按频道名称归类的查询视图，不复制任何消息正文。
CREATE VIEW telegram_messages_by_channel AS
SELECT
  coalesce(s.display_name,s.title,s.reference) AS channel_name,
  s.title AS telegram_title,
  s.username,
  s.reference,
  m.*
FROM telegram_messages m
JOIN telegram_sources s ON s.id=m.source_id;
