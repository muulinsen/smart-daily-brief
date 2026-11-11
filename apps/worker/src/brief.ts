#!/usr/bin/env node
import { candidateEligibleSql, eligibilitySignature, assertEligibilityUnchanged } from '../../../packages/db/src/eligibility.ts';
/**
 * 简报组装与投递（PRD 9 / 12.1 后半段）。
 *
 *   node apps/worker/src/brief.ts --run 3            组装并按配置投递
 *   node apps/worker/src/brief.ts --run 3 --no-send  只组装与预览，不投递
 *   node apps/worker/src/brief.ts --run 3 --shadow   影子投递（带 X-Brief-Environment）
 *
 * 组装是幂等的：同一 run 已有 final 简报时不重复生成，
 * 投递由 deliveries 唯一键兜底，重跑不会重复发送（PRD 12.3 / 24.1-P0）。
 */
import { readFileSync } from 'node:fs';
import { openDb, nowIso, sha256, type DB } from '../../../packages/db/src/index.ts';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { windowFromKey } from '../../../packages/domain/src/normalize.ts';
import { clusterCandidates, excludeCoveredToday, selectForBrief, type ClusterInput }
  from '../../../packages/domain/src/cluster.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { tierConfigOrExit } from '../../../packages/web/src/model-runtime.ts';
import { loadModelSnapshot } from '../../../packages/ai/src/model-config.ts';
import { runCompose, type ComposeInput } from '../../../packages/ai/src/compose.ts';
import { resolveSemanticDuplicates } from '../../../packages/ai/src/semantic-dedup.ts';
import { renderHtml, renderText, checkEmail, subjectOf, type BriefData, type BriefItem }
  from '../../../packages/templates/src/email.ts';
import { deliver } from '../../../packages/templates/src/delivery.ts';
import { mailerFromEnv } from '../../../packages/templates/src/mailer.ts';

const argv = process.argv.slice(2);
const NO_SEND = argv.includes('--no-send');
const SHADOW = argv.includes('--shadow');
const REGENERATE = argv.includes('--regenerate');
const ALLOW_PARTIAL = argv.includes('--allow-partial');
const comparisonArg = argv.includes('--comparison-label') ? argv[argv.indexOf('--comparison-label') + 1] : null;
if (comparisonArg && comparisonArg !== '旧版' && comparisonArg !== '优化版' && comparisonArg !== '优化修正版')
  throw new Error('--comparison-label 仅接受“旧版”“优化版”或“优化修正版”');
const COMPARISON_LABEL = comparisonArg as BriefData['comparisonLabel'];
const runArg = argv.includes('--run') ? Number(argv[argv.indexOf('--run') + 1]) : null;
// 新流程（semantic_dedup）：本次尝试的触发来源与绝对截止时间，由 run.ts 传入
const triggerArg = argv.includes('--trigger') ? argv[argv.indexOf('--trigger') + 1] : 'manual';
if (triggerArg !== 'timer' && triggerArg !== 'manual') throw new Error('--trigger 仅接受 timer 或 manual');
const deadlineArg = argv.includes('--deadline') ? Date.parse(String(argv[argv.indexOf('--deadline') + 1])) : NaN;

// 把后台设置的供应商与 API key 注入 env（环境变量优先）
const vault = hydrateEnv();
if (vault.error) console.warn(`密钥保管库不可用：${vault.error}`);

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const rules = loadRules();
const OUT_DIR = process.env.MAIL_OUT_DIR ?? './data/outbox';

const run = (runArg
  ? db.prepare('SELECT * FROM runs WHERE id=?').get(runArg)
  : db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get()) as any;
if (!run) { console.log('没有可用的 run'); db.close(); process.exit(0); }

const initialEligibility = eligibilitySignature(db,run.id);
function checkEligibility() {
  try { assertEligibilityUnchanged(db,run.id,initialEligibility); }
  catch(e:any) {
    db.prepare("UPDATE runs SET status='partial',error=? WHERE id=?").run(e.message,run.id);
    db.prepare("INSERT INTO audit_events(run_id,entity_type,entity_id,action,payload_json,created_at) VALUES(?,'run',?,'brief_eligibility_changed',?,?)").run(run.id,String(run.id),JSON.stringify({error:e.message}),nowIso());
    throw e;
  }
}
const win = windowFromKey(run.window_key);
const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

