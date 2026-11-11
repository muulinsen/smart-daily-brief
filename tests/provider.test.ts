// 供应商适配层 + Schema 校验 + 故障路径（PRD 15.3 / FR-044 / 23.2）
import { createProvider, providerFromEnv } from '../packages/ai/src/registry.ts';
import { TRIAGE_SCHEMA, validate } from '../packages/ai/src/schema.ts';
import { toGeminiSchema } from '../packages/ai/src/providers/gemini.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import { parseJsonResponse } from '../packages/ai/src/providers/openai-compat.ts';
import { OpenAICompatProvider } from '../packages/ai/src/providers/openai-compat.ts';
import type { Fault } from '../packages/ai/src/providers/mock.ts';

let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const payload = JSON.stringify({
  candidates: [
    { candidate_id: 'v1', rule_prescreen: { mandatory_classes: ['A'] } },
    { candidate_id: 'v2', rule_prescreen: { mandatory_classes: [] } },
  ],
});
const req = {
  systemPrompt: '你是信息筛选器。', userContent: payload,
  schema: TRIAGE_SCHEMA, schemaName: 'triage', maxOutputTokens: 200, cachePrefix: true,
};

const mock = async (fault: Fault, faultOnCall = 1) =>
  createProvider({ provider: 'mock', model: 'mock-1', fault, faultOnCall } as any);

console.log('正常路径：\n');
{
  const p = await mock('none');
  const r = await p.complete(req);
  const errs = validate(r.data, TRIAGE_SCHEMA);
  ok('响应通过 Schema 校验', errs.length === 0, errs.join('; '));
  const res = (r.data as any).results;
  ok('强制保留候选判为 retain', res[0].decision === 'retain' && res[0].mandatory_class === 'A');
  ok('普通候选判为 normal', res[1].decision === 'normal');
  ok('用量已归一化', r.usage.inputTokens > 0 && r.usage.outputTokens > 0,
     `in=${r.usage.inputTokens} out=${r.usage.outputTokens} cached=${r.usage.cachedInputTokens}`);
  ok('缓存前缀被计入 cachedInputTokens', r.usage.cachedInputTokens > 0);
  ok('保留 responseId 供审计追溯', !!r.responseId);
}

console.log('\n故障路径（真实 API 无法按需复现的那些）：\n');
{
  const p = await mock('schema_violation');
  const r = await p.complete(req);
  const errs = validate(r.data, TRIAGE_SCHEMA);
  ok('枚举非法 + 类型错误被 Schema 校验拦下', errs.length >= 2, errs.slice(0, 2).join(' | '));
}
{
  // FR-044：第一次失败、第二次成功 → 重试一次即可恢复
  const p = await mock('schema_violation', 1);
  const bad = validate((await p.complete(req)).data, TRIAGE_SCHEMA);
  const good = validate((await p.complete(req)).data, TRIAGE_SCHEMA);
  ok('重试一次后恢复（FR-044）', bad.length > 0 && good.length === 0);
}
for (const [f, kind, retryable] of [
  ['rate_limited', 'rate_limited', true],
  ['timeout', 'timeout', true],
  ['server_error', 'server', true],
  ['refusal', 'refusal', false],
  ['invalid_json', 'bad_request', false],
] as const) {
  const p = await mock(f);
  let e: unknown;
  try { await p.complete(req); } catch (err) { e = err; }
  const pe = e as ProviderError;
  ok(`${f} → ${kind}，retryable=${retryable}`,
     pe instanceof ProviderError && pe.kind === kind && pe.retryable === retryable);
}
{
  // ESC-005：强制保留预判命中但模型判为过滤 —— 必须能被上层发现
  const p = await mock('wrong_filter');
  const res = (await p.complete(req) as any).data.results;
  const v1 = res.find((x: any) => x.candidate_id === 'v1');
  ok('ESC-005 场景可复现（强制保留项被误判为过滤）',
     v1.decision === 'filter', `filter_reason="${v1.filter_reason}"`);
}
{
  const p = await mock('truncated');
  const r = await p.complete(req);
  ok('截断可通过 stopReason 识别', r.stopReason === 'max_tokens');
}

console.log('\n多供应商装配：\n');

