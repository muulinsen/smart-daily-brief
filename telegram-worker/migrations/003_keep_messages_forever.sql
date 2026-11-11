ALTER TABLE telegram_settings
  ADD COLUMN keep_messages_forever INTEGER NOT NULL DEFAULT 0
  CHECK(keep_messages_forever IN (0,1));
