// 语义去重 + AI 分层判断（docs/semantic-dedup-design.md）的回归测试
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrate, nowIso } from '../packages/db/src/index.ts';
import type { CompleteRequest, Provider } from '../packages/ai/src/types.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import {
  EmbeddingError, embedAll, normalize, parseEmbeddingFields, parseEmbeddingResponse, requestEmbeddings, validateEmbeddingConfig, type EmbeddingConfig,
} from '../packages/ai/src/embeddings.ts';
import { AiCache, pruneAiCache } from '../packages/digest/src/cache.ts';
import { createTierEnv, runTask, type TaskSpec, type TierEnv } from '../packages/digest/src/tiered.ts';
import { applyConfirmed, autoCluster, compatibility, specificLinks, type ClusterInput, type Note } from '../packages/digest/src/semantic.ts';
import { acquireLease, budgetScope, nextSlot, takeBudget } from '../packages/db/src/runstate.ts';
import { parseRequest } from '../packages/web/src/requests.ts';
import { buildDigestSemantic } from '../packages/digest/src/build-semantic.ts';
import type { DigestSourceItem } from '../packages/digest/src/core.ts';

let pass = 0;
const ok = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); pass++; console.log(`  ✅ ${name}`); };
const dir = mkdtempSync(join(tmpdir(), 'brief-sem-'));
const cfg = (o: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({ enabled: true, baseUrl: 'https://emb.example/v1', model: 'm', dimensions: 0, simHigh: 0.9, simLow: 0.8, apiKey: 'sk-secret-123', ...o });
const vec = (...xs: number[]) => normalize(xs);

// ---------------- 向量客户端 ----------------
console.log('向量客户端：');
await ok('配置校验：公网 http、带凭证或查询参数的地址、非法阈值都被拒绝', () => {
  assert.equal(validateEmbeddingConfig(cfg()).length, 0);
  assert.equal(validateEmbeddingConfig(cfg({ baseUrl: 'http://127.0.0.1:8080/v1' })).length, 0);
  assert.ok(validateEmbeddingConfig(cfg({ baseUrl: 'http://emb.example/v1' })).some(e => e.includes('https')));
  assert.ok(validateEmbeddingConfig(cfg({ baseUrl: 'https://u:p@emb.example/v1' })).length);
  assert.ok(validateEmbeddingConfig(cfg({ baseUrl: 'https://emb.example/v1?key=abc' })).length);
  assert.ok(validateEmbeddingConfig(cfg({ simHigh: 0.8, simLow: 0.9 })).length);
  assert.ok(validateEmbeddingConfig(parseEmbeddingFields({ baseUrl: 'https://a/v1', model: 'm', dimensions: '1.5' })).length);
  assert.ok(validateEmbeddingConfig(parseEmbeddingFields({ baseUrl: 'https://a/v1', model: 'm', simHigh: 'abc' })).length);
});
await ok('响应校验：按 index 重排；重复/缺失 index、零向量、非有限数、维度不一致都整批作废', () => {
  const r = parseEmbeddingResponse({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }] }, 2, 0);
  assert.deepEqual([...r[0]!], [1, 0]); assert.deepEqual([...r[1]!], [0, 1]);
  const bad = (j: any, n = 2, d = 0) => assert.throws(() => parseEmbeddingResponse(j, n, d), EmbeddingError);
  bad({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] });
  bad({ data: [{ index: 0, embedding: [1] }] });
  bad({ data: [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [1, 0] }] });
  bad({ data: [{ index: 0, embedding: [1, null] }, { index: 1, embedding: [1, 0] }] });
  bad({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0, 0] }] });
  bad({ data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [1, 0] }] }, 2, 3);
});
await ok('错误不带上游正文与密钥；不跟随重定向；429 带 Retry-After', async () => {
  let seenInit: any;
  const f429 = (async (_u: any, init: any) => { seenInit = init; return new Response('{"error":{"code":"rate_limit_exceeded","message":"echo sk-secret-123 and input"}}', { status: 429, headers: { 'retry-after': '7' } }); }) as typeof fetch;
  const e = await requestEmbeddings(cfg(), ['x'], { fetchImpl: f429 }).catch(x => x);
  assert.ok(e instanceof EmbeddingError && e.kind === 'rate_limited' && e.retryAfterSec === 7 && e.code === 'rate_limit_exceeded');
  // 上游把密钥回显在 code 字段里：未知错误码一律丢弃
  const fEcho = (async () => new Response('{"error":{"code":"sk-secret-123"}}', { status: 400 })) as typeof fetch;
  const e3 = await requestEmbeddings(cfg(), ['x'], { fetchImpl: fEcho }).catch(x => x);
  assert.ok(e3.kind === 'bad_request' && e3.code === undefined && !String(e3.message).includes('sk-'));
  assert.ok(!String(e.message).includes('sk-secret') && !String(e.message).includes('echo'));
  assert.equal(seenInit.redirect, 'error');
  assert.ok(!('dimensions' in JSON.parse(seenInit.body)), '自动维度时不带 dimensions');
  const f401 = (async () => new Response('bad key sk-secret-123', { status: 401 })) as typeof fetch;
  const e2 = await requestEmbeddings(cfg(), ['x'], { fetchImpl: f401 }).catch(x => x);
  assert.ok(e2.kind === 'auth' && e2.fatal && !String(e2.message).includes('sk-'));
});
await ok('批量：临时故障重试后成功；401 立即停止；400 拆批', async () => {
  let n = 0;
  const flaky = (async (_u: any, init: any) => {
    n++;
    if (n === 1) return new Response('oops', { status: 503 });
    const inp = JSON.parse(init.body).input as string[];
    return Response.json({ data: inp.map((_, i) => ({ index: i, embedding: [1, i + 1] })) });
  }) as typeof fetch;
  const r = await embedAll(cfg(), ['a', 'b'], { fetchImpl: flaky, sleep: async () => {} });
  assert.equal(r.vectors.filter(Boolean).length, 2); assert.equal(n, 2);
  let calls = 0;
  const auth = (async () => { calls++; return new Response('', { status: 401 }); }) as typeof fetch;
  const r2 = await embedAll(cfg(), ['a', 'b', 'c'], { fetchImpl: auth, sleep: async () => {}, batchSize: 1 });
  assert.equal(r2.fatal?.kind, 'auth'); assert.equal(calls, 1, '配置错误后不再请求');
  const big = (async (_u: any, init: any) => {
    const inp = JSON.parse(init.body).input as string[];
    if (inp.length > 1) return new Response('{"error":{"code":"too_many_inputs"}}', { status: 400 });
    return Response.json({ data: [{ index: 0, embedding: [1, 1] }] });
  }) as typeof fetch;
  const r3 = await embedAll(cfg(), ['a', 'b'], { fetchImpl: big, sleep: async () => {} });
  assert.equal(r3.vectors.filter(Boolean).length, 2);
});

