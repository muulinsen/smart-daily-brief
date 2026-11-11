/**
 * 从数据库组装一期新版日报。只读：不写任何表。
 * 写入 pushed_events / pushed_projects 由投递成功后的调用方负责（recordPushed）。
 */
import type { DB } from '../../db/src/index.ts';
import type { Provider } from '../../ai/src/types.ts';
import {
  classifyRepost, decodeEntities, extractRepos, isReplyOrTrivial, linksFor, preMergeByLinks, urlKey,
  stripVendorPrefix, vendorName, vendorOrder, type DigestData, type DigestProject, type DigestSourceItem, type DigestVendor,
} from './core.ts';
import { composeVendorEvents, describeProjects, judgeReposts, politicsBullets } from './ai.ts';
import { buildTutorials, tutorialKey, TUTORIAL_SOURCES, type TutorialReport } from './tutorials.ts';
import { collectExtraDeals, mergeAllDeals, type DealsReport } from './deals.ts';

export type DigestWindow = { key: string; label: string; start: Date; end: Date };
const H = 3600e3;
const TZ = 'Asia/Shanghai';
export const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour12: false, ...o }).format(d);
export const md = (d: Date) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(5);   // MM-DD
export const hm = (d: Date) => fmt(d, { hour: '2-digit', minute: '2-digit' });

export function loadItems(db: DB, from: string, to: string, lateFloor: string | null): DigestSourceItem[] {
  const rows = db.prepare(`
    SELECT f.id, f.source_id, s.display_name, s.vendor, s.is_official, s.source_role,
           v.title, coalesce(v.fulltext_text, v.clean_text) text,
           coalesce(f.canonical_url, f.origin_url) url, f.published_at, f.first_seen_at
    FROM feed_items f
    JOIN item_versions v ON v.id = f.current_version_id
    JOIN sources s ON s.id = f.source_id
    WHERE s.enabled = 1 AND s.archived_at IS NULL AND (
      (f.published_at >= @from AND f.published_at < @to)
      OR (f.first_seen_at >= @from AND f.first_seen_at < @to
          AND (f.published_at IS NULL OR @late IS NULL OR f.published_at >= @late)))
    ORDER BY coalesce(f.published_at, f.first_seen_at)`).all({ from, to, late: lateFloor }) as any[];
  return rows.map(r => ({
    id: r.id, sourceId: r.source_id, sourceName: r.display_name || r.source_id, vendor: r.vendor || 'other',
    official: !!r.is_official, role: (r.source_role ?? 'context') as DigestSourceItem['role'],
    title: decodeEntities(r.title ?? ''), text: decodeEntities(r.text ?? ''), url: r.url, publishedAt: r.published_at, firstSeenAt: r.first_seen_at,
  }));
}

