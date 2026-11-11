import { loadRules } from './rules.ts';
import { canonicalizeUrl } from './normalize.ts';

/**
 * 跨来源事件聚类与排序（PRD 7.4 / 8.4）。
 * 纯确定性逻辑 —— 依据 AI 给出的 event_key 与结构化评分，不再调模型。
 */

export type ClusterInput = {
  candidateId: string;
  sourceId: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  eventKey: string;
  section: string;
  decision: string;
  mandatoryClass: string;      // A|B|C|D|none
  confidence: number;
  importance: number;          // 0–1
  novelty: number;             // 0–1
  /** 确定性信号，用于「可验证性」「可操作性」两个维度 */
  signals: string[];
  /** 来源优先级，数字越小越可信 */
  sourcePriority: number;
  isOfficial?: boolean;
};

export type Cluster = {
  clusterKey: string;
  section: string;
  /** 最佳原始来源（PRD 7.4「合并后保留最佳原始来源」） */
  primary: ClusterInput;
  /** 其他渠道的贡献 */
  members: ClusterInput[];
  mandatoryClass: string;
  score: number;
};

/** 将模型事件键按人工别名归一化；跨窗口去重与单期聚类必须共用同一逻辑。 */
export function canonicalEventIdentity(title: string, eventKey: string): string {
  const text = title.toLowerCase();
  const aliases = loadRules().clustering?.event_aliases ?? [];
  const alias = aliases.find((a: any) =>
    (a.require_all ?? []).every((x: string) => text.includes(String(x).toLowerCase())) &&
    (!(a.require_any ?? []).length ||
      (a.require_any ?? []).some((x: string) => text.includes(String(x).toLowerCase()))));
  return alias?.key ?? eventKey;
}

/** story_clusters.cluster_key 的尾部固定为 section:mandatoryClass。 */
export function eventPartOfClusterKey(clusterKey: string): string {
  const parts = clusterKey.split(':');
  return parts.length > 2 ? parts.slice(0, -2).join(':') : clusterKey;
}

/**
 * 当天跨窗口去重时，忽略模型 event_key 末尾不一致的日期后缀。
 * 同一事件在早报可能被标成 `...-2026`，午报又被标成
 * `...-2026-09`；日期已由窗口限定，不应让这种格式漂移绕过去重。
 */
function dailyEventIdentity(eventKey: string): string {
  return eventKey.replace(/-(?:20\d{2})(?:-\d{2})?(?:-\d{2})?$/, '');
}

export type PriorBriefEvent = { title: string; clusterKey: string; sourceUrl?: string | null };

/** 同一标题是比模型事件键更强的信号；只做轻量规范化，避免模糊匹配误伤。 */
function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/[\s｜|]+/g, ' ').trim();
}

/**
 * 只消除新闻标题里不改变事件含义的轻微措辞差异。
 *
 * 这是 event_key 漂移时的保守兜底，不做宽泛关键词或向量相似匹配：例如
 * “发布/推出同一产品”可以合并，但“发布产品/公布售价”仍是两个不同标题。
 */
