ALTER TABLE telegram_settings ADD COLUMN vision_enabled_at TEXT;
ALTER TABLE telegram_settings ADD COLUMN vision_provider TEXT NOT NULL DEFAULT 'openai_compatible';
ALTER TABLE telegram_settings ADD COLUMN vision_model TEXT NOT NULL DEFAULT 'gemini-3.8-flash-high';
ALTER TABLE telegram_settings ADD COLUMN vision_base_url TEXT;
ALTER TABLE telegram_settings ADD COLUMN vision_credential_ref TEXT NOT NULL DEFAULT 'OPENAI_API_KEY';
ALTER TABLE telegram_settings ADD COLUMN vision_daily_limit INTEGER NOT NULL DEFAULT 300 CHECK(vision_daily_limit > 0);
ALTER TABLE telegram_settings ADD COLUMN vision_paused INTEGER NOT NULL DEFAULT 0 CHECK(vision_paused IN (0,1));
ALTER TABLE telegram_settings ADD COLUMN vision_pause_reason TEXT;
ALTER TABLE telegram_settings ADD COLUMN vision_last_run_at TEXT;
ALTER TABLE telegram_settings ADD COLUMN vision_last_result TEXT;

-- Migration time is the feature boundary: reconciliation may recover messages sent
-- after this instant, but existing history is never submitted for vision analysis.
UPDATE telegram_settings
SET vision_enabled_at = coalesce(vision_enabled_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    vision_base_url = coalesce(vision_base_url, base_url),
    vision_credential_ref = credential_ref,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE singleton=1;

CREATE TABLE telegram_media_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  media_fingerprint TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_caption TEXT NOT NULL,
  telegram_size_bytes INTEGER,
  temp_path TEXT,
  temp_state TEXT NOT NULL DEFAULT 'absent'
    CHECK(temp_state IN ('absent','downloading','ready','deleted')),
  actual_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'downloading'
    CHECK(status IN ('downloading','pending','running','retry','completed','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_type TEXT,
  error_message TEXT,
  description TEXT,
  key_text TEXT,
  uncertainty TEXT,
  requested_model TEXT,
  response_model TEXT,
  response_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  first_requested_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(chat_id,message_id,media_fingerprint),
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE,
  FOREIGN KEY(chat_id,message_id) REFERENCES telegram_messages(chat_id,message_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_telegram_media_due
  ON telegram_media_tasks(status,next_attempt_at,created_at);
CREATE INDEX idx_telegram_media_message
  ON telegram_media_tasks(chat_id,message_id,created_at DESC);
CREATE INDEX idx_telegram_media_daily
  ON telegram_media_tasks(first_requested_at) WHERE first_requested_at IS NOT NULL;
