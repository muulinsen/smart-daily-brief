-- V2.2 source onboarding, independent profiler model profiles and observation.
ALTER TABLE sources ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE sources ADD COLUMN rule_profile TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sources ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN trust_score REAL;
ALTER TABLE sources ADD COLUMN observation_until TEXT;
ALTER TABLE sources ADD COLUMN recovered_at TEXT;
ALTER TABLE sources ADD COLUMN timeout_ms INTEGER NOT NULL DEFAULT 20000;
ALTER TABLE sources ADD COLUMN max_response_bytes INTEGER NOT NULL DEFAULT 5242880;

UPDATE sources SET onboarding_status = CASE WHEN enabled = 1 THEN 'ACTIVE' ELSE 'DISABLED' END
WHERE onboarding_status = 'ACTIVE';

CREATE TABLE ai_model_profiles (
  id INTEGER PRIMARY KEY,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT,
  model_id TEXT NOT NULL,
  credential_secret_ref TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  fallback_profile TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  last_tested_at TEXT,
  last_test_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (purpose, config_version)
) STRICT;

CREATE TABLE source_onboarding_proposals (
  id INTEGER PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  source_name TEXT NOT NULL,
  parser TEXT NOT NULL,
  sample_json TEXT NOT NULL DEFAULT '[]',
  source_profile_json TEXT,
  evidence_sample_ids TEXT NOT NULL DEFAULT '[]',
  rule_diff_json TEXT,
  dry_run_json TEXT,
  capability_gap_json TEXT,
  model_profile_id INTEGER REFERENCES ai_model_profiles(id),
  model_config_version INTEGER,
  prompt_schema_version TEXT NOT NULL DEFAULT 'source-profiler-v1',
  request_id TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  reviewer TEXT,
  reviewed_at TEXT,
  approved_version INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_onboarding_status ON sources(onboarding_status, enabled);
CREATE INDEX idx_onboarding_proposals_status ON source_onboarding_proposals(status, created_at DESC);
CREATE TABLE source_observation_metrics (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  window_key TEXT NOT NULL,
  fetched INTEGER NOT NULL DEFAULT 0,
  parsed INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  filtered INTEGER NOT NULL DEFAULT 0,
  late INTEGER NOT NULL DEFAULT 0,
  anomaly TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, window_key)
) STRICT;
