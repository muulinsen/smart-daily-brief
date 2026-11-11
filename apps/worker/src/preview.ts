#!/usr/bin/env node
/**
 * 只渲染预览（不写库、不发信、不登记推送历史）。
 *
 *   node apps/worker/src/preview.ts                    最近一个已结束窗口
 *   node apps/worker/src/preview.ts --window 2026-10-22:noon
 *   node apps/worker/src/preview.ts --from 2026-10-22T16:00:00Z --to 2026-10-23T16:00:00Z   自定义窗口（ISO 时间）
 *   node apps/worker/src/preview.ts --out /tmp/preview  输出目录（默认 ./data/preview）
 *
 * 数据库以只读方式打开：不会生成 brief 版本、不会作废旧版本、不会写 deliveries /
 * appendix_seen / pushed_* / audit_events。模型调用照常发生（需要真实摘要）。
 */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hydrateEnv } from '../../../packages/web/src/secrets.ts';
import { AiCache } from '../../../packages/digest/src/cache.ts';
import { createTierEnv } from '../../../packages/digest/src/tiered.ts';
import { buildDigestSemantic } from '../../../packages/digest/src/build-semantic.ts';
import { DEFAULT_EXCLUSIVE_ACTIONS } from '../../../packages/digest/src/semantic.ts';
import { ProviderError } from '../../../packages/ai/src/types.ts';
import { windowFromKey, windowToReport } from '../../../packages/domain/src/normalize.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { tierInput, embeddingPick, tierConfigOrExit } from '../../../packages/web/src/model-runtime.ts';
import { loadModelSnapshot } from '../../../packages/ai/src/model-config.ts';
import { buildDigest } from '../../../packages/digest/src/build.ts';
import { loadTelegramDaily } from '../../../packages/digest/src/telegram.ts';
import { stripDealsFromTelegram } from '../../../packages/digest/src/deals.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import { renderDigestHtml, renderDigestText, renderDigestFeedHtml, digestSubject } from '../../../packages/digest/src/render.ts';
import { checkEmail } from '../../../packages/templates/src/email.ts';

const argv = process.argv.slice(2);
const arg = (k: string) => argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const vault = hydrateEnv();
if (vault.error) console.warn(`密钥保管库不可用：${vault.error}`);

