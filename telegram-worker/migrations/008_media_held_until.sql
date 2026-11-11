-- 失败图片保留 7 天（docs/error-hygiene-design.md B2）：首次进入保留时间 + 7 天，之后不顺延。
ALTER TABLE telegram_media_tasks ADD COLUMN held_until TEXT;
