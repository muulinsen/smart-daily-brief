// 全局模型供应商：加密、快照解析、写入协议（revision / 外键 / 审计同事务 / 引用图）、导入、模型列表、Anthropic 隔离
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'model-providers-'));
process.env.SECRETS_PATH = join(dir, 'secrets.enc');
process.env.APP_ENCRYPTION_KEY = 'test-master-key-0123456789abcdef';
for (const k of Object.keys(process.env)) if (/^(AI_|OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|DASHSCOPE|EMBEDDING|SOURCE_PROFILER|DEDUP_)/.test(k)) delete process.env[k];

const { openDb, migrate } = await import('../packages/db/src/index.ts');
const mc = await import('../packages/ai/src/model-config.ts');
const mp = await import('../packages/web/src/model-providers.ts');
const cat = await import('../packages/web/src/model-catalog.ts');
const { createProvider } = await import('../packages/ai/src/registry.ts');

const ok = (name: string) => console.log(`  ✅ ${name}`);
const key = mc.currentMasterKey()!;
const freshDb = (name: string) => { const db = openDb(join(dir, name)); migrate(db, 'migrations'); return db; };
const rev = (db: any) => (db.prepare('SELECT revision FROM model_config_state').get() as any).revision as number;
const audits = (db: any) => (db.prepare(`SELECT action, payload_json FROM audit_events WHERE entity_type='model_config' ORDER BY id`).all() as any[]);
const KEY_A = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa1111', KEY_B = 'sk-bbbbbbbbbbbbbbbbbbbbbbbb2222';