// ---------- 新版日报（官方动态 / 开源项目 / 时政速览） ----------
// rules.yaml brief.format = digest_v2 时走新流程；改回 legacy 即恢复下方旧版分区简报。
if (rules.brief?.format === 'digest_v2') {
  const { runDigestBrief } = await import('./brief-digest.ts');
  const code = await runDigestBrief({ db, run, win, rules, noSend: NO_SEND, shadow: SHADOW,
    regenerate: REGENERATE, outDir: OUT_DIR, trigger: triggerArg, deadlineMs: Number.isFinite(deadlineArg) ? deadlineArg : null });
  db.close(); process.exit(code);
}

// ---------- 1. 取候选与判定 ----------
type Row = {
  cid: number; vid: number; source_id: string; category: string; priority: number;
  title: string; body: string; url: string | null; published_at: string | null;
  display_name: string; site_url: string | null;
  decision: string; mandatory_class: string | null; section: string | null;
  late_discovery: number; origin_window_key: string; first_seen_at: string;
  signals_json: string | null; filter_rule_id: string | null; filter_reason: string | null;
  is_official: number; result_json: string | null;
  compose_json: string | null;
};
const rows = db.prepare(`
  SELECT c.id cid, c.item_version_id vid, f.source_id, s.category, s.priority,
         s.display_name, s.site_url,
         v.title, coalesce(v.fulltext_text, v.clean_text) body,
         f.canonical_url url, f.published_at, c.decision, c.mandatory_class, c.section,
         c.late_discovery, c.origin_window_key, f.first_seen_at,
         v.signals_json, c.filter_rule_id, c.filter_reason,
         coalesce(s.is_official,0) is_official,
         (SELECT e.result_json FROM evaluations e WHERE e.candidate_id=c.id
           AND e.stage IN ('sol','terra','luna')
           ORDER BY CASE e.stage WHEN 'sol' THEN 0 WHEN 'terra' THEN 1 ELSE 2 END, e.id DESC LIMIT 1) result_json
         ,(SELECT e.result_json FROM evaluations e WHERE e.candidate_id=c.id
           AND e.stage='compose' ORDER BY e.id DESC LIMIT 1) compose_json
  FROM candidates c
  JOIN item_versions v ON v.id=c.item_version_id
  JOIN feed_items f ON f.id=v.item_id
  JOIN sources s ON s.id=f.source_id
  WHERE ${candidateEligibleSql()} AND c.run_id=?`).all(run.id) as Row[];

if (!rows.length) { console.log(`run #${run.id} 没有候选`); db.close(); process.exit(0); }

