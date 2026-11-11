#!/usr/bin/env node
/**
 * 管理后台（PRD 16 / 14.2 / 19.2）。
 *
 * 只监听 127.0.0.1 —— 公网由 Caddy 反代并负责 TLS 与安全 Header，
 * 应用层负责会话、CSRF、限流（纵深防御，PRD 19.2）。
 *
 *   ADMIN_PASSWORD_HASH=... ADMIN_TOTP_SECRET=... node apps/web/src/server.ts
 *   未配置口令时以只读演示模式启动并明确告警。
 */
import { windowDefs } from '../../../packages/domain/src/normalize.ts';
import { readBackupSettings, readGdriveStatus, writeBackupSettings } from '../../../packages/web/src/backup-settings.ts';
import { loadRules } from '../../../packages/domain/src/rules.ts';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { openDb, migrate, nowIso, type DB } from '../../../packages/db/src/index.ts';
import { join } from 'node:path';
import { verifyPassword, verifyTotp, SessionStore, csrfOk, LoginLimiter, type Session }
  from '../../../packages/web/src/auth.ts';
import { renderLogin, renderSubscriptions, slotAlerts, renderSettings, renderToday, renderTodayOverview, renderSystem, renderRuns, renderRunDetail, renderChannels,
         renderBackupSwitches, setNavBadges, isXSource, SUBSCRIPTION_TABS, SETTINGS_TABS, CHANNEL_TABS,
         type TodaySlot, type NavBadges, type RunRow, type FeedRow, type SubscriptionTab, type SettingsTab, type ChannelTab } from '../../../packages/web/src/views.ts';
import { pendingRequests, queueRequest } from '../../../packages/web/src/requests.ts';
import { computeAlerts, mergeSlotAlerts, readBackups, readDisk, readUnits, type Alert } from '../../../packages/web/src/ops.ts';
import { briefFeedToken, briefsRss, rotateBriefFeedToken } from '../../../packages/web/src/briefs-rss.ts';
import { maskedSecrets, setSecret, setSettings, resolveSettings, vaultHealthy,
         resolveSecret, SECRET_NAMES, type SecretName, resolveEmbeddingConfig } from '../../../packages/web/src/secrets.ts';
import { getRetryState, hasRunStateTables } from '../../../packages/db/src/runstate.ts';
import { EmbeddingError, parseEmbeddingFields, testEmbedding, validateEmbeddingConfig } from '../../../packages/ai/src/embeddings.ts';
import { overrideCandidate, toggleSource, updateSourceGroup, updateSourceUrl, planResend, addSource, deleteSource,
         testSource, isDeletedSql, ActionError } from '../../../packages/web/src/actions.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { resolveMailTransport } from '../../../packages/templates/src/mailer.ts';
import { errorText } from '../../../packages/ai/src/errors.ts';
import { safeFormUrl } from '../../../packages/web/src/url-redact.ts';
import { loadModelSnapshot, readModelConfig, openProvider, currentMasterKey, masterKeyProblem, resolveModel, hostOf, CONSUMERS, CONSUMER_LABEL, CONFIG_ERROR_LABEL, PROVIDER_TYPE_LABEL, type Consumer, type ProviderType } from '../../../packages/ai/src/model-config.ts';
import { embeddingPick, tierPick, legacyTelegramConfig } from '../../../packages/web/src/model-runtime.ts';
import { createModelProvider, updateModelProvider, deleteModelProvider, setManualModels, saveAssignments, setModelConfigEnabled,
  importLegacy, applyModelsFetch, collectLegacy, workerEnvCopy, ModelConfigError, type AssignmentInput } from '../../../packages/web/src/model-providers.ts';
import { fetchModelCatalog, tryStartFetch, endFetch } from '../../../packages/web/src/model-catalog.ts';
import { renderModelsSection, type ConsumerStatus } from '../../../packages/web/src/model-views.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { addTelegramSource, retryTelegramSource, rotateAllToken, rotateSourceToken, renameTelegramSource,
         toggleTelegramSource, updateTelegramSettings, resumeVisionQueue, setVisionDailyLimit, updateTelegramRetention, TelegramError } from '../../../packages/telegram/src/core.ts';
import { visionStats } from '../../../packages/telegram/src/vision.ts';
import { sourceRss, allRss, digestRss, digestsForBriefFeed } from '../../../packages/telegram/src/rss.ts';
import { digestHtml } from '../../../packages/telegram/src/digest.ts';
import { sendLoginCommand, type LoginCommand } from '../../../packages/telegram/src/login.ts';
import { telegramSourcesSection, telegramDigestsSection, telegramVisionSection, telegramLoginSection, renderTelegramSettings, renderTelegramRetention } from '../../../packages/telegram/src/views.ts';

const PORT = Number(process.env.ADMIN_PORT ?? 3000);
const HOST = process.env.ADMIN_HOST ?? '127.0.0.1';
const PW_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';
const TOTP = process.env.ADMIN_TOTP_SECRET ?? '';
const SECURE_COOKIE = (process.env.ADMIN_SECURE_COOKIE ?? 'true') !== 'false';

const db: DB = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
const telegramDb = readyTelegramDb();
// 新部署可以直接启动：首次启动自动应用前向迁移，重复启动保持幂等。
migrate(db, join(process.cwd(), 'migrations'));
const sessions = new SessionStore(Number(process.env.ADMIN_SESSION_HOURS ?? 12));
const limiter = new LoginLimiter(5, 15 * 60e3);
setInterval(() => sessions.sweep(), 10 * 60e3).unref();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', serializers: { req(req) { return { method:req.method, url:String(req.url).startsWith('/rss/') ? '/rss/[REDACTED]' : req.url }; } } },
  bodyLimit: 256 * 1024,
  // 只信任本机反向代理（后台只监听 127.0.0.1）：真实客户端 IP 用于登录限流，外部伪造的转发头不被采信
  trustProxy: ['127.0.0.1', '::1'],
});
await app.register(cookie);
// HTML 表单提交的是 application/x-www-form-urlencoded，
// Fastify 默认只解析 JSON —— 少了这个插件浏览器登录会直接 415。
await app.register(formbody, { bodyLimit: 64 * 1024 });

const configured = !!PW_HASH;
if (!configured)
  app.log.warn('未设置 ADMIN_PASSWORD_HASH —— 以只读演示模式启动，所有写操作被拒绝');

// ---------- 会话 ----------
const sessionOf = (req: any): Session | null => sessions.get(req.cookies?.sid);

