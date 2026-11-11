import { type DB, sha256 } from './index.ts';

/** Shared by candidate selection, AI stages, composition and deduplication. */
export function itemEligibleSql(item = 'f'): string {
  return `EXISTS (SELECT 1 FROM sources eligibility_source
    WHERE eligibility_source.id=${item}.source_id AND eligibility_source.enabled=1 AND eligibility_source.archived_at IS NULL)`;
}
export function candidateEligibleSql(candidate = 'c'): string {
  return `EXISTS (SELECT 1 FROM item_versions eligibility_version
    JOIN feed_items eligibility_item ON eligibility_item.id=eligibility_version.item_id
    WHERE eligibility_version.id=${candidate}.item_version_id AND ${itemEligibleSql('eligibility_item')})`;
}
/**
 * Persisted with the immutable brief; detects changes during composition and retry waits.
 * 全网热点删除后仍保留 `NULL AS briefing_enabled_since`（字段名、顺序、排序不变）：普通来源的签名与历史记录逐字一致，
 * 旧版简报复用与投递重试依赖它。
 */
export function eligibilitySignature(db: DB, runId: number): string {
  // enabled 列取「有效资格」：未归档来源的值与原来逐字相同（字段名、类型、顺序不变），归档来源记为 0
  return sha256(JSON.stringify(db.prepare(`SELECT DISTINCT s.id,CASE WHEN s.archived_at IS NULL THEN s.enabled ELSE 0 END AS enabled,NULL AS briefing_enabled_since
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id JOIN sources s ON s.id=f.source_id
    WHERE c.run_id=? ORDER BY s.id`).all(runId)));
}
export function assertEligibilityUnchanged(db: DB, runId: number, signature: string): void {
  if (eligibilitySignature(db, runId) !== signature) throw new Error('来源日报资格已变化，本轮已中止，请重新运行以生成最新内容');
}
