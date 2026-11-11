/**
 * 全文写回与恢复（docs/ssrf-redirect-design.md 第 4 版 §6、§11）。
 */
import type { DB } from '../../../packages/db/src/index.ts';

export const FULLTEXT_MAX_ATTEMPTS = 3;
/** 可重试类：次数未用完时状态保持 NULL，下一轮继续。 */
export const FULLTEXT_TRANSIENT: ReadonlySet<string> = new Set(['dns', 'network', 'timeout', 'http_408', 'http_5xx']);

/**
 * 失败写回：可重试类在次数未用完时保持 NULL（SQL 内按库里的当前次数判断，不按读出的旧值）；
 * 只覆盖未成功的记录：晚到的失败不能清掉已成功（ok / too_short）的全文。返回是否写入。
 */
export function recordFulltextFailure(db: DB, vid: number, f: { url: string | null; errorClass?: string; error: string;
  gateReason: string; signalsJson: string; prescreenJson: string; at: string }): boolean {
  return db.prepare(`UPDATE item_versions SET
    fulltext_text=NULL, fulltext_html=NULL, fulltext_hash=NULL, fulltext_url=?,
    fulltext_status=CASE WHEN ? = 1 AND fulltext_attempts + 1 < ? THEN NULL ELSE 'failed' END,
    fulltext_error=?, fulltext_fetched_at=?, fulltext_attempts=fulltext_attempts+1, gate_reason=?,
    signals_json=?, prescreen_json=? WHERE id=? AND (fulltext_status IS NULL OR fulltext_status='failed')`)
    .run(f.url, FULLTEXT_TRANSIENT.has(String(f.errorClass)) ? 1 : 0, FULLTEXT_MAX_ATTEMPTS, f.error, f.at,
      f.gateReason, f.signalsJson, f.prescreenJson, vid).changes > 0;
}

/**
 * 把最近 N 天因临时故障失败的记录改回待抓（次数清零、状态 NULL）。只允许更新全文，不会重新生成或重发已保存的日报。
 * 新格式 <分类>:<状态>；旧格式 fetch_failed:<分类>（旧实现第一次临时失败就写 failed）。未知格式一律不动。
 */
export function resetTransientFulltext(db: DB, days: number, now = Date.now()): number {
  const since = new Date(now - days * 864e5).toISOString();
  return db.prepare(`UPDATE item_versions SET fulltext_attempts=0, fulltext_status=NULL
    WHERE fulltext_status='failed' AND fulltext_fetched_at >= ? AND (
      fulltext_error GLOB 'dns:*' OR fulltext_error GLOB 'network:*' OR fulltext_error GLOB 'timeout:*'
      OR fulltext_error GLOB 'http_408:*' OR fulltext_error GLOB 'http_5xx:*'
      OR fulltext_error IN ('fetch_failed:network', 'fetch_failed:timeout', 'fetch_failed:dns', 'fetch_failed:http_5xx')
      OR fulltext_error GLOB 'fetch_failed:5[0-9][0-9]')`).run(since).changes;
}
