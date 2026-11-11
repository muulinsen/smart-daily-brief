process.env.TELEGRAM_DAILY_RETRY_MS = '0';
// Telegram 跨频道汇总 RSS + 补采期间的窗口推进
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { isGroupAdminNotice, rotateAllToken, updateTelegramSettings } from '../packages/telegram/src/core.ts';
import { digestRss } from '../packages/telegram/src/rss.ts';
import { ensureDueJobs } from '../packages/telegram/src/summarize.ts';
import { runDueDigests, validateDigest, TELEGRAM_DIGEST_SCHEMA } from '../packages/telegram/src/digest.ts';
import { cleanupTelegram } from '../packages/telegram/src/maintenance.ts';

const dir = mkdtempSync(join(tmpdir(), 'brief-tg-digest-')); const db = readyTelegramDb(join(dir, 'telegram.db'));
let fail = 0; const ok = (name: string, value: boolean, d = '') => { if (!value) fail++; console.log(`  ${value ? '✅' : '❌'} ${name}${d ? '  ' + d : ''}`); };

updateTelegramSettings(db, { modelMode: 'legacy', timezone: 'UTC', schedule: '00:00,12:00', provider: 'mock', model: 'm', credentialRef: 'OPENAI_COMPAT_API_KEY', promptRules: '' });
const allToken = rotateAllToken(db)!;
const T = (s: string) => new Date(s).toISOString();
const now = new Date('2026-10-09T13:00:00Z');
const addSource = (title: string, chatId: number) => {
  const id = Number(db.prepare(`INSERT INTO telegram_sources(reference,source_type,chat_id,title,status,enabled,validation_requested_at,created_at,updated_at)
    VALUES(?,'normal',?,?,'active',1,?,?,?)`).run(`@s${chatId}`, chatId, title, T('2026-10-01'), T('2026-10-01'), T('2026-10-01')).lastInsertRowid);
  db.prepare('INSERT INTO telegram_sync_state(source_id) VALUES(?)').run(id);
  return id;
};
const a = addSource('折腾搞机', -101), b = addSource('eSIM群', -102), c = addSource('giffgaff 交流群', -103);
const W = T('2026-10-09T12:00:00Z'), W0 = T('2026-10-09T00:00:00Z');
const addSummary = (sourceId: number, start: string, end: string, summary: object) => {
  const job = db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
    VALUES(?,?,?,'h','mock','m',1,'completed',?,?)`).run(sourceId, start, end, end, end);
  db.prepare(`INSERT INTO telegram_summaries(job_id,source_id,window_start,window_end,title,summary_json,rendered_html,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(job.lastInsertRowid, sourceId, start, end, 't', JSON.stringify(summary), '', end, T('2026-11-30'));
  // daily_v2 从原始消息逐群提取：为每个总结放一条对应消息
  const chat = (db.prepare('SELECT chat_id FROM telegram_sources WHERE id=?').get(sourceId) as any).chat_id;
  db.prepare(`INSERT OR IGNORE INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`)
    .run(sourceId, chat, Date.parse(start) / 1000 + sourceId, start, (summary as any).topics[0], 'h', end);
};
const S = (topic: string) => ({ topics: [topic], important: [`${topic} 的细节`], viewpoints: [`${topic} 的看法`], sources: [], uncertainty: [] });
addSummary(a, W0, W, S('iPhone eSIM'));
addSummary(b, W0, W, S('eSIM 开通'));

let calls = 0; let lastPrompt = '';
const provider = { name: 'mock', model: 'digest-m', strictness: 'strict', complete: async (req: any) => {
  calls++; lastPrompt = req.userContent;
  const usage = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 };
  if (req.schemaName === 'tg_extract') {
    const texts = [...req.userContent.matchAll(/<message [^>]*>\n([\s\S]*?)\n<\/message>/g)].map(m => m[1]);
    return { data: { points: texts.map((t: string) => ({ category: 'eSIM', text: `${t} 的细节（消息 ID：123）` })) }, rawText: '', responseId: 'r', model: 'digest-m', usage };
  }
  const list = JSON.parse(req.userContent.slice(req.userContent.indexOf('\n\n') + 2));
  return { data: { items: [{ text: list.map((x: any) => x.text).join('；'), groups: [...new Set(list.flatMap((x: any) => x.groups)), '编造频道'] }] },
    rawText: '', responseId: 'r', model: 'digest-m', usage };
} } as any;
// 保留天数取很大：样例数据用固定日期，RSS 按真实时间过滤过期，30 天会在 2026-11-09 之后让 RSS 断言失效
const cfg = { provider: 'mock' as const, model: 'm', summaryRetentionDays: 36500, lookbackDays: 7 };

