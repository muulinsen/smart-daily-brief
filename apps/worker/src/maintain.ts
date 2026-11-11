#!/usr/bin/env node
/**
 * 日常维护：SQLite 在线备份 + 快照过期清理（计划 3.5 / PRD 13.3）。
 * 用 better-sqlite3 的 backup() API，不依赖 sqlite3 CLI（本机未安装）。
 */
import { readdirSync, statSync, unlinkSync, rmdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, nowIso } from '../../../packages/db/src/index.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { cleanupTelegram } from '../../../packages/telegram/src/maintenance.ts';
import { gzipFile, pruneBackups, removeStaleTemps } from './backup-files.ts';
import { readBackupSettings } from '../../../packages/web/src/backup-settings.ts';
import { pruneAiCache } from '../../../packages/digest/src/cache.ts';

const DB_PATH = process.env.DATABASE_PATH ?? './data/brief.db';
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/lib/briefing/backups';
const SNAP_DIR = process.env.SNAPSHOT_DIR ?? './data/snapshots';
const KEEP_DAILY = Number(process.env.BACKUP_KEEP_DAILY ?? 14);   // PRD 13.3
const KEEP_WEEKLY = Number(process.env.BACKUP_KEEP_WEEKLY ?? 8);

const db = openDb(DB_PATH);
mkdirSync(BACKUP_DIR, { recursive: true });
for (const prefix of ['brief', 'telegram']) {
  const stale = removeStaleTemps(BACKUP_DIR, prefix);
  if (stale.length) console.log(`清理中断残留: ${stale.join(', ')}`);
}

// 后台「备份与存储」的本机备份开关；读不到开关文件时按开启处理
const backupCfg = readBackupSettings();
if (backupCfg.error) console.warn(`⚠️ ${backupCfg.error}`);
const LOCAL_BACKUP = backupCfg.local;
const stamp = new Date().toISOString().slice(0, 10);

// ---- 1. 在线备份（不阻塞写入） ----
if (LOCAL_BACKUP) {
  const tmp = join(BACKUP_DIR, `brief-${stamp}.db`);
  await db.backup(tmp);
  const gzBytes = await gzipFile(tmp);
  console.log(`备份: ${tmp}.gz (${(gzBytes / 1024).toFixed(0)} KB)`);

  // ---- 2. 备份保留：日备 KEEP_DAILY 份，每周一的另留 KEEP_WEEKLY 份 ----
  const removed = pruneBackups(BACKUP_DIR, 'brief', KEEP_DAILY, KEEP_WEEKLY);
  console.log(`备份保留 ${KEEP_DAILY} 日 + ${KEEP_WEEKLY} 周，清理 ${removed.length} 份`);
} else console.log('本机备份已在后台关闭：跳过日报库与 Telegram 库备份（已有备份保留不动）');

// ---- 3. 快照过期清理（PRD 13.3：压缩保留 30 天） ----
const expired = db.prepare('SELECT id, storage_path FROM raw_snapshots WHERE expires_at < ?')
  .all(nowIso()) as Array<{ id: number; storage_path: string }>;
const del = db.prepare('DELETE FROM raw_snapshots WHERE id = ?');
let gone = 0;
db.transaction(() => {
  for (const s of expired) {
    try { if (existsSync(s.storage_path)) unlinkSync(s.storage_path); } catch { /* 文件已不在，仍删记录 */ }
    del.run(s.id); gone++;
  }
})();
// 清理空目录
const prune = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) prune(p);
  }
  try { if (readdirSync(dir).length === 0 && dir !== SNAP_DIR) rmdirSync(dir); } catch { /* 非空 */ }
};
prune(SNAP_DIR);
console.log(`快照清理 ${gone} 个过期条目`);

// ---- 4. WAL checkpoint，防止 -wal 文件无限增长 ----
// AI 结果与向量缓存保留 30 天（可随时重建，迁移 018 之前跳过）
const pruned = pruneAiCache(db, 30);
if (pruned.notes || pruned.vectors) console.log(`清理 AI 缓存 ${pruned.notes} 条、向量缓存 ${pruned.vectors} 条`);
db.pragma('wal_checkpoint(TRUNCATE)');
const size = statSync(DB_PATH).size;
console.log(`数据库 ${(size / 1024 / 1024).toFixed(1)} MB，WAL 已 checkpoint`);
db.close();

// ---- 5. Telegram 使用独立数据库，但共享同一维护生命周期 ----
// 消息库永久保留全部历史，最新一份备份已包含之前所有备份的内容，所以 KEEP_DAILY=1 即「每日压缩并合并为一份」。
const telegramPath = process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3';
const telegramDb = readyTelegramDb(telegramPath);
let telegramBackupNote = '本机备份已关闭';
if (LOCAL_BACKUP) {
  const telegramTmp = join(BACKUP_DIR, `telegram-${stamp}.db`);
  await telegramDb.backup(telegramTmp);
  const telegramGzBytes = await gzipFile(telegramTmp);
  pruneBackups(BACKUP_DIR, 'telegram', KEEP_DAILY, KEEP_WEEKLY);
  telegramBackupNote = `${telegramTmp}.gz (${(telegramGzBytes / 1024 / 1024).toFixed(0)} MB)`;
}
const telegramCleaned = cleanupTelegram(telegramDb);
telegramDb.pragma('wal_checkpoint(TRUNCATE)');
console.log(`Telegram 备份: ${telegramBackupNote}；清理消息 ${telegramCleaned.messages}、URL ${telegramCleaned.urls}、总结 ${telegramCleaned.summaries}`);
telegramDb.close();
