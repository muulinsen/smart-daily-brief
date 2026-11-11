// 测试用本机 HTTPS 服务器：测试时用 openssl 生成自签证书（含给定的主机名与 127.0.0.1 / ::1），不依赖外网。
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';

export type TestCert = { key: Buffer; cert: Buffer; caFile: string; dir: string };

export function makeCert(names: string[]): TestCert {
  const dir = mkdtempSync(join(tmpdir(), 'safe-fetch-cert-'));
  const cfg = join(dir, 'san.cnf');
  writeFileSync(cfg, `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=test\n[v3]\nsubjectAltName=${
    [...names.map(n => `DNS:${n}`), 'IP:127.0.0.1', 'IP:::1'].join(',')}\nbasicConstraints=critical,CA:TRUE\n`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', join(dir, 'key.pem'),
    '-out', join(dir, 'cert.pem'), '-config', cfg], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')), caFile: join(dir, 'cert.pem'), dir };
}

export type Served = { port: number; requests: Array<{ host: string; path: string; headers: IncomingMessage['headers']; localAddress: string }>;
  close: () => Promise<void> };

/** handler 收到 (req, res, host) ；host 来自 Host 头（不含端口）。 */
export async function serve(cert: TestCert, handler: (req: IncomingMessage, res: ServerResponse, host: string) => void,
  listenHost = '127.0.0.1'): Promise<Served> {
  const requests: Served['requests'] = [];
  const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    requests.push({ host, path: req.url ?? '', headers: req.headers, localAddress: req.socket.localAddress ?? '' });
    handler(req, res, host);
  });
  const sockets = new Set<any>();
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, listenHost, () => r()));
  return { port: (server.address() as AddressInfo).port, requests,
    close: () => new Promise<void>(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

export const cleanupCert = (c: TestCert) => rmSync(c.dir, { recursive: true, force: true });
