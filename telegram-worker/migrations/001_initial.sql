CREATE TABLE IF NOT EXISTS telegram_schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS telegram_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  schedule_json TEXT NOT NULL DEFAULT '["08:00","12:00","22:00"]',
  provider TEXT NOT NULL DEFAULT 'openai_compatible',
  model TEXT NOT NULL DEFAULT '',
  base_url TEXT,
  credential_ref TEXT NOT NULL DEFAULT 'OPENAI_COMPAT_API_KEY',
  prompt_rules TEXT NOT NULL DEFAULT '',
  prompt_version INTEGER NOT NULL DEFAULT 1,
  raw_retention_days INTEGER NOT NULL DEFAULT 6,
  summary_retention_days INTEGER NOT NULL DEFAULT 30,
  url_retention_days INTEGER NOT NULL DEFAULT 30,
  all_rss_token TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO telegram_settings(singleton, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE IF NOT EXISTS telegram_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  display_name TEXT,
  source_type TEXT NOT NULL CHECK(source_type IN ('normal','url')),
  chat_id INTEGER UNIQUE,
  title TEXT,
  username TEXT,
  telegram_kind TEXT CHECK(telegram_kind IS NULL OR telegram_kind IN ('channel','group')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','error','disabled')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  rss_token TEXT UNIQUE,
  last_error TEXT,
  validation_requested_at TEXT NOT NULL,
  validated_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_telegram_sources_work
  ON telegram_sources(status, enabled, validation_requested_at);

CREATE TABLE IF NOT EXISTS telegram_messages (
  source_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  text TEXT NOT NULL,
  edited_at TEXT,
  reply_to_id INTEGER,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(chat_id,message_id),
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_telegram_messages_window
  ON telegram_messages(source_id,sent_at,message_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS telegram_message_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  edited_at TEXT,
  collected_at TEXT NOT NULL,
  UNIQUE(chat_id,message_id,content_hash),
  FOREIGN KEY(chat_id,message_id) REFERENCES telegram_messages(chat_id,message_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS telegram_sync_state (
  source_id INTEGER PRIMARY KEY,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  last_error TEXT,
  last_window_end TEXT,
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
) STRICT;

-- URL 渠道只持久化规范化 URL 与来源级时间；不得加入消息标识或正文。
CREATE TABLE IF NOT EXISTS telegram_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_url TEXT NOT NULL UNIQUE,
  first_source_id INTEGER NOT NULL,
  last_source_id INTEGER NOT NULL,
  first_discovered_at TEXT NOT NULL,
  last_discovered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(first_source_id) REFERENCES telegram_sources(id),
  FOREIGN KEY(last_source_id) REFERENCES telegram_sources(id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_telegram_urls_expiry ON telegram_urls(expires_at);

CREATE TABLE IF NOT EXISTS telegram_summary_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id,window_start,window_end),
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_telegram_summary_due
  ON telegram_summary_jobs(status,next_attempt_at);

CREATE TABLE IF NOT EXISTS telegram_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE,
  source_id INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  title TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  rendered_html TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES telegram_summary_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES telegram_sources(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_telegram_summaries_feed
  ON telegram_summaries(source_id,window_end DESC);

CREATE TABLE IF NOT EXISTS telegram_summary_cache (
  request_hash TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS telegram_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS telegram_worker_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  authorized INTEGER NOT NULL DEFAULT 0,
  login_state TEXT NOT NULL DEFAULT 'idle' CHECK(login_state IN ('idle','code_required','password_required','authorized','error')),
  account_hint TEXT,
  last_error TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO telegram_worker_state(singleton,updated_at)
VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
