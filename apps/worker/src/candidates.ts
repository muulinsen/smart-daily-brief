#!/usr/bin/env node
/**
 * 候选构建（PRD 第 5、6、8 章）—— 阶段 1 的闭环终点。
 * 从库里读窗口数据 → 三窗口复查补录 → 信号抽取 → A–D 预判 →
 * 确定性过滤 → 写 candidates。全程不调 AI、不发邮件。
 *
 *   node apps/worker/src/candidates.ts                    当前窗口
 *   node apps/worker/src/candidates.ts --window 2026-08-23:noon
 *   node apps/worker/src/candidates.ts --preview          只报告不落库
 */
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { windowToReport, windowFromKey, previousWindows, type Win } from '../../../packages/domain/src/normalize.ts';
import { extractSignals, prescreenMandatory } from '../../../packages/domain/src/signals.ts';
import { applyDeterministicFilters } from '../../../packages/domain/src/filters.ts';
import { itemsInWindow, findLateDiscoveries, type ItemRow } from '../../../packages/db/src/queries.ts';

const argv = process.argv.slice(2);
const PREVIEW = argv.includes('--preview');
const winArg = argv.includes('--window') ? argv[argv.indexOf('--window') + 1] : null;

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();
const win: Win = winArg && winArg !== 'auto' ? windowFromKey(winArg) : windowToReport();
const prev = previousWindows(win, 3);

console.log(`窗口 ${win.key} ${win.label}  [${win.start.toISOString()} → ${win.end.toISOString()})`);
console.log(`复查最近三个已结束窗口: ${prev.map(w => w.key).join(', ')}\n`);

// ---- run 行（window_key 唯一，PRD 7.5 幂等） ----
let runId: number | null = null;
if (!PREVIEW) {
  const existing = db.prepare('SELECT id FROM runs WHERE window_key=?').get(win.key) as any;
  runId = existing?.id ?? Number(db.prepare(`INSERT INTO runs
    (window_key,window_label,window_start_at,window_end_at,scheduled_at,started_at,
     status,stage,trigger,rule_version) VALUES (?,?,?,?,?,?,'running','filtering','manual',?)`)
    .run(win.key, win.label, win.start.toISOString(), win.end.toISOString(),
         win.end.toISOString(), nowIso(), rules.meta.rule_version).lastInsertRowid);
}

// ---- 取条目：当前窗口 + 最近三窗口的补录 ----
const current = itemsInWindow(db, win);
const { late, backfill } = findLateDiscoveries(db, prev);
type Row = ItemRow;

// ---- 逐条判定 ----
const insCand = db.prepare(`INSERT INTO candidates
  (run_id,item_version_id,origin_window_key,late_discovery,late_reason,
   prescreen_json,decision,mandatory_class,filter_rule_id,filter_reason,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(run_id,item_version_id) DO NOTHING`);
const insAudit = db.prepare(`INSERT INTO audit_events
  (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`);

const hostOf = (id: string) =>
  ({ linuxdo: 'linux.do', v2ex: 'v2ex.com', elsewhere: 'elsewhere.news' }[id] ?? '');

type Out = { decision: string; cls: string[]; rule?: string; reason?: string; late: boolean; r: Row };
const results: Out[] = [];
const errors: string[] = [];

