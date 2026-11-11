#!/usr/bin/env node
/**
 * 执行后台排队的操作（由 brief-requests.path 在请求目录非空时触发）：
 *   rerun  —— 重新运行某个时段：node run.ts --window K，与定时运行走同一流程和同一把运行锁
 *   resend —— 重新发送某期已定稿的日报：沿用 deliver() 的补发编号，结果写入 deliveries 与审计
 * 逐个执行直到目录为空。
 */
import { spawn } from 'node:child_process';
import { openDb, nowIso } from '../../../packages/db/src/index.ts';
import { takeRequest } from '../../../packages/web/src/requests.ts';
import { mailerFromEnv } from '../../../packages/templates/src/mailer.ts';
import { deliver } from '../../../packages/templates/src/delivery.ts';

const DIR = process.env.REQUEST_DIR ?? '/var/lib/briefing/requests';
const OUT_DIR = process.env.MAIL_OUT_DIR ?? './data/outbox';

const runWindow = (key: string) => new Promise<number>(resolve => {
  const p = spawn(process.execPath, ['apps/worker/src/run.ts', '--window', key, '--trigger', 'manual'], { stdio: 'inherit' });
  p.on('close', code => resolve(code ?? 1));
  p.on('error', () => resolve(1));
});

for (let req = takeRequest(DIR); req; req = takeRequest(DIR)) {
  if (req === 'invalid') { console.error('丢弃格式无效的请求文件'); continue; }
  const db = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
  const audit = (action: string, entityType: string, entityId: string, payload: unknown) =>
    db.prepare('INSERT INTO audit_events(entity_type,entity_id,action,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(entityType, entityId, action, JSON.stringify(payload), nowIso());
  try {
    if (req.type === 'rerun') {
      console.log(`▶ 重新运行 ${req.window}（${req.requestedAt} 由后台发起）`);
      audit('manual_rerun_started', 'run', req.window, { requestedAt: req.requestedAt });
      db.close();
      const code = await runWindow(req.window);
      const after = openDb(process.env.DATABASE_PATH ?? './data/brief.db');
      after.prepare('INSERT INTO audit_events(entity_type,entity_id,action,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run('run', req.window, 'manual_rerun_finished', JSON.stringify({ exitCode: code }), nowIso());
      after.close();
      console.log(code === 0 ? `✅ ${req.window} 运行完成` : `⚠️ ${req.window} 运行退出码 ${code}`);
      continue;
    }
    const to = process.env.MAIL_TO ?? '';
    const b = db.prepare(`SELECT id, subject, text_body, html_body FROM briefs WHERE id=? AND status='final'`).get(req.briefId) as any;
    if (!to) { console.error('未设置 MAIL_TO，无法重新发送'); audit('manual_resend', 'brief', String(req.briefId), { ok: false, error: '未设置 MAIL_TO' }); continue; }
    if (!b) { console.error(`日报 #${req.briefId} 不存在或未定稿`); continue; }
    const { mailer, kind } = mailerFromEnv(OUT_DIR);
    const r = await deliver(db, mailer, { briefId: b.id, recipient: to, deliveryType: 'resend',
      subject: b.subject, text: b.text_body, html: b.html_body });
    audit('manual_resend', 'brief', String(b.id), { ok: r.status === 'sent', status: r.status, channel: kind, error: r.error ?? null, actor: 'owner' });
    console.log(`${r.status === 'sent' ? '✅' : '⚠️'} 重新发送日报 #${b.id}：${r.status}${r.error ? ` ${r.error}` : ''}`);
  } catch (e: any) {
    console.error(`请求执行失败：${e?.message ?? e}`);
  } finally {
    if (db.open) db.close();
  }
}