app.addHook('onRequest', async (req, reply) => {
  // 后台不应被搜索引擎或嵌入
  reply.header('X-Robots-Tag', 'noindex, nofollow');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

/** 未登录一律跳登录页；API 返回 401。 */
function requireAuth(req: any, reply: any): Session | null {
  const s = sessionOf(req);
  if (s) return s;
  if (req.url.startsWith('/api/')) { reply.code(401).send({ error: '未登录' }); return null; }
  reply.redirect('/login');
  return null;
}

/**
 * 写操作前置：演示模式一律拒绝 + CSRF + 同源。
 * 顺序重要 —— 未配置口令时连 CSRF 都不该走到。
 */
function requireWrite(req: any, reply: any, s: Session): boolean {
  if (!configured) {
    reply.code(403).send({ error: '只读演示模式：未设置 ADMIN_PASSWORD_HASH，写操作被禁用' });
    return false;
  }
  return requireCsrf(req, reply, s);
}

/** 写操作必须带正确的 CSRF token 且为同源（PRD 14.2）。 */
function requireCsrf(req: any, reply: any, s: Session): boolean {
  const token = (req.body as any)?.csrf ?? req.headers['x-csrf-token'];
  if (!csrfOk(s, token)) { reply.code(403).send({ error: 'CSRF 校验失败' }); return false; }
  const origin = req.headers.origin;
  if (origin) {
    const expect = process.env.ADMIN_BASE_URL;
    // 精确比较源（协议 + 主机 + 端口），不用前缀匹配：https://brief.example.com.evil.com 不能通过
    let want = '';
    try { want = expect ? new URL(expect).origin : ''; } catch { want = ''; }
    if (expect && origin !== want) {
      reply.code(403).send({ error: '跨源请求被拒绝' }); return false;
    }
  }
  return true;
}

// ---------- 登录 ----------
app.get('/login', async (req, reply) => {
  if (sessionOf(req)) return reply.redirect('/');
  return reply.type('text/html; charset=utf-8')
    .send(renderLogin({ configured, needTotp: !!TOTP }));
});

app.post('/login', async (req, reply) => {
  const ip = req.ip ?? 'unknown';
  const gate = limiter.check(ip);
  if (!gate.allowed) {
    return reply.code(429).type('text/html; charset=utf-8')
      .send(renderLogin({ configured, needTotp: !!TOTP,
        error: `尝试过于频繁，请 ${Math.ceil(gate.retryAfterSec / 60)} 分钟后再试` }));
  }
  const { password = '', totp = '' } = (req.body ?? {}) as any;

  // 未配置时不允许任何人登录 —— 演示模式只读
  const pwOk = configured && verifyPassword(String(password), PW_HASH);
  const totpOk = !TOTP || verifyTotp(TOTP, String(totp));

  if (!pwOk || !totpOk) {
    limiter.fail(ip);
    req.log.warn({ ip: 'redacted', pwOk, totpOk }, '登录失败');
    // 不区分「口令错」与「验证码错」，避免泄露哪一项正确
    return reply.code(401).type('text/html; charset=utf-8')
      .send(renderLogin({ configured, needTotp: !!TOTP, error: '口令或验证码错误' }));
  }

  limiter.reset(ip);
  const s = sessions.create();
  reply.setCookie('sid', s.id, {
    httpOnly: true, sameSite: 'strict', secure: SECURE_COOKIE, path: '/',
    maxAge: Number(process.env.ADMIN_SESSION_HOURS ?? 12) * 3600,
  });
  return reply.redirect('/');
});

app.post('/logout', async (req, reply) => {
  const s = sessionOf(req);
  if (s && !requireCsrf(req, reply, s)) return;
  sessions.destroy(req.cookies?.sid);
  reply.clearCookie('sid', { path: '/' });
  return reply.redirect('/login');
});

// ---------- 健康检查（不需要登录，供部署流程用） ----------
app.get('/health/live', async () => ({ ok: true }));
app.get('/health/ready', async (_req, reply) => {
  try {
    db.prepare('SELECT 1').get();
    telegramDb.prepare('SELECT 1').get();
    return { ok: true, sessions: sessions.size };
  } catch (e: any) {
    return reply.code(503).send({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---------- 页面 ----------
/** 表单可带 redirect 指定操作后返回的页面；只接受站内路径，防止被利用做外部跳转。 */
const back = (req: any, fallback: string): string => {
  const r = String((req.body as any)?.redirect ?? '');
  return /^\/(?!\/)[\w\-/?=&.%#]*$/.test(r) ? r : fallback;
};
const q = {
  /** 管理列表：只排除已归档与已删除的来源；停用、待确认的照常显示（docs/admin-reorg-p1-design.md §5） */
  sources: () => db.prepare(`SELECT id,display_name,category,source_group,host_group,health,harvest_tier,
    consecutive_failures,last_success_at,last_http_code,last_error,latest_item_at,enabled,managed_by,onboarding_status,observation_until,
    (SELECT url FROM source_endpoints e WHERE e.source_id=sources.id AND e.priority=1) endpoint_url,
    (SELECT parser FROM source_endpoints e WHERE e.source_id=sources.id AND e.priority=1) endpoint_parser
    FROM sources WHERE archived_at IS NULL AND NOT ${isDeletedSql()}
    ORDER BY CASE health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, id`).all(),
  tests: () => db.prepare(`SELECT url,outcome,parsed_count,error,started_at
    FROM source_tests ORDER BY id DESC LIMIT 8`).all(),
  harvests: () => db.prepare(`SELECT * FROM harvest_runs ORDER BY id DESC LIMIT 12`).all(),
  runs: () => db.prepare(`SELECT r.*, (SELECT count(*) FROM candidates c WHERE c.run_id=r.id) cands
    FROM runs r ORDER BY r.id DESC LIMIT 30`).all(),
  candidates: (id: number) => db.prepare(`SELECT c.*, f.source_id, v.title, f.canonical_url
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id
    JOIN feed_items f ON f.id=v.item_id WHERE c.run_id=? ORDER BY c.decision, c.id`).all(id),
  stats: () => ({
    items: (db.prepare('SELECT count(*) c FROM feed_items').get() as any).c,
    versions: (db.prepare('SELECT count(*) c FROM item_versions').get() as any).c,
    candidates: (db.prepare('SELECT count(*) c FROM candidates').get() as any).c,
    deliveries: db.prepare(`SELECT status, count(*) c FROM deliveries GROUP BY 1`).all(),
    pendingFulltext: (db.prepare(`SELECT count(*) c FROM item_versions v
      JOIN feed_items f ON f.id=v.item_id JOIN sources s ON s.id=f.source_id
      WHERE s.require_fulltext=1 AND s.enabled=1 AND s.archived_at IS NULL AND v.fulltext_status IS NULL`).get() as any).c,
    aiTokens: (db.prepare(`SELECT coalesce(sum(input_tokens+output_tokens),0) n FROM usage_ledger`).get() as any).n,
    aiCostUsd: (db.prepare(`SELECT coalesce(sum(cost_usd),0) n FROM usage_ledger`).get() as any).n,
  }),
};

// ---- 运行状况：今日页、系统运行页和侧栏计数共用 ----
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/lib/briefing/backups';
const taipeiDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
// 今日时段按 rules.yaml 的窗口配置生成（2026-10-22 起为每日一期；写死早/午/晚报会让卡片永远对不上真实运行）
const SLOTS = (): Array<[string, string, string]> => windowDefs().map(d => [d.id, d.label, `${String(d.end_hour).padStart(2, '0')}:00`]);
const rssOnly = () => (loadRules() as any).brief?.delivery === 'rss_only';
/** 一期定稿的条目数：新版日报记在 brief_composed 审计里（digestCount），旧版按 brief_items 统计。 */
const BRIEF_ITEMS_SQL = (alias: string) => `coalesce(
  (SELECT coalesce(json_extract(a.payload_json,'$.items'), json_extract(a.payload_json,'$.digestCount')) FROM audit_events a
    WHERE a.entity_type='brief' AND a.entity_id=CAST(${alias}.id AS TEXT) AND a.action IN ('brief_composed','brief_telegram_refreshed') ORDER BY a.id DESC LIMIT 1),
  (SELECT count(*) FROM brief_items i WHERE i.brief_id=${alias}.id))`;

/** 每个 Telegram 来源的最近消息时间和 24 小时消息量；子查询都走 (source_id, sent_at) 索引。 */
const telegramSources = (now = Date.now()) => telegramDb.prepare(`SELECT s.*,
    (SELECT max(m.sent_at) FROM telegram_messages m WHERE m.source_id=s.id AND m.deleted_at IS NULL) last_message_at,
    (SELECT count(*) FROM telegram_messages m WHERE m.source_id=s.id AND m.sent_at>=? AND m.deleted_at IS NULL) messages_24h,
    -- 与「单频道总结失败」告警同一口径：近 2 天重试已用完的失败时段
    (SELECT count(*) FROM telegram_summary_jobs j WHERE j.source_id=s.id AND j.status='failed' AND j.next_attempt_at IS NULL AND j.window_end>=?) summary_failures,
    (SELECT max(j.window_end) FROM telegram_summary_jobs j WHERE j.source_id=s.id AND j.status='failed' AND j.next_attempt_at IS NULL AND j.window_end>=?) summary_failed_window
  FROM telegram_sources s ORDER BY s.enabled DESC, CASE s.status WHEN 'error' THEN 0 ELSE 1 END, s.id`)
  .all(new Date(now - 864e5).toISOString(), new Date(now - 2 * 864e5).toISOString(), new Date(now - 2 * 864e5).toISOString()) as any[];

let sysCache: { at: number; units: ReturnType<typeof readUnits>; disk: ReturnType<typeof readDisk>; backups: ReturnType<typeof readBackups> } | null = null;
const systemState = () => {
  if (!sysCache || Date.now() - sysCache.at > 20_000)
    sysCache = { at: Date.now(), units: readUnits(), disk: readDisk('/'), backups: readBackups(BACKUP_DIR) };
  return sysCache;
};

/** 今天各时段的运行与投递（系统运行的时段卡片、今日的漏运行 / 未投递告警共用）。 */
function todaySlots(now: number): TodaySlot[] {
  const date = taipeiDate(now);
  const rss = rssOnly();
  return SLOTS().map(([key, label, clock]) => {
    const run = db.prepare('SELECT * FROM runs WHERE window_key=?').get(`${date}:${key}`) as any;
    const brief = run ? db.prepare(`SELECT b.id, ${BRIEF_ITEMS_SQL('b')} items FROM briefs b
      WHERE b.run_id=? AND b.status='final' ORDER BY b.version DESC LIMIT 1`).get(run.id) as any : null;
    const delivery = brief ? db.prepare(`SELECT status,sent_at,error FROM deliveries WHERE brief_id=? AND delivery_type='primary' ORDER BY id DESC LIMIT 1`).get(brief.id) as any : null;
    return { key, label, clock, scheduledAt: Date.parse(`${date}T${clock}:00+08:00`), run: run ?? null, items: brief?.items ?? null, delivery: delivery ?? null, rssOnly: rss };
  });
}

function opsSnapshot() {
  const now = Date.now();
  const sys = systemState();
  const tgSources = telegramSources(now);
  const settings = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  const worker = telegramDb.prepare('SELECT * FROM telegram_worker_state WHERE singleton=1').get() as any;
  const sources = q.sources() as any[];
  const heartbeatAt: string | null = [worker?.heartbeat_at, ...tgSources.filter(t => t.enabled).map(t => t.last_success_at)].filter(Boolean).sort().pop() ?? null;
  const base: Alert[] = computeAlerts({
    now, units: sys.units, disk: sys.disk, backups: sys.backups, backupSettings: readBackupSettings(), gdrive: readGdriveStatus(),
    runs: (hasRunStateTables(db)
      ? db.prepare(`SELECT r.window_key,r.window_label,r.scheduled_at,r.status,r.error,r.finished_at,
          s.next_attempt_at, s.unresolved, s.last_error_kind, json_array_length(coalesce(s.refused_json,'[]')) refused_count
          FROM runs r LEFT JOIN run_retry_state s ON s.run_id=r.id WHERE r.scheduled_at>=? ORDER BY r.scheduled_at`)
      : db.prepare(`SELECT window_key,window_label,scheduled_at,status,error,finished_at FROM runs WHERE scheduled_at>=? ORDER BY scheduled_at`))
      .all(new Date(now - 864e5).toISOString()) as any[],
    sources,
    telegram: {
      authorized: !!worker?.authorized,
      heartbeatAt,
      sources: tgSources.map(t => ({ name: t.display_name || t.title || t.reference, status: t.status, enabled: t.enabled,
        last_error: t.last_error, last_success_at: t.last_success_at })),
      visionPaused: !!settings?.vision_paused, visionPauseReason: settings?.vision_pause_reason ?? null,
      visionBacklog: visionStats(telegramDb, new Date(now)).pending, visionDailyLimit: Number(settings?.vision_daily_limit ?? 0) || 1,
      failedSummaries: (telegramDb.prepare(`SELECT count(*) n FROM telegram_summary_jobs WHERE status='failed' AND next_attempt_at IS NULL AND window_end>=?`)
        .get(new Date(now - 2 * 864e5).toISOString()) as any).n,
    },
  });
  // 全局模型供应商：启用后任一用途配置不可用（Telegram 会静默不领取任务）→ 红色告警；主密钥太弱 → 提醒
  const alerts: Alert[] = [...base];
  try {
    const raw = readModelConfig(db);
    if (raw.enabled) for (const st of modelStatus(true, settings).filter(x => !x.ok))
      alerts.push({ level: 'bad', area: st.consumer.startsWith('telegram') ? 'telegram' : 'system', title: `模型配置错误：${CONSUMER_LABEL[st.consumer]}`,
        detail: `${st.text}；相关任务暂停领取，修好后自动继续`, href: '/settings?tab=models#model-assign' });
    const weak = masterKeyProblem();
    if (weak && (raw.enabled || raw.providers.length)) alerts.push({ level: 'warn', area: 'system', title: '主密钥强度不足', detail: weak, href: '/settings?tab=models' });
  } catch (e: any) {
    alerts.push({ level: 'bad', area: 'system', title: '无法读取模型配置', detail: String(e?.message ?? e).slice(0, 120), href: '/settings?tab=models' });
  }
  // 时段卡片只补 computeAlerts 没有的两类：漏运行、已定稿未投递（§11）
  const slots = todaySlots(now);
  const all = mergeSlotAlerts(alerts, slotAlerts(slots, now))
    .sort((a, b) => (a.level === 'bad' ? 0 : 1) - (b.level === 'bad' ? 0 : 1));   // 稳定排序：故障在前
  return { now, sys, alerts: all, sources, tgSources, worker, slots, heartbeatAt };
}

setNavBadges((): NavBadges => {
  const { alerts } = opsSnapshot();
  const badge = (xs: Alert[]) => xs.length ? { count: xs.length, level: xs.some(a => a.level === 'bad') ? 'bad' as const : 'warn' as const } : undefined;
  // 角标按「去处理」链接所在的页面归类，与今日的告警同一来源
  const at = (prefix: string) => badge(alerts.filter(a => a.href === prefix || a.href.startsWith(`${prefix}?`) || a.href.startsWith(`${prefix}#`) || a.href.startsWith(`${prefix}/`)));
  return { today: badge(alerts), subscriptions: at('/subscriptions'), runs: at('/runs'), system: at('/system'), settings: at('/settings') };
});

const html = (reply: any, body: string, code = 200) => reply.code(code).type('text/html; charset=utf-8').send(body);
const weekdayLabel = (now: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(now));

/** 今日：只有待处理（§3）。 */
app.get('/', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const { now, alerts } = opsSnapshot();
  return html(reply, renderToday({ csrf: s.csrf, now, dateLabel: weekdayLabel(now), alerts }));
});

app.post('/system/backups', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s || !requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const before = readBackupSettings();
  try {
    const after = writeBackupSettings({ local: b.local === 'on', gdrive: b.gdrive === 'on' });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('settings','backups','backup_settings_updated',?,?)`)
      .run(JSON.stringify({ before: { local: before.local, gdrive: before.gdrive }, after: { local: after.local, gdrive: after.gdrive }, actor: 'owner' }), nowIso());
    return reply.redirect('/settings?tab=data&saved=backups#backups');
  } catch (e: any) {
    req.log.error({ err: errorText(e) }, '保存备份设置失败');
    return html(reply, settingsPage(s, { error: '保存备份设置失败' }, 'data'), 500);
  }
});
app.get('/system/backups', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return reply.redirect('/settings?tab=data#backups');
});

/** 图片识别实际生效的模型（全局开关打开时取模型分配，否则旧配置）；只含类型、主机、模型。 */
function visionModelText(tgSettings: any): string {
  try { return modelStatus(readModelConfig(db).enabled, tgSettings).find(x => x.consumer === 'telegramVision')?.text ?? '—'; }
  catch { return '无法读取模型配置'; }
}

app.get('/system', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const { now, sys, sources, tgSources, worker, slots, heartbeatAt } = opsSnapshot();
  const since = new Date(now - 864e5).toISOString();
  const byStage = (db.prepare(`SELECT stage, model, count(*) calls FROM evaluations WHERE created_at>=? GROUP BY stage, model
    ORDER BY CASE stage WHEN 'luna' THEN 0 WHEN 'terra' THEN 1 WHEN 'sol' THEN 2 ELSE 3 END, calls DESC`).all(since) as any[])
    .map(r => ({ stage: String(r.stage), model: String(r.model), calls: r.calls }));
  // 新版日报的调用次数（brief_composed 审计）
  for (const r of db.prepare(`SELECT coalesce(json_extract(payload_json,'$.model'),'') model, sum(json_extract(payload_json,'$.aiCalls')) calls
    FROM audit_events WHERE action='brief_composed' AND created_at>=? AND json_extract(payload_json,'$.aiCalls') IS NOT NULL GROUP BY 1`).all(since) as any[])
    if (r.calls) byStage.push({ stage: 'digest', model: String(r.model || '—'), calls: Number(r.calls) });
  // 原今日页的时段卡片与运行概况
  const dayStart = new Date(Date.parse(`${taipeiDate(now)}T00:00:00+08:00`)).toISOString();
  // AI 调用：旧版 L1/L2/L3 每次判定在 evaluations 记一行；新版日报（digest_v2）的调用次数记在 brief_composed 审计里
  const aiCalls = (db.prepare(`SELECT count(*) calls FROM evaluations WHERE created_at>=?`).get(dayStart) as any).calls
    + Number((db.prepare(`SELECT coalesce(sum(json_extract(payload_json,'$.aiCalls')),0) n FROM audit_events WHERE action='brief_composed' AND created_at>=?`).get(dayStart) as any).n);
  const lastH = (q.harvests() as any[])[0];
  const enabled = sources.filter(x => x.enabled);
  const tgEnabled = tgSources.filter(t => t.enabled);
  const overview = renderTodayOverview({ now, dateLabel: weekdayLabel(now), slots,
    rss: { healthy: enabled.filter(x => x.health === 'healthy').length, enabled: enabled.length,
      lastHarvestAt: lastH?.started_at ?? null, lastHarvestNew: lastH?.new_items ?? null },
    telegram: { active: tgEnabled.filter(t => t.status === 'active').length, enabled: tgEnabled.length,
      messages24h: tgEnabled.reduce((n, t) => n + Number(t.messages_24h ?? 0), 0), authorized: !!worker?.authorized, heartbeatAt },
    ai: { calls: aiCalls }, disk: sys.disk });
  const tgSettings = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  const vision = telegramVisionSection({ csrf: s.csrf, settings: tgSettings, model: visionModelText(tgSettings), vision: visionStats(telegramDb, new Date(now)) });
  return html(reply, renderSystem({ csrf: s.csrf, now, units: sys.units, backups: sys.backups, disk: sys.disk, overview, vision,
    backupSettings: readBackupSettings(), gdrive: readGdriveStatus(), ai24h: { calls: byStage.reduce((n, r) => n + r.calls, 0), byStage } }));
});

// ---- 日报记录 ----
const REQUEST_DIR = process.env.REQUEST_DIR ?? '/var/lib/briefing/requests';
const RUN_ROWS = `SELECT r.id, r.window_key, r.window_label, r.scheduled_at, r.started_at, r.finished_at, r.status, r.stage, r.trigger, r.error,
    (SELECT count(*) FROM candidates c WHERE c.run_id=r.id) cands,
    b.id brief_id, ${BRIEF_ITEMS_SQL('b')} items,
    d.status delivery_status, d.sent_at,
    (SELECT count(*) FROM deliveries x WHERE x.brief_id=b.id AND x.delivery_type='resend' AND x.status='sent') resends
  FROM runs r
  LEFT JOIN briefs b ON b.id=(SELECT id FROM briefs WHERE run_id=r.id AND status='final' ORDER BY version DESC LIMIT 1)
  LEFT JOIN deliveries d ON d.id=(SELECT id FROM deliveries WHERE brief_id=b.id AND delivery_type='primary' ORDER BY id DESC LIMIT 1)`;
const NOTICES: Record<string, string> = {
  rerun: '已加入队列，后台会在几秒内开始重新运行，完整流程约需 10 分钟。刷新本页查看进度。',
  resend: '已加入队列，邮件会在几秒内重新发送，刷新本页可在投递记录里看到结果。',
  regen: '已清除该时段的要点汇总，1 分钟内会按当前的频道总结重新生成。',
};
const queuedWindows = () => pendingRequests(REQUEST_DIR).flatMap(r => r.type === 'rerun' ? [r.window] : []);

/** 日报 → Telegram 要点（原 Telegram → 要点汇总）。 */
const telegramDigestsHtml = (s: Session) => {
  const settings = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  return telegramDigestsSection({ csrf: s.csrf, settings,
    digests: (telegramDb.prepare('SELECT * FROM telegram_digests ORDER BY window_end DESC LIMIT 30').all() as any[])
      .map(d => ({ ...d, rendered_html: digestHtml(telegramDb, d) })),
    // 与 runDueDigests 的回溯范围一致：更早的时段删掉后不会再自动生成
    lookbackFrom: new Date(Date.now() - (Number(settings.raw_retention_days) + 1) * 864e5).toISOString() });
};

app.get<{ Querystring: { status?: string; tab?: string; notice?: string } }>('/runs', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (req.query.tab === 'telegram')
    return html(reply, renderRuns({ csrf: s.csrf, runs: [], filter: 'all', queued: [], telegramHtml: telegramDigestsHtml(s), notice: NOTICES[String(req.query.notice ?? '')] }));
  const filter = req.query.status === 'failed' ? 'failed' : 'all';
  const rss = rssOnly();
  const runs = (db.prepare(`${RUN_ROWS} ${filter === 'failed' ? "WHERE r.status<>'succeeded'" : ''} ORDER BY r.scheduled_at DESC LIMIT 60`).all() as RunRow[])
    .map(r => ({ ...r, rss_only: rss }));
  return reply.type('text/html; charset=utf-8').send(renderRuns({ csrf: s.csrf, runs, filter, queued: queuedWindows() }));
});

app.get<{ Params: { id: string }; Querystring: { notice?: string } }>('/runs/:id', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const found = db.prepare(`${RUN_ROWS} WHERE r.id=?`).get(Number(req.params.id)) as RunRow | undefined;
  const run = found ? { ...found, rss_only: rssOnly() } : undefined;
  if (!run) return reply.code(404).type('text/html; charset=utf-8').send(renderRuns({ csrf: s.csrf, runs: [], filter: 'all', queued: [], notice: '找不到这次运行记录' }));
  const deliveries = run.brief_id ? db.prepare(`SELECT delivery_type,resend_sequence,status,sent_at,created_at,error FROM deliveries WHERE brief_id=? ORDER BY id`).all(run.brief_id) as any[] : [];
  const candidates = (db.prepare(`SELECT c.id, v.title, f.source_id, f.canonical_url, c.decision, c.mandatory_class, c.section, c.filter_reason,
      e.stage, json_extract(e.result_json,'$.confidence') confidence,
      coalesce(json_extract(e.result_json,'$.filter_reason'), e.escalation_reasons) ai_reason,
      EXISTS(SELECT 1 FROM manual_overrides m WHERE m.target_type='candidate' AND m.target_id=CAST(c.id AS TEXT)) overridden
    FROM candidates c JOIN item_versions v ON v.id=c.item_version_id JOIN feed_items f ON f.id=v.item_id
    LEFT JOIN evaluations e ON e.id=(SELECT id FROM evaluations x WHERE x.candidate_id=c.id AND x.stage IN ('sol','terra','luna')
      ORDER BY CASE x.stage WHEN 'sol' THEN 0 WHEN 'terra' THEN 1 ELSE 2 END, x.id DESC LIMIT 1)
    WHERE c.run_id=? ORDER BY c.score DESC, c.id`).all(run.id) as any[])
    .map(c => ({ ...c, ai_reason: (() => { try { const v = JSON.parse(c.ai_reason); return Array.isArray(v) ? v.join('；') : String(c.ai_reason ?? ''); } catch { return c.ai_reason; } })() }));
  let retry: Parameters<typeof renderRunDetail>[0]['retry'];
  if (hasRunStateTables(db)) {
    const st = getRetryState(db, run.id);
    const attempts = db.prepare(`SELECT trigger,started_at,finished_at,outcome,unresolved,error_kind FROM run_attempts WHERE run_id=? ORDER BY id`).all(run.id) as any[];
    if (st || attempts.length) {
      let refused: Array<{ task: string; label: string }> = [];
      try { refused = (JSON.parse(st?.refused_json ?? '[]') as any[]).map(x => ({ task: String(x.task ?? ''), label: String(x.label ?? '') })); } catch { /* 损坏时不展示 */ }
      retry = { deadline_at: st?.deadline_at ?? null, next_attempt_at: st?.next_attempt_at ?? null, unresolved: st?.unresolved ?? 0,
        last_error_kind: st?.last_error_kind ?? null, refused, attempts };
    }
  }
  return reply.type('text/html; charset=utf-8').send(renderRunDetail({ csrf: s.csrf, run, deliveries, candidates, retry,
    queued: queuedWindows().includes(run.window_key), notice: NOTICES[String(req.query.notice ?? '')] }));
});

app.post<{ Params: { id: string } }>('/runs/:id/rerun', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s || !requireWrite(req, reply, s)) return;
  const run = db.prepare('SELECT id, window_key, status, finished_at FROM runs WHERE id=?').get(Number(req.params.id)) as any;
  if (!run) return reply.code(404).send({ error: '运行记录不存在' });
  if (run.status === 'succeeded') return reply.code(409).send({ error: '这次运行已经成功，如需再发一次请用“重新发送邮件”' });
  queueRequest(REQUEST_DIR, { type: 'rerun', window: run.window_key });
  return reply.redirect(`/runs/${run.id}?notice=rerun`);
});

app.post<{ Params: { id: string } }>('/runs/:id/resend', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s || !requireWrite(req, reply, s)) return;
  const b = db.prepare(`SELECT b.id FROM briefs b WHERE b.run_id=? AND b.status='final' ORDER BY b.version DESC LIMIT 1`).get(Number(req.params.id)) as any;
  if (!b) return reply.code(404).send({ error: '这次运行没有可发送的日报' });
  queueRequest(REQUEST_DIR, { type: 'resend', briefId: b.id });
  return reply.redirect(`/runs/${Number(req.params.id)}?notice=resend`);
});

// ---- 消息渠道：RSS（原订阅输出，所有 RSS 地址集中一处）与邮件（只读） ----
app.get('/feeds', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return reply.redirect('/channels?tab=rss');
});
/** 收件地址逐个只显示首字符与域名；任何一个解析不了就只显示人数，不回显原字符串 */
const maskEmail = (v: string | undefined): string | null => {
  const parts = String(v ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const masked = parts.map(p => { const m = /^(?:[^<]*<)?([^<>\s@,]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?$/.exec(p); return m ? `${m[1]!.slice(0, 1)}***@${m[2]}` : null; });
  return masked.every(Boolean) ? masked.join(', ') : `已设置 ${parts.length} 个收件人`;
};
app.get<{ Querystring: { tab?: string } }>('/channels', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const tab: ChannelTab = CHANNEL_TABS.some(([k]) => k === req.query.tab) ? req.query.tab as ChannelTab : 'rss';
  if (tab === 'email') {
    // 与 worker 同一判断：凭证不完整时实际是落盘、不发送，不能显示成「已配置」
    const t = resolveMailTransport();
    return html(reply, renderChannels({ csrf: s.csrf, now: Date.now(), tab, feeds: [],
      email: { mode: rssOnly() ? 'rss_only' : '发送邮件（RSS 同时更新）', configured: t.kind !== 'file', transport: t.kind === 'file' ? (t.note ?? '') : t.kind,
        to: maskEmail(process.env.MAIL_TO) } }));
  }
  const base = process.env.ADMIN_BASE_URL ?? '';
  const briefToken = briefFeedToken(db);
  const tg = telegramDb.prepare('SELECT all_rss_token FROM telegram_settings WHERE singleton=1').get() as any;
  const feeds: FeedRow[] = [
    { group: '日报', name: '日报', note: '每期一条：日报正文在前，后接同一时段的 Telegram 频道要点；每天 08:00 一期（覆盖前 24 小时）', url: briefToken ? `${base}/rss/briefs/${briefToken}` : null,
      lastAt: (db.prepare(`SELECT max(created_at) t FROM briefs WHERE status='final'`).get() as any).t, action: '/rss/briefs/token' },
    { group: 'Telegram', name: '跨频道要点', note: '每个时段一条，AI 合并所有频道并标注来源；与“全部频道”共用令牌',
      url: tg?.all_rss_token ? `${base}/rss/telegram/digest/${tg.all_rss_token}` : null,
      lastAt: (telegramDb.prepare(`SELECT max(window_end) t FROM telegram_digests WHERE status='completed'`).get() as any).t, action: '/telegram/rss/all/token' },
    { group: 'Telegram', name: '全部频道', note: '每个频道每个时段各一条；与“跨频道要点”共用令牌',
      url: tg?.all_rss_token ? `${base}/rss/telegram/all/${tg.all_rss_token}` : null,
      lastAt: (telegramDb.prepare(`SELECT max(window_end) t FROM telegram_summaries`).get() as any).t, action: '/telegram/rss/all/token' },
    ...(telegramDb.prepare(`SELECT s.id, s.reference, coalesce(s.display_name,s.title,s.reference) name, s.rss_token, s.enabled,
        (SELECT max(window_end) FROM telegram_summaries m WHERE m.source_id=s.id) last
      FROM telegram_sources s WHERE s.source_type='normal' ORDER BY s.enabled DESC, s.id`).all() as any[]).map(t => ({
      group: 'Telegram 单个频道', name: t.name, note: `${t.reference}${t.enabled ? '' : ' · 已停用'}`,
      url: t.rss_token ? `${base}/rss/telegram/source/${t.rss_token}` : null, lastAt: t.last, action: `/telegram/sources/${t.id}/token` })),
  ];
  return html(reply, renderChannels({ csrf: s.csrf, now: Date.now(), tab, feeds, email: { mode: '', configured: false, transport: '', to: null } }));
});

app.post('/rss/briefs/token', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s || !requireWrite(req, reply, s)) return;
  rotateBriefFeedToken(db, (req.body as any)?.action === 'revoke'); return reply.redirect(back(req, '/channels?tab=rss'));
});
app.get<{Params:{token:string}}>('/rss/briefs/:token', async (req, reply) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.token)) return reply.code(404).send('订阅不存在');
  const body = briefsRss(db, req.params.token, process.env.ADMIN_BASE_URL ?? '', 20);
  if (body === null) return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control', 'private, no-store, max-age=0').header('Referrer-Policy', 'no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});

// ---- Telegram：各部分分散到订阅源 / 日报 / 系统运行 / 设置（§1、§2）----
const tgErr = (e: any, fallback: string): [number, string] => e instanceof TelegramError ? [e.code, e.message] : [500, fallback];
const TG_OLD_TABS: Record<string, string> = { digests: '/runs?tab=telegram', vision: '/system#vision', login: '/settings?tab=telegram' };
app.get<{ Querystring: { tab?: string } }>('/telegram', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return reply.redirect(TG_OLD_TABS[String(req.query.tab ?? '')] ?? '/subscriptions?tab=telegram');
});

app.post('/telegram/vision/limit', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return;
  try { setVisionDailyLimit(telegramDb, (req.body as any)?.limit); return reply.redirect('/settings?tab=telegram&saved=vision#vision'); }
  catch(e:any){ const [code,msg]=tgErr(e,'保存失败'); return html(reply, settingsPage(s,{error:msg, tgForm:{vision_daily_limit:String((req.body as any)?.limit??'')}},'telegram'), code); }
});
app.post('/telegram/retention', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return; const b=(req.body??{}) as any;
  try { updateTelegramRetention(telegramDb, { keepForever: b.keep_forever === '1', rawDays: b.raw_retention_days, summaryDays: b.summary_retention_days });
    return reply.redirect('/settings?tab=data&saved=retention#retention'); }
  catch(e:any){ const [code,msg]=tgErr(e,'保存失败');
    return html(reply, settingsPage(s,{error:msg, tgForm:{keep_messages_forever:b.keep_forever==='1'?1:0, raw_retention_days:String(b.raw_retention_days??''), summary_retention_days:String(b.summary_retention_days??'')}},'data'), code); }
});
app.post('/telegram/digests/regenerate', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return;
  const w = String((req.body as any)?.window_end ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(w))
    return html(reply, renderRuns({ csrf: s.csrf, runs: [], filter: 'all', queued: [], telegramHtml: telegramDigestsHtml(s), error: '时段格式无效' }), 400);
  telegramDb.prepare('DELETE FROM telegram_digests WHERE window_end=?').run(w);
  return reply.redirect('/runs?tab=telegram&notice=regen');
});

app.post('/telegram/sources', async (req, reply) => {
  const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return;
  const b=(req.body??{}) as any;
  try { const r=addTelegramSource(telegramDb,{reference:String(b.reference??''),displayName:String(b.display_name??''),sourceType:String(b.source_type??'normal') as any});
    return html(reply, subscriptionsPage(s,'telegram',{saved:`来源 #${r.id} 已进入异步验证队列。`})); }
  catch(e:any){ const [code,msg]=tgErr(e,'新增来源失败');
    return html(reply, subscriptionsPage(s,'telegram',{error:msg, tgForm:{display_name:String(b.display_name??''),reference:String(b.reference??''),source_type:String(b.source_type??'')}}), code); }
});
/** Telegram 区每行的操作：成功回到原页面（订阅源或消息渠道），失败显示在订阅源 · Telegram 区。 */
function tgRowAction(path: string, fallbackError: string, fn: (id: number, b: any) => void) {
  app.post<{Params:{id:string}}>(path, async (req, reply) => {
    const s=requireAuth(req,reply); if(!s||!requireWrite(req,reply,s))return;
    try { fn(Number(req.params.id), (req.body ?? {}) as any); return reply.redirect(back(req,'/subscriptions?tab=telegram')); }
    catch(e:any){ const [code,msg]=tgErr(e,fallbackError); return html(reply, subscriptionsPage(s,'telegram',{error:msg}), code); }
  });
}
tgRowAction('/telegram/sources/:id/retry', '重试失败', id => retryTelegramSource(telegramDb, id));
tgRowAction('/telegram/sources/:id/toggle', '启停失败', (id, b) => toggleTelegramSource(telegramDb, id, String(b.enabled) === 'true'));
tgRowAction('/telegram/sources/:id/name', '保存显示名失败', (id, b) => renameTelegramSource(telegramDb, id, String(b.display_name ?? '')));
tgRowAction('/telegram/sources/:id/token', '令牌操作失败', (id, b) => rotateSourceToken(telegramDb, id, b.action === 'revoke'));
app.post('/telegram/rss/all/token',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  rotateAllToken(telegramDb,(req.body as any)?.action==='revoke');return reply.redirect(back(req,'/channels?tab=rss'));
});
app.post('/telegram/settings',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return; const b=(req.body??{}) as any;
  const managed = loadModelSnapshot(db).enabled;
  try{updateTelegramSettings(telegramDb,{timezone:b.timezone,schedule:b.schedule,provider:b.provider,model:b.model,baseUrl:b.base_url,credentialRef:b.credential_ref,promptRules:b.prompt_rules,modelMode:b.model_mode,managedModels:managed});
    return reply.redirect('/settings?tab=telegram&saved=telegram#telegram');}
  catch(e:any){ const [code,msg]=tgErr(e,'设置保存失败');
    // 409（模型配置方式已变化）时不回填，按当前方式重新显示；其余错误回填非敏感输入
    const sched = String(b.schedule ?? '').split(',').map((x: string) => x.trim()).filter(Boolean);
    const tgForm = code === 409 ? undefined : { timezone: String(b.timezone ?? ''), schedule_json: JSON.stringify(sched), prompt_rules: String(b.prompt_rules ?? ''),
      ...(managed ? {} : { provider: String(b.provider ?? ''), model: String(b.model ?? ''), base_url: String(b.base_url ?? ''), credential_ref: String(b.credential_ref ?? '') }) };
    return html(reply, settingsPage(s,{error:msg, tgForm},'telegram'), code); }
});
app.post('/telegram/vision/resume',async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  resumeVisionQueue(telegramDb);return reply.redirect(back(req,'/system#vision'));
});
for(const command of ['start','code','password'] as LoginCommand[]) app.post(`/telegram/login/${command}`,async(req,reply)=>{
  const s=requireAuth(req,reply);if(!s||!requireWrite(req,reply,s))return;
  try{const result=await sendLoginCommand(command,String((req.body as any)?.value??''));
    return html(reply, settingsPage(s,result.ok?{saved:`登录状态：${result.state??'已更新'}`}:{error:result.error??'登录失败'},'telegram'));}
  catch{return html(reply, settingsPage(s,{error:'Telegram 采集器未运行，或登录 Socket 不可用'},'telegram'), 503);}
});

app.get<{Params:{token:string}}>('/rss/telegram/source/:token',async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return reply.code(404).send('订阅不存在');
  const body=sourceRss(telegramDb,req.params.token,process.env.ADMIN_BASE_URL??'');
  if(body===null)return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control','private, no-store, max-age=0').header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});
app.get<{Params:{token:string}}>('/rss/telegram/all/:token',async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return reply.code(404).send('订阅不存在');
  const body=allRss(telegramDb,req.params.token,process.env.ADMIN_BASE_URL??'');
  if(body===null)return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control','private, no-store, max-age=0').header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});
app.get<{Params:{token:string}}>('/rss/telegram/digest/:token',async(req,reply)=>{
  if(!/^[a-f0-9]{64}$/.test(req.params.token))return reply.code(404).send('订阅不存在');
  const body=digestRss(telegramDb,req.params.token,process.env.ADMIN_BASE_URL??'');
  if(body===null)return reply.code(404).send('订阅不存在');
  return reply.header('Cache-Control','private, no-store, max-age=0').header('Referrer-Policy','no-referrer').type('application/rss+xml; charset=utf-8').send(body);
});

// ---- 订阅源：RSS / Telegram / X 三个区域（§1、§2） ----
type SubExtra = { saved?: string; error?: string; form?: Record<string, string>; tgForm?: { display_name?: string; reference?: string; source_type?: string } };
function subscriptionsPage(s: Session, tab: SubscriptionTab, extra: SubExtra = {}) {
  const tg = telegramSources();
  const { tgForm, ...rest } = extra;
  const telegramHtml = tab === 'telegram' ? telegramSourcesSection({ csrf: s.csrf, sources: tg,
    worker: telegramDb.prepare('SELECT * FROM telegram_worker_state WHERE singleton=1').get() as any,
    baseUrl: process.env.ADMIN_BASE_URL ?? '',
    timezone: (telegramDb.prepare('SELECT timezone FROM telegram_settings WHERE singleton=1').get() as any)?.timezone ?? 'Asia/Shanghai',
    form: tgForm }) : undefined;
  return renderSubscriptions({ csrf: s.csrf, tab, sources: q.sources() as any, tests: q.tests() as any, telegramHtml, telegramCount: tg.length, ...rest });
}
/** 表单所属区域：新增 / 测试按「类型」，其余按返回地址里的 tab。 */
const tabFromForm = (b: any): SubscriptionTab => {
  if (b?.kind === 'x') return 'x';
  if (b?.kind === 'rss') return 'rss';
  const m = /[?&]tab=(rss|x|telegram)(?:&|#|$)/.exec(String(b?.redirect ?? ''));
  return (m?.[1] as SubscriptionTab) ?? 'rss';
};
/** 来源所在区域：按库里的 host_group；来源不存在时按表单。 */
const tabOfSource = (id: string, b: any): SubscriptionTab => {
  const r = db.prepare('SELECT host_group FROM sources WHERE id=?').get(id) as any;
  return r ? (isXSource(r) ? 'x' : 'rss') : tabFromForm(b);
};
/** 错误时可回填的新增来源字段（白名单）；地址带用户名口令、认证参数或像令牌的路径片段时不回填。 */
const ADD_FORM_FIELDS = ['id', 'name', 'url', 'parser', 'category', 'source_group', 'tier', 'priority', 'kind'];
const refillForm = (b: any): Record<string, string> => Object.fromEntries(ADD_FORM_FIELDS.filter(k => b?.[k] != null)
  .map(k => [k, k === 'url' ? safeFormUrl(b[k]) : String(b[k]).slice(0, 500)]));
const actionMsg = (req: any, e: unknown, what: string): [number, string] => {
  if (e instanceof ActionError) return [e.code, e.message];
  req.log.error({ err: errorText(e) }, what);
  return [500, '内部错误'];
};

app.get('/sources', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return reply.redirect('/subscriptions?tab=rss');
});
app.get<{ Querystring: { tab?: string } }>('/subscriptions', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const tab = SUBSCRIPTION_TABS.some(([k]) => k === req.query.tab) ? req.query.tab as SubscriptionTab : 'rss';
  return html(reply, subscriptionsPage(s, tab));
});

/** 仅测试，不添加（FR-004：不写入正式简报，但保存诊断日志） */
app.post('/sources/test', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const tab = tabFromForm(b);
  const t = await testSource(db, { url: String(b.url ?? ''), parser: String(b.parser ?? 'rss') });
  const msg = t.ok
    ? `测试通过：解析出 ${t.parsedCount} 条，耗时 ${t.latencyMs}ms。` +
      (t.sample.length ? ` 首条「${t.sample[0]!.title.slice(0, 40)}」` : '')
    : undefined;
  const form = { url: safeFormUrl(b.url), parser: String(b.parser ?? 'rss') };
  return html(reply, subscriptionsPage(s, tab, t.ok ? { saved: msg, form } : { error: `测试失败（${t.outcome}）：${t.error}`, form }));
});

/** 新增来源：测试通过后直接启用并进入观察期（§4）；类型决定进入 RSS 区还是 X 区。 */
app.post('/sources/add', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const tab = tabFromForm(b);
  try {
    const r = await addSource(db, {
      id: String(b.id ?? ''), name: String(b.name ?? ''), url: String(b.url ?? ''),
      parser: String(b.parser ?? 'rss'), category: String(b.category ?? 'tech'),
      sourceGroup: String(b.source_group ?? 'unclassified'),
      tier: String(b.tier ?? 'standard'), priority: Number(b.priority ?? 5),
      kind: tab === 'x' ? 'x' : 'rss', actor: 'owner',
    });
    return html(reply, subscriptionsPage(s, tab, { saved: `来源「${r.id}」测试通过（解析出 ${r.parsedCount} 条），已启用并进入观察期。` }));
  } catch (e) {
    const [code, msg] = actionMsg(req, e, '新增来源失败');
    return html(reply, subscriptionsPage(s, tab, { error: msg, form: refillForm(b) }), code);
  }
});

/** 单个来源的写操作：成功与失败都回到该来源所在的区域。 */
function sourceAction(path: string, what: string, fn: (id: string, b: any) => Promise<string> | string) {
  app.post<{ Params: { id: string } }>(path, async (req, reply) => {
    const s = requireAuth(req, reply); if (!s) return;
    if (!requireWrite(req, reply, s)) return;
    const b = (req.body ?? {}) as any;
    const tab = tabOfSource(req.params.id, b);
    try { return html(reply, subscriptionsPage(s, tab, { saved: await fn(req.params.id, b) })); }
    catch (e) { const [code, msg] = actionMsg(req, e, what); return html(reply, subscriptionsPage(s, tab, { error: msg }), code); }
  });
}
sourceAction('/sources/:id/delete', '删除来源失败', (id, b) => {
  const r = deleteSource(db, id, String(b.reason ?? ''), 'owner');
  return `来源已删除并停用。已抓取的 ${r.retainedItems} 条内容按审计要求保留。`;
});
sourceAction('/sources/:id/url', '修改来源 URL 失败', async (id, b) => {
  const r = await updateSourceUrl(db, { sourceId: id, url: String(b.url ?? ''), reason: String(b.reason ?? ''), actor: 'owner' });
  return `来源「${r.sourceId}」的订阅 URL 已更新；测试解析出 ${r.parsedCount} 条。`;
});
sourceAction('/sources/:id/group', '修改来源分组失败', (id, b) => {
  updateSourceGroup(db, id, String(b.source_group ?? ''), String(b.reason ?? ''), 'owner');
  return '来源分组已更新。';
});

// ---------- 只读 API ----------
app.get('/api/v1/dashboard', async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return { sources: q.sources(), harvests: q.harvests(), runs: q.runs(), stats: q.stats() };
});
app.get('/api/v1/sources', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.sources();
});
/** 后台自动化新增来源：与网页表单共用校验、测试抓取和审计；测试通过后直接启用并进入观察期（§7）。 */
app.post('/api/v1/sources', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    const r = await addSource(db, {
      id: String(b.id ?? ''), name: String(b.name ?? ''), url: String(b.url ?? ''),
      parser: String(b.parser ?? 'rss'), category: String(b.category ?? 'tech'),
      sourceGroup: String(b.source_group ?? 'unclassified'),
      tier: String(b.tier ?? 'standard'), priority: Number(b.priority ?? 5),
      mandatoryRetention: !!b.mandatory_retention, kind: b.kind == null ? 'rss' : String(b.kind), actor: 'owner',
    });
    return reply.code(201).send({ id: r.id, status: r.status });
  } catch (e) {
    const [code, msg] = actionMsg(req, e, 'API 新增来源失败');
    return reply.code(code).send({ error: msg });
  }
});
app.post<{ Params: { id: string } }>('/api/v1/sources/:id/url', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try { return await updateSourceUrl(db, { sourceId: req.params.id,
    url: String(b.url ?? ''), reason: String(b.reason ?? ''), actor: 'owner' }); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.post<{ Params: { id: string } }>('/api/v1/sources/:id/group', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  try { return updateSourceGroup(db, req.params.id, String((req.body as any)?.source_group ?? ''),
    String((req.body as any)?.reason ?? ''), 'owner'); }
  catch (e) { const msg = e instanceof ActionError ? e.message : '内部错误';
    return reply.code(e instanceof ActionError ? e.code : 500).send({ error: msg }); }
});
app.get('/api/v1/runs', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.runs();
});
app.get<{ Params: { id: string } }>('/api/v1/runs/:id/candidates', async (req, reply) => {
  if (!requireAuth(req, reply)) return; return q.candidates(Number(req.params.id));
});

