-- ============================================================
-- 005 评估附录已列条目
--
-- 三窗口复查会把最近三个已结束窗口的条目反复带进候选，
-- 于是被过滤的条目每期附录都重列一遍 ——
-- 实测早报与午报的附录重复率 71%，读起来像"和昨天差不多"。
-- 记录已列过的条目，后续只列新增的。
-- ============================================================
CREATE TABLE appendix_seen (
  item_version_id INTEGER PRIMARY KEY REFERENCES item_versions(id) ON DELETE CASCADE,
  brief_id        INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  decision        TEXT NOT NULL,
  listed_at       TEXT NOT NULL
) STRICT;

CREATE INDEX idx_appendix_seen_brief ON appendix_seen(brief_id);
