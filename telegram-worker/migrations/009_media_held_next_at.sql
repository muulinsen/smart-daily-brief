-- 保留中图片的下一次自动重试时间（12 小时间隔，且不早于上游要求的等待）。
ALTER TABLE telegram_media_tasks ADD COLUMN held_next_at TEXT;
