-- 图片识别跨进程租约：持有者。释放时必须核对，旧进程不能释放新进程的租约。
ALTER TABLE telegram_settings ADD COLUMN vision_lease_owner TEXT;
