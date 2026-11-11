#!/usr/bin/env node
/**
 * 升级原因诊断：列出某次运行里被判为 escalate 的候选，
 * 显示触发的规则与命中关键词的上下文 —— 用于判断是真高风险还是误触发。
 *   node scripts/inspect-escalations.mjs [--run N] [--rule ESC-002]
 */
import { openDb } from '../packages/db/src/index.ts';
import { loadRules } from '../packages/domain/src/rules.ts';

const argv = process.argv.slice(2);
const runId = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;
const only = argv.includes('--rule') ? argv[argv.indexOf('--rule') + 1] : null;

const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const rid = runId ?? (db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get()?.id);
const kw = (loadRules().high_risk?.domains ?? []).flatMap(d => d.keywords ?? []);
const majors = loadRules().major_news_types ?? [];

const rows = db.prepare(`
  SELECT c.id, f.source_id, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         e.escalation_reasons er, e.confidence conf, e.result_json rj
  FROM candidates c
  JOIN item_versions v ON v.id = c.item_version_id
  JOIN feed_items f ON f.id = v.item_id
  LEFT JOIN evaluations e ON e.candidate_id = c.id AND e.stage = 'luna'
  WHERE c.run_id = ? AND c.decision = 'escalate'
  ORDER BY c.id`).all(rid);

const ctx = (hay, k) => {
  const i = hay.indexOf(k);
  if (i < 0) return '';
  return '…' + hay.slice(Math.max(0, i - 26), i + k.length + 26).replace(/\s+/g, ' ') + '…';
};

const byRule = {};
let shown = 0;
console.log(`run #${rid} 的升级候选（共 ${rows.length} 条）\n`);

for (const r of rows) {
  const rules = r.er ? JSON.parse(r.er) : [];
  for (const x of rules) byRule[x] = (byRule[x] ?? 0) + 1;
  if (only && !rules.includes(only)) continue;

  const hay = `${r.title} ${r.body}`;
  const hitRisk = kw.filter(k => hay.includes(k));
  const hitMajor = majors.filter(k => hay.includes(k));
  console.log(`${++shown}. [${r.source_id}] ${r.title.slice(0, 44)}`);
  console.log(`   规则 ${rules.join(' ')}   置信度 ${r.conf ?? '-'}`);
  if (hitRisk.length) {
    console.log(`   高风险词 ${hitRisk.join(' ')}`);
    for (const k of hitRisk.slice(0, 2)) console.log(`     「${k}」 ${ctx(hay, k)}`);
  }
  if (hitMajor.length) console.log(`   重大新闻类型 ${hitMajor.join(' ')}`);
  try {
    const j = JSON.parse(r.rj ?? '{}');
    if (j.escalation_reasons?.length) console.log(`   模型自陈: ${j.escalation_reasons.join('；')}`);
  } catch { /* ignore */ }
  console.log();
}

console.log('规则命中统计：' + Object.entries(byRule).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}×${v}`).join('  '));
db.close();
