/**
 * 出站安全的 HTTPS 抓取（docs/ssrf-redirect-design.md 第 4 版 §3、§11）。
 *
 * - 每一跳先 checkUrlSafe（协议、主机名、DNS 解析结果），连接时 lookup 只返回这些已校验的地址：
 *   实际连接的一定是校验过的地址，不会在连接时重新解析（消除 DNS 重绑定）。
 * - 只跟随 301/302/303/307/308；Location 必须恰好一个（读 rawHeaders 判断重复）；跳数上限、循环拒绝。
 * - 整次请求一个截止时刻（可由调用方传入，通道切换时共用）：DNS 校验、各跳连接与读取、解压都共用。
 * - 正文按流解压，解压后的字节边读边计数，超过上限立即中断（防 gzip 炸弹与无长度的分块响应）。
 * - 错误文本只用固定文案 + 分类 + 第几跳，不含地址、解析结果或底层异常消息；分类只看结构化错误码。
 */
import https from 'node:https';
import type { IncomingMessage, ClientRequest } from 'node:http';
import { isIP } from 'node:net';
import zlib from 'node:zlib';
import { checkUrlSafe, type LookupFn, type UrlCheck } from './ssrf.ts';

export type ErrorClass = 'blocked' | 'redirect_invalid' | 'dns' | 'network' | 'timeout' | 'tls' | 'too_large' | 'decode'
  | 'http_3xx' | 'http_4xx' | 'http_408' | 'http_5xx' | 'rate_limited' | 'cooldown' | 'protocol' | 'empty' | 'config' | 'curl_error';
/** 可重试（临时故障）。config 单独处理（不计次数、停止本批），不在这里。 */
export const RETRYABLE: ReadonlySet<string> = new Set(['dns', 'network', 'timeout', 'http_408', 'http_5xx']);

export type SafeResult = {
  outcome: 'ok' | 'not_modified' | 'fetch_failed' | 'source_anomaly' | 'rate_limited';
  httpCode?: number; contentType?: string | null; retryAfterMs?: number;
  body?: string; bytes?: number; etag?: string | null; lastModified?: string | null;
  latencyMs: number; errorClass?: ErrorClass; errorMessage?: string;
  /** 实际跳数（1 = 没有重定向） */
  hops: number;
  /** 第一跳被拒时给后台管理员看的原因（不含 IP）；其余情况为空 */
  firstHopReason?: string;
};

export type SafeCheck = (url: string, o: { deadline: number; lookup?: LookupFn }) => Promise<UrlCheck>;
/** 每一跳发起前调用（限流间隔、熔断）：返回 false 表示该主机冷却中、不发请求。 */
export type BeforeHop = (url: string, hop: number) => Promise<boolean>;

export type SafeOpts = {
  timeoutMs: number; userAgent: string; maxBytes: number;
  /** 绝对截止时刻；给出时优先于 timeoutMs（通道切换共用同一截止时刻） */
  deadline?: number;
  maxRedirects?: number; connectTimeoutMs?: number;
  etag?: string | null; lastModified?: string | null; accept?: string;
  /** headers：拿到最终 2xx 响应头即返回、不读正文；body（默认）：读取受限正文 */
  mode?: 'headers' | 'body';
  beforeHop?: BeforeHop;
  /** 测试注入：DNS 解析、地址校验、请求函数、TLS 选项 */
  lookup?: LookupFn; check?: SafeCheck; request?: typeof https.request; tlsOptions?: https.RequestOptions;
};

export const FOLLOW: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MSG: Record<ErrorClass, string> = {
  blocked: '地址未通过安全校验', redirect_invalid: '重定向无效', dns: 'DNS 解析失败', network: '网络错误', timeout: '请求超时',
  tls: 'TLS / 证书错误', too_large: '响应超过体积上限', decode: '响应解码失败', http_3xx: '非预期的 3xx 响应', http_4xx: 'HTTP 4xx',
  http_408: 'HTTP 408 请求超时', http_5xx: 'HTTP 5xx', rate_limited: '被限流', cooldown: '目标主机冷却中，未请求', protocol: '非预期的协议升级响应', empty: '响应体为空', config: '本机抓取配置错误', curl_error: 'curl 执行失败',
};
export const hopText = (cls: ErrorClass, hop: number, status?: number) =>
  `${status ? `HTTP ${status} ` : ''}${MSG[cls]}${hop > 0 ? `（第 ${hop + 1} 跳）` : ''}`;

/** 只取出 rawHeaders 里某个头的全部原始值（不合并）。 */
export function rawHeaderValues(raw: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}

