import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DB = Database.Database;

/** 打开数据库并应用 PRD 19.2 要求的 pragma。 */
export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');      // 单 Writer + 并发读（PRD 27 风险表）
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');    // WAL 下的推荐值，兼顾安全与写入吞吐
  return db;
}

/** 前向迁移。已应用的记录在 schema_migrations，禁止 destructive rollback（计划 22.4）。 */
export function migrate(db: DB, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL) STRICT`);

  const applied = new Map<string, string>(
    db.prepare('SELECT name, checksum FROM schema_migrations').all()
      .map((r: any) => [r.name, r.checksum]));

  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)');

  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sum = sha256(sql).slice(0, 16);
    const prev = applied.get(f);
    if (prev !== undefined) {
      if (prev !== sum)
        throw new Error(`迁移 ${f} 已应用但内容已变更（${prev} → ${sum}）。已应用的迁移不可修改，请新增一个迁移文件。`);
      continue;
    }
    db.transaction(() => { db.exec(sql); record.run(f, nowIso(), sum); })();
    ran.push(f);
  }
  return ran;
}

import { createHash } from 'node:crypto';
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const nowIso = () => new Date().toISOString();
