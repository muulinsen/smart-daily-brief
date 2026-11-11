/**
 * L1 / L2 分层调用（docs/semantic-dedup-design.md §3、§4）。无 L3、无人工。
 *
 * 每个任务按条目 ID 工作：输入 ID 与输出 ID 必须一一对应，缺失、重复、未知都算无效；
 * 已通过的结果立即保留，只把无效/缺失/低置信/被拦截的条目送 L2。
 * 最终每个条目落入三类之一：results（已判定）、refused（L1 与 L2 都以内容安全拒绝处理，按排除计）、
 * unresolved（未判定，阻断发布）。重试只在这里调度一次，不与旧的 call() 叠加。
 */
import type { JsonSchema, Provider, ProviderConfig } from '../../ai/src/types.ts';
import { ProviderError } from '../../ai/src/types.ts';
import { createProvider } from '../../ai/src/registry.ts';
import { validate } from '../../ai/src/schema.ts';
import { AiCache, sha256, stableJson } from './cache.ts';

export type Tier = 'L1' | 'L2';
export type Slot = { tier: Tier; provider: Provider | null; dead: boolean; deadReason: string | null };

export type TierEnv = {
  l1: Slot;
  l2: Slot;
  /** L2 与 L1 的供应商/模型/端点完全相同：L1 认证失败时不再浪费 L2 调用 */
  l2SameAsL1: boolean;
  configId: string;
  cache: AiCache;
  signal?: AbortSignal;
  l2Left: { items: number; gray: number };
  /** 预算耗尽或到达截止时间后的原因；非空即停止派发 */
  stopReason: string | null;
  /** 每次实际请求前调用（预算 / 截止时间），向量请求同样经过它 */
  dispatch: () => void;
  lastErrorKind: string | null;
  concurrency: number;
  log: (s: string) => void;
};

export const LOW_CONFIDENCE = 0.6;
/** 缓存中"两层都拒绝处理"的终态标记（只含标记，不含任何内容）。 */
const REFUSED = '__refused';

/** 本地可判定的模型配置错误（全局模型供应商开关打开时）：该层直接标记不可用，不派发请求。 */
export type TierConfigError = { configError: string };
export type TierInput = ProviderConfig | TierConfigError;
const isErr = (c: TierInput): c is TierConfigError => 'configError' in c;

/** 配置标识：两层的供应商、模型、端点（不含密钥）与提示词版本；库内配置追加供应商指纹。 */
export function tierConfigId(l1: TierInput, l2: TierInput, promptVersion: string): string {
  // 地址格式错误时不在这里抛出：该层会在创建供应商时被标记为不可用
  const endpoint = (u?: string) => { if (!u) return ''; try { const x = new URL(u); return x.origin + x.pathname; } catch { return `invalid:${u.length}`; } };
  const pick = (c: TierInput) => isErr(c) ? ['unavailable', c.configError]
    : [c.provider, c.model, endpoint(c.baseUrl), ...(c.cacheScope ? [c.cacheScope] : [])];
  return sha256(JSON.stringify(['tier1', pick(l1), pick(l2), promptVersion])).slice(0, 32);
}

/**
 * 创建两层供应商。创建失败（缺密钥、缺 Base URL）不抛出，而是把该层标记为不可用，由任务降级处理。
 * onDispatch 在每次实际请求前调用，用于持久化预算与截止时间检查。
 */
export async function createTierEnv(o: {
  l1: TierInput; l2: TierInput; promptVersion: string; cache: AiCache;
  onDispatch: () => void; signal?: AbortSignal; l2Items?: number; l2Gray?: number; concurrency?: number;
  log?: (s: string) => void; providers?: { l1?: Provider; l2?: Provider };
}): Promise<TierEnv> {
  const slot = async (tier: Tier, cfg: TierInput, injected?: Provider): Promise<Slot> => {
    if (injected) return { tier, provider: injected, dead: false, deadReason: null };
    if (isErr(cfg)) return { tier, provider: null, dead: true, deadReason: `config:${cfg.configError}` };
    try { return { tier, provider: await createProvider({ ...cfg, timeoutMs: cfg.timeoutMs ?? 120_000 }, { onDispatch: o.onDispatch }), dead: false, deadReason: null }; }
    catch (e) { return { tier, provider: null, dead: true, deadReason: errorKind(e) }; }
  };
  const a = o.l1, b = o.l2;
  const same = !isErr(a) && !isErr(b) && a.provider === b.provider && a.model === b.model && (a.baseUrl ?? '') === (b.baseUrl ?? '') && a.apiKey === b.apiKey;
  const l1 = await slot('L1', a, o.providers?.l1), l2 = await slot('L2', b, o.providers?.l2);
  // 配置错误直接作为最后错误类型，推迟发布时后台显示的就是它
  const configErr = [l1, l2].find(s => s.deadReason?.startsWith('config:'))?.deadReason ?? null;
  return {
    l1, l2, l2SameAsL1: same,
    configId: tierConfigId(o.l1, o.l2, o.promptVersion), cache: o.cache, signal: o.signal,
    l2Left: { items: o.l2Items ?? 80, gray: o.l2Gray ?? 60 }, stopReason: null, lastErrorKind: configErr, dispatch: o.onDispatch,
    concurrency: o.concurrency ?? 3, log: o.log ?? (() => {}),
  };
}

