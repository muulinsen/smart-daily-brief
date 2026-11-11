-- ============================================================
-- 003 来源管理（FR-001：新增、编辑、启停、测试）
--
-- 【为什么需要 managed_by】
-- sources.yaml 是 git 版本化的配置，sync-sources 会按它重建来源表。
-- 若后台新增的来源没有标记，下一次 sync 会把它当作"配置里已删除"
-- 而停用甚至覆盖。用 managed_by 区分归属：
--   config —— 来自 sources.yaml，由 sync-sources 管理
--   admin  —— 后台新增，sync-sources 不得触碰
-- ============================================================

ALTER TABLE sources ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'config';
ALTER TABLE sources ADD COLUMN created_by TEXT;

-- 后台「测试抓取」的诊断记录（FR-004：测试不得写入正式简报，但可保存诊断日志）
CREATE TABLE source_tests (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT,                    -- 可为空：新增前的预测试还没有来源
  url           TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  latency_ms    INTEGER,
  outcome       TEXT NOT NULL,           -- ok|blocked|fetch_failed|parse_failed
  http_code     INTEGER,
  bytes         INTEGER,
  parsed_count  INTEGER,
  parser        TEXT,
  sample_json   TEXT,                    -- 前几条解析结果，供人工确认解析是否正确
  error         TEXT,
  actor         TEXT NOT NULL DEFAULT 'owner'
) STRICT;

CREATE INDEX idx_source_tests_recent ON source_tests(started_at DESC);
CREATE INDEX idx_sources_managed ON sources(managed_by, enabled);
