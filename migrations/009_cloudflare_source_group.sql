-- 扩展来源分组枚举；通过替换单列保留 sources 主键及所有外键关系。
ALTER TABLE sources ADD COLUMN source_group_next TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (source_group_next IN ('unclassified','openai','claude','google','deepseek','cloudflare'));
UPDATE sources SET source_group_next=source_group;
DROP INDEX idx_sources_group;
ALTER TABLE sources DROP COLUMN source_group;
ALTER TABLE sources RENAME COLUMN source_group_next TO source_group;
CREATE INDEX idx_sources_group ON sources(source_group, enabled, id);
