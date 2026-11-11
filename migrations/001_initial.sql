-- ============================================================
-- 001 初始 schema（PRD 13.1 / 13.2，含实施方案 2.1 的 harvest_runs）
-- 全部使用 STRICT 表：SQLite 3.53 会强制列类型，尽早暴露写入错误。
--
-- 【时间存储约定】(PRD 5.4)
--   *_at        TEXT，ISO-8601 UTC，形如 2026-08-23T01:00:00.000Z
--   *_at_taipei TEXT，Asia/Taipei 本地表示，仅为人读与审计
--   *_raw       TEXT，来源给出的原始时间字符串，原样保存
-- ============================================================

-- ---------- 来源与健康 ----------
CREATE TABLE sources (
  id                TEXT PRIMARY KEY,          -- 与 sources.yaml 的 id 对应
  name              TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  category          TEXT NOT NULL,
  host_group        TEXT NOT NULL,
  harvest_tier      TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 5,
  mandatory_retention INTEGER NOT NULL DEFAULT 0,
  require_fulltext  INTEGER NOT NULL DEFAULT 0,
  config_json       TEXT NOT NULL,             -- 该源在 sources.yaml 里的完整配置快照
  source_version    INTEGER NOT NULL,          -- 对应 sources.yaml meta.source_version
  -- 健康状态（PRD 4.3 / FR-003）
  health            TEXT NOT NULL DEFAULT 'unknown',  -- healthy|degraded|failing|unknown
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at   TEXT,
  last_attempt_at   TEXT,
  last_http_code    INTEGER,
  last_error        TEXT,
  latest_item_at    TEXT,                      -- 最新条目的发布时间
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

-- 端点：sources.yaml 里 endpoints 的展开，保留回退优先级
CREATE TABLE source_endpoints (
  id          INTEGER PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL,
  url         TEXT NOT NULL,
  parser      TEXT NOT NULL,
  host_group  TEXT,                            -- 覆盖来源默认分组（如 t.me 兜底）
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- 条件 GET 缓存（PRD 4.4）
  etag        TEXT,
  last_modified TEXT,
  UNIQUE (source_id, priority)
) STRICT;

-- ---------- 采集与抓取 ----------
-- 采集周期（实施方案 2.1）：纯 I/O，不跑 AI、不发信
CREATE TABLE harvest_runs (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,                  -- running|succeeded|partial|failed
  tiers_json   TEXT NOT NULL,                  -- 本轮实际采集了哪些档位
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  sources_ok        INTEGER NOT NULL DEFAULT 0,
  new_items         INTEGER NOT NULL DEFAULT 0,
  new_versions      INTEGER NOT NULL DEFAULT 0,
  error        TEXT
) STRICT;

-- 简报运行（PRD 13.1 runs）
CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  window_key   TEXT NOT NULL UNIQUE,           -- YYYY-MM-DD:{morning|noon|evening}（PRD 7.5 幂等）
  window_label TEXT NOT NULL,
  window_start_at TEXT NOT NULL,               -- 左闭
  window_end_at   TEXT NOT NULL,               -- 右开
  scheduled_at TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  status       TEXT NOT NULL,                  -- PRD 12.2 状态机
  stage        TEXT,
  lock_token   TEXT,
  lock_expires_at TEXT,
  trigger      TEXT NOT NULL,                  -- timer|manual|recovery
  is_recovered INTEGER NOT NULL DEFAULT 0,     -- 补偿调度产生（PRD 5.3）
  send_enabled INTEGER NOT NULL DEFAULT 1,
  rule_version INTEGER,                        -- 当时生效的 rules.yaml 版本
  error        TEXT
) STRICT;

