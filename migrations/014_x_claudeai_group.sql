-- X @ClaudeAI 属于 Claude 子分类。仅修正仍为未归类的旧记录，保留后台手动调整。
UPDATE sources SET source_group='claude',updated_at=datetime('now')
WHERE id='x_claudeai' AND source_group='unclassified';
