// 出站安全抓取（docs/ssrf-redirect-design.md 第 4 版 §9、§11）：safeHttp 与 safeCurl。
// 全部用本机 HTTPS 测试服务器与注入的地址校验，不依赖外网。
import assert from 'node:assert/strict';
import https from 'node:https';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeHttp, RETRYABLE, rawHeaderValues, nextHop, classifyError, type SafeCheck } from '../packages/connectors/src/safe-http.ts';
import { safeCurl, curlArgs, curlExitClass, parseHead } from '../packages/connectors/src/safe-curl.ts';
import { HostGroup } from '../packages/connectors/src/throttle.ts';
import { makeCert, serve, cleanupCert } from './helpers/https-server.ts';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { recordFulltextFailure, resetTransientFulltext } from '../apps/worker/src/fulltext-store.ts';
import { storableUrl } from '../packages/web/src/actions.ts';

const ok = (m: string) => console.log(`  ✅ ${m}`);
const NAMES = ['a.example', 'b.example', 'c.example', 'evil.internal', 'linux.do'];
const cert = makeCert(NAMES);
const tls = { ca: cert.cert };
/** 模拟地址校验：https 才放行；evil.internal 拒绝；其余主机「解析」到给定地址。记录调用次数。 */
const calls: string[] = [];
const mkCheck = (addresses = ['127.0.0.1']): SafeCheck => async (u) => {
  calls.push(u);
  let url: URL; try { url = new URL(u); } catch { return { ok: false, reason: 'URL 格式非法', kind: 'blocked' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: '只允许 https', kind: 'blocked' };
  if (url.hostname === 'evil.internal') return { ok: false, reason: 'evil.internal 解析到 10.0.0.5（私有网段）', kind: 'blocked' };
  return { ok: true, url: url.href, addresses };
};
const base = { timeoutMs: 3000, userAgent: 'test', maxBytes: 1024 * 1024, tlsOptions: tls, check: mkCheck() };

let srv = await serve(cert, (req, res, host) => {
  const p = req.url ?? '/';
  const go = (code: number, loc: string | string[]) => { res.writeHead(code, { Location: loc as any }); res.end('moved'); };
  if (p.startsWith('/r/')) { const code = Number(p.slice(3, 6)); return go(code, `https://b.example:${port}/final`); }
  if (p === '/final') { res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"B"' }); return res.end('<rss>final</rss>'); }
  if (p === '/etag') { if (req.headers['if-none-match'] === '"A"') { res.writeHead(304); return res.end(); } res.writeHead(200, { etag: '"A"' }); return res.end('<rss>a</rss>'); }
  if (p === '/bare304') { res.writeHead(304); return res.end(); }
  if (p === '/300') return go(300, `https://b.example:${port}/final`);
  if (p === '/noloc') { res.writeHead(302); return res.end(); }
  if (p === '/dup') { res.setHeader('Location', [`https://b.example:${port}/final`, `https://c.example:${port}/final`]); res.writeHead(302); return res.end(); }
  if (p === '/loop') return go(302, `https://a.example:${port}/loop`);
  if (p.startsWith('/chain/')) { const n = Number(p.slice(7)); return go(302, `https://a.example:${port}/chain/${n + 1}`); }
  if (p === '/to-evil') return go(302, `https://evil.internal:${port}/admin`);
  if (p === '/to-http') return go(302, `http://b.example:${port}/final`);
  if (p === '/admin') { res.writeHead(200); return res.end('SECRET-ADMIN'); }
  if (p === '/bomb') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024))); }
  if (p === '/chunked-big') { res.writeHead(200); const b = Buffer.alloc(64 * 1024, 97); let i = 0; const t = setInterval(() => { if (i++ > 40) { clearInterval(t); res.end(); } else res.write(b); }, 1); return; }
  if (p === '/badgzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(Buffer.from('not gzip at all')); }
  if (p === '/compress') { res.writeHead(200, { 'content-encoding': 'compress' }); return res.end('x'); }
  if (p === '/truncated') { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); setTimeout(() => res.socket?.destroy(), 20); return; }
  if (p === '/stall') { res.writeHead(200); res.write('<rss>'); return; }
  if (p === '/slow302') { res.writeHead(302, { Location: `https://b.example:${port}/final` }); res.write('x'); return; }   // 头到了、正文永不结束
  if (p === '/101') { res.socket!.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); return; }   // 协议升级后不再有任何响应
  if (p === '/408') { res.writeHead(408); return res.end(); }
  if (p === '/429') { res.writeHead(429, { 'retry-after': '30' }); return res.end(); }
  if (p === '/503') { res.writeHead(503); return res.end(); }
  if (p === '/403cf') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<html>Just a moment...</html>'); }
  if (p === '/bigheaders') { for (let i = 0; i < 80; i++) res.setHeader(`x-h${i}`, 'v'.repeat(1000)); res.writeHead(200); return res.end('ok'); }
  if (p === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.from('<rss>gz</rss>'))); }
  res.writeHead(404); res.end();
});
let port = srv.port;
const A = (p: string) => `https://a.example:${port}${p}`;