-- 单次端点抓取尝试。多端点回退下每次尝试都要留痕（实施方案 2.2）
CREATE TABLE fetch_attempts (
  id            INTEGER PRIMARY KEY,
  harvest_run_id INTEGER REFERENCES harvest_runs(id) ON DELETE CASCADE,
  run_id        INTEGER REFERENCES runs(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL REFERENCES sources(id),
  endpoint_id   INTEGER REFERENCES source_endpoints(id),
  endpoint_priority INTEGER NOT NULL,
  url           TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  latency_ms    INTEGER,
  -- 结果分类（PRD 18 章状态表 / FR-011）
  outcome       TEXT NOT NULL,                 -- ok|not_modified|fetch_failed|source_anomaly|parse_failed
  http_code     INTEGER,
  bytes         INTEGER,
  content_hash  TEXT,
  parsed_count  INTEGER,
  error_class   TEXT,                          -- timeout|tls|dns|http_4xx|http_5xx|empty|bad_xml
  error_message TEXT,
  is_fallback   INTEGER NOT NULL DEFAULT 0,    -- 非 priority 1 即为回退
  fallback_reason TEXT,
  CHECK (harvest_run_id IS NOT NULL OR run_id IS NOT NULL)
) STRICT;

-- 原始响应留存（PRD 13.1 / 13.3：压缩保留 30 天）
CREATE TABLE raw_snapshots (
  id              INTEGER PRIMARY KEY,
  fetch_attempt_id INTEGER NOT NULL REFERENCES fetch_attempts(id) ON DELETE CASCADE,
  source_id       TEXT NOT NULL REFERENCES sources(id),
  storage_path    TEXT NOT NULL,               -- /var/lib/briefing/snapshots/YYYY/MM/DD/<hash>.gz
  content_hash    TEXT NOT NULL,
  bytes_raw       INTEGER NOT NULL,
  bytes_stored    INTEGER NOT NULL,
  captured_at     TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  UNIQUE (content_hash, source_id)             -- 内容未变则不重复落盘
) STRICT;

-- ---------- 内容实体与版本 ----------
CREATE TABLE feed_items (
  id               INTEGER PRIMARY KEY,
  source_id        TEXT NOT NULL REFERENCES sources(id),
  source_item_key  TEXT NOT NULL,              -- topic id / tg msg id / guid / canonical url（PRD 7.1 优先级）
  key_kind         TEXT NOT NULL,              -- topic_id|tg_msg|x_status|guid|canonical_url|title_time|content_hash
  canonical_url    TEXT,
  origin_url       TEXT,                       -- 原始事件链接（PRD 7.2）
  discovery_url    TEXT,                       -- 发现渠道链接
  published_at     TEXT,                       -- UTC
  published_at_taipei TEXT,
  published_at_raw TEXT,
  timestamp_confidence TEXT NOT NULL DEFAULT 'exact',  -- exact|assumed|date_only|anomalous（PRD 5.4）
  first_seen_at    TEXT NOT NULL,              -- 首次发现时间（PRD 6.3 补录必须展示）
  first_seen_harvest_run_id INTEGER REFERENCES harvest_runs(id),
  origin_window_key TEXT,                      -- 按 published_at 归属的窗口
  last_seen_at     TEXT NOT NULL,
  current_version_id INTEGER,                  -- → item_versions.id（延迟设置，避免循环 FK）
  created_at       TEXT NOT NULL,
  UNIQUE (source_id, source_item_key)          -- PRD 7.5 幂等约束
) STRICT;

CREATE TABLE item_versions (
  id            INTEGER PRIMARY KEY,
  item_id       INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  content_hash  TEXT NOT NULL,                 -- 语义指纹（PRD 7.3，已剔除噪声）
  raw_hash      TEXT NOT NULL,                 -- 未清洗内容的哈希，用于诊断
  title         TEXT NOT NULL,
  clean_text    TEXT NOT NULL,
  html_excerpt  TEXT,
  is_excerpt    INTEGER NOT NULL DEFAULT 0,    -- 正文是否为 RSS 摘要（linux.do 实测 39/39 为 true）
  fulltext_fetched_at TEXT,                    -- 原帖全文抓取时间（规则 forum_fulltext）
  fulltext_status TEXT,                        -- ok|failed|skipped|not_needed
  signals_json  TEXT,                          -- 13 个确定性信号的抽取结果
  discovered_at TEXT NOT NULL,
  version_no    INTEGER NOT NULL,
  is_substantive_update INTEGER NOT NULL DEFAULT 0,
  update_signals_json TEXT,                    -- 命中的实质更新信号（PRD 7.3）
  UNIQUE (item_id, content_hash)               -- PRD 7.5 幂等约束
) STRICT;

-- ---------- 候选、判定、聚类（阶段 2 使用，先建表避免后续迁移churn） ----------
CREATE TABLE candidates (
  id              INTEGER PRIMARY KEY,
  run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  item_version_id INTEGER NOT NULL REFERENCES item_versions(id),
  origin_window_key TEXT NOT NULL,
  late_discovery  INTEGER NOT NULL DEFAULT 0,  -- 补录（PRD 6）
  late_reason     TEXT,
  prescreen_json  TEXT,                        -- A-D 预判结果
  decision        TEXT,                        -- retain|normal|filter|escalate
  mandatory_class TEXT,                        -- A|B|C|D|none
  section         TEXT,
  score           REAL,
  filter_rule_id  TEXT,                        -- DF-xxx（PRD 8.3 要求保存规则 ID）
  filter_reason   TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (run_id, item_version_id)
) STRICT;

CREATE TABLE evaluations (
  id            INTEGER PRIMARY KEY,
  candidate_id  INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,                 -- rule|luna|terra|sol|human
  model         TEXT,
  prompt_version TEXT,
  reasoning_effort TEXT,
  response_id   TEXT,                          -- PRD 15 要求可追溯
  input_tokens  INTEGER,
  output_tokens INTEGER,
  result_json   TEXT NOT NULL,
  escalation_reasons TEXT,
  confidence    REAL,
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE story_clusters (
  id                  INTEGER PRIMARY KEY,
  cluster_key         TEXT NOT NULL UNIQUE,
  canonical_title     TEXT NOT NULL,
  current_version_hash TEXT NOT NULL,
  best_origin_item_version_id INTEGER REFERENCES item_versions(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE cluster_members (
  id              INTEGER PRIMARY KEY,
  cluster_id      INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  item_version_id INTEGER NOT NULL REFERENCES item_versions(id),
  contribution    TEXT,
  added_by        TEXT NOT NULL DEFAULT 'model',  -- model|human（人工优先，FR-034）
  created_at      TEXT NOT NULL,
  UNIQUE (cluster_id, item_version_id)
) STRICT;

-- ---------- 简报与投递 ----------
CREATE TABLE briefs (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  subject      TEXT NOT NULL,
  text_body    TEXT NOT NULL,
  html_body    TEXT NOT NULL,
  html_bytes   INTEGER NOT NULL,
  status       TEXT NOT NULL,                  -- draft|final|superseded|voided
  rule_version INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (run_id, version)
) STRICT;

CREATE TABLE brief_items (
  id               INTEGER PRIMARY KEY,
  brief_id         INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  story_cluster_id INTEGER NOT NULL REFERENCES story_clusters(id),
  version_hash     TEXT NOT NULL,
  section          TEXT NOT NULL,
  order_no         INTEGER NOT NULL,
  status           TEXT NOT NULL,              -- included|late_discovery|updated
  title            TEXT NOT NULL,
  conclusion       TEXT NOT NULL,
  summary_json     TEXT NOT NULL,
  source_name      TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  UNIQUE (brief_id, story_cluster_id, version_hash)   -- PRD 7.5 幂等约束
) STRICT;

CREATE TABLE deliveries (
  id            INTEGER PRIMARY KEY,
  brief_id      INTEGER NOT NULL REFERENCES briefs(id),
  recipient     TEXT NOT NULL,
  delivery_type TEXT NOT NULL,                 -- primary|resend|shadow
  resend_sequence INTEGER NOT NULL DEFAULT 0,  -- 补发显式序号（PRD 7.5）
  attempt       INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL,                 -- pending|sent|failed|permanent_failure
  provider_id   TEXT,                          -- Gmail message ID
  error         TEXT,
  created_at    TEXT NOT NULL,
  sent_at       TEXT,
  UNIQUE (brief_id, recipient, delivery_type, resend_sequence)
) STRICT;

-- ---------- 版本、覆盖、审计、用量 ----------
CREATE TABLE prompt_versions (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  schema_hash  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content      TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (name, version)
) STRICT;

CREATE TABLE rule_versions (
  id           INTEGER PRIMARY KEY,
  rule_version INTEGER NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  content      TEXT NOT NULL,                  -- rules.yaml 全文快照
  activated_at TEXT NOT NULL
) STRICT;

CREATE TABLE manual_overrides (
  id           INTEGER PRIMARY KEY,
  target_type  TEXT NOT NULL,                  -- candidate|cluster|source|item
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT NOT NULL,                  -- 必填（PRD 16.4）
  scope        TEXT NOT NULL DEFAULT 'once',   -- once|permanent
  actor        TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE audit_events (
  id           INTEGER PRIMARY KEY,
  run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  harvest_run_id INTEGER REFERENCES harvest_runs(id) ON DELETE SET NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  payload_json TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE usage_ledger (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  evaluation_id INTEGER REFERENCES evaluations(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,
  task          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL,
  price_source_url TEXT,                       -- PRD 15.5：保存价格来源与抓取日期
  price_fetched_at TEXT,
  created_at    TEXT NOT NULL
) STRICT;

-- ---------- 索引（PRD 13.2） ----------
CREATE INDEX idx_feed_items_canonical_url ON feed_items(canonical_url);
CREATE INDEX idx_feed_items_published     ON feed_items(published_at DESC);
CREATE INDEX idx_feed_items_origin_window ON feed_items(origin_window_key, source_id);
CREATE INDEX idx_feed_items_source_seen   ON feed_items(source_id, first_seen_at DESC);
CREATE INDEX idx_item_versions_item       ON item_versions(item_id, version_no DESC);
CREATE INDEX idx_item_versions_hash       ON item_versions(content_hash);
CREATE INDEX idx_item_versions_fulltext   ON item_versions(fulltext_status) WHERE fulltext_status IS NULL OR fulltext_status = 'failed';
CREATE INDEX idx_candidates_run           ON candidates(run_id, origin_window_key, late_discovery);
CREATE INDEX idx_brief_items_cluster      ON brief_items(story_cluster_id, version_hash);
CREATE INDEX idx_fetch_attempts_source    ON fetch_attempts(source_id, started_at DESC);
CREATE INDEX idx_fetch_attempts_harvest   ON fetch_attempts(harvest_run_id);
CREATE INDEX idx_audit_entity             ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_usage_run                ON usage_ledger(run_id, model);
CREATE INDEX idx_raw_snapshots_expiry     ON raw_snapshots(expires_at);
CREATE INDEX idx_harvest_runs_started     ON harvest_runs(started_at DESC);
