/**
 * 所有 RSS 订阅共用的 RSS 2.0 输出，按 NetNewsWire 等阅读器的惯例：
 * - 完整正文放 content:encoded，description 只放一两句纯文本，供文章列表显示预览；
 * - 正文是不带任何内联样式的语义化 HTML（h2/h3/p/ol），排版交给阅读器主题，
 *   深色模式、字号和阅读宽度都随阅读器设置走；
 * - 带 atom:link rel=self、lastBuildDate、ttl、dc:creator，阅读器据此去重和安排刷新。
 */

export const xml = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const htmlEsc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 只允许 https 链接进入正文，与邮件模板的 safeUrl 规则一致 */
export function safeHref(raw: unknown): string | null {
  try { const u = new URL(String(raw ?? '').trim()); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}

/** 从 HTML 取纯文本摘要，用作阅读器列表里的预览 */
export function plainSummary(html: string, max = 140): string {
  const text = html.replace(/<(h[1-6])[^>]*>.*?<\/\1>/gs, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type FeedItem = { title: string; link: string; guid: string; pubDate: Date | string; html: string; summary?: string; author?: string };

export function rssDocument(o: { title: string; link: string; selfUrl?: string; description: string; items: FeedItem[]; ttlMinutes?: number }): string {
  const date = (d: Date | string) => new Date(d).toUTCString();
  const latest = o.items.map(i => new Date(i.pubDate).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const items = o.items.map(i => `<item><title>${xml(i.title)}</title><link>${xml(i.link)}</link>` +
    `<guid isPermaLink="false">${xml(i.guid)}</guid><pubDate>${date(i.pubDate)}</pubDate>` +
    `<dc:creator>${xml(i.author ?? o.title)}</dc:creator>` +
    `<description>${xml(i.summary ?? plainSummary(i.html))}</description>` +
    `<content:encoded>${xml(i.html)}</content:encoded></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">` +
    `<channel><title>${xml(o.title)}</title><link>${xml(o.link)}</link><description>${xml(o.description)}</description>` +
    `<language>zh-CN</language>${o.selfUrl ? `<atom:link href="${xml(o.selfUrl)}" rel="self" type="application/rss+xml"/>` : ''}` +
    `${latest ? `<lastBuildDate>${new Date(latest).toUTCString()}</lastBuildDate>` : ''}<ttl>${o.ttlMinutes ?? 30}</ttl>${items}</channel></rss>`;
}
