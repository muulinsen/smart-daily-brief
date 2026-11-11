import type { TelegramDB } from './db.ts';

const dateParts = (date: Date, timeZone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
  timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value])) as Record<string,string>;

export function retentionCutoff(now: Date, timeZone: string, retentionDays: number): Date {
  const local=dateParts(now,timeZone);
  const abstract=new Date(Date.UTC(Number(local.year),Number(local.month)-1,Number(local.day)-(retentionDays-1)));
  const y=abstract.getUTCFullYear(),m=abstract.getUTCMonth()+1,d=abstract.getUTCDate();
  const wanted=Date.UTC(y,m-1,d,0,0,0);let candidate=new Date(wanted);
  for(let i=0;i<3;i++){
    const p=dateParts(candidate,timeZone);
    const got=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute),Number(p.second));
    candidate=new Date(candidate.getTime()+wanted-got);
  }
  return candidate;
}

export function cleanupTelegram(db: TelegramDB, now = new Date()): {messages:number;urls:number;summaries:number;cache:number} {
  const s=db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  const rawCutoff=retentionCutoff(now,s.timezone,Number(s.raw_retention_days)).toISOString();
  const summaryCutoff=now.toISOString();
  const result=db.transaction(()=>{
    const messages=Boolean(s.keep_messages_forever) ? 0 : db.prepare(`DELETE FROM telegram_messages
      WHERE sent_at<? AND source_id NOT IN
        (SELECT id FROM telegram_sources WHERE retain_all_history=1)
        -- 有保留中图片（失败后保留 7 天等待自动重试）的消息暂不删除，否则图片任务会被级联删除
        AND NOT EXISTS (SELECT 1 FROM telegram_media_tasks v WHERE v.chat_id=telegram_messages.chat_id
          AND v.message_id=telegram_messages.message_id AND v.held_until > ? AND v.temp_state='ready')`).run(rawCutoff, now.toISOString()).changes;
    const urls=db.prepare('DELETE FROM telegram_urls WHERE expires_at<?').run(summaryCutoff).changes;
    const summaries=db.prepare('DELETE FROM telegram_summaries WHERE expires_at<?').run(summaryCutoff).changes;
    db.prepare('DELETE FROM telegram_digests WHERE expires_at<?').run(summaryCutoff);
    db.prepare(`DELETE FROM telegram_summary_jobs WHERE window_end<? AND id NOT IN (SELECT job_id FROM telegram_summaries)`).run(
      new Date(now.getTime()-Number(s.summary_retention_days)*86400_000).toISOString());
    const cache=db.prepare("DELETE FROM telegram_summary_cache WHERE created_at<?").run(
      new Date(now.getTime()-Number(s.summary_retention_days)*86400_000).toISOString()).changes;
    return {messages,urls,summaries,cache};
  })();
  db.pragma('wal_checkpoint(PASSIVE)');
  return result;
}
