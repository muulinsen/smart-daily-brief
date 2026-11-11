#!/usr/bin/env node
/**
 * 把人工反馈写入黄金集（PRD 23.3 / 24.1）。
 *
 *   node scripts/golden-mark.mjs keep c123 c145 c160
 *   node scripts/golden-mark.mjs keep c123 --class A
 *   node scripts/golden-mark.mjs keep c123 --section quality_article
 *   node scripts/golden-mark.mjs keep v694 v666 --same-event-as v694,v666
 *   node scripts/golden-mark.mjs drop c200 c201        确认「过滤是对的」
 *   node scripts/golden-mark.mjs list                  看已标注进度
 *   node scripts/golden-mark.mjs sweep                 上一期附录里没被点名的，全部记为「过滤得对」
 *   node scripts/golden-mark.mjs sweep --brief 10      指定某一期
 *
 * 邮件附录里每条被过滤/待复核的条目都带编号（c<候选ID>）。
 * 人工回复「保留 c123 c145」后用本脚本落库 —— 这些标注是
 * human_confirmed 的，会直接计入 golden-eval 的召回率评估。
 *
 * 「过滤是对的」同样有价值：它构成负例，用于衡量错误过滤率。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { openDb } from '../packages/db/src/index.ts';
import { extractSignals, prescreenMandatory } from '../packages/domain/src/signals.ts';

// 黄金集是运行时数据，不是代码 —— 放 /var/lib/briefing（brief 可写），
// 而非 git 仓库所在的 /opt（root 只读）。开发时默认回落到仓库内路径。
const FILE = process.env.GOLDEN_PATH
  ?? (process.env.DATABASE_PATH?.startsWith('/var/lib/') ? '/var/lib/briefing/golden.json'
                                                        : 'tests/golden/samples.json');
const argv = process.argv.slice(2);
const cmd = argv[0];
const clsIdx = argv.indexOf('--class');
const forcedClass = clsIdx > 0 ? argv[clsIdx + 1] : null;
const sectionIdx = argv.indexOf('--section');
const forcedSection = sectionIdx > 0 ? argv[sectionIdx + 1] : null;
const validSections = ['ai_tech', 'developer_product', 'quality_article', 'society_life'];
if (forcedSection && !validSections.includes(forcedSection)) {
  console.error(`分区必须是 ${validSections.join(' / ')}`);
  process.exit(1);
}
const sameIdx = argv.indexOf('--same-event-as');
const sameEventRefs = sameIdx > 0
  ? String(argv[sameIdx + 1] ?? '').split(/[\s,]+/).filter(Boolean).map(x => x.toLowerCase())
  : [];
// 支持三种引用：c<候选ID>（邮件附录里的编号）、v<版本ID>（无候选时用）、
// 以及 --title <关键词>（简报里的标题被 compose 改写过，原标题需按关键词找）
const refs = argv.slice(1).filter(a => /^[cv]\d+$/i.test(a)).map(a => a.toLowerCase());
let sweepMode = false;
const titleIdx = argv.indexOf('--title');
const titleKey = titleIdx > 0 ? argv[titleIdx + 1] : null;

const db = openDb(process.env.DATABASE_PATH ?? '/var/lib/briefing/brief.db');
const all = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
const byId = new Map(all.map(s => [s.id, s]));

if (cmd === 'list') {
  const conf = all.filter(s => s.labelSource === 'human_confirmed');
  const dflt = all.filter(s => s.labelSource === 'human_default');
  const cls = {};
  for (const s of conf) cls[s.expected.mandatoryClass] = (cls[s.expected.mandatoryClass] ?? 0) + 1;
  console.log(`黄金集 ${all.length} 条`);
  console.log(`  逐条点名确认 ${conf.length} 条`);
  console.log(`  附录未点名、按默认约定视为过滤正确 ${dflt.length} 条`);
  console.log(`  类别分布: ${Object.entries(cls).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`);
  console.log(`  保留正例: ${conf.filter(s => s.expected.decision !== 'filter').length}`);
  console.log(`  过滤负例: ${conf.filter(s => s.expected.decision === 'filter').length}`);
  console.log('\nPRD 23.3 覆盖度：');
  for (const [name, need, got] of [
    ['A 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'A').length],
    ['B 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'B').length],
    ['C 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'C').length],
    ['D 类正例', 20, conf.filter(s => s.expected.mandatoryClass === 'D').length],
    ['过滤负例', 20, [...conf, ...dflt].filter(s => s.expected.decision === 'filter').length],
    ['总量', 200, conf.length + dflt.length],
  ]) console.log(`  ${got >= need ? '✅' : '⏳'} ${name.padEnd(10)} ${got}/${need}`);
  db.close(); process.exit(0);
}

/**
 * sweep：把某期附录里**没有**被人工点名的条目，全部记为「过滤得对」。
 *
 * 依据是使用方定下的约定：「我没提到的附录内容默认就是过滤的对」。
 * 只标 keep 的话，系统只能学到「越放越宽」—— 没有负例就无法衡量
 * 错误过滤率，min_score_to_include 也没有可校准的下界。
 *
 * 已有标注一律不覆盖：人工显式说过的（keep 或 drop）优先于这条默认约定。
 */