// ---------------- 聚类 ----------------
console.log('聚类：');
const note = (o: Partial<Note>): Note => ({ subject: 'OpenAI', action: '发布', object: 'GPT-6', version: '', numbers: [], eventTime: '', summary: 's', ...o });
const ci = (id: number, v: Float32Array | undefined, n?: Note, extra: Partial<ClusterInput> = {}): ClusterInput => ({ id, vec: v, note: n, links: new Set(), urlKey: null, ...extra });
await ok('高相似且身份兼容才自动合并；版本或互斥动作冲突进灰区', () => {
  const a = ci(1, vec(1, 0, 0), note({})), b = ci(2, vec(0.99, 0.14, 0), note({}));
  const c = ci(3, vec(0.99, 0, 0.14), note({ action: '下线' }));
  const r = autoCluster([a, b, c], 0.9, 0.8);
  assert.deepEqual(r.groups, [[1, 2], [3]]);
  assert.equal(r.gray.length, 1);
  assert.equal(compatibility(note({ version: 'v1' }), note({ version: 'v2' })), 'gray');
  assert.equal(compatibility(note({ subject: 'Google' }), note({})), 'gray');
  assert.equal(compatibility(note({ numbers: ['5%'] }), note({ numbers: ['10%'] })), 'gray');
  assert.equal(compatibility(note({ numbers: ['2026年', '100亿元'] }), note({ numbers: ['2026年', '200亿元'] })), 'gray', '共同年份不能掩盖金额冲突');
  assert.equal(compatibility(note({ numbers: ['2026年'] }), note({ numbers: ['2026年', '200亿元'] })), 'gray', '一方多出数字也要确认');
  assert.equal(compatibility(note({ numbers: ['2026年', '5%'] }), note({ numbers: ['5%', '2026年'] })), 'auto');
  assert.equal(compatibility(undefined, note({})), 'gray');
});
await ok('完全链接：A≈B、B≈C 但 A≉C 时不会链式合并三条', () => {
  const A = ci(1, vec(1, 0), note({})), B = ci(2, vec(0.96, 0.28), note({})), C = ci(3, vec(0.84, 0.54), note({}));
  const r = autoCluster([A, B, C], 0.9, 0.8);
  assert.ok(!r.groups.some(g => g.length === 3));
});
await ok('无向量只按网址完全相同合并；共享具体链接降低门槛但仍需身份兼容；泛链接不算线索', () => {
  const r = autoCluster([ci(1, undefined, undefined, { urlKey: 'a.com/x' }), ci(2, undefined, undefined, { urlKey: 'a.com/x' }), ci(3, undefined)], 0.9, 0.8);
  assert.deepEqual(r.groups, [[1, 2], [3]]);
  const L = new Set(['openai.com/index/gpt-6']);
  const r2 = autoCluster([ci(1, vec(1, 0), note({}), { links: L }), ci(2, vec(0.85, 0.53), note({}), { links: L })], 0.9, 0.8);
  assert.deepEqual(r2.groups, [[1, 2]]);
  const it = (url: string): DigestSourceItem => ({ id: 1, sourceId: 's', sourceName: 's', vendor: 'v', official: false, role: 'context', title: '', text: '', url, publishedAt: null, firstSeenAt: '' });
  assert.equal(specificLinks(it('https://github.com/foo/bar')).size, 0);
  assert.equal(specificLinks(it('https://openai.com/')).size, 0);
  assert.equal(specificLinks(it('https://openai.com/index/gpt-6/')).size, 1);
});
await ok('灰区确认后只合并两侧都未改动过的组', () => {
  const groups = [[1], [2], [3]];
  const props = [{ a: [1], b: [2], score: 0.85 }, { a: [2], b: [3], score: 0.84 }];
  assert.deepEqual(applyConfirmed(groups, props, new Set([0, 1])), [[1, 2], [3]]);
});

