/**
 * OpenAI 兼容 `/embeddings` 客户端（语义去重用，docs/semantic-dedup-design.md §2.2）。
 *
 * 安全：不跟随重定向；错误只保留结构化信息（kind / status / retryAfterSec / code），
 * 不保存上游响应正文、请求头或异常对象，日志与页面因此不可能带出密钥或请求内容。
 * 校验：index 完整唯一、维度一致、全部有限且范数大于 0；任一不符整批作废。
 */
import { createHash } from 'node:crypto';

export type EmbeddingConfig = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** 0 = 自动（不在请求里带 dimensions） */
  dimensions: number;
  simHigh: number;
  simLow: number;
  apiKey?: string;
  /** 库内配置的供应商指纹（缓存隔离）；旧配置为空 */
  scope?: string;
};

export type EmbeddingErrorKind = 'network' | 'timeout' | 'server' | 'rate_limited' | 'auth' | 'not_found'
  | 'bad_request' | 'too_large' | 'invalid_response' | 'config' | 'aborted' | 'budget';

/** 结构化错误：message 由本模块生成，绝不包含上游响应正文。 */
export class EmbeddingError extends Error {
  kind: EmbeddingErrorKind; status?: number; retryAfterSec?: number; code?: string;
  constructor(kind: EmbeddingErrorKind, o: { status?: number; retryAfterSec?: number; code?: string } = {}) {
    super(`embedding ${kind}${o.status ? ` HTTP ${o.status}` : ''}${o.code ? ` (${o.code})` : ''}`);
    this.name = 'EmbeddingError'; this.kind = kind; this.status = o.status; this.retryAfterSec = o.retryAfterSec; this.code = o.code;
    // 只由类型、状态码与白名单错误码构成，可以原样输出（errorText）
    (this as any).publicMessage = this.message;
  }
  /** 配置类错误：本期不应再请求该端点。 */
  get fatal(): boolean { return ['auth', 'not_found', 'config', 'budget', 'aborted'].includes(this.kind); }
  get transient(): boolean { return ['network', 'timeout', 'server', 'rate_limited'].includes(this.kind); }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
export const MAX_DIMENSIONS = 8192;

/** 校验并规范化配置。返回错误列表（中文，可直接展示）；为空表示可用。 */
export function validateEmbeddingConfig(c: Partial<EmbeddingConfig>): string[] {
  const errs: string[] = [];
  const url = String(c.baseUrl ?? '').trim();
  if (!url) errs.push('Base URL 不能为空');
  else if (url.length > 300) errs.push('Base URL 过长');
  else {
    let u: URL | null = null;
    try { u = new URL(url); } catch { errs.push('Base URL 不是合法地址'); }
    if (u) {
      if (u.username || u.password) errs.push('Base URL 不能包含用户名或密码');
      if (u.search || u.hash) errs.push('Base URL 不能包含查询参数或锚点（密钥请填在 API Key 中）');
      if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) errs.push('公网地址必须使用 https；http 只允许本机地址（localhost / 127.0.0.1 / ::1）');
      else if (u.protocol !== 'https:' && u.protocol !== 'http:') errs.push('Base URL 只支持 http/https');
    }
  }
  const model = String(c.model ?? '').trim();
  if (!model) errs.push('模型 ID 不能为空');
  else if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) errs.push('模型 ID 过长或包含控制字符');
  const d = c.dimensions ?? 0;
  if (!Number.isInteger(d) || d < 0 || d > MAX_DIMENSIONS) errs.push(`维度必须留空或为 1–${MAX_DIMENSIONS} 的整数`);
  const hi = c.simHigh, lo = c.simLow;
  if (typeof hi !== 'number' || typeof lo !== 'number' || !Number.isFinite(hi) || !Number.isFinite(lo) || !(lo > 0 && lo < hi && hi <= 1))
    errs.push('相似度阈值需满足 0 < 待确认阈值 < 直接合并阈值 ≤ 1');
  return errs;
}

/** 从字符串字段解析（后台表单 / 环境变量）。无法解析的数字变成 NaN，交给 validate 报错。 */
export function parseEmbeddingFields(f: { enabled?: string; baseUrl?: string; model?: string; dimensions?: string; simHigh?: string; simLow?: string }, apiKey?: string): EmbeddingConfig {
  const num = (s: string | undefined, dflt: number) => { const t = String(s ?? '').trim(); return t === '' ? dflt : (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN); };
  const dims = String(f.dimensions ?? '').trim();
  return {
    enabled: ['1', 'true', 'on'].includes(String(f.enabled ?? '').trim().toLowerCase()),
    baseUrl: String(f.baseUrl ?? '').trim().replace(/\/+$/, ''),
    model: String(f.model ?? '').trim(),
    dimensions: dims === '' ? 0 : (/^\d+$/.test(dims) ? Number(dims) : NaN),
    simHigh: num(f.simHigh, 0.9),
    simLow: num(f.simLow, 0.8),
    apiKey,
  };
}

