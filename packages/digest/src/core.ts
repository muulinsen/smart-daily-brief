/**
 * 新版日报（官方动态 / 开源项目 / 时政速览）的确定性部分：
 * 条目清洗、转发/琐碎帖过滤、GitHub 仓库抽取、相似度与转载判定、URL 级预合并。
 * 不调用模型、不读写数据库，便于单测。
 */

export type DigestSourceItem = {
  id: number;
  sourceId: string;
  sourceName: string;
  vendor: string;
  official: boolean;
  role: 'official' | 'politics' | 'context';
  title: string;
  text: string;
  url: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
};

export type DigestLink = { label: string; url: string };
export type DigestEvent = { title: string; summary: string; links: DigestLink[]; itemIds: number[] };
export type DigestVendor = { vendor: string; name: string; events: DigestEvent[] };
export type DigestProject = { repo: string; url: string; description: string; mentionedBy: DigestLink[] };
/** 技术教程：来自 LINUX DO / V2EX 的可复现技术帖。summary 为 1–2 句概括，url 为原帖链接。 */
/** 板块内的专栏：tech 技术干货 / deals 羊毛资讯 / life 生活经验。旧数据缺省视为 tech。 */
export type TutorialCategory = 'tech' | 'deals' | 'life';
/** channel：forum 论坛帖 / telegram 群消息 / other 其他渠道；缺省视为 forum。url 为空字符串表示没有可用链接（不编造）。 */
export type DigestTutorial = { title: string; summary: string; url: string; itemId: number; category?: TutorialCategory; channel?: 'forum' | 'telegram' | 'other' };
export type DigestData = {
  format: 'digest_v2';
  date: string;            // YYYY-MM-DD（北京时间）
  windowLabel: string;
  windowRange: string;     // 如 10-22 08:00–12:00
  vendors: DigestVendor[]; // 只含有内容的厂商
  emptyVendors: string[];  // 本期无更新的厂商显示名
  projects: DigestProject[];
  /** 三、技术教程。缺省（旧数据）= 无该板块；空数组 = 板块显示「本期无…」。 */
  tutorials?: DigestTutorial[];
  politics: string[];      // 每条一个新闻，1–2 句；无内容时为空数组（旧数据可能是字符串）
  /** 末节 Telegram 群组要点（仅每日简报）。缺省 = 不显示该节。 */
  telegram?: DigestTelegram;
};
export type DigestTelegram = {
  status: 'ready' | 'pending';
  windowStart?: string; windowEnd?: string;
  categories: Array<{ name: string; items: Array<{ text: string; groups: string[]; /** 购买地址所在原消息的 t.me 链接（有才有） */ sourceUrls?: string[] }> }>;
  groups: string[];
  notes?: string[];
};

/** 厂商显示名与固定顺序。未列出的厂商排在最后，按 id 显示。 */
export const VENDORS: Array<{ id: string; name: string }> = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'google', name: 'Google' },
  { id: 'github', name: 'GitHub' },
  { id: 'notion', name: 'Notion' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'cloudflare', name: 'Cloudflare' },
  { id: 'hermes', name: 'Hermes Agent' },
  { id: 'zlibrary', name: 'Z-Library' },
  { id: 'naval', name: 'Naval' },
  { id: 'ssamat', name: '@ssamat' },
];
export const vendorName = (id: string) => VENDORS.find(v => v.id === id)?.name ?? id;
export const vendorOrder = (id: string) => { const i = VENDORS.findIndex(v => v.id === id); return i < 0 ? 999 : i; };

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const URL_RE = /https?:\/\/[^\s<>"'）)\]]+/g;
export const linksIn = (s: string) => [...new Set((s.match(URL_RE) ?? []).map(u => u.replace(/[.,;:!?。，、]+$/, '')))];

/** 去掉查询串跟踪参数与尾斜杠，用于 URL 级比对。 */
export function urlKey(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^s$|^t$/i.test(k)) x.searchParams.delete(k);
    x.hash = '';
    const host = x.hostname.replace(/^www\./, '').replace(/^(mobile\.)?twitter\.com$/, 'x.com');
    return `${host}${x.pathname.replace(/\/+$/, '')}${x.search}`.toLowerCase();
  } catch { return null; }
}

/**
 * X 回复、纯转发、过短的寒暄帖不进入官方动态。
 * 只按确定性特征判断；拿不准的交给模型（模型可把整条标记为琐碎）。
 */
