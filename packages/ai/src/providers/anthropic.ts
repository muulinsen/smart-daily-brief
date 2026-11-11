import { networkError, refusalError, invalidJsonError, upstreamCode, retryAfterFrom } from '../errors.ts';
import type { Provider, CompleteRequest, CompleteResult, ProviderConfig, Strictness } from '../types.ts';
import { ProviderError } from '../types.ts';

/**
 * Anthropic Messages API 适配器。
 *
 * 用官方 SDK（@anthropic-ai/sdk）而不是自己拼 HTTP —— 官方 SDK 负责
 * 重试、类型、错误分类，且 API 演进时不会悄悄写错线路格式。
 * SDK 走动态 import 懒加载：只有真的配置成 anthropic 才会进内存
 * （896 MB 机器上这点很重要）。
 *
 * 结构化输出用原生 output_config.format（不是旧的 output_format 参数，
 * 也不需要用 tool-use 去绕），供应商侧保证符合 schema → strictness='strict'。
 *
 * 缓存口径：Anthropic 区分「写入缓存」与「读取缓存」两个计费档，
 * 分别映射到 cacheWriteTokens / cachedInputTokens。
 */
export class AnthropicProvider implements Provider {
  readonly name = 'anthropic' as const;
  readonly model;
  readonly strictness: Strictness;
  #cfg: ProviderConfig;
  #client: any = null;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model;
    this.strictness = cfg.strictness ?? 'strict';
    this.#cfg = cfg;
  }

  async #getClient(): Promise<any> {
    if (this.#client) return this.#client;
    let Anthropic: any;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new ProviderError('bad_request',
        '未安装 @anthropic-ai/sdk。执行 npm i @anthropic-ai/sdk 后再用 anthropic 供应商。');
    }
    // 不传 apiKey 时 SDK 自行从 ANTHROPIC_API_KEY / auth profile 解析
    const options: Record<string, unknown> = {};
    if (this.#cfg.isolated) Object.assign(options, isolatedOptions(this.#cfg));
    else {
      // 旧配置路径：固定 warn，不受 ANTHROPIC_LOG=debug 影响（debug 会打印请求内容）
      options.logLevel = 'warn';
      if (this.#cfg.apiKey) options.apiKey = this.#cfg.apiKey;
      if (this.#cfg.baseUrl) options.baseURL = this.#cfg.baseUrl.replace(/\/$/, '');
    }
    // 重试统一由 withTransientRetry 负责（每次实际请求都计入预算）；关闭 SDK 自带的重试，避免叠加与漏计
    options.maxRetries = 0;
    this.#client = new Anthropic(options);
    return this.#client;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const client = await this.#getClient();
    const system = req.cachePrefix
      ? [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : req.systemPrompt;

    let resp: any;
    try {
      resp = await client.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system,
        output_config: {
          format: { type: 'json_schema', name: req.schemaName, schema: req.schema },
        },
        messages: [{ role: 'user', content: req.userContent }],
      });
    } catch (e: any) {
      throw mapAnthropicError(e);
    }

    // 安全护栏：拒答时 content 可能为空，必须先看 stop_reason
    if (resp.stop_reason === 'refusal') throw refusalError();

    const text = (resp.content ?? [])
      .filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw invalidJsonError(text); }

    const u = resp.usage ?? {};
    return {
      data, rawText: text, responseId: resp.id ?? '', model: resp.model ?? this.model,
      stopReason: resp.stop_reason,
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function mapAnthropicError(e: any): ProviderError {
  const s = e?.status;
  if (typeof s !== 'number') return networkError(e);
  // SDK 已解析的错误类型（e.error.error.type）走白名单；e.message 含响应正文，不使用
  const code = upstreamCode(e?.error?.error?.type ?? e?.error?.type);
  let retryAfter: string | null = null;
  try { retryAfter = e?.headers?.get?.('retry-after') ?? e?.headers?.['retry-after'] ?? null; } catch { retryAfter = null; }
  const kind: ProviderError['kind'] = s === 429 ? 'rate_limited' : s === 401 || s === 403 ? 'auth'
    // SDK 自带重试已关闭（maxRetries=0），它原本会重试的 408 / 409 要映射成瞬时故障，交给 withTransientRetry
    : s === 408 ? 'timeout' : s === 409 || s >= 500 ? 'server' : 'bad_request';
  const err = new ProviderError(kind, `HTTP ${s}${code ? ` ${code}` : ''}`, s);
  if (code) err.code = code;
  // 响应头缺失或无效时按原有规则从 SDK 错误文本（含响应正文）里取秒数；该文本只用于解析，不进入 message
  if (s === 429) { const sec = retryAfterFrom(retryAfter, typeof e?.message === 'string' ? e.message : ''); if (sec !== undefined) err.retryAfterSec = sec; }
  return err;
}

/**
 * 库内配置的请求头全部由这里重建：SDK 合并了 ANTHROPIC_CUSTOM_HEADERS 之后，同名的 anthropic-version / beta /
 * user-agent / x-stainless-* 也可能来自环境，所以只保留与请求体格式有关的 content-type / accept，其余用固定值。
 */
const PASS_HEADERS = new Set(['content-type', 'accept']);
const FIXED_HEADERS: Record<string, string> = { 'anthropic-version': '2023-06-01', 'user-agent': 'briefing-system' };

/**
 * 库内配置（全局模型供应商）的 SDK 选项：SDK 会隐式读取 ANTHROPIC_BASE_URL / AUTH_TOKEN / CUSTOM_HEADERS / LOG，
 * 构造参数不足以全部关掉，所以最终请求由这里的 fetch 重建：只发往库里的地址、不跟随重定向、按白名单重建请求头、
 * 鉴权只用库里的密钥。
 */
export function isolatedOptions(cfg: ProviderConfig): Record<string, unknown> {
  // 先规范化（主机大小写、默认端口、末尾 /），SDK 发出的请求地址也是规范化后的，按源 + 路径前缀比较
  const b = new URL(cfg.baseUrl || 'https://api.anthropic.com');
  const basePath = b.pathname.replace(/\/+$/, '');
  const base = b.origin + basePath;
  const key = cfg.apiKey ?? '';
  const isolatedFetch = async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '');
    let u: URL | null = null;
    try { u = new URL(url); } catch { u = null; }
    if (!u || u.origin !== b.origin || !(u.pathname === basePath || u.pathname.startsWith(basePath + '/')))
      throw new ProviderError('bad_request', '请求地址与配置的 Base URL 不一致，已拦截');
    const headers = new Headers();
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      if (PASS_HEADERS.has(k.toLowerCase())) headers.set(k.toLowerCase(), v);
    });
    for (const [k, v] of Object.entries(FIXED_HEADERS)) headers.set(k, v);
    headers.set('x-api-key', key);
    return fetch(url, { ...init, headers, redirect: 'error' });
  };
  return { apiKey: key, authToken: null, baseURL: base, logLevel: 'off', fetch: isolatedFetch, defaultHeaders: {}, ...(cfg.timeoutMs ? { timeout: cfg.timeoutMs } : {}) };
}
