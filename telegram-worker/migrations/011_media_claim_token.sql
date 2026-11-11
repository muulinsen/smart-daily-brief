-- 领取任务的进程令牌：结果回写必须核对，旧进程恢复后不能覆盖新进程的任务。
ALTER TABLE telegram_media_tasks ADD COLUMN claim_token TEXT;