/** 缓存空间标识：端点 origin+path、模型、请求维度。不含密钥。 */
export function embeddingConfigId(c: EmbeddingConfig): string {
  const u = new URL(c.baseUrl);
  // 库内配置（全局模型供应商）追加供应商指纹，同端点同模型的不同账户不共用缓存；旧配置不变，已有缓存继续命中
  const parts: unknown[] = ['emb1', u.origin + u.pathname.replace(/\/+$/, ''), c.model, c.dimensions];
  if (c.scope) parts.push(c.scope);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export type EmbedOptions = {
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** 每次实际请求前调用，可抛 EmbeddingError('budget') 阻止派发。 */
  onDispatch?: () => void;
};

/** 单次请求（不重试）。返回与 inputs 一一对应、已 L2 归一化的 Float32 向量。 */
export async function requestEmbeddings(c: EmbeddingConfig, inputs: string[], o: EmbedOptions = {}, expectDims = c.dimensions): Promise<Float32Array[]> {
  if (!inputs.length) return [];
  if (!c.apiKey) throw new EmbeddingError('config', { code: 'missing_api_key' });
  o.onDispatch?.();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 60_000);
  const signal = o.signal ? AbortSignal.any([ac.signal, o.signal]) : ac.signal;
  const body: Record<string, unknown> = { model: c.model, input: inputs, encoding_format: 'float' };
  if (c.dimensions > 0) body.dimensions = c.dimensions;
  let json: any;
  try {
    let r: Response;
    try {
      r = await (o.fetchImpl ?? fetch)(`${c.baseUrl}/embeddings`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      if (o.signal?.aborted) throw new EmbeddingError('aborted');
      throw new EmbeddingError(e?.name === 'AbortError' ? 'timeout' : 'network');
    }
    const text = await readLimited(r, o.maxResponseBytes ?? 32 * 1024 * 1024, signal, o.signal);
    if (!r.ok) throw httpError(r.status, text, r.headers.get('retry-after'));
    try { json = JSON.parse(text); } catch { throw new EmbeddingError('invalid_response', { code: 'not_json' }); }
  } finally { clearTimeout(timer); }
  return parseEmbeddingResponse(json, inputs.length, expectDims);
}

async function readLimited(r: Response, max: number, signal: AbortSignal, outer?: AbortSignal): Promise<string> {
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new EmbeddingError('too_large');
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new EmbeddingError(outer?.aborted ? 'aborted' : 'timeout');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new EmbeddingError('too_large');
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof EmbeddingError) throw e;
    throw new EmbeddingError(outer?.aborted ? 'aborted' : signal.aborted ? 'timeout' : 'network');
  } finally { try { reader.releaseLock(); } catch { /* 已释放 */ } }
  return Buffer.concat(chunks).toString('utf8');
}

/** 只认这些常见错误码；其余一律丢弃（上游可能把密钥或输入回显在 code/type 字段里）。 */
const KNOWN_CODES = new Set(['invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded', 'model_not_found', 'context_length_exceeded',
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'server_error',
  'too_many_inputs', 'invalid_model', 'unsupported_dimensions', 'billing_hard_limit_reached', 'overloaded_error']);

function httpError(status: number, text: string, retryAfter: string | null): EmbeddingError {
  // 只取上游 JSON 中已知的错误码，不保留任何正文
  let code: string | undefined;
  try { const j = JSON.parse(text); const c = j?.error?.code ?? j?.error?.type; if (typeof c === 'string' && KNOWN_CODES.has(c.toLowerCase())) code = c.toLowerCase(); } catch { /* 非 JSON */ }
  const sec = Number(retryAfter);
  if (status === 429) return new EmbeddingError('rate_limited', { status, code, retryAfterSec: retryAfter && Number.isFinite(sec) && sec >= 0 ? sec : undefined });
  if (status === 401 || status === 403) return new EmbeddingError('auth', { status, code });
  if (status === 404) return new EmbeddingError('not_found', { status, code });
  if (status === 408 || status >= 500) return new EmbeddingError(status === 408 ? 'timeout' : 'server', { status, code });
  if (status === 413) return new EmbeddingError('too_large', { status, code });
  return new EmbeddingError('bad_request', { status, code });
}

