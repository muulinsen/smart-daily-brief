-- 采集覆盖水位与同步尝试结果（docs/telegram-collector-watchdog-design.md）
-- 用独立的新表而不是 ALTER TABLE ADD COLUMN：CREATE TABLE IF NOT EXISTS 可重复执行，
-- Python 端 executescript 中途中断、或 Node 与 Python 同时启动重复执行，都不会让后续启动失败。
-- covered_until：最近一次成功同步（连续历史扫描 + 保留期复查）的扫描开始时刻，此前发出的消息都已采到
-- last_attempt_at / last_attempt_ok：最近一次同步尝试的时刻与结果；NULL = 进行中或从未尝试
CREATE TABLE IF NOT EXISTS telegram_sync_progress (
  source_id       INTEGER PRIMARY KEY REFERENCES telegram_sources(id) ON DELETE CASCADE,
  covered_until   TEXT,
  last_attempt_at TEXT,
  last_attempt_ok INTEGER CHECK(last_attempt_ok IN (0,1))
) STRICT;