// ---------------- 分层调用 ----------------
console.log('分层调用：');
type Handler = (req: CompleteRequest, payload: any) => unknown;
const scripted = (name: string, h: Handler) => { const p = { calls: 0, name: 'mock' as const, model: name, strictness: 'json' as const,
  async complete(req: CompleteRequest) { p.calls++; const data = await h(req, JSON.parse(req.userContent)); return { data, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 }, responseId: 'r', model: name }; } };
  return p; };
const SPEC: TaskSpec<{ t: string }, { v: string; confidence: number }> = {
  task: 't.v1', system: 's', schemaName: 'x', batchSize: 10,
  schema: { type: 'object', required: ['r'], properties: { r: { type: 'array', items: { type: 'object', required: ['id', 'v', 'confidence'],
    properties: { id: { type: 'integer' }, v: { type: 'string' }, confidence: { type: 'number' } } } } } },
  maxOut: () => 100, payload: b => ({ items: b.map(x => ({ id: Number(x.id), ...x.input })) }),
  entries: o => o.r, idOf: r => String(r.id), accept: r => r.v ? { v: r.v, confidence: Number(r.confidence) } : null, confidence: r => r.confidence,
};
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), input: { t: `item${i + 1}` } }));
const mkEnv = async (l1: Provider, l2: Provider, cache = new AiCache(null), extra: { onDispatch?: () => void; same?: boolean } = {}) => {
  const env = await createTierEnv({ l1: { provider: 'mock', model: 'a' }, l2: { provider: 'mock', model: extra.same ? 'a' : 'b' }, promptVersion: 't', cache,
    onDispatch: extra.onDispatch ?? (() => {}), providers: { l1, l2 }, concurrency: 1 });
  return env;
};
await ok('输出缺失、重复、未知 ID 与低置信度条目交 L2，其余保留 L1 结果', async () => {
  const l1 = scripted('a', (_r, p) => ({ r: [
    { id: 1, v: 'ok', confidence: 0.9 }, { id: 2, v: 'x', confidence: 0.9 }, { id: 2, v: 'y', confidence: 0.9 },
    { id: 3, v: 'low', confidence: 0.3 }, { id: 99, v: 'ghost', confidence: 1 } ] }));
  const l2 = scripted('b', (_r, p) => ({ r: p.items.map((x: any) => ({ id: x.id, v: `L2-${x.id}`, confidence: 0.9 })) }));
  const r = await runTask(await mkEnv(l1, l2), SPEC, items(4));
  assert.equal(r.results.get('1')!.v, 'ok'); assert.equal(r.tiers.get('1'), 'L1');
  for (const id of ['2', '3', '4']) assert.equal(r.results.get(id)!.v, `L2-${id}`);
  assert.equal(r.unresolved.size, 0);
});
await ok('两层都被内容安全拦截的条目按拒绝处理计；其余拆单条后成功', async () => {
  const filtered = () => { const e = new ProviderError('bad_request', 'filtered'); e.contentFiltered = true; return e; };
  const l1 = scripted('a', (_r, p) => { if (p.items.some((x: any) => x.id === 2)) throw filtered(); return { r: p.items.map((x: any) => ({ id: x.id, v: 'ok', confidence: 1 })) }; });
  const l2 = scripted('b', (_r, p) => { if (p.items.some((x: any) => x.id === 2)) throw filtered(); return { r: p.items.map((x: any) => ({ id: x.id, v: 'ok2', confidence: 1 })) }; });
  const r = await runTask(await mkEnv(l1, l2), SPEC, items(3));
  assert.deepEqual([...r.refused], ['2']); assert.equal(r.results.size, 2); assert.equal(r.unresolved.size, 0);
});
await ok('L1 认证失败且 L2 配置相同：不再调用 L2，条目未判定', async () => {
  const l1 = scripted('a', () => { throw new ProviderError('auth', 'HTTP 401 key', 401); });
  const r = await runTask(await mkEnv(l1, l1, new AiCache(null), { same: true }), SPEC, items(3));
  assert.equal(l1.calls, 1); assert.equal(r.unresolved.size, 3);
});
await ok('Schema 不合格重试一次后升级 L2；L2 也失败则未判定', async () => {
  const l1 = scripted('a', () => ({ wrong: true }));
  const l2 = scripted('b', () => { throw new ProviderError('server', 'HTTP 500', 500); });
  const r = await runTask(await mkEnv(l1, l2), SPEC, items(2));
  assert.equal(l1.calls, 2); assert.equal(r.unresolved.size, 2);
});
await ok('预算耗尽即停止派发，剩余条目未判定', async () => {
  let left = 1;
  const stop = () => { if (left-- <= 0) { const e = new ProviderError('timeout', 'budget'); e.budgetExhausted = true; throw e; } };
  const mk = (n: string) => { const s = scripted(n, (_r, p) => ({ r: p.items.map((x: any) => ({ id: x.id, v: 'ok', confidence: 1 })) }));
    return { ...s, complete: (req: CompleteRequest) => { stop(); return s.complete(req); } } as Provider; };
  const env = await mkEnv(mk('a'), mk('b'));
  const r = await runTask(env, { ...SPEC, batchSize: 2 }, items(4));
  assert.equal(r.results.size, 2); assert.equal(r.unresolved.size, 2); assert.equal(env.stopReason, 'budget');
});

