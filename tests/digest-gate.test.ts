// 新流程的发布门禁：有未判定条目时不落库、记录推迟状态并返回 75；租约被占用时不重复构建
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'digest-gate-'));
process.env.AI_PROVIDER = 'mock'; process.env.AI_L1_MODEL = 'mock-model';
for (const k of ['AI_L1_PROVIDER', 'AI_L2_PROVIDER', 'AI_L2_MODEL', 'EMBEDDING_ENABLED', 'EMBEDDING_API_KEY']) delete process.env[k];
process.env.SECRETS_PATH = join(dir, 'secrets.enc');
process.env.TELEGRAM_DATABASE_PATH = join(dir, 'missing-tg.sqlite3');

const { openDb, migrate } = await import('../packages/db/src/index.ts');
const { loadRules } = await import('../packages/domain/src/rules.ts');
const { runDigestBrief, EXIT_WAITING_AI, EXIT_LEASE_BUSY } = await import('../apps/worker/src/brief-digest.ts');
const { acquireLease } = await import('../packages/db/src/runstate.ts');

const db = openDb(join(dir, 'g.db')); migrate(db, './migrations');
const now = new Date().toISOString();
db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,config_json,source_version,created_at,updated_at,vendor,is_official,source_role,enabled)
  VALUES ('yicai','yicai','一财','news','direct','standard','{}',1,?,?,'other',0,'politics',1)`).run(now, now);
const fid = Number(db.prepare(`INSERT INTO feed_items (source_id,source_item_key,key_kind,canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at)
  VALUES ('yicai','k1','guid','https://yicai.com/1','2026-11-04T02:00:00Z','exact',?,?,?)`).run(now, now, now).lastInsertRowid);
const vid = Number(db.prepare(`INSERT INTO item_versions (item_id,content_hash,raw_hash,title,clean_text,discovered_at,version_no) VALUES (?,?,?,?,?,?,1)`)
  .run(fid, 'h', 'r', '某项政策发布', '某部门发布某项政策。', now).lastInsertRowid);
db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid, fid);
const runId = Number(db.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger)
  VALUES ('2026-11-05:daily','日报','2026-11-04T00:00:00Z','2026-11-05T00:00:00Z','2026-11-05T00:00:00Z','running','timer')`).run().lastInsertRowid);
const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
const rules = loadRules() as any;
assert.ok(rules.brief?.semantic_dedup?.enabled, 'rules.yaml 已开启新流程');
const win = { key: '2026-11-05:daily', label: '日报', start: new Date('2026-11-04T00:00:00Z'), end: new Date('2026-11-05T00:00:00Z') };
const opts = { db, run, win, rules, noSend: true, shadow: false, regenerate: false, outDir: join(dir, 'out'), trigger: 'timer' as const, deadlineMs: Date.now() + 3600e3 };

