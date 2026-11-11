-- 持久化主机级熔断。RSS 和全文抓取共享同一个冷却状态，进程重启后仍有效。
CREATE TABLE host_circuit_breakers (
  host                TEXT PRIMARY KEY,
  consecutive_limits  INTEGER NOT NULL DEFAULT 0,
  cooldown_until      TEXT,
  last_http_code      INTEGER,
  last_error          TEXT,
  last_limited_at     TEXT,
  last_success_at     TEXT,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_host_circuit_cooldown ON host_circuit_breakers(cooldown_until);
