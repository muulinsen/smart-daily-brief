#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { cleanupTelegram } from '../../../packages/telegram/src/maintenance.ts';

const path=process.env.TELEGRAM_DATABASE_PATH??'./data/telegram.sqlite3';
const db=readyTelegramDb(path);
const backupDir=process.env.BACKUP_DIR??'./data/backups';mkdirSync(backupDir,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const backup=join(backupDir,`${basename(path)}-${stamp}.bak`);
await db.backup(backup);
const cleaned=cleanupTelegram(db);
const integrity=db.pragma('integrity_check',{simple:true});
console.log(`Telegram 备份完成；清理消息 ${cleaned.messages}、URL ${cleaned.urls}、总结 ${cleaned.summaries}；integrity_check=${integrity}`);
db.pragma('wal_checkpoint(TRUNCATE)');db.close();
