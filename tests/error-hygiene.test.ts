// 错误信息卫生 + Telegram 完整性（docs/error-hygiene-design.md）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'error-hygiene-'));
const MARK = 'LEAK_MARKER_7f3a';   // 放进上游正文、模型输出里的标记：任何落库 / 日志 / message 都不得出现
const ok = (name: string) => console.log(`  ✅ ${name}`);
const noLeak = (s: unknown, what: string) => assert.ok(!String(s ?? '').includes(MARK), `${what} 不得包含上游内容：${String(s).slice(0, 200)}`);

const { ProviderError } = await import('../packages/ai/src/types.ts');
const err = await import('../packages/ai/src/errors.ts');
const { toError, OpenAICompatProvider } = await import('../packages/ai/src/providers/openai-compat.ts');
const { GeminiProvider } = await import('../packages/ai/src/providers/gemini.ts');
const { validate } = await import('../packages/ai/src/schema.ts');
const { createProvider } = await import('../packages/ai/src/registry.ts');
const { readyTelegramDb } = await import('../packages/telegram/src/db.ts');
const vision = await import('../packages/telegram/src/vision.ts');
const { buildDigest } = await import('../packages/telegram/src/digest.ts');
const { summarizeJob } = await import('../packages/telegram/src/summarize.ts');
const { cleanupTelegram } = await import('../packages/telegram/src/maintenance.ts');
const { traceFacts } = await import('../packages/ai/src/fact-trace.ts');

/** 用假 fetch 跑一次适配器请求，返回抛出的错误。 */
async function adapterError(make: () => any, respond: () => Response): Promise<any> {
  const orig = globalThis.fetch; globalThis.fetch = (async () => respond()) as any;
  try { await make().complete({ systemPrompt: 's', userContent: 'u', schema: { type: 'object' }, schemaName: 't', maxOutputTokens: 10 }); return null; }
  catch (e) { return e; } finally { globalThis.fetch = orig; }
}
const compat = () => new OpenAICompatProvider({ provider: 'openai_compatible', model: 'm', apiKey: 'k', baseUrl: 'https://gw.example.com/v1' });
const gem = () => new GeminiProvider({ provider: 'gemini', model: 'g', apiKey: 'k' });
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

