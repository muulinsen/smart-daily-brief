#!/usr/bin/env node
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { visionStats } from '../packages/telegram/src/vision.ts';

const db = readyTelegramDb();
try {
  const settings = db.prepare(`SELECT vision_model,vision_daily_limit,vision_paused,vision_pause_reason
    FROM telegram_settings WHERE singleton=1`).get();
  const stats = visionStats(db);
  console.log(JSON.stringify({ ...settings, ...stats }, null, 2));
} finally { db.close(); }
