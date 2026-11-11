ALTER TABLE sources ADD COLUMN source_group_next TEXT NOT NULL DEFAULT 'unclassified'
 CHECK(source_group_next IN ('unclassified','openai','claude','google','deepseek','cloudflare','meituan','zhihu','weibo','baidu'));
UPDATE sources SET source_group_next=source_group;
DROP INDEX idx_sources_group;
ALTER TABLE sources DROP COLUMN source_group;
ALTER TABLE sources RENAME COLUMN source_group_next TO source_group;
CREATE INDEX idx_sources_group ON sources(source_group,enabled,id);
CREATE TABLE allnet_subscriptions (
 source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
 upstream_id INTEGER NOT NULL UNIQUE CHECK(upstream_id>0),
 item_limit INTEGER NOT NULL CHECK(item_limit BETWEEN 1 AND 100),
 kind TEXT NOT NULL CHECK(kind IN ('ranking','latest')),
 origin TEXT,
 token TEXT UNIQUE,
 snapshot_json TEXT,
 snapshot_at TEXT
) STRICT;
CREATE TABLE allnet_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL) STRICT;
CREATE TABLE allnet_lock (id INTEGER PRIMARY KEY CHECK(id=1), until_ms INTEGER NOT NULL) STRICT;
INSERT INTO allnet_lock VALUES(1,0);
CREATE TABLE allnet_cache (cache_key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_ms INTEGER NOT NULL) STRICT;
