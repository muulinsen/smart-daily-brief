import type { DB } from '../../../packages/db/src/index.ts';
import { nowIso } from '../../../packages/db/src/index.ts';

const HOUR = 60 * 60 * 1000;
const COOLDOWNS = [HOUR, 6 * HOUR, 24 * HOUR] as const;

export function cooldownMs(strikes: number): number {
  return COOLDOWNS[Math.min(Math.max(1, strikes), COOLDOWNS.length) - 1]!;
}

export function openCircuitHosts(db: DB, at = Date.now()): Set<string> {
  const rows = db.prepare(`SELECT host FROM host_circuit_breakers
    WHERE cooldown_until IS NOT NULL AND cooldown_until > ?`).all(new Date(at).toISOString()) as { host: string }[];
  return new Set(rows.map(r => r.host));
}

export function recordRateLimit(
  db: DB, host: string, httpCode?: number, error?: string, at = Date.now(),
): string {
  const row = db.prepare('SELECT consecutive_limits FROM host_circuit_breakers WHERE host=?')
    .get(host) as { consecutive_limits: number } | undefined;
  const strikes = (row?.consecutive_limits ?? 0) + 1;
  const now = new Date(at).toISOString();
  const until = new Date(at + cooldownMs(strikes)).toISOString();
  db.prepare(`INSERT INTO host_circuit_breakers
    (host,consecutive_limits,cooldown_until,last_http_code,last_error,last_limited_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(host) DO UPDATE SET
      consecutive_limits=excluded.consecutive_limits,
      cooldown_until=excluded.cooldown_until,
      last_http_code=excluded.last_http_code,
      last_error=excluded.last_error,
      last_limited_at=excluded.last_limited_at,
      updated_at=excluded.updated_at`)
    .run(host, strikes, until, httpCode ?? null, error ?? null, now, now);
  return until;
}

export function recordHostSuccess(db: DB, host: string, at = Date.now()): void {
  const now = new Date(at).toISOString();
  db.prepare(`UPDATE host_circuit_breakers SET consecutive_limits=0,cooldown_until=NULL,
    last_http_code=NULL,last_error=NULL,last_success_at=?,updated_at=? WHERE host=?`)
    .run(now, now, host);
}

export function circuitUntil(db: DB, host: string, at = Date.now()): string | null {
  const row = db.prepare('SELECT cooldown_until FROM host_circuit_breakers WHERE host=?').get(host) as
    { cooldown_until: string | null } | undefined;
  return row?.cooldown_until && Date.parse(row.cooldown_until) > at ? row.cooldown_until : null;
}
