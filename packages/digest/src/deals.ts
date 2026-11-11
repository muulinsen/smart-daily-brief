/**
 * 「羊毛资讯」：覆盖所有已采集渠道的限时优惠/免费福利/薅羊毛信息。
 *   · LINUX DO / V2EX：由 buildTutorials 的 judgeTutorials 判为 category=deals；
 *   · 其他渠道（RSS / 官方账号 / X 等已采集条目）与 Telegram 群消息：本模块先用关键词线索粗筛，再由 judgeDeals 判定是否真有具体优惠；
 *   · 各渠道的羊毛条目最后由 mergeDeals 把「同平台同优惠」合并成一条。
 * Telegram 库只读打开、不写入；不作为新闻源的既定决策不变，这里只抽群里的优惠讯息。
 * 展示不带群名/来源名；有消息链接（t.me/…）才放「原消息」链接，没有就不放，不编造。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { Provider } from '../../ai/src/types.ts';
import { similarity, type DigestSourceItem, type DigestTutorial } from './core.ts';
import { judgeDeals, mergeDeals, matchTelegramSummary, type DealVerdict } from './ai.ts';
import { tutorialKey, cleanTutorialSummary } from './tutorials.ts';
import type { DigestTelegram } from './core.ts';

/** 优惠线索（只用于粗筛，减少送模型的条数；是否真是羊毛由模型判定）。 */
export const DEAL_HINT = /优惠|免费|限时|折扣|秒杀|羊毛|福利|立减|优惠码|兑换码|白嫖|补贴|返现|特价|促销|试用|首月|领取|领券|红包|撸|薅|赠送|送你|买一送|半价|折|off\b|free|promo|coupon|sale|deal|discount|trial|bonus|giveaway|voucher|code/i;
const MIN_TEXT = 15;
const noise = (s: string) => s.replace(/\bimage\s+\d+\s*[×x]\s*\d+\s+[\d.]+\s*[KM]?B\b/gi, ' ').replace(/\s+/g, ' ').trim();

export type TgMessage = { chatId: number; messageId: number; sentAt: string; group: string; text: string; link: string | null };

/** 窗口内各启用群的消息（含图片识别文字）。只读。 */
export function loadTelegramMessages(path: string, start: string, end: string): TgMessage[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const sources = db.prepare(`SELECT id, coalesce(display_name,title,reference) name FROM telegram_sources WHERE source_type='normal' AND enabled=1 ORDER BY id`).all() as any[];
    const q = db.prepare(`SELECT m.chat_id,m.message_id,m.sent_at,m.text,m.source_url,v.description,v.key_text
      FROM telegram_messages m LEFT JOIN telegram_media_tasks v ON v.chat_id=m.chat_id AND v.message_id=m.message_id
        AND v.superseded_at IS NULL AND v.status='completed'
      WHERE m.source_id=? AND m.sent_at>=? AND m.sent_at<? AND m.deleted_at IS NULL ORDER BY m.sent_at,m.message_id`);
    const out: TgMessage[] = [];
    for (const s of sources) for (const r of q.all(s.id, start, end) as any[]) {
      const parts = [String(r.text ?? '').trim(), String(r.description ?? '').trim() && `[图片描述] ${r.description}`, String(r.key_text ?? '').trim() && `[图片文字] ${r.key_text}`].filter(Boolean);
      const text = noise(parts.join('\n'));
      if (text) out.push({ chatId: r.chat_id, messageId: r.message_id, sentAt: r.sent_at, group: s.name, text, link: r.source_url || null });
    }
    return out;
  } finally { db.close(); }
}

/** itemId：其他渠道（已采集条目）的条目编号，用于合并时检查是否已被判为不同事件；Telegram 群消息没有。 */
export type DealPicked = { channel: 'telegram' | 'other'; title: string; summary: string; url: string; group?: string; sourceName?: string; raw: string; reason?: string; itemId?: number };
export type DealsReport = {
  telegram: { enabled: boolean; messages: number; hinted: number; sentToModel: number; picked: number };
  other: { candidates: number; hinted: number; sentToModel: number; picked: number };
  extras: DealPicked[];                       // 模型判定为羊毛的 Telegram / 其他渠道条目（合并前）
  merged: Array<{ summary: string; url: string; channel: string; members: Array<{ channel: string; title: string; url: string }> }>;   // 合并后的全部羊毛条目
  dropped: Array<{ title: string; reason: string }>;
  rejected: Array<{ channel: string; gist: string; reason: string }>;   // 命中关键词但模型判为非羊毛的条目（便于人工复核）
  modelError?: string;
};

