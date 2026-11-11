import { Throttler } from './throttle.ts';
import { safeHttp, RETRYABLE, type BeforeHop, type ErrorClass, type SafeResult } from './safe-http.ts';
import { safeCurl } from './safe-curl.ts';

/**
 * 来源抓取的统一入口（docs/ssrf-redirect-design.md 第 4 版）。
 * 普通通道 = safeHttp（固定已校验地址的 node:https），curl 通道 = safeCurl（封闭、逐跳校验）。
 * 两者都逐跳做 SSRF 校验，错误文本只有固定文案。
 */
export type FetchOutcome =
  | 'ok' | 'not_modified' | 'fetch_failed' | 'source_anomaly' | 'parse_failed'
  // 限流与内容失败必须分开：限流不是「这条内容抓不到」，
  // 不该消耗重试次数，否则条目会被永久放弃。
  | 'rate_limited';

export type FetchResult = {
  outcome: FetchOutcome;
  httpCode?: number;
  contentType?: string | null;
  retryAfterMs?: number;
  body?: string;
  bytes?: number;
  etag?: string | null;
  lastModified?: string | null;
  latencyMs: number;
  errorClass?: ErrorClass | string;
  errorMessage?: string;
  /** 第一跳被拒的原因（不含 IP），只给后台来源测试显示 */
  firstHopReason?: string;
};

type FetchOpts = { timeoutMs: number; userAgent: string; maxBytes: number;
  etag?: string | null; lastModified?: string | null;
  /** 绝对截止时刻（通道切换共用） */
  deadline?: number; maxRedirects?: number; connectTimeoutMs?: number;
  beforeHop?: BeforeHop; mode?: 'headers' | 'body'; accept?: string };

const toFetch = (r: SafeResult): FetchResult => {
  const { hops: _h, ...rest } = r;
  return rest;
};

/** 普通通道：一次抓取（逐跳校验、固定连接地址、条件 GET、体积上限）。 */
export async function fetchOnce(url: string, opts: FetchOpts): Promise<FetchResult> {
  return toFetch(await safeHttp(url, opts));
}

/**
 * curl 通道。
 *
 * 【为什么需要】linux.do 在 Cloudflare bot management 之后，对 Node 的 TLS 指纹一律返回 403
 * `cf-mitigated: challenge`，而 curl 稳定 200。判定依据是 TLS/HTTP2 指纹，不是请求头。
 */
export async function fetchViaCurl(url: string, opts: FetchOpts): Promise<FetchResult> {
  return toFetch(await safeCurl(url, opts));
}

/**
 * 自动通道选择：先走普通通道；若被 Cloudflare 质询（403），改走 curl 重试一次。
 * 两个通道共用同一个截止时刻；curl 回退也先经过 beforeHop（限流间隔与熔断）。
 */
export async function fetchSmart(
  url: string,
  opts: FetchOpts & { transport?: 'auto' | 'curl' | 'undici' },
): Promise<FetchResult & { transport: string }> {
  const deadline = opts.deadline ?? Date.now() + opts.timeoutMs;
  if (opts.transport === 'curl')
    return { ...await fetchViaCurl(url, { ...opts, deadline }), transport: 'curl' };

  const r = await fetchOnce(url, { ...opts, deadline, etag: null, lastModified: null });
  const challenged = r.httpCode === 403 && (r.outcome === 'fetch_failed' || r.outcome === 'rate_limited');
  if (opts.transport === 'undici' || !challenged) return { ...r, transport: 'undici' };

  const before = opts.beforeHop;
  const c = await fetchViaCurl(url, { ...opts, deadline, beforeHop: before ? (u, h) => before(u, h + 1) : undefined });
  return { ...c, transport: 'curl-after-403' };
}

/** 每一跳的限流与熔断：第一跳已由调用方的 group.run 排队；之后的跳按目标主机的分组只等间隔，冷却中的主机不请求。 */
export function hopGuard(throttler: Throttler, hostBlocked?: (host: string) => boolean): BeforeHop {
  return async (url, hop) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return false; }
    if (hostBlocked?.(host)) return false;
    if (hop > 0) await throttler.groupFor(url).pace();
    return true;
  };
}

export type Endpoint = {
  id?: number; priority: number; url: string; parser: string; host_group?: string | null;
  etag?: string | null; last_modified?: string | null;
};
export type Attempt = FetchResult & { endpoint: Endpoint; isFallback: boolean };

/**
 * 按 priority 升序尝试端点，成功即停。
 * 每轮都从 priority 1 开始，不做粘性缓存 —— PRD 18 章要求
 * 「不得因为过去曾 404 而跳过抓取」。所有尝试都返回，供审计落库。
 */
export async function fetchWithFallback(
  endpoints: Endpoint[],
  throttler: Throttler,
  defaults: { userAgent: string; maxBytes: number; maxRedirects?: number },
  unavailableHosts: ReadonlySet<string> = new Set(),
  hostBlocked?: (host: string) => boolean,
): Promise<{ attempts: Attempt[]; success: Attempt | null }> {
  const guard = hopGuard(throttler, hostBlocked);
  const attempts: Attempt[] = [];
  const rateLimitedHosts = new Set<string>();
  for (const ep of [...endpoints].sort((a, b) => a.priority - b.priority)) {
    let host = '';
    try { host = new URL(ep.url).hostname; } catch { /* fetch will report invalid URL */ }
    if (unavailableHosts.has(host) || rateLimitedHosts.has(host)) continue;
    const group = throttler.groupFor(ep.url, ep.host_group);
    const maxAttempts = Math.max(1, group.cfg.max_retries + 1);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // linux.do 会按 TLS 指纹质询 Node/undici；直接使用 curl，避免一次注定失败的请求。
      const request = host === 'linux.do' ? fetchViaCurl : fetchOnce;
      const res = await group.run(() => request(ep.url, {
        timeoutMs: group.cfg.timeout_ms,
        userAgent: defaults.userAgent,
        maxBytes: defaults.maxBytes,
        maxRedirects: defaults.maxRedirects,
        etag: ep.etag, lastModified: ep.last_modified,
        beforeHop: guard,
      }));
      const a: Attempt = { ...res, endpoint: ep, isFallback: ep.priority > 1 };
      attempts.push(a);
      if (res.outcome === 'ok' || res.outcome === 'not_modified') return { attempts, success: a };
      // 限流后不在同一主机继续尝试其它 URL，也不做秒级重试；由持久化熔断器冷却。
      if (res.outcome === 'rate_limited') { rateLimitedHosts.add(host); break; }
      const retryable = RETRYABLE.has(String(res.errorClass));
      if (!retryable || attempt === maxAttempts - 1) break;
      const delay = res.retryAfterMs && res.retryAfterMs > 0 ? Math.min(res.retryAfterMs, 60000) : [2000, 8000, 30000][attempt]!;
      await new Promise(resolve => setTimeout(resolve, delay + Math.floor(Math.random() * 250)));
    }
  }
  return { attempts, success: null };
}
