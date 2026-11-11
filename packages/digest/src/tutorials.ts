/**
 * 「技术教程」板块（建议渲染标题改为「技术干货」）：只从 LINUX DO / V2EX 挑「有技术价值」的帖子 ——
 * 教程、技术科普、方法与经验分享、有深度的技术观点/行业讨论、实用的技术资源与限时优惠信息。
 * 确定性部分（预筛、去重、相似合并）不调用模型、不读写数据库；模型判定在 ai.ts（judgeTutorials）。
 * 不增加任何站点请求：只使用库里已存的正文/摘要（fulltext_text 或 clean_text）。
 */
import type { Provider } from '../../ai/src/types.ts';
import { extractSignals, prescreenMandatory } from '../../domain/src/signals.ts';
import { classifyRepost, extractRepos, similarity, urlKey, type DigestSourceItem, type DigestTutorial, type TutorialCategory } from './core.ts';
import { judgeReposts, judgeTutorials, type TutorialVerdict } from './ai.ts';

export const TUTORIAL_SOURCES = ['linuxdo', 'v2ex'];
/** 与 rules.yaml mandatory_retention B 类 topic_scope 一致，另补常见表述。仅作为信号提示传给模型，不再作为硬性门槛。 */
export const TUTORIAL_KEYWORDS = ['教程', '配置', '部署', '架构', '复盘', '实测', '踩坑', '排障', '排查', '优化', '迁移', '对比测试',
  '搭建', '安装', '折腾', '逆向', '命令', '脚本', '解决方案', '方法', '步骤', '指南', '攻略', '自建', '自托管', 'docker', 'nginx', 'ssh'];
const MIN_BODY = 40;      // 标题+正文（去掉图片占位后）少于此字数没有信息量
/** 用户指定的带楼层深链：显示用的原帖链接覆盖（key 为主题帖基础 URL）。去重仍按主题帖基础 URL。 */
export const TUTORIAL_URL_OVERRIDES: Record<string, string> = {
  'linux.do/t/topic/3061561': 'https://linux.do/t/topic/3061561/34',
  'linux.do/t/topic/3063844': 'https://linux.do/t/topic/3063844/102',
  'linux.do/t/topic/3066730': 'https://linux.do/t/topic/3066730/20',
};
/** 去重用 key：linux.do 带楼层的链接折叠回主题帖。 */
export const tutorialKey = (u: string | null | undefined): string | null => {
  const k = urlKey(u); return k ? k.replace(/^(linux\.do\/t\/(?:topic\/)?\d+)\/\d+$/, '$1') : null;
};

export type TutorialExcluded = { id: number; sourceId: string; title: string; url: string | null; reason: string; stage: 'prescreen' | 'repost' | 'project' | 'history' | 'model' | 'dup' };
export type TutorialPicked = { id: number; sourceId: string; title: string; url: string; reason: string; category: TutorialCategory };
export type TutorialReport = {
  candidates: Record<string, number>;   // 各来源候选帖总数
  sentToModel: number;
  picked: number;
  pickedItems: TutorialPicked[];
  excluded: TutorialExcluded[];
  modelError?: string;
};

const hostOf = (u: string | null) => { try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; } };

/** 去掉论坛图片上传占位（如「image 780×372 17.7 KB」），避免被算成正文长度。 */
const stripNoise = (s: string) => s.replace(/\bimage\s+\d+\s*[×x]\s*\d+\s+[\d.]+\s*[KM]?B\b/gi, ' ').replace(/\s+/g, ' ').trim();

/**
 * 确定性预筛：返回 reason=null 表示通过，否则返回排除原因。signals 供模型参考。
 * 只挡两类：没有信息量的短帖、带 AFF 推广链接且没有任何技术特征的帖子；其余一律交给模型判断价值。
 */