await ok('判为收录却没有摘要：不缓存、交 L2，两层都如此则未判定', async () => {
  const { tutorialJudge, dealJudge, dealMerger, Gate } = await import('../packages/digest/src/ai-tiered.ts');
  const empty = scripted('a', (req, p) => req.schemaName === 'tutorial_judge'
    ? { results: p.posts.map((x: any) => ({ id: x.id, tutorial: true, category: 'tech', reason: '教程', summary: '', confidence: 0.95 })) }
    : { results: p.items.map((x: any) => ({ id: x.id, deal: true, title: 't', reason: 'r', summary: ' ', confidence: 0.95 })) });
  const gate = new Gate();
  const env = await mkEnv(empty, empty);
  const t = await tutorialJudge(env, gate)([{ id: 1, title: 'x', text: 'y', signals: [] }]);
  const d = await dealJudge(env, gate)([{ id: 2, title: 'x', text: 'y' }]);
  assert.equal(t.results.size + d.results.size, 0);
  assert.deepEqual(gate.unresolved.map(u => u.task).sort(), ['技术干货', '羊毛资讯']);
  // 羊毛合并：空组、跨事件组合并都被拒绝，回退为各自成条
  const bad = scripted('a', () => ({ groups: [{ ids: [1, 2], summary: '合并' }, { ids: [], summary: '' }] }));
  const m1 = await dealMerger(await mkEnv(bad, bad))([{ id: 1, title: 'a', summary: 'a' }, { id: 2, title: 'b', summary: 'b' }]);
  assert.equal(m1.groups.length, 2);
  const cross = scripted('a', () => ({ groups: [{ ids: [1, 2], summary: '合并' }] }));
  const m2 = await dealMerger(await mkEnv(cross, cross), (a, b) => a !== b)([{ id: 1, title: 'a', summary: 'a' }, { id: 2, title: 'b', summary: 'b' }], new Map([[1, 101], [2, 102]]));
  assert.equal(m2.groups.length, 2, '不同事件组的论坛帖不得合并');
  const m3 = await dealMerger(await mkEnv(cross, cross), (a, b) => a !== b)([{ id: 1, title: 'a', summary: 'a' }, { id: 2, title: 'b', summary: 'b' }], new Map([[1, 101]]));
  assert.equal(m3.groups.length, 1, '没有事件身份的其他渠道条目仍可合并');
});
await ok('两层都拒绝处理的结果会缓存：重试时不再消耗 L2 名额；无标题消息不记录正文', async () => {
  const { dealJudge, Gate } = await import('../packages/digest/src/ai-tiered.ts');
  const cache = new AiCache(openDb(join(dir, 'refuse.db')));
  const mdb = openDb(join(dir, 'refuse2.db')); migrate(mdb, './migrations');
  const c2 = new AiCache(mdb);
  const refuse = scripted('a', () => { const e = new ProviderError('refusal', 'blocked'); throw e; });
  const gate = new Gate();
  const d = await dealJudge(await mkEnv(refuse, refuse, c2), gate)([{ id: 7, title: '', text: '群里私聊内容 PRIVATE-BODY' }]);
  assert.equal(d.results.get(7)?.reason, '模型拒绝处理');
  assert.ok(!JSON.stringify(gate.refused).includes('PRIVATE-BODY'), '拒绝标签不含消息正文');
  const calls = refuse.calls;
  const gate2 = new Gate();
  await dealJudge(await mkEnv(refuse, refuse, c2), gate2)([{ id: 7, title: '', text: '群里私聊内容 PRIVATE-BODY' }]);
  assert.equal(refuse.calls, calls, '缓存命中，不再请求'); assert.equal(gate2.refused.length, 1);
  void cache; mdb.close();
});
await ok('其他渠道的羊毛条目带上原条目编号，合并时能检查是否已判为不同事件', async () => {
  const { mergeAllDeals } = await import('../packages/digest/src/deals.ts');
  let seen: Map<number, number> | null = null;
  const report: any = { merged: [] };
  await mergeAllDeals(null as any, [], [{ channel: 'other', title: 'a', summary: 'a', url: 'https://a', raw: '', itemId: 501 },
    { channel: 'telegram', title: 'b', summary: 'b', url: '', raw: '' }], report, [], async (items, map) => { seen = map; return { groups: items.map(i => ({ ids: [i.id], summary: i.summary })) }; });
  assert.deepEqual([...seen!.entries()], [[1, 501]]);
});
await ok('向量请求计入预算：预算用尽即停止向量调用（不当作网络错误重试）', async () => {
  const { embedTexts } = await import('../packages/digest/src/semantic.ts');
  let calls = 0;
  const f = (async () => { calls++; return Response.json({ data: [{ index: 0, embedding: [1, 0] }] }); }) as typeof fetch;
  const real = globalThis.fetch; globalThis.fetch = f;
  try {
    const r = await embedTexts(cfg({ model: 'budget-test' }), new AiCache(null), ['a', 'b'], { onDispatch: () => { throw new EmbeddingError('budget'); } });
    assert.equal(r.fatal?.kind, 'budget'); assert.equal(calls, 0);
  } finally { globalThis.fetch = real; }
});

