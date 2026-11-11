import { loadRules, re } from './rules.ts';

export type SignalMap = Record<string, boolean>;
export type SignalDetail = { signals: SignalMap; links: string[]; repos: string[]; officialLinks: string[] };

const URL_RE = /https?:\/\/[^\s<>"')\]，。；]+/g;

const hostOf = (u: string): string => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const matchHost = (h: string, list: string[]) =>
  list.some(x => h === x || h.endsWith('.' + x));

/** 把 official_domains 的分组结构拍平。 */
let _official: string[] | null = null;
function officialDomains(): string[] {
  if (_official) return _official;
  const flat = (o: unknown): string[] =>
    Array.isArray(o) ? o.flatMap(flat)
      : (o && typeof o === 'object') ? Object.values(o).flatMap(flat)
      : typeof o === 'string' ? [o] : [];
  _official = flat(loadRules().official_domains);
  return _official;
}

/**
 * 抽取 13 个确定性信号（rules.yaml signals）。
 * 这些结果既用于 A–D 预判，也作为紧凑事实传给 Luna
 * —— PRD 15.2「已抽取代码仓库/步骤/官方链接」，模型不必自己找。
 */
export function extractSignals(text: string, html: string, sourceHost = ''): SignalDetail {
  const S = loadRules().signals;
  const both = `${html}\n${text}`;
  const links = [...new Set([...both.matchAll(URL_RE)].map(m => m[0].replace(/[.,;:]+$/, '')))];
  const hosts = links.map(hostOf);
  const OFF = officialDomains();

  const repos = links.filter(u => matchHost(hostOf(u), S.repo_url.url_host_any));
  const officialLinks = links.filter(u => matchHost(hostOf(u), OFF));

  /**
   * 正则信号求值。
   *
   * 【为什么要分别针对文本与 HTML】
   * 早先只测 text，于是 code_block 的 `<pre>…</pre>` 那条规则永远匹配不到 ——
   * 实测 linux.do 100 条候选里 11 条 HTML 含 <code>、7 条含 <pre>、
   * 纯文本围栏 0 条，而信号只命中 1 条。B 类（可复现实践）依赖 code_block，
   * 于是几乎全军覆没，黄金集里 B 类正例长期为 0。
   *
   * 但不能一律改成同时测 HTML：config_block 的
   * `key: value` 连续三行在任何带内联样式的 HTML 里都会命中，
   * price_mention 也会被 HTML 属性里的数字污染。
   * 因此由规则自己声明作用对象，默认仍是纯文本。
   */
  const target = (r: any): string =>
    r?.on === 'html' ? html : r?.on === 'both' ? both : text;
  const anyRegex = (d: any): boolean => {
    if (d?.regex) return re(d).test(target(d));
    if (d?.any_of) return d.any_of.some((r: any) => r.regex && re(r).test(target(r)));
    return false;
  };

  const signals: SignalMap = {
    repo_url: repos.length > 0,
    demo_link: links.some(u =>
      matchHost(hostOf(u), S.demo_link.url_host_any) ||
      (S.demo_link.or_path_regex && new RegExp(S.demo_link.or_path_regex).test(u))),
    official_link: officialLinks.length > 0,
    external_link: links.filter(u => !sourceHost || hostOf(u) !== sourceHost).length >= (S.external_link.min_count ?? 1),
    code_block: anyRegex(S.code_block),
    command_line: anyRegex(S.command_line),
    config_block: anyRegex(S.config_block),
    install_hint: anyRegex(S.install_hint),
    policy_mention: anyRegex(S.policy_mention),
    price_mention: anyRegex(S.price_mention),
    invite_code: anyRegex(S.invite_code),
    step_markers: (() => {
      const n = S.step_markers.min_count ?? 1;
      return S.step_markers.any_of.some((r: any) =>
        (text.match(re(r, 'g')) ?? []).length >= n);
    })(),
    aff_link: (() => {
      const d = S.aff_link;
      const hostList = d.any_of.find((x: any) => x.url_host_any)?.url_host_any ?? [];
      if (links.some(u => matchHost(hostOf(u), hostList))) return true;
      const params: string[] = d.any_of.find((x: any) => x.url_query_param_any)?.url_query_param_any ?? [];
      if (links.some(u => { try { const q = new URL(u).searchParams; return params.some(p => q.has(p)); } catch { return false; } }))
        return true;
      const rx = d.any_of.find((x: any) => x.regex);
      return rx ? re(rx).test(text) : false;
    })(),
  };
  void hosts;
  return { signals, links, repos, officialLinks };
}

/**
 * 强制保留 A–D 程序预判（rules.yaml mandatory_retention.classes）。
 * 只判断「有没有硬证据」；「是不是那个类别」交给 AI 语义确认。
 */
/**
 * 强制保留 A–D 预判（PRD 8.2）。
 *
 * 条件一律从 rules.yaml 的 mandatory_retention.classes[].prescreen 求值 ——
 * 早先规则在 YAML 里声明、在这里硬编码了第二遍，两边会静默漂移，
 * 和确定性过滤当初 DF-030 从未生效是同一个毛病。
 * 求值器不认识的条件类型抛错，不静默跳过。
 *
 * 这里只做「有无客观证据」的预判，不判主题是否相关 ——
 * 后者是 topic_scope + ai_confirm 的职责（PRD 8.2 两段式）。
 */
export function prescreenMandatory(s: SignalMap): string[] {
  const classes = loadRules().mandatory_retention?.classes ?? [];
  return classes.filter((c: any) => evalPrescreen(c.prescreen, s, c.class))
                .map((c: any) => String(c.class));
}

/** prescreen 条件求值。支持 signal / not_signal / any_of / all_of 及其嵌套。 */
function evalPrescreen(cond: any, s: SignalMap, cls: string): boolean {
  if (cond == null) return false;
  // any_of/all_of 的元素允许直接写信号名：`any_of: [code_block, install_hint]`
  if (typeof cond === 'string') return !!s[cond];
  if (Array.isArray(cond)) return cond.every(c => evalPrescreen(c, s, cls));
  if (cond.all_of) return cond.all_of.every((c: any) => evalPrescreen(c, s, cls));
  if (cond.any_of) return cond.any_of.some((c: any) => evalPrescreen(c, s, cls));
  if (cond.signal !== undefined) return !!s[cond.signal];
  if (cond.not_signal !== undefined) return !s[cond.not_signal];
  throw new Error(`${cls} 类 prescreen 含未知条件：${JSON.stringify(cond).slice(0, 80)}`);
}

/**
 * 自检：每个类别都要有可求值的 prescreen，且引用的信号必须真实存在。
 * 供校验器在 CI 里调用，堵住「YAML 里写了但信号名拼错」这类静默失效。
 */
export function auditPrescreenCoverage(): string[] {
  const classes = loadRules().mandatory_retention?.classes ?? [];
  const known = new Set(Object.keys(loadRules().signals ?? {}));
  const problems: string[] = [];
  const walk = (c: any, cls: string): void => {
    if (c == null) return;
    if (typeof c === 'string') { if (!known.has(c)) problems.push(`${cls} 类引用了未定义信号「${c}」`); return; }
    if (Array.isArray(c)) return c.forEach(x => walk(x, cls));
    if (c.all_of) return c.all_of.forEach((x: any) => walk(x, cls));
    if (c.any_of) return c.any_of.forEach((x: any) => walk(x, cls));
    for (const k of ['signal', 'not_signal'])
      if (c[k] !== undefined && !known.has(c[k])) problems.push(`${cls} 类引用了未定义信号「${c[k]}」`);
  };
  for (const c of classes) {
    if (!c.prescreen) problems.push(`${c.class} 类没有 prescreen —— 永远预判不到`);
    walk(c.prescreen, String(c.class));
  }
  return problems;
}

/** 全文抓取门（rules.yaml source_specific.forum_fulltext.fetch_gate）。 */
export function needsFulltext(
  sourceId: string, title: string, excerpt: string, isExcerpt: boolean, s: SignalMap,
): { need: boolean; reason: string } {
  const cfg = loadRules().source_specific?.forum_fulltext;
  if (!cfg?.applies_to_sources?.includes(sourceId)) return { need: false, reason: 'not_applicable' };

  const hints: string[] = cfg.hint_keywords ?? [];
  const hay = `${title}\n${excerpt}`;
  const hitHint = hints.find(k => hay.includes(k));
  if (hitHint) return { need: true, reason: `hint:${hitHint}` };

  // 摘要里已经露出任一信号 → 全文大概率有更多证据
  if (isExcerpt && Object.values(s).some(Boolean))
    return { need: true, reason: 'excerpt_truncated_and_any_signal' };

  return { need: false, reason: 'no_gate_hit' };
}