/** 校验响应并按 index 重排、归一化。expectDims=0 时以本批首条为准（跨批一致由调用方锁定）。 */
export function parseEmbeddingResponse(json: any, n: number, expectDims: number): Float32Array[] {
  const data = json?.data;
  if (!Array.isArray(data) || data.length !== n) throw new EmbeddingError('invalid_response', { code: 'count_mismatch' });
  const out: Array<Float32Array | undefined> = new Array(n);
  let dims = expectDims;
  for (const d of data) {
    const idx = d?.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || out[idx]) throw new EmbeddingError('invalid_response', { code: 'bad_index' });
    const v = d?.embedding;
    if (!Array.isArray(v) || !v.length) throw new EmbeddingError('invalid_response', { code: 'empty_vector' });
    if (!dims) dims = v.length;
    if (v.length !== dims) throw new EmbeddingError('invalid_response', { code: 'dims_mismatch' });
    out[idx] = normalize(v);
  }
  return out as Float32Array[];
}

export function normalize(v: ArrayLike<unknown>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new EmbeddingError('invalid_response', { code: 'non_finite' });
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  if (!(norm > 0) || !Number.isFinite(norm)) throw new EmbeddingError('invalid_response', { code: 'zero_norm' });
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i]!)) throw new EmbeddingError('invalid_response', { code: 'non_finite' });
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * 带重试与拆批的批量向量化。返回与 inputs 对应的向量（失败的条目为 undefined）与本期是否应停用向量。
 * 临时故障 / 429：最多重试 2 次；400/413：拆半一次；配置类错误：立即停止，返回 fatal。
 */
export async function embedAll(c: EmbeddingConfig, inputs: string[], o: EmbedOptions & { batchSize?: number; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void } = {}):
  Promise<{ vectors: Array<Float32Array | undefined>; fatal?: EmbeddingError; errors: EmbeddingError[] }> {
  const size = o.batchSize ?? 64;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const vectors: Array<Float32Array | undefined> = new Array(inputs.length);
  const errors: EmbeddingError[] = [];
  let lockedDims = c.dimensions;
  const clipped = inputs.map(s => s.length > 2000 ? s.slice(0, 2000) : s);

  const once = async (idx: number[]): Promise<void> => {
    // 请求参数始终按配置（自动维度时不带 dimensions）；校验用本次运行锁定的维度，防止批次间漂移
    const res = await requestEmbeddings(c, idx.map(i => clipped[i]!), o, lockedDims);
    if (!lockedDims) lockedDims = res[0]!.length;
    idx.forEach((i, k) => { vectors[i] = res[k]; });
  };
  const withRetry = async (idx: number[], canSplit: boolean): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try { return await once(idx); }
      catch (e) {
        const err = e instanceof EmbeddingError ? e : new EmbeddingError('network');
        if (err.fatal) throw err;
        if (err.transient && attempt < 2) {
          const ms = err.retryAfterSec !== undefined ? Math.min(err.retryAfterSec * 1000, 60_000) : [5_000, 15_000][attempt]!;
          o.log?.(`向量请求临时失败（${err.kind}${err.status ? ` HTTP ${err.status}` : ''}），${Math.round(ms / 1000)} 秒后重试`);
          await sleep(ms);
          if (o.signal?.aborted) throw new EmbeddingError('aborted');
          continue;
        }
        if ((err.kind === 'bad_request' || err.kind === 'too_large') && canSplit && idx.length > 1) {
          const mid = Math.ceil(idx.length / 2);
          await withRetry(idx.slice(0, mid), false).catch(x => { if (x instanceof EmbeddingError && x.fatal) throw x; errors.push(x); });
          await withRetry(idx.slice(mid), false).catch(x => { if (x instanceof EmbeddingError && x.fatal) throw x; errors.push(x); });
          return;
        }
        throw err;
      }
    }
  };
  for (let i = 0; i < inputs.length; i += size) {
    const idx = Array.from({ length: Math.min(size, inputs.length - i) }, (_, k) => i + k);
    try { await withRetry(idx, true); }
    catch (e) {
      const err = e instanceof EmbeddingError ? e : new EmbeddingError('network');
      if (err.fatal) return { vectors, fatal: err, errors };
      errors.push(err);
    }
  }
  return { vectors, errors };
}

/** 后台"测试连通性"：用当前生效配置请求一次固定文本。不重试。 */
export async function testEmbedding(c: EmbeddingConfig, o: EmbedOptions = {}): Promise<{ dims: number; ms: number }> {
  const t0 = Date.now();
  const [v] = await requestEmbeddings(c, ['连通性测试 connectivity test'], { timeoutMs: 15_000, ...o });
  return { dims: v!.length, ms: Date.now() - t0 };
}
