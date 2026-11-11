#!/usr/bin/env node
/**
 * 全文抓取器（rules.yaml source_specific.forum_fulltext / elsewhere）。
 *
 * 为什么需要：实测 linux.do RSS 39/39 条正文均被截断，净正文中位数仅 240 字，
 * 仅凭摘要跑 A–D 预判 39 条只命中 3 条 —— 支撑不了 PRD 24.1 的 ≥98% 召回。
 *
 * 策略：按 item_version 抓一次（不是每个采集周期都抓），便宜门筛选，单轮上限 25。
 *   node apps/worker/src/fulltext.ts            按门限抓取待处理条目
 *   node apps/worker/src/fulltext.ts --limit N  覆盖单轮上限
 *   node apps/worker/src/fulltext.ts --retry    连失败条目一并重试
 *   node apps/worker/src/fulltext.ts --source X 只处理指定来源
 */
import { openDb, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { loadRules, loadSources } from '../../../packages/domain/src/rules.ts';
import { contentFingerprint, stripHtml } from '../../../packages/domain/src/normalize.ts';
import { extractSignals, prescreenMandatory, needsFulltext } from '../../../packages/domain/src/signals.ts';
import { Throttler } from '../../../packages/connectors/src/throttle.ts';
import { hopGuard } from '../../../packages/connectors/src/fetch.ts';
import { FULLTEXT_MAX_ATTEMPTS, recordFulltextFailure, resetTransientFulltext } from './fulltext-store.ts';
import { fulltextFetcher } from '../../../packages/connectors/src/fulltext.ts';
import { circuitUntil, recordHostSuccess, recordRateLimit } from './host-circuit.ts';

const argv = process.argv.slice(2);
const RETRY = argv.includes('--retry');
const ONLY = argv.includes('--source') ? argv[argv.indexOf('--source') + 1] : null;
const rules = loadRules();
const scfg = loadSources();
const gateCfg = rules.source_specific?.forum_fulltext ?? {};
const LIMIT = argv.includes('--limit')
  ? Number(argv[argv.indexOf('--limit') + 1])
  : (gateCfg.max_fetch_per_run ?? 25);

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const throttler = new Throttler(scfg.host_groups);
const MAX_ATTEMPTS = FULLTEXT_MAX_ATTEMPTS;

// ---- 恢复：把最近 N 天因临时故障失败的记录改回待抓（只允许更新全文，不会重新生成或重发已保存的日报） ----
if (argv.includes('--reset-transient')) {
  const days = Number(argv[argv.indexOf('--reset-transient') + 1]);
  if (!Number.isInteger(days) || days < 1 || days > 30) { console.error('用法：--reset-transient <1–30 天>'); process.exit(2); }
  console.log(`已恢复 ${resetTransientFulltext(db, days)} 条最近 ${days} 天因临时故障失败的全文，下一轮重新抓取。`);
  db.close(); process.exit(0);
}

type Row = {
  vid: number; item_id: number; source_id: string; source_item_key: string;
  canonical_url: string | null; title: string; clean_text: string; html_excerpt: string | null;
  is_excerpt: number; fulltext_attempts: number; fulltext_status: string | null;
};

const pending = db.prepare(`
  SELECT v.id vid, v.item_id, f.source_id, f.source_item_key, f.canonical_url,
         v.title, v.clean_text, v.html_excerpt, v.is_excerpt, v.fulltext_attempts, v.fulltext_status
  FROM item_versions v JOIN feed_items f ON f.id = v.item_id
  JOIN sources s ON s.id = f.source_id
  WHERE s.require_fulltext = 1 AND s.enabled = 1 AND s.archived_at IS NULL
    AND (v.fulltext_status IS NULL ${RETRY ? "OR v.fulltext_status = 'failed'" : ''})
    AND v.fulltext_attempts < ?
    ${ONLY ? 'AND f.source_id = ?' : ''}
  ORDER BY v.fulltext_attempts ASC, v.discovered_at DESC`)
  .all(...(ONLY ? [MAX_ATTEMPTS, ONLY] : [MAX_ATTEMPTS])) as Row[];

const upd = db.prepare(`UPDATE item_versions SET
  fulltext_text=?, fulltext_html=?, fulltext_hash=?, fulltext_url=?,
  fulltext_status=?, fulltext_error=?, fulltext_fetched_at=?,
  fulltext_attempts=fulltext_attempts+1, gate_reason=?,
  signals_json=?, prescreen_json=? WHERE id=?`);
const skip = db.prepare(
  `UPDATE item_versions SET fulltext_status='skipped', gate_reason=?, signals_json=?, prescreen_json=? WHERE id=?`);

const sourceHost = (id: string, url: string | null = null) => {
  const fixed = ({ linuxdo: 'linux.do', v2ex: 'v2ex.com', elsewhere: 'elsewhere.news' } as
    Record<string, string>)[id];
  if (fixed) return fixed;
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
};

// 单轮配额按来源分设（rules.yaml max_fetch_per_run_by_source）
const perSource: Record<string, number> = gateCfg.max_fetch_per_run_by_source ?? {};
const capFor = (id: string) => perSource[id] ?? LIMIT;
const used: Record<string, number> = {};

let fetched = 0, skipped = 0, failed = 0, gated = 0;
let configError = false;
const guard = hopGuard(throttler, h => !!circuitUntil(db, h));
const limitedSources = new Set<string>();
const upgraded: string[] = [];

for (const r of pending) {
  // 限流按来源隔离：linux.do 被限流不该连累 Elsewhere
  if (limitedSources.has(r.source_id)) { gated++; continue; }
  if ((used[r.source_id] ?? 0) >= capFor(r.source_id)) { gated++; continue; }

  // 先用摘要算一次信号，供门限判定
  const host = sourceHost(r.source_id, r.canonical_url);
  const pre = extractSignals(r.clean_text, r.html_excerpt ?? '', host);
  const gate = r.source_id === 'elsewhere'
    ? { need: true, reason: 'elsewhere_require_full_article' }   // PRD 8.6：无条件打开原文
    : r.source_id === 'jike'
    ? { need: true, reason: 'jike_composite_child_require_full_article' }
    : needsFulltext(r.source_id, r.title, r.clean_text, !!r.is_excerpt, pre.signals);

  if (!gate.need) {
    skip.run(gate.reason, JSON.stringify(pre.signals),
             JSON.stringify(prescreenMandatory(pre.signals)), r.vid);
    skipped++; continue;
  }

  const fetcher = fulltextFetcher(r.source_id, r.source_item_key, r.canonical_url);
  if (!fetcher) {
    skip.run('no_fetcher', JSON.stringify(pre.signals),
             JSON.stringify(prescreenMandatory(pre.signals)), r.vid);
    skipped++; continue;
  }

  // RSS 与全文共享 linux.do 主机熔断；冷却期间不再试撞 Cloudflare。
  const blockedUntil = host ? circuitUntil(db, host) : null;
  if (blockedUntil) {
    limitedSources.add(r.source_id);
    console.log(`  ⏸ ${r.source_id} 主机熔断中（至 ${blockedUntil}），跳过本轮全文抓取`);
    gated++;
    continue;
  }
  const grp = throttler.groupFor(`https://${host}/`, r.source_id === 'linuxdo' ? 'fulltext_discourse' : null);
  // linux.do 在 Cloudflare 之后，undici 一律被质询 403，直接走 curl
  // 省掉一次注定失败的请求（详见 fetchViaCurl 注释）。
  const transport = r.source_id === 'linuxdo' ? 'curl' as const : 'auto' as const;
  const res = await grp.run(() => fetcher({
    userAgent: scfg.defaults.user_agent,
    timeoutMs: grp.cfg.timeout_ms,
    maxBytes: scfg.defaults.max_body_bytes,
    maxRedirects: Number(scfg.defaults.follow_redirects ?? 3),
    beforeHop: guard,
    transport,
  }));
  // 本机配置问题（curl 不可用、CA 读不了等）：不计次数、停止本批，修好后自然恢复
  if (res.errorClass === 'config') {
    console.error('  ⛔ 本机抓取配置错误（curl / CA / 临时目录），停止本批；修复后下一轮自动继续');
    configError = true;
    break;
  }
  fetched++; used[r.source_id] = (used[r.source_id] ?? 0) + 1;

  // 限流：不计入 fulltext_attempts（否则会把条目永久判死），
  // 且立即中止本批 —— 继续打只会加深惩罚。下一轮 timer 自然形成冷却。
  // 目标主机冷却中（含跳转到冷却中的主机）：没有发出请求，不计尝试次数、不记熔断，下一轮再试
  if (res.errorClass === 'cooldown') {
    // 没有出站：不占本轮的抓取计数与来源配额
    fetched--; used[r.source_id] = (used[r.source_id] ?? 1) - 1;
    console.log(`  ⏸ ${r.source_id} 目标主机冷却中，本条延后`);
    gated++;
    continue;
  }
  if (res.rateLimited) {
    // 不计入 fulltext_attempts（否则条目会被永久判死），跳过该来源剩余条目，
    // 但其他来源继续。下一轮 timer 形成天然冷却。
    limitedSources.add(r.source_id);
    const until = host ? recordRateLimit(db, host, res.httpCode, res.error) : null;
    console.log(`  ⏸ ${r.source_id} 触发限流（${res.error}），熔断至 ${until ?? '下一轮'}，跳过该来源剩余条目`);
    continue;
  }

  if (!res.ok || !res.text) {
    // on_fetch_fail: 降级用摘要但标记证据不足。
    // 关键：不得把「没看到证据」当成「没有证据」而过滤强制保留候选
    // （rules.yaml mandatory_retention.on_insufficient_evidence）。
    recordFulltextFailure(db, r.vid, { url: res.fetchedUrl ?? null, errorClass: res.errorClass, error: res.error ?? 'other:',
      gateReason: gate.reason, signalsJson: JSON.stringify(pre.signals),
      prescreenJson: JSON.stringify(prescreenMandatory(pre.signals)), at: nowIso() });
    failed++;
    continue;
  }

  if (host) recordHostSuccess(db, host);

  const text = res.text;
  const minChars = r.source_id === 'elsewhere'
    ? (rules.source_specific?.elsewhere?.min_article_chars ?? 0) : 0;
  const post = extractSignals(text, res.html ?? '', host);
  const preClasses = prescreenMandatory(pre.signals);
  const postClasses = prescreenMandatory(post.signals);
  const gained = postClasses.filter(c => !preClasses.includes(c));
  if (gained.length) upgraded.push(`${r.source_id}:${r.title.slice(0, 30)} +${gained.join('')}`);

  upd.run(text, (res.html ?? '').slice(0, 20000), contentFingerprint(text),
          res.fetchedUrl ?? null,
          text.length < minChars ? 'too_short' : 'ok',
          text.length < minChars ? `正文仅 ${text.length} 字，低于 ${minChars} 阈值` : null,
          nowIso(), gate.reason, JSON.stringify(post.signals),
          JSON.stringify(postClasses), r.vid);
}

console.log(`全文抓取：待处理 ${pending.length} 条`);
console.log(`  抓取 ${fetched} | 门限跳过 ${skipped} | 失败 ${failed} | 超出本轮上限 ${gated}` +
            (limitedSources.size ? ` | ⏸ 限流跳过: ${[...limitedSources].join(', ')}` : ''));
if (upgraded.length) {
  console.log(`  ▲ 全文使 ${upgraded.length} 条获得新的强制保留预判：`);
  for (const u of upgraded.slice(0, 12)) console.log(`     ${u}`);
}
void stripHtml;
db.close();
if (configError) process.exitCode = 1;