if (cmd === 'sweep') {
  const bIdx = argv.indexOf('--brief');
  const brief = bIdx > 0
    ? db.prepare('SELECT id, run_id, subject FROM briefs WHERE id=?').get(Number(argv[bIdx + 1]))
    : db.prepare(`SELECT id, run_id, subject FROM briefs WHERE status='final'
                  ORDER BY id DESC LIMIT 1`).get();
  if (!brief) { console.error('找不到该期简报'); process.exit(1); }

  // 该期附录实际列出的条目 = 记进 appendix_seen 的那些
  const listed = db.prepare(`
    SELECT c.id cid, v.id vid FROM appendix_seen a
    JOIN item_versions v ON v.id = a.item_version_id
    JOIN candidates c ON c.item_version_id = v.id AND c.run_id = ?
    WHERE a.brief_id = ?`).all(brief.run_id, brief.id);

  console.log(`${brief.subject}  附录列出 ${listed.length} 条`);
  const todo = listed.filter(r => !byId.has(`v${r.vid}`));
  console.log(`  已有人工标注 ${listed.length - todo.length} 条（保持不变）`);
  console.log(`  按默认约定记为「过滤得对」：${todo.length} 条\n`);
  if (!todo.length) { db.close(); process.exit(0); }

  for (const r of todo) refs.push(`c${r.cid}`);
  sweepMode = true;
}

if (cmd !== 'keep' && cmd !== 'drop' && cmd !== 'sweep') {
  console.error('用法: golden-mark.mjs keep|drop c123 c145 …   |   golden-mark.mjs list');
  process.exit(1);
}
if (!refs.length && !titleKey) { console.error('没有识别到编号（c123 / v456）或 --title 关键词'); process.exit(1); }

const host = { linuxdo: 'linux.do', v2ex: 'v2ex.com', elsewhere: 'elsewhere.news' };
const byVersion = db.prepare(`
  SELECT (SELECT c.id FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) cid,
         f.source_id, f.canonical_url url, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         coalesce(v.fulltext_html, v.html_excerpt) html,
         v.is_excerpt, v.fulltext_status,
         (SELECT c.decision FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) decision,
         (SELECT c.filter_reason FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) filter_reason,
         (SELECT c.filter_rule_id FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) filter_rule_id,
         v.prescreen_json, v.id vid
  FROM item_versions v JOIN feed_items f ON f.id = v.item_id WHERE v.id = ?`);

const byTitle = db.prepare(`
  SELECT (SELECT c.id FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) cid,
         f.source_id, f.canonical_url url, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         coalesce(v.fulltext_html, v.html_excerpt) html,
         v.is_excerpt, v.fulltext_status,
         (SELECT c.decision FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) decision,
         (SELECT c.filter_reason FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) filter_reason,
         (SELECT c.filter_rule_id FROM candidates c WHERE c.item_version_id=v.id LIMIT 1) filter_rule_id,
         v.prescreen_json, v.id vid
  FROM item_versions v JOIN feed_items f ON f.id = v.item_id
  WHERE v.title LIKE ? ORDER BY v.id DESC LIMIT 5`);