console.log('等待所有频道就绪：\n');
{
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id IN (?,?)').run(W, a, b);
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(W0, c);
  ok('有频道还没推进到该时刻时不生成', await runDueDigests(db, cfg, provider, now) === 0 && calls === 0);
  // 2026-11-07：采集器停摆，重启后补采还没轮到的频道也被当成"坏来源"跳过，汇总缺了 17% 的消息
  db.prepare('UPDATE telegram_sources SET updated_at=? WHERE id=?').run('2026-10-09T13:00:00Z', c);   // 改名等操作会更新 updated_at，不能当作同步过
  const attempt = (at: string | null, okv: number | null) => db.prepare(`INSERT INTO telegram_sync_progress(source_id,last_attempt_at,last_attempt_ok) VALUES(?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_attempt_ok=excluded.last_attempt_ok`).run(c, at, okv);
  attempt(null, null);
  ok('超过宽限期但落后频道在时段结束后从未同步过：继续等待补采', await runDueDigests(db, cfg, provider, new Date('2026-10-09T15:30:00Z')) === 0 && calls === 0);
  ok('时段结束 24 小时后无论是否追上都生成', await runDueDigests(db, cfg, provider, new Date('2026-10-10T12:30:00Z')) === 1);
  db.prepare('DELETE FROM telegram_digests').run(); calls = 0;
  attempt('2026-10-09T13:00:00Z', 1);
  ok('落后频道在时段结束后同步成功但覆盖水位未越过时段：继续等待', await runDueDigests(db, cfg, provider, new Date('2026-10-09T15:30:00Z')) === 0 && calls === 0);
  attempt('2026-10-09T14:00:00Z', null);
  ok('上一轮失败后本轮正在重新补采（进行中）：继续等待，不当成故障来源', await runDueDigests(db, cfg, provider, new Date('2026-10-09T15:30:00Z')) === 0 && calls === 0);
  attempt('2026-10-09T13:00:00Z', 0);
  ok('落后频道在时段结束后已同步过但出错（来源自身故障）：超过宽限后不再等它', await runDueDigests(db, cfg, provider, new Date('2026-10-09T15:30:00Z')) === 1);
  db.prepare('DELETE FROM telegram_digests').run(); calls = 0;
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(W, c);
  const pending = db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at)
    VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(c, W0, W, W, W);
  ok('窗口结束 40 分钟内还有频道总结未完成时不生成', await runDueDigests(db, cfg, provider, new Date('2026-10-09T12:20:00Z')) === 0 && calls === 0);
  ok('超过 40 分钟后不再被未完成的频道总结任务阻塞', await runDueDigests(db, cfg, provider, now) === 1 && calls > 0);
  db.prepare('DELETE FROM telegram_digests').run(); calls = 0;
  db.prepare('DELETE FROM telegram_summary_jobs WHERE id=?').run(pending.lastInsertRowid);
}

console.log('\n逐群提取 + 按分类合并（daily_v2）：\n');
{
  ok('全部就绪后生成一条汇总', await runDueDigests(db, cfg, provider, now) === 1 && calls === 3, String(calls));
  const row = db.prepare('SELECT * FROM telegram_digests WHERE window_end=?').get(W) as any;
  const html = String(row.rendered_html); const j = JSON.parse(row.summary_json);
  ok('存储为 daily_v2 分类结构', j.format === 'daily_v2' && j.categories[0].name === 'eSIM/保号', row.summary_json);
  ok('跨群合并为一行并标注来源群（按输入顺序）', html.includes('<h3>eSIM/保号</h3><ul><li>iPhone eSIM 的细节；eSIM 开通 的细节 <small>〔折腾搞机、eSIM群〕</small></li></ul>'), html);
  ok('丢弃编造的群名', !html.includes('编造频道'));
  ok('清理消息 ID', !html.includes('123'));
  ok('记录来源与模型', row.source_ids === JSON.stringify([a, b]) && row.response_model === 'digest-m' && row.fallback === 0);
  ok('已完成的时刻不重复调用', await runDueDigests(db, cfg, provider, now) === 0 && calls === 3);
  ok('Schema 不设条数上限、每条至少一个频道', (TELEGRAM_DIGEST_SCHEMA.properties.points as any).maxItems === undefined &&
    (TELEGRAM_DIGEST_SCHEMA.properties.points as any).items.properties.channels.minItems === 1);
  ok('超过 10 条时不再截断', validateDigest({ points: Array.from({ length: 15 }, (_, i) => ({ text: `p${i}`, channels: ['折腾搞机'] })) }, ['折腾搞机']).points.length === 15);
  void lastPrompt;
}

