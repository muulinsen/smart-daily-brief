#!/usr/bin/env node
import { candidateEligibleSql } from '../../../packages/db/src/eligibility.ts';
/**
 * L1 判定 CLI —— 把编排器接到数据库。
 *
 *   node apps/worker/src/triage.ts                 处理最新 run 的候选
 *   node apps/worker/src/triage.ts --run 3
 *   node apps/worker/src/triage.ts --dry           不落库，只报告
 *
 * 默认 AI_PROVIDER=mock，不需要任何 key 即可跑通全链路。
 */
import { readFileSync } from 'node:fs';
import { openDb, nowIso, sha256, type DB } from '../../../packages/db/src/index.ts';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { isHighRisk } from '../../../packages/domain/src/risk.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { tierConfigOrExit } from '../../../packages/web/src/model-runtime.ts';
import { loadModelSnapshot } from '../../../packages/ai/src/model-config.ts';
import { runTriage, type Candidate, type TriageDeps } from '../../../packages/ai/src/triage.ts';
import type { TriageResult } from '../../../packages/ai/src/schema.ts';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const RETRY_REUSED = argv.includes('--retry-reused');
const runArg = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;

// 把后台设置的供应商与 API key 注入 env（环境变量优先）
const vault = hydrateEnv();
if (vault.error) console.warn(`密钥保管库不可用：${vault.error}`);

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();

// ---- run ----
const run = (runArg
  ? db.prepare('SELECT * FROM runs WHERE id=?').get(runArg)
  : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()) as any;
if (!run) { console.log('没有可处理的 run，先跑 candidates.ts'); db.close(); process.exit(0); }

// ---- Prompt 版本化（PRD 15.2 / FR-045）----
const promptText = readFileSync('./config/prompts/triage.md', 'utf8');
const promptHash = sha256(promptText).slice(0, 16);
const promptVersion = `triage-v${rules.meta.rule_version}-${promptHash.slice(0, 8)}`;
if (!DRY) {
  db.prepare(`INSERT INTO prompt_versions (name,version,schema_hash,content_hash,content,active,created_at)
    VALUES ('triage',?,?,?,?,1,?) ON CONFLICT(name,version) DO NOTHING`)
    .run(promptVersion, promptHash, promptHash, promptText, nowIso());
}

// ---- 取候选：确定性过滤已淘汰的不再送 AI（PRD 8.1 顺序）----
type Row = {
  cid: number; vid: number; source_id: string; category: string; title: string;
  clean_text: string; fulltext_text: string | null; canonical_url: string | null;
  published_at: string | null; signals_json: string | null; prescreen_json: string | null;
  content_hash: string; decision: string | null;
};
const successfulReuse = `e.stage='luna' AND e.prompt_version=? AND e.response_id IS NULL
  AND e.result_json IS NOT NULL AND json_extract(e.result_json,'$.error') IS NULL
  AND json_extract(e.result_json,'$.decision') IS NOT NULL`;
const rows = db.prepare(`
  SELECT c.id cid, c.item_version_id vid, f.source_id, s.category, v.title,
         v.clean_text, v.fulltext_text, f.canonical_url, f.published_at,
         v.signals_json, v.prescreen_json, v.content_hash, c.decision
  FROM candidates c
  JOIN item_versions v ON v.id = c.item_version_id
  JOIN feed_items f ON f.id = v.item_id
  JOIN sources s ON s.id = f.source_id
  WHERE ${candidateEligibleSql()} AND c.run_id = ? AND (
      c.decision IS NULL OR c.decision IN ('retain','normal','escalate')
      ${RETRY_REUSED ? `OR (c.decision='filter' AND EXISTS
        (SELECT 1 FROM evaluations er WHERE er.candidate_id=c.id AND
         ${successfulReuse.replaceAll('e.', 'er.')}))` : ''}
    )
    AND NOT EXISTS (SELECT 1 FROM evaluations e
                    WHERE e.candidate_id = c.id AND e.stage IN ('luna','terra','sol')
                      AND e.result_json IS NOT NULL
                      AND json_extract(e.result_json,'$.error') IS NULL
                      AND json_extract(e.result_json,'$.decision') IS NOT NULL
                      ${RETRY_REUSED ? `AND NOT (${successfulReuse})` : ''})
  ORDER BY c.id`).all(...(RETRY_REUSED
    ? [run.id, promptVersion, promptVersion]
    : [run.id])) as Row[];

if (!rows.length) { console.log(`run #${run.id} (${run.window_key}) 没有待判定候选`); db.close(); process.exit(0); }

const cands: Candidate[] = rows.map(r => {
  const sig = r.signals_json ? JSON.parse(r.signals_json) as Record<string, boolean> : {};
  return {
    candidateId: `c${r.cid}`,
    sourceId: r.source_id,
    sourceKind: r.category,
    title: r.title,
    publishedAt: r.published_at,
    url: r.canonical_url,
    body: r.fulltext_text || r.clean_text,
    signals: Object.entries(sig).filter(([, v]) => v).map(([k]) => k),
    repos: [], officialLinks: [],
    prescreenClasses: r.prescreen_json ? JSON.parse(r.prescreen_json) : [],
    // 某些“每日汇总”RSS 的多条子消息共享正文，但标题不同；只按正文哈希
    // 会把 A 消息的事件键复用给 B 消息，造成错误聚类和跨窗口过滤。
    contentHash: sha256(`${r.content_hash}\0${r.title.trim().toLowerCase()}`),
  };
});

