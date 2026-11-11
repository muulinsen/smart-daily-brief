/**
 * 新流程的日报组装（brief.semantic_dedup.enabled，docs/semantic-dedup-design.md）：
 * L1 结构化摘要 → 向量 → 分池聚类（灰区 L2 确认）→ 各版块按固定事件组生成，全部 AI 判定走 L1/L2 分层。
 * 只读业务表；只写 AI/向量缓存。阻断发布的未判定条目通过 gate 返回，由调用方决定推迟发布。
 */
import type { DB } from '../../db/src/index.ts';
import type { Provider } from '../../ai/src/types.ts';
import { dot, EmbeddingError, type EmbeddingConfig } from '../../ai/src/embeddings.ts';
import {
  extractRepos, isReplyOrTrivial, linksFor, stripVendorPrefix, urlKey, vendorName, vendorOrder,
  type DigestData, type DigestProject, type DigestSourceItem, type DigestVendor,
} from './core.ts';
import { fmt, hm, loadItems, md, pushedHistory, type DigestBuild, type DigestWindow } from './build.ts';
import { buildTutorials, TUTORIAL_SOURCES } from './tutorials.ts';
import { collectExtraDeals, mergeAllDeals } from './deals.ts';
import type { TierEnv } from './tiered.ts';
import type { AiCache } from './cache.ts';
import { applyConfirmed, autoCluster, confirmGray, embedText, embedTexts, exactUrlGroups, extractNotes, specificLinks, type ClusterInput, type GrayProposal, type Note } from './semantic.ts';
import { Gate, composeEventsTiered, dealJudge, dealMerger, describeProjectsTiered, judgeRepostsTiered, politicsTiered, tutorialJudge } from './ai-tiered.ts';

const H = 3600e3;
const clip = (s: string, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) : t; };

export type SemanticBuild = DigestBuild & { gate: Gate; warnings: string[]; stats: Record<string, number> };

/** 未注入时的占位供应商：新流程的所有版块都走注入的分层判定，不应调用到它。 */
const NO_PROVIDER: Provider = { name: 'mock', model: 'none', strictness: 'json', complete: async () => { throw new Error('新流程不应直接调用旧版判定'); } };

