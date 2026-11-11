// 全局模型供应商接入：开关关着时逐字兼容旧配置；配置错误在领取前判定（日报推迟、Telegram 不领取）；
// 图片识别暂停只属于触发它的配置；后台路由（导入、接管后隐藏旧输入、Telegram 保存不重置模型列、Origin 精确比较、/health/models）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = mkdtempSync(join(tmpdir(), 'model-integration-'));
for (const k of Object.keys(process.env)) if (/^(AI_|OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|DASHSCOPE|EMBEDDING|SOURCE_PROFILER|DEDUP_)/.test(k)) delete process.env[k];
process.env.SECRETS_PATH = join(dir, 'secrets.enc');
process.env.APP_ENCRYPTION_KEY = 'integration-master-key-0123456789';
process.env.TELEGRAM_DATABASE_PATH = join(dir, 'missing-tg.sqlite3');

const { openDb, migrate } = await import('../packages/db/src/index.ts');
const { providerFromEnv } = await import('../packages/ai/src/registry.ts');
const mc = await import('../packages/ai/src/model-config.ts');
const mp = await import('../packages/web/src/model-providers.ts');
const rt = await import('../packages/web/src/model-runtime.ts');
const { resolveEmbeddingConfig } = await import('../packages/web/src/secrets.ts');
const { readyTelegramDb } = await import('../packages/telegram/src/db.ts');
const { runDueSummaries } = await import('../packages/telegram/src/summarize.ts');
const { runOneVisionTask } = await import('../packages/telegram/src/vision.ts');
const { updateTelegramSettings } = await import('../packages/telegram/src/core.ts');
const { ProviderError } = await import('../packages/ai/src/types.ts');
const { hashPassword } = await import('../packages/web/src/auth.ts');

const ok = (name: string) => console.log(`  ✅ ${name}`);
const key = mc.currentMasterKey()!;
const KEY = 'sk-integration-aaaaaaaaaaaaaaaa9999';
let child: ReturnType<typeof spawn> | undefined;

