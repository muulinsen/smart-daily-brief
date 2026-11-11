import { XMLParser } from 'fast-xml-parser';

export type RawItem = {
  title: string;
  html: string;            // 原始正文 HTML
  link: string | null;
  guid: string | null;
  publishedRaw: string | null;
  author: string | null;
};

/**
 * 把“一觉醒来发生了什么 MM月DD日”一类聚合日报拆成独立消息。
 * 聚合帖里的每个编号有自己的标题和原文 URL，本质上是不同事件；如果把整帖
 * 当成一个候选，模型只能给整包一个分区/event_key，无法逐条分类与去重。
 */
export function expandCompositeDigest(item: RawItem): RawItem[] {
  const superTechFans = expandSuperTechFansDigest(item);
  if (superTechFans) return superTechFans;
  if (!/^一觉醒来发生了什么\s+\d{2}月\d{2}日/.test(item.title.trim())) return [item];
  const plain = String(item.html ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\r/g, '');
  const lines = plain.split('\n').map(x => x.trim()).filter(Boolean);
  const out: RawItem[] = [];
  let section = '资讯';
  let pending: { title: string; index: string } | null = null;

  for (const line of lines) {
    if (/资讯快读/.test(line)) { section = '资讯快读'; pending = null; continue; }
    if (/即刻镇小报/.test(line)) { section = '即刻镇小报'; pending = null; continue; }
    const numbered = line.match(/^(\d+)[、.．]\s*(.+)$/);
    if (numbered) {
      pending = { index: numbered[1]!, title: numbered[2]!.trim() };
      const inlineUrl = pending.title.match(/\s+(https:\/\/\S+)$/)?.[1];
      if (inlineUrl) {
        pending.title = pending.title.slice(0, -inlineUrl.length).trim();
        out.push(child(inlineUrl)); pending = null;
      }
      continue;
    }
    const url = line.match(/^https:\/\/\S+/)?.[0];
    if (pending && url) { out.push(child(url)); pending = null; continue; }
    if (pending && !/^今日.+内容来自/.test(line)) pending.title += ` ${line}`;
  }

  // 至少拆出两条才视为聚合日报；格式异常时保留原条目，避免静默丢内容。
  return out.length >= 2 ? out : [item];

  function child(url: string): RawItem {
    const p = pending!;
    return {
      title: p.title,
      html: `${p.title}\n\n聚合栏目：${section}\n原合集：${item.title}`,
      link: url,
      guid: null,
      publishedRaw: item.publishedRaw,
      author: item.author,
    };
  }
}

/**
 * SuperTechFans 每期 RSS 条目包含 10 篇独立的 Hacker News 消息。
 * 数字 h2 到下一个 h2 是一篇消息；其中第一条外链是原文，HN item id
 * 是跨日期、排名变化仍保持不变的条目标识。
 */
