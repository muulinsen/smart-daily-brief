#!/usr/bin/env node
/**
 * 一次性清理已有错误记录（docs/error-hygiene-design.md A3，用户 2026-11-10 决定「清理成只留错误类型」）。
 *
 *   node scripts/scrub-error-text.mjs            # 只统计（dry-run），不写
 *   node scripts/scrub-error-text.mjs --apply    # 先在线备份两个库，再改写
 *
 * - 不判断新旧：范围内所有还没清理过的值都改写成「[已清理] 类型 HTTP 状态」；以 [已清理] 开头的跳过（可重复执行，第二次 0 行）。
 * - 只输出每列改写的行数，不输出任何原值。
 * - 库路径取自 DATABASE_PATH / TELEGRAM_DATABASE_PATH，必须是绝对路径且文件已存在（不会新建空库）。
 * - 生产用 systemd-run -p User=brief -p EnvironmentFile=/etc/briefing/env 运行。
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const APPLY = process.argv.includes('--apply');
const MARK = '[已清理]';
const KINDS = ['rate_limited', 'auth', 'timeout', 'bad_request', 'server', 'network', 'truncated', 'refusal'];
/** 采集器自己写的图片任务错误类型（来自 Telegram 下载，不是模型错误），不动。 */
const COLLECTOR_TYPES = ['download_error', 'too_large', 'media_removed', 'message_deleted'];

export function scrubbed(value, errorType) {
  const s = String(value ?? '');
  const kind = errorType && KINDS.includes(errorType) ? errorType : KINDS.find(k => s.startsWith(k));
  const status = /HTTP (\d{3})/.exec(s)?.[1];
  return [MARK, kind, status ? `HTTP ${status}` : null].filter(Boolean).join(' ');
}

function openExisting(envName) {
  const p = process.env[envName];
  if (!p || !isAbsolute(p)) throw new Error(`${envName} 必须是绝对路径`);
  if (!existsSync(p)) throw new Error(`${envName} 指向的文件不存在，拒绝执行（不会新建空库）`);
  const db = new Database(p, { fileMustExist: true });
  db.pragma('busy_timeout = 10000');
  return { db, path: p };
}

/** 对一列做改写；where 限定范围。返回改写行数（dry-run 时为将要改写的行数）。 */
function scrubColumn(db, table, column, where = '1=1', typeCol = null) {
  const scope = `${column} IS NOT NULL AND ${column} <> '' AND substr(${column}, 1, ${MARK.length}) <> ? AND (${where})`;
  const select = () => db.prepare(`SELECT rowid AS rid, ${column} AS v${typeCol ? `, ${typeCol} AS t` : ''} FROM ${table} WHERE ${scope}`).all(MARK);
  if (!APPLY) return select().length;
  // 读与写在同一个写事务里；写时再核对原值与范围（例如期间管理员把提案改成人工拒绝，就不再改写）
  const up = db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=? AND ${column}=? AND ${scope}`);
  return db.transaction(() => { let n = 0; for (const r of select()) n += up.run(scrubbed(r.v, r.t), r.rid, r.v, MARK).changes; return n; }).immediate();
}

/** JSON 列里的顶层 $.error（只改这个键，不动其他字段）。 */
function scrubJsonError(db, table, column, where = '1=1') {
  const scope = `json_valid(${column}) AND json_type(${column}, '$.error') = 'text'
      AND substr(json_extract(${column}, '$.error'), 1, ${MARK.length}) <> ? AND (${where})`;
  const select = () => db.prepare(`SELECT rowid AS rid, json_extract(${column}, '$.error') AS v FROM ${table} WHERE ${scope}`).all(MARK);
  if (!APPLY) return select().length;
  const up = db.prepare(`UPDATE ${table} SET ${column}=json_set(${column}, '$.error', ?) WHERE rowid=? AND json_extract(${column}, '$.error')=? AND ${scope}`);
  return db.transaction(() => { let n = 0; for (const r of select()) n += up.run(scrubbed(r.v, null), r.rid, r.v, MARK).changes; return n; }).immediate();
}

async function backup(db, label, dir) {
  // 每次执行一个新目录、文件名区分两个库、绝不覆盖已有备份（保留清理前的原始数据）
  const dest = join(dir, `${label}.sqlite3.bak`);
  if (existsSync(dest)) throw new Error(`备份文件已存在，拒绝覆盖：${basename(dest)}`);
  await db.backup(dest);                // 在线备份，包含 WAL 中已提交的内容
  chmodSync(dest, 0o600);
  const b = new Database(dest, { readonly: true, fileMustExist: true });
  try { const ok = b.pragma('integrity_check', { simple: true }); if (ok !== 'ok') throw new Error(`备份完整性检查失败：${basename(dest)}`); }
  finally { b.close(); }
  return dest;
}

const hasTable = (db, t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);

async function main() {
  const brief = openExisting('DATABASE_PATH');
  const tg = openExisting('TELEGRAM_DATABASE_PATH');
  try {
    if (APPLY) {
      const parent = process.env.SCRUB_BACKUP_DIR ?? join(process.env.BACKUP_DIR ?? '/var/lib/briefing/backups', 'prescrub');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      // 独占新建：同名目录已存在（同一时刻重复执行）时 mkdir 失败，不会写进旧备份
      const dir = join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`);
      mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
      await backup(brief.db, 'brief', dir);
      await backup(tg.db, 'telegram', dir);
      console.log(`已备份到 ${dir}（0700 / 0600，完整性检查通过）`);
    }
    const report = [];
    const add = (name, n) => report.push([name, n]);
    // Telegram 库
    add('telegram_summary_jobs.error', scrubColumn(tg.db, 'telegram_summary_jobs', 'error'));
    add('telegram_digests.error', scrubColumn(tg.db, 'telegram_digests', 'error'));
    add('telegram_media_tasks.error_message', scrubColumn(tg.db, 'telegram_media_tasks', 'error_message',
      `error_type IS NULL OR error_type NOT IN (${COLLECTOR_TYPES.map(t => `'${t}'`).join(',')})`, 'error_type'));
    // 日报库
    if (hasTable(brief.db, 'evaluations')) add('evaluations.result_json $.error', scrubJsonError(brief.db, 'evaluations', 'result_json'));
    add('runs.error', scrubColumn(brief.db, 'runs', 'error'));
    if (hasTable(brief.db, 'source_onboarding_proposals'))
      add('source_onboarding_proposals.error（仅 AI_ANALYSIS_FAILED）', scrubColumn(brief.db, 'source_onboarding_proposals', 'error', `status='AI_ANALYSIS_FAILED'`));
    const actions = brief.db.prepare(`SELECT DISTINCT action FROM audit_events WHERE json_valid(payload_json) AND json_type(payload_json, '$.error')='text'`).all().map(r => r.action);
    add(`audit_events.payload_json $.error（action：${actions.join('、') || '无'}）`, scrubJsonError(brief.db, 'audit_events', 'payload_json'));
    for (const [name, n] of report) console.log(`${APPLY ? '已改写' : '将改写'} ${String(n).padStart(6)}  ${name}`);
    if (!APPLY) console.log('（dry-run：未写入。加 --apply 先备份再改写）');
  } finally { brief.db.close(); tg.db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(`清理失败：${e?.message ?? e}`); process.exit(1); });
