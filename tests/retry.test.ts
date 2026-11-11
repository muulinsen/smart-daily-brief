// AI 供应商瞬时故障重试
// 2026-10-09 早报：上游短暂断网，复核调用立即失败两次、中间不等待，155 条落入待复核，门禁阻断发送。
import { withTransientRetry, isTransient } from '../packages/ai/src/retry.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import { toError } from '../packages/ai/src/providers/openai-compat.ts';
import type { CompleteResult, Provider } from '../packages/ai/src/types.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const RESULT = { data: {}, rawText: '{}', responseId: 'r', model: 'm',
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 } } as CompleteResult;
const REQ = { systemPrompt: 's', userContent: 'u', schema: {}, schemaName: 'x', maxOutputTokens: 10 } as any;

/** 按脚本依次抛错或成功的假供应商 */
function scripted(script: Array<ProviderError | 'ok'>): Provider & { calls: number } {
  const p = {
    name: 'openai_compatible', model: 'm', strictness: 'json', calls: 0,
    async complete() {
      const step = script[Math.min(p.calls++, script.length - 1)];
      if (step === 'ok') return RESULT;
      throw step;
    },
  };
  return p as any;
}
const harness = () => {
  const waits: number[] = [];
  const logs: string[] = [];
  return { waits, logs, opts: { delaysMs: [5, 15, 45], sleep: async (ms: number) => { waits.push(ms); }, log: (l: string) => logs.push(l) } };
};
const net = () => new ProviderError('network', 'fetch failed');

console.log('瞬时错误退避重试：\n');
{
  const h = harness();
  const inner = scripted([net(), new ProviderError('server', 'HTTP 502'), 'ok']);
  const p = withTransientRetry(inner, h.opts);
  const res = await p.complete(REQ);
  ok('断网 + 502 后第三次成功', res === RESULT && inner.calls === 3);
  ok('按退避表等待', JSON.stringify(h.waits) === '[5,15]', JSON.stringify(h.waits));
  ok('透传 name/model/strictness', p.name === 'openai_compatible' && p.model === 'm' && p.strictness === 'json');
}

console.log('\n非瞬时错误不重试：\n');
{
  for (const kind of ['bad_request', 'auth', 'refusal', 'truncated'] as const) {
    const h = harness();
    const inner = scripted([new ProviderError(kind, kind), 'ok']);
    let e: unknown;
    try { await withTransientRetry(inner, h.opts).complete(REQ); } catch (err) { e = err; }
    ok(`${kind} 立即抛出`, (e as ProviderError)?.kind === kind && inner.calls === 1 && h.waits.length === 0);
  }
  ok('isTransient 只认 network/timeout/server/rate_limited',
     isTransient(new ProviderError('timeout', 't')) && isTransient(new ProviderError('rate_limited', 'r')) &&
     !isTransient(new Error('x')) && !isTransient(new ProviderError('truncated', 't')));
}

console.log('\nHTTP 状态映射：\n');
{
  // 2026-10-09：上游返回 408「stream closed before response.completed」被当成请求错误，没有重试
  ok('408 归为可重试的超时', toError(408, 'stream disconnected').kind === 'timeout' && isTransient(toError(408, '')));
  ok('400 仍为不可重试的请求错误', toError(400, 'bad').kind === 'bad_request' && !isTransient(toError(400, '')));
}

console.log('\n429 按 Retry-After 等待（有上限）：\n');
{
  const h = harness();
  const inner = scripted([toError(429, '{"error":"slow down","retry_after": 7}'), 'ok']);
  await withTransientRetry(inner, h.opts).complete(REQ);
  ok('Retry-After 7 秒', h.waits[0] === 7000, String(h.waits[0]));
  const h2 = harness();
  // 正文里的秒数由适配器在丢弃正文前解析；响应头无效时回退到正文
  await withTransientRetry(scripted([toError(429, 'Retry-After: 3600', 'not-a-number'), 'ok']), h2.opts).complete(REQ);
  ok('超长 Retry-After 截断到 2 分钟', h2.waits[0] === 120_000, String(h2.waits[0]));
}

console.log('\n持续中断时熔断，避免拖垮整轮：\n');
{
  const h = harness();
  const inner = scripted([net()]);
  const p = withTransientRetry(inner, h.opts);
  for (let i = 0; i < 3; i++) { try { await p.complete(REQ); } catch { /* 预期失败 */ } }
  ok('前 3 次调用各重试 3 次', inner.calls === 12 && h.waits.length === 9, `calls=${inner.calls}`);
  ok('记录一次上游中断日志', h.logs.filter(l => l.includes('判定为上游中断')).length === 1);
  const before = inner.calls, waited = h.waits.length;
  let e: unknown;
  try { await p.complete(REQ); } catch (err) { e = err; }
  ok('熔断后直接失败、不再等待', inner.calls === before + 1 && h.waits.length === waited && (e as ProviderError).kind === 'network');

  // 网络恢复：一次成功即解除熔断
  const recovering = scripted(['ok', net(), 'ok']);
  const q = withTransientRetry(recovering, h.opts);
  for (let i = 0; i < 3; i++) { try { await q.complete(REQ); } catch { /* */ } }
  ok('成功调用会清零计数', recovering.calls === 4, `calls=${recovering.calls}`);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