/** 建一个启用了全局模型供应商的库：一个 OpenAI 兼容供应商，全部跟随 L1。 */
function enabledDb(name: string) {
  const db = openDb(join(dir, name)); migrate(db, 'migrations');
  const p = mp.createModelProvider(db, key, { name: '网关', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1', apiKey: KEY }, 0);
  let r = mp.saveAssignments(db, [
    { consumer: 'l1', mode: 'provider', providerId: p.id, model: 'flash' }, { consumer: 'l2', mode: 'follow', follow: 'l1' },
    { consumer: 'l3', mode: 'follow', follow: 'l1' }, { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' },
    { consumer: 'telegramVision', mode: 'follow', follow: 'l1' }, { consumer: 'embedding', mode: 'disabled' },
  ], p.revision).revision;
  r = mp.setModelConfigEnabled(db, true, r).revision;
  return { db, providerId: p.id, revision: r };
}

try {
  // ---------- 开关关着：逐字兼容 ----------
  {
    const db = openDb(join(dir, 'legacy.db')); migrate(db, 'migrations');
    const snap = mc.loadModelSnapshot(db);
    const combos: Record<string, string>[] = [
      {},
      { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k1', AI_L1_MODEL: 'm1' },
      { AI_L1_PROVIDER: 'openai_compatible', AI_L1_MODEL: 'flash', AI_BASE_URL: 'https://gw.example.com/v1', OPENAI_COMPAT_API_KEY: 'k2', AI_L1_STRICTNESS: 'json' },
      { AI_L1_PROVIDER: 'openai_compatible', AI_L1_MODEL: 'flash', AI_L1_BASE_URL: 'https://gw.example.com/v1', OPENAI_COMPAT_API_KEY: 'k2',
        AI_L2_MODEL: 'pro', AI_L3_PROVIDER: 'anthropic', AI_L3_MODEL: 'claude', ANTHROPIC_API_KEY: 'k3', AI_L2_STRICTNESS: '' },
    ];
    for (const env of combos) {
      for (const k of Object.keys(process.env)) if (/^(AI_|OPENAI|ANTHROPIC)/.test(k)) delete process.env[k];
      Object.assign(process.env, env);
      for (const t of ['L1', 'L2', 'L3'] as const) {
        const p = rt.tierPick(snap, t);
        assert.ok(p.ok && p.source === 'legacy');
        assert.deepEqual(p.cfg, providerFromEnv(t), `${JSON.stringify(env)} ${t} 与旧解析逐字一致`);
        assert.equal(p.cfg.isolated, undefined); assert.equal(p.cfg.cacheScope, undefined);
      }
    }
    for (const k of Object.keys(process.env)) if (/^(AI_|OPENAI|ANTHROPIC)/.test(k)) delete process.env[k];
    Object.assign(process.env, { EMBEDDING_ENABLED: 'true', EMBEDDING_BASE_URL: 'https://emb.example.com/v1', EMBEDDING_MODEL: 'e1', EMBEDDING_API_KEY: 'ek' });
    const old = resolveEmbeddingConfig();
    assert.deepEqual(rt.embeddingPick(snap).config, old.config, '向量配置与旧解析一致（不加 scope，已有缓存继续命中）');
    for (const k of ['EMBEDDING_ENABLED', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_API_KEY']) delete process.env[k];
    // 后台测试按钮传入 worker 的环境副本（第 5 轮审查）：解析结果来自传入的环境而不是后台自己的 process.env
    const injected = rt.tierPick(snap, 'L1', { AI_L1_PROVIDER: 'openai', AI_L1_MODEL: 'vault-model', OPENAI_API_KEY: 'vk' });
    assert.ok(injected.ok && injected.cfg.provider === 'openai' && injected.cfg.model === 'vault-model' && injected.cfg.apiKey === 'vk');
    db.close();
    ok('开关关着：L1/L2/L3（含 AI_BASE_URL、strictness、L3 换厂商）与向量配置都与旧代码逐字一致');
  }

  // ---------- 向量分配给官方 OpenAI、地址留空：用官方默认地址（第 4 轮审查） ----------
  {
    const db = openDb(join(dir, 'emb.db')); migrate(db, 'migrations');
    const a = mp.createModelProvider(db, key, { name: 'A', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1', apiKey: KEY }, 0);
    const o = mp.createModelProvider(db, key, { name: 'OpenAI', type: 'openai', baseUrl: '', apiKey: KEY }, a.revision);
    let r = mp.saveAssignments(db, [
      { consumer: 'l1', mode: 'provider', providerId: a.id, model: 'flash' }, { consumer: 'l2', mode: 'follow', follow: 'l1' },
      { consumer: 'l3', mode: 'follow', follow: 'l1' }, { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' },
      { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
      { consumer: 'embedding', mode: 'provider', providerId: o.id, model: 'text-embedding-3-small' },
    ], o.revision).revision;
    mp.setModelConfigEnabled(db, true, r);
    const e = rt.embeddingPick(mc.loadModelSnapshot(db));
    assert.ok(e.config, e.note); assert.equal(e.config!.baseUrl, 'https://api.openai.com/v1'); assert.ok(e.config!.scope, '缓存键带供应商指纹');
    db.close();
    ok('向量分配给官方 OpenAI 且地址留空：使用官方默认地址，缓存键带指纹');
  }

  // ---------- 开关打开：配置错误 → 日报推迟（不派发请求） ----------
  {
    const { db } = enabledDb('gate.db');
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
    const { loadRules } = await import('../packages/domain/src/rules.ts');
    const { runDigestBrief, EXIT_WAITING_AI } = await import('../apps/worker/src/brief-digest.ts');
    // 主密钥换了：库里的密钥解不开 → 两层都不可用，不回退到 env
    process.env.AI_L1_PROVIDER = 'mock'; process.env.AI_L1_MODEL = 'mock-model';
    const saved = process.env.APP_ENCRYPTION_KEY; process.env.APP_ENCRYPTION_KEY = 'another-key';
    const code = await runDigestBrief({ db, run: db.prepare('SELECT * FROM runs WHERE id=?').get(runId), rules: loadRules() as any, noSend: true, shadow: false, regenerate: false,
      win: { key: '2026-11-05:daily', label: '日报', start: new Date('2026-11-04T00:00:00Z'), end: new Date('2026-11-05T00:00:00Z') },
      outDir: join(dir, 'out'), trigger: 'timer', deadlineMs: Date.now() + 3600e3 });
    // 预览：本地配置错误在构建与输出之前就以非零退出（第 5 轮审查）
    const { spawnSync } = await import('node:child_process');
    const pv = spawnSync(process.execPath, ['apps/worker/src/preview.ts', '--from', '2026-11-04T00:00:00Z', '--to', '2026-11-05T00:00:00Z', '--no-telegram', '--out', join(dir, 'pv')],
      { encoding: 'utf8', env: { ...process.env, DATABASE_PATH: join(dir, 'gate.db') } });
    assert.equal(pv.status, 1, pv.stderr.slice(-300)); assert.match(pv.stderr, /key_unreadable/);
    assert.ok(!existsSync(join(dir, 'pv')) && !existsSync(join(dir, 'pv.html')), '不写出残缺预览');
    process.env.APP_ENCRYPTION_KEY = saved; delete process.env.AI_L1_PROVIDER; delete process.env.AI_L1_MODEL;
    assert.equal(code, EXIT_WAITING_AI);
    const run = db.prepare('SELECT status, error FROM runs WHERE id=?').get(runId) as any;
    assert.equal(run.status, 'waiting_ai'); assert.match(run.error, /config:key_unreadable/);
    const used = db.prepare(`SELECT used FROM run_ai_budget WHERE run_id=?`).get(runId) as any;
    assert.ok(!used || used.used === 0, '配置错误不派发任何请求');
    db.close();
    ok('开关打开且密钥解不开：日报推迟发布，错误类型 config:key_unreadable，不回退 env、不派发请求');
  }

  // ---------- Telegram：配置错误不领取；图片识别暂停属于触发它的配置 ----------
  {
    const tg = readyTelegramDb(join(dir, 'tg.sqlite3'));
    const at = '2026-11-01T00:00:00.000Z';
    const src = Number(tg.prepare(`INSERT INTO telegram_sources(reference,source_type,chat_id,title,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES('@s1','normal',-1001,'群','active',1,?,?,?)`).run(at, at, at).lastInsertRowid);
    tg.prepare('INSERT INTO telegram_sync_state(source_id) VALUES(?)').run(src);
    tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src, -1001, 1, '2026-11-01T01:00:00.000Z', '一条消息', 'h1', at);
    const job = Number(tg.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
      VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src, at, '2026-11-01T02:00:00.000Z', at, at).lastInsertRowid);
    let calls = 0;
    const done = await runDueSummaries(tg, undefined, () => { calls++; return { error: 'key_unreadable' }; });
    const j = tg.prepare('SELECT status, attempts FROM telegram_summary_jobs WHERE id=?').get(job) as any;
    assert.equal(done, 0); assert.ok(calls >= 1);
    assert.deepEqual([j.status, j.attempts], ['pending', 0], '配置错误时不领取：状态与次数不变');
    ok('Telegram 总结：配置错误时不领取任务，状态与次数不变');

    const mediaDir = join(dir, 'media'); mkdirSync(mediaDir, { recursive: true });
    const media = (mid: number, fp: string) => {
      const path = join(mediaDir, fp);
      tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src, -1001, mid, at, '', fp, at);
      writeFileSync(path, Buffer.from([1, 2, 3]), { mode: 0o600 });
      tg.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,temp_path,temp_state,actual_size_bytes,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(src, -1001, mid, fp, 'image/png', '', path, 'ready', 3, 'pending', at, at);
      return path;
    };
    const authFail = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => { throw new ProviderError('auth', 'bad', 401); } } as any;
    const settings = () => tg.prepare('SELECT vision_paused, vision_pause_fingerprint FROM telegram_settings').get() as any;
    const p1 = media(11, 'fp-a');
    // 请求期间管理员换了配置：迟到的 401 不暂停
    assert.equal(await runOneVisionTask(tg, { provider: authFail, mediaDir, fingerprint: 'old', currentFingerprint: () => 'new' }), 'failed');
    assert.equal(settings().vision_paused, 0, '旧配置迟到的鉴权失败不暂停新配置'); assert.ok(existsSync(p1));
    // 当前配置本身鉴权失败：暂停并记录指纹
    assert.equal(await runOneVisionTask(tg, { provider: authFail, mediaDir, fingerprint: 'cur', currentFingerprint: () => 'cur' }), 'failed');
    assert.deepEqual([settings().vision_paused, settings().vision_pause_fingerprint], [1, 'cur']);
    assert.equal(await runOneVisionTask(tg, { provider: authFail, mediaDir, fingerprint: 'cur', currentFingerprint: () => 'cur' }), 'paused', '同一配置保持暂停');
    // 换了配置：自动解除暂停并继续
    const okProvider = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => ({ data: { description: 'd', key_text: '', uncertainty: '' }, usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 }, responseId: 'r', model: 'm' }) } as any;
    assert.equal(await runOneVisionTask(tg, { provider: okProvider, mediaDir, fingerprint: 'fixed', currentFingerprint: () => 'fixed' }), 'done');
    assert.equal(settings().vision_paused, 0); assert.equal(settings().vision_pause_fingerprint, null);
    // 旧数据（无指纹）的暂停仍需手动恢复
    tg.prepare('UPDATE telegram_settings SET vision_paused=1, vision_pause_fingerprint=NULL').run();
    media(12, 'fp-b');
    assert.equal(await runOneVisionTask(tg, { provider: okProvider, mediaDir, fingerprint: 'fixed' }), 'paused');
    tg.close();
    ok('图片识别：迟到的旧 401 不暂停；当前配置失败才暂停并记指纹；换配置自动解除；无指纹的旧暂停仍需手动恢复');
  }

  // ---------- 后台路由 ----------
  {
    const dbpath = join(dir, 'web.db');
    { const db = openDb(dbpath); migrate(db, 'migrations'); db.close(); }
    const tgPath = join(dir, 'web-tg.sqlite3');
    { const tg = readyTelegramDb(tgPath);
      updateTelegramSettings(tg, { modelMode: 'legacy', timezone: 'Asia/Shanghai', schedule: '08:00', provider: 'openai_compatible', model: 'flash', baseUrl: 'https://gw.example.com/v1', credentialRef: 'OPENAI_COMPAT_API_KEY', promptRules: '' });
      tg.prepare(`UPDATE telegram_settings SET vision_provider='openai_compatible', vision_model='flash', vision_base_url='https://gw.example.com/v1', vision_credential_ref='OPENAI_COMPAT_API_KEY'`).run();
      tg.close(); }
    const env = { ...process.env, DATABASE_PATH: dbpath, TELEGRAM_DATABASE_PATH: tgPath, TELEGRAM_SESSION_PATH: join(dir, 'tgs'),
      TELEGRAM_LOGIN_SOCKET: join(dir, 'tg.sock'), REQUEST_DIR: join(dir, 'req'), BACKUP_DIR: join(dir, 'bak'),
      BACKUP_SETTINGS_PATH: join(dir, 'backup-settings.json'), ADMIN_PASSWORD_HASH: hashPassword('test-pass'), ADMIN_TOTP_SECRET: '',
      ADMIN_PORT: '3197', ADMIN_SECURE_COOKIE: 'false', ADMIN_BASE_URL: 'http://127.0.0.1:3197',
      AI_L1_PROVIDER: 'openai_compatible', AI_L1_MODEL: 'flash', AI_L1_BASE_URL: 'https://gw.example.com/v1', OPENAI_COMPAT_API_KEY: KEY };
    let logs = '';
    child = spawn(process.execPath, ['apps/web/src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', b => logs += b); child.stderr!.on('data', b => logs += b);
    const base = 'http://127.0.0.1:3197';
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health/live')).ok) break; } catch { /* 启动中 */ } await new Promise(r => setTimeout(r, 50)); }
    assert.equal((await fetch(base + '/health/models', { redirect: 'manual' })).status, 302, '/health/models 需要登录');
    const login = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-pass' }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = async () => (await fetch(base + '/settings', { headers: { cookie } })).text();
    let html = await page();
    assert.ok(html.includes('从当前配置导入') && html.includes('name="l1_provider"'), '未启用：显示导入按钮与旧的 L1 表单');
    assert.ok(html.includes('旧配置：OpenAI 兼容 · gw.example.com · flash'), '显示旧配置的生效摘要（只有主机）');
    assert.ok(!html.includes(KEY), '页面不含密钥');
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    const rev = () => html.match(/name="revision" value="(\d+)"/)![1]!;
    const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(base + path, { method: 'POST', headers: { cookie, ...headers }, body: new URLSearchParams(body), redirect: 'manual' });
    assert.equal((await post('/settings/models/import', { revision: rev() })).status, 403, '缺 CSRF 被拒');
    assert.equal((await post('/settings/models/import', { csrf, revision: rev() }, { origin: 'http://127.0.0.1:3197.evil.example' })).status, 403, 'Origin 前缀相同但不是同一源：被拒');
    const imp = await post('/settings/models/import', { csrf, revision: rev() });
    const impHtml = await imp.text();
    assert.equal(imp.status, 200, impHtml.match(/class="err">([^<]+)/)?.[1]); assert.ok(impHtml.includes('已导入 1 个供应商'));
    html = await page();
    assert.ok(!html.includes('name="l1_provider"') && !html.includes('name="credential_ref" aria-label'), '启用后隐藏分散的模型输入');
    const tgTab = async () => (await fetch(base + '/settings?tab=telegram', { headers: { cookie } })).text();
    { const t = await tgTab();
      assert.ok(t.includes('在「设置 → 模型 → 模型分配」中选择') && !t.includes('name="provider"') && t.includes('name="model_mode" value="managed"'), '开关打开：设置 → Telegram 不显示模型字段'); }
    const health = await (await fetch(base + '/health/models', { headers: { cookie } })).json() as any;
    assert.equal(health.enabled, true); assert.equal(health.providers, 1);
    assert.ok(health.consumers.every((c: any) => c.ok), JSON.stringify(health.consumers));
    assert.ok(!JSON.stringify(health).includes(KEY) && !JSON.stringify(health).includes('/v1'), '不含密钥与地址路径');
    // 配置不可用（密文被改）→ 首页红色告警，Telegram 用途归到 Telegram 区（第 5 轮审查）
    { const w = openDb(dbpath); w.prepare(`UPDATE model_providers SET key_tag=?`).run(Buffer.alloc(16).toString('base64')); w.close(); }
    const home = await (await fetch(base + '/', { headers: { cookie } })).text();
    assert.ok(home.includes('模型配置错误：Telegram 总结') && home.includes('模型配置错误：日报 L1'), '首页显示模型配置错误告警');
    const h2 = await (await fetch(base + '/health/models', { headers: { cookie } })).json() as any;
    assert.ok(h2.consumers.some((c: any) => !c.ok && c.text.includes('无法解密')));
    // 恢复：重新填写密钥（改地址以外的保存也必须能读原密钥，所以这里直接重填）
    html = await page();
    const pid = html.match(/settings\/models\/providers\/(p_[a-z0-9]{8})\/refresh/)![1]!;
    const fix = await post(`/settings/models/providers/${pid}`, { csrf, revision: rev(), name: '网关', type: 'openai_compatible', base_url: 'https://gw.example.com/v1', api_key: KEY });
    assert.equal(fix.status, 200);
    assert.ok(!(await (await fetch(base + '/', { headers: { cookie } })).text()).includes('模型配置错误'), '修好后告警消失');
    // Telegram 设置保存不重置模型列（停用开关后它们就是旧配置）
    // 打开页面后、保存前，别处改了模型列：SQL 只更新时区 / 时段 / 提示词，不覆盖（§6）
    { const tg = readyTelegramDb(tgPath); tg.prepare(`UPDATE telegram_settings SET model='flash-2'`).run(); tg.close(); }
    const saved = await post('/telegram/settings', { csrf, model_mode: 'managed', timezone: 'Asia/Shanghai', schedule: '08:00, 20:00', prompt_rules: '', provider: 'mock', model: 'evil' });
    assert.equal(saved.status, 302); assert.equal(saved.headers.get('location'), '/settings?tab=telegram&saved=telegram#telegram');
    { const tg = readyTelegramDb(tgPath); const s = tg.prepare('SELECT provider, model, base_url, credential_ref, schedule_json FROM telegram_settings').get() as any; tg.close();
      assert.deepEqual([s.provider, s.model, s.base_url, s.credential_ref, s.schedule_json], ['openai_compatible', 'flash-2', 'https://gw.example.com/v1', 'OPENAI_COMPAT_API_KEY', '["08:00","20:00"]']); }
    // 旧页面（开关关着时打开）在开关打开后保存 → 409，不写入任何字段
    const mism = await post('/telegram/settings', { csrf, model_mode: 'legacy', timezone: 'UTC', schedule: '09:00', prompt_rules: 'x', provider: 'mock', model: 'm', credential_ref: 'OPENAI_COMPAT_API_KEY' });
    assert.equal(mism.status, 409); assert.ok((await mism.text()).includes('模型配置方式已变化'));
    { const tg = readyTelegramDb(tgPath); const s = tg.prepare('SELECT timezone, model, schedule_json FROM telegram_settings').get() as any; tg.close();
      assert.deepEqual([s.timezone, s.model, s.schedule_json], ['Asia/Shanghai', 'flash-2', '["08:00","20:00"]'], '409 时不写入'); }
    // 校验失败：回到设置 → Telegram，回填非敏感输入
    const bad = await post('/telegram/settings', { csrf, model_mode: 'managed', timezone: 'Asia/Shanghai', schedule: '25:00', prompt_rules: '关注发布会' });
    assert.equal(bad.status, 400); { const t = await bad.text(); assert.ok(t.includes('时段必须是') && t.includes('25:00') && t.includes('关注发布会') && t.includes('aria-current="page">Telegram')); }
    // 旧 revision 的保存被拒
    const stale = await post('/settings/models/enable', { csrf, revision: '0', enabled: '1' });
    assert.equal(stale.status, 409);
    // 停用回到旧配置
    html = await page();
    const off = await post('/settings/models/enable', { csrf, revision: rev(), enabled: '0' });
    assert.equal(off.status, 200); assert.ok((await page()).includes('name="l1_provider"'));
    { const t = await tgTab(); assert.ok(t.includes('name="provider"') && t.includes('name="model_mode" value="legacy"'), '开关关着：仍可编辑旧的模型字段'); }
    assert.ok(!logs.includes(KEY), '服务日志不含密钥');
    ok('后台：导入需 CSRF 与同源、启用后隐藏旧输入、Telegram 保存不重置模型列、旧 revision 被拒、停用可回到旧配置、/health/models 需登录且不含密钥');
  }
  console.log('\n✅ 全部通过');
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
