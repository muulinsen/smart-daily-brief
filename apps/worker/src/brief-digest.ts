/**
 * 新版日报（rules.yaml brief.format = digest_v2）的组装、持久化与投递。
 * 由 brief.ts 调用；旧版分区渲染逻辑保留在 brief.ts 中，format 改回后即恢复。
 *
 * 不变量：
 *   - 已投递成功的简报不会重复生成或重发（除非 --regenerate）。
 *   - 先持久化再投递；投递成功后才登记 pushed_events / pushed_projects（72 小时跨期去重）。
 */
import { nowIso, type DB } from '../../../packages/db/src/index.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { buildDigest, recordPushed } from '../../../packages/digest/src/build.ts';
import { loadTelegramDaily } from '../../../packages/digest/src/telegram.ts';
import { stripDealsFromTelegram } from '../../../packages/digest/src/deals.ts';
import { renderDigestHtml, renderDigestText, digestSubject, digestCount } from '../../../packages/digest/src/render.ts';
import type { DigestData } from '../../../packages/digest/src/core.ts';
import { checkEmail } from '../../../packages/templates/src/email.ts';
import { deliver } from '../../../packages/templates/src/delivery.ts';
import { mailerFromEnv } from '../../../packages/templates/src/mailer.ts';
import { ProviderError, type Provider } from '../../../packages/ai/src/types.ts';
import { tierInput, embeddingPick, tierConfigOrExit } from '../../../packages/web/src/model-runtime.ts';
import { loadModelSnapshot } from '../../../packages/ai/src/model-config.ts';
import { AiCache } from '../../../packages/digest/src/cache.ts';
import { createTierEnv } from '../../../packages/digest/src/tiered.ts';
import { buildDigestSemantic, type SemanticBuild } from '../../../packages/digest/src/build-semantic.ts';
import { DEFAULT_EXCLUSIVE_ACTIONS } from '../../../packages/digest/src/semantic.ts';
import {
  acquireLease, budgetScope, finishAttempt, hasRunStateTables, setRetryState, startAttempt, takeBudget, type Lease, type Trigger,
} from '../../../packages/db/src/runstate.ts';

/** 有未判定条目、本期推迟发布（由 run.ts 按固定时刻表重试）。 */
export const EXIT_WAITING_AI = 75;
/** 另一个尝试正持有本期租约：本次没有构建，结果未知（定时循环应继续按时刻表检查，而不是当作成功结束）。 */
export const EXIT_LEASE_BUSY = 76;

class DeadlinePassed extends Error {}

type Opts = {
  db: DB; run: any; win: { key: string; label: string; start: Date; end: Date }; rules: any;
  noSend: boolean; shadow: boolean; regenerate: boolean; outDir: string;
  /** 新流程：本次尝试的触发来源与绝对截止时间（毫秒时间戳；手动重跑为 null） */
  trigger?: Trigger; deadlineMs?: number | null;
  /** 仅供测试注入：替换 Telegram 汇总去羊毛步骤（验证构建之后的 AI 调用也计入审计次数） */
  stripDeals?: typeof stripDealsFromTelegram;
};

export async function runDigestBrief(o: Opts): Promise<number> {
  if (!o.rules.brief?.semantic_dedup?.enabled) return compose(o, null);
  // 新流程：同一期同一时刻只允许一个构建/发布尝试（定时、手动、直接 CLI 共用）
  if (!hasRunStateTables(o.db)) { console.error('❌ 缺少迁移 018 的运行状态表，请先运行 npm run migrate'); return 1; }
  const lease = acquireLease(o.db, o.run.id);
  if (!lease) { console.log('另一个构建尝试正在进行，本次不重复构建'); return EXIT_LEASE_BUSY; }
  try { return await compose(o, lease); } finally { lease.release(); }
}