// ---------- 写操作（PRD 16.4 / 16.5 / 19.2：全部留痕） ----------

/** 把 ActionError 映射为 HTTP 响应，其余错误交给全局处理器。 */
function handleAction(reply: any, fn: () => unknown) {
  try { return { ok: true, result: fn() }; }
  catch (e) {
    if (e instanceof ActionError) { reply.code(e.code).send({ error: e.message }); return null; }
    throw e;
  }
}

app.post<{ Params: { id: string } }>('/candidates/:id/override', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const r = handleAction(reply, () => overrideCandidate(db, {
    candidateId: Number(req.params.id),
    action: b.action, reason: b.reason, scope: b.scope,
    mandatoryClass: b.mandatory_class ?? null, section: b.section ?? null,
    actor: 'owner',
  }));
  if (!r) return;
  return b.redirect ? reply.redirect(back(req, '/')) : r.result;
});

app.post<{ Params: { id: string } }>('/sources/:id/toggle', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  // 网页表单（带 redirect）：成功回到原区域，失败显示在该来源所在的区域；不带 redirect 的调用照旧返回 JSON
  if (b.redirect) {
    const tab = tabOfSource(req.params.id, b);
    try { toggleSource(db, req.params.id, String(b.enabled) === 'true', b.reason, 'owner'); return reply.redirect(back(req, `/subscriptions?tab=${tab}`)); }
    catch (e) { const [code, msg] = actionMsg(req, e, '启停来源失败'); return html(reply, subscriptionsPage(s, tab, { error: msg }), code); }
  }
  const r = handleAction(reply, () =>
    toggleSource(db, req.params.id, String(b.enabled) === 'true', b.reason, 'owner'));
  if (!r) return;
  return r.result;
});

