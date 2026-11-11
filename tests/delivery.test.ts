// 投递幂等与重试（PRD 17.2 / 7.5 / FR-052 / FR-053 / 24.1-P0）
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, nowIso } from '../packages/db/src/index.ts';
import { deliver, alreadyDelivered, nextResendSequence, type Mailer } from '../packages/templates/src/delivery.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-d-'));
const db = openDb(join(dir, 'd.db'));
migrate(db, './migrations');
const now = nowIso();

db.prepare(`INSERT INTO runs (window_key,window_label,window_start_at,window_end_at,
  scheduled_at,status,trigger) VALUES ('2026-08-23:evening','晚报',?,?,?,'succeeded','timer')`)
  .run(now, now, now);
const briefId = Number(db.prepare(`INSERT INTO briefs (run_id,version,subject,text_body,
  html_body,html_bytes,status,rule_version,created_at) VALUES (1,1,'s','t','h',1,'final',1,?)`)
  .run(now).lastInsertRowid);

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };
const msg = { briefId, recipient: 'a@b.com', subject: 's', text: 't', html: 'h',
              retryDelayMs: 0, sleep: async () => {} };

const okMailer = (id = 'msg-1'): Mailer => async () => ({ ok: true, providerId: id });
let calls = 0;
const countingMailer = (r: any): Mailer => async () => { calls++; return r; };

console.log('幂等（PRD 24.1-P0：重跑与重试中不得重复发送）：\n');
{
  calls = 0;
  const m = countingMailer({ ok: true, providerId: 'gmail-abc' });
  const r1 = await deliver(db, m, { ...msg, deliveryType: 'primary' });
  const r2 = await deliver(db, m, { ...msg, deliveryType: 'primary' });
  const r3 = await deliver(db, m, { ...msg, deliveryType: 'primary' });
  ok('首次发送成功并保存 provider message ID',
     r1.status === 'sent' && r1.providerId === 'gmail-abc');
  ok('重复调用返回 already_sent', r2.status === 'already_sent' && r3.status === 'already_sent');
  ok('实际只调用了一次发信', calls === 1, `calls=${calls}`);
  ok('deliveries 只有一行',
     (db.prepare(`SELECT count(*) c FROM deliveries WHERE delivery_type='primary'`).get() as any).c === 1);
  ok('alreadyDelivered 可查', alreadyDelivered(db, briefId, 'a@b.com'));
}

console.log('\n重试（FR-053）：\n');
{
  calls = 0;
  let n = 0;
  const flaky: Mailer = async () => (++n === 1
    ? { ok: false, permanent: false, error: '网络超时' }
    : { ok: true, providerId: 'gmail-retry' });
  const r = await deliver(db, flaky, { ...msg, recipient: 'retry@b.com', deliveryType: 'primary' });
  ok('首次失败后重试一次即成功', r.status === 'sent' && r.attempts === 2);
}
{
  const always: Mailer = async () => ({ ok: false, permanent: false, error: '5xx' });
  const r = await deliver(db, always, { ...msg, recipient: 'dead@b.com', deliveryType: 'primary' });
  ok('两次都失败 → failed（可重发）', r.status === 'failed' && r.attempts === 2);
  ok('失败未被误写成已送达',
     (db.prepare(`SELECT status FROM deliveries WHERE recipient='dead@b.com'`).get() as any).status === 'failed');
}
{
  calls = 0;
  const authErr = countingMailer({ ok: false, permanent: true, error: '认证失败' });
  const r = await deliver(db, authErr, { ...msg, recipient: 'auth@b.com', deliveryType: 'primary' });
  ok('永久错误不盲目重试', r.status === 'permanent_failure' && r.attempts === 1, `calls=${calls}`);
}

console.log('\n补发必须显式创建 resend 序号（PRD 7.5）：\n');
{
  const r1 = await deliver(db, okMailer('resend-1'), { ...msg, deliveryType: 'resend' });
  const r2 = await deliver(db, okMailer('resend-2'), { ...msg, deliveryType: 'resend' });
  ok('两次补发产生两条独立记录', r1.deliveryId !== r2.deliveryId);
  ok('resend 序号递增',
     (db.prepare(`SELECT group_concat(resend_sequence) s FROM deliveries
       WHERE delivery_type='resend' AND recipient='a@b.com'`).get() as any).s === '1,2');
  ok('下一个序号为 3', nextResendSequence(db, briefId, 'a@b.com') === 3);
  ok('primary 记录未被影响',
     (db.prepare(`SELECT count(*) c FROM deliveries WHERE delivery_type='primary' AND recipient='a@b.com'`)
       .get() as any).c === 1);
}

console.log('\n影子运行标记（PRD 26 章）：\n');
{
  let seen: any = null;
  const spy: Mailer = async (m) => { seen = m; return { ok: true, providerId: 'x' }; };
  await deliver(db, spy, { ...msg, recipient: 'shadow@b.com', deliveryType: 'shadow', environment: 'shadow' });
  ok('带 X-Brief-Environment Header', seen.headers?.['X-Brief-Environment'] === 'shadow');
  ok('shadow 与 primary 互不冲突',
     (db.prepare(`SELECT count(*) c FROM deliveries WHERE recipient='shadow@b.com'`).get() as any).c === 1);
}

console.log('\n唯一约束兜底：\n');
{
  let threw = false;
  try {
    db.prepare(`INSERT INTO deliveries (brief_id,recipient,delivery_type,resend_sequence,
      attempt,status,created_at) VALUES (?,?,'primary',0,1,'pending',?)`).run(briefId, 'a@b.com', now);
  } catch { threw = true; }
  ok('数据库层拒绝重复的 (brief, 收件人, 类型, 序号)', threw);
}

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
