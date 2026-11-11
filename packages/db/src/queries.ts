import { itemEligibleSql } from './eligibility.ts';
import type { DB } from './index.ts';
import type { Win } from '../../domain/src/normalize.ts';

export type ItemRow = {
  item_id: number; vid: number; source_id: string; title: string; clean_text: string;
  fulltext_text: string | null; html_excerpt: string | null; fulltext_html: string | null;
  canonical_url: string | null; published_at: string; first_seen_at: string;
  origin_window_key: string; timestamp_confidence: string; mandatory_retention: number;
  dup_canonical: number; ever_sent: number;
};

const SELECT_IN_RANGE = `
  SELECT f.id item_id, v.id vid, f.source_id, v.title, v.clean_text,
         v.fulltext_text, v.html_excerpt, v.fulltext_html,
         f.canonical_url, f.published_at, f.first_seen_at, f.origin_window_key,
         f.timestamp_confidence, s.mandatory_retention,
         (SELECT count(*) FROM feed_items f2
           WHERE ${itemEligibleSql('f2')} AND f2.canonical_url = f.canonical_url AND f2.canonical_url IS NOT NULL
             AND f2.id <> f.id AND f2.first_seen_at < f.first_seen_at) dup_canonical,
         (SELECT count(*) FROM brief_items bi
           JOIN cluster_members cm ON cm.cluster_id = bi.story_cluster_id
           WHERE cm.item_version_id = v.id) ever_sent
  FROM feed_items f
  JOIN item_versions v ON v.id = f.current_version_id
  JOIN sources s ON s.id = f.source_id
  WHERE ${itemEligibleSql()} AND f.published_at >= ? AND f.published_at < ?`;

/** 某窗口内发布的条目。 */
export function itemsInWindow(db: DB, w: Win): ItemRow[] {
  return db.prepare(SELECT_IN_RANGE).all(w.start.toISOString(), w.end.toISOString()) as ItemRow[];
}

export type LateResult = {
  late: Array<ItemRow & { origin: Win }>;
  /** 上线前存量：窗口结束时系统尚未在采集该来源，不算「上游延迟」。 */
  backfill: number;
};

/**
 * 三窗口复查补录（PRD 6.2）。四个条件全部满足才算补录：
 *   1. 规范化发布时间落在最近三个已结束窗口之一
 *   2. 首次发现时间晚于该窗口结束（原窗口运行结束前库里没有它）
 *   3. 该条目及等价实体从未被任何简报发送
 *   4. 该窗口结束前系统确实在采集这个来源
 *
 * 第 4 条是迁移截止点：仅凭前三条会把上线前的存量全判成补录
 * （实测冷启动时 61 条全是假象），也会把「新增来源」「来源当时故障」
 * 误判为上游延迟。
 */
export function findLateDiscoveries(db: DB, prev: Win[]): LateResult {
  const watched = db.prepare(`SELECT 1 FROM fetch_attempts
    WHERE source_id = ? AND outcome IN ('ok','not_modified') AND started_at < ? LIMIT 1`);
  const late: Array<ItemRow & { origin: Win }> = [];
  let backfill = 0;

  for (const w of prev) {
    for (const r of itemsInWindow(db, w)) {
      if (Date.parse(r.first_seen_at) < w.end.getTime()) continue;   // 窗口结束前已见
      if (r.ever_sent > 0) continue;                                  // 已发送过
      if (!watched.get(r.source_id, w.end.toISOString())) { backfill++; continue; }
      late.push({ ...r, origin: w });
    }
  }
  return { late, backfill };
}