// 完整性门禁：任何未完成 AI 判定的候选都会让简报失真。除非人工明确
// 使用 --allow-partial，本期不得持久化、发送或被标记为 succeeded。
const unresolved = rows.filter(r => r.decision == null || r.decision === 'escalate');
const maxUnresolved = Number(rules.brief?.completeness_gate?.max_unresolved ?? 0);
if (!ALLOW_PARTIAL && unresolved.length > maxUnresolved) {
  const nullCount = unresolved.filter(r => r.decision == null).length;
  const pendingCount = unresolved.length - nullCount;
  const message = `完整性门禁阻断：未判定 ${nullCount} 条，待复核 ${pendingCount} 条`;
  db.prepare(`UPDATE runs SET status='partial',stage='review',error=?,finished_at=? WHERE id=?`)
    .run(message, nowIso(), run.id);
  db.prepare(`INSERT INTO audit_events
    (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(run.id, 'run', String(run.id), 'brief_completeness_blocked',
      JSON.stringify({ unresolved: unresolved.length, nullCount, pendingCount, maxUnresolved }), nowIso());
  console.error(`❌ ${message}；拒绝生成或发送残缺简报`);
  db.close(); process.exit(2);
}

const included = rows.filter(r => r.decision === 'retain' || r.decision === 'normal');
const parseEval = (r: Row) => { try { return r.result_json ? JSON.parse(r.result_json) : null; } catch { return null; } };
const parseCompose = (r: Row) => { try { return r.compose_json ? JSON.parse(r.compose_json) : null; } catch { return null; } };

// ---------- 2. 聚类与排序 ----------
const inputs: ClusterInput[] = included.map(r => {
  const e = parseEval(r);
  const sig = r.signals_json ? JSON.parse(r.signals_json) as Record<string, boolean> : {};
  return {
    candidateId: `c${r.cid}`, sourceId: r.source_id, title: r.title, url: r.url,
    publishedAt: r.published_at,
    eventKey: e?.event_key ?? `solo-${r.cid}`,
    section: r.section ?? e?.section ?? 'ai_tech',
    decision: r.decision, mandatoryClass: r.mandatory_class ?? 'none',
    confidence: e?.confidence ?? 0.5,
    importance: e?.importance ?? 0.5, novelty: e?.novelty ?? 0.5,
    signals: Object.entries(sig).filter(([, v]) => v).map(([k]) => k),
    sourcePriority: r.priority ?? 5, isOfficial: !!r.is_official,
  };
});
const cfg = tierConfigOrExit(loadModelSnapshot(db as any), 'L1');
const provider = await createProvider(cfg);
const dedupProvider = await createProvider({ ...cfg, timeoutMs: 15000 });
const semantic = await resolveSemanticDuplicates(inputs.map(i => ({
  candidateId: i.candidateId, title: i.title, body: rows.find(r => `c${r.cid}` === i.candidateId)?.body ?? '',
  eventKey: i.eventKey, section: i.section, mandatoryClass: i.mandatoryClass,
})), dedupProvider, {
  onDecision: d => {
    console.log(`语义去重 ${d.candidateA}/${d.candidateB}: ${d.sameEvent ? '同一事件' : '不同事件'}${d.error ? `（${d.error}）` : ''}`);
    db.prepare(`INSERT INTO audit_events
      (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(run.id, 'semantic_dedup', `${d.candidateA}:${d.candidateB}`, 'semantic_duplicate_decision',
        JSON.stringify({ ...d, provider: provider.name }), nowIso());
  },
});
const semanticKeys = new Map(semantic.items.map(i => [i.candidateId, i.eventKey]));
const clusters = clusterCandidates(inputs.map(i => ({ ...i, eventKey: semanticKeys.get(i.candidateId) ?? i.eventKey })));

// 同一台北自然日跨窗口去重：早报出现后，午报/晚报的同义转述不再进入正文。
// 只查已经实际发送的简报，发送失败或草稿不能占掉后续窗口的事件。
const day = run.window_key.slice(0, 10);
const previousToday = db.prepare(`
  SELECT bi.title, bi.source_url sourceUrl, sc.cluster_key clusterKey
  FROM brief_items bi
  JOIN briefs b ON b.id=bi.brief_id AND b.status='final'
  JOIN runs pr ON pr.id=b.run_id
  JOIN story_clusters sc ON sc.id=bi.story_cluster_id
  WHERE pr.id<>? AND pr.window_key LIKE ? AND pr.window_end_at < ?
    AND EXISTS (SELECT 1 FROM deliveries d WHERE d.brief_id=b.id AND d.status='sent')
  ORDER BY pr.window_end_at`).all(run.id, `${day}:%`, run.window_end_at) as
  Array<{ title: string; clusterKey: string; sourceUrl: string | null }>;
const daily = excludeCoveredToday(clusters, previousToday);
if (daily.covered.length) {
  const mark = db.prepare(`UPDATE candidates SET decision='filter',filter_rule_id='DF-047',
    filter_reason='同一事件已在当天较早窗口推送，本窗口不再重复' WHERE id=?`);
  db.transaction(() => {
    for (const x of daily.covered) {
      for (const m of [x.cluster.primary, ...x.cluster.members]) {
        mark.run(Number(m.candidateId.slice(1)));
        const row = rows.find(r => r.cid === Number(m.candidateId.slice(1)));
        if (row) {
          row.decision = 'filter'; row.filter_rule_id = 'DF-047';
          row.filter_reason = '同一事件已在当天较早窗口推送，本窗口不再重复';
        }
      }
      console.log(`  ↪ 当日去重：${x.cluster.primary.title}（较早窗口：${x.previous.title}）`);
    }
  })();
}
const { selected, dropped } = selectForBrief(daily.fresh);

console.log(`run #${run.id} ${run.window_key} ${run.window_label}`);
console.log(`候选 ${rows.length} → 入选候选 ${included.length} → 聚类 ${clusters.length}` +
  ` → 当日重复 ${daily.covered.length} → 选中 ${selected.length}`);

