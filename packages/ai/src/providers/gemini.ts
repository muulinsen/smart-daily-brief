import { networkError, refusalError, invalidJsonError } from '../errors.ts';
import type { Provider, CompleteRequest, CompleteResult, ProviderConfig, Strictness } from '../types.ts';
import { ProviderError } from '../types.ts';
import { toError } from './openai-compat.ts';

/**
 * Gemini generateContent 适配器。
 * 结构化输出用 generationConfig.responseMimeType + responseSchema。
 *
 * 注意：Gemini 的 responseSchema 是 OpenAPI 子集，不接受 JSON Schema 的
 * 全部关键字（如 additionalProperties / $ref / oneOf），由 toGeminiSchema 裁剪。
 */
const GEMINI_BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

export class GeminiProvider implements Provider {
  readonly name = 'gemini' as const;
  readonly model;
  readonly strictness: Strictness;
  #key: string;
  #base: string;
  #timeout: number;

  constructor(cfg: ProviderConfig) {
    this.model = cfg.model;
    this.strictness = cfg.strictness ?? 'strict';
    this.#base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.#timeout = cfg.timeoutMs ?? 90_000;
    if (!cfg.apiKey) throw new ProviderError('auth', 'gemini 缺少 API key');
    this.#key = cfg.apiKey;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const body = {
      systemInstruction: { parts: [{ text: req.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: req.userContent }] }],
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(req.schema),
      },
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#timeout);
    let r: Response;
    try {
      r = await fetch(`${this.#base}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST', signal: ac.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#key },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      throw networkError(e);
    } finally { clearTimeout(timer); }

    if (!r.ok) throw toError(r.status, await r.text().catch(() => ''), r.headers.get('retry-after'));
    let j: any;
    try { j = await r.json(); } catch { throw invalidJsonError(''); }
    const cand = j.candidates?.[0];
    // 原生拒答：提示被拦截（promptFeedback.blockReason）或候选因安全类原因结束
    if (j.promptFeedback?.blockReason || GEMINI_BLOCKED.has(cand?.finishReason)) throw refusalError();

    const text = (cand?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw invalidJsonError(text); }

    const u = j.usageMetadata ?? {};
    return {
      data, rawText: text, responseId: j.responseId ?? '', model: this.model,
      stopReason: cand?.finishReason,
      usage: {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        cachedInputTokens: u.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
    };
  }
}

/** 裁掉 Gemini responseSchema 不支持的 JSON Schema 关键字。 */
export function toGeminiSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const drop = new Set(['additionalProperties', '$schema', '$ref', 'oneOf', 'allOf', 'not',
                        'patternProperties', 'const', 'examples', 'default']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    out[k] = toGeminiSchema(v);
  }
  return out;
}
