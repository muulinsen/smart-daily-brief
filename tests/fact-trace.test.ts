// 实时事实追溯：原文可达性（只看响应头）与搜索结果解析。全部走 safeHttp，用本机 HTTPS 测试服务器。
import https from 'node:https';
import { traceFacts } from '../packages/ai/src/fact-trace.ts';
import { makeCert, serve, cleanupCert } from './helpers/https-server.ts';

const cert = makeCert(['www.apple.com', 'www.bing.com']);
const srv = await serve(cert, (req, res, host) => {
  if (host === 'www.bing.com') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end('<rss><channel><item><title>Apple confirms updates</title><link>https://www.apple.com/newsroom/2026/09/major-updates</link><description>Updates are now available.</description></item></channel></rss>');
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>official'); // 正文永不结束：原文检查只看响应头
});
try {
  const result = await traceFacts('iOS 27 and macOS 27 updates are now available',
    'https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available', {
      check: async (u) => ({ ok: true, url: new URL(u).href, addresses: ['127.0.0.1'] }),
      request: ((u: any, o: any, cb: any) => https.request(u, { ...o, port: srv.port }, cb)) as any,
      tlsOptions: { ca: cert.cert }, timeoutMs: 3000 });
  if (result.origin?.reachable !== true || result.results.length !== 1 || srv.requests.length !== 2)
    throw new Error(`fact trace failed: ${JSON.stringify(result)}`);
  console.log('✅ 实时事实追溯：原文可访问（不读正文）且搜索结果可解析');
} finally { await srv.close(); cleanupCert(cert); }
