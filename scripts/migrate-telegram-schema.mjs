#!/usr/bin/env node
import Database from 'better-sqlite3';
import { basename, dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';

const path = process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3';
const backupDir = process.env.MIGRATION_BACKUP_DIR ?? join(dirname(path), 'migration-backups');
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
chmodSync(backupDir, 0o700);
let backup = '';
if (existsSync(path)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup = join(backupDir, `${basename(path)}-before-vision-${stamp}.bak`);
  const source = new Database(path, { readonly: true });
  try { await source.backup(backup); } finally { source.close(); }
  chmodSync(backup, 0o600);
}
const db = readyTelegramDb(path);
try {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`Telegram SQLite integrity_check=${integrity}`);
  console.log(`Telegram schema migration complete; integrity_check=ok${backup ? `; backup=${backup}` : ''}`);
} finally { db.close(); }
