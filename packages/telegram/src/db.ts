import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type TelegramDB = Database.Database;

export function openTelegramDb(path = process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3'): TelegramDB {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  try { chmodSync(path, 0o600); } catch { /* 可能尚未创建 */ }
  return db;
}

export function migrateTelegram(db: TelegramDB, dir = join(process.cwd(), 'telegram-worker/migrations')): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT`);
  const applied = new Map((db.prepare('SELECT name,checksum FROM telegram_schema_migrations').all() as any[])
    .map(r => [r.name, r.checksum]));
  const names = readdirSync(dir).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  const added: string[] = [];
  for (const name of names) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
    const old = applied.get(name);
    if (old && old !== checksum) throw new Error(`Telegram 迁移 ${name} 已被修改`);
    if (old) continue;
    // 取得写锁后重新检查登记：另一个进程（Node 或 Python）可能刚刚执行完同一个迁移，避免重复 ALTER
    const ran = db.transaction(() => {
      if (db.prepare('SELECT 1 FROM telegram_schema_migrations WHERE name=?').get(name)) return false;
      db.exec(sql);
      db.prepare('INSERT OR REPLACE INTO telegram_schema_migrations VALUES(?,?,?)')
        .run(name, checksum, new Date().toISOString());
      return true;
    }).immediate();
    if (ran) added.push(name);
  }
  return added;
}

export function readyTelegramDb(path?: string): TelegramDB {
  const db = openTelegramDb(path);
  migrateTelegram(db);
  return db;
}