/** 解析重定向目标：恰好一个 Location、可解析；返回去掉片段的规范化地址或 null（协议等由下一跳的校验处理）。 */
export function nextHop(current: string, locations: string[]): string | null {
  if (locations.length !== 1) return null;
  try { const u = new URL(locations[0]!.trim(), current); u.hash = ''; return u.href; } catch { return null; }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE', 'EAI_AGAIN', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL']);
/** 底层异常 → 分类（只看结构化错误码与名字，不看异常文本）。 */
export function classifyError(e: any): ErrorClass {
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (e?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (/^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL_|ERR_OSSL_|HOSTNAME_MISMATCH)/.test(code)) return 'tls';
  if (code === 'ERR_TOO_LARGE') return 'too_large';
  if (code === 'ERR_PROTOCOL_UPGRADE') return 'protocol';
  if (/^Z_|^ERR_BROTLI|^ERR_ZLIB|^ERR_DECODE/.test(code)) return 'decode';
  if (NETWORK_CODES.has(code)) return 'network';
  return 'network';
}

const IP_TEXT = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]*:[0-9a-f:.]+\b/gi;
/** 第一跳被拒的原因给管理员看：去掉 IP。 */
export const reasonWithoutIp = (r: string) => r.replace(IP_TEXT, '…');

/** 连接时只用已校验的地址：lookup 回调一次完成，不做任何解析。 */
export function pinnedLookup(addresses: string[]) {
  const list = addresses.map(a => ({ address: a, family: isIP(a) as 4 | 6 }));
  return (_host: string, options: any, cb: (...a: any[]) => void) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options?.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  };
}

const bare = (h: string) => h.replace(/^\[|\]$/g, '');

/** 与截止时刻赛跑：地址校验、限流等待等不受控的等待也不能越过截止时间（到时返回 null）。 */
export function untilDeadline<T>(p: Promise<T>, deadline: number): Promise<T | null> {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.resolve(null);
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<null>(r => { t = setTimeout(() => r(null), left); })]).finally(() => clearTimeout(t));
}

