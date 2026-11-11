// curl 通道集成验证（docs/ssrf-redirect-design.md §11）：用真实 curl 与本机 HTTPS 测试服务器，
// 逐项输出结果，用于在不同 curl 版本（生产 7.81）上比对行为。不依赖数据库与外网。
//   node tests/curl-integration.test.ts            本机
//   结果中「⚠️」表示该版本 curl 的行为与预期不同（继续跑完，最后以非 0 退出）
//   2026-11-10 已在 curl 8.9.1（本机）与 7.81.0（Ubuntu 22.04 容器，与生产同版本）上全部通过
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { safeCurl } from '../packages/connectors/src/safe-curl.ts';
import type { SafeCheck } from '../packages/connectors/src/safe-http.ts';
import { makeCert, serve, cleanupCert } from './helpers/https-server.ts';

console.log(execFileSync('curl', ['--version'], { encoding: 'utf8' }).split('\n')[0]);
const cert = makeCert(['a.example', 'b.example', 'evil.internal']);
let port = 0;
const srv = await serve(cert, (req, res) => {
  const p = req.url ?? '/';
  if (p === '/final') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (p === '/r302') { res.writeHead(302, { Location: `https://b.example:${port}/final` }); return res.end('moved'); }
  if (p === '/head-only-302') { res.writeHead(302, { Location: `https://b.example:${port}/final` }); res.flushHeaders(); return; }   // 头到了、正文永不来
  if (p === '/slow302') { res.writeHead(302, { Location: `https://b.example:${port}/final` }); res.write('x'); return; }
  if (p === '/trailers') { res.writeHead(200, { 'content-type': 'application/json', Trailer: 'Digest' }); res.write('{"ok":'); res.write('true}'); res.addTrailers({ Digest: 'sha-256=abc' }); return res.end(); }
  if (p === '/429-stall') { res.writeHead(429, { 'retry-after': '30' }); res.flushHeaders(); return; }
  if (p === '/429') { res.writeHead(429, { 'retry-after': '30' }); return res.end('slow down'); }
  if (p === '/to-evil') { res.writeHead(302, { Location: `https://evil.internal:${port}/x` }); return res.end(); }
  if (p === '/dup') { res.setHeader('Location', [`https://b.example:${port}/final`, `https://a.example:${port}/final`]); res.writeHead(302); return res.end(); }
  if (p === '/bomb') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024))); }
  if (p === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.from('{"gz":1}'))); }
  if (p === '/bigheaders') { for (let i = 0; i < 80; i++) res.setHeader(`x-h${i}`, 'v'.repeat(1000)); res.writeHead(200); return res.end('ok'); }
  if (p === '/stall') { res.writeHead(200); res.write('{'); return; }
  if (p === '/etag') { if (req.headers['if-none-match'] === '"A"') { res.writeHead(304); return res.end(); } res.writeHead(200, { etag: '"A"' }); return res.end('a'); }
  res.writeHead(404); res.end();
});
port = srv.port;
const check = (addresses: string[]): SafeCheck => async (u) => {
  const url = new URL(u);
  if (url.protocol !== 'https:') return { ok: false, reason: 'https', kind: 'blocked' };
  if (url.hostname === 'evil.internal') return { ok: false, reason: '内网', kind: 'blocked' };
  return { ok: true, url: url.href, addresses };
};
const base = { timeoutMs: 6000, userAgent: 'curl-int', maxBytes: 1024 * 1024, caFile: cert.caFile, check: check(['127.0.0.1']) };
const A = (p: string) => `https://a.example:${port}${p}`;
let warn = 0;
const row = async (name: string, run: () => Promise<any>, expect: (r: any, ms: number) => boolean) => {
  const t = Date.now();
  let r: any; try { r = await run(); } catch (e: any) { r = { thrown: String(e?.code ?? e?.name) }; }
  const ms = Date.now() - t;
  const good = expect(r, ms);
  if (!good) warn++;
  console.log(`${good ? '✅' : '⚠️'} ${name.padEnd(34)} ${ms}ms  ${JSON.stringify({ outcome: r.outcome, cls: r.errorClass, code: r.httpCode, body: r.body?.slice?.(0, 40), hops: r.hops })}`);
};
try {
  await row('跟随 302', () => safeCurl(A('/r302'), base), r => r.outcome === 'ok' && r.body === '{"ok":true}');
  await row('只有头的 302（正文永不来）', () => safeCurl(A('/head-only-302'), base), (r, ms) => r.outcome === 'ok' && ms < 3000);
  await row('慢重定向正文', () => safeCurl(A('/slow302'), base), (r, ms) => r.outcome === 'ok' && ms < 3000);
  await row('分块 + trailers', () => safeCurl(A('/trailers'), base), r => r.outcome === 'ok' && r.body === '{"ok":true}');
  await row('429 正文停滞', () => safeCurl(A('/429-stall'), base), r => r.outcome === 'rate_limited');
  await row('429', () => safeCurl(A('/429'), base), r => r.outcome === 'rate_limited' && r.retryAfterMs === 30000);
  await row('重定向到内网', () => safeCurl(A('/to-evil'), base), r => r.errorClass === 'blocked');
  await row('重复 Location', () => safeCurl(A('/dup'), base), r => r.errorClass === 'redirect_invalid');
  await row('gzip 炸弹', () => safeCurl(A('/bomb'), base), r => r.errorClass === 'too_large');
  await row('gzip 正文', () => safeCurl(A('/gz'), base), r => r.body === '{"gz":1}');
  await row('头部超过 64KB', () => safeCurl(A('/bigheaders'), base), r => r.errorClass === 'too_large');
  await row('正文停滞超时', () => safeCurl(A('/stall'), { ...base, timeoutMs: 1500 }), (r, ms) => r.errorClass === 'timeout' && ms < 5000);
  await row('条件请求 304', () => safeCurl(A('/etag'), { ...base, etag: '"A"' }), r => r.outcome === 'not_modified');
  await row('多地址（::1 不可用 → 127.0.0.1）', () => safeCurl(A('/final'), { ...base, check: check(['::1', '127.0.0.1']) }), r => r.outcome === 'ok');
  await row('IP 字面量', () => safeCurl(`https://127.0.0.1:${port}/final`, base), r => r.outcome === 'ok');
  await row('证书不含主机名', () => safeCurl(`https://wrong.example:${port}/final`, base), r => r.errorClass === 'tls');
  await row('截止时间极短', () => safeCurl(A('/final'), { ...base, timeoutMs: 1 }), r => r.errorClass === 'timeout');
  console.log(warn ? `\n⚠️ ${warn} 项与预期不同` : '\n✅ 全部符合预期');
  if (warn) process.exitCode = 1;
} finally { await srv.close(); cleanupCert(cert); }