try {
  // ================= A1 源头 =================
  {
    let e = toError(400, JSON.stringify({ error: { message: `bad ${MARK}`, code: 'model_not_found' } }));
    noLeak(e.message, 'HTTP 错误 message'); assert.equal(e.code, 'model_not_found'); assert.equal(e.message, 'HTTP 400 model_not_found');
    e = toError(400, JSON.stringify({ error: { code: `sk-${MARK}` } })); assert.equal(e.code, 'other', '名单外的错误码记 other'); noLeak(e.message, '非白名单码');
    e = toError(503, `<html>${MARK}</html>`); assert.equal(e.kind, 'server'); noLeak(e.message, '非 JSON 错误页');
    assert.equal(toError(429, '', '7').retryAfterSec, 7, '响应头有效');
    assert.equal(toError(429, '{"retry_after": 9}', 'bogus').retryAfterSec, 9, '响应头无效回退正文');
    assert.equal(toError(429, 'retry-after: 11').retryAfterSec, 11, '无头时取正文');
    assert.equal(toError(401, JSON.stringify({ error: { type: 'authentication_error' } })).code, 'authentication_error');
    assert.equal(toError(400, JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: MARK } })).code, 'INVALID_ARGUMENT', 'Gemini 用 error.status');

    // OpenAI 兼容：非 JSON 输出、字符串计数、refusal、网络错误
    e = await adapterError(compat, () => json({ choices: [{ message: { content: `不是 JSON ${MARK}` }, finish_reason: 'stop' }] }));
    noLeak(e.message, '非 JSON 输出'); assert.match(e.message, /响应不是合法 JSON（\d+ 字）/);
    e = await adapterError(compat, () => json({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: MARK } }));
    assert.equal(e.kind, 'truncated'); noLeak(e.message, '字符串型 token 计数');
    e = await adapterError(compat, () => json({ choices: [{ message: { content: null, refusal: `我不能 ${MARK}` }, finish_reason: 'stop' }] }));
    assert.deepEqual([e.kind, e.contentFiltered, e.retryable], ['refusal', true, false]); noLeak(e.message, 'refusal');
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => { const x: any = new TypeError(`fetch failed ${MARK}`); x.cause = { code: 'ECONNRESET', message: MARK }; throw x; }) as any;
    try { await compat().complete({ systemPrompt: 's', userContent: 'u', schema: {}, schemaName: 't', maxOutputTokens: 1 }); } catch (x: any) { e = x; } finally { globalThis.fetch = origFetch; }
    assert.deepEqual([e.kind, e.code, e.message], ['network', 'ECONNRESET', '网络错误（ECONNRESET）']);
    globalThis.fetch = (async () => { const x: any = new Error(MARK); x.code = `E${MARK}`; throw x; }) as any;
    try { await compat().complete({ systemPrompt: 's', userContent: 'u', schema: {}, schemaName: 't', maxOutputTokens: 1 }); } catch (x: any) { e = x; } finally { globalThis.fetch = origFetch; }
    assert.equal(e.message, '网络错误（other）', '名单外的网络错误码');

    // Gemini：原生拒答、非 JSON 响应体
    e = await adapterError(gem, () => json({ promptFeedback: { blockReason: 'OTHER' }, candidates: [] }));
    assert.deepEqual([e.kind, e.contentFiltered], ['refusal', true]);
    e = await adapterError(gem, () => json({ candidates: [{ finishReason: 'BLOCKLIST', content: { parts: [] } }] }));
    assert.equal(e.kind, 'refusal');
    e = await adapterError(gem, () => new Response(`{oops ${MARK}`, { status: 200 }));
    noLeak(e.message, 'Gemini 坏 JSON 响应体'); assert.equal(e.kind, 'bad_request');
    e = await adapterError(gem, () => json({ error: { status: 'RESOURCE_EXHAUSTED', message: MARK } }, 429, { 'retry-after': '5' }));
    assert.deepEqual([e.kind, e.retryAfterSec, e.code], ['rate_limited', 5, 'RESOURCE_EXHAUSTED']); noLeak(e.message, 'Gemini 429');

    // Anthropic（真 SDK + 本机假服务）：错误正文、拒答
    const replies: Array<[number, unknown]> = [[400, { type: 'error', error: { type: 'invalid_request_error', message: MARK } }],
      [200, { id: 'm', type: 'message', role: 'assistant', model: 'c', stop_reason: 'refusal', stop_details: { explanation: MARK }, content: [], usage: { input_tokens: 1, output_tokens: 0 } }],
      [429, { type: 'error', error: { type: 'rate_limit_error', message: MARK } }],
      [429, { type: 'error', error: { type: 'rate_limit_error', message: MARK }, retry_after: 4 }]];
    let n429 = 0;
    const srv = createServer((rq, rs) => { rq.resume(); rq.on('end', () => { const [st, body] = replies.shift()!;
      // 第一个 429 带响应头；第二个没有响应头、秒数只在正文里
      rs.writeHead(st, { 'content-type': 'application/json', ...(st === 429 && n429++ === 0 ? { 'retry-after': '3' } : {}) }); rs.end(JSON.stringify(body)); }); });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const a = await createProvider({ provider: 'anthropic', model: 'c', apiKey: 'k', baseUrl: `http://127.0.0.1:${(srv.address() as any).port}` }, { retry: false });
    const ask = async () => { try { await a.complete({ systemPrompt: 's', userContent: 'u', schema: {}, schemaName: 't', maxOutputTokens: 5 }); return null; } catch (x) { return x as any; } };
    e = await ask(); assert.deepEqual([e.kind, e.code, e.status], ['bad_request', 'invalid_request_error', 400]); noLeak(e.message, 'Anthropic 400');
    e = await ask(); assert.deepEqual([e.kind, e.contentFiltered], ['refusal', true]); noLeak(e.message, 'Anthropic 拒答说明');
    e = await ask(); assert.deepEqual([e.kind, e.retryAfterSec], ['rate_limited', 3]); noLeak(e.message, 'Anthropic 429');
    e = await ask(); assert.deepEqual([e.kind, e.retryAfterSec], ['rate_limited', 4], '没有响应头时从正文取等待秒数'); noLeak(e.message, 'Anthropic 429 正文');
    srv.close();

    // Schema 与 registry
    const errs = validate({ decision: `坏值${MARK}`, [`extra_${MARK}`]: 1 }, { type: 'object', additionalProperties: false, properties: { decision: { type: 'string', enum: ['a', 'b'] } } });
    assert.equal(errs.length, 2); noLeak(errs.join('\n'), 'Schema 错误');
    let re: any; try { await createProvider({ provider: `x${MARK}` as any, model: 'm' }); } catch (x) { re = x; }
    noLeak(re.message, '未知供应商');
    ok('源头：HTTP 错误、非白名单码、坏 JSON、字符串计数、各家拒答、网络错误、Schema、未知供应商都不带上游内容；白名单码与 Retry-After 正确');
  }

  // ================= A2 出口 =================
  {
    assert.equal(err.errorText(new ProviderError('server', 'HTTP 502', 502)), 'server HTTP 502：HTTP 502');
    assert.equal(err.errorText(new Error(`包装的 ${MARK}`)), 'Error');
    assert.equal(err.errorText(new SyntaxError(`Unexpected token in JSON at "${MARK}"`)), 'SyntaxError');
    const wrapped: any = new Error(MARK); wrapped.name = `Weird${MARK}`; assert.equal(err.errorText(wrapped), 'Error', '名单外类名');
    assert.equal(err.errorText(new err.PublicError('搜索 HTTP 500')), '搜索 HTTP 500');
    assert.equal(err.errorText(err.markPublic(new Error('Bearer abc.def sk-1234567890abcdef'))), 'Bearer *** sk-***', '固定文案也做密钥脱敏');
    ok('出口 errorText：未知错误只留类名，固定文案原样，密钥脱敏');
  }

  // ================= Telegram 落库不带上游内容 =================
  const tg = readyTelegramDb(join(dir, 'tg.sqlite3'));
  const at = '2026-11-01T00:00:00.000Z';
  const addSource = (title: string, chat: number, enabled = 1) => {
    const id = Number(tg.prepare(`INSERT INTO telegram_sources(reference,source_type,chat_id,title,status,enabled,validation_requested_at,created_at,updated_at)
      VALUES(?,'normal',?,?,'active',?,?,?,?)`).run(`@s${chat}`, chat, title, enabled, at, at, at).lastInsertRowid);
    tg.prepare('INSERT INTO telegram_sync_state(source_id) VALUES(?)').run(id);
    return id;
  };
  const leaky = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => { throw new Error(`upstream said ${MARK}`); } } as any;
  {
    const src = addSource('甲群', -1001);
    tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src, -1001, 1, '2026-11-01T01:00:00.000Z', '消息', 'h', at);
    const job = Number(tg.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
      VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src, at, '2026-11-01T02:00:00.000Z', at, at).lastInsertRowid);
    const logs: string[] = []; const orig = console.error; console.error = (...x: any[]) => { logs.push(x.join(' ')); };
    try { await summarizeJob(tg, job, { provider: 'mock', model: 'm', promptRules: '', promptVersion: 1, summaryRetentionDays: 30 }, leaky); }
    finally { console.error = orig; }
    noLeak((tg.prepare('SELECT error FROM telegram_summary_jobs WHERE id=?').get(job) as any).error, '单群总结错误');
    noLeak(logs.join('\n'), '单群总结日志');
    ok('Telegram 单群总结失败：库与日志都只有错误类型');
  }

  // ================= B1 要点结尾说明 =================
  {
    const W0 = '2026-11-02T00:00:00.000Z', W = '2026-11-02T12:00:00.000Z';
    const a = addSource('A群', -2001), b = addSource('B群', -2002), off = addSource('停用群', -2003, 0);
    const summary = (topic: string) => JSON.stringify({ topics: [topic], important: [`${topic} 细节`], viewpoints: [], sources: [], uncertainty: [] });
    for (const [id, chat, topic] of [[a, -2001, 'A 话题'], [b, -2002, 'B 话题'], [off, -2003, '停用群话题']] as const) {
      const j = tg.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
        VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(id, W0, W, W, W);
      tg.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(j.lastInsertRowid, id, W0, W, 't', summary(topic), '', W, '2099-01-01T00:00:00.000Z');
      tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(id, chat, 100, '2026-11-02T03:00:00.000Z', topic, 'h', W);
    }
    // A 群覆盖水位已越过窗口，B 群落后，甲群（上面的）没有覆盖记录
    tg.prepare(`INSERT INTO telegram_sync_progress(source_id,covered_until) VALUES(?,?)`).run(a, '2026-11-02T13:00:00.000Z');
    tg.prepare(`INSERT INTO telegram_sync_progress(source_id,covered_until) VALUES(?,?)`).run(b, '2026-11-02T06:00:00.000Z');
    const cfg = { provider: 'mock' as const, model: 'm', summaryRetentionDays: 36500 };
    let extract = 0;
    const p = { name: 'mock', model: 'm', strictness: 'strict', complete: async (req: any) => {
      const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 };
      if (req.schemaName === 'tg_extract') {
        extract++;
        if (/群：B群/.test(req.userContent)) throw err.refusalError();
        return { data: { points: [{ category: '其他', text: 'A 话题 的要点' }] }, rawText: '', responseId: 'r', model: 'm', usage };
      }
      const list = JSON.parse(req.userContent.slice(req.userContent.indexOf('\n\n') + 2));
      return { data: { items: list }, rawText: '', responseId: 'r', model: 'm', usage };
    } } as any;
    await buildDigest(tg, W, cfg, p, new Date('2026-11-02T13:00:00Z'));
    const row = tg.prepare('SELECT * FROM telegram_digests WHERE window_end=?').get(W) as any;
    const d = JSON.parse(row.summary_json);
    assert.equal(row.status, 'completed');
    assert.deepEqual(d.notes, ['本期以下群组未正常汇总：甲群（消息采集未完成，可能缺少部分消息）；B群（内容被模型过滤、消息采集未完成，可能缺少部分消息）']);
    assert.ok(!JSON.stringify(d).includes('停用群'), '停用群不在范围内');
    assert.ok(row.rendered_html.endsWith('消息采集未完成，可能缺少部分消息）</small></p>'), '说明在最后');
    ok('B1：覆盖水位缺失 / 落后记为采集未完成；拒答记为被过滤；同一群多个原因合并；停用群不计；说明在最后');

    // 全部群都被拒答：直接带说明完成，不进入 3 次重试
    const W2 = '2026-11-03T12:00:00.000Z';
    for (const [id, chat] of [[a, -2001], [b, -2002]] as const) {
      const j = tg.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
        VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(id, '2026-11-03T00:00:00.000Z', W2, W2, W2);
      tg.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(j.lastInsertRowid, id, '2026-11-03T00:00:00.000Z', W2, 't', summary('x'), '', W2, '2099-01-01T00:00:00.000Z');
      tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(id, chat, 200, '2026-11-03T03:00:00.000Z', 'x', 'h', W2);
    }
    tg.prepare(`UPDATE telegram_sync_progress SET covered_until=?`).run('2026-11-04T00:00:00.000Z');
    const refuseAll = { ...p, complete: async () => { throw err.refusalError(); } };
    await buildDigest(tg, W2, cfg, refuseAll, new Date('2026-11-03T13:00:00Z'));
    const r2 = tg.prepare('SELECT status, attempts, fallback, summary_json FROM telegram_digests WHERE window_end=?').get(W2) as any;
    assert.deepEqual([r2.status, r2.attempts, r2.fallback], ['completed', 1, 0], '全部被拒答直接完成');
    assert.match(JSON.parse(r2.summary_json).notes[0], /A群（内容被模型过滤）；B群（内容被模型过滤）/);

    // 全部失败（非过滤）3 次后兜底：兜底只用参与生成的群，原因是生成失败
    const W3 = '2026-11-04T12:00:00.000Z';
    for (const [id, chat] of [[a, -2001], [off, -2003]] as const) {
      const j = tg.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
        VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(id, '2026-11-04T00:00:00.000Z', W3, W3, W3);
      tg.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(j.lastInsertRowid, id, '2026-11-04T00:00:00.000Z', W3, 't', summary(id === off ? '停用群话题' : 'A 话题'), '', W3, '2099-01-01T00:00:00.000Z');
      tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(id, chat, 300, '2026-11-04T03:00:00.000Z', 'y', 'h', W3);
    }
    tg.prepare(`UPDATE telegram_sync_progress SET covered_until=?`).run('2026-11-05T00:00:00.000Z');
    for (let i = 0; i < 3; i++) await buildDigest(tg, W3, cfg, leaky, new Date('2026-11-04T13:00:00Z'));
    const r3 = tg.prepare('SELECT status, fallback, summary_json, error FROM telegram_digests WHERE window_end=?').get(W3) as any;
    const d3 = JSON.parse(r3.summary_json);
    assert.deepEqual([r3.status, r3.fallback], ['completed', 1]); noLeak(r3.error, '要点失败原因');
    assert.ok(!JSON.stringify(d3).includes('停用群'), '兜底不含停用群的旧总结');
    assert.ok(d3.notes.at(-1).includes('A群（生成失败）') && d3.notes[0].startsWith('AI 汇总失败'));
    ok('B1：全部被拒答直接完成不重试；全部失败 3 次后兜底只用参与生成的群、原因准确、错误不带上游内容');
  }

  // ================= B2 失败图片保留 =================
  {
    const mediaDir = join(dir, 'media'); mkdirSync(mediaDir, { recursive: true });
    const src = addSource('图群', -3001);
    let mid = 1000;
    const media = (bytes = 3) => {
      const id = ++mid; const path = join(mediaDir, `f${id}`);
      tg.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`).run(src, -3001, id, at, '', `h${id}`, at);
      writeFileSync(path, Buffer.alloc(bytes, 1));
      const t = tg.prepare(`INSERT INTO telegram_media_tasks(source_id,chat_id,message_id,media_fingerprint,mime_type,original_caption,temp_path,temp_state,actual_size_bytes,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(src, -3001, id, `fp${id}`, 'image/png', '', path, 'ready', bytes, 'pending', at, at);
      return { id: Number(t.lastInsertRowid), path };
    };
    const row = (id: number) => tg.prepare('SELECT * FROM telegram_media_tasks WHERE id=?').get(id) as any;
    const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 };
    const good = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => ({ data: { description: 'd', key_text: '', uncertainty: '' }, usage, responseId: 'r', model: 'm' }) } as any;
    const reject = { ...good, complete: async () => { throw toError(404, JSON.stringify({ error: { code: 'model_not_found', message: MARK } })); } };
    const flaky = { ...good, complete: async () => { throw new ProviderError('server', 'HTTP 502', 502); } };
    let clock = new Date('2026-11-05T00:00:00Z');
    const run = (p: any, extra: any = {}) => vision.runOneVisionTask(tg, { provider: p, mediaDir, fingerprint: 'F1', now: () => clock, ...extra });

    // 不可重试错误 → 保留，不删文件
    const m1 = media();
    assert.equal(await run(reject), 'failed');
    let r = row(m1.id);
    assert.deepEqual([r.status, r.temp_state, !!r.held_until, r.held_fingerprint, existsSync(m1.path)], ['failed', 'ready', true, 'F1', true]);
    noLeak(r.error_message, '图片识别错误');
    assert.equal(Date.parse(r.held_until) - clock.getTime(), 7 * 86400_000); assert.equal(Date.parse(r.held_next_at) - clock.getTime(), 12 * 3600_000);
    // 12 小时内不放回；到时间放回并只请求一次，再失败回到保留（held_until 不顺延）
    clock = new Date(clock.getTime() + 11 * 3600_000);
    assert.equal(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F1' }).released, 0);
    clock = new Date(clock.getTime() + 2 * 3600_000);
    assert.equal(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F1' }).released, 1);
    assert.equal(await run(flaky), 'failed', '保留中的重试即使临时故障也直接回到保留');
    r = row(m1.id); assert.equal(r.status, 'failed'); assert.equal(r.held_until, '2026-11-12T00:00:00.000Z', 'held_until 不顺延');
    // 配置指纹变化：立即放回；成功后完成并删除文件
    assert.equal(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F2' }).released, 1, '换配置立即放回');
    assert.equal(await run(good, { fingerprint: 'F2' }), 'done');
    r = row(m1.id); assert.deepEqual([r.status, r.temp_state, existsSync(m1.path)], ['completed', 'deleted', false]);
    ok('B2：不可重试错误进入保留不删文件；12 小时放回；保留中再失败回到保留且期限不顺延；换配置立即放回；成功后才删');

    // 首次生命周期：临时故障按 RETRY_MINUTES，用完进入保留
    const m2 = media();
    for (let i = 0; i < 4; i++) {
      tg.prepare(`UPDATE telegram_media_tasks SET next_attempt_at=? WHERE id=? AND status='retry'`).run(clock.toISOString(), m2.id);
      await run(flaky);
    }
    r = row(m2.id); assert.deepEqual([r.status, !!r.held_until, existsSync(m2.path)], ['failed', true, true], '临时故障用完重试后进入保留，不删');
    // 7 天到期删除
    clock = new Date(Date.parse(r.held_until) + 1000);
    assert.ok(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F2' }).expired >= 1);
    r = row(m2.id); assert.deepEqual([r.temp_state, existsSync(m2.path)], ['deleted', false]);
    ok('B2：首次临时故障按退避重试，用完进入保留；7 天到期删除');

    // 图片本身无效：直接终态删除；ENOENT：终态
    const m3 = media(0);
    await run(good);
    r = row(m3.id); assert.deepEqual([r.status, r.temp_state, existsSync(m3.path)], ['failed', 'deleted', false]);
    ok('B2：图片本身无效直接删除');

    // 租约：另一个进程持有时返回 busy；旧进程恢复后无法覆盖新进程的任务
    const owner = vision.acquireVisionLease(tg, clock)!;
    assert.ok(owner); assert.equal(await run(good), 'busy');
    assert.equal(vision.acquireVisionLease(tg, clock), null);
    vision.releaseVisionLease(tg, 'someone-else');
    assert.equal(vision.acquireVisionLease(tg, clock), null, '别人不能释放我的租约');
    vision.releaseVisionLease(tg, owner);
    const m4 = media();
    let release!: () => void;
    const slow = { ...good, complete: () => new Promise(res => { release = () => res({ data: { description: 'old', key_text: '', uncertainty: '' }, usage, responseId: 'r', model: 'm' }); }) };
    const oldRun = run(slow);
    await new Promise(res => setTimeout(res, 20));
    // 旧进程卡住超过租约：新进程取得租约，恢复「遗留的 running」并重新处理
    clock = new Date(clock.getTime() + 200_000);
    const newOwner = vision.acquireVisionLease(tg, clock)!;
    assert.ok(newOwner, '租约过期后新进程可以取得');
    vision.recoverVisionFiles(tg, mediaDir, clock);
    assert.equal(row(m4.id).status, 'retry', '遗留 running 走正常失败处理');
    tg.prepare(`UPDATE telegram_media_tasks SET next_attempt_at=? WHERE id=?`).run(clock.toISOString(), m4.id);
    assert.equal(await vision.runOneVisionTask(tg, { provider: good, mediaDir, owner: newOwner, now: () => clock }), 'done');
    release(); await oldRun;
    r = row(m4.id); assert.equal(r.description, 'd', '旧进程迟到的结果不覆盖新进程');
    vision.releaseVisionLease(tg, newOwner);
    // 第 5 轮审查：租约过期后的旧 owner 不能再领取，也不能恢复现任进程的任务
    const cur = vision.acquireVisionLease(tg, clock)!;
    const m4b = media();
    assert.equal(await vision.runOneVisionTask(tg, { provider: good, mediaDir, owner: newOwner, now: () => clock }), 'idle', '失效的 owner 不领取');
    assert.equal(row(m4b.id).status, 'pending');
    tg.prepare(`UPDATE telegram_media_tasks SET status='running', claim_token=? WHERE id=?`).run(cur, m4b.id);
    assert.equal(vision.recoverVisionFiles(tg, mediaDir, clock, { owner: newOwner }), 0);
    assert.equal(row(m4b.id).status, 'running', '失效的 owner 不恢复现任进程的任务');
    tg.prepare(`UPDATE telegram_media_tasks SET status='pending', claim_token=NULL WHERE id=?`).run(m4b.id);
    vision.releaseVisionLease(tg, cur);
    ok('B2：租约互斥、只能释放自己的租约；旧进程恢复后无法覆盖新进程的任务；失效的 owner 不领取、不恢复；遗留 running 走正常失败处理');

    // 第 5 轮审查：换配置后放回的保留图片被杀，恢复时用本次请求的指纹，不会被立即再次放回
    const m7 = media();
    tg.prepare(`UPDATE telegram_media_tasks SET status='failed', held_until=?, held_next_at=?, held_fingerprint='F1', attempts=3 WHERE id=?`)
      .run(new Date(clock.getTime() + 5 * 86400_000).toISOString(), new Date(clock.getTime() + 3600_000).toISOString(), m7.id);
    tg.prepare(`UPDATE telegram_media_tasks SET status='completed', temp_state='deleted' WHERE id<>? AND status IN ('pending','retry')`).run(m7.id);
    assert.equal(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F3' }).released, 1);
    const hang = { ...good, complete: () => new Promise(() => {}) };
    void run(hang, { fingerprint: 'F3' });
    await new Promise(res => setTimeout(res, 20));
    assert.equal(row(m7.id).held_fingerprint, 'F3', '派发前记下本次请求的指纹');
    clock = new Date(clock.getTime() + 200_000);
    const o7 = vision.acquireVisionLease(tg, clock)!;
    vision.recoverVisionFiles(tg, mediaDir, clock, { owner: o7, fingerprint: 'F3' });
    r = row(m7.id); assert.deepEqual([r.status, r.held_fingerprint], ['failed', 'F3']);
    assert.equal(vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F3' }).released, 0, '被杀后遵守 12 小时等待');
    vision.releaseVisionLease(tg, o7);
    ok('B2：被杀的保留任务按本次请求的指纹恢复，不会被立即再次放回');

    // 核对轮：领取后、派发前失租 → 保持 running 交给有效 owner 恢复，不会被漏掉（也不发请求）
    const m8 = media();
    tg.prepare(`UPDATE telegram_media_tasks SET status='completed', temp_state='deleted' WHERE id<>? AND status IN ('pending','retry')`).run(m8.id);
    let calls8 = 0; const counting = { ...good, complete: async () => { calls8++; return good.complete(); } };
    const base8 = clock.getTime(); let tick = 0;
    // 前三次读时钟（取得租约、本轮开始、领取时续租）不跳；之后（派发前续租）跳过 150 秒，模拟领取后卡住
    const jumpy = () => new Date(base8 + (tick++ < 3 ? 0 : 400_000));
    assert.equal(await vision.runOneVisionTask(tg, { provider: counting, mediaDir, now: jumpy }), 'idle');
    assert.equal(calls8, 0, '失租后不发请求');
    r = row(m8.id); assert.equal(r.status, 'running', '失租时不改成没有重试信息的 failed');
    clock = new Date(base8 + 400_000);
    const o8 = vision.acquireVisionLease(tg, clock)!;
    vision.recoverVisionFiles(tg, mediaDir, clock, { owner: o8, fingerprint: 'F3' });
    assert.equal(row(m8.id).status, 'retry', '有效 owner 按遗留任务恢复');
    vision.releaseVisionLease(tg, o8);
    ok('B2：派发前失租不发请求、不漏任务，由有效租约的进程恢复');

    // 条件回写：识别期间被采集器标为失效 → 不覆盖、不删文件
    const m5 = media();
    const superseding = { ...good, complete: async () => {
      tg.prepare(`UPDATE telegram_media_tasks SET superseded_at=?,status='skipped',temp_path=NULL,temp_state='deleted' WHERE id=?`).run(at, m5.id);
      return { data: { description: 'd', key_text: '', uncertainty: '' }, usage, responseId: 'r', model: 'm' };
    } };
    await run(superseding);
    assert.equal(row(m5.id).status, 'skipped', '采集器写的新状态不被覆盖');
    ok('B2：识别期间被采集器标为失效时不覆盖其状态');

    // 目录硬上限：先删保留中最早的，再删最早的待识别
    const big1 = media(600), big2 = media(600), big3 = media(600);
    tg.prepare(`UPDATE telegram_media_tasks SET status='failed', held_until=?, held_next_at=? WHERE id=?`).run('2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', big1.id);
    const res = vision.maintainHeldMedia(tg, { mediaDir, now: clock, fingerprint: 'F2', capBytes: 1000 });
    assert.ok(res.evicted >= 2);
    assert.equal(row(big1.id).error_type, 'disk_full'); assert.equal(row(big2.id).status, 'skipped');
    assert.equal(row(big3.id).status, 'pending', '降到上限以下就停止');
    assert.ok((tg.prepare('SELECT vision_disk_evicted n FROM telegram_settings').get() as any).n >= 2);
    // 删除失败（目录只读）时不扣减用量：继续往下处理，而不是删了一个就以为降到上限以下
    const roDir = join(dir, 'media-ro'); mkdirSync(roDir);
    const ro = [1, 2].map(() => { const x = media(600); const p2 = join(roDir, `r${x.id}`); writeFileSync(p2, Buffer.alloc(600, 1));
      tg.prepare('UPDATE telegram_media_tasks SET temp_path=? WHERE id=?').run(p2, x.id); return x.id; });
    const { chmodSync } = await import('node:fs');
    chmodSync(roDir, 0o555);
    try { vision.maintainHeldMedia(tg, { mediaDir: roDir, now: clock, fingerprint: 'F2', capBytes: 1000 }); }
    finally { chmodSync(roDir, 0o755); }
    assert.ok(ro.every(id => row(id).error_type === 'disk_full'), '删除失败时继续处理下一张');
    ok('B2：目录硬上限按实际文件统计，先删保留中最早的，再把最早的待识别标为 disk_full；删除失败不误扣用量');

    // 消息清理不删有保留中图片的消息
    const m6 = media();
    tg.prepare(`UPDATE telegram_media_tasks SET status='failed', held_until='2099-01-01T00:00:00.000Z' WHERE id=?`).run(m6.id);
    tg.prepare(`UPDATE telegram_settings SET keep_messages_forever=0, raw_retention_days=1`).run();
    cleanupTelegram(tg, new Date('2026-12-01T00:00:00Z'));
    assert.ok(row(m6.id), '保留中图片的任务没有被级联删除');
    ok('B2：消息清理跳过有保留中图片的消息');
    void readdirSync;
  }

  // ================= fact-trace SSRF（docs/ssrf-redirect-design.md：统一走 safeHttp） =================
  {
    const https = (await import('node:https')).default;
    const { makeCert, serve, cleanupCert } = await import('./helpers/https-server.ts');
    const cert = makeCert(['news.example.com', 'news2.example.com', 'evil.internal', 'www.bing.com', 'slow.example.com']);
    const srv = await serve(cert, (req, res, host) => {
      if (host === 'news.example.com') { res.writeHead(302, { location: 'https://evil.internal/admin' }); return res.end(); }
      if (host === 'news2.example.com' || req.url?.startsWith('/search') && host === 'www.bing.com' && process.env.__LOOP === '1') { res.writeHead(302, { location: 'https://news2.example.com/x' }); return res.end(); }
      if (host === 'www.bing.com' && process.env.__STALL === '1') { res.writeHead(200); res.write('<rss>'); return; }
      if (host === 'www.bing.com') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end('<rss><channel></channel></rss>'); }
      res.writeHead(200); res.end('evil');
    });
    const inject = (timeoutMs = 3000, check?: any) => ({
      check: check ?? (async (u: string) => { const h = new URL(u).hostname; return h === 'evil.internal' ? { ok: false as const, reason: '内网', kind: 'blocked' as const } : { ok: true as const, url: new URL(u).href, addresses: ['127.0.0.1'] }; }),
      request: ((u: any, o: any, cb: any) => https.request(u, { ...o, port: srv.port }, cb)) as any, tlsOptions: { ca: cert.cert }, timeoutMs });
    try {
      const out = await traceFacts('标题', 'https://news.example.com/a', inject());
      assert.ok(!srv.requests.some(x => x.host === 'evil.internal'), '重定向到内网的地址不会被请求');
      assert.equal(out.origin?.reachable, false);
      process.env.__LOOP = '1';
      const out2 = await traceFacts('标题', null, inject());
      delete process.env.__LOOP;
      assert.match(String(out2.error), /重定向无效/);
      // 响应头已到、正文停滞 → 截止时间仍然生效
      process.env.__STALL = '1';
      const t0 = Date.now();
      const out3 = await traceFacts('标题', null, inject(200));
      delete process.env.__STALL;
      assert.ok(Date.now() - t0 < 2000, '不会无限等待'); assert.match(String(out3.error), /请求超时/);
      // 原文链接的首次安全校验停滞也受截止时间约束
      const t1 = Date.now();
      const out4 = await traceFacts('标题', 'https://slow.example.com/a', inject(200, () => new Promise(() => {})));
      assert.ok(Date.now() - t1 < 2000, '首次安全校验停滞也不会无限等待'); assert.equal(out4.origin?.reachable, false);
      ok('fact-trace：逐跳校验重定向（指向内网的不请求），超过跳数上限报错；正文停滞、首次安全校验停滞都受截止时间约束');
    } finally { await srv.close(); cleanupCert(cert); }
  }

  // ================= A3 清理脚本 =================
  {
    const { openDb, migrate } = await import('../packages/db/src/index.ts');
    const briefPath = join(dir, 'brief.db');
    const b = openDb(briefPath); migrate(b, 'migrations');
    b.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger,error) VALUES ('k','l',?,?,?,'failed','timer',?)`).run(at, at, at, `bad_request: HTTP 400 ${MARK}`);
    b.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('x','1','ai_manual_audit',?,?)`).run(JSON.stringify({ error: `network: ${MARK}`, keep: 'yes' }), at);
    b.close();
    tg.prepare(`UPDATE telegram_digests SET error=? WHERE window_end='2026-11-02T12:00:00.000Z'`).run(`server HTTP 503 ${MARK}`);
    tg.prepare(`UPDATE telegram_media_tasks SET error_message=?, error_type='download_error' WHERE id=(SELECT min(id) FROM telegram_media_tasks)`).run(`采集器下载错误 ${MARK}`);
    const env = { ...process.env, DATABASE_PATH: briefPath, TELEGRAM_DATABASE_PATH: join(dir, 'tg.sqlite3'), SCRUB_BACKUP_DIR: join(dir, 'scrub-bak') };
    const dry = spawnSync(process.execPath, ['scripts/scrub-error-text.mjs'], { encoding: 'utf8', env });
    assert.equal(dry.status, 0, dry.stderr); noLeak(dry.stdout, 'dry-run 输出'); assert.match(dry.stdout, /dry-run/);
    assert.ok(!existsSync(join(dir, 'scrub-bak')), 'dry-run 不备份不写');
    const apply = spawnSync(process.execPath, ['scripts/scrub-error-text.mjs', '--apply'], { encoding: 'utf8', env });
    assert.equal(apply.status, 0, apply.stderr); noLeak(apply.stdout, '清理输出');
    assert.equal(readdirSync(join(dir, 'scrub-bak')).length, 1, '两个库都已备份到本次执行的新目录');
    const b2 = openDb(briefPath);
    assert.equal((b2.prepare(`SELECT error FROM runs`).get() as any).error, '[已清理] bad_request HTTP 400');
    const pl = JSON.parse((b2.prepare(`SELECT payload_json FROM audit_events WHERE action='ai_manual_audit'`).get() as any).payload_json);
    assert.deepEqual(pl, { error: '[已清理] network', keep: 'yes' }, 'JSON 只改 error 键');
    b2.close();
    assert.equal((tg.prepare(`SELECT error FROM telegram_digests WHERE window_end='2026-11-02T12:00:00.000Z'`).get() as any).error, '[已清理] server HTTP 503');
    assert.ok(String((tg.prepare(`SELECT error_message FROM telegram_media_tasks WHERE error_type='download_error'`).get() as any).error_message).includes(MARK), '采集器下载错误不动');
    const again = spawnSync(process.execPath, ['scripts/scrub-error-text.mjs', '--apply'], { encoding: 'utf8', env: { ...env, SCRUB_BACKUP_DIR: join(dir, 'scrub-bak2') } });
    assert.ok(again.stdout.split('\n').filter(l => l.startsWith('已改写')).every(l => /已改写\s+0 /.test(l)), '第二次 0 行：' + again.stdout);
    // 第 5 轮审查：同一个备份父目录重复 --apply 不覆盖首次的原始备份
    const again2 = spawnSync(process.execPath, ['scripts/scrub-error-text.mjs', '--apply'], { encoding: 'utf8', env });
    assert.equal(again2.status, 0, again2.stderr);
    const runs = readdirSync(join(dir, 'scrub-bak'));
    assert.equal(runs.length, 2, '每次执行一个新目录');
    const firstDir = join(dir, 'scrub-bak', runs.sort()[0]!);
    assert.deepEqual(readdirSync(firstDir).filter(f => f.endsWith('.bak')).sort(), ['brief.sqlite3.bak', 'telegram.sqlite3.bak'], '两个库文件名不碰撞');
    const orig = new (await import('better-sqlite3')).default(join(firstDir, 'brief.sqlite3.bak'), { readonly: true });
    assert.ok(String((orig.prepare('SELECT error FROM runs').get() as any).error).includes(MARK), '首次备份保留清理前的原始数据');
    orig.close();
    const bad = spawnSync(process.execPath, ['scripts/scrub-error-text.mjs'], { encoding: 'utf8', env: { ...env, DATABASE_PATH: join(dir, 'nope.db') } });
    assert.notEqual(bad.status, 0); assert.ok(!existsSync(join(dir, 'nope.db')), '路径不存在时拒绝且不新建');
    ok('A3 清理脚本：dry-run 不写；先备份再改写；JSON 只改 error 键；采集器错误不动；第二次 0 行；输出不含原值；路径不存在拒绝');
  }
  tg.close();
  console.log('\n✅ 全部通过');
} finally { rmSync(dir, { recursive: true, force: true }); }