/** 近 72 小时已推送的事件 URL / 标题与开源项目。旧版日报（brief_items、正文）一并纳入，避免切换当天重复。 */
export function pushedHistory(db: DB, before: Date) {
  const since = new Date(before.getTime() - 72 * H).toISOString();
  const urls = new Set<string>(); const titles = new Map<string, string[]>(); const repos = new Set<string>();
  const tutUrls = new Set<string>(); const tutTitles: string[] = [];
  const addTitle = (v: string, t: string) => titles.set(v, [...(titles.get(v) ?? []), t]);
  for (const r of db.prepare(`SELECT vendor, title, urls_json FROM pushed_events WHERE pushed_at >= ? AND pushed_at < ?`).all(since, before.toISOString()) as any[]) {
    addTitle(r.vendor, r.title);
    for (const u of JSON.parse(r.urls_json || '[]')) { const k = urlKey(u); if (k) urls.add(k); }
  }
  for (const r of db.prepare(`SELECT repo FROM pushed_projects WHERE pushed_at >= ? AND pushed_at < ?`).all(since, before.toISOString()) as any[]) repos.add(r.repo);
  // pushed_tutorials 由迁移 017 创建；表尚不存在（未迁移）时视为无历史，不报错
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='pushed_tutorials'`).get()) {
    for (const r of db.prepare(`SELECT title, url FROM pushed_tutorials WHERE pushed_at >= ? AND pushed_at < ?`).all(since, before.toISOString()) as any[]) {
      tutTitles.push(r.title); const k = tutorialKey(r.url); if (k) tutUrls.add(k);
    }
  }
  const sent = db.prepare(`SELECT b.id, b.html_body FROM briefs b
    WHERE b.status = 'final' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.brief_id = b.id AND d.status = 'sent' AND d.sent_at >= ? AND d.sent_at < ?)`)
    .all(since, before.toISOString()) as any[];
  // DIGEST_IGNORE_LEGACY_HISTORY=1：重发新版日报时不以旧版正文去重（旧版内容不算新版已推送）
  if (process.env.DIGEST_IGNORE_LEGACY_HISTORY === '1') sent.length = 0;
  for (const b of sent) {
    for (const r of extractRepos(b.html_body ?? '')) repos.add(r);
    for (const i of db.prepare(`SELECT bi.title, bi.source_url, coalesce(s.vendor, 'other') vendor FROM brief_items bi
        LEFT JOIN sources s ON s.id = bi.source_name WHERE bi.brief_id = ?`).all(b.id) as any[]) {
      addTitle(i.vendor, i.title); const k = urlKey(i.source_url); if (k) urls.add(k);
    }
  }
  return { urls, titles, repos, tutUrls, tutTitles };
}

export type DigestBuild = { data: DigestData; log: string[]; tutorialReport?: TutorialReport; dealsReport?: DealsReport };

export async function buildDigest(db: DB, win: DigestWindow, provider: Provider, opts: { maxProjects?: number; telegramPath?: string | null } = {}): Promise<DigestBuild> {
  const log: string[] = [];
  const from = win.start.toISOString(), to = win.end.toISOString();
  const items = loadItems(db, from, to, new Date(win.start.getTime() - 48 * H).toISOString());
  const history = pushedHistory(db, win.end);
  log.push(`窗口条目 ${items.length} 条；72h 已推送 URL ${history.urls.size} 个、项目 ${history.repos.size} 个`);

  // ---------- 一、官方动态 ----------
  const officialAll = items.filter(i => i.official && i.role === 'official');
  const official = officialAll.filter(i => {
    if (isReplyOrTrivial(i)) { log.push(`  过滤回复/琐碎：[${i.sourceName}] ${i.title.slice(0, 50)}`); return false; }
    const k = urlKey(i.url);
    if (k && history.urls.has(k)) { log.push(`  72h 已推送：[${i.sourceName}] ${i.title.slice(0, 50)}`); return false; }
    return true;
  });
  const vendorIds = [...new Set((db.prepare(`SELECT DISTINCT vendor FROM sources WHERE enabled = 1 AND archived_at IS NULL AND is_official = 1 AND source_role = 'official'`).all() as any[]).map(r => r.vendor as string))];
  const vendors: DigestVendor[] = []; const emptyVendors: string[] = [];
  for (const v of vendorIds.sort((a, b) => vendorOrder(a) - vendorOrder(b) || a.localeCompare(b))) {
    const vi = official.filter(i => i.vendor === v);
    if (!vi.length) { emptyVendors.push(vendorName(v)); continue; }
    const groups = preMergeByLinks(vi);
    const r = await composeVendorEvents(provider, vendorName(v), vi, groups, history.titles.get(v) ?? []);
    if (r.error) log.push(`  ⚠️ ${vendorName(v)} 模型合并失败，按链接分组回退：${r.error}`);
    const events = r.events.filter(e => {
      if (e.trivial) log.push(`  模型判为琐碎：${vendorName(v)} ${e.title}`);
      if (e.repeat) log.push(`  模型判为 72h 重复：${vendorName(v)} ${e.title}`);
      return !e.trivial && !e.repeat;
    }).map(e => {
      const its = e.itemIds.map(id => vi.find(i => i.id === id)!).filter(Boolean)
        .sort((a, b) => Number(b.sourceId.startsWith('x_') ? 0 : 1) - Number(a.sourceId.startsWith('x_') ? 0 : 1));
      if (e.itemIds.length > 1) log.push(`  合并 ${e.itemIds.length} 条 → ${vendorName(v)}：${e.title}`);
      return { title: stripVendorPrefix(e.title, v, vendorName(v)), summary: stripVendorPrefix(e.summary, v, vendorName(v)), links: linksFor(its), itemIds: e.itemIds };
    });
    if (events.length) vendors.push({ vendor: v, name: vendorName(v), events }); else emptyVendors.push(vendorName(v));
  }

  // ---------- 非官方转载过滤（只影响开源项目提取） ----------
  const officials72 = loadItems(db, new Date(win.end.getTime() - 72 * H).toISOString(), to, null).filter(i => i.official);
  const nonOfficial = items.filter(i => !i.official);
  const reposts = new Set<number>(); const uncertain: Array<{ id: number; item: any; official: any }> = [];
  for (const it of nonOfficial) {
    if (!extractRepos(`${it.url ?? ''} ${it.title} ${it.text}`).length) continue;   // 只有含仓库的帖子需要判定
    const c = classifyRepost(it, officials72);
    if (c.verdict === 'repost') reposts.add(it.id);
    else if (c.verdict === 'uncertain' && uncertain.length < 20) uncertain.push({ id: it.id, item: it, official: officials72.find(o => o.id === c.officialId) });
  }
  for (const [id, yes] of await judgeReposts(provider, uncertain)) if (yes) reposts.add(id);
  if (reposts.size) log.push(`  非官方转载官方内容，已排除：${reposts.size} 条`);

  // ---------- 二、开源项目 ----------
  const mentions = new Map<string, { items: DigestSourceItem[]; contexts: string[] }>();
  for (const it of items) {
    if (reposts.has(it.id)) continue;
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
    .slice(0, (opts.maxProjects ?? 12) + 6);
  const desc = await describeProjects(provider, ranked.map(([repo, m]) => ({ repo, contexts: m.contexts })));
  const projects: DigestProject[] = [];
  for (const [repo, m] of ranked) {
    const d = desc.get(repo);
    if (d && !d.isProject) { log.push(`  非开源项目，跳过：${repo}`); continue; }
    if (projects.length >= (opts.maxProjects ?? 12)) break;
    projects.push({ repo, url: `https://github.com/${repo}`, description: d?.description || '（简介生成失败）',
      mentionedBy: m.items.map(i => ({ label: i.sourceName, url: i.url ?? `https://github.com/${repo}` })) });
  }
  log.push(`开源项目候选 ${mentions.size} 个，入选 ${projects.length} 个`);

  // ---------- 三、技术教程（LINUX DO / V2EX） ----------
  const tut = await buildTutorials(provider, items, {
    officials: officials72, projectRepos: new Set(projects.map(p => p.repo)),
    pushedUrls: history.tutUrls, pushedTitles: history.tutTitles,
  });
  log.push(...tut.log);

  // ---------- 羊毛资讯：论坛判为 deals 的 + 其他渠道 + Telegram 群消息，同平台同优惠合并 ----------
  const vendorItemIds = new Set<number>(vendors.flatMap(v => v.events.flatMap(e => (e as any).itemIds ?? [])));
  const extra = await collectExtraDeals(provider, {
    items, skipItemIds: vendorItemIds, forumSources: [...TUTORIAL_SOURCES],
    telegramPath: opts.telegramPath ?? null, start: from, end: to,
    pushedUrls: history.tutUrls, pushedTitles: history.tutTitles,
  }, log);
  const deals = await mergeAllDeals(provider, tut.tutorials.filter(t => t.category === 'deals'), extra.extras, extra.report, log);
  const tutorials = [...tut.tutorials.filter(t => t.category !== 'deals'), ...deals];
  log.push(`羊毛资讯入选 ${deals.length} 条（论坛 ${tut.tutorials.filter(t => t.category === 'deals').length}、其他渠道 ${extra.report.other.picked}、Telegram ${extra.report.telegram.picked}，合并后）`);

  // ---------- 四、时政速览 ----------
  const pol = items.filter(i => i.role === 'politics')
    .sort((a, b) => String(b.publishedAt ?? b.firstSeenAt).localeCompare(String(a.publishedAt ?? a.firstSeenAt)));
  // 每个来源最多取 25 条，避免一财高频滚动淹没其他来源
  const perSrc = new Map<string, number>();
  const polPick = pol.filter(i => { const n = (perSrc.get(i.sourceId) ?? 0) + 1; perSrc.set(i.sourceId, n); return n <= 25; });
  const politics = await politicsBullets(provider, polPick);
  if (politics.error) log.push(`  ⚠️ 时政速览生成失败：${politics.error}`);
  log.push(`时政素材 ${pol.length} 条，送模型 ${polPick.length} 条`);

  const data: DigestData = {
    format: 'digest_v2',
    date: fmt(win.end, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    windowLabel: win.label,
    windowRange: `${md(win.start)} ${hm(win.start)}–${md(win.start) !== md(win.end) ? md(win.end) + ' ' : ''}${hm(win.end)}`,
    vendors, emptyVendors, projects, tutorials, politics: politics.bullets,
  };
  return { data, log, tutorialReport: { ...tut.report, picked: tutorials.length }, dealsReport: extra.report };
}