export type ExtraCtx = {
  items: DigestSourceItem[];                  // 窗口条目（含各渠道）
  skipItemIds: Set<number>;                   // 已在「一、官方动态」出现的条目
  forumSources: string[];                     // 已由 judgeTutorials 处理的论坛来源
  telegramPath: string | null; start: string; end: string;
  pushedUrls: Set<string>; pushedTitles: string[];
  /** 新流程注入：分层判定（替代 judgeDeals） */
  judge?: (items: Array<{ id: number; title: string; text: string }>) => Promise<{ results: Map<number, DealVerdict>; error?: string }>;
};

export async function collectExtraDeals(provider: Provider, c: ExtraCtx, log: string[] = []): Promise<{ extras: DealPicked[]; report: DealsReport }> {
  const report: DealsReport = { telegram: { enabled: !!c.telegramPath, messages: 0, hinted: 0, sentToModel: 0, picked: 0 }, other: { candidates: 0, hinted: 0, sentToModel: 0, picked: 0 }, extras: [], merged: [], dropped: [], rejected: [] };
  type Src = { id: number; title: string; text: string; channel: 'telegram' | 'other'; url: string; group?: string; sourceName?: string; itemId?: number };
  const srcs: Src[] = [];
  let id = 0;
  // 其他渠道：非论坛、非时政、尚未出现在官方动态里的条目
  const others = c.items.filter(i => !c.forumSources.includes(i.sourceId) && i.role !== 'politics' && !c.skipItemIds.has(i.id));
  report.other.candidates = others.length;
  for (const it of others) {
    const text = noise(it.text);
    if (`${it.title} ${text}`.length < MIN_TEXT || !DEAL_HINT.test(`${it.title} ${text}`)) continue;
    srcs.push({ id: ++id, title: it.title, text, channel: 'other', url: it.url ?? '', sourceName: it.sourceName, itemId: it.id });
    report.other.hinted++;
  }
  // Telegram 群消息
  if (c.telegramPath) {
    const msgs = loadTelegramMessages(c.telegramPath, c.start, c.end);
    report.telegram.messages = msgs.length;
    const seen = new Set<string>();
    for (const m of msgs) {
      if (m.text.length < MIN_TEXT || !DEAL_HINT.test(m.text)) continue;
      const k = m.text.replace(/\s+/g, '').toLowerCase();
      if (seen.has(k)) continue; seen.add(k);
      srcs.push({ id: ++id, title: '', text: m.text, channel: 'telegram', url: m.link ?? '', group: m.group });
      report.telegram.hinted++;
    }
  }
  report.other.sentToModel = srcs.filter(s => s.channel === 'other').length;
  report.telegram.sentToModel = srcs.filter(s => s.channel === 'telegram').length;
  log.push(`羊毛资讯：其他渠道 ${report.other.candidates} 条（线索 ${report.other.hinted}），Telegram ${report.telegram.messages} 条消息（线索 ${report.telegram.hinted}）`);
  const { results, error } = await (c.judge ?? ((x: Parameters<typeof judgeDeals>[1]) => judgeDeals(provider, x)))(srcs.map(s => ({ id: s.id, title: s.title, text: s.text })));
  if (error) { report.modelError = error; log.push(`  ⚠️ 羊毛资讯模型判定失败（部分或全部）：${error}`); }
  const extras: DealPicked[] = [];
  for (const s of srcs) {
    const r = results.get(s.id);
    const summary = r ? cleanTutorialSummary(r.summary) : '';
    if (!r || !r.deal || !summary) { report.rejected.push({ channel: s.channel, gist: `${s.title} ${s.text}`.trim().replace(/\s+/g, ' ').slice(0, 110), reason: r ? (r.reason || '无摘要') : '模型未返回' }); continue; }
    const key = tutorialKey(s.url);
    if ((key && c.pushedUrls.has(key)) || c.pushedTitles.some(t => similarity(t, r.title) >= 0.6)) { report.dropped.push({ title: r.title, reason: '72h 内已推送' }); continue; }
    extras.push({ channel: s.channel, title: r.title || summary.slice(0, 20), summary, url: s.url, group: s.group, sourceName: s.sourceName, raw: `${s.title} ${s.text}`.trim().slice(0, 500), reason: r.reason, itemId: s.itemId });
    report.extras.push(extras[extras.length - 1]!);
    report[s.channel === 'telegram' ? 'telegram' : 'other'].picked++;
  }
  return { extras, report };
}