export function expandSuperTechFansDigest(item: RawItem): RawItem[] | null {
  if (!/^\d{4}\s+\d{2}\s+\d{2}\s+HackerNews$/i.test(item.title.trim())) return null;

  const decode = (s: string) => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&rsquo;/gi, '’').replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”').replace(/&ldquo;/gi, '“')
    .replace(/&ndash;/gi, '–').replace(/&mdash;/gi, '—');
  const headings = [...String(item.html ?? '').matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  const out: RawItem[] = [];

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!;
    const heading = decode(h[1]!.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const numbered = heading.match(/^(\d+)\.\s*(.+?)(?:\s+#)?$/);
    if (!numbered) continue;

    const sectionStart = h.index! + h[0]!.length;
    const sectionEnd = headings[i + 1]?.index ?? item.html.length;
    const section = item.html.slice(sectionStart, sectionEnd).trim();
    const urls = [...section.matchAll(/href=(?:&#34;|&quot;|["'])(https?:\/\/.*?)(?:&#34;|&quot;|["'])/gi)]
      .map(m => decode(m[1]!));
    const link = urls.find(u => !u.startsWith('https://news.ycombinator.com/item?')) ?? urls[0] ?? item.link;
    const hnId = section.match(/https:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i)?.[1] ?? null;
    const date = item.title.trim().slice(0, 10).replace(/\s/g, '-');
    const title = numbered[2]!.trim();

    out.push({
      title,
      html: section,
      link,
      guid: hnId ? `hn:${hnId}` : `supertechfans:${date}:${title}`.slice(0, 190),
      publishedRaw: item.publishedRaw,
      author: 'SuperTechFans',
    });
  }

  // 页面结构异常时保留整篇，避免静默丢失该期内容。
  return out.length >= 2 ? out : [item];
}

const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', cdataPropName: '__cdata',
  trimValues: true, parseTagValue: false,
});

const txt = (v: any): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt(v.__cdata ?? v['#text'] ?? '');
  return '';
};

/** RSS 2.0 + Atom，容忍 CDATA、HTML 描述与不规范日期（PRD 4.4）。 */
export function parseFeed(body: string): RawItem[] {
  const doc = xml.parse(body);
  const out: RawItem[] = [];

  for (const it of [].concat(doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item ?? [])) {
    const i: any = it;
    out.push({
      title: txt(i.title),
      html: txt(i['content:encoded']) || txt(i.description) || '',
      link: txt(i.link) || null,
      guid: txt(i.guid) || null,
      publishedRaw: txt(i.pubDate) || txt(i['dc:date']) || null,
      author: txt(i.author) || txt(i['dc:creator']) || null,
    });
  }
  for (const en of [].concat(doc?.feed?.entry ?? [])) {
    const e: any = en;
    const links = [].concat(e.link ?? []);
    const alt = links.find((l: any) => !l?.['@rel'] || l['@rel'] === 'alternate');
    out.push({
      title: txt(e.title),
      html: txt(e.content) || txt(e.summary) || '',
      link: (alt as any)?.['@href'] ?? txt(e.link) ?? null,
      guid: txt(e.id) || null,
      publishedRaw: txt(e.published) || txt(e.updated) || null,
      author: txt(e.author?.name) || null,
    });
  }
  return out.filter(i => i.title || i.html);
}

/** V2EX 官方热门主题 JSON。避免依赖易失效的 RSSHub 转换路由。 */
export function parseV2exHotJson(body: string): RawItem[] {
  const rows = JSON.parse(body);
  if (!Array.isArray(rows)) throw new Error('V2EX 热门接口返回值不是数组');
  return rows.map((row: any): RawItem => {
    const id = Number(row?.id);
    const created = Number(row?.created);
    return {
      title: String(row?.title ?? '').trim(),
      html: String(row?.content_rendered ?? row?.content ?? ''),
      link: row?.url ? String(row.url).replace(/^http:\/\//i, 'https://') : null,
      guid: Number.isFinite(id) ? `v2ex:t:${id}` : null,
      publishedRaw: Number.isFinite(created) && created > 0
        ? new Date(created * 1000).toISOString()
        : null,
      author: row?.member?.username ? String(row.member.username) : null,
    };
  }).filter((i: RawItem) => i.title || i.html);
}

/**
 * t.me/s/<channel> 网页版解析（实施方案 2.2 的 Telegram 二级兜底）。
 * 不依赖任何第三方 RSSHub 实例。data-post 形如 "durov/123"，
 * 正好满足 PRD 7.1「Telegram channel + message ID」的身份键要求。
 */
export function parseTelegramWeb(body: string, channel: string): RawItem[] {
  const out: RawItem[] = [];
  // 注意：不能按 class 前缀切块 —— `tgme_widget_message` 同时是 _text/_meta
  // 等子元素的前缀，会把正文容器切到相邻块里。改为按 data-post 出现位置切片。
  const marks = [...body.matchAll(/data-post="([^"]+)"/g)];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]!;
    const post = m[1]!;
    const start = m.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
    const block = body.slice(start, end);

    const textHtml = block.match(
      /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
    const time = block.match(/<time[^>]+datetime="([^"]+)"/)?.[1] ?? null;
    if (!textHtml.trim()) continue;

    const plain = textHtml.replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();

    out.push({
      title: plain.slice(0, 120),
      html: textHtml,
      link: `https://t.me/${post}`,
      guid: `tg:${post.replace('/', ':')}`,
      publishedRaw: time,
      author: `@${channel}`,
    });
  }
  return out;
}

/**
 * DeepSeek 更新日志网页（PRD FR-013：按日期、标题、链接和正文片段构建版本指纹）。
 *
 * 页面结构（Docusaurus）：
 *   <h2 id="时间-2026-08-21">时间: 2026-08-21</h2>     ← 日期节
 *   <h3 id="deepseek-v4-flash-vision-exp-发布">…</h3>  ← 该日期下的发布条目
 * h3 的 id 是稳定锚点，用作身份键并拼出深链。
 *
 * 注意：早期实现按 h2/h3 标题文本做键，而「deepseek-chat」这类标题会在
 * 多个日期节里重复出现，导致 5 个不同发布被折叠成同一条目的 5 个版本。
 * 键必须包含日期。
 */
export function parseDeepseekPage(body: string): RawItem[] {
  const BASE = 'https://api-docs.deepseek.com/zh-cn/updates/';
  const out: RawItem[] = [];
  const zw = (t: string) => t.replace(/[\u200b-\u200f\ufeff]/g, '');

  const heads = [...body.matchAll(/<(h[23])\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  let curDate: string | null = null;

  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const tag = h[1]!;
    const attrs = h[2]!;
    const id = attrs.match(/id="([^"]+)"/)?.[1] ?? '';
    const text = zw(h[3]!.replace(/<[^>]+>/g, '')).trim();

    if (tag === 'h2') {
      // 日期节：从 id 或文本里取 YYYY-MM-DD
      curDate = (id.match(/(\d{4}-\d{2}-\d{2})/) ?? text.match(/(\d{4}-\d{2}-\d{2})/))?.[1] ?? null;
      continue;
    }

    // h3 = 一条发布。正文取到下一个 h2/h3 之前
    const bodyStart = h.index! + h[0]!.length;
    const bodyEnd = heads[i + 1]?.index ?? body.length;
    const section = body.slice(bodyStart, bodyEnd);

    out.push({
      title: curDate ? `${text}（${curDate}）` : text,
      html: section,
      link: id ? `${BASE}#${encodeURIComponent(id)}` : BASE,
      // 键含日期 → 同名标题在不同日期下互不碰撞
      guid: `deepseek:${curDate ?? 'undated'}:${zw(id) || text.slice(0, 60)}`,
      publishedRaw: curDate,
      author: 'DeepSeek',
    });
  }
  return out;
}

/**
 * OpenAI 产品更新页经 Jina Reader 转换后的 Markdown。
 *
 * 官方 RSS 在当前服务器出口会触发 Cloudflare challenge，但同一官方页面经
 * Jina Reader 可返回重复结构：产品、日期、发布阶段、二级标题、正文。
 * 条目标识只使用产品、日期和标题，代理抓取时间不会制造重复条目。
 */
export function parseOpenAIReleaseNotesPage(body: string): RawItem[] {
  const PAGE = 'https://openai.com/products/release-notes/';
  const marker = 'Markdown Content:';
  const content = body.includes(marker)
    ? body.slice(body.indexOf(marker) + marker.length).trim()
    : body.trim();
  const entry = /(?:^|\n)([^\n]{1,50})\n\n([A-Z][a-z]{2} \d{1,2}, \d{4})\n\n([^\n]{1,40})\n\n## ([^\n]+)\n/g;
  const matches = [...content.matchAll(entry)];
  const out: RawItem[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const product = m[1]!.trim();
    const date = m[2]!.trim();
    const stage = m[3]!.trim();
    const title = m[4]!.trim();
    const start = m.index! + m[0]!.length;
    const end = matches[i + 1]?.index ?? content.length;
    const section = content.slice(start, end).trim();
    const source = section.match(/\[View source[^\]]*\]\((https?:\/\/[^)]+)\)/i)?.[1] ?? PAGE;
    const stable = `${date}:${product}:${title}`.toLowerCase().replace(/\s+/g, ' ').trim();

    out.push({
      title,
      html: `产品：${product}\n发布阶段：${stage}\n\n${section}`,
      link: source,
      guid: `openai-release:${stable}`,
      publishedRaw: date,
      author: `OpenAI · ${product}`,
    });
  }
  return out;
}

export function parseBy(parser: string, body: string, ctx: { channel?: string }): RawItem[] {
  let parsed: RawItem[];
  switch (parser) {
    case 'rss': case 'atom':   parsed = parseFeed(body); break;
    case 'v2ex_json':          parsed = parseV2exHotJson(body); break;
    case 'telegram_web':       parsed = parseTelegramWeb(body, ctx.channel ?? ''); break;
    case 'deepseek_page':      parsed = parseDeepseekPage(body); break;
    case 'openai_release_notes_page': parsed = parseOpenAIReleaseNotesPage(body); break;
    default: throw new Error(`未知解析器: ${parser}`);
  }
  return parsed.flatMap(expandCompositeDigest);
}
