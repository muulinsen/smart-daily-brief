-- ============================================================
-- 016 来源厂商元数据 + 新版日报（官方动态 / 开源项目 / 时政速览）
--
-- 只做加列与新建表，不删除、不改写任何历史数据。
--   sources.vendor       来源所属厂商/主体（anthropic/openai/google/...）
--   sources.is_official  是否为该厂商官方渠道（1=进入「官方动态」）
--   sources.source_role  official | politics | context
--                        context 只用于开源项目提取与转载比对，不作为新闻展示
--   briefs.digest_json   新版结构化正文，邮件与 RSS 由同一份数据渲染
--   pushed_events / pushed_projects  已实际投递的事件与开源项目，用于 72 小时跨期去重
-- ============================================================
ALTER TABLE sources ADD COLUMN vendor TEXT NOT NULL DEFAULT 'other';
ALTER TABLE sources ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN source_role TEXT NOT NULL DEFAULT 'context';

-- 现有来源的初始值（随后 sync-sources 以 sources.yaml 为准覆盖 config 来源）
UPDATE sources SET vendor = CASE WHEN source_group <> 'unclassified' THEN source_group ELSE id END
  WHERE managed_by = 'admin';
UPDATE sources SET is_official = 1 WHERE coalesce(json_extract(config_json, '$.official'), 0) = 1;

ALTER TABLE briefs ADD COLUMN digest_json TEXT;

CREATE TABLE IF NOT EXISTS pushed_events (
  id          INTEGER PRIMARY KEY,
  vendor      TEXT NOT NULL,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  urls_json   TEXT NOT NULL,
  brief_id    INTEGER REFERENCES briefs(id),
  pushed_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_pushed_events_time ON pushed_events(pushed_at, vendor);

CREATE TABLE IF NOT EXISTS pushed_projects (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,              -- owner/name，小写
  description TEXT NOT NULL,
  brief_id    INTEGER REFERENCES briefs(id),
  pushed_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_pushed_projects_repo ON pushed_projects(repo, pushed_at);