{
  const originalFetch=globalThis.fetch;let sent:any;
  globalThis.fetch=async(_url:any,init:any)=>{sent=JSON.parse(String(init.body));return new Response(JSON.stringify({
    id:'vision-1',model:'gemini-3.8-flash',choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2},
  }),{status:200,headers:{'content-type':'application/json'}})};
  try {
    const p=new OpenAICompatProvider({provider:'openai_compatible',model:'gemini-3.8-flash-high',apiKey:'k',baseUrl:'https://example.test/v1'});
    await p.complete({...req,userContent:'analyse',images:[{mimeType:'image/png',data:'AQI='}]});
    ok('多模态图片使用 OpenAI Compatible image_url Data URL',
      Array.isArray(sent.messages[1].content)&&sent.messages[1].content[1].image_url.url==='data:image/png;base64,AQI=');
  } finally { globalThis.fetch=originalFetch; }
}

{
  // 上游内容过滤：HTTP 200 + choices 为空 → 带 contentFiltered 标记；有内容的空文本仍是普通 bad_request
  const originalFetch=globalThis.fetch;
  const p=new OpenAICompatProvider({provider:'openai_compatible',model:'m',apiKey:'k',baseUrl:'https://example.test/v1'});
  const respond=(body:any)=>{globalThis.fetch=async()=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})};
  try {
    respond({id:'x',choices:[],usage:{prompt_tokens:10,completion_tokens:0}});
    let e1:any; try { await p.complete(req) } catch (e) { e1=e }
    ok('空 choices → contentFiltered 且不可重试', e1 instanceof ProviderError && e1.contentFiltered===true && e1.retryable===false && e1.kind==='bad_request');
    respond({id:'x',choices:[{message:{content:''},finish_reason:'content_filter'}],usage:{prompt_tokens:10,completion_tokens:0}});
    let e2:any; try { await p.complete(req) } catch (e) { e2=e }
    ok('finish_reason=content_filter → contentFiltered', e2?.contentFiltered===true);
    respond({id:'x',choices:[{message:{content:''},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:0}});
    let e3:any; try { await p.complete(req) } catch (e) { e3=e }
    ok('有 choice 但正文为空仍按原错误处理（非过滤）', e3 instanceof ProviderError && !e3.contentFiltered && /响应体为空/.test(e3.message));
  } finally { globalThis.fetch=originalFetch; }
}

{
  const value = { results: [{ candidate_id: 'c1', decision: 'normal', note: '含 } 与 ] 字符' }] };
  const raw = JSON.stringify(value);
  ok('OpenAI 兼容响应接受纯 JSON', JSON.stringify(parseJsonResponse(raw)) === raw);
  ok('OpenAI 兼容响应剥离 Markdown JSON 围栏',
    JSON.stringify(parseJsonResponse(`\`\`\`json\n${raw}\n\`\`\``)) === raw);
  ok('OpenAI 兼容响应可忽略前后说明文字',
    JSON.stringify(parseJsonResponse(`结果如下：\n${raw}\n以上。`)) === raw);
  let bad: unknown;
  try { parseJsonResponse('没有结构化输出'); } catch (e) { bad = e; }
  ok('无合法 JSON 时仍会报错', bad instanceof SyntaxError);
}

{
  for (const [prov, expectStrict] of [
    ['openai', 'strict'], ['openai_compatible', 'json'], ['deepseek', 'json'], ['qwen', 'json'],
  ] as const) {
    const p = await createProvider({ provider: prov, model: 'm', apiKey: 'k',
      baseUrl: prov === 'openai_compatible' ? 'https://example.com/v1' : undefined });
    ok(`${prov} 装配成功，strictness=${p.strictness}`, p.strictness === expectStrict);
  }
  const a = await createProvider({ provider: 'anthropic', model: 'claude-opus-5' });
  ok('anthropic 装配成功（SDK 懒加载，此处不触发网络）', a.strictness === 'strict');
  const g = await createProvider({ provider: 'gemini', model: 'g', apiKey: 'k' });
  ok('gemini 装配成功', g.name === 'gemini');

  let e: unknown;
  try { await createProvider({ provider: 'openai', model: 'm' }); } catch (err) { e = err; }
  ok('缺 API key 时明确报错而非静默失败', (e as ProviderError)?.kind === 'auth');
  e = undefined;
  try { await createProvider({ provider: 'openai_compatible', model: 'm', apiKey: 'k' }); } catch (err) { e = err; }
  ok('OpenAI 兼容格式缺 Base URL 时明确报错', (e as ProviderError)?.kind === 'bad_request');
}

