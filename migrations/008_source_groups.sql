-- 后台来源展示分组。与用于日报筛选的 category 分离，避免界面整理改变过滤行为。
ALTER TABLE sources ADD COLUMN source_group TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (source_group IN ('unclassified','openai','claude','google','deepseek'));

-- 现有 DeepSeek 更新日志复用原记录并归入厂商；其余历史来源保持未归类。
UPDATE sources SET source_group='deepseek' WHERE id='deepseek';
CREATE INDEX idx_sources_group ON sources(source_group, enabled, id);