if (!selected.length) {
  // PRD 9.1：合格内容不足时允许少于 5 条，禁止用旧消息凑数 —— 一条不够也如实反映
  console.log('本窗口没有达标内容。按 PRD 9.1，不用旧消息凑数。');
}

/**
 * 来源证据：给 compose 模型判断「该不该点明来源局限」的确定性依据。
 *
 * 这些是程序能确定的事实（有没有官方链接、来源是论坛还是官方文档），
 * 不是判断结论 —— 说不说、怎么说由模型按 compose.md 的表格决定。
 * 交给模型自己从正文猜来源性质会猜错，所以由程序给出。
 */
function sourceEvidence(r: Row): Record<string, boolean | string> {
  let sig: Record<string, unknown> = {};
  try { sig = r.signals_json ? JSON.parse(r.signals_json) : {}; } catch { /* 信号缺失不致命 */ }
  return {
    source_kind: r.category ?? 'unknown',
    is_official_source: !!r.is_official,
    has_official_link: !!sig.has_official_link || !!sig.official_domain,
    has_repo_link: !!sig.has_repo,
    has_reproducible_method: !!sig.has_steps || !!sig.has_code,
    is_personal_account: !!sig.first_person || r.category === 'forum' || r.category === 'social',
  };
}

// ---------- 3. 生成文案 ----------
const byCid = new Map(rows.map(r => [`c${r.cid}`, r]));
const composeInputs: ComposeInput[] = selected.map(c => {
  const r = byCid.get(c.primary.candidateId)!;
  const e = parseEval(r);
  const cached = parseCompose(r);
  const prepared = cached?.conclusion && cached?.summary_sentences?.length >= 2 ? cached
    : e?.conclusion && e?.summary_sentences?.length >= 2 ? e : null;
  return {
    candidateId: c.primary.candidateId,
    sourceName: r.source_id, sourceUrl: r.url, title: r.title, body: r.body,
    section: c.section, mandatoryClass: c.mandatoryClass,
    contributions: c.members.map(m => ({ sourceName: m.sourceId, url: m.url })),
    sourceLimitations: e?.source_limitations ?? [],
    sourceEvidence: sourceEvidence(r),
    precomposed: prepared
      ? { title: prepared.title, conclusion: prepared.conclusion,
          summarySentences: prepared.summary_sentences } : null,
  };
});

const composePromptText = readFileSync('./config/prompts/compose.md', 'utf8');
const composePromptVersion = `compose-v${rules.meta.rule_version}-${sha256(composePromptText).slice(0, 8)}`;
const composed = composeInputs.length
  ? await runCompose(composeInputs, {
      provider, systemPrompt: composePromptText,
      batchSize: Number(process.env.AI_COMPOSE_BATCH_SIZE ?? 4), bodyCharsMax: 4000,
      interBatchDelayMs: Number(process.env.AI_COMPOSE_BATCH_DELAY_MS ?? 0),
      outputTokensMax: rules.ai?.budget_per_run?.luna?.output_tokens_max ?? 8000,
      forbiddenFields: rules.brief?.item_fields_forbidden ?? [],
    })
  : { outcomes: [], usedInput: 0, usedOutput: 0, calls: 0 };

const copy = new Map(composed.outcomes.filter(o => o.result).map(o => [o.candidateId, o.result!]));
const composeFailed = composed.outcomes.filter(o => !o.result);
// 成功文案跨重试缓存。供应商限流时补发可能需多轮完成；若只放内存，
// 每轮都会重做已经成功的批次，既浪费额度又更容易再次触发限流。
const newlyComposed = composed.outcomes.filter(o => o.status === 'ok' && o.result);
if (newlyComposed.length) {
  const exists = db.prepare(`SELECT 1 FROM evaluations
    WHERE candidate_id=? AND stage='compose' AND prompt_version=? LIMIT 1`);
  const insert = db.prepare(`INSERT INTO evaluations
    (candidate_id,stage,model,prompt_version,result_json,created_at)
    VALUES (?,'compose',?,?,?,?)`);
  db.transaction(() => {
    for (const o of newlyComposed) {
      const cid = Number(o.candidateId.slice(1));
      if (!exists.get(cid, composePromptVersion))
        insert.run(cid, provider.model, composePromptVersion, JSON.stringify(o.result), nowIso());
    }
  })();
  console.log(`文案缓存：新增 ${newlyComposed.length} 条，后续重试直接复用`);
}
if (composed.calls)
  console.log(`文案：调用 ${composed.calls} 次，复用 ${composed.outcomes.filter(o => o.status === 'reused').length} 条`);
