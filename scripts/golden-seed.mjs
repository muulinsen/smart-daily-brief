#!/usr/bin/env node
// 从已采集语料生成黄金集草稿（机器预标注，待人工确认）
//   node scripts/golden-seed.mjs [--limit N]
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { openDb } from '../packages/db/src/index.ts';
import { extractSignals, prescreenMandatory } from '../packages/domain/src/signals.ts';

const OUT = process.env.GOLDEN_PATH
  ?? (process.env.DATABASE_PATH?.startsWith('/var/lib/') ? '/var/lib/briefing/golden.json'
                                                        : 'tests/golden/samples.json');
const limit = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : 400;

const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const known = new Map(existing.map(s => [s.id, s]));

const rows = db.prepare(`
  SELECT f.source_id, f.canonical_url, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         coalesce(v.fulltext_html, v.html_excerpt) html,
         v.is_excerpt, v.fulltext_status, v.id vid
  FROM item_versions v JOIN feed_items f ON f.id = v.item_id
  WHERE length(coalesce(v.fulltext_text, v.clean_text)) > 40
  ORDER BY v.discovered_at DESC LIMIT ?`).all(limit);

const host = { linuxdo:'linux.do', v2ex:'v2ex.com', elsewhere:'elsewhere.news' };
let added = 0;
for (const r of rows) {
  const id = `v${r.vid}`;
  if (known.has(id)) continue;                       // 已标注的不覆盖
  const d = extractSignals(r.body, r.html ?? '', host[r.source_id] ?? '');
  const cls = prescreenMandatory(d.signals);
  known.set(id, {
    id, source: r.source_id, url: r.canonical_url, title: r.title, body: r.body,
    bodyIsExcerpt: !!r.is_excerpt && r.fulltext_status !== 'ok',
    expected: {
      decision: cls.length ? 'retain' : 'normal',
      mandatoryClass: cls[0] ?? 'none',
      section: null, filterRuleId: null, sameEventAs: [], mustMention: [],
    },
    // 固化抽取结果：黄金集评估的是 AI 层（提示词/模型），
    // 确定性抽取器有自己的单测。若评估时重新从 body 抽信号，
    // HTML 里的仓库与官方链接会丢失，导致指标失真。
    extracted: { signals: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
                 repos: d.repos, officialLinks: d.officialLinks, prescreenClasses: cls },
    labelSource: 'machine_proposed',
    note: cls.length ? `程序预判 ${cls.join('')}，请确认类别是否吻合` : '',
    tags: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
  });
  added++;
}

const all = [...known.values()];
writeFileSync(OUT, JSON.stringify(all, null, 2));

const confirmed = all.filter(s => s.labelSource === 'human_confirmed');
const byClass = {};
for (const s of confirmed) byClass[s.expected.mandatoryClass] = (byClass[s.expected.mandatoryClass] ?? 0) + 1;

console.log(`黄金集 ${OUT}`);
console.log(`  总计 ${all.length} 条（本次新增 ${added}）`);
console.log(`  人工确认 ${confirmed.length} 条 —— 只有这些计入回归`);
console.log(`  非摘要样本 ${all.filter(s => !s.bodyIsExcerpt).length} 条（只有这些能校验 A–D 召回）`);
console.log(`  已确认的类别分布: ${Object.entries(byClass).map(([k,v])=>k+'='+v).join(' ') || '（无）'}`);
console.log(`\nPRD 23.3 覆盖度要求（按已确认样本计）：`);
for (const [name, need, got] of [
  ['强制保留 A 正例', 20, confirmed.filter(s=>s.expected.mandatoryClass==='A').length],
  ['强制保留 B 正例', 20, confirmed.filter(s=>s.expected.mandatoryClass==='B').length],
  ['强制保留 C 正例', 20, confirmed.filter(s=>s.expected.mandatoryClass==='C').length],
  ['强制保留 D 正例', 20, confirmed.filter(s=>s.expected.mandatoryClass==='D').length],
  ['过滤样本',        20, confirmed.filter(s=>s.expected.decision==='filter').length],
  ['同事件聚类标注',  15, confirmed.filter(s=>(s.expected.sameEventAs??[]).length).length],
  ['总量',           200, confirmed.length],
]) console.log(`  ${got >= need ? '✅' : '⏳'} ${name.padEnd(16)} ${got}/${need}`);
db.close();
