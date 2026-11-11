-- 全局模型供应商（docs/model-providers-design.md 第 3 版定稿）。只追加。
-- 开关关着（默认）时所有使用方走旧配置，这些表不被读取；导入成功时在同一事务里打开。

CREATE TABLE IF NOT EXISTS model_config_state (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision   INTEGER NOT NULL DEFAULT 0,
  enabled_at TEXT
) STRICT;
INSERT OR IGNORE INTO model_config_state(singleton) VALUES (1);

-- 完整 Base URL 与密钥都用 APP_ENCRYPTION_KEY 做 AES-256-GCM 加密，附加认证数据含供应商 ID（密文不能挪到别的行）。
-- 明文只存主机名（显示、审计用）。
CREATE TABLE IF NOT EXISTS model_providers (
  id             TEXT PRIMARY KEY CHECK (length(id) = 10 AND substr(id, 1, 2) = 'p_' AND substr(id, 3) NOT GLOB '*[^a-z0-9]*'),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  type           TEXT NOT NULL CHECK (type IN ('openai_compatible','openai','deepseek','qwen','anthropic','gemini')),
  base_host      TEXT NOT NULL DEFAULT '',
  url_ct TEXT, url_iv TEXT, url_tag TEXT,
  key_ct TEXT, key_iv TEXT, key_tag TEXT,
  key_hint       TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  models_json        TEXT NOT NULL DEFAULT '[]',
  models_for         INTEGER,
  models_truncated   INTEGER NOT NULL DEFAULT 0,
  manual_models_json TEXT NOT NULL DEFAULT '[]',
  models_fetched_at  TEXT,
  models_error_json  TEXT,
  models_next_allowed_at  TEXT,
  models_next_allowed_for INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS model_assignments (
  consumer    TEXT PRIMARY KEY CHECK (consumer IN ('l1','l2','l3','telegramSummary','telegramVision','sourceProfiler','embedding')),
  provider_id TEXT REFERENCES model_providers(id) ON DELETE RESTRICT,
  model       TEXT,
  strictness  TEXT CHECK (strictness IN ('strict','json','none')),
  follow      TEXT CHECK (follow IN ('l1','l2')),
  disabled    INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  CHECK ((provider_id IS NOT NULL AND model IS NOT NULL AND follow IS NULL AND disabled = 0)
      OR (provider_id IS NULL AND model IS NULL AND strictness IS NULL AND follow IS NOT NULL AND disabled = 0)
      OR (provider_id IS NULL AND model IS NULL AND strictness IS NULL AND follow IS NULL AND disabled = 1))
) STRICT;
