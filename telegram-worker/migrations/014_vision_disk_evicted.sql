-- 因图片目录超过上限而提前删除的图片数（后台展示）。
ALTER TABLE telegram_settings ADD COLUMN vision_disk_evicted INTEGER NOT NULL DEFAULT 0;