console.log('\n汇总 RSS：\n');
{
  const feed = digestRss(db, allToken, 'https://brief.test')!;
  ok('每个时刻一条 item', (feed.match(/<item>/g) ?? []).length === 1);
  ok('标题含月日与早/午/晚', feed.includes('<title>📌 Telegram 要点 · 10-09 午</title>'));
  ok('guid 稳定', feed.includes('telegram-digest:2026-10-09T12:00:00.000Z'));
  ok('正文含来源群标注', feed.includes('〔折腾搞机、eSIM群〕'));
  ok('完整正文放在 content:encoded，列表预览是纯文本', feed.includes('<content:encoded>&lt;h3&gt;') && feed.includes('<description>iPhone eSIM 的细节；eSIM 开通 的细节</description>'), feed);
  ok('带自引用链接与 dc:creator', feed.includes('rel="self"') && feed.includes('<dc:creator>Telegram 跨频道要点</dc:creator>'));
  ok('错误令牌返回 null', digestRss(db, 'f'.repeat(64), '') === null);
}

console.log('\n单频道与 AI 失败兜底：\n');
{
  const W2 = T('2026-10-09T00:00:00Z'), W1 = T('2026-10-08T12:00:00Z');
  addSummary(c, W1, W2, S('giffgaff 激活'));
  calls = 0;
  ok('只有一个群时同样逐群提取并标注该群', await runDueDigests(db, cfg, provider, now) === 1 &&
    String((db.prepare('SELECT rendered_html FROM telegram_digests WHERE window_end=?').get(W2) as any).rendered_html).includes('giffgaff 激活 的细节 <small>〔giffgaff 交流群〕'));

  const W3 = T('2026-10-08T12:00:00Z'), W4 = T('2026-10-08T00:00:00Z');
  addSummary(a, W4, W3, S('A 话题')); addSummary(b, W4, W3, S('B 话题'));
  const broken = { name: 'mock', model: 'm', strictness: 'strict', complete: async () => { throw new Error('upstream down'); } } as any;
  let t = now;
  ok('AI 失败先排队重试', await runDueDigests(db, cfg, broken, t) === 0 &&
    (db.prepare('SELECT status,next_attempt_at FROM telegram_digests WHERE window_end=?').get(W3) as any).status === 'failed');
  ok('未到重试时间不重试', await runDueDigests(db, cfg, broken, t) === 0 &&
    (db.prepare('SELECT attempts FROM telegram_digests WHERE window_end=?').get(W3) as any).attempts === 1);
  t = new Date(t.getTime() + 3600_000); await runDueDigests(db, cfg, broken, t);
  t = new Date(t.getTime() + 3600_000); await runDueDigests(db, cfg, broken, t);
  const fb = db.prepare('SELECT * FROM telegram_digests WHERE window_end=?').get(W3) as any;
  ok('第 3 次失败后退回逐频道拼接，时段不缺席', fb.status === 'completed' && fb.fallback === 1 && fb.attempts === 3 && !!fb.error && !String(fb.error).includes('upstream down'));  // 错误只记类型，不记上游原文
  const fbj = JSON.parse(fb.summary_json);
  ok('兜底为 daily_v2 结构（日报能读取），每个频道一个分类并标注频道', fbj.format === 'daily_v2' && fbj.categories.length === 2 &&
    String(fb.rendered_html).includes('<h3>折腾搞机</h3><ul><li>A 话题 的细节 <small>〔折腾搞机〕</small></li></ul>') && String(fb.rendered_html).includes('<h3>eSIM群</h3>'), String(fb.rendered_html));
}

