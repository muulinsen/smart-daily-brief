-- ============================================================
-- 017 技术干货板块（新版日报）的 72 小时跨期去重表
--
-- 只新建表，不改动任何既有数据。与 pushed_events / pushed_projects 同口径：
-- 仅在日报实际发布后由 recordPushed 登记。
-- ============================================================
CREATE TABLE IF NOT EXISTS pushed_tutorials (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  url         TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'tech' CHECK (category IN ('tech','deals','life')),
  brief_id    INTEGER REFERENCES briefs(id),
  pushed_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_pushed_tutorials_time ON pushed_tutorials(pushed_at);