const db = new Database(process.env.DATABASE_PATH ?? './data/brief.db', { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const win = arg('--from') && arg('--to')
  ? { key: `custom:${arg('--from')!.slice(0, 10)}`, label: arg('--label') ?? '预览', start: new Date(arg('--from')!), end: new Date(arg('--to')!) }
  : arg('--window') ? windowFromKey(arg('--window')!) : windowToReport();
const out = arg('--out') ?? './data/preview';
// 旧版供应商延迟创建：新流程预览在 L1 配置损坏时仍可使用 L2 与缓存
let legacy: Awaited<ReturnType<typeof createProvider>> | null = null;
const modelSnap = loadModelSnapshot(db as any);
// 全局模型供应商：本地可判定的配置错误在构建、派发、输出之前就退出（不产出残缺预览）
if (modelSnap.enabled) {
  for (const t of ['L1', 'L2'] as const) tierConfigOrExit(modelSnap, t);
  const emb = embeddingPick(modelSnap);
  if (!emb.config && emb.note.startsWith('向量模型配置错误')) { console.error(`❌ ${emb.note}`); process.exit(1); }
}
const legacyProvider = async () => legacy ??= await createProvider(tierConfigOrExit(modelSnap, 'L1'));

console.log(`预览 ${win.key} ${win.label} [${win.start.toISOString()} → ${win.end.toISOString()})`);
const tgCfg = (loadRules() as any).brief?.telegram_daily;
const withTelegram = !argv.includes('--no-telegram') && (!!arg('--telegram-json') || !!tgCfg?.enabled);
const sem = (loadRules() as any).brief?.semantic_dedup;
const telegramPath = withTelegram ? (process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3') : null;
let built;
if (sem?.enabled && !argv.includes('--legacy')) {
  // 新流程预览：数据库只读，缓存只读不写；未命中缓存的 AI/向量调用照常付费（预算按本进程计）
  const cache = new AiCache(db as any);
  if (cache.note) console.log(`⚠️ ${cache.note}`);
  let used = 0; const cap = Number(sem.max_requests ?? 600);
  const env = await createTierEnv({ l1: tierInput(modelSnap, 'L1'), l2: tierInput(modelSnap, 'L2'), promptVersion: 'sem1', cache,
    onDispatch: () => { if (++used > cap) { const e = new ProviderError('timeout', '预览请求预算用尽'); e.budgetExhausted = true; throw e; } },
    l2Items: Number(sem.l2_max_items ?? 80), l2Gray: Number(sem.l2_max_gray ?? 60), log: s => console.log(s) });
  const emb = embeddingPick(modelSnap);
  const b = await buildDigestSemantic(db as any, win, env, { cache, telegramPath,
    embedding: emb.config, embeddingNote: emb.note,
    exclusiveActions: Array.isArray(sem.exclusive_actions) ? sem.exclusive_actions : DEFAULT_EXCLUSIVE_ACTIONS });
  b.warnings.forEach(w => console.log(`⚠️ ${w}`));
  console.log(`语义去重：${JSON.stringify(b.stats)}；AI 请求 ${used} 次`);
  if (b.gate.unresolved.length) console.log(`⏸ 有 ${b.gate.unresolved.length} 条未判定：正式运行会推迟发布（预览照常输出已判定部分）`);
  if (b.gate.refused.length) console.log(`模型拒绝处理、按排除计：${b.gate.refused.map(x => `${x.task}「${x.label}」`).join('；')}`);
  built = b;
} else built = await buildDigest(db as any, win, await legacyProvider(), { telegramPath });
const { data, log, tutorialReport, dealsReport } = built;
db.close();
log.forEach(l => console.log(l));
if (arg('--telegram-json')) {
  // 试运行生成的群组要点（未写库），用于预览完整日报
  const d = JSON.parse(readFileSync(arg('--telegram-json')!, 'utf8'));
  data.telegram = { status: 'ready', windowStart: d.windowStart, windowEnd: d.windowEnd, categories: d.categories, groups: d.groups };
} else if (tgCfg?.enabled && !argv.includes('--no-telegram')) {
  data.telegram = await loadTelegramDaily(win.end, { waitMinutes: 0, maxAgeHours: Number(tgCfg.max_age_hours ?? 3) });
  console.log(`Telegram 群组要点：${data.telegram.status}`);
}
// 已单独成条的羊毛资讯不再出现在 Telegram 汇总里（汇总其余内容不变）
let tgRemoved: Array<{ category: string; text: string }> = [];
if (data.telegram) {
  const p = await legacyProvider().catch(() => null);
  if (!p) console.log('⚠️ L1 供应商不可用，跳过 Telegram 汇总去重');
  const r = p ? await stripDealsFromTelegram(p, data.telegram, (data.tutorials ?? []).filter(t => t.category === 'deals'), log) : { tg: data.telegram, removed: [] };
  data.telegram = r.tg; tgRemoved = r.removed;
  console.log(`Telegram 汇总去掉重复羊毛 ${tgRemoved.length} 条`);
}

const html = renderDigestHtml(data), text = renderDigestText(data);
const errs = checkEmail(html, text);
if (errs.length) console.warn('⚠️ 邮件校验问题：\n  ' + errs.join('\n  '));
mkdirSync(out, { recursive: true });
const base = join(out, `preview-${win.key.replace(':', '-')}`);
writeFileSync(`${base}.html`, html);
writeFileSync(`${base}.txt`, `主题：${digestSubject(data)}\n\n${text}`);
writeFileSync(`${base}.rss.html`, `<!doctype html><meta charset="utf-8"><title>${digestSubject(data)}（RSS 正文）</title><h1>${digestSubject(data)}</h1>${renderDigestFeedHtml(data)}`);
writeFileSync(`${base}.json`, JSON.stringify(data, null, 2));
if (tutorialReport) writeFileSync(`${base}.tutorials-report.json`, JSON.stringify({ ...tutorialReport, deals: dealsReport, telegramSummaryRemoved: tgRemoved }, null, 2));
console.log(`✅ 预览已写入 ${base}.html / .txt / .json（未写库、未发送）`);