console.log('\n补采未覆盖的窗口不推进：\n');
{
  // 2026-10-09：补采还没跑到时窗口看起来是空的，旧逻辑直接推进边界，补回来的消息永远进不了总结
  const d = addSource('补采中的群', -104);
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(T('2026-10-08T12:00:00Z'), d);
  db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,content_hash,collected_at) VALUES(?,?,?,?,?,?,?)`)
    .run(d, -104, 1, T('2026-10-09T06:00:00Z'), '补采回来的消息', 'h', T('2026-10-09T13:00:00Z'));
  const jobs = () => db.prepare('SELECT window_start,window_end FROM telegram_summary_jobs WHERE source_id=?').all(d) as any[];
  const cursor = () => (db.prepare('SELECT last_window_end FROM telegram_sync_state WHERE source_id=?').get(d) as any).last_window_end;
  ensureDueJobs(db, now);
  ok('从未成功同步过的来源不推进', jobs().length === 0 && cursor() === T('2026-10-08T12:00:00Z'));
  db.prepare('UPDATE telegram_sources SET last_success_at=? WHERE id=?').run(T('2026-10-09T11:00:00Z'), d);
  ensureDueJobs(db, now);
  ok('只推进到采集已覆盖的边界', jobs().length === 0 && cursor() === T('2026-10-09T00:00:00Z'), cursor());
  db.prepare('UPDATE telegram_sources SET last_success_at=? WHERE id=?').run(T('2026-10-09T12:30:00Z'), d);
  ensureDueJobs(db, now);
  ok('采集覆盖后为补回的消息建总结任务', jobs().length === 1 && jobs()[0].window_end === W && cursor() === W);
  // 覆盖水位优先于同步完成时间：扫描 11:50 开始、12:30 才结束，12:00 的时段不能算覆盖
  db.prepare('DELETE FROM telegram_summary_jobs WHERE source_id=?').run(d);
  db.prepare('UPDATE telegram_sync_state SET last_window_end=? WHERE source_id=?').run(T('2026-10-09T00:00:00Z'), d);
  db.prepare('INSERT OR REPLACE INTO telegram_sync_progress(source_id,covered_until) VALUES(?,?)').run(d, T('2026-10-09T11:50:00Z'));
  ensureDueJobs(db, now);
  ok('覆盖水位（扫描开始时刻）未越过边界时不推进，即使同步完成时间已越过', jobs().length === 0 && cursor() === T('2026-10-09T00:00:00Z'), cursor());
  db.prepare('UPDATE telegram_sync_progress SET covered_until=? WHERE source_id=?').run(T('2026-10-09T12:05:00Z'), d);
  ensureDueJobs(db, now);
  ok('覆盖水位越过边界后推进', jobs().length === 1 && cursor() === W);
}

console.log('\n过滤群管理机器人消息：\n');
{
  // 2026-10-09 汇总出现「入群验证过期可能导致永久封禁」：来自验证机器人的模板通知
  for (const t of ['H***e 由于验证已过期，未能完成入群验证，已被封禁 2 分钟。\u200c', '怎***🥰 由于验证已过期，未能完成入群验证，已被永久封禁。\u200c',
    '欢迎 M***l 加入群组！请完成入群验证。\u200c', '欢迎使用 DeerBot。', '你好，欢迎使用 nmBot Preview！\n\nnmBot Preview 兼具群组管理功能',
    '找不到要封禁的频道。\n请注意无法通过用户名封禁用户。', 'A***b 已被禁言 10 分钟'])
    ok(`过滤：${t.slice(0, 18)}`, isGroupAdminNotice(t));
  for (const t of ['新注册外区apple id又被风控了，注册完手机号就再收不到验证码', 'codex那个验证好过吗 我卡这步好久了',
    '现在开 monzo flex 也要验证收入了', '我的 giffgaff 卡已被封禁，充值的钱怎么退', 'Lava开美户要二次身份验证，需要填税号怎么办',
    '苹果官宣10月13日举办主题为“Welcome home（欢迎回家）”的媒体体验活动', '欢迎大家讨论一下 eSIM 的问题'])
    ok(`保留：${t.slice(0, 18)}`, !isGroupAdminNotice(t));
}

console.log('\n保留期清理：\n');
{
  db.prepare("UPDATE telegram_digests SET expires_at=? WHERE window_end=?").run(T('2026-10-01'), W);
  cleanupTelegram(db, now);
  ok('过期汇总被清理', !db.prepare('SELECT 1 FROM telegram_digests WHERE window_end=?').get(W));
  ok('integrity_check=ok', db.pragma('integrity_check', { simple: true }) === 'ok');
}

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过'); process.exit(fail ? 1 : 0);