if (composeFailed.length) console.log(`⚠️  ${composeFailed.length} 条文案生成失败，已从简报中剔除并转人工`);
if (REGENERATE && composeFailed.length) {
  console.error('❌ 补发要求完整成稿：存在文案失败，拒绝持久化或发送残缺简报');
  db.close(); process.exit(1);
}

// ---------- 4. 组装 BriefData ----------
const SECTIONS = rules.brief?.sections ?? [];
const sectionTitle = (id: string) =>
  SECTIONS.find((s: any) => s.id === id)?.title ?? id;

const items: Array<BriefItem & { section: string; score: number }> = [];
for (const c of selected) {
  const r = byCid.get(c.primary.candidateId)!;
  const cp = copy.get(c.primary.candidateId);
  if (!cp) continue;                                     // 文案失败的不进简报
  items.push({
    section: c.section,
    title: cp.title || r.title,
    conclusion: cp.conclusion,
    summarySentences: cp.summary_sentences,
    sourceName: r.display_name || r.source_id,
    sourceSite: r.site_url,
    sourceUrl: r.url,
    score: c.score,
    otherSources: c.members.map(m => {
      const mr = byCid.get(m.candidateId);
      return { name: mr?.display_name || m.sourceId, site: mr?.site_url ?? null };
    }),
    lateDiscovery: r.late_discovery ? {
      originWindow: r.origin_window_key,
      publishedAt: String(r.published_at ?? '').slice(0, 16).replace('T', ' '),
      firstSeenAt: String(r.first_seen_at).slice(0, 16).replace('T', ' '),
    } : null,
  });
}

// 用户已明确永久关闭“核心要点”；正文分区本身即为完整内容，避免同一条
// 在邮件顶部和正文重复展示。保留 BriefData 字段为空以兼容历史渲染器。
const highlights: string[] = [];

// 审计区（PRD 9.3）
const filtered = rows.filter(r => r.decision === 'filter');
const byRule: Record<string, number> = {};
for (const f of filtered) byRule[f.filter_rule_id ?? '其他'] = (byRule[f.filter_rule_id ?? '其他'] ?? 0) + 1;

const mandatoryMisses = rows
  .filter(r => r.decision === 'filter' && r.mandatory_class && r.mandatory_class !== 'none')
  .map(r => ({ title: r.title, url: r.url, reason: r.filter_reason ?? r.filter_rule_id ?? '未记录原因' }));

const sourceIssues = (db.prepare(`SELECT id, display_name, site_url, health, last_error,
  consecutive_failures FROM sources WHERE enabled=1 AND archived_at IS NULL AND health IN ('failing','degraded')`).all() as any[])
  .map(s => ({ source: s.display_name || s.id, site: s.site_url,
               status: s.health === 'failing' ? '抓取失败' : '来源异常',
               detail: `${String(s.last_error ?? '').slice(0, 80)}（连续 ${s.consecutive_failures} 次）` }));

/**
 * 评估附录（影子运行期默认开启，稳定后可用 BRIEF_EVAL_APPENDIX=false 关闭）。
 *
 * 只列**本期新出现**的被过滤/待复核条目。三窗口复查会把最近三个已结束
 * 窗口的条目反复带进候选，若每期都全量重列，附录会有七成以上重复
 * （实测早报与午报重复率 71%），读起来像"和上一封差不多"，
 * 也让人工筛选无从下手。
 *
 * 每条带可引用编号 c<候选ID>。人工回复「保留 c123」后用
 * scripts/golden-mark.mjs 写入黄金集 —— 这是 PRD 24.1
 * 「强制保留召回率 ≥98%」在有黄金集之前唯一的取得基线的方式。
 */
const wantAppendix = (process.env.BRIEF_EVAL_APPENDIX ?? 'true') !== 'false';
const entry = (r: Row, reason: string) =>
  ({ ref: `c${r.cid}`, title: r.title, source: r.display_name || r.source_id,
     site: r.site_url, url: r.url, reason });

const seen = new Set((db.prepare('SELECT item_version_id v FROM appendix_seen').all() as any[])
  .map(x => x.v));
