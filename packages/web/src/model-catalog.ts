/**
 * 模型列表拉取（docs/model-providers-design.md 第 7、13 节）。
 *
 * - 整次操作 20 秒（含读响应体）、每页 1 MB、最多 5 页、最多 500 个 ID；redirect: 'error'。
 * - 结果只有两种：所有请求的页都完整、结构合法 → 成功（因页数 / 数量上限停在页间也算成功，标 truncated）；
 *   任何一页失败 → 整次丢弃，保留旧列表，只记 kind/status（不存上游正文）。
 * - 同一供应商同时只允许一个拉取，10 秒内最多一次；回写由 applyModelsFetch 核对 config_version。
 */
import type { ProviderType } from '../../ai/src/model-config.ts';
import { OFFICIAL_BASE, validModelId } from '../../ai/src/model-config.ts';
import type { ModelsFetchResult } from './model-providers.ts';

const TOTAL_MS = 20_000, PAGE_BYTES = 1024 * 1024, MAX_PAGES = 5, MAX_IDS = 500;

type Page = { ids: string[]; next: string | null };

function statusKind(s: number): string {
  if (s === 401) return 'auth';
  if (s === 403) return 'forbidden';
  if (s === 404) return 'not_found';
  if (s === 429) return 'rate_limited';
  if (s >= 500) return 'server';
  return 'bad_request';
}

export function catalogUrl(type: ProviderType, baseUrl: string | undefined, cursor: string | null): string {
  const base = (baseUrl || OFFICIAL_BASE[type]).replace(/\/+$/, '');
  if (type === 'anthropic') return `${base}/v1/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}`;
  if (type === 'gemini') return `${base}/models?pageSize=200${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`;
  return `${base}/models`;
}

/** 按协议严格校验结构并提取 ID。必需字段缺失或类型不对返回 null（整次失败，保留旧列表）；合法的空数组才算空目录。 */
export function parsePage(type: ProviderType, j: any): Page | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (type === 'gemini') {
    if (!Array.isArray(j.models)) return null;   // {} 不是合法目录
    if (j.nextPageToken !== undefined && (typeof j.nextPageToken !== 'string')) return null;
    const ids: string[] = [];
    for (const m of j.models) {
      if (!m || typeof m.name !== 'string' || !Array.isArray(m.supportedGenerationMethods)) return null;
      if (!m.supportedGenerationMethods.includes('generateContent')) continue;
      ids.push(m.name.replace(/^models\//, ''));
    }
    return { ids, next: j.nextPageToken || null };
  }
  if (!Array.isArray(j.data)) return null;
  const ids: string[] = [];
  for (const m of j.data) { if (!m || typeof m.id !== 'string') return null; ids.push(m.id); }
  if (type === 'anthropic') {
    if (typeof j.has_more !== 'boolean') return null;
    if (j.has_more) { if (typeof j.last_id !== 'string' || !j.last_id) return null; return { ids, next: j.last_id }; }
    return { ids, next: null };
  }
  return { ids, next: null };
}

async function readLimited(r: Response, limit: number): Promise<string | null> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authHeaders(type: ProviderType, apiKey: string): Record<string, string> {
  if (type === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (type === 'gemini') return { 'x-goog-api-key': apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

export async function fetchModelCatalog(type: ProviderType, baseUrl: string | undefined, apiKey: string,
  o: { fetchImpl?: typeof fetch; totalMs?: number } = {}): Promise<ModelsFetchResult> {
  const f = o.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.totalMs ?? TOTAL_MS);
  const ids: string[] = [];
  let truncated = false;
  try {
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { truncated = true; break; }
      let r: Response;
      try { r = await f(catalogUrl(type, baseUrl, cursor), { headers: { accept: 'application/json', ...authHeaders(type, apiKey) }, redirect: 'error', signal: ac.signal }); }
      catch (e: any) { return { ok: false, kind: ac.signal.aborted ? 'timeout' : 'network' }; }
      if (!r.ok) {
        const ra = Number(r.headers.get('retry-after'));
        await r.body?.cancel().catch(() => {});
        return { ok: false, kind: statusKind(r.status), status: r.status, ...(r.status === 429 && Number.isFinite(ra) && ra > 0 ? { retryAfterSec: Math.min(ra, 3600) } : {}) };
      }
      let text: string | null;
      try { text = await readLimited(r, PAGE_BYTES); } catch { return { ok: false, kind: ac.signal.aborted ? 'timeout' : 'network' }; }
      if (text === null) return { ok: false, kind: 'too_large' };
      let j: unknown;
      try { j = JSON.parse(text); } catch { return { ok: false, kind: 'bad_response' }; }
      const p = parsePage(type, j);
      if (!p) return { ok: false, kind: 'bad_response' };
      for (const id of p.ids) {
        if (!validModelId(type, id) || ids.includes(id)) continue;
        if (ids.length >= MAX_IDS) { truncated = true; break; }
        ids.push(id);
      }
      // 名额已满且还有下一页：标为不完整并成功结束，不再多请求一页
      if (!truncated && ids.length >= MAX_IDS && p.next) truncated = true;
      if (truncated || !p.next) break;
      cursor = p.next;
    }
  } finally { clearTimeout(timer); }
  return { ok: true, models: ids.sort(), truncated };
}

/** 后台进程内的节流：同一供应商同时只允许一个拉取、10 秒内最多一次。 */
const inflight = new Set<string>();
const lastStart = new Map<string, number>();
export function tryStartFetch(id: string, nowMs = Date.now()): boolean {
  const last = lastStart.get(id);
  if (inflight.has(id) || (last !== undefined && nowMs - last < 10_000)) return false;
  inflight.add(id); lastStart.set(id, nowMs); return true;
}
export function endFetch(id: string) { inflight.delete(id); }

export const MODELS_ERROR_LABEL: Record<string, string> = {
  auth: '密钥无效（401）', forbidden: '当前密钥没有模型目录权限或网关不提供目录，可手动添加模型（403）',
  not_found: '网关不提供模型目录，可手动添加模型（404）', rate_limited: '被限流，请稍后再试', server: '上游服务错误',
  bad_request: '请求被拒绝', timeout: '超时（20 秒）', network: '网络错误', too_large: '响应过大', bad_response: '响应格式不符合该类型的模型目录接口',
};