try {
  // ---------- 加密 ----------
  {
    const s = mc.seal(key, 'key', 'p_aaaaaaaa', 'secret-value');
    assert.equal(mc.unseal(key, 'key', 'p_aaaaaaaa', s), 'secret-value');
    assert.throws(() => mc.unseal(key, 'key', 'p_bbbbbbbb', s), '密文挪到别的供应商解不开');
    assert.throws(() => mc.unseal(key, 'url', 'p_aaaaaaaa', s), '密文挪到别的字段解不开');
    assert.throws(() => mc.unseal(mc.masterKeyFrom('other')!, 'key', 'p_aaaaaaaa', s), '主密钥不对解不开');
    ok('加密：附加认证数据绑定字段与供应商 ID，错主密钥解不开');
  }

  // ---------- 迁移与 ID 约束 ----------
  const db = freshDb('a.db');
  {
    const st = db.prepare('SELECT enabled, revision FROM model_config_state').get() as any;
    assert.deepEqual([st.enabled, st.revision], [0, 0], '迁移后开关关着');
    assert.equal(mc.loadModelSnapshot(db).enabled, false);
    const ins = (id: string) => db.prepare(`INSERT INTO model_providers (id,name,type,created_at,updated_at) VALUES (?,?,?,?,?)`).run(id, 'x', 'openai', 'n', 'n');
    assert.throws(() => ins('p_a!!!!!!!'), /CHECK/); assert.throws(() => ins('p_ABCDEFGH'), /CHECK/); assert.throws(() => ins('p_abc'), /CHECK/);
    ok('迁移 019：默认关着；供应商 ID 约束拒绝非法字符');
  }

  // ---------- 校验 ----------
  {
    const v = (u: string, t: any = 'openai_compatible') => mc.validateBaseUrl(t, u);
    assert.equal(v('https://api.example.com/v1'), null);
    for (const bad of ['http://api.example.com/v1', 'https://u:p@api.example.com', 'https://api.example.com/v1?key=1', 'https://127.0.0.1/v1',
      'https://[::ffff:7f00:1]/', 'https://[fe90::1]/', 'https://localhost/v1', 'https://intranet/v1', 'https://x.internal/v1', 'https://10.0.0.1/'])
      assert.ok(v(bad), `${bad} 应被拒绝`);
    assert.ok(v(''), 'OpenAI 兼容必须填写地址'); assert.equal(v('', 'openai'), null, '官方类型可留空');
    assert.ok(mc.validModelId('openai_compatible', 'vendor/model-1')); assert.ok(!mc.validModelId('gemini', 'models/x'));
    assert.ok(!mc.validModelId('openai', '../x')); assert.ok(!mc.validModelId('openai', 'a/b/c')); assert.ok(!mc.validModelId('openai', 'a..b'));
    assert.equal(mc.normalizeBaseUrl('openai', ''), mc.normalizeBaseUrl('openai', 'https://API.openai.com:443/v1/'));
    assert.equal(mc.keyHint('short-key'), null); assert.equal(mc.keyHint(KEY_A), '1111');
    const f1 = mc.fingerprintOf('p_aaaaaaaa', 1, '2foo', null), f2 = mc.fingerprintOf('p_aaaaaaaa', 12, 'foo', null);
    assert.notEqual(f1, f2, '指纹用结构化序列化，不会因拼接产生歧义');
    assert.notEqual(mc.fingerprintOf('p_aaaaaaaa', 1, 'm', null), mc.fingerprintOf('p_bbbbbbbb', 1, 'm', null), '指纹包含供应商身份');
    ok('校验：https、无 IP 字面量 / 本机 / 内网名、模型 ID 路径字符、短密钥不显示末四位、指纹无歧义');
  }

  // ---------- 写入：revision、密钥绑定地址、外键、审计同事务 ----------
  let pa: string, pb: string;
  {
    let r = rev(db);
    ({ id: pa, revision: r } = mp.createModelProvider(db, key, { name: '网关 A', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1/', apiKey: KEY_A }, r));
    const row = db.prepare('SELECT * FROM model_providers WHERE id=?').get(pa) as any;
    assert.equal(row.base_host, 'gw.example.com'); assert.ok(!JSON.stringify(row).includes('gw.example.com/v1'), '完整地址只存密文');
    assert.ok(!JSON.stringify(row).includes(KEY_A), '密钥只存密文'); assert.equal(row.key_hint, '1111');
    assert.throws(() => mp.createModelProvider(db, key, { name: 'x', type: 'openai', baseUrl: '', apiKey: KEY_B }, r - 1), /别处被修改/, '旧 revision 被拒');
    ({ id: pb, revision: r } = mp.createModelProvider(db, key, { name: '官方 B', type: 'openai', baseUrl: '', apiKey: KEY_B }, r));
    assert.throws(() => mp.updateModelProvider(db, key, pa, { name: '网关 A', type: 'openai_compatible', baseUrl: 'https://evil.example.com/v1' }, r), /重新填写密钥/, '改地址不重填密钥被拒');
    assert.throws(() => mp.updateModelProvider(db, key, pa, { name: '网关 A', type: 'deepseek', baseUrl: '' }, r), /重新填写密钥/, '改类型不重填密钥被拒');
    const u1 = mp.updateModelProvider(db, key, pa, { name: '网关 A2', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1' }, r);
    assert.equal(u1.reconfigured, false, '只改名称、地址规范化后相同：不算重新配置'); r = u1.revision;
    assert.equal((db.prepare('SELECT config_version FROM model_providers WHERE id=?').get(pa) as any).config_version, 1);
    r = mp.saveAssignments(db, [
      { consumer: 'l1', mode: 'provider', providerId: pa, model: 'flash' }, { consumer: 'l2', mode: 'follow', follow: 'l1' },
      { consumer: 'l3', mode: 'follow', follow: 'l2' }, { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' },
      { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
      { consumer: 'embedding', mode: 'provider', providerId: pb, model: 'text-embedding-3-small' },
    ], r).revision;
    assert.throws(() => mp.deleteModelProvider(db, pa, r), /正被使用/, '被引用的供应商删不掉');
    assert.throws(() => db.prepare('DELETE FROM model_providers WHERE id=?').run(pa), /FOREIGN KEY/, '外键也挡住直接删除');
    assert.throws(() => mp.saveAssignments(db, [{ consumer: 'l1', mode: 'follow', follow: 'l2' }], r), /不能跟随/);
    assert.throws(() => mp.saveAssignments(db, [{ consumer: 'l1', mode: 'disabled' }], r), /不能停用/);
    // 能力：L1 改成 Anthropic 后图片识别跟随 L1 → 整次写入被拒
    const pc = mp.createModelProvider(db, key, { name: 'Claude', type: 'anthropic', baseUrl: '', apiKey: KEY_B }, r); r = pc.revision;
    const full = (l1: any): any[] => [l1, { consumer: 'l2', mode: 'follow', follow: 'l1' }, { consumer: 'l3', mode: 'follow', follow: 'l2' },
      { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' }, { consumer: 'telegramVision', mode: 'follow', follow: 'l1' },
      { consumer: 'embedding', mode: 'provider', providerId: pb, model: 'text-embedding-3-small' }];
    assert.throws(() => mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: pc.id, model: 'claude-x' }), r), /图片识别.*不支持/);
    assert.throws(() => mp.updateModelProvider(db, key, pa, { name: 'A', type: 'anthropic', baseUrl: '', apiKey: KEY_A }, r), /不支持/, '改供应商类型也重新校验引用图');
    r = mp.deleteModelProvider(db, pc.id, r).revision;
    r = mp.setModelConfigEnabled(db, true, r).revision;   // 6 个使用方齐全可以启用（另有来源画像的停用行）
    // 整表保存：提交内容就是完整分配表；启用时少了必需行 → 整次回滚（第 5 轮审查）
    assert.throws(() => mp.saveAssignments(db, [{ consumer: 'l1', mode: 'provider', providerId: pa, model: 'flash' }], r), /没有分配/);
    assert.equal((db.prepare('SELECT count(*) n FROM model_assignments').get() as any).n, 7, '回滚后 7 行都在');
    r = mp.setModelConfigEnabled(db, false, r).revision;
    const rr = mp.saveAssignments(db, [{ consumer: 'l1', mode: 'provider', providerId: pa, model: 'flash' }], r).revision;
    assert.deepEqual((db.prepare(`SELECT consumer FROM model_assignments WHERE consumer<>'sourceProfiler'`).all() as any[]).map(x => x.consumer), ['l1'], '未提交的分配被清除');
    assert.equal((db.prepare(`SELECT disabled FROM model_assignments WHERE consumer='sourceProfiler'`).get() as any)?.disabled, 1, '已删除的来源画像永久保留一行停用（旧代码回滚仍有 7 行）');
    assert.throws(() => mp.saveAssignments(db, [{ consumer: 'sourceProfiler' as any, mode: 'disabled' }], rr), /未知使用方/, '来源画像不再接受分配');
    assert.ok(audits(db).at(-1)!.payload_json.includes('"to":"none"'), '审计记录被清除的分配');
    r = mp.saveAssignments(db, full({ consumer: 'l1', mode: 'provider', providerId: pa, model: 'flash' }), rr).revision;
    const dbi = freshDb('incomplete.db');
    const pi = mp.createModelProvider(dbi, key, { name: 'A', type: 'openai', baseUrl: '', apiKey: KEY_A }, 0);
    const ri = mp.saveAssignments(dbi, [{ consumer: 'l1', mode: 'provider', providerId: pi.id, model: 'm' }], pi.revision).revision;
    assert.throws(() => mp.setModelConfigEnabled(dbi, true, ri), /没有分配/, '6 个使用方不齐不能启用');
    dbi.close();
    ok('写入：乐观锁、改地址或类型必须重填密钥、外键与引用检查、follow 与停用规则、能力约束覆盖改类型');

    // 审计与配置同事务：审计插入失败 → 配置不变
    db.exec(`CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_events WHEN NEW.entity_type='model_config' BEGIN SELECT RAISE(ABORT, 'audit down'); END`);
    const before = rev(db);
    assert.throws(() => mp.createModelProvider(db, key, { name: 'Z', type: 'openai', baseUrl: '', apiKey: KEY_B }, before), /audit down/);
    assert.equal(rev(db), before); assert.ok(!db.prepare(`SELECT 1 FROM model_providers WHERE name='Z'`).get());
    db.exec('DROP TRIGGER fail_audit');
    const leaked = audits(db).map(a => a.payload_json).join('\n');
    assert.ok(!leaked.includes(KEY_A) && !leaked.includes(KEY_B) && !leaked.includes('/v1'), '审计不含密钥与地址路径');
    ok('审计与配置同一事务：审计失败则配置不变；审计不含密钥与路径');
  }

  // ---------- 主密钥强度、导入前已有停用分配（第 5 轮审查） ----------
  {
    assert.ok(mc.masterKeyProblem('')); assert.ok(mc.masterKeyProblem('replace-with-a-long-random-secret'), '示例占位值');
    assert.ok(mc.masterKeyProblem('short')); assert.equal(mc.masterKeyProblem('A'.repeat(43)), null);
    ok('主密钥：缺失、示例占位值、过短都被识别');
  }

  // ---------- 快照解析 ----------
  {
    const db2 = freshDb('b.db');
    let r = 0;
    const a = mp.createModelProvider(db2, key, { name: 'A', type: 'openai_compatible', baseUrl: 'https://gw.example.com/v1', apiKey: KEY_A }, r); r = a.revision;
    const g = mp.createModelProvider(db2, key, { name: 'G', type: 'gemini', baseUrl: '', apiKey: KEY_B }, r); r = g.revision;
    r = mp.saveAssignments(db2, [
      { consumer: 'l1', mode: 'provider', providerId: a.id, model: 'flash', strictness: 'json' }, { consumer: 'l2', mode: 'provider', providerId: g.id, model: 'gemini-pro' },
      { consumer: 'l3', mode: 'follow', follow: 'l2' }, { consumer: 'telegramSummary', mode: 'follow', follow: 'l1' },
      { consumer: 'telegramVision', mode: 'follow', follow: 'l1' }, { consumer: 'embedding', mode: 'disabled' },
    ], r).revision;
    r = mp.setModelConfigEnabled(db2, true, r).revision;
    process.env.AI_L1_PROVIDER = 'openai'; process.env.AI_L1_MODEL = 'env-model'; process.env.OPENAI_COMPAT_API_KEY = 'env-key';
    const snap = mc.loadModelSnapshot(db2);
    const l1 = mc.resolveModel(snap, 'l1') as any, l3 = mc.resolveModel(snap, 'l3') as any, tg = mc.resolveModel(snap, 'telegramSummary') as any;
    assert.deepEqual([l1.cfg.provider, l1.cfg.model, l1.cfg.baseUrl, l1.cfg.apiKey, l1.cfg.strictness, l1.cfg.isolated], ['openai_compatible', 'flash', 'https://gw.example.com/v1', KEY_A, 'json', true], '开关打开不读 env');
    assert.deepEqual([l3.cfg.provider, l3.cfg.model, l3.cfg.apiKey], ['gemini', 'gemini-pro', KEY_B], 'l3 跟随 l2 整体复制');
    assert.equal(tg.fingerprint, l1.fingerprint);
    assert.deepEqual(mc.resolveModel(snap, 'embedding'), { ok: true, disabled: true });
    delete process.env.AI_L1_PROVIDER; delete process.env.AI_L1_MODEL; delete process.env.OPENAI_COMPAT_API_KEY;
    // 快照不可变：之后改配置不影响已取的快照
    mp.updateModelProvider(db2, key, a.id, { name: 'A', type: 'openai_compatible', baseUrl: 'https://gw2.example.com/v1', apiKey: KEY_B }, r);
    assert.equal((mc.resolveModel(snap, 'l1') as any).cfg.baseUrl, 'https://gw.example.com/v1', '同一任务单元用同一快照');
    const snap2 = mc.loadModelSnapshot(db2);
    assert.notEqual((mc.resolveModel(snap2, 'l1') as any).fingerprint, l1.fingerprint, '换密钥与地址后指纹变化');
    // 错主密钥 → key_unreadable，不回退
    const bad = mc.loadModelSnapshot(db2, mc.masterKeyFrom('wrong'));
    assert.deepEqual(mc.resolveModel(bad, 'l1'), { ok: false, error: 'key_unreadable' });
    assert.deepEqual(mc.resolveModel(mc.loadModelSnapshot(db2, null), 'telegramSummary'), { ok: false, error: 'key_unreadable' });
    db2.close();
    ok('解析：开关打开不读 env、follow 整体复制、快照不可变、错主密钥不回退');
  }

  // ---------- 导入 ----------
  {
    const tgSettings = { provider: 'openai_compatible', model: 'flash', base_url: 'https://gw.example.com/v1', credential_ref: 'OPENAI_COMPAT_API_KEY',
      vision_provider: 'openai_compatible', vision_model: 'flash', vision_base_url: 'https://gw.example.com/v1', vision_credential_ref: 'OPENAI_COMPAT_API_KEY' };
    const prodEnv = { ...process.env, AI_L1_PROVIDER: 'openai_compatible', AI_L1_MODEL: 'flash', AI_L1_BASE_URL: 'https://gw.example.com/v1',
      AI_L2_PROVIDER: 'openai_compatible', AI_L2_MODEL: 'flash', AI_L2_BASE_URL: 'https://gw.example.com/v1',
      AI_L3_PROVIDER: 'openai_compatible', AI_L3_MODEL: 'flash', AI_L3_BASE_URL: 'https://gw.example.com/v1', OPENAI_COMPAT_API_KEY: KEY_A };
    const db3 = freshDb('c.db');
    // 导入前已保存过「停用」分配（没有供应商时也能保存）：导入用完整分配替换，不再主键冲突
    const pre = mp.saveAssignments(db3, [{ consumer: 'embedding', mode: 'disabled' }], 0).revision;
    const rep = mp.importLegacy(db3, key, tgSettings, pre, prodEnv);
    assert.ok(rep.ok, rep.reasons.join('；')); assert.equal(rep.providers, 1, '生产形态只生成 1 个供应商');
    const as = Object.fromEntries((db3.prepare('SELECT * FROM model_assignments').all() as any[]).map(a => [a.consumer, a.disabled ? 'disabled' : a.follow ? `follow:${a.follow}` : 'provider']));
    assert.deepEqual(as, { l1: 'provider', l2: 'follow:l1', l3: 'follow:l1', telegramSummary: 'follow:l1', telegramVision: 'follow:l1', sourceProfiler: 'disabled', embedding: 'disabled' });
    assert.equal(mc.loadModelSnapshot(db3).enabled, true, '导入成功即打开开关');
    const again = mp.importLegacy(db3, key, tgSettings, rev(db3), prodEnv);
    assert.ok(!again.ok && /重复导入/.test(again.reasons[0]!), '重复导入被拒');
    db3.close();
    // L1 = L3 ≠ L2
    const db4 = freshDb('d.db');
    const r4 = mp.importLegacy(db4, key, tgSettings, 0, { ...prodEnv, AI_L2_MODEL: 'pro' });
    assert.ok(r4.ok, r4.reasons.join('；'));
    const l3 = db4.prepare(`SELECT follow FROM model_assignments WHERE consumer='l3'`).get() as any;
    const l2 = db4.prepare(`SELECT provider_id, model FROM model_assignments WHERE consumer='l2'`).get() as any;
    assert.equal(l3.follow, 'l1'); assert.equal(l2.model, 'pro');
    db4.close();
    // 任一使用方不可导入 → 整体不导入
    const db5 = freshDb('e.db');
    const bad1 = mp.importLegacy(db5, key, { ...tgSettings, vision_provider: 'gemini', vision_credential_ref: 'GEMINI_API_KEY' }, 0, { ...prodEnv, GEMINI_API_KEY: KEY_B });
    assert.ok(!bad1.ok && bad1.reasons.some(x => x.includes('图片识别')));
    const bad2 = mp.importLegacy(db5, key, tgSettings, 0, { ...prodEnv, OPENAI_COMPAT_API_KEY: '' });
    assert.ok(!bad2.ok && bad2.reasons.some(x => x.includes('没有密钥')));
    const bad3 = mp.importLegacy(db5, key, tgSettings, 0, { ...prodEnv, AI_L1_PROVIDER: 'mock', AI_L2_PROVIDER: 'mock', AI_L3_PROVIDER: 'mock' });
    assert.ok(!bad3.ok && bad3.reasons.some(x => x.includes('mock')));
    const bad4 = mp.importLegacy(db5, key, tgSettings, 0, { ...prodEnv, AI_L2_PROVIDER: 'anthropic', AI_L2_MODEL: 'claude-x', ANTHROPIC_API_KEY: KEY_B, ANTHROPIC_BASE_URL: 'https://proxy.example.com' });
    assert.ok(!bad4.ok && bad4.reasons.some(x => x.includes('ANTHROPIC_BASE_URL')), 'SDK 会隐式读取的环境变量存在时拒绝导入');
    assert.ok(![bad1, bad2, bad3, bad4].some(b => b.reasons.join('').includes(KEY_A) || b.reasons.join('').includes(KEY_B)), '原因里不含密钥');
    assert.equal((db5.prepare('SELECT count(*) n FROM model_providers').get() as any).n, 0, '失败时什么都没写');
    assert.equal(mc.loadModelSnapshot(db5).enabled, false);
    db5.close();
    ok('导入：生产形态 1 个供应商且全部跟随；L1=L3≠L2；任一不可导入整体放弃；不重复导入；原因不含密钥');
  }

  // ---------- 模型列表 ----------
  {
    const fake = (pages: Array<{ status?: number; body: any; headers?: Record<string, string> }>) => {
      let i = 0; const seen: string[] = [];
      const f = (async (url: string, init: any) => {
        seen.push(url); assert.equal(init.redirect, 'error');
        const p = pages[Math.min(i++, pages.length - 1)]!;
        return new Response(typeof p.body === 'string' ? p.body : JSON.stringify(p.body), { status: p.status ?? 200, headers: p.headers });
      }) as any;
      return { f, seen };
    };
    let x = fake([{ body: { data: [{ id: 'b' }, { id: 'a' }, { id: '../bad' }] } }]);
    assert.deepEqual(await cat.fetchModelCatalog('openai_compatible', 'https://gw.example.com/v1', 'k', { fetchImpl: x.f }), { ok: true, models: ['a', 'b'], truncated: false });
    assert.equal(x.seen[0], 'https://gw.example.com/v1/models');
    x = fake([{ body: { models: [{ name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 't2' } },
      { body: { models: [{ name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] }] } }]);
    assert.deepEqual(await cat.fetchModelCatalog('gemini', '', 'k', { fetchImpl: x.f }), { ok: true, models: ['gemini-flash', 'gemini-pro'], truncated: false });
    assert.ok(x.seen[0]!.startsWith('https://generativelanguage.googleapis.com/v1beta/models') && x.seen[1]!.includes('pageToken=t2'));
    x = fake([{ body: { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' } }, { body: { data: [{ id: 'claude-b' }], has_more: false } }]);
    assert.deepEqual((await cat.fetchModelCatalog('anthropic', '', 'k', { fetchImpl: x.f }) as any).models, ['claude-a', 'claude-b']);
    assert.ok(x.seen[0]!.startsWith('https://api.anthropic.com/v1/models') && x.seen[1]!.includes('after_id=claude-a'));
    x = fake([{ body: { data: [{ id: 'a' }], has_more: true } }]);
    assert.equal((await cat.fetchModelCatalog('anthropic', '', 'k', { fetchImpl: x.f }) as any).kind, 'bad_response', '有更多却没游标 → 失败');
    x = fake([{ body: {} }]); assert.equal((await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }) as any).kind, 'bad_response', 'HTTP 200 的 {} 不当作空列表');
    for (const [t, body] of [['gemini', {}], ['gemini', { models: [{ name: 'models/x', supportedGenerationMethods: 'generateContent' }] }],
      ['anthropic', { data: [{ id: 'a' }] }], ['anthropic', { data: [{ id: 'a' }], has_more: 'false' }], ['openai', { data: [{ id: 1 }] }]] as const) {
      x = fake([{ body }]);
      assert.equal((await cat.fetchModelCatalog(t as any, '', 'k', { fetchImpl: x.f }) as any).kind, 'bad_response', `${t} ${JSON.stringify(body)} 应判为格式错误`);
    }
    x = fake([{ body: { models: [] } }]); assert.deepEqual(await cat.fetchModelCatalog('gemini', '', 'k', { fetchImpl: x.f }), { ok: true, models: [], truncated: false }, '合法空数组才算空目录');
    x = fake([{ body: { data: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })), has_more: true, last_id: 'm499' } }, { status: 500, body: '' }]);
    const exact = await cat.fetchModelCatalog('anthropic', '', 'k', { fetchImpl: x.f }) as any;
    assert.deepEqual([exact.ok, exact.models.length, exact.truncated, x.seen.length], [true, 500, true, 1], '名额正好用完：不再请求下一页');
    x = fake([{ body: { data: [] } }]); assert.deepEqual(await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }), { ok: true, models: [], truncated: false });
    x = fake([{ status: 403, body: 'secret echo sk-xxx' }]); const e403 = await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }) as any;
    assert.deepEqual(e403, { ok: false, kind: 'forbidden', status: 403 }, '错误只留 kind/status，不含正文');
    x = fake([{ status: 429, body: '', headers: { 'retry-after': '99999' } }]);
    assert.equal((await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }) as any).retryAfterSec, 3600, 'Retry-After 上限 1 小时');
    x = fake([{ body: 'x'.repeat(1024 * 1024 + 10) }]); assert.equal((await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }) as any).kind, 'too_large');
    x = fake(Array.from({ length: 7 }, (_, i) => ({ body: { models: [{ name: `models/m${i}`, supportedGenerationMethods: ['generateContent'] }], nextPageToken: `t${i}` } })));
    const five = await cat.fetchModelCatalog('gemini', '', 'k', { fetchImpl: x.f }) as any;
    assert.equal(five.models.length, 5); assert.equal(five.truncated, true, '5 页上限 → 成功且标不完整');
    x = fake([{ body: { data: Array.from({ length: 600 }, (_, i) => ({ id: `m${i}` })) } }]);
    const many = await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: x.f }) as any;
    assert.equal(many.models.length, 500); assert.equal(many.truncated, true);
    const slow = (async (_u: string, init: any) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as any;
    assert.equal((await cat.fetchModelCatalog('openai', '', 'k', { fetchImpl: slow, totalMs: 50 }) as any).kind, 'timeout');
    assert.ok(cat.tryStartFetch('p_x', 1000)); assert.ok(!cat.tryStartFetch('p_x', 1000), '同时只允许一个'); cat.endFetch('p_x');
    assert.ok(!cat.tryStartFetch('p_x', 5000), '10 秒内最多一次'); assert.ok(cat.tryStartFetch('p_x', 12000)); cat.endFetch('p_x');

    // 回写核对 config_version：拉取期间供应商被改或删 → 丢弃
    const db6 = freshDb('f.db');
    const p = mp.createModelProvider(db6, key, { name: 'A', type: 'openai', baseUrl: '', apiKey: KEY_A }, 0);
    assert.ok(mp.applyModelsFetch(db6, p.id, 1, { ok: true, models: ['a'], truncated: false }));
    assert.ok(mp.applyModelsFetch(db6, p.id, 1, { ok: false, kind: 'rate_limited', status: 429, retryAfterSec: 60 }));
    let row = db6.prepare('SELECT * FROM model_providers WHERE id=?').get(p.id) as any;
    assert.equal(row.models_json, '["a"]', '失败保留旧列表'); assert.equal(row.models_next_allowed_for, 1);
    mp.updateModelProvider(db6, key, p.id, { name: 'A', type: 'openai', baseUrl: '', apiKey: KEY_B }, p.revision);
    row = db6.prepare('SELECT * FROM model_providers WHERE id=?').get(p.id) as any;
    assert.equal(row.models_next_allowed_at, null, '换密钥后限流时间失效'); assert.equal(row.config_version, 2);
    assert.ok(!mp.applyModelsFetch(db6, p.id, 1, { ok: true, models: ['old'], truncated: false }), '旧版本结果被丢弃');
    assert.ok(!mp.applyModelsFetch(db6, 'p_zzzzzzzz', 1, { ok: true, models: ['x'], truncated: false }), '已删除的供应商不复活');
    db6.close();
    ok('模型列表：各协议格式与分页、结构校验、错误不含正文、上限与超时、在途与节流、回写核对版本');
  }

  // ---------- Anthropic 隔离 ----------
  {
    const reqs: Array<{ url: string; headers: any }> = [];
    const srv = createServer((rq, rs) => { reqs.push({ url: rq.url!, headers: rq.headers }); rq.resume(); rq.on('end', () => {
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    Object.assign(process.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'env-token', ANTHROPIC_LOG: 'debug', ANTHROPIC_API_KEY: 'env-api-key',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Api-Key: env-key\nX-Leak: 1\nAnthropic-Version: 1999-01-01\nAnthropic-Beta: evil\nUser-Agent: env-agent\nX-Stainless-Evil: 1' });
    const logs: string[] = []; const orig = [console.log, console.debug, console.info, console.warn, console.error];
    console.log = console.debug = console.info = console.warn = console.error = (...a: any[]) => { logs.push(a.join(' ')); };
    try {
      const p = await createProvider({ provider: 'anthropic', model: 'claude-x', apiKey: 'db-key', baseUrl: `http://127.0.0.1:${port}/gw`, isolated: true }, { retry: false });
      const r = await p.complete({ systemPrompt: 's', userContent: 'u-secret-content', schema: {}, schemaName: 't', maxOutputTokens: 10 });
      assert.deepEqual(r.data, { ok: true });
    } finally { [console.log, console.debug, console.info, console.warn, console.error] = orig; srv.close();
      for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_LOG', 'ANTHROPIC_API_KEY']) delete process.env[k]; }
    assert.equal(reqs.length, 1); assert.equal(reqs[0]!.url, '/gw/v1/messages', '请求发往库里的地址');
    const h = reqs[0]!.headers;
    assert.equal(h['x-api-key'], 'db-key'); assert.equal(h.authorization, undefined); assert.equal(h['x-leak'], undefined, '环境注入的自定义头被丢弃');
    assert.equal(h['anthropic-version'], '2023-06-01', '协议版本用固定值，环境同名头无效'); assert.equal(h['anthropic-beta'], undefined);
    assert.equal(h['user-agent'], 'briefing-system'); assert.ok(!Object.keys(h).some(k => k.startsWith('x-stainless')), '不发送 x-stainless-* 头');
    assert.ok(!logs.join('\n').includes('u-secret-content'), 'ANTHROPIC_LOG=debug 不输出请求内容');
    ok('Anthropic 隔离：忽略 ANTHROPIC_BASE_URL / AUTH_TOKEN / CUSTOM_HEADERS / LOG，只用库里的地址与密钥');
  }
  // ---------- Anthropic 地址规范化后比较（第 4 轮审查） ----------
  {
    const { isolatedOptions } = await import('../packages/ai/src/providers/anthropic.ts');
    const seen: string[] = []; const origFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => { seen.push(u); return new Response('{}'); }) as any;
    try {
      const o = isolatedOptions({ provider: 'anthropic', model: 'c', apiKey: 'k', baseUrl: 'https://API.Example.COM:443/gw/' }) as any;
      await o.fetch('https://api.example.com/gw/v1/messages', { headers: {} });
      assert.deepEqual(seen, ['https://api.example.com/gw/v1/messages'], '大小写与默认端口不同的同一地址放行');
      for (const bad of ['https://api.example.com/other/v1/messages', 'https://api.example.com/gwx/v1', 'https://api.example.com.evil.com/gw/v1', 'https://api.example.com:8443/gw/v1'])
        await assert.rejects(o.fetch(bad, { headers: {} }), /已拦截/, `${bad} 应被拦截`);
      assert.equal(seen.length, 1);
      const d = isolatedOptions({ provider: 'anthropic', model: 'c', apiKey: 'k' }) as any;
      await d.fetch('https://api.anthropic.com/v1/messages', { headers: {} });
      assert.equal(seen[1], 'https://api.anthropic.com/v1/messages', '留空用官方地址');
    } finally { globalThis.fetch = origFetch; }
    ok('Anthropic 隔离：规范化后比较源与路径，相似域名、其他端口、路径外地址仍被拦截');
  }
  console.log('\n✅ 全部通过');
} finally { rmSync(dir, { recursive: true, force: true }); }
