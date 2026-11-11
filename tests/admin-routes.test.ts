// 后台改造第一期（docs/admin-reorg-p1-design.md §1–§9）：
// 升级迁移 020（归档 + 来源画像分配行）、归档来源在各读取点与写操作中的处理、导航与旧地址跳转、
// 新页面与写操作落点、删除的路由、来源 API；RSS 访问日志不泄露令牌（通用检查，原全网热点测试迁来）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'admin-routes-'));
process.env.SECRETS_PATH = join(dir, 'secrets.enc');
process.env.APP_ENCRYPTION_KEY = 'test-master-key-0123456789abcdef';
const { openDb, migrate } = await import('../packages/db/src/index.ts');
const { hashPassword } = await import('../packages/web/src/auth.ts');
const { toggleSource, deleteSource, updateSourceGroup, updateSourceUrl, addSource, ActionError } = await import('../packages/web/src/actions.ts');
const { itemsInWindow } = await import('../packages/db/src/queries.ts');
const { eligibilitySignature } = await import('../packages/db/src/eligibility.ts');
const mc = await import('../packages/ai/src/model-config.ts');
const mp = await import('../packages/web/src/model-providers.ts');
const { windowDefs } = await import('../packages/domain/src/normalize.ts');
const { safeFormUrl, displayUrl } = await import('../packages/web/src/url-redact.ts');

