-- 后台改造第一期（docs/admin-reorg-p1-design.md §4、§5）。只追加。
-- 通用「已归档来源」：归档的来源不显示在管理列表、不参与采集与日报、不能启用 / 删除 / 改分组 / 改地址；数据全部保留。
ALTER TABLE sources ADD COLUMN archived_at TEXT;

-- 全网热点（2026-11-08 下线代码、保留数据）与 4 个经 RSSHub 抓取的旧 Telegram 来源（2026-11-10 用户决定）。
-- 按 host_group / 明确 ID 指定；新安装没有这些行，为 0 行。
UPDATE sources SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), enabled = 0
WHERE archived_at IS NULL
  AND (host_group = 'allnet' OR id IN ('tg_tossiphonex','tg_zaihuapd','tg_durov','tg_karlshare'));

-- 来源画像已删除：模型分配里的 sourceProfiler 行永久保留为「停用」（不引用任何供应商，旧代码的 7 行校验仍通过）。
UPDATE model_assignments SET provider_id = NULL, model = NULL, strictness = NULL, follow = NULL, disabled = 1
WHERE consumer = 'sourceProfiler';
INSERT OR IGNORE INTO model_assignments (consumer, provider_id, model, strictness, follow, disabled)
SELECT 'sourceProfiler', NULL, NULL, NULL, NULL, 1 WHERE EXISTS (SELECT 1 FROM model_assignments);
