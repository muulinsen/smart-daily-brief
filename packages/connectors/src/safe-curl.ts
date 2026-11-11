/**
 * curl 通道（docs/ssrf-redirect-design.md 第 4 版 §4、§11）：只用于 linux.do 与 Cloudflare 质询后的回退。
 *
 * - 每跳单独执行一次 curl，地址校验 / Location 解析 / 跳数上限与 safeHttp 共用；curl 不自行跟随。
 * - 封闭：-q（不读 .curlrc）、--globoff、--noproxy '*'、--proto =https、--max-redirs 0；
 *   --resolve 主机:端口:全部已校验地址（curl 依次尝试，不会自行解析）。
 * - 响应头写进每次请求专用 0700 临时目录里的命名管道（--dump-header <FIFO>，curl 每写一段头都会刷新），正文走 stdout；
 *   不从混合输出里猜正文边界。（不用 /dev/fd/3：Node 给子进程的 pipe 在 Linux 上是 socket，curl 7.81 打不开，退出码 23。）
 *   （分块响应的 trailers 也写在头部管道，不会混进正文）。头部管道累计超过 64 KB 即杀进程。
 * - 读到最终响应头就决定：3xx → 杀进程交给逐跳逻辑；304 / 429 / 带质询标记或 linux.do 的 403 / 其他非 2xx → 立即定类；
 *   只有普通 403 才读最多 4 KB 正文前缀识别质询页；2xx → 解压后字节计数，超限杀进程。
 *   （第 5 轮审查：用 -i 时 curl 不刷新头部，「头到了正文不来」要等到超时；trailers 会拼进正文。）
 * - 进程收尾：error 事件（ENOENT/EACCES → config）；放弃或超时先 SIGTERM，2 秒后 SIGKILL，等待 close。
 * - stderr 只保留前 4 KB，不进入任何错误文本。
 */
import { spawn as nodeSpawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, closeSync, read as fsRead, constants as fsc } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { checkUrlSafe } from './ssrf.ts';
import { FOLLOW, hopText, nextHop, reasonWithoutIp, untilDeadline, type ErrorClass, type SafeCheck, type SafeOpts, type SafeResult } from './safe-http.ts';

/** spawnImpl / curlBin / caFile 只供测试（caFile = 测试服务器的自签 CA）。 */
export type CurlOpts = SafeOpts & { spawnImpl?: typeof nodeSpawn; curlBin?: string; caFile?: string };

const HEADER_LIMIT = 64 * 1024;
/** 启动 curl 失败的本机故障（不存在、无权限、进程或文件句柄耗尽）：按 config 处理，不计全文次数、停止本批。 */
const LOCAL_FAULT = new Set(['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
const PREFIX_LIMIT = 4 * 1024;
const bare = (h: string) => h.replace(/^\[|\]$/g, '');

/** curl 退出码 → 分类。 */
export function curlExitClass(code: number | null): ErrorClass {
  if (code === 6) return 'dns';
  // 16 = HTTP/2 帧层错误，92 = HTTP/2 流错误：都是临时故障
  if ([7, 16, 18, 35, 52, 55, 56, 92].includes(code ?? -1)) return 'network';
  if (code === 28) return 'timeout';
  if (code === 77) return 'config';               // CA 证书文件读不了
  if ([51, 58, 59, 60, 64, 66, 80, 83, 90, 91].includes(code ?? -1)) return 'tls';
  if (code === 63) return 'too_large';
  return 'curl_error';
}

/** 构造一跳的 curl 参数（导出给测试检查）。 */
export function curlArgs(url: string, addresses: string[], o: { userAgent: string; connectSec: number; maxSec: number;
  accept?: string; etag?: string | null; lastModified?: string | null; caFile?: string; headerFile: string }): string[] {
  const u = new URL(url);
  const host = bare(u.hostname);
  const port = u.port || '443';
  const args = ['-q', '-sS', '--dump-header', o.headerFile, '--no-buffer', '--compressed', '--globoff', '--noproxy', '*', '--proto', '=https', '--max-redirs', '0',
    '--connect-timeout', o.connectSec.toFixed(3), '--max-time', o.maxSec.toFixed(3), '-A', o.userAgent,
    '-H', `Accept: ${o.accept ?? 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5'}`];
  if (o.etag) args.push('-H', `If-None-Match: ${o.etag}`);
  if (o.lastModified) args.push('-H', `If-Modified-Since: ${o.lastModified}`);
  if (!isIP(host)) args.push('--resolve', `${host}:${port}:${addresses.map(a => isIP(a) === 6 ? `[${a}]` : a).join(',')}`);
  if (o.caFile) args.push('--cacert', o.caFile);
  args.push('--', url);
  return args;
}

type Head = { status: number; raw: Array<[string, string]> };
/** 从累计的头部输出中解析最终响应头（跳过 1xx）；返回头与之后的剩余字节（trailers 等），未读完返回 null。 */
export function parseHead(buf: Buffer): { head: Head; rest: Buffer } | null {
  let off = 0;
  for (;;) {
    const s = buf.subarray(off);
    let end = s.indexOf('\r\n\r\n'); let sep = 4;
    const lf = s.indexOf('\n\n');
    if (end < 0 || (lf >= 0 && lf < end)) { end = lf; sep = 2; }
    if (end < 0) return null;
    const lines = s.subarray(0, end).toString('latin1').split(/\r?\n/);
    const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? '');
    if (!m) throw Object.assign(new Error('bad head'), { code: 'BAD_HEAD' });
    const status = Number(m[1]);
    off += end + sep;
    if (status >= 100 && status < 200) continue;
    const raw = lines.slice(1).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()] as [string, string]; })
      .filter(([k]) => k);
    return { head: { status, raw }, rest: buf.subarray(off) };
  }
}