/** 补发第一步：只返回确认信息，不发送（PRD 16.5 两步确认）。 */
app.get<{ Params: { id: string }; Querystring: { to?: string } }>(
  '/api/v1/briefs/:id/resend-plan', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const to = req.query.to ?? process.env.MAIL_TO ?? '';
  if (!to) return reply.code(400).send({ error: '缺少收件人' });
  const r = handleAction(reply, () => planResend(db, Number(req.params.id), to));
  return r ? r.result : undefined;
});

// ---------- 设置（AI 供应商与 API Key） ----------
const envOverrides = () => {
  const names = ['AI_PROVIDER','AI_L1_PROVIDER','AI_L1_MODEL','AI_L2_MODEL','AI_L3_MODEL',
                 'AI_L2_PROVIDER','AI_L3_PROVIDER','AI_L1_BASE_URL','AI_L2_BASE_URL',
                 'AI_L3_BASE_URL', ...SECRET_NAMES];
  return names.filter(n => !!process.env[n]);
};

/** 每个使用方当前实际生效的配置摘要（只含类型、主机、模型；不含密钥与地址路径）。 */
function modelStatus(enabled: boolean, tgSettings: any): ConsumerStatus[] {
  const fmt = (type: string, baseUrl: string | undefined, model: string) =>
    `${PROVIDER_TYPE_LABEL[type as ProviderType] ?? type} · ${hostOf(baseUrl) || '官方地址'} · ${model || '（无模型）'}`;
  if (enabled) {
    const snap = loadModelSnapshot(db);
    return CONSUMERS.map(c => {
      const r = resolveModel(snap, c);
      if (!r.ok) return { consumer: c, ok: false, text: CONFIG_ERROR_LABEL[r.error] };
      if (r.disabled) return { consumer: c, ok: true, text: '已停用' };
      return { consumer: c, ok: true, text: fmt(r.cfg.provider, r.cfg.baseUrl, r.cfg.model) };
    });
  }
  return collectLegacy(tgSettings, workerEnvCopy()).map(p => p.reason ? { consumer: p.consumer, ok: false, text: p.reason }
    : p.disabled ? { consumer: p.consumer, ok: true, text: '旧配置：未启用 / 模拟' }
    : { consumer: p.consumer, ok: true, text: `旧配置：${fmt(p.cfg!.provider, p.cfg!.baseUrl, p.cfg!.model)}${p.cfg!.apiKey ? '' : '（无密钥）'}` });
}

