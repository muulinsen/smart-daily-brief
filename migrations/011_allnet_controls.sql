ALTER TABLE allnet_subscriptions ADD COLUMN collection_enabled INTEGER NOT NULL DEFAULT 1 CHECK(collection_enabled IN (0,1));
ALTER TABLE allnet_subscriptions ADD COLUMN briefing_enabled_since TEXT;
UPDATE allnet_subscriptions SET collection_enabled=(SELECT enabled FROM sources WHERE id=source_id);
ALTER TABLE briefs ADD COLUMN eligibility_signature TEXT;