/** 把论坛判为 deals 的条目和其他渠道/Telegram 的羊毛条目合并成最终「羊毛资讯」列表（同平台同优惠合一）。 */
export async function mergeAllDeals(provider: Provider, forum: DigestTutorial[], extras: DealPicked[], report: DealsReport, log: string[] = [],
  merge?: (items: Array<{ id: number; title: string; summary: string }>, itemIdOf: Map<number, number>) => Promise<{ groups: Array<{ ids: number[]; summary: string }>; error?: string }>): Promise<DigestTutorial[]> {
  type M = { id: number; title: string; summary: string; url: string; channel: 'forum' | 'telegram' | 'other'; itemId: number };
  const all: M[] = [
    ...forum.map(t => ({ title: t.title, summary: t.summary, url: t.url, channel: 'forum' as const, itemId: t.itemId })),
    ...extras.map(e => ({ title: e.title, summary: e.summary, url: e.url, channel: e.channel, itemId: e.itemId ?? 0 })),
  ].map((m, i) => ({ ...m, id: i + 1 }));
  if (!all.length) return [];
  const mg = await (merge ?? ((x: Parameters<typeof mergeDeals>[1]) => mergeDeals(provider, x)))(all.map(m => ({ id: m.id, title: m.title, summary: m.summary })),
    new Map(all.filter(m => m.itemId).map(m => [m.id, m.itemId])));
  if (mg.error) { report.modelError = report.modelError ?? mg.error; log.push(`  ⚠️ 羊毛资讯合并失败，按原样保留：${mg.error}`); }
  const rank = (m: M) => (m.channel === 'forum' ? 0 : m.channel === 'other' ? 1 : 2) * 2 + (m.url ? 0 : 1);
  const out: DigestTutorial[] = [];
  for (const g of mg.groups) {
    const ms = g.ids.map(i => all.find(m => m.id === i)!).filter(Boolean).sort((a, b) => rank(a) - rank(b));
    const p = ms[0]!;
    const summary = cleanTutorialSummary(g.summary) || p.summary;
    out.push({ title: p.title, summary, url: p.url, itemId: p.itemId, category: 'deals', channel: p.channel });
    report.merged.push({ summary, url: p.url, channel: p.channel, members: ms.map(m => ({ channel: m.channel, title: m.title, url: m.url })) });
    if (ms.length > 1) log.push(`  合并羊毛 ${ms.length} 条 → ${p.title}`);
  }
  return out;
}

/** 从 Telegram 群组要点汇总里去掉已经单独成条的羊毛条目（其余内容不变）。返回去掉的行，供报告核对。 */
export async function stripDealsFromTelegram(provider: Provider, tg: DigestTelegram, deals: DigestTutorial[], log: string[] = []): Promise<{ tg: DigestTelegram; removed: Array<{ category: string; text: string }> }> {
  if (tg.status !== 'ready' || !deals.length) return { tg, removed: [] };
  const lines: Array<{ id: number; text: string; cat: string }> = [];
  for (const c of tg.categories) for (const it of c.items) lines.push({ id: lines.length + 1, text: it.text, cat: c.name });
  const m = await matchTelegramSummary(provider, deals.map(d => ({ title: d.title, summary: d.summary })), lines.map(l => ({ id: l.id, text: l.text })));
  if (m.error) log.push(`  ⚠️ Telegram 汇总去重失败，保持原样：${m.error}`);
  let n = 0;
  const categories = tg.categories.map(c => ({ name: c.name, items: c.items.filter(() => !m.remove.has(++n)) })).filter(c => c.items.length);
  return { tg: { ...tg, categories }, removed: lines.filter(l => m.remove.has(l.id)).map(l => ({ category: l.cat, text: l.text })) };
}
