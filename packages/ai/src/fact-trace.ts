import { errorText, PublicError } from './errors.ts';
import { XMLParser } from 'fast-xml-parser';
import { safeHttp, type SafeCheck, type SafeOpts } from '../../connectors/src/safe-http.ts';

export type FactEvidence = {
  checkedAt: string;
  currentDate: string;
  origin: { url: string; reachable: boolean; status?: number } | null;
  results: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
};

const xml = new XMLParser({ ignoreAttributes: false, trimValues: true });
const text = (v: unknown) => typeof v === 'string' ? v : v == null ? '' : String(v);

const MAX_REDIRECTS = 4;
const MAX_BODY = 1024 * 1024;
const UA = 'BriefingFactTrace/1.0';

/** 测试注入（地址校验、请求函数、TLS 选项）；生产不传。 */
export type TraceOpts = { timeoutMs?: number; check?: SafeCheck; request?: SafeOpts['request']; tlsOptions?: SafeOpts['tlsOptions'] };

/** 实时核验候选原始链接，并从公开搜索结果取回独立来源摘要供复核模型比对。 */
export async function traceFacts(title: string, originUrl: string | null, o: TraceOpts = {}): Promise<FactEvidence> {
  const checkedAt = new Date().toISOString();
  const out: FactEvidence = { checkedAt, currentDate: checkedAt.slice(0, 10), origin: null, results: [] };
  const timeoutMs = o.timeoutMs ?? 8000;
  // 统一走 safeHttp（docs/ssrf-redirect-design.md §11）：逐跳校验、固定连接地址、整次截止时间
  const base = { timeoutMs, userAgent: UA, maxBytes: MAX_BODY, maxRedirects: MAX_REDIRECTS, check: o.check, request: o.request, tlsOptions: o.tlsOptions };
  try {
    if (originUrl) {
      // 原文可达性：只看响应头，不读正文（大页面、慢正文不会被误判为不可达）
      const r = await safeHttp(originUrl, { ...base, mode: 'headers', accept: 'text/html;q=0.9, */*;q=0.5' });
      const url = (() => { try { return new URL(originUrl).href; } catch { return originUrl; } })();
      // 第一跳就未通过安全校验：不记录来源（与原行为一致）
      out.origin = r.errorClass === 'blocked' && r.hops === 1 ? null
        : { url, reachable: r.outcome === 'ok', ...(r.httpCode ? { status: r.httpCode } : {}) };
    }
    const query = originUrl
      ? `"${title.slice(0, 120)}" site:${new URL(originUrl).hostname}`
      : `"${title.slice(0, 120)}"`;
    const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
    const s = await safeHttp(searchUrl, { ...base, mode: 'body', accept: 'application/rss+xml, application/xml, text/html;q=0.8' });
    if (s.outcome !== 'ok' || !s.body)
      throw new PublicError(s.errorClass === 'too_large' ? '搜索响应过大' : s.httpCode && s.httpCode >= 300 ? `搜索 HTTP ${s.httpCode}` : (s.errorMessage ?? '搜索失败'));
    const body = s.body;
    const parsed = xml.parse(body);
    const raw = parsed?.rss?.channel?.item ?? [];
    const items = Array.isArray(raw) ? raw : [raw];
    out.results = items.slice(0, 5).map((x: any) => ({
      title: text(x?.title).slice(0, 240),
      url: text(x?.link).slice(0, 1000),
      snippet: text(x?.description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
    })).filter((x: any) => x.title && /^https:\/\//.test(x.url));
  } catch (e: any) {
    out.error = errorText(e);
  }
  return out;
}