// 对照邮件必须复用旧版刚刚展示过的附录，而不能因为旧版已投递就变成空附录。
const comparisonAppendix = COMPARISON_LABEL ? new Set((db.prepare(`
  SELECT a.item_version_id v FROM appendix_seen a JOIN briefs b ON b.id=a.brief_id
  WHERE b.run_id=?`).all(run.id) as any[]).map(x => x.v)) : new Set<number>();

let evalAppendix: BriefData['evalAppendix'] = null;
let appendixNew: Row[] = [];
if (wantAppendix) {
  const fresh = (d: string) => rows.filter(r => r.decision === d
    && (!seen.has(r.vid) || comparisonAppendix.has(r.vid)));
  const filtered = fresh('filter'), pending = fresh('escalate');
  appendixNew = [...filtered, ...pending];
  const repeated = rows.filter(r => (r.decision === 'filter' || r.decision === 'escalate')
    && seen.has(r.vid) && !comparisonAppendix.has(r.vid)).length;
  evalAppendix = {
    filtered: filtered.map(r => entry(r, r.filter_reason ?? r.filter_rule_id ?? '未记录原因')),
    pending: pending.map(r => entry(r, '待复核：名额不足或需人工判断')),
    truncatedNote: repeated ? `另有 ${repeated} 条此前已在附录中列出，本期不再重复。` : null,
  };
  console.log(`附录：新增 ${appendixNew.length} 条，跳过已列过的 ${repeated} 条`);
}

const sectionData = (SECTIONS.filter((s: any) => s.id !== 'core_highlights' && s.id !== 'audit'))
  .map((s: any) => ({ id: s.id, title: s.title,
    items: items.filter(i => i.section === s.id).sort((a, b) => b.score - a.score) }));
const data: BriefData = {
  date: run.window_key.slice(0, 10),
  windowLabel: run.window_label,
  windowRange: `${fmt(win.start)}–${fmt(win.end)}`,
  highlights,
  sections: sectionData,
  comparisonLabel: COMPARISON_LABEL,
  audit: {
    mandatoryMisses,
    counts: [
      { label: '正常入选', count: items.length },
      { label: '补录', count: items.filter(i => i.lateDiscovery).length },
      { label: '已过滤', count: filtered.length },
      ...Object.entries(byRule).map(([k, v]) => ({ label: k, count: v })),
      { label: '未入选（分数不足）', count: dropped.length },
    ].filter(c => c.count > 0),
    sourceIssues,
  },
  evalAppendix,
};

// ---------- 5. 渲染与校验 ----------
// 用户要求邮件始终包含完整附录；不再按 HTML 字节数裁剪或拒绝发送。
const html = renderHtml(data);
const text = renderText(data);
const subject = subjectOf(data) + (REGENERATE && !COMPARISON_LABEL ? '｜补发' : '');
const errs = checkEmail(html, text);
if (errs.length) {
  console.error('❌ 邮件校验未通过，拒绝发送：');
  errs.forEach(e => console.error('   ' + e));
  db.close(); process.exit(1);
}
console.log(`简报：${items.length} 条 / ${Math.round(Buffer.byteLength(html, 'utf8') / 1024)} KB / 主题「${subject}」`);
if (sectionTitle('audit')) { /* 分区标题已由 rules 提供 */ }

checkEligibility();

// ---------- 6. 持久化不可变版本（FR-052） ----------
const existing = db.prepare(
  `SELECT id, version, eligibility_signature FROM briefs WHERE run_id=? ORDER BY version DESC LIMIT 1`).get(run.id) as any;
const version = (existing?.version ?? 0) + 1;
let briefId: number;

