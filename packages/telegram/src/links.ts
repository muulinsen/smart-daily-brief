/**
 * 消息里的链接（含不带协议头的域名路径，如 `tg7788.com/buy/553`、`t.me/xxx_bot`）的识别、校验与渲染。
 * 摘要里出现的购买地址必须来自输入消息原文：restrictLinks 把不在白名单里的链接剔除，
 * 在白名单里的链接还原成输入里的原样写法（模型加的 https:// 之类会被改回去）。无依赖，可被日报渲染层直接引用。
 */

/** 不带路径的裸域名只在这些常见后缀下才算链接（避免把 Node.js、Next.js 之类误判为域名）；带路径的域名不受此限。 */
const COMMON_TLDS = new Set(('com net org io cc me co xyz top vip shop store site online app dev link ly so gg ai tv pro info biz us uk cn hk tw jp kr ru de fr in to sh fm cloud club live fun icu cyou buzz work tech wiki today ink xin la ws mobi asia pw one ac').split(' '));
const PATH_CHARS = "[\\w\\-.~:/?#@!$&*+,;=%]";
const LINK_RE = new RegExp(
  `https?://${PATH_CHARS}+|(?<![\\w@./:-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?\\.)+[A-Za-z]{2,24}(?:/${PATH_CHARS}*)?(?![\\w-])`, 'g');
const TRAILING = /[.,;:!?)\]}'"]+$/;

export type FoundLink = { raw: string; start: number; end: number };

/** 按出现顺序返回文本中的链接（raw 为原样写法，已去掉句末标点）。 */
export function findLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of String(text ?? '').matchAll(LINK_RE)) {
    const raw = m[0].replace(TRAILING, '');
    if (!raw) continue;
    if (!/^https?:\/\//i.test(raw)) {
      const [host, ...rest] = raw.split('/');
      const tld = host!.split('.').pop()!.toLowerCase();
      if (!rest.length || !rest.join('/')) { if (!COMMON_TLDS.has(tld)) continue; }
      else if (!/^[a-z]{2,24}$/i.test(tld)) continue;
    }
    if (!linkHref(raw)) continue;
    out.push({ raw, start: m.index!, end: m.index! + raw.length });
  }
  return out;
}

/** 可点击的 href：已有 http(s) 协议头的保持，不带协议头的补 https://；带用户名密码或无效的返回 null。 */
export function linkHref(raw: string): string | null {
  const s = String(raw ?? '').trim();
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

/** 比较用的规范形式：去协议头和 www.、主机名小写、去末尾斜杠，路径大小写保留。 */
export function normalizeLink(raw: string): string {
  const s = String(raw ?? '').trim().replace(/^https?:\/\//i, '');
  const i = s.indexOf('/');
  const host = (i < 0 ? s : s.slice(0, i)).toLowerCase().replace(/^www\./, '');
  return `${host}${i < 0 ? '' : s.slice(i)}`.replace(/\/+$/, '');
}

/** 收集文本里的全部链接：规范形式 → 输入里的原样写法（先出现的优先）。 */
export function collectLinks(texts: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of texts) for (const l of findLinks(t)) { const k = normalizeLink(l.raw); if (!out.has(k)) out.set(k, l.raw); }
  return out;
}

/** 摘要文本里的链接必须在白名单（输入消息）里：在的还原为原样写法，不在的整段剔除。 */
export function restrictLinks(text: string, allowed: Map<string, string>): { text: string; removed: string[] } {
  const src = String(text ?? ''); const removed: string[] = []; let out = ''; let pos = 0;
  for (const l of findLinks(src)) {
    out += src.slice(pos, l.start); pos = l.end;
    const orig = allowed.get(normalizeLink(l.raw));
    if (orig) out += orig; else removed.push(l.raw);
  }
  out += src.slice(pos);
  return { text: removed.length ? out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。；,.;])/g, '$1').trim() : out, removed };
}

/**
 * 把文本渲染成转义后的 HTML，其中的链接变成 <a>（显示文字保持原样，不带协议头的补 https:// 作 href）。
 * href 可经 opts.href 二次过滤（如日报邮件只放行 https）；返回 null 时按纯文本输出。
 */
export function renderLinkedHtml(text: string, esc: (s: unknown) => string, opts: { href?: (url: string) => string | null; attrs?: string } = {}): string {
  const src = String(text ?? ''); let out = ''; let pos = 0;
  for (const l of findLinks(src)) {
    out += esc(src.slice(pos, l.start)); pos = l.end;
    const base = linkHref(l.raw); const href = base && (opts.href ? opts.href(base) : base);
    out += href ? `<a href="${esc(href)}"${opts.attrs ?? ''}>${esc(l.raw)}</a>` : esc(l.raw);
  }
  return out + esc(src.slice(pos));
}

/** 只接受 t.me 的消息链接作为「原消息」。 */
export const isTelegramMessageUrl = (u: unknown): u is string => /^https:\/\/t\.me\/[\w/+-]+$/.test(String(u ?? ''));