export async function buildDigestSemantic(db: DB, win: DigestWindow, env: TierEnv, o: {
  cache: AiCache; embedding: EmbeddingConfig | null; embeddingNote?: string; exclusiveActions?: Array<[string, string]>;
  maxProjects?: number; telegramPath?: string | null;
}): Promise<SemanticBuild> {
  const log: string[] = [], warnings: string[] = [], gate = new Gate();
  const stats: Record<string, number> = {};
  const from = win.start.toISOString(), to = win.end.toISOString();
  const items = loadItems(db, from, to, new Date(win.start.getTime() - 48 * H).toISOString());
  const history = pushedHistory(db, win.end);
  const officials72 = loadItems(db, new Date(win.end.getTime() - 72 * H).toISOString(), to, null).filter(i => i.official);
  log.push(`窗口条目 ${items.length} 条；72h 已推送 URL ${history.urls.size} 个、项目 ${history.repos.size} 个`);

  // ---------- 1. 分池 ----------
  const official = items.filter(i => i.official && i.role === 'official').filter(i => {
    if (isReplyOrTrivial(i)) { log.push(`  过滤回复/琐碎：[${i.sourceName}] ${i.title.slice(0, 50)}`); return false; }
    const k = urlKey(i.url);
    if (k && history.urls.has(k)) { log.push(`  72h 已推送：[${i.sourceName}] ${i.title.slice(0, 50)}`); return false; }
    return true;
  });
  const politics = items.filter(i => i.role === 'politics');
  const community = items.filter(i => !i.official && i.role !== 'politics');
  const pools = new Map<string, DigestSourceItem[]>();
  for (const i of official) pools.set(`vendor:${i.vendor}`, [...(pools.get(`vendor:${i.vendor}`) ?? []), i]);
  pools.set('politics', politics); pools.set('community', community);
  const order = (a: DigestSourceItem, b: DigestSourceItem) => String(a.publishedAt ?? a.firstSeenAt).localeCompare(String(b.publishedAt ?? b.firstSeenAt)) || a.id - b.id;
  for (const [, list] of pools) list.sort(order);
  const byId = new Map(items.map(i => [i.id, i]));

  // ---------- 2. L1 结构化摘要（不阻断：缺摘要的条目用标题+正文片段做向量） ----------
  const poolItems = [...pools.values()].flat();
  const notes = await extractNotes(env, poolItems);
  stats.notes = notes.size; stats.noteMissing = poolItems.length - notes.size;
  if (stats.noteMissing) warnings.push(`${stats.noteMissing} 条未取得结构化摘要，按原文参与比较`);

  // ---------- 3. 向量 ----------
  // 向量请求同样计入本期 AI 请求预算；预算或截止时间用尽时按配置类错误处理（本期停止向量调用）
  const embDispatch = () => { try { env.dispatch(); } catch { throw new EmbeddingError('budget'); } };
  let vec = new Map<number, Float32Array>();
  let vectorsUsable = false;
  if (!o.embedding) warnings.push(`未使用向量合并：${o.embeddingNote ?? '向量模型未启用'}，本期只合并网址完全相同的条目`);
  else {
    const r = await embedTexts(o.embedding, o.cache, poolItems.map(i => embedText(i, notes.get(i.id))), { signal: env.signal, onDispatch: embDispatch, log: s => log.push(`  ${s}`) });
    poolItems.forEach((i, k) => { const v = r.vectors[k]; if (v) vec.set(i.id, v); });
    if (r.fatal) { warnings.push(`向量模型不可用（${r.fatal.kind}${r.fatal.status ? ` HTTP ${r.fatal.status}` : ''}），本期只合并网址完全相同的条目`); vec = new Map(); }
    else {
      vectorsUsable = vec.size > 0;
      if (r.errors.length) warnings.push(`${poolItems.length - vec.size} 条未取得向量，这些条目单独成组`);
    }
  }
  stats.vectors = vec.size;

  // ---------- 4. 聚类 + 灰区 ----------
  const high = o.embedding?.simHigh ?? 0.9, low = o.embedding?.simLow ?? 0.8;
  const groupsByPool = new Map<string, number[][]>();
  const grayAll: Array<GrayProposal & { pool: string }> = [];
  for (const [pool, list] of pools) {
    if (!vectorsUsable) { groupsByPool.set(pool, exactUrlGroups(list)); continue; }
    const inputs: ClusterInput[] = list.map(i => ({ id: i.id, vec: vec.get(i.id), note: notes.get(i.id), links: specificLinks(i), urlKey: urlKey(i.url) }));
    const r = autoCluster(inputs, high, low, o.exclusiveActions);
    groupsByPool.set(pool, r.groups);
    grayAll.push(...r.gray.map(g => ({ ...g, pool })));
  }
  if (grayAll.length) {
    grayAll.sort((a, b) => b.score - a.score);
    const confirmed = await confirmGray(env, grayAll, id => ({ title: byId.get(id)?.title ?? '', note: notes.get(id) }));
    stats.grayAsked = Math.min(grayAll.length, 60); stats.grayMerged = confirmed.size;
    for (const [pool, groups] of groupsByPool) {
      const idx: number[] = []; const props: GrayProposal[] = [];
      grayAll.forEach((g, i) => { if (g.pool === pool) { idx.push(i); props.push(g); } });
      const conf = new Set(idx.map((gi, k) => confirmed.has(gi) ? k : -1).filter(k => k >= 0));
      groupsByPool.set(pool, applyConfirmed(groups, props, conf));
    }
  }
  const groupOf = new Map<number, number>();
  let gid = 0;
  const groupList = new Map<number, number[]>();
  for (const [, groups] of groupsByPool) for (const g of groups) { gid++; groupList.set(gid, g); for (const id of g) groupOf.set(id, gid); }
  for (const [, g] of groupList) if (g.length > 1) log.push(`  合并 ${g.length} 条：${g.map(id => byId.get(id)?.title.slice(0, 24)).join(' ｜ ')}`);
  stats.groups = groupList.size;

  // ---------- 5. 一、官方动态 ----------
  const pushedRows = db.prepare(`SELECT vendor, title, summary FROM pushed_events WHERE pushed_at >= ? AND pushed_at < ?`)
    .all(new Date(win.end.getTime() - 72 * H).toISOString(), to) as Array<{ vendor: string; title: string; summary: string }>;
  const histVec = new Map<number, Float32Array>();
  const curRawVec = new Map<number, Float32Array>();
  if (vectorsUsable && o.embedding) {
    const histTexts = pushedRows.map(r => `${r.title} ${r.summary}`);
    const curTexts = official.map(i => `${clip(i.title, 200)} ${clip(i.text, 200)}`);
    const r = await embedTexts(o.embedding, o.cache, [...histTexts, ...curTexts], { signal: env.signal, onDispatch: embDispatch });
    histTexts.forEach((_, k) => { const v = r.vectors[k]; if (v) histVec.set(k, v); });
    official.forEach((i, k) => { const v = r.vectors[histTexts.length + k]; if (v) curRawVec.set(i.id, v); });
  }
  const vendorIds = [...new Set((db.prepare(`SELECT DISTINCT vendor FROM sources WHERE enabled = 1 AND archived_at IS NULL AND is_official = 1 AND source_role = 'official'`).all() as any[]).map(r => r.vendor as string))];
  const vendors: DigestVendor[] = []; const emptyVendors: string[] = [];
  for (const v of vendorIds.sort((a, b) => vendorOrder(a) - vendorOrder(b) || a.localeCompare(b))) {
    const groups = groupsByPool.get(`vendor:${v}`) ?? [];
    if (!groups.length) { emptyVendors.push(vendorName(v)); continue; }
    const hist = pushedRows.map((r, k) => ({ r, k })).filter(x => x.r.vendor === v);
    const input = groups.map(g => {
      const members = g.map(id => byId.get(id)!);
      // 逐事件检索最相似的 5 条历史事件；向量不可用时退回该厂商的历史标题
      let recent: string[];
      const mv = members.map(m => curRawVec.get(m.id)).filter(Boolean) as Float32Array[];
      if (mv.length && hist.length && hist.every(x => histVec.has(x.k)))
        recent = hist.map(x => ({ t: x.r.title, s: Math.max(...mv.map(a => dot(a, histVec.get(x.k)!))) })).sort((a, b) => b.s - a.s).slice(0, 5).map(x => x.t);
      else recent = (history.titles.get(v) ?? []).slice(0, 60);
      return { id: groupOf.get(g[0]!)!, items: members, recentPushed: recent };
    });
    const texts = await composeEventsTiered(env, gate, vendorName(v), input);
    const events = input.flatMap(g => {
      const t = texts.get(g.id);
      if (!t) return [];
      if (t.trivial) { log.push(`  模型判为琐碎：${vendorName(v)} ${t.title}`); return []; }
      if (t.repeat) { log.push(`  模型判为 72h 重复：${vendorName(v)} ${t.title}`); return []; }
      const its = [...g.items].sort((a, b) => Number(b.sourceId.startsWith('x_') ? 0 : 1) - Number(a.sourceId.startsWith('x_') ? 0 : 1));
      return [{ title: stripVendorPrefix(t.title, v, vendorName(v)), summary: stripVendorPrefix(t.summary, v, vendorName(v)), links: linksFor(its), itemIds: g.items.map(i => i.id) }];
    });
    if (events.length) vendors.push({ vendor: v, name: vendorName(v), events }); else emptyVendors.push(vendorName(v));
  }

  // ---------- 6. 转载候选（链接相同或向量相似的 72h 官方条目） ----------
  const offRaw = new Map<number, Float32Array>();
  const comRaw = new Map<number, Float32Array>();
  if (vectorsUsable && o.embedding) {
    const offTexts = officials72.map(i => `${clip(i.title, 200)} ${clip(i.text, 200)}`);
    const comTexts = community.map(i => `${clip(i.title, 200)} ${clip(i.text, 200)}`);
    const r = await embedTexts(o.embedding, o.cache, [...offTexts, ...comTexts], { signal: env.signal, onDispatch: embDispatch });
    officials72.forEach((i, k) => { const v = r.vectors[k]; if (v) offRaw.set(i.id, v); });
    community.forEach((i, k) => { const v = r.vectors[offTexts.length + k]; if (v) comRaw.set(i.id, v); });
  }
  const repostCandidate = (it: DigestSourceItem): DigestSourceItem | null => {
    const mine = new Set([urlKey(it.url), ...specificLinks(it)].filter(Boolean) as string[]);
    for (const off of officials72) { const k = urlKey(off.url); if (k && mine.has(k)) return off; }
    const a = comRaw.get(it.id); if (!a) return null;
    let best: DigestSourceItem | null = null, bs = low;
    for (const off of officials72) { const b = offRaw.get(off.id); if (b) { const s = dot(a, b); if (s >= bs) { bs = s; best = off; } } }
    return best;
  };
  const reposts = (pairs: Array<{ id: number; item: DigestSourceItem; official: DigestSourceItem }>) => judgeRepostsTiered(env, pairs);

  // ---------- 7. 二、开源项目 ----------
  const repoPosts = items.filter(i => !i.official && extractRepos(`${i.url ?? ''} ${i.title} ${i.text}`).length);
  const repoPairs = repoPosts.map(it => ({ it, off: repostCandidate(it) })).filter(x => x.off).slice(0, 40);
  const reposted = new Set<number>();
  for (const [id, yes] of await reposts(repoPairs.map(x => ({ id: x.it.id, item: x.it, official: x.off! })))) if (yes) reposted.add(id);
  if (reposted.size) log.push(`  非官方转载官方内容，已排除：${reposted.size} 条`);
  const mentions = new Map<string, { items: DigestSourceItem[]; contexts: string[] }>();
  for (const it of items) {
    if (reposted.has(it.id)) continue;
    const blob = `${it.url ?? ''}\n${it.title}\n${it.text}`;
    for (const repo of extractRepos(blob)) {
      if (history.repos.has(repo)) continue;
      const m = mentions.get(repo) ?? { items: [], contexts: [] };
      if (!m.items.some(x => x.sourceName === it.sourceName)) m.items.push(it);
      const idx = blob.toLowerCase().indexOf(`github.com/${repo}`);
      m.contexts.push(`${it.title}\n${blob.slice(Math.max(0, idx - 250), idx + 250)}`);
      mentions.set(repo, m);
    }
  }
  const ranked = [...mentions.entries()]
    .sort((a, b) => b[1].items.length - a[1].items.length || Number(b[1].items.some(i => i.official)) - Number(a[1].items.some(i => i.official)))
    .slice(0, (o.maxProjects ?? 12) + 6);
  const desc = await describeProjectsTiered(env, gate, ranked.map(([repo, m]) => ({ repo, contexts: m.contexts })));
  const projects: DigestProject[] = [];
  for (const [repo, m] of ranked) {
    const d = desc.get(repo);
    if (!d) continue;   // 未判定：已计入 gate，本期不会发布
    if (!d.isProject) { log.push(`  非开源项目，跳过：${repo}`); continue; }
    if (projects.length >= (o.maxProjects ?? 12)) break;
    projects.push({ repo, url: `https://github.com/${repo}`, description: d.description,
      mentionedBy: m.items.map(i => ({ label: i.sourceName, url: i.url ?? `https://github.com/${repo}` })) });
  }
  log.push(`开源项目候选 ${mentions.size} 个，入选 ${projects.length} 个`);

  // ---------- 8. 技术干货 / 羊毛 ----------
  const tut = await buildTutorials(env.l1.provider ?? NO_PROVIDER, items, {
    officials: officials72, projectRepos: new Set(projects.map(p => p.repo)),
    pushedUrls: history.tutUrls, pushedTitles: history.tutTitles,
    judge: tutorialJudge(env, gate), repostCandidate, reposts,
    sameEvent: (a, b) => groupOf.has(a) && groupOf.get(a) === groupOf.get(b),
  });
  log.push(...tut.log);
  const vendorItemIds = new Set<number>(vendors.flatMap(v => v.events.flatMap(e => e.itemIds)));
  const extra = await collectExtraDeals(env.l1.provider ?? NO_PROVIDER, {
    items, skipItemIds: vendorItemIds, forumSources: [...TUTORIAL_SOURCES],
    telegramPath: o.telegramPath ?? null, start: from, end: to,
    pushedUrls: history.tutUrls, pushedTitles: history.tutTitles, judge: dealJudge(env, gate),
  }, log);
  const deals = await mergeAllDeals(env.l1.provider ?? NO_PROVIDER, tut.tutorials.filter(t => t.category === 'deals'), extra.extras, extra.report, log,
    dealMerger(env, (a, b) => groupOf.has(a) && groupOf.has(b) && groupOf.get(a) !== groupOf.get(b)));
  const tutorials = [...tut.tutorials.filter(t => t.category !== 'deals'), ...deals];
  log.push(`羊毛资讯入选 ${deals.length} 条（论坛 ${tut.tutorials.filter(t => t.category === 'deals').length}、其他渠道 ${extra.report.other.picked}、Telegram ${extra.report.telegram.picked}，合并后）`);

  // ---------- 9. 时政速览：按事件组，组内全部成员参与 ----------
  const polGroups = (groupsByPool.get('politics') ?? []).map(g => g.map(id => byId.get(id)!))
    .sort((a, b) => order(b[b.length - 1]!, a[a.length - 1]!));
  const perSrc = new Map<string, number>();
  const polPick = polGroups.filter(g => { const s = g[0]!.sourceId; const n = (perSrc.get(s) ?? 0) + 1; perSrc.set(s, n); return n <= 25; });
  const politicsOut = await politicsTiered(env, gate, polPick.map(g => ({ id: groupOf.get(g[0]!.id)!, items: g })));
  log.push(`时政素材 ${politics.length} 条，合并为 ${polGroups.length} 个事件，送模型 ${polPick.length} 个`);

  if (env.stopReason) warnings.push(`AI 调用已停止（${env.stopReason === 'deadline' ? '到达截止时间' : '本期请求预算用尽'}）`);
  const data: DigestData = {
    format: 'digest_v2',
    date: fmt(win.end, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    windowLabel: win.label,
    windowRange: `${md(win.start)} ${hm(win.start)}–${md(win.start) !== md(win.end) ? md(win.end) + ' ' : ''}${hm(win.end)}`,
    vendors, emptyVendors, projects, tutorials, politics: politicsOut,
  };
  return { data, log, gate, warnings, stats, tutorialReport: { ...tut.report, picked: tutorials.length }, dealsReport: extra.report };
}

export type { Note };