export type TaskSpec<I, R> = {
  task: string;
  system: string;
  schema: JsonSchema;
  schemaName: string;
  batchSize: number;
  l2BatchSize?: number;
  maxOut: (n: number) => number;
  temperature?: number;
  payload: (batch: Array<{ id: string; input: I }>) => unknown;
  entries: (out: any) => unknown[];
  idOf: (raw: any) => string;
  accept: (raw: any, input: I) => R | null;
  confidence?: (r: R) => number;
  l2Quota?: 'items' | 'gray';
};

export type TaskOutcome<R> = {
  results: Map<string, R>;
  tiers: Map<string, Tier>;
  unresolved: Set<string>;
  refused: Set<string>;
};

/** 错误类型（只用于日志与状态，不含任何上游正文）。 */
export function errorKind(e: unknown): string {
  if (e instanceof ProviderError) {
    if (e.budgetExhausted) return 'budget';
    if (e.contentFiltered || e.kind === 'refusal') return 'content_filter';
    if (e.kind === 'bad_request' && !e.status) return 'invalid_json';
    return e.status ? `${e.kind}_${e.status}` : e.kind;
  }
  if (e instanceof SchemaError) return 'schema';
  return 'unknown';
}
class SchemaError extends Error {}

/**
 * 截止时间到达时立即放弃等待（不支持取消信号的适配器也一样），截止后返回的结果一律不采用。
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = () => { const e = new ProviderError('timeout', '已到截止时间'); e.budgetExhausted = true; return e; };
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(deadline());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(deadline());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(v => { signal.removeEventListener('abort', onAbort); signal.aborted ? reject(deadline()) : resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(signal.aborted ? deadline() : e); });
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) { const x = items[i++]!; await fn(x); }
  }));
}

export async function runTask<I, R>(env: TierEnv, spec: TaskSpec<I, R>, items: Array<{ id: string; input: I }>): Promise<TaskOutcome<R>> {
  const out: TaskOutcome<R> = { results: new Map(), tiers: new Map(), unresolved: new Set(), refused: new Set() };
  const byId = new Map(items.map(x => [x.id, x]));
  const hashOf = new Map(items.map(x => [x.id, sha256(stableJson(x.input))]));
  const conf = (r: R) => spec.confidence ? spec.confidence(r) : 1;

  // 0. 缓存
  const pending: Array<{ id: string; input: I }> = [];
  for (const x of items) {
    const c = env.cache.getResult(hashOf.get(x.id)!, spec.task, env.configId);
    if (c?.value?.[REFUSED]) { out.refused.add(x.id); continue; }   // 已确认两层都拒绝处理：不再重复消耗 L2 名额
    const v = c ? spec.accept(c.value, x.input) : null;
    if (c && v !== null) { out.results.set(x.id, v); out.tiers.set(x.id, c.tier); }
    else pending.push(x);
  }
  if (!pending.length) return out;

  const filtered = { L1: new Set<string>(), L2: new Set<string>() };
  const raws = { L1: new Map<string, any>(), L2: new Map<string, any>() };
  const got = { L1: new Map<string, R>(), L2: new Map<string, R>() };

  const call = async (slot: Slot, batch: Array<{ id: string; input: I }>, depth: number): Promise<void> => {
    if (env.stopReason || slot.dead || !slot.provider || env.signal?.aborted) return;
    try {
      const res = await abortable(slot.provider.complete({
        systemPrompt: spec.system, userContent: JSON.stringify(spec.payload(batch)), schema: spec.schema, schemaName: spec.schemaName,
        maxOutputTokens: spec.maxOut(batch.length), cachePrefix: true, signal: env.signal,
        ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      }), env.signal);
      if (validate(res.data, spec.schema).length) throw new SchemaError('schema');
      const want = new Set(batch.map(b => b.id));
      const seen = new Map<string, number>();
      const list = spec.entries(res.data);
      for (const r of list) { const id = String(spec.idOf(r)); seen.set(id, (seen.get(id) ?? 0) + 1); }
      for (const r of list) {
        const id = String(spec.idOf(r));
        if (!want.has(id) || seen.get(id)! > 1) continue;      // 未知或重复 ID 一律作废
        const v = spec.accept(r, byId.get(id)!.input);
        if (v !== null) { got[slot.tier].set(id, v); raws[slot.tier].set(id, r); }
      }
    } catch (e) {
      const kind = errorKind(e);
      env.lastErrorKind = kind;
      const pe = e instanceof ProviderError ? e : null;
      if (pe?.budgetExhausted || env.signal?.aborted) { env.stopReason = env.signal?.aborted || /截止/.test(pe?.message ?? '') ? 'deadline' : 'budget'; return; }
      // 内容安全拦截：OpenAI 兼容为 contentFiltered，Gemini / Anthropic 为 refusal，统一按单条拦截处理
      if (pe?.contentFiltered || pe?.kind === 'refusal') {
        if (batch.length > 1) { await pool(batch.map(b => [b]), env.concurrency, b => call(slot, b, depth + 1)); return; }
        filtered[slot.tier].add(batch[0]!.id); return;
      }
      if (pe?.kind === 'auth') { slot.dead = true; slot.deadReason = kind; env.log(`  ⚠️ ${slot.tier} 认证失败（${kind}），本期不再调用该层`); return; }
      const schemaLike = e instanceof SchemaError || (pe?.kind === 'bad_request' && !pe.status);
      if (schemaLike && depth === 0) { await call(slot, batch, 1); return; }
      const splittable = pe && (pe.kind === 'truncated' || (pe.kind === 'bad_request' && (pe.status === 400 || pe.status === 413)));
      if (splittable && batch.length > 1 && depth === 0) {
        const mid = Math.ceil(batch.length / 2);
        await call(slot, batch.slice(0, mid), 1); await call(slot, batch.slice(mid), 1); return;
      }
      env.log(`  ⚠️ ${spec.task} ${slot.tier} 批次失败（${kind}，${batch.length} 条）`);
    }
  };

  // 1. L1
  const chunks: Array<Array<{ id: string; input: I }>> = [];
  for (let i = 0; i < pending.length; i += spec.batchSize) chunks.push(pending.slice(i, i + spec.batchSize));
  await pool(chunks, env.concurrency, b => call(env.l1, b, 0));

  // 2. 需要 L2 的条目：缺失/无效、被拦截、低置信度
  const needL2 = pending.filter(x => !got.L1.has(x.id) || conf(got.L1.get(x.id)!) < LOW_CONFIDENCE);
  const skipL2 = env.l2SameAsL1 && env.l1.dead;
  const quota = spec.l2Quota ?? 'items';
  const l2Batch: Array<{ id: string; input: I }> = [];
  for (const x of needL2) {
    if (skipL2 || env.l2Left[quota] <= 0) break;
    env.l2Left[quota]--; l2Batch.push(x);
  }
  if (l2Batch.length) {
    const size = spec.l2BatchSize ?? 5;
    const l2chunks: Array<Array<{ id: string; input: I }>> = [];
    for (let i = 0; i < l2Batch.length; i += size) l2chunks.push(l2Batch.slice(i, i + size));
    await pool(l2chunks, env.concurrency, b => call(env.l2, b, 0));
  }

  // 3. 归类与缓存
  for (const x of pending) {
    const h = hashOf.get(x.id)!;
    const v2 = got.L2.get(x.id), v1 = got.L1.get(x.id);
    if (v2 !== undefined) {
      const w = env.cache.putResult(h, spec.task, env.configId, 'L2', raws.L2.get(x.id));
      out.results.set(x.id, spec.accept(w.value, x.input) ?? v2); out.tiers.set(x.id, 'L2');
    } else if (v1 !== undefined) {
      // 低置信度且 L2 没给出结果：本期采用 L1 结果，但不写缓存，下次重试还有机会升级
      if (conf(v1) >= LOW_CONFIDENCE) {
        const w = env.cache.putResult(h, spec.task, env.configId, 'L1', raws.L1.get(x.id));
        out.results.set(x.id, spec.accept(w.value, x.input) ?? v1);
      } else out.results.set(x.id, v1);
      out.tiers.set(x.id, 'L1');
    } else if (filtered.L1.has(x.id) && filtered.L2.has(x.id)) {
      out.refused.add(x.id);
      env.cache.putResult(h, spec.task, env.configId, 'L2', { [REFUSED]: true });
    }
    else out.unresolved.add(x.id);
  }
  return out;
}