function modelsSection(s: Session): { html: string; enabled: boolean } {
  const raw = readModelConfig(db);
  const key = currentMasterKey();
  const tgSettings = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  const providers = raw.providers.map(p => { const o = openProvider(p, key); return { ...p, baseUrl: o.error ? null : (o.baseUrl ?? '') }; });
  return { enabled: raw.enabled, html: renderModelsSection({ csrf: s.csrf, enabled: raw.enabled, revision: raw.revision, keyOk: !!key, keyProblem: masterKeyProblem(),
    providers, assignments: raw.assignments, status: modelStatus(raw.enabled, tgSettings) }) };
}

type SettingsExtra = { saved?: string; error?: string;
  /** 保存失败时回填的 Telegram 设置字段（都是非敏感字段），覆盖库里的值用于显示 */
  tgForm?: Record<string, unknown> };
function settingsPage(s: Session, extra: SettingsExtra = {}, tab: SettingsTab = 'models') {
  const h = vaultHealthy();
  const models = modelsSection(s);
  const { tgForm, ...rest } = extra;
  const tgSettings = { ...(telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any), ...(tgForm ?? {}) };
  return renderSettings({
    tab, models: models.html, managed: models.enabled,
    csrf: s.csrf, vaultOk: h.ok, vaultReason: h.reason,
    secrets: maskedSecrets(), settings: resolveSettings() as any,
    envOverrides: envOverrides(),
    telegramLogin: telegramLoginSection({ csrf: s.csrf, worker: telegramDb.prepare('SELECT * FROM telegram_worker_state WHERE singleton=1').get() as any }),
    telegram: renderTelegramSettings({ csrf: s.csrf, managed: models.enabled, settings: tgSettings }),
    retention: renderTelegramRetention({ csrf: s.csrf, settings: tgSettings }),
    backups: renderBackupSwitches(s.csrf, readBackupSettings(), readGdriveStatus()),
    embedding: resolveEmbeddingConfig(),
    ...rest,
  });
}
const SETTINGS_SAVED: Record<string, [SettingsTab, string]> = {
  telegram: ['telegram', 'Telegram 总结设置已保存，已完成的历史总结不会重写。'],
  vision: ['telegram', '图片识别每日上限已保存。'],
  retention: ['data', '数据保留设置已保存，下次维护时生效。'],
  backups: ['data', '备份设置已保存，下次备份时生效。'],
};