export function prescreenTutorial(it: DigestSourceItem): { reason: string | null; signals: string[] } {
  const body = stripNoise(it.text);
  const sig = extractSignals(it.text, '', hostOf(it.url));
  const hit = Object.entries(sig.signals).filter(([, v]) => v).map(([k]) => k);
  const lower = `${it.title}\n${body}`.toLowerCase();
  if (prescreenMandatory(sig.signals).includes('B')) hit.push('B类可复现实践预判');
  if (TUTORIAL_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) hit.push('含教程类关键词');
  if (`${it.title} ${body}`.length < MIN_BODY) return { reason: '内容过短，没有信息量', signals: hit };
  if (sig.signals.aff_link && !sig.signals.code_block && !sig.signals.command_line && !sig.signals.config_block)
    return { reason: '含 AFF/推广链接，疑似营销', signals: hit };
  return { reason: null, signals: hit };
}

/** 去掉概括里可能残留的星标、来源名前缀。 */
export function cleanTutorialSummary(s: string): string {
  let t = s.replace(/[⭐🌟★☆*]/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:在\s*)?(?:LINUX\s*DO|linux\.do|V2EX|L站|V站)(?:\s*论坛)?\s*(?:上|里|中)?\s*[:：,，]?\s*/i, '');
  return t.trim();
}

export type TutorialCtx = {
  officials: DigestSourceItem[];        // 近 72h 官方条目，用于转载比对
  projectRepos: Set<string>;            // 本期「开源项目」板块已入选仓库
  pushedUrls: Set<string>;              // 72h 已推送教程 URL key
  pushedTitles: string[];               // 72h 已推送教程标题
  /** 新流程注入：分层判定（替代 judgeTutorials） */
  judge?: (items: Array<{ id: number; title: string; text: string; signals: string[] }>) => Promise<{ results: Map<number, TutorialVerdict>; error?: string }>;
  /** 新流程注入：转载候选（链接或向量相似的官方条目）与分层转载判定；不再按相似度自动排除 */
  repostCandidate?: (it: DigestSourceItem) => DigestSourceItem | null;
  reposts?: (pairs: Array<{ id: number; item: DigestSourceItem; official: DigestSourceItem }>) => Promise<Map<number, boolean>>;
  /** 新流程注入：两条是否已被语义聚类判为同一事件（替代标题/摘要相似度 0.6 的交叉发布判断） */
  sameEvent?: (a: number, b: number) => boolean;
};

