/**
 * 新版日报推迟发布所需的运行状态（迁移 018，docs/semantic-dedup-design.md §5）：
 * AI 请求预算、运行租约、尝试记录、推迟状态。全部是短事务，跨进程安全。
 */
import { randomBytes } from 'node:crypto';
import { nowIso, type DB } from './index.ts';

export type Trigger = 'timer' | 'manual';

export function hasRunStateTables(db: DB): boolean {
  const n = (db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table'
    AND name IN ('run_ai_budget','run_attempts','run_retry_state','run_leases')`).get() as any).n;
  return n === 4;
}

/** 预算作用域：定时运行的多次尝试共用 timer；每次手动重跑另开 manual:<尝试 id>。 */
export function budgetScope(trigger: Trigger, attemptId: number): string {
  return trigger === 'timer' ? 'timer' : `manual:${attemptId}`;
}

/** 原子扣减一次请求额度；额度不足返回 false。 */
export function takeBudget(db: DB, runId: number, scope: string, cap: number): boolean {
  db.prepare('INSERT INTO run_ai_budget(run_id,scope,used) VALUES(?,?,0) ON CONFLICT(run_id,scope) DO NOTHING').run(runId, scope);
  return db.prepare('UPDATE run_ai_budget SET used=used+1 WHERE run_id=? AND scope=? AND used<?').run(runId, scope, cap).changes === 1;
}

export function budgetUsed(db: DB, runId: number, scope: string): number {
  return Number((db.prepare('SELECT used FROM run_ai_budget WHERE run_id=? AND scope=?').get(runId, scope) as any)?.used ?? 0);
}

// ---------- 租约 ----------

export type Lease = { runId: number; owner: string; release(): void; renew(): boolean; held(): boolean };
const LEASE_MS = 5 * 60_000;

/** 原子获取租约（不存在或已过期才可获取）。拿不到返回 null。获取后每分钟自动续租。 */
export function acquireLease(db: DB, runId: number, now = () => Date.now()): Lease | null {
  const owner = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const got = db.transaction(() => {
    const row = db.prepare('SELECT owner, expires_at FROM run_leases WHERE run_id=?').get(runId) as any;
    if (row && Date.parse(row.expires_at) > now()) return false;
    db.prepare(`INSERT INTO run_leases(run_id,owner,expires_at) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`)
      .run(runId, owner, new Date(now() + LEASE_MS).toISOString());
    return true;
  }).immediate();
  if (!got) return null;
  let released = false;
  const renew = () => !released && db.prepare('UPDATE run_leases SET expires_at=? WHERE run_id=? AND owner=?')
    .run(new Date(now() + LEASE_MS).toISOString(), runId, owner).changes === 1;
  const timer = setInterval(() => { try { renew(); } catch { /* 下次再试 */ } }, 60_000);
  timer.unref();
  return {
    runId, owner, renew,
    held: () => !released && !!db.prepare('SELECT 1 FROM run_leases WHERE run_id=? AND owner=? AND expires_at>?')
      .get(runId, owner, new Date(now()).toISOString()),
    release: () => {
      if (released) return;
      released = true; clearInterval(timer);
      try { db.prepare('DELETE FROM run_leases WHERE run_id=? AND owner=?').run(runId, owner); } catch { /* 过期后自然失效 */ }
    },
  };
}

// ---------- 尝试记录与推迟状态 ----------

export function startAttempt(db: DB, runId: number, trigger: Trigger): number {
  return Number(db.prepare('INSERT INTO run_attempts(run_id,trigger,started_at) VALUES(?,?,?)').run(runId, trigger, nowIso()).lastInsertRowid);
}

export function finishAttempt(db: DB, attemptId: number, outcome: string, unresolved: number | null, errorKind: string | null) {
  db.prepare('UPDATE run_attempts SET finished_at=?, outcome=?, unresolved=?, error_kind=? WHERE id=?')
    .run(nowIso(), outcome, unresolved, errorKind, attemptId);
}

/** 第一次定时尝试的开始时间（截止时间以它和窗口结束时刻中较晚者为基准，服务器停机后首次启动仍有完整的两小时）。 */
export function firstTimerAttemptAt(db: DB, runId: number): string | null {
  return (db.prepare(`SELECT min(started_at) t FROM run_attempts WHERE run_id=? AND trigger='timer'`).get(runId) as any)?.t ?? null;
}

export type RetryState = { deadline_at: string | null; next_attempt_at: string | null; unresolved: number; last_error_kind: string | null; refused_json: string };

export function getRetryState(db: DB, runId: number): RetryState | null {
  return (db.prepare('SELECT deadline_at,next_attempt_at,unresolved,last_error_kind,refused_json FROM run_retry_state WHERE run_id=?').get(runId) as any) ?? null;
}

export function setRetryState(db: DB, runId: number, s: Partial<RetryState>) {
  const cur = getRetryState(db, runId) ?? { deadline_at: null, next_attempt_at: null, unresolved: 0, last_error_kind: null, refused_json: '[]' };
  const v = { ...cur, ...s };
  db.prepare(`INSERT INTO run_retry_state(run_id,deadline_at,next_attempt_at,unresolved,last_error_kind,refused_json,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET deadline_at=excluded.deadline_at, next_attempt_at=excluded.next_attempt_at,
    unresolved=excluded.unresolved, last_error_kind=excluded.last_error_kind, refused_json=excluded.refused_json, updated_at=excluded.updated_at`)
    .run(runId, v.deadline_at, v.next_attempt_at, v.unresolved, v.last_error_kind, v.refused_json, nowIso());
}

/** 固定时刻表：窗口结束 + 15、30、…分钟；返回严格晚于 now 的下一个时刻。 */
export function nextSlot(base: number, now: number, stepMs = 15 * 60_000): number {
  const k = Math.max(1, Math.floor((now - base) / stepMs) + 1);
  return base + k * stepMs;
}
