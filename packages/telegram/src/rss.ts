import type { TelegramDB } from './db.ts';
import { consolidateViewpoints, stripMessageReferences } from './core.ts';
import { channelName, digestHtml } from './digest.ts';
import { rssDocument, safeHref, type FeedItem } from '../../web/src/feed-xml.ts';

// 兼容已经落库的历史总结：引用仍保留在 summary_json 供审计，RSS 不展示消息 ID/时间结构。
const withoutMessageSources = (html: unknown) => String(html ?? '')
  .replace(/<h2>消息来源<\/h2>(?:<ul>.*?<\/ul>|<p>无<\/p>)/s, '');
const consolidatedRenderedViewpoints = (html: string) => html
  .replace(/(<h2>主要观点<\/h2>)<ul>(.*?)<\/ul>/s, (_all, heading, items) => {
    const points = [...String(items).matchAll(/<li>(.*?)<\/li>/gs)].map(x => x[1]);
    const paragraph = consolidateViewpoints(points);
    return `${heading}${paragraph ? `<p>${paragraph}</p>` : '<p>无</p>'}`;
  })
  .replace(/(<h2>主要观点<\/h2><p>)(.*?)(<\/p>)/s, (_all, open, value, close) => `${open}${consolidateViewpoints([value]) || '无'}${close}`);
const withoutVagueLeadIns = (html: string) => html.replace(
  /(?:(?:有人|群友)(?:提出|认为|表示|提到|指出|建议|质疑)|消息中提到)[：:，,]?\s*/gu,
  '',
);
const publicSummary = (html: unknown) => withoutVagueLeadIns(consolidatedRenderedViewpoints(stripMessageReferences(withoutMessageSources(html))));

const monthDay = (value: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value));
  const values = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${values.month}-${values.day}`;
};
// 早 / 午 / 晚 按关闭时刻的本地小时划分，与 08:00 / 12:00 / 22:00 三档对应
const slot = (value: string, timezone: string) => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(value)));
  return h < 11 ? '早' : h < 17 ? '午' : '晚';
};
const timezoneOf = (db: TelegramDB) => (db.prepare('SELECT timezone FROM telegram_settings WHERE singleton=1').get() as any).timezone as string;
/** 文章链接指向频道本身，阅读器里「在浏览器打开」能直达 Telegram */
const channelLink = (username: string | null, fallback: string) => safeHref(username ? `https://t.me/${username}` : '') ?? fallback;

function summaryItems(rows: any[], timezone: string, baseUrl: string): FeedItem[] {
  return rows.map(r => {
    const name = channelName(r.source_name);
    return { title: `${name} ${monthDay(r.window_end, timezone)}`, link: channelLink(r.username, baseUrl),
      guid: `telegram:${r.source_id}:${r.window_start}:${r.window_end}`, pubDate: r.window_end,
      html: publicSummary(r.rendered_html), author: name };
  });
}

export function sourceRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const source = db.prepare(`SELECT id,username,coalesce(display_name,title,reference) name FROM telegram_sources
    WHERE rss_token=? AND source_type='normal'`).get(token) as any;
  if (!source) return null;
  const rows = db.prepare(`SELECT s.*,j.window_start,j.window_end FROM telegram_summaries s
    JOIN telegram_summary_jobs j ON j.id=s.job_id WHERE s.source_id=? AND s.expires_at>?
    ORDER BY j.window_end DESC LIMIT 100`).all(source.id, new Date().toISOString()) as any[];
  const name = channelName(source.name);
  return rssDocument({ title: `Telegram · ${name}`, link: channelLink(source.username, baseUrl), selfUrl: `${baseUrl}/rss/telegram/source/${token}`,
    description: `${name} 每个时段的消息总结`,
    items: summaryItems(rows.map(r => ({ ...r, source_name: source.name, username: source.username })), timezoneOf(db), baseUrl) });
}

export function allRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const setting = db.prepare('SELECT all_rss_token FROM telegram_settings WHERE singleton=1').get() as any;
  if (!setting?.all_rss_token || setting.all_rss_token !== token) return null;
  const rows = db.prepare(`SELECT sm.*,j.window_start,j.window_end,s.username,coalesce(s.display_name,s.title,s.reference) source_name FROM telegram_summaries sm
    JOIN telegram_summary_jobs j ON j.id=sm.job_id JOIN telegram_sources s ON s.id=sm.source_id
    WHERE s.source_type='normal' AND s.enabled=1 AND sm.expires_at>? ORDER BY j.window_end DESC LIMIT 200`)
    .all(new Date().toISOString()) as any[];
  return rssDocument({ title: 'Telegram 群组总结', link: baseUrl, selfUrl: `${baseUrl}/rss/telegram/all/${token}`,
    description: '每个频道每个时段一条总结', items: summaryItems(rows, timezoneOf(db), baseUrl) });
}

/** 跨频道汇总：每个关闭时刻一条，复用全部频道 RSS 的令牌。正文按存储的要点重新渲染。 */
export function digestRss(db: TelegramDB, token: string, baseUrl: string): string | null {
  const setting = db.prepare('SELECT all_rss_token,timezone FROM telegram_settings WHERE singleton=1').get() as any;
  if (!setting?.all_rss_token || setting.all_rss_token !== token) return null;
  const rows = db.prepare(`SELECT * FROM telegram_digests WHERE status='completed' AND (expires_at IS NULL OR expires_at>?)
    ORDER BY window_end DESC LIMIT 100`).all(new Date().toISOString()) as any[];
  const items: FeedItem[] = rows.map(r => {
    let points: any[] = [];
    try { const j = JSON.parse(r.summary_json ?? '{}'); points = j.format === 'daily_v2' ? j.categories.flatMap((c: any) => c.items) : j.points ?? []; } catch { /* 无结构化要点 */ }
    return { title: `📌 Telegram 要点 · ${monthDay(r.window_end, setting.timezone)} ${slot(r.window_end, setting.timezone)}`,
      link: `${baseUrl}/telegram?tab=digests`, guid: `telegram-digest:${r.window_end}`, pubDate: r.window_end,
      html: withoutVagueLeadIns(digestHtml(db, r)), author: 'Telegram 跨频道要点',
      summary: points.slice(0, 3).map(p => String(p.text ?? '')).filter(Boolean).join('；') || undefined };
  });
  return rssDocument({ title: 'Telegram 跨频道要点', link: baseUrl, selfUrl: `${baseUrl}/rss/telegram/digest/${token}`,
    description: '每个时段一条，汇总所有频道并标注来源', items });
}

/** 供日报 RSS 拼接：返回指定区间内已完成的跨频道要点，按关闭时刻索引。 */
export function digestsForBriefFeed(db: TelegramDB, since: string): Map<string, { html: string; texts: string[] }> {
  const rows = db.prepare(`SELECT * FROM telegram_digests WHERE status='completed' AND window_end>=?
    AND (expires_at IS NULL OR expires_at>?)`).all(since, new Date().toISOString()) as any[];
  return new Map(rows.map(r => {
    let points: any[] = [];
    try { const j = JSON.parse(r.summary_json ?? '{}'); points = j.format === 'daily_v2' ? j.categories.flatMap((c: any) => c.items) : j.points ?? []; } catch { /* 无结构化要点 */ }
    return [new Date(r.window_end).toISOString(), { html: withoutVagueLeadIns(digestHtml(db, r)),
      texts: points.map(p => String(p.text ?? '')).filter(Boolean) }];
  }));
}