app.get<{ Querystring: { saved?: string; tab?: string } }>('/settings', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const saved = SETTINGS_SAVED[String(req.query.saved ?? '')];
  const tab = SETTINGS_TABS.some(([k]) => k === req.query.tab) ? req.query.tab as SettingsTab : saved?.[0] ?? 'models';
  return html(reply, settingsPage(s, { saved: saved?.[1] }, tab));
});

app.post('/settings/ai', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  try {
    setSettings({
      aiProvider: String(b.ai_provider ?? '').trim(),
      l1Provider: String(b.l1_provider ?? '').trim(),
      l1Model: String(b.l1_model ?? '').trim(),
      l2Model: String(b.l2_model ?? '').trim(),
      l3Model: String(b.l3_model ?? '').trim(),
      l2Provider: String(b.l2_provider ?? '').trim(),
      l3Provider: String(b.l3_provider ?? '').trim(),
      l1BaseUrl: String(b.l1_base_url ?? '').trim(),
      l2BaseUrl: String(b.l2_base_url ?? '').trim(),
      l3BaseUrl: String(b.l3_base_url ?? '').trim(),
    });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
      VALUES ('settings','ai','ai_settings_updated',?,?)`)
      .run(JSON.stringify({ l1Provider: b.l1_provider, l1Model: b.l1_model, l1BaseUrl: b.l1_base_url || 'default',
        l2Provider: b.l2_provider || 'same-as-l1', l2BaseUrl: b.l2_base_url || 'default',
        l3Provider: b.l3_provider || 'same-as-l1', l3BaseUrl: b.l3_base_url || 'default', actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: '供应商设置已保存。worker 下次运行即生效。' }));
  } catch (e: any) {
    return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: String(e?.message ?? e) }));
  }
});

// ---------- 全局模型供应商（docs/model-providers-design.md 第 3 版定稿） ----------
const modelsPage = (reply: any, s: Session, r: { saved?: string; error?: string }, code = 200) =>
  reply.code(code).type('text/html; charset=utf-8').send(settingsPage(s, r));
/** 写操作统一处理：登录、CSRF、只读模式；ModelConfigError 显示给管理员（不含密钥与地址路径）。 */
function modelWrite(path: string, fn: (b: any, rev: number, req: any) => Promise<string> | string) {
  app.post(path, async (req, reply) => {
    const s = requireAuth(req, reply); if (!s) return;
    if (!requireWrite(req, reply, s)) return;
    const b = (req.body ?? {}) as any;
    try { return modelsPage(reply, s, { saved: await fn(b, Number(b.revision), req) }); }
    catch (e: any) {
      if (e instanceof ModelConfigError) return modelsPage(reply, s, { error: e.message }, e.code === 'conflict' ? 409 : 400);
      req.log.error({ err: String(e?.message ?? e).slice(0, 200) }, 'model config write failed');
      return modelsPage(reply, s, { error: '保存失败，请查看服务日志' }, 500);
    }
  });
}

async function refreshModels(id: string): Promise<string> {
  const row = db.prepare('SELECT * FROM model_providers WHERE id=?').get(id) as any;
  if (!row) throw new ModelConfigError('供应商不存在');
  if (row.models_next_allowed_at && row.models_next_allowed_for === row.config_version && Date.parse(row.models_next_allowed_at) > Date.now())
    return `被限流，${row.models_next_allowed_at.slice(11, 16)} UTC 之后再试`;
  const o = openProvider(row, currentMasterKey());
  if (o.error || !o.apiKey) throw new ModelConfigError('密钥无法读取，不能拉取模型列表');
  if (!tryStartFetch(id)) return '模型列表正在拉取或 10 秒内刚拉取过，请稍后再试';
  try {
    const r = await fetchModelCatalog(row.type, o.baseUrl, o.apiKey);
    const applied = applyModelsFetch(db, id, row.config_version, r);
    if (!applied) return '拉取期间供应商配置已变化，本次结果已丢弃';
    return r.ok ? `模型列表已更新：${r.models.length} 个${r.truncated ? '（列表不完整）' : ''}` : `模型列表拉取失败（${r.kind}${r.status ? ` HTTP ${r.status}` : ''}），已保留原列表`;
  } finally { endFetch(id); }
}

const requireStrongKey = () => { const weak = masterKeyProblem(); if (weak) throw new ModelConfigError(`${weak}；请先在 /etc/briefing/env 换成强主密钥并重启 brief-web`); };
modelWrite('/settings/models/import', (b) => {
  requireStrongKey();
  const tg = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get();
  const r = importLegacy(db, currentMasterKey(), tg, Number(b.revision));
  if (!r.ok) throw new ModelConfigError(`未导入：${r.reasons.join('；')}`);
  return `已导入 ${r.providers} 个供应商并启用。请在「模型分配」中逐个测试。`;
});
modelWrite('/settings/models/enable', (b, rev) => {
  const on = b.enabled === '1';
  setModelConfigEnabled(db, on, rev);
  return on ? '已启用全局模型供应商，worker 下一个任务起生效。' : '已停用，回到旧配置（env 与各处设置）。';
});
modelWrite('/settings/models/providers', async (b, rev) => {
  requireStrongKey();
  const r = createModelProvider(db, currentMasterKey(), { name: b.name, type: b.type, baseUrl: b.base_url, apiKey: b.api_key }, rev);
  return `供应商已保存。${await refreshModels(r.id)}`;
});
modelWrite('/settings/models/providers/:id', async (b, rev, req) => {
  const id = String(req.params.id);
  const r = updateModelProvider(db, currentMasterKey(), id, { name: b.name, type: b.type, baseUrl: b.base_url, apiKey: b.api_key, clearKey: b.clear_key === '1' }, rev);
  return r.reconfigured && String(b.api_key ?? '').trim() ? `供应商已保存。${await refreshModels(id)}` : '供应商已保存。';
});
modelWrite('/settings/models/providers/:id/delete', (_b, rev, req) => { deleteModelProvider(db, String(req.params.id), rev); return '供应商已删除。'; });
modelWrite('/settings/models/providers/:id/manual', (b, rev, req) => {
  setManualModels(db, String(req.params.id), String(b.models ?? '').split(/\r?\n/), rev); return '手动模型已保存。';
});
modelWrite('/settings/models/providers/:id/refresh', (_b, _rev, req) => refreshModels(String(req.params.id)));
modelWrite('/settings/models/assignments', (b, rev) => {
  const inputs: AssignmentInput[] = [];
  for (const c of CONSUMERS) {
    const t = String(b[`${c}_target`] ?? '');
    if (!t) continue;
    if (t === 'disabled') inputs.push({ consumer: c, mode: 'disabled' });
    else if (t.startsWith('follow:')) inputs.push({ consumer: c, mode: 'follow', follow: t.slice(7) });
    else if (t.startsWith('p:')) inputs.push({ consumer: c, mode: 'provider', providerId: t.slice(2), model: b[`${c}_model`], strictness: b[`${c}_strictness`] });
    else throw new ModelConfigError(`${CONSUMER_LABEL[c]}：选项无效`);
  }
  saveAssignments(db, inputs, rev);
  return '分配已保存，worker 下一个任务起生效。';
});

// 测试当前生效配置：与 worker 同一解析入口；只显示成功 / 错误类型与耗时，不显示上游正文
let modelTestRunning = false, modelTestAt = 0;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
modelWrite('/settings/models/test', async (b) => {
  const c = String(b.consumer) as Consumer;
  if (!CONSUMERS.includes(c)) throw new ModelConfigError('未知用途');
  if (modelTestRunning || Date.now() - modelTestAt < 10_000) return '测试过于频繁，请 10 秒后再试';
  const snap = loadModelSnapshot(db);
  let cfg: any;
  if (c === 'embedding') {
    const e = embeddingPick(snap);
    if (!e.config) throw new ModelConfigError(`无法测试：${e.note}`);
    modelTestRunning = true; modelTestAt = Date.now();
    try { const t = await testEmbedding(e.config); return `${CONSUMER_LABEL[c]}测试通过：${t.dims} 维，${t.ms} ms`; }
    catch (err: any) { throw new ModelConfigError(`${CONSUMER_LABEL[c]}测试失败：${err instanceof EmbeddingError ? err.message : '未知错误'}`); }
    finally { modelTestRunning = false; }
  }
  if (snap.enabled) {
    const r = resolveModel(snap, c);
    if (!r.ok) throw new ModelConfigError(`无法测试：${CONFIG_ERROR_LABEL[r.error]}`);
    if (r.disabled) return `${CONSUMER_LABEL[c]}已停用，无需测试`;
    cfg = r.cfg;
  } else if (c === 'l1' || c === 'l2' || c === 'l3') {
    // 后台不 hydrate 保管库：用 worker 实际看到的环境副本解析，测的就是 worker 跑的
    const p = tierPick(snap, c.toUpperCase() as any, workerEnvCopy()); if (!p.ok) throw new ModelConfigError(p.message); cfg = p.cfg;
  } else {
    cfg = legacyTelegramConfig(telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get(), c, workerEnvCopy());
  }
  modelTestRunning = true; modelTestAt = Date.now();
  const t0 = Date.now();
  try {
    const p = await createProvider({ ...cfg, timeoutMs: 30_000 }, { retry: false });
    await p.complete({ systemPrompt: '只输出 JSON。', userContent: '返回 {"ok": true}', maxOutputTokens: 50, schemaName: 'ping',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      ...(c === 'telegramVision' ? { images: [{ mimeType: 'image/png', data: TINY_PNG }] } : {}) } as any);
    return `${CONSUMER_LABEL[c]}测试通过（${Date.now() - t0} ms）`;
  } catch (err: any) {
    throw new ModelConfigError(`${CONSUMER_LABEL[c]}测试失败：${err?.kind ?? 'error'}${err?.status ? ` HTTP ${err.status}` : ''}`);
  } finally { modelTestRunning = false; }
});

// 部署验收与恢复核对：开关、revision、每个使用方的解析结果（不含密钥与地址路径）。需要登录。
app.get('/health/models', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  const raw = readModelConfig(db);
  const tg = telegramDb.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get();
  return { enabled: raw.enabled, revision: raw.revision, masterKey: !!currentMasterKey(), providers: raw.providers.length,
    consumers: modelStatus(raw.enabled, tg) };
});

// ---------- 向量模型（语义去重） ----------
app.post('/settings/embedding', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  if (loadModelSnapshot(db).enabled) {
    // 全局模型供应商接管：本表单只管维度与阈值
    const dims = { dimensions: str(b.dimensions, 6), simHigh: str(b.sim_high, 10) || '0.9', simLow: str(b.sim_low, 10) || '0.8' };
    const errs = validateEmbeddingConfig(parseEmbeddingFields({ enabled: 'true', baseUrl: 'https://example.com/v1', model: 'm', ...dims }, 'k'));
    if (errs.length) return reply.code(400).type('text/html; charset=utf-8').send(settingsPage(s, { error: `向量模型设置未保存：${errs.join('；')}` }));
    setSettings({ embeddingDimensions: dims.dimensions, dedupSimHigh: dims.simHigh, dedupSimLow: dims.simLow });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('settings','embedding','embedding_settings_updated',?,?)`)
      .run(JSON.stringify({ ...dims, managed: true, actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: '向量维度与阈值已保存。' }));
  }
  const fields = { enabled: b.enabled === 'on' ? 'true' : 'false', baseUrl: str(b.base_url, 300), model: str(b.model, 200),
    dimensions: str(b.dimensions, 6), simHigh: str(b.sim_high, 10), simLow: str(b.sim_low, 10) };
  const cfg = parseEmbeddingFields(fields, 'placeholder');
  // 启用时必须校验通过；关闭时允许保存不完整的配置，但地址格式仍须合法（防止把密钥写进地址）
  const errs = validateEmbeddingConfig(cfg).filter(e => cfg.enabled || /Base URL/.test(e) && fields.baseUrl);
  if (errs.length) return reply.code(400).type('text/html; charset=utf-8').send(settingsPage(s, { error: `向量模型设置未保存：${errs.join('；')}` }));
  try {
    setSettings({ embeddingEnabled: fields.enabled, embeddingBaseUrl: cfg.baseUrl, embeddingModel: fields.model,
      embeddingDimensions: fields.dimensions, dedupSimHigh: fields.simHigh || '0.9', dedupSimLow: fields.simLow || '0.8' });
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('settings','embedding','embedding_settings_updated',?,?)`)
      .run(JSON.stringify({ enabled: cfg.enabled, model: fields.model, dimensions: cfg.dimensions, simHigh: cfg.simHigh, simLow: cfg.simLow,
        baseUrlHost: cfg.baseUrl ? new URL(cfg.baseUrl).host : null, actor: 'owner' }), nowIso());
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: '向量模型设置已保存。worker 下次运行即生效。' }));
  } catch (e: any) {
    return reply.code(500).type('text/html; charset=utf-8').send(settingsPage(s, { error: '保存失败：' + String(e?.message ?? e).slice(0, 200) }));
  }
});

// 连通性测试：测"当前生效"的配置（环境变量优先），限 10 秒一次、同时最多 1 个
let embeddingTestAt = 0, embeddingTestRunning = false;
app.post('/settings/embedding/test', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  if (embeddingTestRunning || Date.now() - embeddingTestAt < 10_000)
    return reply.code(429).type('text/html; charset=utf-8').send(settingsPage(s, { error: '测试过于频繁，请 10 秒后再试' }));
  // 测的就是跑的：与 worker 用同一个解析入口（全局模型供应商启用时来自分配）
  const pick = embeddingPick(loadModelSnapshot(db));
  if (!pick.config) return reply.code(400).type('text/html; charset=utf-8').send(settingsPage(s, { error: `无法测试：${pick.note}` }));
  embeddingTestRunning = true; embeddingTestAt = Date.now();
  try {
    const t = await testEmbedding(pick.config);
    return reply.type('text/html; charset=utf-8').send(settingsPage(s, { saved: `连通性测试通过：返回 ${t.dims} 维向量，耗时 ${t.ms} ms` }));
  } catch (e: any) {
    // 只展示结构化错误类型，不展示上游响应正文
    const msg = e instanceof EmbeddingError ? e.message : 'embedding unknown';
    return reply.code(502).type('text/html; charset=utf-8').send(settingsPage(s, { error: `连通性测试失败：${msg}` }));
  } finally { embeddingTestRunning = false; }
});

app.post('/settings/secret', async (req, reply) => {
  const s = requireAuth(req, reply); if (!s) return;
  if (!requireWrite(req, reply, s)) return;
  const b = (req.body ?? {}) as any;
  const name = String(b.name ?? '') as SecretName;
  // Telegram API ID / Hash / 手机号在设置 → Telegram，其余在设置 → API Key
  const tab: SettingsTab = name.startsWith('TELEGRAM_') ? 'telegram' : 'keys';
  if (!SECRET_NAMES.includes(name))
    return html(reply, settingsPage(s, { error: '未知的密钥名' }, 'keys'), 400);
  try {
    const val = String(b.value ?? '');
    setSecret(name, val);
    // 审计只记「哪个 key 被改了」，绝不记值本身（PRD 19.2）
    db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at)
      VALUES ('secret',?,?,?,?)`)
      .run(name, val.trim() ? 'secret_set' : 'secret_cleared',
           JSON.stringify({ actor: 'owner', length: val.trim().length }), nowIso());
    const effect = tab === 'telegram' ? '需要在服务器上重启 brief-telegram-collector 才会生效（采集器只在启动时读取）。' : 'worker 下次运行即生效。';
    return html(reply, settingsPage(s, { saved: `${name} 已${val.trim() ? '保存' : '清除'}。${effect}` }, tab));
  } catch (e: any) {
    req.log.error({ err: errorText(e) }, '保存密钥失败');
    return html(reply, settingsPage(s, { error: '保存失败，请查看服务日志' }, tab), 500);
  }
});

// 统一 404：不记录原始网址（默认处理会把完整 URL 写进日志，已下线的 /rss/allnet/<令牌> 等旧链接会因此泄露令牌）
app.setNotFoundHandler((req, reply) => { reply.code(404).type('text/plain; charset=utf-8').send('Not Found'); });

app.setErrorHandler((err, req, reply) => {
  // 敏感错误只进服务器日志，前端不暴露堆栈（PRD 14.2）
  req.log.error({ err }, '请求处理失败');
  reply.code((err as any).statusCode ?? 500).send({ error: '服务器内部错误', request_id: req.id });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`管理后台已启动 http://${HOST}:${PORT}（仅本机，公网经 Caddy 反代）`);
