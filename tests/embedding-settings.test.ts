// 后台「向量模型」设置：登录、CSRF、地址校验、密钥不回显、连通性测试脱敏与限频
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { hashPassword } from '../packages/web/src/auth.ts';

const dir = mkdtempSync(join(tmpdir(), 'emb-settings-'));
const dbpath = join(dir, 'test.db');
const db = openDb(dbpath); migrate(db, 'migrations');
const KEY = 'sk-test-emb-0123456789';
// 本机假的 /embeddings：返回 401 并回显请求内容与密钥，用来验证页面不泄露上游正文
let hits = 0;
const fake = createServer((req, res) => {
  hits++;
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `echo ${req.headers.authorization} ${body}` } }));
  });
});
fake.listen(0, '127.0.0.1'); await once(fake, 'listening');
const fakePort = (fake.address() as any).port;
const env = { ...process.env, DATABASE_PATH: dbpath, SECRETS_PATH: join(dir, 'secrets.enc'), APP_ENCRYPTION_KEY: 'test-master-key',
  TELEGRAM_DATABASE_PATH: join(dir, 'tg.sqlite3'), TELEGRAM_SESSION_PATH: join(dir, 'tg'), TELEGRAM_LOGIN_SOCKET: join(dir, 'tg.sock'),
  REQUEST_DIR: join(dir, 'req'), BACKUP_DIR: join(dir, 'bak'),
  ADMIN_PASSWORD_HASH: hashPassword('test-pass'), ADMIN_TOTP_SECRET: '', ADMIN_PORT: '3198', ADMIN_SECURE_COOKIE: 'false', ADMIN_BASE_URL: 'http://127.0.0.1:3198' };
for (const k of ['EMBEDDING_ENABLED', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS', 'DEDUP_SIM_HIGH', 'DEDUP_SIM_LOW', 'EMBEDDING_API_KEY']) delete (env as any)[k];
let child: ReturnType<typeof spawn> | undefined;
try {
  let logs = '';
  child = spawn(process.execPath, ['apps/web/src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', b => logs += b); child.stderr!.on('data', b => logs += b);
  const base = 'http://127.0.0.1:3198';
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health/live')).ok) break; } catch { /* 启动中 */ } await new Promise(r => setTimeout(r, 50)); }
  const login = await fetch(base + '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-pass' }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const page = await (await fetch(base + '/settings', { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
  assert.ok(page.includes('向量模型（语义去重）') && page.includes('未启用'));
  const save = (o: Record<string, string>) => fetch(base + '/settings/embedding', { method: 'POST', headers: { cookie }, body: new URLSearchParams(o) });

  assert.equal((await save({ enabled: 'on', base_url: 'https://e.example/v1', model: 'm' })).status, 403, '缺 CSRF 被拒');
  assert.equal((await fetch(base + '/settings/embedding', { method: 'POST', body: new URLSearchParams({ csrf }) , redirect: 'manual' })).status, 302, '未登录跳转登录');
  let r = await save({ csrf, enabled: 'on', base_url: 'http://e.example/v1', model: 'm', sim_high: '0.9', sim_low: '0.8' });
  assert.equal(r.status, 400); assert.ok((await r.text()).includes('https'));
  r = await save({ csrf, enabled: 'on', base_url: 'https://e.example/v1?key=abc', model: 'm', sim_high: '0.9', sim_low: '0.8' });
  assert.equal(r.status, 400);
  r = await save({ csrf, enabled: 'on', base_url: 'https://e.example/v1', model: 'm', sim_high: '0.7', sim_low: '0.8' });
  assert.equal(r.status, 400, '阈值顺序错误');
  r = await save({ csrf, enabled: 'on', base_url: `http://127.0.0.1:${fakePort}/v1`, model: 'text-embedding-3-small', dimensions: '', sim_high: '0.9', sim_low: '0.8' });
  assert.equal(r.status, 200);
  let html = await r.text();
  assert.ok(html.includes('向量模型设置已保存') && html.includes('未设置 EMBEDDING_API_KEY'));

  r = await fetch(base + '/settings/secret', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf, name: 'EMBEDDING_API_KEY', value: KEY }) });
  html = await r.text();
  // 保存密钥回到设置 → API Key；向量模型状态在设置 → 模型
  assert.equal(r.status, 200); assert.ok(html.includes('EMBEDDING_API_KEY 已保存') && html.includes('aria-current="page">API Key')); assert.ok(!html.includes(KEY), '密钥不回显');
  html = await (await fetch(base + '/settings', { headers: { cookie } })).text();
  assert.ok(html.includes('已启用，配置有效')); assert.ok(!html.includes(KEY), '密钥不回显');

  r = await fetch(base + '/settings/embedding/test', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf }) });
  html = await r.text();
  assert.equal(r.status, 502); assert.ok(html.includes('连通性测试失败') && html.includes('auth'));
  assert.ok(!html.includes(KEY) && !html.includes('echo'), '页面不含上游正文与密钥');
  assert.equal(hits, 1);
  r = await fetch(base + '/settings/embedding/test', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf }) });
  assert.equal(r.status, 429, '10 秒内重复测试被限频'); assert.equal(hits, 1);

  const audit = (db.prepare(`SELECT group_concat(payload_json, ' ') p FROM audit_events`).get() as any).p ?? '';
  assert.ok(audit.includes('embedding_settings') || audit.includes('text-embedding-3-small')); assert.ok(!audit.includes(KEY));
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!logs.includes(KEY) && !logs.includes('echo'), '服务日志不含密钥与上游正文');
  console.log('✅ 向量模型设置：CSRF、地址与阈值校验、密钥不回显、测试脱敏与限频通过');
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  fake.close(); db.close(); rmSync(dir, { recursive: true, force: true });
}