const judge = (r: Row, isLate: boolean, originKey: string) => {
  // 有全文优先用全文（PRD 8.6 / forum_fulltext）
  const text = r.fulltext_text || r.clean_text;
  const html = r.fulltext_html || r.html_excerpt || '';
  const det = extractSignals(text, html, hostOf(r.source_id));
  const cls = r.mandatory_retention ? prescreenMandatory(det.signals) : [];

  let decision = cls.length ? 'retain' : 'normal';
  let rule: string | undefined, reason: string | undefined;

  // 时间戳异常/过旧不自动入选（PRD 5.4）
  if (r.timestamp_confidence === 'anomalous' || r.timestamp_confidence === 'stale') {
    decision = 'filter'; rule = 'TS-ANOMALY';
    reason = `时间戳置信度 ${r.timestamp_confidence}，按 PRD 5.4 不自动入选`;
  } else {
    try {
      const hit = applyDeterministicFilters({
        title: r.title, cleanText: text, signals: det.signals,
        externalLinkCount: det.links.filter(u => {
          try { return new URL(u).hostname.replace(/^www\./, '') !== hostOf(r.source_id); } catch { return false; }
        }).length,
        isMandatory: cls.length > 0,
        alreadySentNoUpdate: r.ever_sent > 0,
        duplicateCanonical: r.dup_canonical > 0,
      });
      if (hit) { decision = 'filter'; rule = hit.ruleId; reason = hit.reason; }
    } catch (e: any) {
      // 反向保护闸门触发 → 转人工，绝不静默过滤（PRD 8.3）
      decision = 'escalate'; rule = 'GUARD'; reason = e.message;
      errors.push(`${r.source_id}: ${e.message}`);
    }
  }

  results.push({ decision, cls, rule, reason, late: isLate, r });
  if (!PREVIEW && runId)
    insCand.run(runId, r.vid, originKey, isLate ? 1 : 0,
      isLate ? `补录（RSS 延迟）：原窗口 ${originKey}，首次发现 ${r.first_seen_at}` : null,
      JSON.stringify(cls), decision, cls[0] ?? 'none', rule ?? null, reason ?? null, nowIso());
};

if (!PREVIEW && runId) {
  db.transaction(() => {
    for (const r of current) judge(r, false, win.key);
    for (const r of late) judge(r, true, r.origin.key);
  })();
} else {
  for (const r of current) judge(r, false, win.key);
  for (const r of late) judge(r, true, r.origin.key);
}

// ---- 报告 ----
const by = (p: (o: Out) => boolean) => results.filter(p);
console.log(`当前窗口条目 ${current.length} 条，补录 ${late.length} 条` +
            (backfill ? `（另有 ${backfill} 条属上线前存量，不计为补录）` : '') + '\n');
console.log('判定结果：');
for (const d of ['retain', 'normal', 'escalate', 'filter']) {
  const n = by(o => o.decision === d).length;
  if (n) console.log(`  ${d.padEnd(10)} ${n}`);
}
const retained = by(o => o.decision === 'retain');
if (retained.length) {
  console.log('\n强制保留候选：');
  for (const o of retained.slice(0, 15))
    console.log(`  [${o.cls.join('')}] ${o.r.source_id.padEnd(10)} ${o.r.title.slice(0, 44)}`);
}
if (late.length) {
  console.log('\n补录条目（PRD 6.3 必须展示原时间/原窗口/首次发现）：');
  for (const o of by(o => o.late).slice(0, 12))
    console.log(`  ${o.r.source_id.padEnd(11)} 原发布 ${String(o.r.published_at).slice(0, 16)}` +
                ` 原窗口 ${o.r.origin_window_key} 首见 ${o.r.first_seen_at.slice(0, 16)}  ${o.decision}`);
}
const byRule: Record<string, number> = {};
for (const o of by(o => o.decision === 'filter')) byRule[o.rule!] = (byRule[o.rule!] ?? 0) + 1;
if (Object.keys(byRule).length)
  console.log('\n过滤规则命中：' + Object.entries(byRule).map(([k, v]) => `${k}×${v}`).join('  '));
if (errors.length) {
  console.log(`\n⚠️  ${errors.length} 条触发反向保护闸门，已转人工：`);
  errors.slice(0, 5).forEach(e => console.log('   ' + e));
}
if (!PREVIEW && runId) {
  db.prepare(`UPDATE runs SET status='succeeded', stage='filtering', finished_at=? WHERE id=?`)
    .run(nowIso(), runId);
  insAudit.run(runId, 'run', String(runId), 'candidates_built',
    JSON.stringify({ current: current.length, late: late.length,
                     retain: by(o => o.decision === 'retain').length }), nowIso());
  console.log(`\n已写入 run #${runId}`);
} else {
  console.log('\n(预览模式，未落库)');
}
db.close();
