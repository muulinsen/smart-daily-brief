import { assertEligibilityUnchanged } from '../../db/src/eligibility.ts';
import type { DB } from '../../db/src/index.ts';
import { nowIso } from '../../db/src/index.ts';

/**
 * 投递幂等与重试（PRD 17.2 / 7.5 / FR-052 / FR-053）。
 *
 * 核心约束：发送前先在事务里创建 deliveries(status=pending)，
 * 由 UNIQUE(brief_id, recipient, delivery_type, resend_sequence) 锁定。
 * 同一简报、同一收件人、同一类型不会因重试或重跑而重复投递。
 * 补发必须显式创建新的 resend_sequence。
 */

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; permanent: boolean; error: string };

export type Mailer = (msg: {
  to: string; subject: string; text: string; html: string; headers?: Record<string, string>;
}) => Promise<SendResult>;

export type DeliverOpts = {
  briefId: number;
  recipient: string;
  deliveryType: 'primary' | 'resend' | 'shadow';
  subject: string;
  text: string;
  html: string;
  /** 影子运行需带此 Header 以便区分（PRD 26 章） */
  environment?: string;
  /** 首次失败后重试的间隔，网络类错误适用（PRD 17.2：30 秒后重试一次） */
  retryDelayMs?: number;
  assertEligible?: () => void;
  sleep?: (ms: number) => Promise<void>;
};

export type DeliverOutcome = {
  status: 'sent' | 'failed' | 'permanent_failure' | 'already_sent';
  deliveryId: number | null;
  providerId?: string;
  attempts: number;
  error?: string;
};

/**
 * 投递一封简报。
 *
 * 幂等策略：先查是否已有 sent 记录 —— 有则直接返回 already_sent，
 * 绝不重发（PRD 24.1 P0：重跑与重试中不得重复发送）。
 */
export async function deliver(
  db: DB, mailer: Mailer, o: DeliverOpts,
): Promise<DeliverOutcome> {
  const seq = o.deliveryType === 'resend' ? nextResendSequence(db, o.briefId, o.recipient) : 0;

  const existing = db.prepare(`SELECT id, status, provider_id, attempt FROM deliveries
    WHERE brief_id=? AND recipient=? AND delivery_type=? AND resend_sequence=?`)
    .get(o.briefId, o.recipient, o.deliveryType, seq) as any;

  if (existing?.status === 'sent')
    return { status: 'already_sent', deliveryId: existing.id,
             providerId: existing.provider_id, attempts: existing.attempt };

  const id = existing?.id ?? Number(db.prepare(`INSERT INTO deliveries
    (brief_id,recipient,delivery_type,resend_sequence,attempt,status,created_at)
    VALUES (?,?,?,?,1,'pending',?)`)
    .run(o.briefId, o.recipient, o.deliveryType, seq, nowIso()).lastInsertRowid);

  const headers: Record<string, string> = {};
  if (o.environment) headers['X-Brief-Environment'] = o.environment;

  const markSent = db.prepare(
    `UPDATE deliveries SET status='sent', provider_id=?, sent_at=?, attempt=?, error=NULL WHERE id=?`);
  const markFail = db.prepare(
    `UPDATE deliveries SET status=?, error=?, attempt=? WHERE id=?`);

  const sleep = o.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)));
  let attempts = 0, last: SendResult | null = null;

  // 首次失败自动重试一次；永久错误（认证失败、收件人无效）不盲目重试（FR-053）
  for (let i = 0; i < 2; i++) {
    try {
      o.assertEligible?.();
      const brief=db.prepare('SELECT run_id,eligibility_signature FROM briefs WHERE id=?').get(o.briefId) as any;
      if(brief?.eligibility_signature) assertEligibilityUnchanged(db,brief.run_id,brief.eligibility_signature);
    } catch(e:any) {
      markFail.run('failed',e.message,attempts,id);
      throw e;
    }
    attempts++;
    last = await mailer({ to: o.recipient, subject: o.subject, text: o.text, html: o.html, headers });
    if (last.ok) {
      markSent.run(last.providerId, nowIso(), attempts, id);
      return { status: 'sent', deliveryId: id, providerId: last.providerId, attempts };
    }
    if (last.permanent) break;
    if (i === 0) await sleep(o.retryDelayMs ?? 30_000);
  }

  const permanent = last && !last.ok ? last.permanent : false;
  const err = last && !last.ok ? last.error : '未知错误';
  markFail.run(permanent ? 'permanent_failure' : 'failed', err, attempts, id);
  return { status: permanent ? 'permanent_failure' : 'failed',
           deliveryId: id, attempts, error: err };
}

/** 补发时取下一个 resend 序号（PRD 7.5：补发必须显式创建 resend_sequence）。 */
export function nextResendSequence(db: DB, briefId: number, recipient: string): number {
  const r = db.prepare(`SELECT max(resend_sequence) m FROM deliveries
    WHERE brief_id=? AND recipient=? AND delivery_type='resend'`)
    .get(briefId, recipient) as any;
  return (r?.m ?? 0) + 1;
}

/** 某简报是否已成功投递给某收件人（用于重跑前的判断）。 */
export function alreadyDelivered(db: DB, briefId: number, recipient: string): boolean {
  const r = db.prepare(`SELECT 1 FROM deliveries
    WHERE brief_id=? AND recipient=? AND status='sent' LIMIT 1`).get(briefId, recipient);
  return !!r;
}
