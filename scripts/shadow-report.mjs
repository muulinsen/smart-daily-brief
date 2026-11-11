#!/usr/bin/env node
/**
 * 影子运行日报（PRD 25.5 / 24.2）。
 *   node scripts/shadow-report.mjs [--days 7]
 *
 * 回答三个问题：采集稳不稳、判定合不合理、漏没漏项。
 */
import { openDb } from '../packages/db/src/index.ts';

const days = process.argv.includes('--days')
  ? Number(process.argv[process.argv.indexOf('--days') + 1]) : 7;
const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const A = (s, ...a) => db.prepare(s).all(...a);
const G = (s, ...a) => db.prepare(s).get(...a);
const since = `-${days} days`;
const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';

console.log(`影子运行报告 · 最近 ${days} 天\n${'='.repeat(56)}\n`);

// ---- 1. 采集稳定性 ----
const h = G(`SELECT count(*) runs, sum(sources_attempted) att, sum(sources_ok) ok,
             sum(new_items) items FROM harvest_runs WHERE started_at > datetime('now', ?)`, since);
console.log('【采集】');
console.log(`  轮次 ${h.runs ?? 0}  单源成功率 ${pct(h.ok, h.att)}（PRD 目标 ≥97%）  新条目 ${h.items ?? 0}`);
const fails = A(`SELECT source_id, count(*) c FROM fetch_attempts
  WHERE started_at > datetime('now', ?) AND outcome NOT IN ('ok','not_modified')
  GROUP BY 1 ORDER BY c DESC LIMIT 5`, since);
if (fails.length) console.log(`  失败最多：${fails.map(f => `${f.source_id}×${f.c}`).join('  ')}`);
const fb = A(`SELECT source_id, endpoint_priority p, count(*) c FROM fetch_attempts
  WHERE started_at > datetime('now', ?) AND endpoint_priority > 1 AND outcome='ok'
  GROUP BY 1,2`, since);
console.log(fb.length ? `  端点回退：${fb.map(x => `${x.source_id}→P${x.p}×${x.c}`).join('  ')}` : '  端点回退：无');

// ---- 2. 窗口与补录 ----
console.log('\n【窗口与补录】');
const runs = A(`SELECT window_key, status, (SELECT count(*) FROM candidates c WHERE c.run_id=r.id) n
  FROM runs r WHERE scheduled_at > datetime('now', ?) ORDER BY id`, since);
console.log(`  运行 ${runs.length} 次  成功 ${runs.filter(r => r.status === 'succeeded').length}`);
const late = G(`SELECT count(*) c FROM candidates WHERE late_discovery=1
  AND created_at > datetime('now', ?)`, since);
console.log(`  补录条目 ${late.c}（PRD 6 三窗口复查的产出）`);

// ---- 3. 判定分布 ----
console.log('\n【判定】');
const dec = A(`SELECT decision, count(*) c FROM candidates
  WHERE created_at > datetime('now', ?) GROUP BY 1 ORDER BY c DESC`, since);
const total = dec.reduce((a, d) => a + d.c, 0);
for (const d of dec) console.log(`  ${d.decision.padEnd(10)} ${String(d.c).padStart(4)}  ${pct(d.c, total)}`);
const mand = A(`SELECT mandatory_class m, count(*) c FROM candidates
  WHERE created_at > datetime('now', ?) AND m IS NOT NULL AND m<>'none' GROUP BY 1`, since);
console.log(`  强制保留：${mand.length ? mand.map(x => `${x.m}=${x.c}`).join(' ') : '无'}`);
const rules = A(`SELECT filter_rule_id r, count(*) c FROM candidates
  WHERE created_at > datetime('now', ?) AND r IS NOT NULL GROUP BY 1 ORDER BY c DESC`, since);
if (rules.length) console.log(`  过滤规则：${rules.map(x => `${x.r}×${x.c}`).join('  ')}`);

// ---- 4. 漏项风险（PRD 24.1 的核心指标）----
console.log('\n【漏项风险】');
const escFiltered = G(`SELECT count(*) c FROM candidates c
  WHERE c.created_at > datetime('now', ?) AND c.decision='filter'
    AND EXISTS (SELECT 1 FROM item_versions v WHERE v.id=c.item_version_id
      AND v.prescreen_json IS NOT NULL AND v.prescreen_json<>'[]')`, since);
console.log(`  程序预判为 A–D 但最终被过滤：${escFiltered.c} 条` +
            (escFiltered.c ? '  ⚠️ 需逐条人工复核（PRD 9.3 要求邮件中逐条列出）' : '  ✅'));
const manual = G(`SELECT count(*) c FROM audit_events
  WHERE action IN ('ai_manual_audit','budget_skipped') AND created_at > datetime('now', ?)`, since);
console.log(`  转人工审计：${manual.c} 条`);

// ---- 5. 投递 ----
console.log('\n【投递】');
const dl = A(`SELECT delivery_type t, status, count(*) c FROM deliveries
  WHERE created_at > datetime('now', ?) GROUP BY 1,2`, since);
console.log(dl.length ? dl.map(d => `  ${d.t}/${d.status}: ${d.c}`).join('\n') : '  尚无投递');
const dup = G(`SELECT count(*) c FROM (SELECT brief_id, recipient, delivery_type, count(*) n
  FROM deliveries GROUP BY 1,2,3 HAVING n>1)`);
console.log(`  重复投递：${dup.c} 组` + (dup.c ? '  ❌ 违反 PRD 24.1-P0' : '  ✅'));

console.log(`\n${'='.repeat(56)}`);
console.log('PRD 25.5：影子运行需连续 7 天达标后方可切换正式投递。');
db.close();
