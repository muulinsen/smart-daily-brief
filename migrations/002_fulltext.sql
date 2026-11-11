-- ============================================================
-- 002 全文抓取字段
--
-- 【为什么不覆盖 clean_text / content_hash】
-- content_hash 是采集器基于 feed 给出的正文（多数情况是摘要）算出的
-- 去重身份键，UNIQUE(item_id, content_hash) 依赖它保持稳定。
-- 若抓到全文后覆盖它，下一轮采集读到同样的摘要会重新算出旧哈希、
-- 在库里找不到，从而不断创建新版本 —— 版本会无限增长。
-- 因此全文作为独立字段并存：clean_text 是「feed 说了什么」，
-- fulltext_text 是「原帖实际是什么」，两者都保留可审计。
-- ============================================================

ALTER TABLE item_versions ADD COLUMN fulltext_text TEXT;
ALTER TABLE item_versions ADD COLUMN fulltext_html TEXT;
ALTER TABLE item_versions ADD COLUMN fulltext_hash TEXT;   -- 全文自身的语义指纹，用于发现原帖被编辑
ALTER TABLE item_versions ADD COLUMN fulltext_url  TEXT;   -- 实际抓取的 URL（如 Discourse 的 .json）
ALTER TABLE item_versions ADD COLUMN fulltext_error TEXT;
ALTER TABLE item_versions ADD COLUMN fulltext_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE item_versions ADD COLUMN gate_reason TEXT;     -- 命中哪条 fetch_gate，或为何跳过
ALTER TABLE item_versions ADD COLUMN prescreen_json TEXT;  -- A–D 程序预判结果

-- 待抓队列：按尝试次数与发现时间排序
CREATE INDEX idx_item_versions_pending_fulltext
  ON item_versions(fulltext_attempts, discovered_at)
  WHERE fulltext_status IS NULL OR fulltext_status = 'failed';