export function isReplyOrTrivial(it: Pick<DigestSourceItem, 'title' | 'text' | 'sourceId'>): boolean {
  const t = decodeEntities(it.title).trim();
  const body = decodeEntities(it.text).trim();
  if (/^(R to @|RT @|Re:?\s|@\w+)/i.test(t)) return true;
  const isX = it.sourceId.startsWith('x_');
  if (isX) {
    const plain = body.replace(URL_RE, '').replace(/[#@]\w+/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length < 25) return true;
  }
  return false;
}

/** GitHub 仓库抽取：返回小写 owner/repo，排除站点功能路径。 */
const GH_RESERVED = new Set(['orgs', 'features', 'topics', 'settings', 'marketplace', 'sponsors', 'apps', 'login', 'join',
  'about', 'pricing', 'enterprise', 'collections', 'trending', 'explore', 'notifications', 'site', 'security',
  'customer-stories', 'readme', 'events', 'team', 'solutions', 'resources', 'user-attachments', 'search', 'issues',
  'pulls', 'new', 'organizations', 'contact', 'blog', 'home', 'signup', 'codespaces', 'copilot', 'github-copilot', 'mobile']);
export function extractRepos(s: string): string[] {
  const out = new Set<string>();
  for (const m of String(s ?? '').matchAll(/(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})/g)) {
    const owner = m[1]!.toLowerCase();
    let repo = m[2]!.replace(/\.git$/i, '').replace(/[._-]+$/, '').toLowerCase();
    if (!repo || GH_RESERVED.has(owner) || repo === '..') continue;
    out.add(`${owner}/${repo}`);
  }
  return [...out];
}

/** 字符二元组 Jaccard 相似度，对中英文混排都可用。 */
export function similarity(a: string, b: string): number {
  const g = (s: string) => {
    const t = decodeEntities(s).normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const set = new Set<string>(); for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2)); return set;
  };
  const A = g(a), B = g(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type RepostVerdict = { verdict: 'repost' | 'uncertain' | 'distinct'; officialId: number | null; score: number };

/**
 * 非官方条目是否只是转载/轻改写官方条目（近 72 小时）。
 * 链接到同一官方 URL 或标题高度相似即判定为转载；中间地带交给模型。
 */
export function classifyRepost(item: DigestSourceItem, officials: DigestSourceItem[]): RepostVerdict {
  const mine = new Set([urlKey(item.url), ...linksIn(`${item.text}`).map(urlKey)].filter(Boolean) as string[]);
  let best: RepostVerdict = { verdict: 'distinct', officialId: null, score: 0 };
  for (const o of officials) {
    const ok = urlKey(o.url);
    if (ok && mine.has(ok)) return { verdict: 'repost', officialId: o.id, score: 1 };
    const s = Math.max(similarity(item.title, o.title), similarity(item.text.slice(0, 400), o.text.slice(0, 400)));
    if (s > best.score) best = { verdict: s >= 0.6 ? 'repost' : s >= 0.3 ? 'uncertain' : 'distinct', officialId: o.id, score: s };
  }
  return best;
}

/** 同一厂商内按共享链接预合并（并查集），返回分组的条目 id。 */
export function preMergeByLinks(items: DigestSourceItem[]): number[][] {
  const parent = new Map(items.map(i => [i.id, i.id]));
  const find = (x: number): number => { const p = parent.get(x)!; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const owner = new Map<string, number>();
  for (const it of items) {
    const keys = [urlKey(it.url), ...linksIn(it.text).map(urlKey)].filter(Boolean) as string[];
    for (const k of keys) {
      if (/^x\.com\/[^/]+$/.test(k) || /^(github\.com|x\.com|openai\.com|anthropic\.com|blog\.google)$/.test(k)) continue;
      const prev = owner.get(k);
      if (prev == null) owner.set(k, it.id); else { const a = find(prev), b = find(it.id); if (a !== b) parent.set(b, a); }
    }
  }
  const groups = new Map<number, number[]>();
  for (const it of items) { const r = find(it.id); groups.set(r, [...(groups.get(r) ?? []), it.id]); }
  return [...groups.values()];
}

/** 来源链接标签：官网条目用来源名，X 用 @账号。同一来源多条时编号。 */
export function linksFor(items: DigestSourceItem[]): DigestLink[] {
  const out: DigestLink[] = []; const seen = new Set<string>(); const count = new Map<string, number>();
  for (const it of items) {
    const k = urlKey(it.url); if (!it.url || !k || seen.has(k)) continue; seen.add(k);
    const n = (count.get(it.sourceName) ?? 0) + 1; count.set(it.sourceName, n);
    out.push({ label: n > 1 ? `${it.sourceName} (${n})` : it.sourceName, url: it.url });
  }
  return out;
}

/** 去掉标题/摘要开头重复的厂商名（如 OpenAI 分组下的「OpenAI 发布…」→「发布…」）。 */
export function stripVendorPrefix(text: string, vendorId: string, name: string): string {
  const names = [...new Set([name, vendorId, name.replace(/^@/, ''), ...(VENDOR_ALIASES[vendorId] ?? [])])].filter(Boolean)
    .sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`^\\s*(?:${names.join('|')})(?:\\s*(?:公司|官方|团队|旗下))?\\s*(?:[:：,，]\\s*)?`, 'i');
  const out = text.replace(re, '').trim();
  return out.length >= 4 ? out : text.trim();
}
const VENDOR_ALIASES: Record<string, string[]> = {
  anthropic: ['Anthropic'], openai: ['OpenAI'], google: ['Google', '谷歌'], github: ['GitHub'],
  notion: ['Notion'], deepseek: ['DeepSeek', '深度求索'], cloudflare: ['Cloudflare'],
};