function normalizedEventWording(title: string): string {
  return normalizedTitle(title)
    .replace(/宣布正式推出|正式推出|宣布推出|推出|正式发布|发布了/g, '发布')
    .replace(/[\s，,。.!！?？:：;；“”"'‘’（）()【】\[\]·]/g, '');
}

/**
 * 保守的标题事实指纹：抽取英文/数字实体与中文双字词，去掉报道套话。
 * 只有至少两个共同 token 且重叠度达到阈值才视为同一事件，避免把同主题新闻合并。
 */
function titleTokens(title: string): Set<string> {
  const t = title.normalize('NFKC').toLowerCase()
    .replace(/发布|推出|宣布|报道|消息|表示|称|透露|最新|今日|今早|午报|早报|晚报/g, '');
  const out = new Set<string>();
  for (const m of t.matchAll(/[a-z0-9][a-z0-9._+-]{1,}/g)) out.add(m[0]);
  const han = t.replace(/[^\u3400-\u9fff]/g, '');
  for (let i = 0; i + 1 < han.length; i++) out.add(han.slice(i, i + 2));
  return out;
}

export function similarEventTitles(a: string, b: string): boolean {
  const price = (s: string) => /价格|售价|涨价|调价|成本|price|pricing|cost/i.test(s);
  const release = (s: string) => /发布|推出|上线|release|launch|available/i.test(s);
  if (price(a) !== price(b) && (price(a) || price(b)) && (release(a) || release(b))) return false;
  const ai = (s: string) => /\bai\b|人工智能|算法/i.test(s);
  if (ai(a) !== ai(b) && (ai(a) || ai(b))) return false;
  const x = titleTokens(a), y = titleTokens(b);
  if (x.size < 2 || y.size < 2) return false;
  let common = 0;
  for (const token of x) if (y.has(token)) common++;
  return common >= 3 && common / Math.min(x.size, y.size) >= 0.35;
}

/** 过滤同一台北自然日较早窗口已经推送的事件。 */
export function excludeCoveredToday(clusters: Cluster[], previous: PriorBriefEvent[]) {
  const priorKeys = new Map<string, PriorBriefEvent>();
  const priorUrls = new Map<string, PriorBriefEvent>();
  const priorTitles = new Map<string, PriorBriefEvent>();
  for (const p of previous) {
    const raw = eventPartOfClusterKey(p.clusterKey);
    priorKeys.set(dailyEventIdentity(canonicalEventIdentity(p.title, raw)), p);
    const url = p.sourceUrl ? canonicalizeUrl(p.sourceUrl) : null;
    if (url) priorUrls.set(url, p);
    priorTitles.set(normalizedEventWording(p.title), p);
  }
  const fresh: Cluster[] = [];
  const covered: Array<{ cluster: Cluster; previous: PriorBriefEvent }> = [];
  for (const c of clusters) {
    const raw = eventPartOfClusterKey(c.clusterKey);
    const key = dailyEventIdentity(canonicalEventIdentity(c.primary.title, raw));
    // 强信号优先：同一规范化原文 URL 或完全相同标题必定是重复；事件键
    // 只作为第三顺位。模型在不同层级可能为同一新闻生成不同 event_key。
    const currentUrl = c.primary.url ? canonicalizeUrl(c.primary.url) : null;
    const similar = previous.find(p => similarEventTitles(c.primary.title, p.title));
    const prior = (currentUrl ? priorUrls.get(currentUrl) : undefined)
      ?? priorTitles.get(normalizedEventWording(c.primary.title))
      ?? priorKeys.get(key)
      ?? similar;
    if (prior) covered.push({ cluster: c, previous: prior });
    else fresh.push(c);
  }
  return { fresh, covered };
}

/**
 * 分组。
 *
 * 只有同一事件才合并。PRD 7.4 明确：架构教程、插件、独立工具、版本更新、
 * 实测报告、产品权益、省钱教程即使同生态同关键词，也必须分别评估。
 * 实现上除 event_key 外再按 (section, mandatory_class) 二次切分 ——
 * 模型偶尔会把「某项目发布」和「某项目使用教程」给同一个 event_key，
 * 而这两者恰恰是 PRD 要求分开的。
 */
export function clusterCandidates(items: ClusterInput[]): Cluster[] {
  const aliases = loadRules().clustering?.event_aliases ?? [];
  const groups = new Map<string, ClusterInput[]>();
  // 同分区、同强制类别且标题仅有“发布/推出”等措辞差异时，复用首个
  // event_key。这样既能兜住模型键漂移，也不会跨越原有的分类隔离边界。
  const wordingEventKeys = new Map<string, string>();
  const subjectGroups: Array<{ title: string; section: string; mandatoryClass: string; eventKey: string }> = [];
  for (const original of items) {
    const it = { ...original };
    const text = it.title.toLowerCase();
    const alias = aliases.find((a: any) =>
      (a.require_all ?? []).every((x: string) => text.includes(String(x).toLowerCase())) &&
      (!(a.require_any ?? []).length ||
        (a.require_any ?? []).some((x: string) => text.includes(String(x).toLowerCase()))));
    // A 类由仓库/演示等硬信号确认，确定性归入“开源项目”；人工事件别名
    // 可统一模型漂移出的分区，使同一事件不会因 section 不同而漏合并。
    it.section = it.mandatoryClass === 'A'
      ? 'open_source_project'
      : alias?.force_section ?? it.section;
    const modelEventKey = canonicalEventIdentity(it.title, it.eventKey);
    const wordingScope = `${normalizedEventWording(it.title)}\u0001${it.section}\u0001${it.mandatoryClass}`;
    const related = subjectGroups.find(g => g.section === it.section &&
      g.mandatoryClass === it.mandatoryClass && similarEventTitles(it.title, g.title));
    const eventKey = wordingEventKeys.get(wordingScope) ?? related?.eventKey ?? modelEventKey;
    wordingEventKeys.set(wordingScope, eventKey);
    subjectGroups.push({ title: it.title, section: it.section, mandatoryClass: it.mandatoryClass, eventKey });
    const key = `${eventKey}\u0000${it.section}\u0000${it.mandatoryClass}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(it);
  }

  const out: Cluster[] = [];
  for (const [key, members] of groups) {
    const sorted = [...members].sort(compareOrigin);
    const primary = sorted[0]!;
    out.push({
      clusterKey: key.replace(/\u0000/g, ':'),
      section: primary.section,
      primary,
      members: sorted.slice(1),
      mandatoryClass: primary.mandatoryClass,
      score: scoreCluster(primary, sorted),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 选最佳原始来源：官方 > 来源优先级 > 证据更多 > 更早发布。 */
function compareOrigin(a: ClusterInput, b: ClusterInput): number {
  if (!!b.isOfficial !== !!a.isOfficial) return b.isOfficial ? 1 : -1;
  if (a.sourcePriority !== b.sourcePriority) return a.sourcePriority - b.sourcePriority;
  if (a.signals.length !== b.signals.length) return b.signals.length - a.signals.length;
  return (a.publishedAt ?? '').localeCompare(b.publishedAt ?? '');
}

/**
 * 0–100 排序分（PRD 8.4 权重）。
 *   公共重要性 25 / 信息增量 20 / 可验证性 20 / 可操作性 15 / 来源可信度 10 / 时效性 10
 * 前两项来自模型（语义维度），后四项由程序算 —— 符合 PRD 1.3 确定性优先。
 */
export function scoreCluster(primary: ClusterInput, all: ClusterInput[]): number {
  const w = loadRules().ranking?.weights ?? {};
  const sig = new Set(all.flatMap(m => m.signals));

  // 可验证性：有官方链接/仓库/演示，或多来源互证
  const verifiability = clamp(
    (sig.has('official_link') ? 0.45 : 0) +
    (sig.has('repo_url') ? 0.3 : 0) +
    (sig.has('demo_link') ? 0.15 : 0) +
    (sig.has('external_link') ? 0.1 : 0) +
    (all.length > 1 ? 0.2 : 0));

  // 可操作性：有可执行命令/配置/步骤
  const actionability = clamp(
    (sig.has('code_block') ? 0.35 : 0) +
    (sig.has('command_line') ? 0.3 : 0) +
    (sig.has('config_block') ? 0.2 : 0) +
    (sig.has('step_markers') ? 0.25 : 0));

  // 来源可信度：优先级 1 最高，7 最低
  const credibility = clamp(1 - (primary.sourcePriority - 1) / 7) *
                      (primary.isOfficial ? 1 : 0.85);

  // 时效性：24 小时内满分，之后线性衰减到 72 小时
  const ageH = primary.publishedAt
    ? (Date.now() - Date.parse(primary.publishedAt)) / 3.6e6 : 48;
  const timeliness = clamp(ageH <= 24 ? 1 : 1 - (ageH - 24) / 48);

  const score =
    (w.public_importance ?? 25) * clamp(primary.importance) +
    (w.information_gain ?? 20) * clamp(primary.novelty) +
    (w.verifiability ?? 20) * verifiability +
    (w.actionability ?? 15) * actionability +
    (w.source_credibility ?? 10) * credibility +
    (w.timeliness ?? 10) * timeliness;

  return Math.round(score * 10) / 10;
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export type SelectResult = {
  selected: Cluster[];
  /** 未入选但需要在审计区逐条列出的强制保留项（PRD 9.3） */
  droppedMandatory: Cluster[];
  dropped: Cluster[];
};

/**
 * 选出进入简报的条目（PRD 8.4 / 9.1）。
 *
 * 两条硬约束：
 *  1. 强制保留候选不参与 8–12 条篇幅淘汰，可使总数超过 12。
 *  2. 低于 min_score 的普通候选宁可不收 —— PRD 9.1 明令禁止用旧消息凑数，
 *     所以「不足 8 条」是允许的结果，不是失败。
 */
export function selectForBrief(clusters: Cluster[]): SelectResult {
  const R = loadRules().ranking ?? {};
  const [, maxN] = R.target_item_count ?? [8, 12];
  const minScore = R.min_score_to_include ?? 55;

  // 强制分类与人工 retain 都不参与篇幅/分数淘汰。人工判断优先于模型，
  // retain 即使没有 A–D 分类也必须进入简报。
  const isRetained = (c: Cluster) =>
    c.mandatoryClass !== 'none' || c.primary.decision === 'retain';
  const mandatory = clusters.filter(isRetained);
  const normal = clusters.filter(c => !isRetained(c));

  // 普通候选：先过分数线，再按分数取前 maxN 名
  const qualified = normal.filter(c => c.score >= minScore);
  const belowBar = normal.filter(c => c.score < minScore);
  const picked = qualified.slice(0, maxN);
  const overflow = qualified.slice(maxN);

  return {
    selected: [...mandatory, ...picked].sort((a, b) => b.score - a.score),
    droppedMandatory: [],          // 由 AI/人工判 filter 的强制保留项在上游处理
    dropped: [...overflow, ...belowBar],
  };
}
