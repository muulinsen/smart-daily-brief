/**
 * 错误信息卫生（docs/error-hygiene-design.md）。
 *
 * - 源头：ProviderError 的 message 只由我们写死的文案 + 白名单字段 + 校验过的数字构成，不含上游正文或模型输出。
 * - 出口：errorText(e) 是所有写入数据库、页面、日志的错误的唯一格式化函数；未知错误只输出受控类名，不输出 message。
 */
import { ProviderError } from './types.ts';

/** 各供应商公开文档里的错误码 / 类型 / 状态名，名单外一律记 other（上游可能把任意文本放进这些字段）。 */
const UPSTREAM_CODES = new Set([
  // OpenAI 类
  'rate_limit_exceeded', 'insufficient_quota', 'invalid_api_key', 'model_not_found', 'context_length_exceeded',
  'invalid_request_error', 'server_error', 'content_filter',
  // Anthropic
  'authentication_error', 'permission_error', 'not_found_error', 'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error',
  // Gemini（error.status）
  'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'PERMISSION_DENIED', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED',
]);

/** 网络层错误码封闭名单（Node 系统错误与 undici）。 */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_ABORTED',
]);

/** errorText 允许原样输出的运行时错误类名（不输出它们的 message）。 */
const SAFE_NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'Error']);

export function upstreamCode(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return UPSTREAM_CODES.has(v) ? v : 'other';
}

/** 从 JSON 错误响应体里取白名单错误码：error.code → error.type → error.status → 顶层 type。正文本身不保存。 */
export function codeFromBody(body: string): string | undefined {
  let j: any;
  try { j = JSON.parse(body); } catch { return undefined; }
  if (!j || typeof j !== 'object') return undefined;
  const e = j.error && typeof j.error === 'object' ? j.error : {};
  for (const v of [e.code, e.type, e.status, j.type]) if (typeof v === 'string' && v) return upstreamCode(v);
  return undefined;
}

/** 网络错误码：只取封闭名单里的 cause.code / code，否则 other。 */
export function networkCode(e: any): string {
  for (const v of [e?.cause?.code, e?.code, e?.cause?.cause?.code]) if (typeof v === 'string' && NETWORK_CODES.has(v)) return v;
  return 'other';
}

/** 网络错误：固定文案 + 白名单错误码，不使用原始 message 与 e.name。 */
export function networkError(e: any): ProviderError {
  const isAbort = e?.name === 'AbortError' || e?.name === 'TimeoutError';
  const code = networkCode(e);
  const err = new ProviderError(isAbort ? 'timeout' : 'network', isAbort ? '请求超时' : `网络错误（${code}）`);
  if (code !== 'other') err.code = code;
  return err;
}

/** 计数字段只接受有限非负整数，否则「?」。 */
export const safeCount = (v: unknown): string => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : '?');

/**
 * Retry-After 秒数：响应头有效优先；头缺失或无效时，按原有规则从正文里取（在丢弃正文之前调用）。
 * 原 retry.ts 从 message 里匹配同一个正则，这里等价迁移。
 */
export function retryAfterFrom(header: string | null | undefined, body?: string): number | undefined {
  const h = Number(header);
  if (header != null && header !== '' && Number.isFinite(h) && h >= 0) return h;
  const m = body ? /retry[-_ ]after["':\s]*(\d+)/i.exec(body) : null;
  return m ? Number(m[1]) : undefined;
}

/** 上游 HTTP 错误 → ProviderError。正文只用于取错误码与 Retry-After，不进入 message。 */
export function httpError(status: number, body: string, retryAfterHeader?: string | null): ProviderError {
  const code = codeFromBody(body);
  const msg = `HTTP ${status}${code ? ` ${code}` : ''}`;
  const kind: ProviderError['kind'] = status === 429 ? 'rate_limited' : status === 408 ? 'timeout'
    : status === 401 || status === 403 ? 'auth' : status >= 500 ? 'server' : 'bad_request';
  const e = new ProviderError(kind, msg, status);
  if (code) e.code = code;
  if (status === 429) { const s = retryAfterFrom(retryAfterHeader, body); if (s !== undefined) e.retryAfterSec = s; }
  return e;
}

/** 模型拒答（各供应商的原生拒答格式都归到这里）：不可重试，Telegram 路径按内容过滤处理、不再反复请求。 */
export function refusalError(): ProviderError {
  const e = new ProviderError('refusal', '模型拒答');
  e.contentFiltered = true;
  return e;
}

/** 模型输出不是合法 JSON：只记长度，不记内容（输出可能复述输入消息）。 */
export const invalidJsonError = (text: string) =>
  new ProviderError('bad_request', text ? `响应不是合法 JSON（${text.length} 字）` : '响应不是合法 JSON（响应体为空）');

/** 由我们写死的文案构造、可以原样输出的错误。 */
export class PublicError extends Error {
  publicMessage: string;
  constructor(message: string) { super(message); this.name = 'PublicError'; this.publicMessage = message; }
}

/** 给已有错误打上「message 是我们写死的文案，可以原样输出」的标记。 */
export function markPublic<T extends Error>(e: T): T { (e as any).publicMessage = e.message; return e; }

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+\S+/gi, 'Bearer ***'], [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/(api[_-]?key|token|authorization|secret)(["'\s:=]+)[^\s"',}]+/gi, '$1$2***'],
];

/**
 * 所有写入数据库、页面、日志的错误都经过这里。
 * - ProviderError：类型 + HTTP 状态 + 白名单错误码 + 受控 message
 * - 带 publicMessage 的错误：它（只由我们写死的文案设置）
 * - 其他一切：只有受控类名，不输出 message（ActionError 包装的、SyntaxError 带输入片段的都在这里被挡住）
 */
export function errorText(e: unknown, max = 300): string {
  let s: string;
  if (e instanceof ProviderError) s = `${e.kind}${e.status ? ` HTTP ${e.status}` : ''}${e.code && !e.message.includes(e.code) ? ` ${e.code}` : ''}：${e.message}`;
  else if (e && typeof (e as any).publicMessage === 'string') s = (e as any).publicMessage;
  else {
    const name = (e as any)?.name;
    s = typeof name === 'string' && SAFE_NAMES.has(name) ? name : 'Error';
  }
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s.slice(0, max);
}
