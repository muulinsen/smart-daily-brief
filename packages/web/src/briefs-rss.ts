/**
 * 日报 RSS：每期已定稿的日报一条。
 *
 * 正文不复用邮件 HTML：邮件为兼容各家客户端用了表格布局、固定宽度和全量内联样式，
 * 在 NetNewsWire 里会渲染成带边框的窄盒子并重复标题。这里从 brief_items 重建一份
 * 语义化 HTML（分区 h2、条目 h3、段落；原文链接只放在条目标题上），分区顺序与标题取自 rules.yaml，与邮件一致；
 * 排版完全交给阅读器主题。2026-10-22 起不再拼接 Telegram 要点；新版日报直接渲染 briefs.digest_json。
 * 令牌存于 feed_tokens（name='briefs'）。
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../../db/src/index.ts';
import { loadRules } from '../../domain/src/rules.ts';
import { htmlEsc as esc, rssDocument, safeHref, type FeedItem } from './feed-xml.ts';
import { renderDigestFeedHtml, digestCount, digestTitles } from '../../digest/src/render.ts';

export function briefFeedToken(db: DB): string | null {
  return (db.prepare("SELECT token FROM feed_tokens WHERE name='briefs'").get() as any)?.token ?? null;
}

export function rotateBriefFeedToken(db: DB, revoke = false): string | null {
  const token = revoke ? null : randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO feed_tokens(name,token,rotated_at) VALUES('briefs',?,?)
    ON CONFLICT(name) DO UPDATE SET token=excluded.token, rotated_at=excluded.rotated_at`).run(token, new Date().toISOString());
  return token;
}

type Section = { id: string; title: string };
const TZ = 'Asia/Taipei';
const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const mdLabel = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(iso)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.month}月${p.day}日`;
};

/** 一期日报的阅读器正文。sections 默认取 rules.yaml，测试可注入。 */
export function briefFeedHtml(db: DB, briefId: number, sections: Section[] = defaultSections()): { html: string; titles: string[]; count: number } {
  const b = db.prepare(`SELECT r.window_start_at, r.window_end_at, b.digest_json FROM briefs b JOIN runs r ON r.id=b.run_id WHERE b.id=?`).get(briefId) as any;
  // 新版日报：与邮件同一份结构化数据渲染（官方动态 / 开源项目 / 时政速览）
  if (b?.digest_json) {
    const d = JSON.parse(b.digest_json);
    return { html: renderDigestFeedHtml(d), titles: digestTitles(d), count: digestCount(d) };
  }
  const items = db.prepare(`SELECT i.section, i.title, i.conclusion, i.summary_json, i.source_url
    FROM brief_items i WHERE i.brief_id=? ORDER BY i.order_no`).all(briefId) as any[];
  const link = (href: string | null, text: string) => href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);

  const titles: string[] = [];   // 按正文顺序，供列表预览
  const known = new Set(sections.map(s => s.id));
  const ordered = [...sections, ...[...new Set(items.map(i => String(i.section)))].filter(id => !known.has(id)).map(id => ({ id, title: id }))];
  const body = ordered.map(sec => {
    const xs = items.filter(i => i.section === sec.id);
    if (!xs.length) return '';
    return `<h2>${esc(sec.title)}</h2>` + xs.map(i => {
      const url = safeHref(i.source_url);
      titles.push(String(i.title));
      let summary: string[] = [];
      try { summary = JSON.parse(i.summary_json ?? '[]'); } catch { /* 旧数据 */ }
      return `<h3>${link(url, i.title)}</h3>` +
        `<p><strong>${esc(i.conclusion)}</strong></p>` +
        (summary.length ? `<p>${summary.map(esc).join('')}</p>` : '');
    }).join('');
  }).join('');
  const head = `<p>${esc(hhmm(b.window_start_at))}–${esc(hhmm(b.window_end_at))} 的新内容，共 ${items.length} 条。</p>`;
  return { html: head + body, titles, count: items.length };
}

function defaultSections(): Section[] {
  try {
    return ((loadRules() as any).brief?.sections ?? [])
      .filter((s: any) => s.id !== 'core_highlights' && s.id !== 'audit').map((s: any) => ({ id: s.id, title: s.title }));
  } catch { return []; }
}

/** 同一时段的 Telegram 跨频道要点，按关闭时刻（ISO）索引；由调用方从 Telegram 库读取 */
export type TelegramDigests = (since: string) => Map<string, { html: string; texts: string[] }>;
/** 每期一条日报正文（不再拼接 Telegram 要点）。 */
export function briefsRss(db: DB, token: string, baseUrl: string, limit = 20, sections?: Section[], telegram?: TelegramDigests): string | null {
  const current = briefFeedToken(db);
  if (!current || current !== token) return null;
  const rows = db.prepare(`SELECT b.id, b.created_at, r.id run_id, r.window_key, r.window_label, r.window_end_at,
      (SELECT d.sent_at FROM deliveries d WHERE d.brief_id=b.id AND d.status='sent' ORDER BY d.sent_at LIMIT 1) sent_at
    FROM briefs b JOIN runs r ON r.id=b.run_id
    WHERE b.status='final' AND b.version=(SELECT max(version) FROM briefs x WHERE x.run_id=b.run_id AND x.status='final')
    ORDER BY r.window_start_at DESC LIMIT ?`).all(limit) as any[];
  // 2026-10-22：按用户要求移除「Telegram 频道要点」，telegram 参数保留仅为兼容调用方，不再使用。
  void telegram;
  const items: FeedItem[] = rows.map(r => {
    const f = briefFeedHtml(db, r.id, sections);
    return { title: `${mdLabel(r.window_end_at)} ${r.window_label} · ${f.count} 条`, link: `${baseUrl}/runs/${r.run_id}`,
      guid: `brief:${r.window_key}:${r.id}`, pubDate: r.sent_at ?? r.created_at, html: f.html,
      summary: f.titles.slice(0, 3).join('；') + (f.count > 3 ? ' 等' : ''), author: '十六源日报' };
  });
  items.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
  return rssDocument({ title: '十六源日报', link: baseUrl, selfUrl: `${baseUrl}/rss/briefs/${token}`,
    description: '每天早、午、晚三期：官方动态、开源项目、时政速览', items, ttlMinutes: 60 });
}