if (existing && !REGENERATE && db.prepare("SELECT 1 FROM deliveries WHERE brief_id=? AND recipient=? AND delivery_type=? AND status='sent'").get(existing.id,process.env.MAIL_TO??'',SHADOW?'shadow':'primary')) {
  console.log('本期已投递，不重复发送'); db.close(); process.exit(0);
}
if (existing && !REGENERATE && existing.eligibility_signature===initialEligibility) {
  briefId = existing.id;
  console.log(`已存在简报 #${briefId}（v${existing.version}），复用；加 --regenerate 可生成新版本`);
} else {
  briefId = Number(db.transaction(() => {
    checkEligibility();
    const id = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,html_body,
      html_bytes,status,rule_version,created_at) VALUES (?,?,?,?,?,?,'final',?,?)`)
      .run(run.id, version, subject, text, html, Buffer.byteLength(html, 'utf8'),
           rules.meta.rule_version, nowIso()).lastInsertRowid);
    db.prepare('UPDATE briefs SET eligibility_signature=? WHERE id=?').run(initialEligibility,id);
    if (existing) db.prepare(`UPDATE briefs SET status='superseded' WHERE id=?`).run(existing.id);

    const insCluster = db.prepare(`INSERT INTO story_clusters (cluster_key,canonical_title,
      current_version_hash,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(cluster_key) DO UPDATE SET canonical_title=excluded.canonical_title,
      updated_at=excluded.updated_at`);
    const getCluster = db.prepare('SELECT id FROM story_clusters WHERE cluster_key=?');
    const insMember = db.prepare(`INSERT INTO cluster_members (cluster_id,item_version_id,
      contribution,added_by,created_at) VALUES (?,?,?,'model',?)
      ON CONFLICT(cluster_id,item_version_id) DO NOTHING`);
    const insItem = db.prepare(`INSERT INTO brief_items (brief_id,story_cluster_id,version_hash,
      section,order_no,status,title,conclusion,summary_json,source_name,source_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

    let order = 0;
    for (const c of selected) {
      const cp = copy.get(c.primary.candidateId); if (!cp) continue;
      const r = byCid.get(c.primary.candidateId)!;
      insCluster.run(c.clusterKey, cp.title || r.title, String(r.vid), nowIso(), nowIso());
      const clusterId = (getCluster.get(c.clusterKey) as any).id;
      insMember.run(clusterId, r.vid, '主要来源', nowIso());
      for (const m of c.members) {
        const mr = byCid.get(m.candidateId);
        if (mr) insMember.run(clusterId, mr.vid, '补充来源', nowIso());
      }
      insItem.run(id, clusterId, String(r.vid), c.section, ++order,
        r.late_discovery ? 'late_discovery' : 'included',
        cp.title || r.title, cp.conclusion, JSON.stringify(cp.summary_sentences),
        r.source_id, r.url ?? '');
    }
    db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(run.id, 'brief', String(id), 'brief_composed',
      JSON.stringify({ items: order, htmlBytes: Buffer.byteLength(html, 'utf8'), version }), nowIso());
    return id;
  })());
  console.log(`已保存简报 #${briefId} v${version}（发送前先持久化，PRD 12.1）`);
}

// ---------- 7. 投递 ----------
const to = process.env.MAIL_TO ?? '';
if (NO_SEND) {
  console.log('--no-send：跳过投递');
} else if (!to) {
  console.log('未设置 MAIL_TO，跳过投递');
} else {
  const { mailer, kind, note } = mailerFromEnv(OUT_DIR);
  if (note) console.log(`投递通道：${kind} —— ${note}`);
  else console.log(`投递通道：${kind}`);

  checkEligibility();
  const r = await deliver(db, mailer, {
    briefId, recipient: to,
    assertEligible: checkEligibility,
    deliveryType: SHADOW ? 'shadow' : REGENERATE ? 'resend' : 'primary',
    subject, text, html,
    environment: SHADOW ? 'shadow' : undefined,
  });
  // 只有真正投递出去才记为「已列过」—— 发送失败时不能标记，
  // 否则补发或下期就再也看不到这些条目了
  if ((r.status === 'sent' || r.status === 'already_sent') && appendixNew.length) {
    const ins = db.prepare(`INSERT INTO appendix_seen (item_version_id,brief_id,decision,listed_at)
      VALUES (?,?,?,?) ON CONFLICT(item_version_id) DO NOTHING`);
    db.transaction(() => {
      for (const x of appendixNew) ins.run(x.vid, briefId, x.decision, nowIso());
    })();
  }
  const icon = { sent: '✅', already_sent: '○', failed: '⚠️', permanent_failure: '❌' }[r.status];
  console.log(`${icon} 投递 ${r.status}` +
    (r.providerId ? ` id=${r.providerId}` : '') +
    (r.error ? ` 错误：${r.error}` : '') + ` （尝试 ${r.attempts} 次）`);
  if (r.status === 'permanent_failure')
    console.error('永久失败 —— 简报已持久化，修复凭证后可用后台补发');
}

db.prepare(`UPDATE runs SET status='succeeded', stage='sending', finished_at=?, error=NULL WHERE id=?`)
  .run(nowIso(), run.id);
db.close();
