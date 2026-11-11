-- 图片识别跨进程租约：到期时间。
ALTER TABLE telegram_settings ADD COLUMN vision_lease_until TEXT;