export async function buildTutorials(provider: Provider, items: DigestSourceItem[], ctx: TutorialCtx):
  Promise<{ tutorials: DigestTutorial[]; report: TutorialReport; log: string[] }> {
  const log: string[] = [];
  const cands = items.filter(i => TUTORIAL_SOURCES.includes(i.sourceId) && !i.official);
  const report: TutorialReport = { candidates: {}, sentToModel: 0, picked: 0, pickedItems: [], excluded: [] };
  for (const c of cands) report.candidates[c.sourceId] = (report.candidates[c.sourceId] ?? 0) + 1;
  const exclude = (i: DigestSourceItem, reason: string, stage: TutorialExcluded['stage']) =>
    report.excluded.push({ id: i.id, sourceId: i.sourceId, title: i.title, url: i.url, reason, stage });

  // 1. 确定性预筛 + 72h 去重 + 已在开源项目板块
  const pass: Array<{ it: DigestSourceItem; signals: string[] }> = [];
  for (const it of cands) {
    const k = tutorialKey(it.url);
    if (k && ctx.pushedUrls.has(k)) { exclude(it, '72 小时内已推送过', 'history'); continue; }
    if (ctx.pushedTitles.some(t => similarity(t, it.title) >= 0.6)) { exclude(it, '与 72 小时内已推送教程重复', 'history'); continue; }
    const repos = extractRepos(`${it.url ?? ''}\n${it.title}\n${it.text}`);
    const dup = repos.find(r => ctx.projectRepos.has(r));
    if (dup) { exclude(it, `仓库 ${dup} 已在「开源项目」板块`, 'project'); continue; }
    // 交叉发布：与已因「开源项目」板块排除的帖子标题高度相似（同一内容的另一站副本）
    const twin = report.excluded.find(x => x.stage === 'project' && similarity(x.title, it.title) >= 0.6);
    if (twin) { exclude(it, `同一内容的交叉发布，仓库已在「开源项目」板块：${twin.title.slice(0, 20)}`, 'project'); continue; }
    const p = prescreenTutorial(it);
    if (p.reason) { exclude(it, p.reason, 'prescreen'); continue; }
    pass.push({ it, signals: p.signals });
  }

  // 2. 与官方厂商新闻重复的转载（沿用 classifyRepost）
  const reposts = new Set<number>(); const uncertain: Array<{ id: number; item: DigestSourceItem; official: DigestSourceItem }> = [];
  if (ctx.repostCandidate && ctx.reposts) {
    for (const { it } of pass) { const o = ctx.repostCandidate(it); if (o && uncertain.length < 40) uncertain.push({ id: it.id, item: it, official: o }); }
    for (const [id, yes] of await ctx.reposts(uncertain)) if (yes) reposts.add(id);
  } else {
    for (const { it } of pass) {
      const c = classifyRepost(it, ctx.officials);
      if (c.verdict === 'repost') reposts.add(it.id);
      else if (c.verdict === 'uncertain' && uncertain.length < 20) uncertain.push({ id: it.id, item: it, official: ctx.officials.find(o => o.id === c.officialId)! });
    }
    for (const [id, yes] of await judgeReposts(provider, uncertain)) if (yes) reposts.add(id);
  }
  const afterRepost = pass.filter(({ it }) => { if (reposts.has(it.id)) { exclude(it, '转载/改写官方厂商新闻，已有官方动态覆盖', 'repost'); return false; } return true; });

  // 3. 模型判定 + 概括
  report.sentToModel = afterRepost.length;
  const { results, error } = await (ctx.judge ?? ((x: Parameters<typeof judgeTutorials>[1]) => judgeTutorials(provider, x)))(afterRepost.map(({ it, signals }) => ({ id: it.id, title: it.title, text: stripNoise(it.text), signals })));
  if (error) { report.modelError = error; log.push(`  ⚠️ 技术教程模型判定失败（部分或全部）：${error}`); }
  const picked: DigestTutorial[] = [];
  for (const { it } of afterRepost) {
    const r = results.get(it.id);
    if (!r) { exclude(it, '模型未返回判定（保守不收录）', 'model'); continue; }
    const summary = cleanTutorialSummary(r.summary);
    if (!r.tutorial || !summary) { exclude(it, r.reason || '模型判定不是可复现教程', 'model'); continue; }
    if (!it.url) { exclude(it, '无原帖链接', 'model'); continue; }
    // V2EX 与 LINUX DO 交叉发布同一内容：只保留先到的一条
    const same = ctx.sameEvent ? picked.find(p => ctx.sameEvent!(p.itemId, it.id))
      : picked.find(p => similarity(p.title, it.title) >= 0.6 || similarity(p.summary, summary) >= 0.6);
    if (same) { exclude(it, `与已入选条目重复（交叉发布）：${same.title.slice(0, 20)}`, 'dup'); continue; }
    const url = TUTORIAL_URL_OVERRIDES[tutorialKey(it.url) ?? ''] ?? it.url;
    picked.push({ title: it.title, summary, url, itemId: it.id, category: r.category });
    report.pickedItems.push({ id: it.id, sourceId: it.sourceId, title: it.title, url, reason: r.reason, category: r.category });
  }
  report.picked = picked.length;
  const total = cands.length;
  log.push(`技术教程候选 ${total} 条（${Object.entries(report.candidates).map(([k, v]) => `${k} ${v}`).join('、') || '0'}），送模型 ${report.sentToModel} 条，入选 ${picked.length} 条`);
  for (const x of report.excluded) log.push(`  技术教程排除[${x.stage}] ${x.sourceId} ${x.title.slice(0, 40)} —— ${x.reason}`);
  return { tutorials: picked, report, log };
}