const ok = (m: string) => console.log(`  ✅ ${m}`);
const dbpath = join(dir, 'test.db');
const T = new Date().toISOString();
const LEGACY_TOKEN = 'c'.repeat(64);
let child: ReturnType<typeof spawn> | undefined;
const db = openDb(dbpath);
try {
  // ---------- 升级：旧安装（001–019）里有全网热点、4 个旧 Telegram 来源、来源画像分配 ----------
  const pre = join(dir, 'mig-pre'); mkdirSync(pre);
  for (const f of readdirSync('migrations')) if (f.endsWith('.sql') && f < '020') copyFileSync(join('migrations', f), join(pre, f));
  migrate(db, pre);
  const src = (id: string, hostGroup: string, enabled: number, managedBy = 'config') => {
    db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,managed_by,enabled,require_fulltext,created_at,updated_at)
      VALUES(?,?,?,'tech',?,'standard','{}',1,?,?,0,?,?)`).run(id, id, `名称-${id}`, hostGroup, managedBy, enabled, T, T);
    db.prepare(`INSERT INTO source_endpoints(source_id,priority,url,parser,host_group,enabled) VALUES(?,1,?,'rss',?,1)`).run(id, `https://203.0.113.9/${id}.xml`, hostGroup);
  };
  src('allnet_legacy', 'allnet', 0, 'admin');
  db.prepare(`INSERT INTO allnet_subscriptions(source_id,upstream_id,item_limit,kind,token) VALUES('allnet_legacy',76,15,'ranking',?)`).run(LEGACY_TOKEN);
  src('tg_zaihuapd', 'rsshub', 1);          // 4 个旧来源之一，升级前仍启用
  src('tg_durov', 'rsshub', 0);
  src('tg_mychannel', 'rsshub', 1);         // 其他安装自定义的 RSSHub Telegram 来源：不受影响
  src('blog', 'direct', 1, 'admin');
  src('xuser', 'github_x_rss', 1, 'admin');
  src('pend', 'direct', 0, 'admin');        // 其他安装遗留的待确认来源
  db.prepare(`UPDATE sources SET onboarding_status='HUMAN_REVIEW' WHERE id='pend'`).run();
  db.prepare(`UPDATE source_endpoints SET enabled=0 WHERE source_id='pend'`).run();
  const item = (source: string, key: string) => {
    const id = Number(db.prepare(`INSERT INTO feed_items(source_id,source_item_key,key_kind,canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at)
      VALUES(?,?,'guid',?,?,'exact',?,?,?)`).run(source, key, `https://example.com/${key}`, T, T, T, T).lastInsertRowid);
    const vid = Number(db.prepare(`INSERT INTO item_versions(item_id,content_hash,raw_hash,title,clean_text,is_excerpt,discovered_at,version_no) VALUES(?,?,'r',?,?,0,?,1)`)
      .run(id, key, key, key, T).lastInsertRowid);
    db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid, id); return vid;
  };
  const tgVid = item('tg_zaihuapd', 'tg-old'); const blogVid = item('blog', 'blog-1');
  // 来源画像的分配引用了一个只给它用的供应商
  const key = mc.currentMasterKey()!;
  const pa = mp.createModelProvider(db, key, { name: 'A', type: 'openai', baseUrl: '', apiKey: 'sk-aaaaaaaaaaaaaaaaaaaaaaaa1111' }, 0);
  const pb = mp.createModelProvider(db, key, { name: 'B', type: 'openai', baseUrl: '', apiKey: 'sk-bbbbbbbbbbbbbbbbbbbbbbbb2222' }, pa.revision);
  db.prepare(`INSERT INTO model_assignments(consumer,provider_id,model,strictness,follow,disabled) VALUES('l1',?,'m',NULL,NULL,0),('sourceProfiler',?,'p',NULL,NULL,0)`).run(pa.id, pb.id);
  const counts = () => ['sources', 'feed_items', 'item_versions', 'source_endpoints', 'allnet_subscriptions'].map(t => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as any).n);
  const before = counts();

  assert.deepEqual(migrate(db, 'migrations'), ['020_source_archive.sql']);
  const arch = (id: string) => db.prepare('SELECT archived_at, enabled FROM sources WHERE id=?').get(id) as any;
  for (const id of ['allnet_legacy', 'tg_zaihuapd', 'tg_durov']) assert.ok(arch(id).archived_at && arch(id).enabled === 0, `${id} 归档并停用`);
  for (const id of ['tg_mychannel', 'blog', 'pend']) assert.equal(arch(id).archived_at, null, `${id} 不归档`);
  assert.equal(arch('tg_mychannel').enabled, 1);
  assert.deepEqual(counts(), before, '迁移不删除任何数据');
  const prof = db.prepare(`SELECT * FROM model_assignments WHERE consumer='sourceProfiler'`).get() as any;
  assert.deepEqual([prof.provider_id, prof.model, prof.disabled], [null, null, 1], '来源画像分配行改为停用、不再引用供应商');
  assert.deepEqual(migrate(db, 'migrations'), [], '重复启动不重复执行');
  const rev = (db.prepare('SELECT revision FROM model_config_state').get() as any).revision;
  mp.deleteModelProvider(db, pb.id, rev);
  ok('迁移 020：按 ID 归档 4 个旧 Telegram 来源与全网热点（升级前启用的也归档），自定义来源不动；数据不删；画像分配行转停用、原供应商可删；不重复执行');

  // ---------- 归档后被改回 enabled=1（例如回滚期间的配置同步）：各读取点仍排除 ----------
  db.prepare(`UPDATE sources SET enabled=1 WHERE id IN ('tg_zaihuapd','allnet_legacy')`).run();
  db.prepare(`UPDATE sources SET require_fulltext=1 WHERE id='tg_zaihuapd'`).run();
  const win = { key: 'w', label: 'w', start: new Date(Date.now() - 36e5), end: new Date(Date.now() + 36e5) };
  const inWin = itemsInWindow(db, win).map((r: any) => r.vid);
  assert.ok(inWin.includes(blogVid) && !inWin.includes(tgVid), '日报资格排除归档来源');
  const runEnv = { ...process.env, DATABASE_PATH: dbpath, SNAPSHOT_DIR: join(dir, 'snap') };
  for (const args of [['--all'], ['--source', 'tg_zaihuapd']]) {
    const h = spawnSync(process.execPath, ['apps/worker/src/harvest.ts', ...args], { encoding: 'utf8', env: runEnv });
    assert.ok(!`${h.stdout}${h.stderr}`.includes('tg_zaihuapd') && !`${h.stdout}${h.stderr}`.includes('allnet_legacy'), `采集 ${args.join(' ')} 不碰归档来源`);
  }
  spawnSync(process.execPath, ['apps/worker/src/fulltext.ts', '--source', 'tg_zaihuapd'], { encoding: 'utf8', env: runEnv });
  assert.equal((db.prepare('SELECT fulltext_attempts n FROM item_versions WHERE id=?').get(tgVid) as any).n, 0, '全文抓取不碰归档来源');
  // 资格签名：未归档来源逐字不变；归档使有效资格变化 → 签名变化
  db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger) VALUES('2026-11-10:daily','日报',?,?,?,'succeeded','timer')`).run(T, T, T);
  const runId = (db.prepare('SELECT max(id) id FROM runs').get() as any).id;
  for (const vid of [blogVid, tgVid]) db.prepare(`INSERT INTO candidates(run_id,item_version_id,origin_window_key,decision,created_at) VALUES(?,?,'2026-11-10:daily','escalate',?)`).run(runId, vid, T);
  const sigArchived = eligibilitySignature(db, runId);
  db.prepare(`UPDATE sources SET archived_at=NULL WHERE id='tg_zaihuapd'`).run();
  const sigLive = eligibilitySignature(db, runId);
  db.prepare(`UPDATE sources SET archived_at=? WHERE id='tg_zaihuapd'`).run(T);
  assert.notEqual(sigArchived, sigLive, '归档改变有效资格时签名变化');
  // 写操作一律拒绝
  await assert.rejects(async () => toggleSource(db, 'allnet_legacy', true, 'try enable'), /已归档/);
  await assert.rejects(async () => deleteSource(db, 'allnet_legacy', 'try delete'), /已归档/);
  await assert.rejects(async () => updateSourceGroup(db, 'tg_zaihuapd', 'google', 'try regroup'), /已归档/);
  const probeOk = async (..._a: any[]) => ({ ok: true, outcome: 'ok', parsedCount: 3, sample: [], latencyMs: 1 }) as any;
  await assert.rejects(() => updateSourceUrl(db, { sourceId: 'tg_zaihuapd', url: 'https://203.0.113.10/x.xml', reason: 'try url' }, probeOk), /已归档/);
  // 改地址期间被归档：最终写入复查后拒绝
  await assert.rejects(() => updateSourceUrl(db, { sourceId: 'blog', url: 'https://203.0.113.10/b.xml', reason: 'race' },
    async () => { db.prepare(`UPDATE sources SET archived_at=? WHERE id='blog'`).run(T); return probeOk(); }), (e: any) => e instanceof ActionError && e.code === 409);
  db.prepare(`UPDATE sources SET archived_at=NULL WHERE id='blog'`).run();
  // 并发改地址：后完成的那次发现旧地址已变 → 409
  await assert.rejects(() => updateSourceUrl(db, { sourceId: 'blog', url: 'https://203.0.113.11/b.xml', reason: 'race 2' },
    async () => { db.prepare(`UPDATE source_endpoints SET url='https://203.0.113.12/b.xml' WHERE source_id='blog'`).run(); return probeOk(); }), (e: any) => e instanceof ActionError && e.code === 409);
  db.prepare(`UPDATE source_endpoints SET url='https://203.0.113.9/blog.xml' WHERE source_id='blog'`).run();
  ok('归档且 enabled=1 时：日报资格、采集（--all / --source）、全文抓取都排除；签名随有效资格变化；启用 / 删除 / 改分组 / 改地址被拒，改地址期间被归档或被并发修改也被拒');

  // 待确认来源：启用时同时启用端点并进入观察期
  toggleSource(db, 'pend', true, '确认启用来源');
  const pend = db.prepare(`SELECT s.enabled, s.onboarding_status, s.observation_until, e.enabled ep FROM sources s JOIN source_endpoints e ON e.source_id=s.id WHERE s.id='pend'`).get() as any;
  assert.deepEqual([pend.enabled, pend.onboarding_status, pend.ep, !!pend.observation_until], [1, 'OBSERVATION', 1, true]);
  // 新增来源：测试通过直接启用 + 观察期；测试失败不写入；ID 冲突 409；类型决定 host_group
  const added = await addSource(db, { id: 'newx', name: '新的 X 账号', url: 'https://203.0.113.20/x.xml', parser: 'rss', category: 'tech', sourceGroup: 'unclassified', tier: 'standard', kind: 'x' } as any, probeOk);
  assert.deepEqual([added.id, added.status], ['newx', 'OBSERVATION']);
  const nx = db.prepare(`SELECT enabled, host_group, onboarding_status, vendor, is_official, source_role, require_fulltext, config_json FROM sources WHERE id='newx'`).get() as any;
  assert.deepEqual([nx.enabled, nx.host_group, nx.onboarding_status, nx.vendor, nx.is_official, nx.source_role, nx.require_fulltext], [1, 'github_x_rss', 'OBSERVATION', 'other', 0, 'context', 0]);
  assert.equal(JSON.parse(nx.config_json).require_fulltext, false);
  assert.equal((db.prepare(`SELECT host_group FROM source_endpoints WHERE source_id='newx'`).get() as any).host_group, null, '端点不写限流分组覆盖，按主机名限流（RSSHub 等的间隔不被绕过）');
  assert.ok(db.prepare(`SELECT 1 FROM audit_events WHERE action='source_added' AND entity_id='newx'`).get());
  await assert.rejects(() => addSource(db, { id: 'bad1', name: '探测失败', url: 'https://203.0.113.21/x.xml', parser: 'rss', category: 'tech', tier: 'standard' } as any,
    async () => ({ ok: false, outcome: 'parse_error', error: '不是 RSS', sample: [], latencyMs: 1 }) as any), /探测失败/);
  assert.equal(db.prepare(`SELECT 1 FROM sources WHERE id='bad1'`).get(), undefined, '测试失败不写入');
  await assert.rejects(() => addSource(db, { id: 'newx', name: '重复', url: 'https://203.0.113.22/x.xml', parser: 'rss', category: 'tech', tier: 'standard' } as any, probeOk),
    (e: any) => e instanceof ActionError && e.code === 409);
  // 已删除的来源不能再启用
  deleteSource(db, 'newx', '测试删除来源');
  await assert.rejects(async () => toggleSource(db, 'newx', true, 'again'), /删除/);
  ok('待确认来源启用时恢复端点并进入观察期；新增来源直接启用并进入观察期（类型决定区域）、测试失败不写入、ID 冲突 409；已删除来源不能再启用');

  // 今天每个时段都有「进行中」的运行：时段卡片不补告警（slotAlerts 为空），其余告警（如缺备份）必须照常显示
  const taipeiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  for (const d of windowDefs()) db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger) VALUES(?,?,?,?,?,'running','timer') ON CONFLICT(window_key) DO UPDATE SET status='running'`)
    .run(`${taipeiToday}:${d.id}`, d.label, T, T, T);

  // 网址脱敏：解码后判断路径片段；解析不了一律不回填、只显示占位
  const hex = 'a'.repeat(32);
  for (const u of ['https://u:p@x.example/f', 'https://x.example/f?token=1', `https://x.example/r/${hex}`, `https://x.example/r/%61${'a'.repeat(31)}`, `x.example/r/${hex}`, 'https://x.example/%E0%A4%A'])
    assert.equal(safeFormUrl(u), '', `不回填 ${u}`);
  assert.equal(safeFormUrl('https://x.example/feed.xml?page=2'), 'https://x.example/feed.xml?page=2');
  assert.equal(displayUrl(`https://u:p@x.example/r/%61${'a'.repeat(31)}?token=1`), 'https://x.example/r/…?…');
  assert.equal(displayUrl(`x.example/r/${hex}`), '（无法解析的地址）');
  ok('网址脱敏：百分号编码的令牌、缺协议的地址、口令、认证参数都不回填、不显示');

  // ---------- 后台路由 ----------
  const env = { ...process.env, DATABASE_PATH: dbpath, TELEGRAM_DATABASE_PATH: join(dir, 'tg.sqlite3'), TELEGRAM_SESSION_PATH: join(dir, 'tgs'),
    TELEGRAM_LOGIN_SOCKET: join(dir, 'tg.sock'), REQUEST_DIR: join(dir, 'req'), BACKUP_DIR: join(dir, 'bak'),
    BACKUP_SETTINGS_PATH: join(dir, 'backup-settings.json'), ADMIN_PASSWORD_HASH: hashPassword('test-pass'), ADMIN_TOTP_SECRET: '',
    ADMIN_PORT: '3196', ADMIN_SECURE_COOKIE: 'false', ADMIN_BASE_URL: 'http://127.0.0.1:3196', MAIL_TO: 'owner@example.com, Bob <bob@example.net>', MAIL_TRANSPORT: 'smtp' };
  let logs = '';
  child = spawn(process.execPath, ['apps/web/src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', b => logs += b); child.stderr!.on('data', b => logs += b);
  const base = 'http://127.0.0.1:3196';
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health/live')).ok) break; } catch { /* 启动中 */ } await new Promise(r => setTimeout(r, 50)); }
  // 未登录：新页面与旧地址跳转都要求登录
  for (const p of ['/', '/subscriptions?tab=x', '/channels', '/system', '/settings?tab=data', '/runs?tab=telegram', '/sources', '/feeds', '/telegram?tab=login', '/system/backups']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p); assert.equal(r.headers.get('location'), '/login', `${p} 未登录应跳到登录页`);
  }
  const login = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-pass' }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const get = (p: string) => fetch(base + p, { headers: { cookie }, redirect: 'manual' });
  const text = async (p: string) => { const r = await get(p); assert.equal(r.status, 200, p); return r.text(); };
  const redirects: Array<[string, string]> = [['/sources', '/subscriptions?tab=rss'], ['/feeds', '/channels?tab=rss'], ['/telegram', '/subscriptions?tab=telegram'],
    ['/telegram?tab=sources', '/subscriptions?tab=telegram'], ['/telegram?tab=digests', '/runs?tab=telegram'], ['/telegram?tab=vision', '/system#vision'],
    ['/telegram?tab=login', '/settings?tab=telegram'], ['/system/backups', '/settings?tab=data#backups']];
  for (const [from, to] of redirects) { const r = await get(from); assert.equal(r.status, 302, from); assert.equal(r.headers.get('location'), to, from); }
  ok('未登录访问新页面与旧地址都跳到登录；旧地址（含 /telegram?tab=* 四种）跳到新位置');

  const home = await text('/');
  const nav = ['>今日<', '>订阅源<', '>日报<', '>消息渠道<', '>系统运行<', '>设置<'].map(x => home.indexOf(x));
  assert.ok(nav.every((v, i) => v > 0 && (i === 0 || v > nav[i - 1]!)), `导航顺序 ${nav}`);
  assert.ok(home.includes('<h2>待处理</h2>') && !home.includes('运行概况'), '今日只有待处理');
  assert.ok(home.includes('没有新备份') && !home.includes('没有待处理事项') && /今日<span class="cnt (bad|warn)">\d+/.test(home),
    '时段卡片没有补充告警时，其余告警与角标照常显示（核对轮：合并后数组被清空）');
  const csrf = home.match(/name="csrf" value="([^"]+)"/)![1]!;
  const pages: Record<string, string> = {};
  for (const p of ['/subscriptions?tab=rss', '/subscriptions?tab=telegram', '/subscriptions?tab=x', '/runs', '/runs?tab=telegram', '/channels?tab=rss', '/channels?tab=email',
    '/system', '/settings?tab=models', '/settings?tab=telegram', '/settings?tab=keys', '/settings?tab=data']) pages[p] = await text(p);
  assert.ok(pages['/subscriptions?tab=rss']!.includes('名称-blog') && pages['/subscriptions?tab=rss']!.includes('名称-tg_mychannel') && !pages['/subscriptions?tab=rss']!.includes('名称-xuser'));
  assert.ok(pages['/subscriptions?tab=x']!.includes('名称-xuser') && !pages['/subscriptions?tab=x']!.includes('名称-blog'));
  assert.ok(pages['/subscriptions?tab=rss']!.includes('名称-pend'), '待确认 / 停用来源仍显示');
  for (const [p, h] of Object.entries(pages)) {
    assert.ok(!h.includes('名称-tg_zaihuapd') && !h.includes('名称-allnet_legacy') && !h.includes('名称-newx'), `${p} 不显示归档或已删除的来源`);
    assert.ok(!/全网热点|来源画像|Source Profiler|source-profiler|proposals/.test(h), `${p} 不出现全网热点、来源画像、提案`);
  }
  assert.ok(pages['/channels?tab=email']!.includes('o***@example.com, b***@example.net') && !/owner@|bob@|Bob/.test(pages['/channels?tab=email']!), '多个收件人逐个打码');
  assert.ok(pages['/channels?tab=email']!.includes('不会发送邮件') && pages['/channels?tab=email']!.includes('SMTP 凭证不完整') && !pages['/channels?tab=email']!.includes('已配置（smtp）'),
    'MAIL_TRANSPORT=smtp 但缺凭证：如实显示不会发送');
  assert.ok(pages['/settings?tab=telegram']!.includes('id="login"') && pages['/settings?tab=telegram']!.includes('TELEGRAM_API_ID'), '设置 → Telegram：登录与 API 凭据');
  assert.ok(!pages['/settings?tab=keys']!.includes('TELEGRAM_API_ID') && pages['/settings?tab=data']!.includes('id="retention"') && pages['/settings?tab=data']!.includes('id="backups"'));
  assert.ok(pages['/system']!.includes('id="vision"') && pages['/system']!.includes('今天的日报'), '系统运行：时段卡片与图片识别');
  // 历史运行详情仍显示归档来源
  assert.ok((await text(`/runs/${runId}`)).includes('tg_zaihuapd'), '历史详情仍显示归档来源');
  ok('导航 6 项；各新页面可打开；RSS / X 按 host_group 分区；归档与已删除来源不出现、待确认来源仍在；邮件地址打码；历史详情不受影响');

  // 删除的路由 404
  const post = (p: string, body: Record<string, string> = {}) => fetch(base + p, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf, ...body }), redirect: 'manual' });
  for (const p of ['/settings/source-profiler', '/sources/proposals/1/approve', '/sources/proposals/1/reject', '/api/v1/source-proposals/1/approve', '/api/v1/source-proposals/1/reject',
    '/allnet/search', '/sources/allnet/search', '/allnet/add', '/settings/allnet/test'])
    assert.equal((await post(p)).status, 404, `${p} 应已删除`);
  for (const p of ['/allnet', '/rss/allnet/' + 'a'.repeat(64)]) assert.equal((await get(p)).status, 404, `${p} 应已删除`);
  // 来源 API：排除归档、带 host_group；dashboard 没有提案统计
  const api = await (await get('/api/v1/sources')).json() as any[];
  assert.ok(api.some(s => s.id === 'xuser' && s.host_group === 'github_x_rss') && !api.some(s => s.id === 'tg_zaihuapd' || s.id === 'allnet_legacy'));
  const dash = await (await get('/api/v1/dashboard')).json() as any;
  assert.ok(!('onboardingPending' in dash.stats) && !('profilerCalls' in dash.stats) && !dash.sources.some((s: any) => s.id === 'tg_zaihuapd'));
  const apiAdd = await fetch(base + '/api/v1/sources', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ csrf, id: 'apibad', name: '内网', url: 'https://127.0.0.1/x.xml', parser: 'rss', category: 'tech', tier: 'standard' }) });
  assert.equal(apiAdd.status, 400); assert.ok(!db.prepare(`SELECT 1 FROM sources WHERE id='apibad'`).get());
  ok('删除的路由 404；来源 API 排除归档并带 host_group；dashboard 无提案统计；API 新增走同一校验');

  // 写操作的成功与错误分支落在新页面的对应子类
  const html = async (r: Response) => ({ status: r.status, body: await r.text() });
  let r = await html(await post('/sources/add', { kind: 'x', id: 'xbad', name: 'X 名称<b>', url: 'https://127.0.0.1/feed', parser: 'rss', category: 'tech', source_group: 'unclassified', tier: 'standard', priority: '5' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('aria-current="page">X 账号') && r.body.includes('value="X 名称&lt;b&gt;"') && r.body.includes('URL 不可用'), '新增失败：回到 X 区并回填输入');
  // 回填不带口令、认证参数、令牌路径
  for (const secretUrl of ['https://user:pa55word@127.0.0.1/feed', 'https://127.0.0.1/feed?token=SeCrEt123', `https://127.0.0.1/rss/briefs/${'d'.repeat(64)}`]) {
    const b1 = (await html(await post('/sources/add', { kind: 'rss', id: 'xbad', name: 'n', url: secretUrl, parser: 'rss', category: 'tech', tier: 'standard', secret_extra: 'zzextra' }))).body;
    const b2 = (await html(await post('/sources/test', { url: secretUrl, parser: 'rss', redirect: '/subscriptions?tab=rss' }))).body;
    for (const b of [b1, b2]) assert.ok(!b.includes('pa55word') && !b.includes('SeCrEt123') && !b.includes('d'.repeat(64)) && !b.includes('zzextra'), `不回填 ${secretUrl.slice(0, 30)}`);
  }
  r = await html(await post('/sources/test', { url: 'https://127.0.0.1/feed', parser: 'rss', redirect: '/subscriptions?tab=x' }));
  assert.ok(r.body.includes('aria-current="page">X 账号') && r.body.includes('测试失败'), '测试结果回到所在区域');
  r = await html(await post('/sources/tg_zaihuapd/group', { source_group: 'google', reason: '测试归档拒绝', redirect: '/subscriptions?tab=rss' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('来源已归档') && r.body.includes('aria-current="page">RSS 订阅源'));
  r = await html(await post('/sources/xuser/group', { source_group: 'google', reason: '整理分组一下', redirect: '/subscriptions?tab=x' }));
  assert.equal(r.status, 200); assert.ok(r.body.includes('来源分组已更新') && r.body.includes('aria-current="page">X 账号'), '按来源所在区域返回');
  const tog = await post('/sources/xuser/toggle', { enabled: 'false', reason: '暂停采集一下', redirect: '/subscriptions?tab=x' });
  assert.equal(tog.status, 302); assert.equal(tog.headers.get('location'), '/subscriptions?tab=x');
  r = await html(await post('/sources/tg_zaihuapd/toggle', { enabled: 'true', reason: '测试归档拒绝', redirect: '/subscriptions?tab=rss' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('来源已归档') && r.body.includes('<h1>订阅源</h1>'), '启停失败显示在订阅源页（网页表单）');
  const jsonTog = await post('/sources/tg_zaihuapd/toggle', { enabled: 'true', reason: '测试归档拒绝' });
  assert.equal(jsonTog.status, 400); assert.ok((await jsonTog.text()).includes('"error"'), '不带 redirect 的调用照旧返回 JSON');
  // Telegram：添加失败回填、行操作失败回到 Telegram 区、令牌操作回到来源页
  r = await html(await post('/telegram/sources', { reference: 'not a ref <x>', display_name: '显示名', source_type: 'normal' }));
  assert.ok(r.status >= 400 && r.body.includes('aria-current="page">Telegram 频道与群组') && r.body.includes('value="not a ref &lt;x&gt;"'), `Telegram 添加失败 ${r.status}`);
  r = await html(await post('/telegram/sources/999/toggle', { enabled: 'true', redirect: '/subscriptions?tab=telegram' }));
  assert.ok(r.status >= 400 && r.body.includes('aria-current="page">Telegram 频道与群组'));
  const allTok = await post('/telegram/rss/all/token', { action: 'reset', redirect: '/channels?tab=rss' });
  assert.equal(allTok.headers.get('location'), '/channels?tab=rss');
  const briefTok = await post('/rss/briefs/token', { action: 'reset' });
  assert.equal(briefTok.headers.get('location'), '/channels?tab=rss');
  const regen = await post('/telegram/digests/regenerate', { window_end: '2026-11-10T00:00:00.000Z' });
  assert.equal(regen.headers.get('location'), '/runs?tab=telegram&notice=regen');
  assert.ok((await text('/runs?tab=telegram&notice=regen')).includes('已清除该时段的要点汇总'));
  r = await html(await post('/telegram/digests/regenerate', { window_end: 'bad' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('时段格式无效') && r.body.includes('Telegram 要点'));
  const resume = await post('/telegram/vision/resume', { redirect: '/system#vision' });
  assert.equal(resume.headers.get('location'), '/system#vision', '带 # 的站内返回地址可用');
  const ext = await post('/telegram/vision/resume', { redirect: '//evil.example/x' });
  assert.equal(ext.headers.get('location'), '/system#vision', '外部返回地址被拒，用默认值');
  // 设置子类
  const lim = await post('/telegram/vision/limit', { limit: '500' });
  assert.equal(lim.headers.get('location'), '/settings?tab=telegram&saved=vision#vision');
  assert.ok((await text('/settings?tab=telegram&saved=vision')).includes('图片识别每日上限已保存'));
  r = await html(await post('/telegram/vision/limit', { limit: '5000' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('aria-current="page">Telegram') && r.body.includes('value="5000"'), '上限越界：回到设置 → Telegram 并回填');
  const ret = await post('/telegram/retention', { raw_retention_days: '10', summary_retention_days: '30' });
  assert.equal(ret.headers.get('location'), '/settings?tab=data&saved=retention#retention');
  r = await html(await post('/telegram/retention', { raw_retention_days: '0', summary_retention_days: '30' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('aria-current="page">数据保留与备份'));
  r = await html(await post('/telegram/login/start'));
  assert.equal(r.status, 503); assert.ok(r.body.includes('aria-current="page">Telegram') && r.body.includes('采集器未运行'), '登录失败回到设置 → Telegram');
  r = await html(await post('/settings/secret', { name: 'TELEGRAM_API_ID', value: '12345' }));
  assert.ok(r.body.includes('aria-current="page">Telegram') && r.body.includes('重启 brief-telegram-collector') && !r.body.includes('value="12345"'), 'Telegram 凭据：回到设置 → Telegram，提示重启，不回填');
  r = await html(await post('/settings/secret', { name: 'NOPE', value: 'x' }));
  assert.equal(r.status, 400); assert.ok(r.body.includes('aria-current="page">API Key'));
  ok('写操作成功 / 失败都落在新页面的对应子类，错误时回填非敏感输入、不回填密钥；站内返回地址支持 #，外部地址被拒');

  // RSS 访问日志不记录令牌（包括已删除的 /rss/allnet/<令牌>，走统一 404）
  const token = 'b'.repeat(64);
  await fetch(base + '/rss/briefs/' + token);
  assert.equal((await fetch(base + '/rss/allnet/' + LEGACY_TOKEN)).status, 404);
  await new Promise(res => setTimeout(res, 100));
  assert.ok(!logs.includes(token) && !logs.includes(LEGACY_TOKEN), '访问日志不得包含 RSS 令牌');
  assert.ok(!logs.includes('12345'), '日志不含保存的凭据');
  ok('RSS 访问日志隐藏令牌');
  console.log('\n✅ 全部通过');
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  db.close(); rmSync(dir, { recursive: true, force: true });
}
