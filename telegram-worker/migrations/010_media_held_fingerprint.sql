-- 最近一次失败请求所用的模型配置指纹：管理员换配置后立即重试。
ALTER TABLE telegram_media_tasks ADD COLUMN held_fingerprint TEXT;
