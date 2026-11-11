#!/usr/bin/env node
import { openDb, migrate } from '../../../packages/db/src/index.ts';

const dbPath = process.env.DATABASE_PATH ?? './data/brief.db';
const db = openDb(dbPath);
const ran = migrate(db, './migrations');
const tables = db.prepare(
  "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as any;
const idx = db.prepare(
  "SELECT count(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get() as any;

console.log(`数据库: ${dbPath}`);
console.log(ran.length ? `  已应用迁移: ${ran.join(', ')}` : '  无新迁移');
console.log(`  表 ${tables.n} 个 / 索引 ${idx.n} 个`);
console.log(`  journal_mode=${db.pragma('journal_mode', { simple: true })}` +
            ` foreign_keys=${db.pragma('foreign_keys', { simple: true })}`);
db.close();