// ---------------- 迁移、缓存、运行状态 ----------------
console.log('迁移与运行状态：');
const db = openDb(join(dir, 'b.db'));
await ok('空库全量迁移可重复执行，018 的表都存在', () => {
  migrate(db, './migrations'); migrate(db, './migrations');
  const t = (db.prepare(`SELECT group_concat(name) n FROM sqlite_master WHERE type='table' AND name IN ('ai_item_notes','embedding_cache','run_ai_budget','run_attempts','run_retry_state','run_leases')`).get() as any).n.split(',');
  assert.equal(t.length, 6);
});
await ok('缓存命中后不再调用模型；冲突写入以先写者为准；只读库只读不写', async () => {
  const cache = new AiCache(db);
  const l1 = scripted('a', (_r, p) => ({ r: p.items.map((x: any) => ({ id: x.id, v: 'first', confidence: 1 })) }));
  await runTask(await mkEnv(l1, l1, cache), SPEC, items(2));
  const l1b = scripted('a', (_r, p) => ({ r: p.items.map((x: any) => ({ id: x.id, v: 'second', confidence: 1 })) }));
  const r = await runTask(await mkEnv(l1b, l1b, cache), SPEC, items(2));
  assert.equal(l1b.calls, 0); assert.equal(r.results.get('1')!.v, 'first');
  assert.equal(cache.putResult('h', 't', 'c', 'L1', { a: 1 }).value.a, 1);
  assert.equal(cache.putResult('h', 't', 'c', 'L2', { a: 2 }).value.a, 1);
  const v = cache.putVector('th', 'c', 0, vec(1, 2, 3));
  assert.equal(cache.getVector('th', 'c', 0)!.length, 3); assert.ok(Math.abs(v[0]! - vec(1, 2, 3)[0]!) < 1e-6);
  db.pragma('wal_checkpoint(TRUNCATE)');
  const ro = new Database(join(dir, 'b.db'), { readonly: true });
  const rc = new AiCache(ro as any);
  assert.ok(rc.enabled && !rc.writable && rc.note);
  assert.equal(rc.putResult('new', 't', 'c', 'L1', { z: 1 }).value.z, 1);
  assert.equal(rc.getResult('new', 't', 'c'), null);
  ro.close();
  const empty = new Database(':memory:');
  assert.ok(!new AiCache(empty as any).enabled);
  assert.equal(pruneAiCache(db, 0).notes >= 0, true);
});
const now = nowIso();
const runId = Number(db.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger)
  VALUES ('2026-11-05:daily','日报',?,?,?,'running','timer')`).run('2026-11-04T00:00:00Z', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z').lastInsertRowid);
await ok('预算按作用域原子扣减；手动重跑另开预算', () => {
  assert.ok(takeBudget(db, runId, 'timer', 2) && takeBudget(db, runId, 'timer', 2));
  assert.ok(!takeBudget(db, runId, 'timer', 2));
  assert.ok(takeBudget(db, runId, budgetScope('manual', 9), 2));
});
await ok('租约互斥，过期后可被接管，释放后可再获取', () => {
  let t = Date.now();
  const a = acquireLease(db, runId, () => t)!;
  assert.ok(a && a.held());
  assert.equal(acquireLease(db, runId, () => t), null);
  t += 6 * 60_000;
  const b = acquireLease(db, runId, () => t)!;
  assert.ok(b); assert.ok(!a.held());
  b.release(); a.release();
  const c = acquireLease(db, runId); assert.ok(c); c!.release();
});
await ok('固定时刻表：每 15 分钟一个时刻，严格晚于当前时间', () => {
  const base = Date.parse('2026-11-05T00:00:00Z');
  assert.equal(new Date(nextSlot(base, base)).toISOString(), '2026-11-05T00:15:00.000Z');
  assert.equal(new Date(nextSlot(base, base + 16 * 60_000)).toISOString(), '2026-11-05T00:30:00.000Z');
  assert.equal(new Date(nextSlot(base, base + 30 * 60_000)).toISOString(), '2026-11-05T00:45:00.000Z');
});
await ok('后台重跑接受当前配置的 daily 窗口，拒绝非法窗口', () => {
  assert.ok(parseRequest({ type: 'rerun', window: '2026-11-05:daily' }));
  assert.equal(parseRequest({ type: 'rerun', window: '2026-11-05:noon' }), null, '当前配置没有 noon 窗口');
  assert.equal(parseRequest({ type: 'rerun', window: '2026-11-05:daily; rm -rf /' }), null);
});

// ---------------- 集成：组装 ----------------
console.log('集成：');
const ins = (id: string, vendor: string, official: number, role: string) => db.prepare(`INSERT INTO sources (id,name,display_name,category,host_group,harvest_tier,
  config_json,source_version,created_at,updated_at,vendor,is_official,source_role,enabled) VALUES (?,?,?,'news','direct','standard','{}',1,?,?,?,?,?,1)`)
  .run(id, id, id, now, now, vendor, official, role);
ins('yicai', 'other', 0, 'politics'); ins('openai_news', 'openai', 1, 'official'); ins('x_openai', 'openai', 1, 'official');
let seq = 0;
const item = (src: string, title: string, text: string, url: string, at: string) => {
  seq++;
  const fid = Number(db.prepare(`INSERT INTO feed_items (source_id,source_item_key,key_kind,canonical_url,published_at,timestamp_confidence,first_seen_at,last_seen_at,created_at)
    VALUES (?,?,?,?,?,'exact',?,?,?)`).run(src, `k${seq}`, 'guid', url, at, at, at, at).lastInsertRowid);
  const vid = Number(db.prepare(`INSERT INTO item_versions (item_id,content_hash,raw_hash,title,clean_text,discovered_at,version_no) VALUES (?,?,?,?,?,?,1)`)
    .run(fid, `h${seq}`, `r${seq}`, title, text, at).lastInsertRowid);
  db.prepare('UPDATE feed_items SET current_version_id=? WHERE id=?').run(vid, fid);
  return fid;
};
const P1 = item('yicai', '国务院发布稳就业新政', '国务院今日发布稳就业政策措施，包括社保补贴等内容。', 'https://yicai.com/n/1', '2026-11-04T02:00:00Z');
const P2 = item('yicai', '稳就业政策出台', '国务院出台稳就业政策，社保补贴延续。', 'https://yicai.com/n/2', '2026-11-04T03:00:00Z');
item('yicai', '某地发生地震', '某地发生 5 级地震，暂无人员伤亡报告。', 'https://yicai.com/n/3', '2026-11-04T04:00:00Z');
const O1 = item('openai_news', 'Introducing GPT-6', 'Today we are releasing GPT-6, our most capable model with new reasoning.', 'https://openai.com/index/gpt-6/', '2026-11-04T05:00:00Z');
const O2 = item('x_openai', 'GPT-6 is here', 'GPT-6 is rolling out today to all users with better reasoning abilities.', 'https://x.com/OpenAI/status/1', '2026-11-04T05:10:00Z');
item('x_openai', 'GPT-6 price cut', 'We are cutting GPT-6 API prices by 50 percent starting today for developers.', 'https://x.com/OpenAI/status/2', '2026-11-04T06:00:00Z');

const noteFor = (t: string) => /就业/.test(t) ? { subject: '国务院', action: '发布', object: '稳就业政策', summary: '国务院发布稳就业政策' }
  : /地震/.test(t) ? { subject: '某地', action: '发生', object: '地震', summary: '某地发生地震' }
  : /price|降价/i.test(t) ? { subject: 'OpenAI', action: '降价', object: 'GPT-6 API', summary: 'OpenAI GPT-6 API 降价' }
  : { subject: 'OpenAI', action: '发布', object: 'GPT-6', summary: 'OpenAI 发布 GPT-6' };
const asked: Record<string, number> = {};
const brain: Handler = (req, p) => {
  asked[req.schemaName] = (asked[req.schemaName] ?? 0) + 1;
  switch (req.schemaName) {
    case 'event_notes': return { notes: p.items.map((x: any) => ({ id: x.id, version: '', numbers: [], event_time: '', ...noteFor(`${x.title} ${x.text}`) })) };
    case 'same_event': return { results: p.questions.map((q: any) => ({ id: q.id, same_event: false, conflict: true, confidence: 0.9 })) };
    case 'vendor_events': return { events: p.events.map((e: any) => ({ id: e.id, title: `事件${e.id}`, summary: `摘要${e.items.length}条`, trivial: false, repeat: false, confidence: 0.9 })) };
    case 'politics': return { results: p.groups.map((g: any) => ({ id: g.id, selected: true, text: `时政${g.reports.length}条报道`, confidence: 0.9 })) };
    default: return { results: [], projects: [], verdicts: [] };
  }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_u: any, init: any) => {
  const inp = JSON.parse(init.body).input as string[];
  const v = (t: string) => /就业/.test(t) ? [1, 0.02, 0, 0] : /地震/.test(t) ? [0, 1, 0, 0] : /降价|price/i.test(t) ? [0.85, 0, 0.5268, 0] : /GPT-6/.test(t) ? [0.99, 0, 0.05, 0] : [0, 0, 0, 1];
  return Response.json({ data: inp.map((t, i) => ({ index: i, embedding: v(t) })) });
}) as typeof fetch;
const win = { key: '2026-11-05:daily', label: '日报', start: new Date('2026-11-04T00:00:00Z'), end: new Date('2026-11-05T00:00:00Z') };
await ok('同一事件合并（时政两条合一、官网与官方 X 合一），不同事件（发布 vs 降价）经 L2 否决保持分开', async () => {
  const p = scripted('a', brain);
  const env = await mkEnv(p, p, new AiCache(db));
  const b = await buildDigestSemantic(db, win, env, { cache: new AiCache(db), embedding: cfg(), telegramPath: null });
  assert.equal(b.gate.unresolved.length, 0, JSON.stringify(b.gate.unresolved));
  assert.deepEqual(b.data.politics.sort(), ['时政1条报道', '时政2条报道']);
  const openai = b.data.vendors.find(v => v.vendor === 'openai')!;
  assert.equal(openai.events.length, 2);
  assert.ok(openai.events.some(e => e.itemIds.includes(O1) && e.itemIds.includes(O2)));
  assert.ok(asked.same_event >= 1, '发布与降价进灰区交 L2');
  assert.ok(b.stats.groups === 4, JSON.stringify(b.stats));
  void P1; void P2;
});
await ok('向量不可用（401）时只降级合并：不丢条目、不阻断', async () => {
  globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
  const p = scripted('a', brain);
  const b = await buildDigestSemantic(db, win, await mkEnv(p, p), { cache: new AiCache(null), embedding: cfg({ model: 'other' }), telegramPath: null });
  assert.equal(b.gate.unresolved.length, 0);
  assert.equal(b.data.politics.length, 3, '三条时政各自成组');
  assert.ok(b.warnings.some(w => w.includes('向量模型不可用')));
});
await ok('决定取舍的判定失败时计为未判定（阻断发布），不静默丢弃', async () => {
  const p = scripted('a', (req, pl) => { if (req.schemaName === 'politics') throw new ProviderError('server', 'HTTP 502', 502); return brain(req, pl); });
  const b = await buildDigestSemantic(db, win, await mkEnv(p, p), { cache: new AiCache(null), embedding: null, telegramPath: null });
  assert.ok(b.gate.unresolved.some(u => u.task === '时政速览'));
});
globalThis.fetch = realFetch;

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n✅ 全部通过（${pass} 项）`);