/** 投递成功后登记本期推送的事件与项目，供下一期 72 小时去重。 */
export function recordPushed(db: DB, briefId: number, data: DigestData, at = new Date().toISOString()) {
  const ev = db.prepare(`INSERT INTO pushed_events (vendor,title,summary,urls_json,brief_id,pushed_at) VALUES (?,?,?,?,?,?)`);
  const pj = db.prepare(`INSERT INTO pushed_projects (repo,description,brief_id,pushed_at) VALUES (?,?,?,?)`);
  const hasTut = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='pushed_tutorials'`).get();   // 迁移 017 之前不登记教程
  const done = db.prepare(`SELECT 1 FROM pushed_events WHERE brief_id = ? UNION ALL SELECT 1 FROM pushed_projects WHERE brief_id = ?`
    + (hasTut ? ` UNION ALL SELECT 1 FROM pushed_tutorials WHERE brief_id = ?` : '') + ` LIMIT 1`).get(...(hasTut ? [briefId, briefId, briefId] : [briefId, briefId]));
  if (done) return;
  const tu = hasTut ? db.prepare(`INSERT INTO pushed_tutorials (title,summary,url,category,brief_id,pushed_at) VALUES (?,?,?,?,?,?)`) : null;
  db.transaction(() => {
    for (const v of data.vendors) for (const e of v.events) ev.run(v.vendor, e.title, e.summary, JSON.stringify(e.links.map(l => l.url)), briefId, at);
    for (const p of data.projects) pj.run(p.repo, p.description, briefId, at);
    if (tu) for (const t of data.tutorials ?? []) tu.run(t.title, t.summary, t.url, t.category ?? 'tech', briefId, at);
  })();
}