/** 新流程的一次构建尝试。有未判定条目时不持久化，记录推迟状态并返回 EXIT_WAITING_AI。 */
async function buildSemantic(o: Opts): Promise<number | { built: SemanticBuild; provider: Provider | null; attemptId: number; aiCalls: () => number }> {
  const { db, run } = o;
  const trigger = o.trigger ?? 'manual';
  const attemptId = startAttempt(db, run.id, trigger);
  const scope = budgetScope(trigger, attemptId);
  const cfg = o.rules.brief.semantic_dedup;
  const cap = Number(cfg.max_requests ?? 600);
  const deadline = o.deadlineMs ?? null;
  const stop = (why: string) => { const e = new ProviderError('timeout', why); e.budgetExhausted = true; return e; };
  let dispatched = 0;   // 本次尝试实际派发的请求数（含向量请求、重试与构建之后的 Telegram 去羊毛），记入 brief_composed 审计
  const onDispatch = () => {
    if (deadline && Date.now() >= deadline) throw stop('已到截止时间');
    if (!takeBudget(db, run.id, scope, cap)) throw stop('本期 AI 请求预算已用尽');
    dispatched++;
  };
  const cache = new AiCache(db);
  // 本次尝试的模型配置快照：两层与向量都从同一份解析（全局模型供应商开关关着时就是旧配置）
  const snap = loadModelSnapshot(db as any);
  const env = await createTierEnv({
    l1: tierInput(snap, 'L1'), l2: tierInput(snap, 'L2'), promptVersion: 'sem1', cache, onDispatch,
    signal: deadline ? AbortSignal.timeout(Math.max(1, deadline - Date.now())) : undefined,
    l2Items: Number(cfg.l2_max_items ?? 80), l2Gray: Number(cfg.l2_max_gray ?? 60), log: s => console.log(s),
  });
  for (const s of [env.l1, env.l2]) if (s.dead) console.log(`  ⚠️ ${s.tier} 供应商不可用（${s.deadReason}）`);
  const emb = embeddingPick(snap);
  const embedding = emb.config;
  const tgEnabled = !!o.rules.brief?.telegram_daily?.enabled;
  const built = await buildDigestSemantic(db, o.win, env, {
    cache, embedding, embeddingNote: emb.note,
    exclusiveActions: Array.isArray(cfg.exclusive_actions) ? cfg.exclusive_actions : DEFAULT_EXCLUSIVE_ACTIONS,
    telegramPath: tgEnabled ? (process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3') : null,
  });
  built.log.forEach(l => console.log(l));
  built.warnings.forEach(w => console.log(`⚠️ ${w}`));
  if (cache.note) console.log(`⚠️ ${cache.note}`);
  const refused = JSON.stringify(built.gate.refused.slice(0, 50));
  if (built.gate.refused.length) console.log(`模型拒绝处理、按排除计：${built.gate.refused.length} 条`);
  const n = built.gate.unresolved.length;
  if (n) {
    const kind = env.lastErrorKind ?? env.stopReason ?? 'unknown';
    const tasks = [...new Set(built.gate.unresolved.map(u => u.task))].join('、');
    console.log(`⏸ 有 ${n} 条未判定（${tasks}；最后错误类型 ${kind}），本期推迟发布`);
    finishAttempt(db, attemptId, 'waiting_ai', n, kind);
    setRetryState(db, run.id, { unresolved: n, last_error_kind: kind, refused_json: refused });
    db.prepare(`UPDATE runs SET status='waiting_ai', stage='composing', error=? WHERE id=?`)
      .run(`AI 判定未完成：${n} 条未判定（${tasks}），最后错误类型 ${kind}`, run.id);
    return EXIT_WAITING_AI;
  }
  setRetryState(db, run.id, { unresolved: 0, next_attempt_at: null, last_error_kind: null, refused_json: refused });
  // 返回读取函数而不是当前值：发布前还有 Telegram 去羊毛等调用，审计要在落库时再读
  return { built, provider: env.l1.provider, attemptId, aiCalls: () => dispatched };
}

async function compose(o: Opts, lease: Lease | null): Promise<number> {
  const { db, run } = o;
  const to = process.env.MAIL_TO ?? '';
  const deliveryType = o.shadow ? 'shadow' : o.regenerate ? 'resend' : 'primary';
  const existing = db.prepare(`SELECT id, version, subject, text_body, html_body, digest_json FROM briefs
    WHERE run_id=? AND status='final' ORDER BY version DESC LIMIT 1`).get(run.id) as any;
  if (existing && !o.regenerate && db.prepare(`SELECT 1 FROM deliveries WHERE brief_id=? AND recipient=? AND delivery_type=? AND status='sent'`)
    .get(existing.id, to, deliveryType)) { console.log('本期已投递，不重复发送'); return 0; }

  let briefId: number, subject: string, html: string, text: string, data: DigestData;
  if (existing?.digest_json && !o.regenerate) {
    briefId = existing.id; subject = existing.subject; html = existing.html_body; text = existing.text_body;
    data = JSON.parse(existing.digest_json);
    console.log(`复用已生成的新版简报 #${briefId}（v${existing.version}）`);
  } else {
    let provider: Provider | null, built: { data: DigestData; log: string[] }, attemptId: number | null = null;
    // 统计实际 AI 调用次数（新版日报不写 evaluations，后台的「AI 判定」靠这里的计数）
    // 两条路径都给出读取函数，在写审计时才读取，构建之后（Telegram 去羊毛）的调用也算在内
    let aiCalls: () => number, aiModel = '';
    if (lease) {
      const r = await buildSemantic(o);
      if (typeof r === 'number') return r;
      ({ built, provider, attemptId, aiCalls } = r);
      aiModel = provider?.model ?? '';
    } else {
      const inner = await createProvider(tierConfigOrExit(loadModelSnapshot(db as any), 'L1'));
      aiModel = inner.model;
      let legacyCalls = 0; aiCalls = () => legacyCalls;
      provider = { get name() { return inner.name; }, get model() { return inner.model; }, get strictness() { return inner.strictness; },
        complete(req) { legacyCalls++; return inner.complete(req); } };
      const tgEnabled = !!o.rules.brief?.telegram_daily?.enabled;
      built = await buildDigest(db, o.win, provider, { telegramPath: tgEnabled ? (process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3') : null });
      built.log.forEach(l => console.log(l));
    }
    data = built.data;
    const tg = o.rules.brief?.telegram_daily;
    if (tg?.enabled) {
      data.telegram = await loadTelegramDaily(o.win.end, { waitMinutes: o.noSend ? 0 : Number(process.env.BRIEF_TELEGRAM_WAIT_MINUTES ?? tg.wait_minutes ?? 15), maxAgeHours: Number(tg.max_age_hours ?? 3), log: m => console.log(m) });
      if (data.telegram.status === 'ready' && provider) {
        const r = await (o.stripDeals ?? stripDealsFromTelegram)(provider, data.telegram, (data.tutorials ?? []).filter(t => t.category === 'deals'), built.log);
        data.telegram = r.tg;
        console.log(`Telegram 汇总去掉重复羊毛 ${r.removed.length} 条`);
      }
      console.log(`Telegram 群组要点：${data.telegram.status === 'ready' ? `${data.telegram.categories.reduce((n, c) => n + c.items.length, 0)} 条` : '未就绪，注明生成中'}`);
    }
    html = renderDigestHtml(data); text = renderDigestText(data);
    subject = digestSubject(data) + (o.regenerate ? '｜补发' : '');
    const errs = checkEmail(html, text);
    if (errs.length) { console.error('❌ 邮件校验未通过，拒绝发送：\n  ' + errs.join('\n  ')); return 1; }
    const prevAny = db.prepare(`SELECT max(version) v FROM briefs WHERE run_id=?`).get(run.id) as any;
    const version = (prevAny?.v ?? 0) + 1;
    try { briefId = Number(db.transaction(() => {
      // 新流程：发布前再确认租约仍归本尝试所有，防止过期后与另一尝试同时发布
      if (lease && !lease.held()) throw new Error('运行租约已失效，放弃本次发布');
      // 定时尝试：两小时截止之后不得发布（落库即发布）
      if (lease && o.deadlineMs && Date.now() >= o.deadlineMs) throw new DeadlinePassed();
      const id = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at,digest_json)
        VALUES (?,?,?,?,?,?,'final',?,?,?)`).run(run.id, version, subject, text, html, Buffer.byteLength(html, 'utf8'),
        o.rules.meta.rule_version, nowIso(), JSON.stringify(data)).lastInsertRowid);
      if (existing) db.prepare(`UPDATE briefs SET status='superseded' WHERE id=?`).run(existing.id);
      db.prepare(`INSERT INTO audit_events (run_id,entity_type,entity_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
        .run(run.id, 'brief', String(id), 'brief_composed', JSON.stringify({ format: 'digest_v2', items: digestCount(data), version, aiCalls: aiCalls(), model: aiModel }), nowIso());
      return id;
    })()); } catch (e) {
      if (!(e instanceof DeadlinePassed)) throw e;
      console.log('⏸ 已过两小时截止时间，本期不发布');
      if (attemptId !== null) finishAttempt(db, attemptId, 'deadline', 0, 'deadline');
      setRetryState(db, run.id, { last_error_kind: 'deadline' });
      return EXIT_WAITING_AI;
    }
    if (attemptId !== null) finishAttempt(db, attemptId, 'published', 0, null);
    console.log(`已保存新版简报 #${briefId} v${version}：官方事件 ${data.vendors.reduce((n, v) => n + v.events.length, 0)} 条 / 开源项目 ${data.projects.length} 个`);
  }

  const rssOnly = o.rules.brief?.delivery === 'rss_only';
  if (rssOnly) {
    // 只发布 RSS：简报持久化即发布，同时登记 72 小时推送历史
    if (!o.shadow) recordPushed(db, briefId, data);
    console.log('delivery=rss_only：不发邮件，已通过 RSS 发布');
  } else if (o.noSend) console.log('--no-send：跳过投递');
  else if (!to) console.log('未设置 MAIL_TO，跳过投递');
  else {
    const { mailer, kind, note } = mailerFromEnv(o.outDir);
    console.log(`投递通道：${kind}${note ? ` —— ${note}` : ''}`);
    const r = await deliver(db, mailer, { briefId, recipient: to, assertEligible: () => {}, deliveryType,
      subject, text, html, environment: o.shadow ? 'shadow' : undefined });
    if ((r.status === 'sent' || r.status === 'already_sent') && !o.shadow) recordPushed(db, briefId, data);
    console.log(`投递 ${r.status}${r.providerId ? ` id=${r.providerId}` : ''}${r.error ? ` 错误：${r.error}` : ''}（尝试 ${r.attempts} 次）`);
    if (r.status === 'permanent_failure') { console.error('永久失败 —— 简报已持久化，修复凭证后可补发'); }
  }
  db.prepare(`UPDATE runs SET status='succeeded', stage='sending', finished_at=?, error=NULL WHERE id=?`).run(nowIso(), run.id);
  return 0;
}