export async function safeHttp(url: string, o: SafeOpts): Promise<SafeResult> {
  const t0 = Date.now();
  const deadline = o.deadline ?? t0 + o.timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, deadline - t0));
  const maxRedirects = o.maxRedirects ?? 3;
  const request = o.request ?? https.request;
  const check: SafeCheck = o.check ?? ((u, x) => checkUrlSafe(u, x));
  const seen = new Set<string>();
  let current = url;
  const fail = (cls: ErrorClass, hop: number, extra: Partial<SafeResult> = {}): SafeResult => ({
    outcome: cls === 'rate_limited' ? 'rate_limited' : cls === 'empty' ? 'source_anomaly' : 'fetch_failed',
    latencyMs: Date.now() - t0, errorClass: cls, errorMessage: hopText(cls, hop, extra.httpCode), hops: hop + 1, ...extra });
  try {
    for (let hop = 0; ; hop++) {
      if (ac.signal.aborted) return fail('timeout', hop);
      if (seen.has(current)) return fail('redirect_invalid', hop);
      seen.add(current);
      const safe = await untilDeadline(check(current, { deadline, lookup: o.lookup }), deadline);
      if (!safe || ac.signal.aborted) return fail('timeout', hop);
      if (!safe.ok) return fail(safe.kind === 'blocked' ? 'blocked' : safe.kind, hop,
        hop === 0 && safe.kind === 'blocked' ? { firstHopReason: reasonWithoutIp(safe.reason) } : {});
      // 目标主机冷却中：不发请求；记 cooldown（不重试、不计入初始主机的熔断）
    if (o.beforeHop) {
        const allowed = await untilDeadline(o.beforeHop(safe.url, hop), deadline);
        if (allowed === null || ac.signal.aborted) return fail('timeout', hop);
        if (!allowed) return fail('cooldown', hop);
      }
      const u = new URL(safe.url);
      const host = bare(u.hostname);
      const conditional = hop === 0 && !!(o.etag || o.lastModified);
      const headers: Record<string, string> = {
        'user-agent': o.userAgent,
        accept: o.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      };
      if (hop === 0 && o.etag) headers['if-none-match'] = o.etag;
      if (hop === 0 && o.lastModified) headers['if-modified-since'] = o.lastModified;

      let res: IncomingMessage;
      try {
        res = await new Promise<IncomingMessage>((resolve, reject) => {
          const req: ClientRequest = request(u, {
            method: 'GET', headers, agent: false, signal: ac.signal,
            lookup: pinnedLookup(safe.addresses) as any, autoSelectFamily: true,
            // DNS 名：SNI 与证书身份用原主机名；IP 字面量：不发 SNI，证书按 IP 校验
            ...(isIP(host) ? {} : { servername: host }),
            ...(o.tlsOptions ?? {}),
          } as https.RequestOptions, (r) => { got = true; resolve(r); });
          let got = false;
          req.on('error', reject);
          // 协议升级（101）：Node 不调用响应回调也不报错，必须显式拒绝，否则请求永远挂起
          req.on('upgrade', (_r, socket) => { socket.destroy(); reject(Object.assign(new Error('upgrade'), { code: 'ERR_PROTOCOL_UPGRADE' })); });
          // 连接在收到响应之前关闭、或整次被取消：都要落定，不能悬空
          req.on('close', () => { if (!got) reject(Object.assign(new Error('closed'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })); });
          ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          // 连接阶段（到 TLS 握手完成）单独计时，不超过剩余时间
          const ct = Math.max(1, Math.min(o.connectTimeoutMs ?? 10_000, deadline - Date.now()));
          const ctTimer = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), ct);
          req.on('socket', s => s.once('secureConnect', () => clearTimeout(ctTimer)));
          req.on('close', () => clearTimeout(ctTimer));
          req.end();
        });
      } catch (e) {
        return fail(ac.signal.aborted ? 'timeout' : classifyError(e), hop);
      }
      const status = res.statusCode ?? 0;
      const ctype = (res.headers['content-type'] as string | undefined) ?? null;
      const drop = () => { res.destroy(); };

      if (FOLLOW.has(status)) {
        drop();
        if (hop >= maxRedirects) return fail('redirect_invalid', hop);
        const next = nextHop(current, rawHeaderValues(res.rawHeaders, 'location'));
        if (!next) return fail('redirect_invalid', hop);
        current = next;
        continue;
      }
      if (status === 304) {
        drop();
        // 只有第一跳、且确实发送了条件请求头，304 才代表「无更新」
        return conditional ? { outcome: 'not_modified', httpCode: 304, contentType: ctype, latencyMs: Date.now() - t0, hops: 1 }
          : fail('http_3xx', hop, { httpCode: 304 });
      }
      if (status < 200 || status >= 300) {
        drop();
        if (status === 429) {
          const ra = Number(res.headers['retry-after']);
          return fail('rate_limited', hop, { httpCode: 429, contentType: ctype, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) });
        }
        const cls: ErrorClass = status === 408 ? 'http_408' : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'http_3xx';
        return fail(cls, hop, { httpCode: status, contentType: ctype });
      }
      if (o.mode === 'headers') {
        drop();
        return { outcome: 'ok', httpCode: status, contentType: ctype, latencyMs: Date.now() - t0, hops: hop + 1 };
      }

      // 正文：按 content-encoding 流式解压，解压后的字节计数；未知或叠加的编码不接受
      const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate()
        : enc === 'br' ? zlib.createBrotliDecompress() : enc === '' || enc === 'identity' ? null : undefined;
      if (decoder === undefined) { drop(); return fail('decode', hop, { httpCode: status, contentType: ctype }); }
      const chunks: Buffer[] = []; let total = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (ac.signal.aborted) return onAbort();
          ac.signal.addEventListener('abort', onAbort, { once: true });
          // 响应在正文读完之前中断（连接被重置、Content-Length 不足）→ network
          res.on('aborted', () => reject(Object.assign(new Error('premature'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })));
          res.on('error', reject);
          const out: NodeJS.ReadableStream = decoder ? res.pipe(decoder) : res;
          if (decoder) decoder.on('error', (e: any) => reject(Object.assign(e, { code: String(e?.code ?? 'Z_DATA_ERROR') })));
          out.on('data', (c: Buffer) => {
            total += c.byteLength;
            if (total > o.maxBytes) { reject(Object.assign(new Error('too large'), { code: 'ERR_TOO_LARGE' })); return; }
            chunks.push(c);
          });
          out.on('end', () => { if (res.complete) resolve(); else reject(Object.assign(new Error('incomplete'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })); });
        });
      } catch (e) {
        drop(); decoder?.destroy();
        return fail(ac.signal.aborted ? 'timeout' : classifyError(e), hop, { httpCode: status, contentType: ctype });
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return fail('empty', hop, { httpCode: status, contentType: ctype, bytes: 0 });
      const redirected = hop > 0;
      return { outcome: 'ok', httpCode: status, contentType: ctype, body, bytes: total, latencyMs: Date.now() - t0, hops: hop + 1,
        // 发生过重定向：不返回缓存校验值（B 的 ETag 不能存给 A）
        etag: redirected ? null : (res.headers.etag as string | undefined) ?? null,
        lastModified: redirected ? null : (res.headers['last-modified'] as string | undefined) ?? null };
    }
  } finally { clearTimeout(timer); }
}