console.log('\nGemini Schema 裁剪（responseSchema 只接受 OpenAPI 子集）：\n');
{
  const g = toGeminiSchema(TRIAGE_SCHEMA) as any;
  const s = JSON.stringify(g);
  ok('additionalProperties 已剔除', !s.includes('additionalProperties'));
  ok('enum 与 required 保留', s.includes('enum') && s.includes('required'));
  ok('结构未被破坏', g.properties.results.items.properties.decision.enum.length === 4);
}

console.log('\n环境变量分层配置：\n');
{
  process.env.AI_PROVIDER = 'mock';             // 模拟服务器遗留的全局默认值
  process.env.AI_L1_PROVIDER = 'openai_compatible';
  process.env.AI_L1_MODEL = 'flash-1';
  process.env.AI_L1_BASE_URL = 'https://compat.example/v1';
  process.env.OPENAI_COMPAT_API_KEY = 'compat-key';
  delete process.env.AI_L2_PROVIDER;
  process.env.AI_L2_MODEL = 'pro-agent';
  delete process.env.AI_L2_BASE_URL;
  process.env.AI_L3_PROVIDER = 'anthropic';
  process.env.AI_L3_MODEL = 'claude-opus-5';
  process.env.AI_L3_BASE_URL = 'https://anthropic-proxy.example';
  const l1 = providerFromEnv('L1'), l2 = providerFromEnv('L2'), l3 = providerFromEnv('L3');
  ok('L1 覆盖遗留的全局供应商', l1.provider === 'openai_compatible' && l1.model === 'flash-1');
  ok('L2 留空供应商时继承 L1', l2.provider === 'openai_compatible');
  ok('L2 可单独指定模型', l2.model === 'pro-agent');
  ok('L2 同 L1 时继承自定义 Base URL', l2.baseUrl === 'https://compat.example/v1');
  ok('L2 使用继承后供应商对应的密钥', l2.apiKey === 'compat-key');
  ok('L3 可指向不同厂商', l3.provider === 'anthropic' && l3.model === 'claude-opus-5');
  ok('任意层级可读取自定义 Base URL', l3.baseUrl === 'https://anthropic-proxy.example');

  delete process.env.AI_L3_BASE_URL;
  const l3Default = providerFromEnv('L3');
  ok('显式切换厂商且地址留空时不继承 L1 地址', l3Default.baseUrl === undefined);
}

console.log('\nAnthropic 瞬时故障（SDK 自带重试已关闭，统一由 withTransientRetry 负责）：\n');
{
  const { createServer } = await import('node:http');
  const { withTransientRetry } = await import('../packages/ai/src/retry.ts');
  const statuses = [408, 409, 200];
  let hits = 0;
  const srv = createServer((rq, rs) => {
    rq.resume();
    rq.on('end', () => {
      const st = statuses[Math.min(hits, statuses.length - 1)]!; hits++;
      rs.writeHead(st, { 'content-type': 'application/json' });
      rs.end(st === 200
        ? JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{"results":[]}' }], usage: { input_tokens: 3, output_tokens: 2 } })
        : JSON.stringify({ type: 'error', error: { type: st === 408 ? 'timeout_error' : 'conflict', message: 'x' } }));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  let dispatched = 0;
  const cfg = { provider: 'anthropic', model: 'claude-x', apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` } as any;
  try {
    // 单次调用：一次派发只对应一次 HTTP 请求（SDK 不在内部偷偷重试），408 / 409 归为可重试
    const raw = await createProvider(cfg, { retry: false, onDispatch: () => { dispatched++; } });
    const kinds: string[] = [];
    for (let i = 0; i < 2; i++) { try { await raw.complete(req); } catch (e) { kinds.push((e as ProviderError).kind + '/' + String((e as ProviderError).retryable)); } }
    ok('408 → timeout、409 → server，均可重试', kinds.join(',') === 'timeout/true,server/true', kinds.join(','));
    ok('每次派发恰好一次 HTTP 请求', hits === 2 && dispatched === 2, `hits=${hits} dispatched=${dispatched}`);
    // 套上重试：408 → 409 → 200，三次请求都计入预算
    hits = 0; dispatched = 0;
    const retrying = withTransientRetry(await createProvider(cfg, { retry: false, onDispatch: () => { dispatched++; } }),
      { sleep: async () => {}, log: () => {} });
    const r = await retrying.complete(req);
    ok('408 / 409 后重试成功', JSON.stringify(r.data) === '{"results":[]}');
    ok('重试的每次请求都计入预算', hits === 3 && dispatched === 3, `hits=${hits} dispatched=${dispatched}`);
  } finally { srv.close(); }
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