try {
  // mock 供应商对新任务的结构给不出合格结果 → 时政速览未判定 → 推迟发布
  const code = await runDigestBrief(opts);
  assert.equal(code, EXIT_WAITING_AI);
  const r = db.prepare('SELECT status, error FROM runs WHERE id=?').get(runId) as any;
  assert.equal(r.status, 'waiting_ai'); assert.ok(String(r.error).includes('未判定'));
  assert.equal((db.prepare('SELECT count(*) n FROM briefs WHERE run_id=?').get(runId) as any).n, 0, '未判定时不落库（落库即发布）');
  const a = db.prepare('SELECT trigger, outcome, unresolved FROM run_attempts WHERE run_id=?').get(runId) as any;
  assert.deepEqual([a.trigger, a.outcome], ['timer', 'waiting_ai']); assert.ok(a.unresolved > 0);
  const st = db.prepare('SELECT unresolved FROM run_retry_state WHERE run_id=?').get(runId) as any;
  assert.ok(st.unresolved > 0);
  assert.equal((db.prepare('SELECT count(*) n FROM run_leases').get() as any).n, 0, '结束后释放租约');
  // 已到截止时间：不再派发任何 AI 请求
  const used = (db.prepare(`SELECT used FROM run_ai_budget WHERE run_id=? AND scope='timer'`).get(runId) as any).used;
  assert.equal(await runDigestBrief({ ...opts, deadlineMs: Date.now() - 1 }), EXIT_WAITING_AI);
  assert.equal((db.prepare(`SELECT used FROM run_ai_budget WHERE run_id=? AND scope='timer'`).get(runId) as any).used, used, '截止后请求数不再增加');
  // 另一尝试持有租约：本次不构建，并以独立退出码告知定时循环继续按时刻表检查（不能当作成功结束）
  const lease = acquireLease(db, runId)!;
  const before = (db.prepare('SELECT count(*) n FROM run_attempts').get() as any).n;
  assert.equal(await runDigestBrief(opts), EXIT_LEASE_BUSY);
  assert.equal((db.prepare('SELECT count(*) n FROM run_attempts').get() as any).n, before, '没有新的构建尝试');
  lease.release();
  // 判定全部完成（窗口内没有需要 AI 的条目），但已过截止时间：发布事务拒绝落库
  db.prepare('UPDATE feed_items SET published_at=?, first_seen_at=?').run('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  assert.equal(await runDigestBrief({ ...opts, deadlineMs: Date.now() - 1 }), EXIT_WAITING_AI);
  assert.equal((db.prepare('SELECT count(*) n FROM briefs WHERE run_id=?').get(runId) as any).n, 0, '截止后不发布');
  // 未过截止：正常发布。Telegram 要点已就绪，构建之后的去羊毛步骤再派发一次 AI 请求，审计次数必须把它算进去
  const tgPath = join(dir, 'tg.sqlite3');
  const { openTelegramDb, migrateTelegram } = await import('../packages/telegram/src/db.ts');
  const tgdb = openTelegramDb(tgPath); migrateTelegram(tgdb);
  tgdb.prepare(`INSERT INTO telegram_digests (window_start,window_end,status,source_ids,input_hash,summary_json,fallback,attempts,created_at,updated_at)
    VALUES (?,?,'completed','[]','h',?,0,1,?,?)`).run('2026-11-04T00:00:00Z', '2026-11-04T23:00:00Z',
    JSON.stringify({ format: 'daily_v2', categories: [{ name: '其他', items: [{ text: '某群讨论了某事', groups: ['某群'] }] }], groups: [] }), now, now);
  tgdb.close();
  process.env.TELEGRAM_DATABASE_PATH = tgPath;
  const usedBefore = (db.prepare(`SELECT used FROM run_ai_budget WHERE run_id=? AND scope='timer'`).get(runId) as any).used;
  let stripCalled = 0;
  const stripDeals = async (p: any, tg: any) => {
    stripCalled++;
    await p.complete({ systemPrompt: 's', userContent: '{"candidates":[]}', schema: {}, schemaName: 'triage', maxOutputTokens: 50 }).catch(() => {});
    return { tg, removed: [] };
  };
  assert.equal(await runDigestBrief({ ...opts, deadlineMs: Date.now() + 3600e3, stripDeals }), 0);
  assert.equal((db.prepare(`SELECT count(*) n FROM briefs WHERE run_id=? AND status='final'`).get(runId) as any).n, 1);
  assert.equal(stripCalled, 1, 'Telegram 要点就绪时执行去羊毛');
  const composed = JSON.parse((db.prepare(`SELECT payload_json FROM audit_events WHERE action='brief_composed' ORDER BY id DESC LIMIT 1`).get() as any).payload_json);
  const usedAfter = (db.prepare(`SELECT used FROM run_ai_budget WHERE run_id=? AND scope='timer'`).get(runId) as any).used;
  assert.ok(composed.aiCalls >= 1, `构建之后的 AI 调用也要计入审计（实际 ${composed.aiCalls}）`);
  assert.equal(composed.aiCalls, usedAfter - usedBefore, '审计次数与本次尝试实际占用的预算一致');
  console.log('✅ 发布门禁：未判定不落库、推迟状态与尝试记录、截止后不再请求、租约互斥、AI 调用计数含构建后步骤通过');
} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
