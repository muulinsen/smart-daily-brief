#!/usr/bin/env node
import { candidateEligibleSql } from '../../../packages/db/src/eligibility.ts';
/**
 * 用当前规则重算升级判定（不调模型）。
 *
 *   node apps/worker/src/reapply.ts --run 2
 *   node apps/worker/src/reapply.ts --run 2 --dry
 *
 * 存在的理由：模型的原始判定（decision/confidence/importance/event_key）
 * 已存在 evaluations.result_json，而 ESC-001～008 是确定性后处理。
 * 规则调整后若必须重新调模型才能生效，等于每次改规则都要重新付费 ——
 * 这会让人不敢调规则。重算把「模型判断」与「规则判断」解耦。
 *
 * 注意：只重算规则层。模型自身的判定不变，要改那个才需要重跑 triage。
 */
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { isHighRisk } from '../../../packages/domain/src/risk.ts';
import { decideEscalation, type Candidate, type TriageDeps } from '../../../packages/ai/src/triage.ts';
import type { TriageResult } from '../../../packages/ai/src/schema.ts';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const runArg = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;

hydrateEnv();
const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();

const run = (runArg
  ? db.prepare('SELECT * FROM runs WHERE id=?').get(runArg)
  : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()) as any;
if (!run) { console.log('没有可用的 run'); db.close(); process.exit(0); }

type Row = {
  cid: number; source_id: string; title: string; body: string;
  prescreen_json: string | null; signals_json: string | null;
  decision: string; result_json: string | null; escalation_reasons: string | null;
};
const rows = db.prepare(`
  SELECT c.id cid, f.source_id, v.title,
         coalesce(v.fulltext_text, v.clean_text) body,
         v.prescreen_json, v.signals_json, c.decision,
         e.result_json, e.escalation_reasons
  FROM candidates c
  JOIN item_versions v ON v.id = c.item_version_id
  JOIN feed_items f ON f.id = v.item_id
  JOIN evaluations e ON e.candidate_id = c.id AND e.stage = 'luna'
  WHERE ${candidateEligibleSql()} AND c.run_id = ? AND e.result_json IS NOT NULL
  ORDER BY c.id`).all(run.id) as Row[];

if (!rows.length) { console.log(`run #${run.id} 没有可重算的判定（先跑 triage）`); db.close(); process.exit(0); }

// decideEscalation 只用到这几个字段，其余填占位值
const deps = {
  isHighRisk,
  majorNewsTypes: rules.major_news_types ?? [],
} as unknown as TriageDeps;

const upd = db.prepare(`UPDATE candidates SET decision=? WHERE id=?`);
const updEval = db.prepare(`UPDATE evaluations SET escalation_reasons=?
  WHERE candidate_id=? AND stage='luna'`);
const audit = db.prepare(`INSERT INTO audit_events
  (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`);

let changed = 0, freed = 0, added = 0;
const detail: string[] = [];

const apply = () => {
  for (const r of rows) {
    let model: TriageResult;
    try { model = JSON.parse(r.result_json!); } catch { continue; }
    if (!model?.decision) continue;

    const c: Candidate = {
      candidateId: `c${r.cid}`, sourceId: r.source_id, sourceKind: '',
      title: r.title, publishedAt: null, url: null, body: r.body,
      signals: [], repos: [], officialLinks: [],
      prescreenClasses: r.prescreen_json ? JSON.parse(r.prescreen_json) : [],
      contentHash: '',
    };
    const esc = decideEscalation(c, model, deps);
    const next = esc.escalate ? 'escalate' : model.decision;
    const wasEsc = (r.escalation_reasons ? JSON.parse(r.escalation_reasons) : []) as string[];

    if (next === r.decision && JSON.stringify(esc.rules) === JSON.stringify(wasEsc)) continue;
    changed++;
    if (r.decision === 'escalate' && next !== 'escalate') { freed++; detail.push(`  ↓ ${r.title.slice(0, 34)}  → ${next}`); }
    if (r.decision !== 'escalate' && next === 'escalate') { added++; detail.push(`  ↑ ${r.title.slice(0, 34)}  → escalate (${esc.rules.join(' ')})`); }

    if (!DRY) {
      upd.run(next, r.cid);
      updEval.run(esc.rules.length ? JSON.stringify(esc.rules) : null, r.cid);
    }
  }
};

if (DRY) apply(); else db.transaction(apply)();

const dist = db.prepare(`SELECT decision, count(*) c FROM candidates WHERE run_id=? GROUP BY 1`).all(run.id) as any[];
console.log(`run #${run.id} ${run.window_key} | 规则版本 ${rules.meta.rule_version} | 重算 ${rows.length} 条判定`);
console.log(`变更 ${changed} 条：解除升级 ${freed}，新增升级 ${added}`);
detail.slice(0, 12).forEach(d => console.log(d));
console.log(`\n当前分布：${dist.map(d => `${d.decision}=${d.c}`).join('  ')}`);

if (!DRY && changed) {
  audit.run(run.id, 'run', String(run.id), 'escalation_reapplied',
    JSON.stringify({ changed, freed, added, ruleVersion: rules.meta.rule_version }), nowIso());
}
console.log(DRY ? '\n(--dry，未落库)' : '');
db.close();