try {
  console.log('safeHttp：');
  // ---- 跟随与重定向规则 ----
  for (const code of [301, 302, 303, 307, 308]) {
    const r = await safeHttp(A(`/r/${code}`), base);
    assert.equal(r.outcome, 'ok', `${code}`); assert.equal(r.body, '<rss>final</rss>'); assert.equal(r.hops, 2);
    assert.equal(r.etag, null, '重定向后的 200 不返回 etag');
  }
  assert.equal((await safeHttp(A('/300'), base)).errorClass, 'http_3xx');
  assert.equal((await safeHttp(A('/noloc'), base)).errorClass, 'redirect_invalid');
  assert.equal((await safeHttp(A('/dup'), base)).errorClass, 'redirect_invalid', '重复的 Location 被拒（读 rawHeaders）');
  assert.equal((await safeHttp(A('/loop'), base)).errorClass, 'redirect_invalid');
  assert.equal((await safeHttp(A('/chain/0'), { ...base, maxRedirects: 3 })).errorClass, 'redirect_invalid');
  ok('只跟随 301/302/303/307/308；300、缺失或重复 Location、循环、超过跳数上限都被拒');

  const before = srv.requests.length;
  const evil = await safeHttp(A('/to-evil'), base);
  assert.equal(evil.errorClass, 'blocked'); assert.match(evil.errorMessage!, /第 2 跳/);
  assert.ok(!/10\.0\.0\.5|evil/.test(evil.errorMessage!), '错误文本不含地址'); assert.equal(evil.firstHopReason, undefined);
  assert.ok(!srv.requests.slice(before).some(x => x.host === 'evil.internal'), '指向内网的跳转目标没有被请求');
  assert.equal((await safeHttp(A('/to-http'), base)).errorClass, 'blocked', 'https → http 降级被拒');
  const first = await safeHttp(`https://evil.internal:${port}/admin`, base);
  assert.equal(first.errorClass, 'blocked'); assert.ok(first.firstHopReason && !first.firstHopReason.includes('10.0.0.5'), '第一跳原因给管理员看但不含 IP');
  ok('重定向到内网 / 降级为 http 被拒且不请求；错误文本不含地址');

  // ---- 地址固定：连接只用校验过的地址，不再解析 ----
  const remotes: string[] = [];
  const spy: typeof https.request = ((u: any, o: any, cb: any) => { const req = https.request(u, o, cb); req.on('socket', s => s.once('connect', () => remotes.push(s.remoteAddress!))); return req; }) as any;
  calls.length = 0;
  // pinned.example 在真实 DNS 里不存在：只要连接时重新解析就会失败
  const pin = await safeHttp(`https://a.example:${port}/final`, { ...base, request: spy });
  assert.equal(pin.outcome, 'ok'); assert.deepEqual(remotes, ['127.0.0.1']); assert.equal(calls.length, 1, '每跳只校验（解析）一次');
  const nx = await safeHttp(`https://no-such-host.invalid:${port}/final`, { ...base, request: spy, tlsOptions: { ...tls, rejectUnauthorized: false } });
  assert.equal(nx.outcome, 'ok', '连接用的是校验给出的地址，不做系统 DNS 解析（.invalid 根本解析不了）');
  // 多个已校验地址：第一个不可用（::1 上没有监听）→ 换下一个
  const multi = await safeHttp(A('/final'), { ...base, check: mkCheck(['::1', '127.0.0.1']) });
  assert.equal(multi.outcome, 'ok', '已校验地址依次尝试');
  const none = await safeHttp(A('/final'), { ...base, check: mkCheck(['::1']) });
  assert.equal(none.errorClass, 'network', '全部地址不可用 → network');
  ok('DNS 重绑定：连接只用校验过的地址（socket 远端地址、校验只调用一次、不可解析的名字也能连上）；多地址依次尝试');

  // ---- 截止时间 ----
  const t0 = Date.now();
  const stallCheck = await safeHttp(A('/final'), { ...base, timeoutMs: 150, check: () => new Promise(() => {}) as any });
  assert.ok(Date.now() - t0 < 1500); void stallCheck;
  const tc = await safeHttp(A('/final'), { ...base, timeoutMs: 150, check: async (u, x) => { await new Promise(r => setTimeout(r, 300)); return mkCheck()(u, x); } });
  assert.equal(tc.errorClass, 'timeout', 'DNS 慢于截止时间 → timeout');
  const t1 = Date.now();
  assert.equal((await safeHttp(A('/stall'), { ...base, timeoutMs: 300 })).errorClass, 'timeout'); assert.ok(Date.now() - t1 < 1500, '正文停滞也受截止时间约束');
  const hdr = await safeHttp(A('/stall'), { ...base, mode: 'headers', timeoutMs: 2000 });
  assert.equal(hdr.outcome, 'ok', 'headers 模式拿到响应头即返回，不等正文');
  ok('截止时间覆盖地址校验与正文；headers 模式不读正文');

  // ---- 体积、解压、截断 ----
  assert.equal((await safeHttp(A('/bomb'), base)).errorClass, 'too_large', 'gzip 炸弹按解压后字节计数');
  assert.equal((await safeHttp(A('/chunked-big'), base)).errorClass, 'too_large', '无长度的分块响应同样受限');
  assert.equal((await safeHttp(A('/badgzip'), base)).errorClass, 'decode');
  assert.equal((await safeHttp(A('/compress'), base)).errorClass, 'decode', '未知编码不接受');
  assert.equal((await safeHttp(A('/truncated'), base)).errorClass, 'network', '截断不能当成功');
  assert.equal((await safeHttp(A('/gz'), base)).body, '<rss>gz</rss>');
  ok('体积按解压后计数；解码错误、未知编码、截断都按失败处理');

  // ---- 条件请求 ----
  const e1 = await safeHttp(A('/etag'), base); assert.equal(e1.etag, '"A"');
  assert.equal((await safeHttp(A('/etag'), { ...base, etag: '"A"' })).outcome, 'not_modified');
  assert.equal((await safeHttp(A('/bare304'), base)).errorClass, 'http_3xx', '没发条件请求头却收到 304 → 失败');
  const n0 = srv.requests.length;
  await safeHttp(A('/r/302'), { ...base, etag: '"X"' });
  const sent = srv.requests.slice(n0);
  assert.equal(sent[0]!.headers['if-none-match'], '"X"'); assert.equal(sent[1]!.headers['if-none-match'], undefined, '条件请求头只在第一跳');
  ok('条件请求只在第一跳；304 只有发送了条件头才算无更新；重定向后不返回 etag');

  // ---- 状态码与分类 ----
  const tu = Date.now();
  const up = await safeHttp(A('/101'), { ...base, timeoutMs: 5000 });
  assert.ok(up.outcome === 'fetch_failed' && Date.now() - tu < 3000, `协议升级响应不挂起（${up.errorClass}，${Date.now() - tu}ms）`);
  assert.equal((await safeHttp(A('/408'), base)).errorClass, 'http_408');
  const rl = await safeHttp(A('/429'), base); assert.equal(rl.outcome, 'rate_limited'); assert.equal(rl.retryAfterMs, 30000);
  assert.equal((await safeHttp(A('/503'), base)).errorClass, 'http_5xx');
  assert.ok(RETRYABLE.has('dns') && RETRYABLE.has('http_408') && !RETRYABLE.has('blocked') && !RETRYABLE.has('decode') && !RETRYABLE.has('config'));
  assert.equal(classifyError({ code: 'ECONNRESET' }), 'network'); assert.equal(classifyError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'tls');
  assert.equal(classifyError({ code: 'Z_DATA_ERROR' }), 'decode'); assert.equal(classifyError({ name: 'AbortError' }), 'timeout');
  ok('408 / 429 / 5xx 分类；可重试集合含 dns、408，不含 blocked、decode、config；异常只按错误码分类');

  // ---- TLS 身份 ----
  const wrong = await safeHttp(`https://wrong-name.example:${port}/final`, base);
  assert.equal(wrong.errorClass, 'tls', '证书不含该主机名 → tls（不因固定 IP 放宽证书校验）');
  const ipLit = await safeHttp(`https://127.0.0.1:${port}/final`, { ...base });
  assert.equal(ipLit.outcome, 'ok', 'IP 字面量：证书按 IP 校验');
  ok('证书按原主机名校验；IP 字面量按 IP 校验');

  // ---- 每跳限流与冷却 ----
  const hops: Array<[string, number]> = [];
  const r1 = await safeHttp(A('/r/302'), { ...base, beforeHop: async (u, h) => { hops.push([new URL(u).hostname, h]); return true; } });
  assert.equal(r1.outcome, 'ok'); assert.deepEqual(hops, [['a.example', 0], ['b.example', 1]]);
  const n1 = srv.requests.length;
  const cool = await safeHttp(A('/r/302'), { ...base, beforeHop: async (u) => new URL(u).hostname !== 'b.example' });
  assert.equal(cool.errorClass, 'cooldown'); assert.equal(cool.outcome, 'fetch_failed', '冷却跳过不记 rate_limited（不计入初始主机熔断）');
  assert.ok(!srv.requests.slice(n1).some(x => x.host === 'b.example'), '冷却中的主机没有被请求');
  const g = new HostGroup('g', { concurrency: 1, min_interval_ms: 120, timeout_ms: 1000, max_retries: 0 });
  const tp = Date.now(); await g.run(async () => { await g.pace(); });
  assert.ok(Date.now() - tp >= 110, 'pace 在持有本组许可时等间隔、不死锁');
  ok('每跳都经过限流与熔断检查；冷却中的目标不请求；pace 不死锁');

  // ---- curl 通道 ----
  console.log('\nsafeCurl（本机 curl）：');
  const cbase = { ...base, caFile: cert.caFile, tlsOptions: undefined };
  const args = curlArgs(`https://a.example:${port}/x`, ['::1', '127.0.0.1'], { userAgent: 'u', connectSec: 5, maxSec: 10, headerFile: '/tmp/safe-curl-x/h' });
  assert.equal(args[0], '-q', '-q 必须是第一个参数');
  for (const a of ['--globoff', '--compressed', '--no-buffer']) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf('--dump-header') + 1], '/tmp/safe-curl-x/h', '响应头走独立的命名管道'); assert.ok(!args.includes('-i'), '不再用 -i 混合输出');
  assert.deepEqual(args.slice(args.indexOf('--noproxy'), args.indexOf('--noproxy') + 2), ['--noproxy', '*']);
  assert.deepEqual(args.slice(args.indexOf('--proto'), args.indexOf('--proto') + 2), ['--proto', '=https']);
  assert.deepEqual(args.slice(args.indexOf('--max-redirs'), args.indexOf('--max-redirs') + 2), ['--max-redirs', '0']);
  assert.equal(args[args.indexOf('--resolve') + 1], `a.example:${port}:[::1],127.0.0.1`, '--resolve 用实际端口、全部已校验地址、IPv6 加方括号');
  assert.ok(!args.includes('-L'));
  assert.ok(!curlArgs('https://127.0.0.1/x', ['127.0.0.1'], { userAgent: 'u', connectSec: 1, maxSec: 1, headerFile: '/tmp/h' }).includes('--resolve'), 'IP 字面量不加 --resolve');
  ok('curl 参数封闭：-q 首位、--globoff、--noproxy *、--proto =https、--max-redirs 0、--resolve 实际端口');

  const c1 = await safeCurl(A('/r/302'), cbase);
  assert.equal(c1.outcome, 'ok', JSON.stringify(c1)); assert.equal(c1.body, '<rss>final</rss>'); assert.equal(c1.hops, 2); assert.equal(c1.etag, null);
  const nc = srv.requests.length;
  const c2 = await safeCurl(A('/to-evil'), cbase);
  assert.equal(c2.errorClass, 'blocked'); assert.ok(!srv.requests.slice(nc).some(x => x.host === 'evil.internal'));
  assert.equal((await safeCurl(A('/dup'), cbase)).errorClass, 'redirect_invalid');
  assert.equal((await safeCurl(A('/bomb'), cbase)).errorClass, 'too_large', 'curl 按解压后字节计数，超限杀进程');
  assert.equal((await safeCurl(A('/bigheaders'), cbase)).errorClass, 'too_large', '响应头超过 64 KB 杀进程');
  const ts = Date.now();
  const slow = await safeCurl(A('/slow302'), { ...cbase, timeoutMs: 8000 });
  assert.equal(slow.outcome, 'ok', '慢重定向正文不阻止跳转'); assert.ok(Date.now() - ts < 4000, `读到 3xx 头立即跳转（${Date.now() - ts}ms）`);
  const cf = await safeCurl(A('/403cf'), cbase); assert.equal(cf.outcome, 'rate_limited', '质询页 → 限流');
  assert.equal((await safeCurl(A('/gz'), cbase)).body, '<rss>gz</rss>');
  assert.equal((await safeCurl(A('/etag'), { ...cbase, etag: '"A"' })).outcome, 'not_modified');
  const cnone = await safeCurl(A('/final'), { ...cbase, check: mkCheck(['::1', '127.0.0.1']) });
  assert.equal(cnone.outcome, 'ok', 'curl 在已校验地址间依次尝试');
  const cfg = await safeCurl(A('/final'), { ...cbase, curlBin: '/nonexistent/curl' });
  assert.equal(cfg.errorClass, 'config', 'curl 不存在 → config（不按网络故障重试、不判死全文）');
  const tstall = Date.now();
  assert.equal((await safeCurl(A('/stall'), { ...cbase, timeoutMs: 1200 })).errorClass, 'timeout'); assert.ok(Date.now() - tstall < 6000, '超时后进程被结束');
  assert.deepEqual([curlExitClass(6), curlExitClass(7), curlExitClass(16), curlExitClass(18), curlExitClass(92), curlExitClass(28), curlExitClass(60), curlExitClass(63), curlExitClass(77), curlExitClass(3)],
    ['dns', 'network', 'network', 'network', 'network', 'timeout', 'tls', 'too_large', 'config', 'curl_error']);
  // 本机资源耗尽启动失败 → config（不判死全文）
  for (const code of ['EAGAIN', 'EMFILE']) {
    const r = await safeCurl(A('/final'), { ...cbase, spawnImpl: (() => { throw Object.assign(new Error('x'), { code }); }) as any });
    assert.equal(r.errorClass, 'config', code);
  }
  // 截止时刻之后结束的传输不返回成功
  const late = await safeCurl(A('/final'), { ...cbase, timeoutMs: 1 });
  assert.equal(late.errorClass, 'timeout', '截止时间极短时不接受成功');
  const ph = parseHead(Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/2 302\r\nLocation: /a\r\nlocation: /b\r\n\r\nbody'));
  assert.equal(ph!.head.status, 302); assert.equal(ph!.head.raw.filter(([k]) => k === 'location').length, 2); assert.equal(ph!.rest.toString(), 'body');
  ok('curl：逐跳校验与跟随、内网目标不请求、重复 Location、体积与头部上限、慢重定向正文、质询、条件请求、多地址、配置错误、超时收尾、退出码分类');

  // ---- 纯函数 ----
  assert.deepEqual(rawHeaderValues(['Location', 'a', 'X', 'y', 'location', 'b'], 'location'), ['a', 'b']);
  assert.equal(nextHop('https://a.example/x/y', ['../z#frag']), 'https://a.example/z'); assert.equal(nextHop('https://a.example/', ['a', 'b']), null);

  // ---- 全文写回与恢复 ----
  console.log('\n全文写回与恢复：');
  const dir = mkdtempSync(join(tmpdir(), 'safe-fetch-db-'));
  const db = openDb(join(dir, 'b.db')); migrate(db, 'migrations');
  const T = new Date().toISOString();
  db.prepare(`INSERT INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,created_at,updated_at) VALUES('s','s','s','tech','direct','standard','{}',1,?,?)`).run(T, T);
  const ver = (status: string | null, error: string | null, attempts: number, at = T) => {
    const id = Number(db.prepare(`INSERT INTO feed_items(source_id,source_item_key,key_kind,first_seen_at,last_seen_at,created_at) VALUES('s',?,'guid',?,?,?)`).run(Math.random().toString(36), T, T, T).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO item_versions(item_id,content_hash,raw_hash,title,clean_text,discovered_at,version_no,fulltext_status,fulltext_error,fulltext_attempts,fulltext_fetched_at,fulltext_text)
      VALUES(?,?,?,?,?,?,1,?,?,?,?,?)`).run(id, String(Math.random()), 'r', 't', 'c', T, status, error, attempts, at, status === 'ok' ? 'GOOD TEXT' : null).lastInsertRowid);
  };
  const row = (id: number) => db.prepare('SELECT fulltext_status s, fulltext_attempts n, fulltext_text t FROM item_versions WHERE id=?').get(id) as any;
  const f = (cls: string) => ({ url: 'https://x', errorClass: cls, error: `${cls}:`, gateReason: 'g', signalsJson: '{}', prescreenJson: '[]', at: T });
  const v1 = ver(null, null, 0);
  recordFulltextFailure(db, v1, f('network')); assert.deepEqual([row(v1).s, row(v1).n], [null, 1], '临时失败：次数 +1、状态保持 NULL');
  recordFulltextFailure(db, v1, f('timeout')); recordFulltextFailure(db, v1, f('dns'));
  assert.deepEqual([row(v1).s, row(v1).n], ['failed', 3], '次数用完写 failed');
  const v2 = ver(null, null, 0); recordFulltextFailure(db, v2, f('blocked')); assert.equal(row(v2).s, 'failed', '不可重试类直接 failed');
  const v3 = ver('ok', null, 1);
  assert.equal(recordFulltextFailure(db, v3, f('network')), false); assert.deepEqual([row(v3).s, row(v3).t], ['ok', 'GOOD TEXT'], '晚到的失败不覆盖已成功的全文');
  const old5 = ver('failed', 'fetch_failed:503', 1), old6 = ver('failed', 'fetch_failed:404', 1);
  const old1 = ver('failed', 'fetch_failed:network', 1), old2 = ver('failed', 'fetch_failed:http_4xx', 1), old3 = ver('failed', 'parse:', 1),
    old4 = ver('failed', 'fetch_failed:timeout', 1, new Date(Date.now() - 10 * 864e5).toISOString()), unk = ver('failed', 'JSON 解析失败: Unexpected', 1);
  const n = resetTransientFulltext(db, 3);
  assert.deepEqual([row(old1).s, row(old2).s, row(old3).s, row(old4).s, row(unk).s, row(v1).s], [null, 'failed', 'failed', 'failed', 'failed', null]);
  assert.deepEqual([row(old5).s, row(old6).s], [null, 'failed'], '旧格式数字 5xx 可恢复，4xx 不动');
  assert.equal(n, 3, '只恢复最近 N 天内的临时故障（新旧格式），4xx、解析失败、未知格式、过期的不动');
  db.close(); rmSync(dir, { recursive: true, force: true });
  ok('全文：临时失败保持待抓、用完才 failed；晚到失败不覆盖成功；--reset-transient 只恢复临时故障');

  assert.equal(storableUrl('https://user:pa55@x.example/feed?a=1'), 'https://x.example/feed?a=1');
  assert.equal(storableUrl('user:pa55@x.example'), '（无法解析的地址）');
  ok('来源测试记录的地址去掉用户名口令');
  console.log('\n✅ 全部通过');
} finally {
  await srv.close(); cleanupCert(cert);
}
