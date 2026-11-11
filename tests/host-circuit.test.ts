import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { cooldownMs, circuitUntil, openCircuitHosts, recordHostSuccess, recordRateLimit }
  from '../apps/worker/src/host-circuit.ts';

const db = new Database(':memory:');
db.exec(`CREATE TABLE host_circuit_breakers (
  host TEXT PRIMARY KEY, consecutive_limits INTEGER NOT NULL DEFAULT 0,
  cooldown_until TEXT, last_http_code INTEGER, last_error TEXT,
  last_limited_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL)`);

assert.equal(cooldownMs(1), 60 * 60 * 1000);
assert.equal(cooldownMs(2), 6 * 60 * 60 * 1000);
assert.equal(cooldownMs(3), 24 * 60 * 60 * 1000);
assert.equal(cooldownMs(99), 24 * 60 * 60 * 1000);

const t0 = Date.parse('2026-08-30T00:00:00Z');
assert.equal(recordRateLimit(db as any, 'linux.do', 429, 'limited', t0), '2026-08-30T01:00:00.000Z');
assert.equal(circuitUntil(db as any, 'linux.do', t0), '2026-08-30T01:00:00.000Z');
assert(openCircuitHosts(db as any, t0).has('linux.do'));

assert.equal(recordRateLimit(db as any, 'linux.do', 403, 'challenge', t0), '2026-08-30T06:00:00.000Z');
recordHostSuccess(db as any, 'linux.do', t0 + 1000);
assert.equal(circuitUntil(db as any, 'linux.do', t0 + 1000), null);
assert(!openCircuitHosts(db as any, t0 + 1000).has('linux.do'));

db.close();
console.log('host circuit tests passed');