// ---- 指纹复用缓存：同内容此前已有合格结果就不再调模型（PRD 15.2）----
const cachedByHash = new Map<string, TriageResult>();
for (const e of db.prepare(`
  SELECT v.content_hash h, v.title, e.result_json j FROM evaluations e
  JOIN candidates c ON c.id = e.candidate_id
  JOIN item_versions v ON v.id = c.item_version_id
  WHERE e.stage='luna' AND e.prompt_version=? AND e.result_json IS NOT NULL
    AND json_extract(e.result_json,'$.error') IS NULL
    AND json_extract(e.result_json,'$.decision') IS NOT NULL
    ${RETRY_REUSED ? 'AND e.response_id IS NOT NULL' : ''}`)
  .all(promptVersion) as any[]) {
  try {
    const key = sha256(`${e.h}\0${String(e.title).trim().toLowerCase()}`);
    cachedByHash.set(key, JSON.parse(e.j));
  } catch { /* 损坏的记录跳过 */ }
}

// ---- 供应商 ----
const cfg = tierConfigOrExit(loadModelSnapshot(db as any), 'L1');
const provider = await createProvider(cfg);
const budget = rules.ai?.budget_per_run?.luna ?? {};

const deps: TriageDeps = {
  provider,
  systemPrompt: promptText,
  budget: {
    inputTokensMax: budget.input_tokens_max ?? 50000,
    outputTokensMax: budget.output_tokens_max ?? 8000,
    batchSize: Number(process.env.AI_BATCH_SIZE ?? 8),
    bodyCharsMax: rules.ai?.input_minimization?.body_chars_max ?? 8000,
  },
  cachedByHash,
  isHighRisk,
  majorNewsTypes: rules.major_news_types ?? [],
  invalidFilterReasonFragments: rules.ai_filter_guard?.invalid_reason_fragments ?? [],
};

console.log(`run #${run.id} ${run.window_key} | 供应商 ${cfg.provider}${cfg.model ? '/' + cfg.model : ''} | Prompt ${promptVersion}`);
console.log(`待判定 ${cands.length} 条，指纹缓存 ${cachedByHash.size} 条\n`);

const report = await runTriage(cands, deps);

// ---- 落库 ----
if (!DRY) {
  const insEval = db.prepare(`INSERT INTO evaluations
    (candidate_id,stage,model,prompt_version,response_id,input_tokens,output_tokens,
     result_json,escalation_reasons,confidence,created_at)
    VALUES (?,'luna',?,?,?,?,?,?,?,?,?)`);
  const updCand = db.prepare(`UPDATE candidates SET decision=?, mandatory_class=?,
    section=?, filter_reason=COALESCE(?,filter_reason) WHERE id=?`);
  const insAudit = db.prepare(`INSERT INTO audit_events
    (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`);

  db.transaction(() => {
    for (const o of report.outcomes) {
      const cid = Number(o.candidateId.slice(1));
      insEval.run(cid, provider.model, promptVersion, o.responseId ?? null,
        null, null,
        o.result ? JSON.stringify(o.result) : JSON.stringify({ error: o.error }),
        o.escalationRules.length ? JSON.stringify(o.escalationRules) : null,
        o.result?.confidence ?? null, nowIso());

      if (o.result) {
        // 需要升级的不直接采信 L1 判定，标为 escalate 等 L2/L3
        const decision = o.escalate ? 'escalate' : o.result.decision;
        updCand.run(decision, o.result.mandatory_class, o.result.section,
                    o.result.filter_reason, cid);
      } else {
        updCand.run('escalate', null, null, null, cid);
        insAudit.run(run.id, 'candidate', String(cid),
          o.status === 'skipped' ? 'budget_skipped' : 'ai_manual_audit',
          JSON.stringify({ error: o.error, status: o.status }), nowIso());
      }
    }
  })();
}

// ---- 报告 ----
const by = (s: string) => report.outcomes.filter(o => o.status === s).length;
console.log(`调用 ${report.calls} 次` + (report.budgetStopped ? '  ⏸ 已达上限，剩余转人工' : ''));
console.log(`结果：模型判定 ${by('ok')} | 指纹复用 ${by('reused')} | 转人工 ${by('manual_audit')} | 预算跳过 ${by('skipped')}`);

const dec: Record<string, number> = {};
for (const o of report.outcomes) {
  const d = o.result ? (o.escalate ? 'escalate' : o.result.decision) : 'escalate';
  dec[d] = (dec[d] ?? 0) + 1;
}
console.log('判定分布：' + Object.entries(dec).map(([k, v]) => `${k}=${v}`).join('  '));

const escRules: Record<string, number> = {};
for (const o of report.outcomes) for (const r of o.escalationRules) escRules[r] = (escRules[r] ?? 0) + 1;
if (Object.keys(escRules).length)
  console.log('升级规则命中：' + Object.entries(escRules).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`).join('  '));

const retained = report.outcomes.filter(o => o.result?.mandatory_class && o.result.mandatory_class !== 'none');
if (retained.length) {
  console.log('\n强制保留判定：');
  for (const o of retained.slice(0, 12)) {
    const r = rows.find(x => `c${x.cid}` === o.candidateId)!;
    console.log(`  [${o.result!.mandatory_class}] ${r.source_id.padEnd(10)} ${r.title.slice(0, 42)}`);
  }
}
const manual = report.outcomes.filter(o => o.status === 'manual_audit');
if (manual.length) {
  console.log(`\n⚠️  ${manual.length} 条转人工审计：`);
  for (const o of manual.slice(0, 5)) console.log(`   ${o.candidateId}: ${o.error?.slice(0, 70)}`);
}
console.log(DRY ? '\n(--dry，未落库)' : '');
db.close();
