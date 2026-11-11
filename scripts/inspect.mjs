import { openDb } from '../packages/db/src/index.ts';
const db = openDb('./data/brief.db');
const A = (s, ...a) => db.prepare(s).all(...a);
console.log('=== 回退与失败 ===');
const fb = A(`SELECT source_id, endpoint_priority p, outcome, count(*) c
              FROM fetch_attempts GROUP BY 1,2,3 HAVING p>1 OR outcome<>'ok'`);
console.log(fb.length ? fb.map(r => `  ${r.source_id} P${r.p} ${r.outcome} ×${r.c}`).join('\n')
                      : '  无回退，全部 priority 1 直接成功 ✅');
console.log('\n=== 时间戳异常来自哪些源 ===');
for (const r of A(`SELECT source_id, timestamp_confidence tc, count(*) c FROM feed_items
                   WHERE tc<>'exact' GROUP BY 1,2 ORDER BY c DESC`))
  console.log(`  ${r.source_id.padEnd(16)} ${r.tc.padEnd(12)} ${r.c}`);
console.log('\n=== anomalous 样例（原始时间字符串）===');
for (const r of A(`SELECT source_id, published_at_raw, published_at FROM feed_items
                   WHERE timestamp_confidence='anomalous' LIMIT 4`))
  console.log(`  ${r.source_id.padEnd(14)} raw=${r.published_at_raw} → ${r.published_at}`);
console.log('\n=== missing 样例 ===');
for (const r of A(`SELECT source_id, count(*) c FROM feed_items
                   WHERE timestamp_confidence='missing' GROUP BY 1`))
  console.log(`  ${r.source_id.padEnd(14)} ${r.c} 条无时间戳`);
console.log('\n=== deepseek 键重复详情 ===');
for (const r of A(`SELECT f.source_item_key k, v.title, v.version_no, length(v.clean_text) len
                   FROM item_versions v JOIN feed_items f ON f.id=v.item_id
                   WHERE f.source_id='deepseek' AND f.source_item_key LIKE '%deepseek-chat%'
                   ORDER BY v.version_no`))
  console.log(`  v${r.version_no} len=${String(r.len).padStart(5)} title="${r.title.slice(0,40)}"`);
db.close();
