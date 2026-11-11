-- 科技厂商新增 GitHub 与 Hermes Agent 子分类，并保留现有来源和外键。
ALTER TABLE sources ADD COLUMN source_group_next TEXT NOT NULL DEFAULT 'unclassified'
 CHECK(source_group_next IN ('unclassified','openai','claude','google','deepseek','cloudflare','github','hermes','meituan','zhihu','weibo','baidu'));
UPDATE sources SET source_group_next=CASE WHEN id='x_github' THEN 'github' ELSE source_group END;
DROP INDEX idx_sources_group;
ALTER TABLE sources DROP COLUMN source_group;
ALTER TABLE sources RENAME COLUMN source_group_next TO source_group;
CREATE INDEX idx_sources_group ON sources(source_group,enabled,id);