const q = db.prepare(`
  SELECT c.id cid, f.source_id, f.canonical_url url, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         coalesce(v.fulltext_html, v.html_excerpt) html,
         v.is_excerpt, v.fulltext_status, c.decision, c.filter_reason, c.filter_rule_id,
         v.prescreen_json, v.id vid
  FROM candidates c
  JOIN item_versions v ON v.id = c.item_version_id
  JOIN feed_items f ON f.id = v.item_id
  WHERE c.id = ?`);

let added = 0, updated = 0, missing = [];
const targets = [];
for (const ref of refs) {
  const n = Number(ref.slice(1));
  const r = ref[0] === 'c' ? q.get(n) : byVersion.get(n);
  if (!r) { missing.push(ref); continue; }
  targets.push({ ref, r });
}
if (titleKey) {
  const found = byTitle.all(`%${titleKey}%`);
  if (!found.length) missing.push(`--title「${titleKey}」`);
  for (const r of found) targets.push({ ref: `v${r.vid}`, r });
}

for (const { ref, r } of targets) {

  const d = extractSignals(r.body ?? '', r.html ?? '', host[r.source_id] ?? '');
  const auto = prescreenMandatory(d.signals);
  const id = `v${r.vid}`;
  const isKeep = cmd === 'keep' && !sweepMode;
  const cls = forcedClass ?? (isKeep ? (auto[0] ?? 'none') : 'none');

  const sample = {
    id, source: r.source_id, url: r.url, title: r.title, body: r.body ?? '',
    bodyIsExcerpt: !!r.is_excerpt && r.fulltext_status !== 'ok',
    expected: {
      decision: isKeep ? (cls !== 'none' ? 'retain' : 'normal') : 'filter',
      mandatoryClass: cls,
      section: forcedSection ?? byId.get(id)?.expected?.section ?? null,
      filterRuleId: isKeep ? null : (r.filter_rule_id ?? null),
      sameEventAs: sameEventRefs.length
        ? sameEventRefs.filter(x => x !== id)
        : byId.get(id)?.expected?.sameEventAs ?? [],
      mustMention: byId.get(id)?.expected?.mustMention ?? [],
    },
    extracted: {
      signals: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
      repos: d.repos, officialLinks: d.officialLinks, prescreenClasses: auto,
    },
    // sweep 出来的标注是「人工未反对」，证据强度低于逐条点名确认。
    // 分开记，评估时才能区分「确认过滤正确」与「默认视为正确」。
    labelSource: sweepMode ? 'human_default' : 'human_confirmed',
    note: isKeep
      ? `人工判定应收录（系统原判 ${r.decision ?? '未进入候选'}${r.filter_reason ? '：' + String(r.filter_reason).slice(0, 60) : ''}）`
      : sweepMode
        ? `附录中未被点名，按默认约定视为过滤正确（${r.filter_rule_id ?? '模型判定'}）`
        : `人工确认过滤正确（${r.filter_rule_id ?? '模型判定'}）`,
    tags: Object.entries(d.signals).filter(([, v]) => v).map(([k]) => k),
  };

  if (byId.has(id)) updated++; else added++;
  byId.set(id, sample);

  const mark = isKeep ? '保留' : '过滤';
  const flag = isKeep && auto.length === 0 ? '  ⚠️ 程序预判无 A–D 证据，属纯语义漏判' : '';
  console.log(`  ${mark} ${ref}  [${cls}]  ${String(r.title).slice(0, 40)}${flag}`);
}

writeFileSync(FILE, JSON.stringify([...byId.values()], null, 2));
console.log(`\n黄金集：新增 ${added}，更新 ${updated}` + (missing.length ? `，未找到 ${missing.join(' ')}` : ''));

const conf = [...byId.values()].filter(s => s.labelSource === 'human_confirmed');
console.log(`人工确认累计 ${conf.length} 条（PRD 23.3 要求 ≥200）`);
console.log('跑 npm run golden:eval -- --confirmed-only 可用这些标注评估当前规则与模型');
db.close();
