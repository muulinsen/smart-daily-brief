-- 语义去重 + AI 分层判断（docs/semantic-dedup-design.md）
-- 只追加、可重复执行。缓存表可随时清空重建；运行状态表只服务于新版日报的推迟发布。

-- AI 结果缓存：结构化摘要、各类判定、灰区确认。
-- input_sha256 = 实际送模型的规范化输入的哈希；config_id = 供应商/端点/模型/提示词版本的哈希。
CREATE TABLE IF NOT EXISTS ai_item_notes (
  input_sha256 TEXT NOT NULL,
  task         TEXT NOT NULL,
  config_id    TEXT NOT NULL,
  tier         TEXT NOT NULL CHECK (tier IN ('L1','L2')),
  result_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (input_sha256, task, config_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_ai_item_notes_time ON ai_item_notes(created_at);

-- 向量缓存。req_dims：请求的维度，0 = 自动；actual_dims：实际返回的维度。
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_sha256  TEXT NOT NULL,
  config_id    TEXT NOT NULL,
  req_dims     INTEGER NOT NULL CHECK (req_dims >= 0),
  actual_dims  INTEGER NOT NULL CHECK (actual_dims > 0),
  vector       BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  CHECK (length(vector) = actual_dims * 4),
  PRIMARY KEY (text_sha256, config_id, req_dims)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_embedding_cache_time ON embedding_cache(created_at);

-- 每期 AI 请求预算：定时运行的多次尝试共用一份，每次手动重跑另开一份（scope 区分）。
CREATE TABLE IF NOT EXISTS run_ai_budget (
  run_id  INTEGER NOT NULL REFERENCES runs(id),
  scope   TEXT NOT NULL,
  used    INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (run_id, scope)
) STRICT;

-- 每次构建尝试（定时 / 手动）及结果，用于截止时间计算与后台展示。
CREATE TABLE IF NOT EXISTS run_attempts (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  trigger     TEXT NOT NULL CHECK (trigger IN ('timer','manual')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT,
  unresolved  INTEGER,
  error_kind  TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_run_attempts_run ON run_attempts(run_id, started_at);

-- 推迟发布状态（后台读取）：截止时间、下次重试时间、未判定数量、模型拒绝处理而排除的条目。
CREATE TABLE IF NOT EXISTS run_retry_state (
  run_id          INTEGER PRIMARY KEY REFERENCES runs(id),
  deadline_at     TEXT,
  next_attempt_at TEXT,
  unresolved      INTEGER NOT NULL DEFAULT 0,
  last_error_kind TEXT,
  refused_json    TEXT NOT NULL DEFAULT '[]',
  updated_at      TEXT NOT NULL
) STRICT;

-- 运行租约：同一期同一时刻只允许一个构建/发布尝试。
CREATE TABLE IF NOT EXISTS run_leases (
  run_id     INTEGER PRIMARY KEY REFERENCES runs(id),
  owner      TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
