-- GitHub 日榜/周榜是按顺序变化的榜单，不是时序文章源。
UPDATE allnet_subscriptions SET kind='ranking',item_limit=15
WHERE upstream_id IN (467,468);

UPDATE sources SET category='tech',source_group='github',harvest_tier='ranking_feed',updated_at=datetime('now')
WHERE id IN (SELECT source_id FROM allnet_subscriptions WHERE upstream_id IN (467,468));
