#!/usr/bin/env node
// 补录审计：逐条说明为什么判为「补录（RSS 延迟）」，并列出发布后首见前的采集记录。
// 对应 PRD 6.3「补录条目必须保存并展示」与 16.3 运行详情页。
import { openDb } from '../packages/db/src/index.ts';
import { windowOf, previousWindows } from '../packages/domain/src/normalize.ts';
import { findLateDiscoveries } from '../packages/db/src/queries.ts';

const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const { late, backfill } = findLateDiscoveries(db, previousWindows(windowOf(), 3));

console.log(`补录 ${late.length} 条（另有 ${backfill} 条属上线前存量）\n`);
const attempts = db.prepare(`SELECT started_at, outcome FROM fetch_attempts
  WHERE source_id = ? AND started_at > ? AND started_at <= ?
    AND endpoint_priority = 1 ORDER BY started_at`);

for (const r of late) {
  const delay = Math.round((Date.parse(r.first_seen_at) - Date.parse(r.published_at)) / 60000);
  console.log(`● ${r.title.slice(0, 50)}`);
  console.log(`   来源 ${r.source_id} | 原窗口 ${r.origin.key}`);
  console.log(`   发布 ${r.published_at.slice(0, 19)} → 首见 ${r.first_seen_at.slice(0, 19)}  延迟 ${delay} 分钟`);
  const rows = attempts.all(r.source_id, r.published_at, r.first_seen_at);
  const ok = rows.filter(a => a.outcome === 'ok' || a.outcome === 'not_modified');
  console.log(`   期间成功采集 ${ok.length} 次${ok.length ? `（${ok.map(a => a.started_at.slice(11, 16)).join(' ')}）` : ''}` +
              ` —— ${ok.length ? '证明条目当时确实不在 feed 中，属上游延迟入源' : '期间无成功采集，延迟原因存疑'}`);
  console.log();
}
db.close();