/** 结束进程：先 SIGTERM，2 秒后 SIGKILL；等到 close（管道关闭）。 */
function stop(child: ChildProcess, closed: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    return closed.then(() => clearTimeout(t), () => clearTimeout(t));
  }
  return closed.then(() => undefined, () => undefined);
}

export async function safeCurl(url: string, o: CurlOpts): Promise<SafeResult> {
  const t0 = Date.now();
  const deadline = o.deadline ?? t0 + o.timeoutMs;
  const spawn = o.spawnImpl ?? nodeSpawn;
  const check: SafeCheck = o.check ?? ((u, x) => checkUrlSafe(u, x));
  const maxRedirects = o.maxRedirects ?? 3;
  const seen = new Set<string>();
  let current = url;
  let protectedHost = false;
  try { protectedHost = new URL(url).hostname === 'linux.do'; } catch { /* 校验会拒绝 */ }
  const fail = (cls: ErrorClass, hop: number, extra: Partial<SafeResult> = {}): SafeResult => ({
    outcome: cls === 'rate_limited' ? 'rate_limited' : cls === 'empty' ? 'source_anomaly' : 'fetch_failed',
    latencyMs: Date.now() - t0, errorClass: cls, errorMessage: hopText(cls, hop, extra.httpCode), hops: hop + 1, ...extra });

  for (let hop = 0; ; hop++) {
    if (Date.now() >= deadline) return fail('timeout', hop);
    if (seen.has(current)) return fail('redirect_invalid', hop);
    seen.add(current);
    const safe = await untilDeadline(check(current, { deadline, lookup: o.lookup }), deadline);
    if (!safe || Date.now() >= deadline) return fail('timeout', hop);
    if (!safe.ok) return fail(safe.kind === 'blocked' ? 'blocked' : safe.kind, hop,
      hop === 0 && safe.kind === 'blocked' ? { firstHopReason: reasonWithoutIp(safe.reason) } : {});
    // 目标主机冷却中：不发请求；记 cooldown（不重试、不计入初始主机的熔断）
    if (o.beforeHop) {
      const allowed = await untilDeadline(o.beforeHop(safe.url, hop), deadline);
      if (allowed === null) return fail('timeout', hop);
      if (!allowed) return fail('cooldown', hop);
    }
    const left = deadline - Date.now();
    if (left <= 0) return fail('timeout', hop);
    const conditional = hop === 0 && !!(o.etag || o.lastModified);
    const argsFor = (headerFile: string) => curlArgs(safe.url, safe.addresses, {
      userAgent: o.userAgent, accept: o.accept, caFile: o.caFile, etag: hop === 0 ? o.etag : null, lastModified: hop === 0 ? o.lastModified : null,
      connectSec: Math.max(0.1, Math.min(o.connectTimeoutMs ?? 10_000, left) / 1000), maxSec: Math.max(0.1, left / 1000), headerFile });

    // ---- 执行一跳 ----
    type Step = { kind: 'follow'; location: string[] } | { kind: 'done'; result: SafeResult };
    const step = await new Promise<Step>((resolve) => {
      // 头部命名管道：每次请求一个 0700 临时目录；建不了按本机配置故障处理
      let dir = '', fifo = '';
      try { dir = mkdtempSync(join(tmpdir(), 'safe-curl-')); fifo = join(dir, 'h'); execFileSync('mkfifo', ['-m', '600', fifo], { stdio: 'ignore' }); }
      catch { if (dir) rmSync(dir, { recursive: true, force: true }); resolve({ kind: 'done', result: fail('config', hop) }); return; }
      const hopArgs = argsFor(fifo);
      // 读取端非阻塞打开（不占线程池）；自己再占一个写入端，curl 打开之前不会读到「结束」，curl 退出后关掉它
      let rfd = -1, wfd = -1;
      try { rfd = openSync(fifo, fsc.O_RDONLY | fsc.O_NONBLOCK); wfd = openSync(fifo, fsc.O_WRONLY | fsc.O_NONBLOCK); }
      catch { for (const fd of [rfd, wfd]) if (fd >= 0) try { closeSync(fd); } catch { /* 已关闭 */ }
        rmSync(dir, { recursive: true, force: true }); resolve({ kind: 'done', result: fail('config', hop) }); return; }
      const closeWriter = () => { if (wfd >= 0) { try { closeSync(wfd); } catch { /* 已关闭 */ } wfd = -1; } };
      const closeReader = () => { if (rfd >= 0) { try { closeSync(rfd); } catch { /* 已关闭 */ } rfd = -1; } };
      let child: ChildProcess;
      try { child = spawn(o.curlBin ?? 'curl', hopArgs, { stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e: any) { closeWriter(); closeReader(); rmSync(dir, { recursive: true, force: true });
        resolve({ kind: 'done', result: fail(LOCAL_FAULT.has(String(e?.code)) ? 'config' : 'curl_error', hop) }); return; }
      // 头部管道轮询读取（非阻塞 fd：无数据 EAGAIN 稍后再读，读到 0 = 所有写入端都已关闭）。
      // macOS 上 net.Socket 读 FIFO 收不到结束事件，所以不用它。读完头部管道才算这一跳的头部完整。
      let onHeadData: (c: Buffer) => void = () => {};
      const hbuf = Buffer.alloc(16 * 1024);
      const headsDone = new Promise<void>(res => {
        const pump = () => {
          if (rfd < 0) { res(); return; }
          fsRead(rfd, hbuf, 0, hbuf.length, null, (err, n) => {
            if (err) { if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') { setTimeout(pump, 10); return; } res(); return; }
            if (n === 0) { res(); return; }
            onHeadData(Buffer.from(hbuf.subarray(0, n)));
            pump();
          });
        };
        pump();
      });
      const exited = new Promise<[number | null]>((res) => child.on('close', (code) => { closeWriter(); res([code]); }));
      const closed = Promise.all([exited, headsDone]).then(([e]) => { closeReader(); rmSync(dir, { recursive: true, force: true }); return e; });
      let settled = false;
      let headBuf = Buffer.alloc(0); let headBytes = 0; let head: Head | null = null;
      /** 正文：响应头确定之前先缓存（两个管道的先后不保证），之后按上限计数 */
      const chunks: Buffer[] = []; let total = 0;
      /** 普通 403 需要读正文前缀识别质询页 */
      let wantPrefix = false;
      const timer = setTimeout(() => finish({ kind: 'done', result: fail('timeout', hop) }, true), Math.max(1, deadline - Date.now()));
      function finish(s: Step, kill = false) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (kill) void stop(child, closed).then(() => resolve(s)); else resolve(s);
      }
      child.on('error', (e: any) => finish({ kind: 'done', result: fail(LOCAL_FAULT.has(String(e?.code)) ? 'config' : 'curl_error', hop) }, true));
      child.stderr!.on('data', () => { /* 只消费，不保存进错误文本 */ });
      const hv = (name: string) => head?.raw.find(([k]) => k === name)?.[1] ?? null;
      const rateLimited = (status: number) => {
        const ra = hv('retry-after'); const sec = ra && /^\d+$/.test(ra) ? Number(ra) : 0;
        return fail('rate_limited', hop, { httpCode: status, ...(sec > 0 ? { retryAfterMs: sec * 1000 } : {}) });
      };
      const httpFail = (status: number): SafeResult => {
        const cls: ErrorClass = status === 408 ? 'http_408' : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'http_3xx';
        return fail(cls, hop, { httpCode: status });
      };
      /** 普通 403：用正文前缀判断是不是质询页 */
      const judge403 = () => {
        const prefix = Buffer.concat(chunks).toString('utf8').slice(0, PREFIX_LIMIT);
        return /Just a moment|cf-mitigated|__cf_chl/i.test(prefix) ? rateLimited(403) : httpFail(403);
      };
      const onHead = (h: Head) => {
        head = h;
        const st = h.status;
        if (FOLLOW.has(st)) { finish({ kind: 'follow', location: h.raw.filter(([k]) => k === 'location').map(([, v]) => v) }, true); return; }
        if (st === 304) { finish({ kind: 'done', result: conditional ? { outcome: 'not_modified', httpCode: 304, latencyMs: Date.now() - t0, hops: 1 } : fail('http_3xx', hop, { httpCode: 304 }) }, true); return; }
        // 头部已足以定类的不等正文（正文停滞、截断都不能覆盖已确定的限流）
        if (st === 429 || (st === 403 && (protectedHost || !!hv('cf-mitigated')))) { finish({ kind: 'done', result: rateLimited(st) }, true); return; }
        if (st === 403) { wantPrefix = true; if (total >= PREFIX_LIMIT) finish({ kind: 'done', result: judge403() }, true); return; }
        if (st < 200 || st >= 300) { finish({ kind: 'done', result: httpFail(st) }, true); return; }
        if (o.mode === 'headers') { finish({ kind: 'done', result: { outcome: 'ok', httpCode: st, latencyMs: Date.now() - t0, hops: hop + 1 } }, true); return; }
        if (total > o.maxBytes) finish({ kind: 'done', result: fail('too_large', hop, { httpCode: st }) }, true);
      };
      onHeadData = (c: Buffer) => {
        if (settled) return;
        headBytes += c.byteLength;
        if (headBytes > HEADER_LIMIT) { finish({ kind: 'done', result: fail('too_large', hop) }, true); return; }
        if (head) return;   // 最终头之后的内容（trailers）不进入正文，也不需要
        headBuf = Buffer.concat([headBuf, c]);
        let parsed: ReturnType<typeof parseHead>;
        try { parsed = parseHead(headBuf); } catch { finish({ kind: 'done', result: fail('curl_error', hop) }, true); return; }
        if (parsed) onHead(parsed.head);
      };
      child.stdout!.on('data', (c: Buffer) => {
        if (settled) return;
        total += c.byteLength;
        if (wantPrefix) {
          chunks.push(c);
          if (total >= PREFIX_LIMIT) finish({ kind: 'done', result: judge403() }, true);
          return;
        }
        // 头还没到时也按正文上限计数（解压后字节）
        if (total > o.maxBytes) { finish({ kind: 'done', result: fail('too_large', hop, head ? { httpCode: head.status } : {}) }, true); return; }
        chunks.push(c);
      });
      void closed.then(([code]) => {
        if (settled) return;
        if (!head) { finish({ kind: 'done', result: fail(code === 0 ? 'curl_error' : curlExitClass(code), hop) }); return; }
        const status = head.status;
        if (wantPrefix) { finish({ kind: 'done', result: judge403() }); return; }
        if (code !== 0) { finish({ kind: 'done', result: fail(curlExitClass(code), hop, { httpCode: status }) }); return; }
        const body = Buffer.concat(chunks).toString('utf8');
        if (!body.trim()) { finish({ kind: 'done', result: fail('empty', hop, { httpCode: status, bytes: 0 }) }); return; }
        finish({ kind: 'done', result: { outcome: 'ok', httpCode: status, contentType: hv('content-type'), body, bytes: total,
          latencyMs: Date.now() - t0, hops: hop + 1,
          etag: hop > 0 ? null : hv('etag'), lastModified: hop > 0 ? null : hv('last-modified') } });
      });
    });

    // 截止时刻之后才结束的传输不接受成功结果
    if (Date.now() > deadline) return fail('timeout', hop);
    if (step.kind === 'done') return step.result;
    if (hop >= maxRedirects) return fail('redirect_invalid', hop);
    const next = nextHop(current, step.location);
    if (!next) return fail('redirect_invalid', hop);
    current = next;
  }
}
