// 数据库备份开关：读写与容错、提醒规则、维护任务与 Google Drive 脚本按开关执行、后台路由（登录/CSRF/审计）
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { readBackupSettings, readGdriveStatus, writeBackupSettings } from '../packages/web/src/backup-settings.ts';
import { computeAlerts, type AlertInput } from '../packages/web/src/ops.ts';
import { hashPassword } from '../packages/web/src/auth.ts';

const dir = mkdtempSync(join(tmpdir(), 'backup-settings-'));
const ok = (name: string) => console.log(`  ✅ ${name}`);
const settings = join(dir, 'backup-settings.json');
let child: ReturnType<typeof spawn> | undefined;
try {
  // ---- 读写与容错 ----
  assert.deepEqual(readBackupSettings(settings), { local: true, gdrive: true, updatedAt: null });
  writeFileSync(settings, '{broken');
  const broken = readBackupSettings(settings);
  assert.ok(broken.local && broken.gdrive && broken.error, '损坏时按全部开启处理');
  writeFileSync(settings, '{"local":"no"}');
  assert.ok(readBackupSettings(settings).local, '只有明确写成 false 才算关闭');
  const w = writeBackupSettings({ local: false, gdrive: true }, settings);
  assert.equal(readBackupSettings(settings).local, false); assert.ok(w.updatedAt);
  assert.equal(statSync(settings).mode & 0o777, 0o644, 'root 运行的脚本需要可读');
  assert.ok(!readdirSync(dir).some(f => f.endsWith('.tmp')), '原子写入不留临时文件');
  ok('开关读写：缺失或损坏按开启处理，只有明确关闭才关闭，原子写入');

  const st = join(dir, 'gdrive.status');
  writeFileSync(st, 'OK 2026-11-06T20:31:50Z briefing-20261106-201002.tar.zst\n');
  assert.equal(readGdriveStatus(st).state, 'OK');
  writeFileSync(st, 'FAIL 2026-11-06T20:31:50Z exit=1\n'); assert.equal(readGdriveStatus(st).state, 'FAIL');
  writeFileSync(st, 'garbage'); assert.equal(readGdriveStatus(st).state, 'UNKNOWN');
  assert.equal(readGdriveStatus(join(dir, 'none')).state, 'UNKNOWN');
  ok('Google Drive 状态行解析');

  // ---- 提醒 ----
  const now = Date.parse('2026-11-07T12:00:00Z');
  const base: AlertInput = { now, units: [], disk: null, runs: [], sources: [],
    backups: [{ name: 'brief', label: '日报数据库', file: null, bytes: 0, mtime: null }],
    telegram: { authorized: true, heartbeatAt: new Date(now).toISOString(), sources: [], visionPaused: false, visionPauseReason: null, visionBacklog: 0, visionDailyLimit: 1, failedSummaries: 0 } } as any;
  const titles = (o: Partial<AlertInput>) => computeAlerts({ ...base, ...o } as AlertInput).map(a => a.title);
  assert.ok(titles({}).some(t => t.includes('没有新备份')), '默认开启时缺备份要提醒');
  assert.ok(!titles({ backupSettings: { local: false, gdrive: true } }).some(t => t.includes('没有新备份')), '本机备份关闭后不再报缺备份');
  assert.ok(titles({ backupSettings: { local: false, gdrive: false } }).includes('数据库备份已全部关闭'));
  assert.ok(titles({ gdrive: { state: 'FAIL', at: now - 3600e3, detail: 'exit=1' } }).includes('Google Drive 备份失败'));
  assert.ok(titles({ gdrive: { state: 'OK', at: now - 40 * 3600e3, detail: '' } }).some(t => t.includes('36 小时')));
  assert.ok(!titles({ backupSettings: { local: true, gdrive: false }, gdrive: { state: 'FAIL', at: now, detail: '' } }).some(t => t.includes('Google Drive')), 'Google Drive 关闭后不再报它的失败');
  assert.ok(titles({ backupSettings: { local: false, gdrive: true }, gdrive: { state: 'UNKNOWN', at: null, detail: '没有找到记录' } }).includes('Google Drive 备份没有可核实的记录'), '它是唯一开着的备份时，状态未知也要提醒');
  ok('提醒：关闭的备份不报缺失，全部关闭时提醒，Google Drive 失败或过期时提醒');

  // ---- Google Drive 脚本按开关跳过 ----
  const script = join(process.cwd(), 'deploy/scripts/briefing-gdrive-backup.sh');
  // 用假的 sqlite3 / rclone 拦住真实备份：sqlite3 立即失败，rclone 被调用就留下记号（绝不能碰真实数据库与 Google Drive）
  const stub = join(dir, 'stub'); const rcloneMark = join(dir, 'rclone-called');
  spawnSync('mkdir', ['-p', stub]);
  writeFileSync(join(stub, 'sqlite3'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  writeFileSync(join(stub, 'rclone'), `#!/bin/sh\ntouch '${rcloneMark}'\nexit 9\n`, { mode: 0o755 });
  const runScript = (s: string) => spawnSync('bash', [script], { encoding: 'utf8',
    env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, BACKUP_SETTINGS_PATH: s, GDRIVE_BACKUP_STATUS_PATH: st, GDRIVE_BACKUP_TMP_PARENT: dir } });
  writeBackupSettings({ local: true, gdrive: false }, settings);
  let r = runScript(settings);
  assert.equal(r.status, 0, r.stderr); assert.match(readFileSync(st, 'utf8'), /^SKIP /);
  writeFileSync(settings, '{broken');
  r = runScript(settings);
  assert.notEqual(r.status, 0, '开关损坏时照常进入备份（假 sqlite3 在第一步失败）');
  assert.match(readFileSync(st, 'utf8'), /^FAIL /);
  assert.ok(!existsSync(rcloneMark), '测试中绝不调用 rclone');
  assert.ok(!readdirSync(dir).some(f => f.startsWith('gdrive-backup.')), '临时目录在结束时清理');
  ok('Google Drive 脚本：关闭时写 SKIP 并跳过；开关文件损坏时照常执行');

  // ---- 维护任务按本机备份开关执行 ----
  const dbpath = join(dir, 'brief.db'); const tg = join(dir, 'tg.sqlite3'); const bak = join(dir, 'backups');
  { const db = openDb(dbpath); migrate(db, 'migrations'); db.close(); }
  const maintain = (s: string) => spawnSync(process.execPath, ['apps/worker/src/maintain.ts'], { encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: dbpath, TELEGRAM_DATABASE_PATH: tg, BACKUP_DIR: bak, SNAPSHOT_DIR: join(dir, 'snap'), BACKUP_SETTINGS_PATH: s } });
  writeBackupSettings({ local: false, gdrive: true }, settings);
  r = maintain(settings);
  assert.equal(r.status, 0, r.stderr); assert.ok(r.stdout.includes('本机备份已在后台关闭'));
  assert.ok(!existsSync(bak) || !readdirSync(bak).some(f => f.endsWith('.db.gz')), '关闭时不生成备份');
  writeBackupSettings({ local: true, gdrive: true }, settings);
  r = maintain(settings);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readdirSync(bak).some(f => /^brief-.*\.db\.gz$/.test(f)) && readdirSync(bak).some(f => /^telegram-.*\.db\.gz$/.test(f)), '开启时照常备份两个库');
  ok('维护任务：本机备份关闭时跳过、开启时照常备份');

  // ---- 后台路由 ----
  const env = { ...process.env, DATABASE_PATH: dbpath, TELEGRAM_DATABASE_PATH: tg, TELEGRAM_SESSION_PATH: join(dir, 'tgs'), TELEGRAM_LOGIN_SOCKET: join(dir, 'tg.sock'),
    SECRETS_PATH: join(dir, 'secrets.enc'), REQUEST_DIR: join(dir, 'req'), BACKUP_DIR: bak, BACKUP_SETTINGS_PATH: settings, GDRIVE_BACKUP_STATUS_PATH: st,
    ADMIN_PASSWORD_HASH: hashPassword('test-pass'), ADMIN_TOTP_SECRET: '', ADMIN_PORT: '3199', ADMIN_SECURE_COOKIE: 'false', ADMIN_BASE_URL: 'http://127.0.0.1:3199' };
  child = spawn(process.execPath, ['apps/web/src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const baseUrl = 'http://127.0.0.1:3199';
  for (let i = 0; i < 100; i++) { try { if ((await fetch(baseUrl + '/health/live')).ok) break; } catch { /* 启动中 */ } await new Promise(res => setTimeout(res, 50)); }
  const login = await fetch(baseUrl + '/login', { method: 'POST', body: new URLSearchParams({ password: 'test-pass' }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  // 开关在设置 → 数据保留与备份；系统运行只读显示状态与「去设置」链接
  const page = await (await fetch(baseUrl + '/settings?tab=data', { headers: { cookie } })).text();
  assert.ok(page.includes('本机每日备份') && page.includes('Google Drive 备份') && page.includes('action="/system/backups"'));
  assert.ok(!page.includes('&lt;span'), 'Google Drive 状态标签不能被转义成源码显示');
  const sys = await (await fetch(baseUrl + '/system', { headers: { cookie } })).text();
  assert.ok(sys.includes('本机每日备份') && sys.includes('/settings?tab=data#backups') && !sys.includes('action="/system/backups"'), '系统运行只读');
  assert.ok(!sys.includes('&lt;span'));
  const old = await fetch(baseUrl + '/system/backups', { headers: { cookie }, redirect: 'manual' });
  assert.equal(old.status, 302); assert.equal(old.headers.get('location'), '/settings?tab=data#backups');
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
  assert.equal((await fetch(baseUrl + '/system/backups', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ gdrive: 'on' }) })).status, 403, '缺 CSRF 被拒');
  assert.equal((await fetch(baseUrl + '/system/backups', { method: 'POST', body: new URLSearchParams({ csrf }), redirect: 'manual' })).status, 302, '未登录跳转');
  const saved = await fetch(baseUrl + '/system/backups', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf, gdrive: 'on' }), redirect: 'manual' });
  assert.equal(saved.status, 302); assert.equal(saved.headers.get('location'), '/settings?tab=data&saved=backups#backups');
  assert.ok((await (await fetch(baseUrl + saved.headers.get('location')!, { headers: { cookie } })).text()).includes('备份设置已保存'));
  assert.deepEqual([readBackupSettings(settings).local, readBackupSettings(settings).gdrive], [false, true]);
  const both = await fetch(baseUrl + '/system/backups', { method: 'POST', headers: { cookie }, body: new URLSearchParams({ csrf }), redirect: 'manual' });
  assert.equal(both.status, 302);
  const after = await (await fetch(baseUrl + '/settings?tab=data', { headers: { cookie } })).text();
  assert.ok(after.includes('两个备份都已关闭'));
  const home = await (await fetch(baseUrl + '/', { headers: { cookie } })).text();
  assert.ok(home.includes('数据库备份已全部关闭') && home.includes('href="/settings?tab=data"'), '今日：备份全关 → 去设置');
  const db = openDb(dbpath);
  const audits = db.prepare(`SELECT payload_json FROM audit_events WHERE action='backup_settings_updated' ORDER BY id`).all() as any[];
  db.close();
  assert.equal(audits.length, 2); assert.deepEqual(JSON.parse(audits[1].payload_json).after, { local: false, gdrive: false });
  ok('后台：登录与 CSRF 校验、保存开关、全部关闭时页面警示、审计记录前后状态');
  console.log('\n✅ 全部通过');
} finally {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
