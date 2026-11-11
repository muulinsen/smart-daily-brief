// 后台改版第一期：待处理事项、systemd 状态解析、日报 RSS、今日/系统页渲染、侧栏
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../packages/db/src/index.ts';
import { computeAlerts, mergeSlotAlerts, readUnits, type AlertInput } from '../packages/web/src/ops.ts';
import { briefFeedToken, briefsRss, rotateBriefFeedToken } from '../packages/web/src/briefs-rss.ts';
import { renderSystem, renderToday, renderTodayOverview, slotAlerts, renderRuns, renderRunDetail, renderChannels, renderSubscriptions, setNavBadges, layout, type RunRow, type TodaySlot } from '../packages/web/src/views.ts';
import { parseRequest, pendingRequests, queueRequest, takeRequest } from '../packages/web/src/requests.ts';
import { telegramDigestsSection, telegramVisionSection, telegramLoginSection, telegramSourcesSection, renderTelegramSettings, renderTelegramRetention } from '../packages/telegram/src/views.ts';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { addTelegramSource, renameTelegramSource, setVisionDailyLimit, updateTelegramRetention } from '../packages/telegram/src/core.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`); };
const now = Date.parse('2026-10-10T04:30:00Z');
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const healthy = (): AlertInput => ({
  now,
  units: [
    { id: 'brief-run', label: '完整日报运行', kind: 'oneshot', active: 'inactive', result: 'success', startedAt: now - 3 * 36e5, exitedAt: now - 3 * 36e5 + 577e3, nextAt: now + 6e5 },
    { id: 'brief-maintain', label: '维护与备份', kind: 'oneshot', active: 'inactive', result: 'success', startedAt: now - 9e6, exitedAt: now - 9e6 + 6e4, nextAt: now + 8e7 },
    { id: 'brief-telegram-collector', label: 'Telegram 采集', kind: 'daemon', active: 'active', result: 'success', startedAt: now - 9e6, exitedAt: null, nextAt: null },
  ],
  runs: [{ window_key: '2026-10-10:morning', window_label: '早报', scheduled_at: '2026-10-10T00:00:00.000Z', status: 'succeeded', error: null, finished_at: '2026-10-10T00:09:48.000Z' }],
  sources: [{ id: 'v2ex', display_name: 'V2EX', health: 'healthy', enabled: 1, consecutive_failures: 0 }],
  telegram: { authorized: true, heartbeatAt: iso(6e4), sources: [{ name: '折腾搞机', status: 'active', enabled: 1, last_error: null, last_success_at: iso(3e5) }],
    visionPaused: false, visionPauseReason: null, visionBacklog: 12, visionDailyLimit: 1000, failedSummaries: 0 },
  backups: [{ name: 'brief', label: '日报数据库', file: 'brief-2026-10-09.db.gz', bytes: 33 * 2 ** 20, mtime: now - 9e6 },
            { name: 'telegram', label: 'Telegram 数据库', file: 'telegram-2026-10-09.db.gz', bytes: 242 * 2 ** 20, mtime: now - 9e6 }],
  disk: { totalBytes: 34e9, usedBytes: 17.3e9, freeBytes: 16.7e9 },
});

console.log('待处理事项：\n');
{
  ok('一切正常时没有事项', computeAlerts(healthy()).length === 0);

  const i = healthy();
  i.runs.push({ window_key: '2026-10-09:evening', window_label: '晚报', scheduled_at: '2026-10-09T14:00:00.000Z', status: 'partial', error: 'L2/L3 复核无进展、简报组装', finished_at: null });
  const a = computeAlerts(i);
  ok('被完整性门禁拦下的时段 → 故障', a.length === 1 && a[0]!.level === 'bad' && a[0]!.title === '晚报未完成（10-09）' && a[0]!.detail.includes('复核无进展'), JSON.stringify(a));
  i.runs[1]!.scheduled_at = '2026-10-08T04:00:00.000Z';
  ok('超过 24 小时的旧失败不再提示', computeAlerts(i).length === 0);

  const t = healthy();
  t.telegram.sources = Array.from({ length: 16 }, (_, k) => ({ name: `频道${k}`, status: 'error', enabled: 0, last_error: '来源解析失败：ConnectionError', last_success_at: iso(864e6) }));
  const ta = computeAlerts(t);
  ok('9-29 全部来源被停用 → Telegram 故障', ta.some(x => x.area === 'telegram' && x.level === 'bad' && x.title === '16 个 Telegram 来源出错'), JSON.stringify(ta));

  const st = healthy(); st.telegram.sources[0]!.last_success_at = iso(2 * 36e5);
  ok('启用的来源超过 1 小时没同步 → 故障', computeAlerts(st).some(x => x.title === '1 个 Telegram 来源超过 1 小时没有同步'));
  const hb = healthy(); hb.telegram.heartbeatAt = iso(20 * 6e4);
  ok('一轮同步期间 20 分钟没心跳不算故障', !computeAlerts(hb).some(x => x.title.startsWith('Telegram 采集器')));
  hb.telegram.heartbeatAt = iso(45 * 6e4);
  ok('30 分钟没有任何进展 → 故障', computeAlerts(hb).some(x => x.title === 'Telegram 采集器 30 分钟没有进展'));
  const na = healthy(); na.telegram.authorized = false;
  ok('账号未登录 → 故障', computeAlerts(na).some(x => x.title === 'Telegram 账号未登录'));

  const v = healthy(); v.telegram.visionPaused = true; v.telegram.visionPauseReason = '鉴权失败：请检查视觉模型 API 凭证后手动恢复队列';
  ok('图片识别暂停 → 故障并带原因', computeAlerts(v).some(x => x.title === '图片识别已暂停' && x.detail.includes('鉴权失败')));
  const vb = healthy(); vb.telegram.visionBacklog = 1959;
  const vba = computeAlerts(vb).find(x => x.title.startsWith('图片识别积压'));
  ok('积压超过每日上限 → 留意并估算天数', vba?.level === 'warn' && vba.title === '图片识别积压 1,959 张' && vba.detail.includes('约 2 天'), JSON.stringify(vba));

  const m = healthy(); m.units[1] = { ...m.units[1]!, result: 'timeout' }; m.backups[1]!.mtime = now - 6 * 864e5;
  const ma = computeAlerts(m);
  ok('维护超时 → 系统故障', ma.some(x => x.area === 'system' && x.title === '维护与备份上次运行失败' && x.detail.includes('timeout')));
  ok('备份超过 36 小时 → 系统故障', ma.some(x => x.title === 'Telegram 数据库超过 36 小时没有新备份'));
  const running = healthy(); running.units[1] = { ...running.units[1]!, active: 'activating', result: 'timeout' };
  ok('正在运行的任务不算失败', !computeAlerts(running).some(x => x.title.startsWith('维护与备份')));
  const dm = healthy(); dm.units[2] = { ...dm.units[2]!, active: 'failed' };
  ok('常驻服务停止 → 故障', computeAlerts(dm).some(x => x.title === 'Telegram 采集没有在运行'));

  const d = healthy(); d.disk = { totalBytes: 34e9, usedBytes: 30.6e9, freeBytes: 3.4e9 };
  ok('磁盘 90% → 留意', computeAlerts(d).some(x => x.level === 'warn' && x.title === '磁盘已用 90%'));
  d.disk = { totalBytes: 34e9, usedBytes: 33.7e9, freeBytes: 0.3e9 };
  ok('磁盘 99% → 故障', computeAlerts(d).some(x => x.level === 'bad' && x.title === '磁盘已用 99%'));

  const r = healthy(); r.sources.push({ id: 'x', display_name: 'X 来源', health: 'failing', enabled: 1, consecutive_failures: 7 });
  r.telegram.visionBacklog = 5000; r.runs.push({ ...healthy().runs[0]!, window_key: '2026-10-10:noon', window_label: '午报', status: 'failed' });
  const ra = computeAlerts(r);
  ok('故障排在留意前面', ra[0]!.level === 'bad' && ra[ra.length - 1]!.level === 'warn');
  ok('RSS 来源连续失败带次数', ra.some(x => x.area === 'sources' && x.detail.includes('X 来源（7 次）')));
  // RSS 与 X 来源分成两条，分别链接到各自区域（§11）
  const rx = healthy(); rx.sources.push({ id: 'blog', display_name: '博客', health: 'failing', enabled: 1, consecutive_failures: 3, host_group: 'direct' },
    { id: 'xu', display_name: 'X 用户', health: 'failing', enabled: 1, consecutive_failures: 4, host_group: 'github_x_rss' },
    { id: 'off', display_name: '停用的', health: 'failing', enabled: 0, consecutive_failures: 9, host_group: 'github_x_rss' });
  const rxa = computeAlerts(rx).filter(x => x.area === 'sources');
  ok('RSS / X 来源失败分两条告警', rxa.length === 2 && rxa[0]!.title === '1 个 RSS 来源连续失败' && rxa[0]!.href === '/subscriptions?tab=rss'
    && rxa[1]!.title === '1 个 X 来源连续失败' && rxa[1]!.href === '/subscriptions?tab=x' && !rxa[1]!.detail.includes('停用的'), JSON.stringify(rxa));
  // 每类「去处理」链接到新位置（§3）
  const hrefOf = (i: AlertInput, title: string) => computeAlerts(i).find(x => x.title.startsWith(title))?.href;
  const all = healthy(); all.telegram.authorized = false; all.telegram.heartbeatAt = iso(45 * 6e4); all.telegram.visionPaused = true;
  all.telegram.failedSummaries = 2; all.telegram.sources[0]!.last_success_at = iso(2 * 36e5); all.backupSettings = { local: false, gdrive: false };
  all.runs.push({ ...healthy().runs[0]!, window_key: '2026-10-10:noon', window_label: '午报', status: 'failed' });
  const links: Array<[string, string | undefined, string]> = [
    ['Telegram 账号未登录', hrefOf(all, 'Telegram 账号未登录'), '/settings?tab=telegram'],
    ['采集器无进展', hrefOf(hb, 'Telegram 采集器'), '/settings?tab=telegram'],
    ['来源没同步', hrefOf(st, '1 个 Telegram 来源超过'), '/subscriptions?tab=telegram'],
    ['单频道总结失败', hrefOf(all, '2 个频道总结生成失败'), '/subscriptions?tab=telegram'],
    ['图片识别暂停', hrefOf(all, '图片识别已暂停'), '/system#vision'],
    ['备份全关', hrefOf(all, '数据库备份已全部关闭'), '/settings?tab=data'],
    ['日报失败', hrefOf(all, '午报未完成'), '/runs?status=failed'],
    ['备份缺失', hrefOf(m, 'Telegram 数据库超过 36 小时'), '/system#backups'],
    ['磁盘', hrefOf(d, '磁盘已用'), '/system'],
  ];
  const wrong = links.filter(([, got, want]) => got !== want);
  ok('「去处理」链接指向新页面', wrong.length === 0, JSON.stringify(wrong));
}

console.log('\nsystemd 状态解析：\n');
{
  const out = [
    'Id=brief-run.service\nActiveState=inactive\nResult=success\nExecMainStartTimestamp=Sat 2026-10-10 00:00:10 UTC\nExecMainExitTimestamp=Sat 2026-10-10 00:09:48 UTC\nActiveEnterTimestamp=n/a\nNextElapseUSecRealtime=',
    'Id=brief-run.timer\nActiveState=active\nResult=success\nExecMainStartTimestamp=\nExecMainExitTimestamp=\nActiveEnterTimestamp=Fri 2026-10-02 10:00:00 UTC\nNextElapseUSecRealtime=Sat 2026-10-10 04:01:43 UTC',
    'Id=brief-telegram-collector.service\nActiveState=active\nResult=success\nExecMainStartTimestamp=Sat 2026-10-10 00:00:00 UTC\nExecMainExitTimestamp=\nActiveEnterTimestamp=Fri 2026-10-09 15:50:00 UTC\nNextElapseUSecRealtime=',
  ].join('\n\n');
  let args: string[] = [];
  const units = readUnits(a => { args = a; return out; });
  const run = units.find(u => u.id === 'brief-run')!;
  ok('使用 systemd 249 支持的 UTC 时间格式', args.includes('--timestamp=utc'));
  ok('一次查询所有服务和定时器', args.includes('brief-run.timer') && args.includes('brief-telegram-collector.service') && !args.includes('brief-telegram-collector.timer'));
  ok('解析上次运行与下次运行', run.startedAt === Date.parse('2026-10-10T00:00:10Z') && run.exitedAt === Date.parse('2026-10-10T00:09:48Z') && run.nextAt === Date.parse('2026-10-10T04:01:43Z') && run.result === 'success');
  ok('常驻服务取启动时间', units.find(u => u.id === 'brief-telegram-collector')!.startedAt === Date.parse('2026-10-09T15:50:00Z'));
  ok('间隔型定时器带说明文字', units.find(u => u.id === 'brief-subscriptions-sync')!.every === '每 5 分钟');
  ok('缺失的单元标为 unknown', units.find(u => u.id === 'brief-maintain')!.active === 'unknown');
  ok('systemctl 不可用时返回空数组', readUnits(() => { throw new Error('no dbus'); }).length === 0);
}

console.log('\n日报 RSS：\n');
const dir = mkdtempSync(join(tmpdir(), 'brief-admin-'));
{
  const db = openDb(join(dir, 'brief.db'));
  migrate(db, join(process.cwd(), 'migrations'));
  const token = briefFeedToken(db);
  ok('迁移自动生成 256 位令牌', /^[a-f0-9]{64}$/.test(token ?? ''));
  const addRun = (key: string, label: string, start: string, end: string) => Number(db.prepare(`INSERT INTO runs(window_key,window_label,window_start_at,window_end_at,scheduled_at,status,trigger)
    VALUES(?,?,?,?,?,'succeeded','timer')`).run(key, label, start, end, end).lastInsertRowid);
  const addBrief = (run: number, version: number, subject: string, status = 'final') => Number(db.prepare(`INSERT INTO briefs(run_id,version,subject,text_body,html_body,html_bytes,status,rule_version,created_at)
    VALUES(?,?,?,?,?,?,?,1,?)`).run(run, version, subject, 't', '<table style="border:1px">邮件</table>', 10, status, '2026-10-10T00:09:00.000Z').lastInsertRowid);
  const T0 = '2026-10-09T00:00:00.000Z';
  const cluster = (key: string) => Number(db.prepare(`INSERT INTO story_clusters(cluster_key,canonical_title,current_version_hash,created_at,updated_at) VALUES(?,?,?,?,?)`)
    .run(key, key, 'h', T0, T0).lastInsertRowid);
  const version = (source: string, key: string) => {
    const item = Number(db.prepare(`INSERT INTO feed_items(source_id,source_item_key,key_kind,first_seen_at,last_seen_at,created_at) VALUES(?,?,'guid',?,?,?)`)
      .run(source, key, T0, T0, T0).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO item_versions(item_id,content_hash,raw_hash,title,clean_text,discovered_at,version_no) VALUES(?,?,?,?,?,?,1)`)
      .run(item, key, key, key, key, T0).lastInsertRowid);
  };
  const member = (clusterId: number, source: string, key: string, at: string) => db.prepare(`INSERT INTO cluster_members(cluster_id,item_version_id,contribution,added_by,created_at)
    VALUES(?,?,'补充来源','model',?)`).run(clusterId, version(source, key), at);
  const addItem = (brief: number, order: number, section: string, title: string, source: string, url: string | null, clusterId = cluster(`c-${brief}-${order}`)) =>
    db.prepare(`INSERT INTO brief_items(brief_id,story_cluster_id,version_hash,section,order_no,status,title,conclusion,summary_json,source_name,source_url)
      VALUES(?,?,?,?,?,'included',?,?,?,?,?)`).run(brief, clusterId, 'h' + order, section, order, title, `${title}的结论 & 要点`, JSON.stringify(['第一句。', '第二句。']), source, url);
  db.prepare(`INSERT OR IGNORE INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,site_url,created_at,updated_at)
    VALUES('v2ex','v2ex','V2EX','forum','v2ex','standard','{}',1,'https://www.v2ex.com/',?,?)`).run('2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  for (const [id, name] of [['linuxdo', 'LINUX DO'], ['jike', '即刻']])
    db.prepare(`INSERT OR IGNORE INTO sources(id,name,display_name,category,host_group,harvest_tier,config_json,source_version,created_at,updated_at)
      VALUES(?,?,?,'forum',?,'standard','{}',1,?,?)`).run(id, id, name, id, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
  const r1 = addRun('2026-10-09:evening', '晚报', '2026-10-09T04:00:00.000Z', '2026-10-09T14:00:00.000Z');
  const r2 = addRun('2026-10-10:morning', '早报', '2026-10-09T14:00:00.000Z', '2026-10-10T00:00:00.000Z');
  const b1 = addBrief(r1, 1, '十六源日报 · 10-09 晚报');
  addBrief(r2, 1, '早报 v1（被替换）', 'superseded'); const b2 = addBrief(r2, 2, '十六源日报 · 10-10 早报');
  addBrief(r2, 3, '草稿不发布', 'draft');
  addItem(b1, 1, 'ai_tech', '晚报条目', 'v2ex', 'https://e.com/0');
  addItem(b2, 1, 'society_life', '社会条目', 'yicai', 'https://e.com/1');
  const shared = cluster('shared');
  addItem(b2, 2, 'ai_tech', '<AI> 条目', 'v2ex', 'https://e.com/2', shared);
  member(shared, 'linuxdo', 'k1', '2026-10-10T00:05:00.000Z');
  member(shared, 'v2ex', 'k2', '2026-10-10T00:05:00.000Z');
  member(shared, 'jike', 'k3', '2026-10-10T08:00:00.000Z');
  addItem(b2, 3, 'ai_tech', '不安全链接条目', 'v2ex', 'javascript:alert(1)');
  db.prepare(`INSERT INTO deliveries(brief_id,recipient,delivery_type,status,created_at,sent_at) VALUES(?,'me@example.com','primary','sent',?,?)`)
    .run(b2, '2026-10-10T00:09:48.000Z', '2026-10-10T00:09:48.000Z');
  const sections = [{ id: 'ai_tech', title: 'AI 与科技趋势' }, { id: 'society_life', title: '社会与生活速览' }];
  const feed = briefsRss(db, token!, 'https://rss.example', 20, sections)!;
  const content = (feed.match(/<content:encoded>(.*?)<\/content:encoded>/s)?.[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  ok('每期一条，最新的在前，标题简洁', (feed.match(/<item>/g) ?? []).length === 2 && feed.indexOf('10月10日 早报 · 3 条') < feed.indexOf('10月9日 晚报 · 1 条'));
  ok('只取定稿的最新版本', !feed.includes('被替换') && !feed.includes('草稿不发布'));
  ok('正文不用邮件 HTML，没有任何内联样式', !content.includes('<table') && !content.includes('style='));
  ok('分区按规则顺序，条目用 h3', content.indexOf('<h2>AI 与科技趋势</h2>') < content.indexOf('<h2>社会与生活速览</h2>') && content.includes('<h3><a href="https://e.com/2"><AI> 条目</a></h3>'.replace('<AI>', '&lt;AI&gt;')));
  ok('结论加粗、摘要成段', content.includes('<p><strong>&lt;AI&gt; 条目的结论 &amp; 要点</strong></p><p>第一句。第二句。</p>'));
  ok('条目底部不再有来源、另见和阅读原文，原文链接只在标题上', !content.includes('来源：') && !content.includes('另见') && !content.includes('阅读原文') && !content.includes('<small>')
    && (content.match(/href="https:\/\/e\.com\/2"/g) ?? []).length === 1);
  ok('非 https 链接不进正文', !content.includes('javascript:') && content.includes('<h3>不安全链接条目</h3>'));
  ok('开头说明时间窗口', content.startsWith('<p>22:00–08:00 的新内容，共 3 条。</p>'));
  ok('列表预览按正文顺序列出前几条标题', feed.includes('<description>&lt;AI&gt; 条目；不安全链接条目；社会条目</description>'));
  ok('发布时间取投递时间', feed.includes('<pubDate>Sat, 10 Oct 2026 00:09:48 GMT</pubDate>'));
  ok('文章链接指向后台运行记录', feed.includes(`<link>https://rss.example/runs/${r2}</link>`));
  ok('NetNewsWire 所需的命名空间与自引用', feed.includes('xmlns:content=') && feed.includes(`<atom:link href="https://rss.example/rss/briefs/${token}" rel="self"`));
  {
    let asked = '';
    const tg = (since: string) => { asked = since; return new Map([
      ['2026-10-10T00:00:00.000Z', { html: '<ol><li><p><strong>TG 早间要点</strong></p></li></ol>', texts: ['TG 早间要点'] }],
      ['2026-10-10T04:00:00.000Z', { html: '<ol><li><p><strong>TG 午间要点</strong></p></li></ol>', texts: ['TG 午间要点', '第二条'] }],
    ]); };
    const merged = briefsRss(db, token!, 'https://rss.example', 20, sections, tg)!;
    const bodies = [...merged.matchAll(/<content:encoded>(.*?)<\/content:encoded>/gs)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    const morning = bodies.find(b => b.includes('社会条目'))!;
    // 2026-10-22：用户要求从日报 RSS 移除「Telegram 频道要点」，即使传入 Telegram 回调也不拼接。
    ok('不再向 Telegram 取要点', asked === '');
    ok('日报正文不含 Telegram 要点', !bodies.some(b => b.includes('Telegram 频道要点') || b.includes('TG 早间要点')));
    ok('不再为日报缺失的时段单独给出 Telegram 要点', (merged.match(/<item>/g) ?? []).length === 2 && !merged.includes('仅 Telegram 要点'));
    void morning;
    ok('日报条目 guid 不变，阅读器原地更新', merged.includes(`brief:2026-10-10:morning:${b2}`));
  }
  ok('错误令牌返回 null', briefsRss(db, 'f'.repeat(64), '') === null);
  const fresh = rotateBriefFeedToken(db);
  ok('重置后旧令牌立即失效', briefsRss(db, token!, '') === null && briefsRss(db, fresh!, '') !== null);
  rotateBriefFeedToken(db, true);
  ok('撤销后没有可用令牌', briefFeedToken(db) === null && briefsRss(db, fresh!, '') === null);
  db.close();
}

console.log('\n页面渲染：\n');
{
  setNavBadges(() => ({ today: { count: 2, level: 'bad' }, subscriptions: { count: 1, level: 'warn' } }));
  const slots: TodaySlot[] = [
    { key: 'morning', label: '早报', clock: '08:00', scheduledAt: Date.parse('2026-10-10T00:00:00Z'),
      run: { status: 'succeeded', error: null, started_at: '2026-10-10T00:00:10.000Z', finished_at: '2026-10-10T00:09:48.000Z' }, items: 13,
      delivery: { status: 'sent', sent_at: '2026-10-10T00:09:48.000Z', error: null } },
    { key: 'noon', label: '午报', clock: '12:00', scheduledAt: Date.parse('2026-10-10T04:00:00Z'), run: null },
    { key: 'evening', label: '晚报', clock: '22:00', scheduledAt: Date.parse('2026-10-10T14:00:00Z'), run: null },
  ];
  const page = renderToday({ csrf: 'c', now, dateLabel: '10月10日 周六',
    alerts: [{ level: 'bad', area: 'today', title: '午报未完成（10-10）', detail: '<script>x</script>', href: '/runs?status=failed' }] });
  ok('待处理事项转义不可信文本', page.includes('&lt;script&gt;x&lt;/script&gt;') && !page.includes('<script>x'));
  ok('今日只有待处理：有「去处理」，没有时段卡片与统计', page.includes('>去处理</a>') && page.includes('href="/runs?status=failed"') && !page.includes('已投递') && !page.includes('运行概况'));
  const navOrder = ['>今日<', '>订阅源<', '>日报<', '>消息渠道<', '>系统运行<', '>设置<'].map(x => page.indexOf(x));
  ok('导航 6 项且顺序正确', navOrder.every((v, i) => v > 0 && (i === 0 || v > navOrder[i - 1]!)) && !page.includes('>Telegram</a>') && !page.includes('>来源</a>'), navOrder.join(','));
  ok('侧栏高亮当前页并显示计数', page.includes('<a href="/" class="on" aria-current="page">今日<span class="cnt bad">2</span></a>') && page.includes('订阅源<span class="cnt warn">1</span>'));
  ok('页面不含任何脚本', !/<script/i.test(page.replace('&lt;script', '')));
  const quiet = renderToday({ csrf: 'c', now, dateLabel: 'x', alerts: [] });
  ok('没有事项时说明截至时间', quiet.includes('截至 12:30 没有待处理事项'));
  // 原今日页的时段卡片与统计 → 系统运行顶部（判断逻辑不变）
  const overview = renderTodayOverview({ now, dateLabel: '10月10日 周六', slots,
    rss: { healthy: 31, enabled: 33, lastHarvestAt: iso(6e5), lastHarvestNew: 12 },
    telegram: { active: 15, enabled: 15, messages24h: 3184, authorized: true, heartbeatAt: iso(6e4) },
    ai: { calls: 412 }, disk: healthy().disk });
  ok('早报已投递并显示用时与条数', overview.includes('已投递') && overview.includes('用时 9 分 38 秒') && overview.includes('13 条'));
  ok('到点 30 分钟仍无记录 → 没有运行', overview.includes('没有运行'));
  ok('未来时段显示未开始', overview.includes('未开始'));
  ok('AI 只显示调用次数、不显示费用', overview.includes('412 次') && !overview.includes('$') && !overview.includes('费用') && !overview.includes(' token'));
  ok('Telegram 卡片显示授权与最近同步', overview.includes('账号已登录') && /最近同步 \d+ (分钟|小时|天)前/.test(overview));
  // 时段卡片判为异常的，在今日以告警出现：只补漏运行与已定稿未投递（§11）
  const sa = slotAlerts(slots, now);
  ok('漏运行 → 告警，链接到系统运行', sa.length === 1 && sa[0]!.title === '午报没有运行' && sa[0]!.href === '/system' && sa[0]!.level === 'bad', JSON.stringify(sa));
  const run = (status: string) => ({ id: 5, status, error: null, started_at: iso(6e5), finished_at: iso(3e5) });
  const one = (x: Partial<TodaySlot>) => slotAlerts([{ key: 'daily', label: '日报', clock: '08:00', scheduledAt: now - 36e5, ...x } as TodaySlot], now);
  ok('已定稿未投递 → 留意，链接到运行详情', (() => { const a = one({ run: run('succeeded'), items: 3, delivery: { status: 'failed', sent_at: null, error: 'SMTP 535' } });
    return a.length === 1 && a[0]!.title === '日报已生成但未投递' && a[0]!.href === '/runs/5' && a[0]!.detail === 'SMTP 535'; })());
  ok('只发 RSS 不算未投递', one({ run: run('succeeded'), items: 3, delivery: null, rssOnly: true }).length === 0);
  ok('已投递、进行中、失败（computeAlerts 已覆盖）、刚到点都不重复告警',
    one({ run: run('succeeded'), items: 3, delivery: { status: 'sent', sent_at: iso(1), error: null } }).length === 0
    && one({ run: run('running') }).length === 0 && one({ run: run('failed') }).length === 0 && one({ run: run('partial') }).length === 0
    && one({ scheduledAt: now - 5 * 6e4, run: null }).length === 0);
  // brief-run 在建运行记录前失败：computeAlerts 的「日报运行失败」与时段的「没有运行」合成一条
  const failedRun = healthy(); failedRun.units[0] = { ...failedRun.units[0]!, id: 'brief-run', result: 'exit-code' } as any; failedRun.runs = [];
  const unitAlerts = computeAlerts(failedRun);
  const mergedA = mergeSlotAlerts(unitAlerts, sa).filter(a => a.area === 'today');
  ok('建运行记录前失败只出一条待处理，保留失败详情', unitAlerts.some(a => a.title === '日报运行失败') && mergedA.length === 1
    && mergedA[0]!.title === '午报没有运行' && mergedA[0]!.detail.includes('exit-code'), JSON.stringify(mergedA));
  ok('没有服务失败时直接追加', mergeSlotAlerts(computeAlerts(healthy()), sa).filter(a => a.area === 'today').length === 1);
  setNavBadges(() => { throw new Error('db locked'); });
  ok('侧栏计数出错不影响页面', layout('设置', '<p>x</p>', 'c').includes('class="on" aria-current="page">设置'));
  const sys = renderSystem({ csrf: 'c', now, units: [], backups: healthy().backups, disk: healthy().disk, ai24h: { calls: 0, byStage: [] }, overview, vision: '<p>识别区</p>' });
  ok('读不到 systemd 时给出排查方法', sys.includes('无法读取 systemd 状态'));
  ok('系统运行顶部是时段卡片，含图片识别', sys.indexOf('今天的日报') < sys.indexOf('<h2>定时任务') && sys.includes('id="vision"') && sys.includes('识别区'));
  ok('备份只读：状态 + 去设置链接，没有开关表单', sys.includes('/settings?tab=data#backups') && !sys.includes('action="/system/backups"'));
  const sys2 = renderSystem({ csrf: 'c', now, units: [], backups: [], disk: null, ai24h: { calls: 3, byStage: [{ stage: 'luna', model: 'm', calls: 3 }] } });
  ok('AI 环节显示中文名且无费用', sys2.includes('L1 初筛') && !sys2.includes('$'));
  ok('备份卡片显示大小', sys.includes('242 MB') && sys.includes('33 MB'));
}

console.log('\n订阅源页：\n');
{
  const src = (id: string, host_group: string, extra: Record<string, unknown> = {}) => ({ id, display_name: id.toUpperCase(), category: 'tech', source_group: 'other', host_group,
    health: 'healthy', harvest_tier: 'standard', consecutive_failures: 0, last_success_at: null, last_http_code: 200, last_error: null, latest_item_at: null,
    enabled: 1, managed_by: 'admin', onboarding_status: 'ACTIVE', observation_until: null, endpoint_url: `https://${id}.example/feed`, endpoint_parser: 'rss', ...extra });
  const sources = [src('blog', 'direct'), src('hub', 'rsshub'), src('xuser', 'github_x_rss'), src('pend', 'direct', { enabled: 0, onboarding_status: 'HUMAN_REVIEW' })];
  const rss = renderSubscriptions({ csrf: 'c', tab: 'rss', sources: sources as any, telegramCount: 3 });
  ok('RSS 区：direct 与 rsshub，不含 X', rss.includes('BLOG') && rss.includes('HUB') && !rss.includes('XUSER'));
  ok('标签显示三个区域的数量', rss.includes('RSS 订阅源（3）') && rss.includes('X 账号（1）') && rss.includes('Telegram 频道与群组（3）'));
  ok('新增表单类型为 RSS，操作返回本区', rss.includes('name="kind" value="rss"') && rss.includes('name="redirect" value="/subscriptions?tab=rss"'));
  ok('待确认来源仍显示', rss.includes('PEND') && rss.includes('待确认'));
  ok('未知分组的来源归到「其他分组」，不消失', rss.includes('其他分组（3）'));
  ok('没有提案审核与全文开关', !rss.includes('/sources/proposals') && !rss.includes('require_fulltext'));
  const x = renderSubscriptions({ csrf: 'c', tab: 'x', sources: sources as any });
  ok('X 区只含 github_x_rss，新增类型为 X', x.includes('XUSER') && !x.includes('BLOG') && x.includes('name="kind" value="x"'));
  const tgPage = renderSubscriptions({ csrf: 'c', tab: 'telegram', sources: sources as any, telegramHtml: '<p>TG 区</p>' });
  ok('Telegram 区显示 Telegram 模块内容', tgPage.includes('TG 区') && !tgPage.includes('BLOG'));
  ok('错误时回填非敏感输入', renderSubscriptions({ csrf: 'c', tab: 'rss', sources: [], error: 'ID 冲突', form: { id: 'blog', name: '<博客>' } }).includes('value="&lt;博客&gt;"'));
}

console.log('\nTelegram 显示名：\n');
{
  const tg = readyTelegramDb(join(dir, 'telegram.db'));
  const src = addTelegramSource(tg, { reference: '@zaihuapd', sourceType: 'normal' });
  renameTelegramSource(tg, src.id, '  在花科技圈 ');
  ok('保存去掉首尾空格', (tg.prepare('SELECT display_name FROM telegram_sources WHERE id=?').get(src.id) as any).display_name === '在花科技圈');
  ok('留空回退为频道标题', (() => { renameTelegramSource(tg, src.id, ''); return (tg.prepare('SELECT display_name FROM telegram_sources WHERE id=?').get(src.id) as any).display_name === null; })());
  ok('超长显示名被拒绝', (() => { try { renameTelegramSource(tg, src.id, 'x'.repeat(81)); return false; } catch { return true; } })());
  ok('记录审计', !!tg.prepare("SELECT 1 FROM telegram_audit_events WHERE action='source_renamed'").get());
  tg.close();
}


console.log('\n后台操作请求队列：\n');
{
  const rq = join(dir, 'requests');
  // 时段键按当前 rules.yaml 的窗口配置校验（生产为每日一期 daily；2026-11-05 修复：旧正则拒绝 daily，后台重跑不可用）
  ok('只接受合法的时段键', parseRequest({ type: 'rerun', window: '2026-10-09:daily' }) !== null &&
    parseRequest({ type: 'rerun', window: '2026-10-09:noon' }) === null &&
    parseRequest({ type: 'rerun', window: '2026-10-09:daily; rm -rf /' }) === null && parseRequest({ type: 'rerun', window: '--shadow' }) === null);
  ok('补发只接受正整数 ID', parseRequest({ type: 'resend', briefId: 63 }) !== null && parseRequest({ type: 'resend', briefId: '63' }) === null && parseRequest({ type: 'other' }) === null);
  queueRequest(rq, { type: 'rerun', window: '2026-10-09:daily' });
  queueRequest(rq, { type: 'rerun', window: '2026-10-09:daily' });
  queueRequest(rq, { type: 'resend', briefId: 63 });
  ok('同一操作排队中不重复写入', pendingRequests(rq).length === 2);
  ok('按先后顺序取出并删除', (takeRequest(rq) as any).window === '2026-10-09:daily' && pendingRequests(rq).length === 1);
  writeFileSync(join(rq, '0000-bad.json'), '{"type":"rerun","window":"../../etc"}');
  ok('格式无效的文件被丢弃', takeRequest(rq) === 'invalid' && (takeRequest(rq) as any).briefId === 63 && takeRequest(rq) === null);
}

console.log('\n日报记录页：\n');
{
  const base: RunRow = { id: 7, window_key: '2026-10-09:noon', window_label: '午报', scheduled_at: '2026-10-09T04:00:00.000Z', started_at: '2026-10-09T04:01:00.000Z',
    finished_at: '2026-10-09T04:23:00.000Z', status: 'partial', stage: 'sending', trigger: 'timer', error: 'L2/L3 复核无进展、简报组装', cands: 640, items: null,
    brief_id: null, delivery_status: null, sent_at: null, resends: 0 };
  const ok1: RunRow = { ...base, id: 8, window_key: '2026-10-10:morning', window_label: '早报', status: 'succeeded', error: null, items: 13, brief_id: 63, delivery_status: 'sent', sent_at: '2026-10-10T00:09:48.000Z', resends: 1 };
  const list = renderRuns({ csrf: 'c', runs: [ok1, base], filter: 'all', queued: ['2026-10-09:noon'] });
  ok('列表显示已投递与补发次数', list.includes('已投递') && list.includes('补发 1 次'));
  ok('排队中的时段显示排队', list.includes('排队中'));
  // 2026-10-22 起投递方式为只发 RSS：定稿即发布，没有邮件记录不能显示成「未投递」
  const rssRun: RunRow = { ...ok1, id: 9, window_key: '2026-11-07:daily', window_label: '日报', delivery_status: null, sent_at: null, resends: 0, rss_only: true };
  const rssList = renderRuns({ csrf: 'c', runs: [rssRun], filter: 'all', queued: [] });
  ok('只发 RSS 的成功期次显示已发布（RSS）', rssList.includes('已发布（RSS）') && !rssList.includes('未投递'));
  ok('非只发 RSS 时没有邮件记录仍显示未投递', renderRuns({ csrf: 'c', runs: [{ ...rssRun, rss_only: false }], filter: 'all', queued: [] }).includes('未投递'));
  const rssToday = renderTodayOverview({ now: Date.parse('2026-11-07T04:00:00Z'), dateLabel: '11月7日',
    slots: [{ key: 'daily', label: '日报', clock: '08:00', scheduledAt: Date.parse('2026-11-07T00:00:00Z'),
      run: { status: 'succeeded', error: null, started_at: '2026-11-07T00:01:00.000Z', finished_at: '2026-11-07T00:11:00.000Z' }, items: 116, delivery: null, rssOnly: true }],
    rss: { healthy: 1, enabled: 1, lastHarvestAt: null, lastHarvestNew: null }, telegram: { active: 1, enabled: 1, messages24h: 1, authorized: true }, ai: { calls: 40 }, disk: null });
  ok('时段卡片每日一期：显示已发布（RSS）与条目数', rssToday.includes('已发布（RSS）') && rssToday.includes('116 条') && !rssToday.includes('午报'));
  ok('侧栏高亮日报', list.includes('<a href="/runs" class="on" aria-current="page">日报<'));
  ok('日报页有两个标签', list.includes('href="/runs?tab=telegram"') && list.includes('>日报记录</a>'));
  const detail = renderRunDetail({ csrf: 'c', run: base, queued: false, deliveries: [], candidates: [
    { id: 1, title: '<b>标题</b>', source_id: 'v2ex', canonical_url: 'https://e.com/1', decision: 'escalate', mandatory_class: 'none', section: null, filter_reason: null, stage: 'luna', confidence: 0.62, ai_reason: '需要复核', overridden: 0 },
    { id: 2, title: '被过滤', source_id: 'v2ex', canonical_url: null, decision: 'filter', mandatory_class: null, section: null, filter_reason: '广告', stage: 'luna', confidence: 0.9, ai_reason: null, overridden: 1 }] });
  ok('未发送的时段可以重新运行', detail.includes('action="/runs/7/rerun"') && detail.includes('重新运行此时段'));
  ok('没有日报时不显示重新发送', !detail.includes('/runs/7/resend'));
  ok('候选标题转义', detail.includes('&lt;b&gt;标题&lt;/b&gt;'));
  ok('过滤掉的候选默认折叠', detail.includes('<details><summary>过滤 · 1 条</summary>'));
  ok('人工处理表单返回本页', detail.includes('action="/candidates/1/override"') && detail.includes('name="redirect" value="/runs/7"'));
  ok('显示 AI 层级与置信度', detail.includes('L1 · 置信 62%'));
  ok('标记已人工处理', detail.includes('已人工处理'));
  const sent = renderRunDetail({ csrf: 'c', run: ok1, queued: false, candidates: [],
    deliveries: [{ delivery_type: 'primary', resend_sequence: 0, status: 'sent', sent_at: ok1.sent_at, created_at: ok1.sent_at!, error: null }] });
  ok('已投递的时段只能重新发送', sent.includes('/runs/8/resend') && !sent.includes('/runs/8/rerun') && sent.includes('首次投递'));
  ok('排队中按钮不可点', renderRunDetail({ csrf: 'c', run: base, queued: true, deliveries: [], candidates: [] }).includes('disabled>已排队，等待运行'));
}

console.log('\n消息渠道页：\n');
{
  const email = { mode: '', configured: false, transport: '', to: null };
  const page = renderChannels({ csrf: 'c', now, tab: 'rss', email, feeds: [
    { group: '日报', name: '日报', note: '每期一条', url: 'https://x/rss/briefs/t', lastAt: iso(36e5), action: '/rss/briefs/token' },
    { group: 'Telegram 单个频道', name: '<折腾>', note: '@a', url: null, lastAt: null, action: '/telegram/sources/1/token' }] });
  ok('按分组列出', page.includes('<h2>日报</h2>') && page.includes('<h2>Telegram 单个频道</h2>'));
  ok('操作完成后回到消息渠道 → RSS', page.includes('name="redirect" value="/channels?tab=rss"'));
  ok('说明「要点」与「全部频道」共用令牌', page.includes('共用一个令牌'));
  ok('令牌撤销后可重新生成', page.includes('令牌已撤销') && page.includes('>生成</button>'));
  ok('名称转义', page.includes('&lt;折腾&gt;'));
  ok('侧栏高亮消息渠道', page.includes('<a href="/channels" class="on" aria-current="page">消息渠道'));
  const mail = renderChannels({ csrf: 'c', now, tab: 'email', feeds: [], email: { mode: 'rss_only', configured: true, transport: 'smtp', to: 'a***@example.com' } });
  ok('邮件只读：投递方式、通道、收件地址，没有表单', mail.includes('只发 RSS') && mail.includes('已配置（smtp）') && mail.includes('a***@example.com') && !mail.includes('<form method="post" action="/channels'));
}

console.log('\nTelegram 各部分：\n');
{
  const settings = { timezone: 'Asia/Taipei', schedule_json: '["08:00","12:00","22:00"]', provider: 'openai_compatible', model: 'm', base_url: '', credential_ref: 'OPENAI_COMPAT_API_KEY',
    prompt_rules: '', vision_model: 'gemini', vision_daily_limit: 1000, vision_paused: 0, raw_retention_days: 6, summary_retention_days: 30, keep_messages_forever: 1 };
  const dg = (end: string) => ({ window_end: end, status: 'completed', fallback: 0, source_ids: '[1,2]', rendered_html: '<ol><li>x</li></ol>', error: null, attempts: 1, next_attempt_at: null, response_model: 'm' });
  const digests = telegramDigestsSection({ csrf: 'c', settings, digests: [dg(iso(36e5)), dg(iso(20 * 864e5))], lookbackFrom: iso(7 * 864e5) });
  ok('只有回溯范围内的时段能重新生成', (digests.match(/action="\/telegram\/digests\/regenerate"/g) ?? []).length === 1);
  ok('要点操作回到日报 → Telegram 要点', digests.includes('value="/runs?tab=telegram"'));
  const vision = telegramVisionSection({ csrf: 'c', settings, model: 'OpenAI 兼容 · gw.example.com · flash',
    vision: { pending: 1959, failed: 9, completedToday: 120, quotaUsed: 130, oldestMinutes: 600 } });
  ok('图片识别估算处理天数', vision.includes('1,959 张') && vision.includes('约 2 天处理完'));
  ok('今日完成（台北日期）与新图片额度（UTC）分开显示', vision.includes('今日完成') && vision.includes('120 张') && vision.includes('按台北日期') && vision.includes('130 / 1,000') && vision.includes('按 UTC 日期'));
  ok('显示实际生效的模型', vision.includes('OpenAI 兼容 · gw.example.com · flash') && !vision.includes('gemini'));
  const paused = telegramVisionSection({ csrf: 'c', settings: { ...settings, vision_paused: 1, vision_pause_reason: '鉴权失败' }, model: 'm',
    vision: { pending: 0, failed: 0, completedToday: 0, quotaUsed: 0, oldestMinutes: null } });
  ok('暂停时可恢复，操作回到系统运行', paused.includes('action="/telegram/vision/resume"') && paused.includes('value="/system#vision"'));
  const login = telegramLoginSection({ csrf: 'c', worker: { authorized: 1, heartbeat_at: iso(6e4), login_state: 'authorized' } });
  ok('登录表单回到设置 → Telegram', login.includes('value="/settings?tab=telegram"') && login.includes('type="password" name="value"'));
  const legacy = renderTelegramSettings({ csrf: 'c', settings });
  const managed = renderTelegramSettings({ csrf: 'c', settings, managed: true });
  ok('设置 → Telegram 有总结与图片识别两节', legacy.includes('id="telegram"') && legacy.includes('id="vision"'));
  ok('开关关着：可编辑旧模型字段，表单记住模式', legacy.includes('name="provider"') && legacy.includes('name="model_mode" value="legacy"'));
  ok('开关打开：不显示模型字段', !managed.includes('name="provider"') && !managed.includes('name="model"') && managed.includes('name="model_mode" value="managed"') && managed.includes('模型分配'));
  const ret = renderTelegramRetention({ csrf: 'c', settings });
  ok('数据保留在独立一节，永久保留默认勾选', ret.includes('id="retention"') && ret.includes('name="keep_forever" value="1" checked'));
  // 订阅源 · Telegram 区每行的 RSS 四种状态与总结失败提示
  const row = (id: number, x: Record<string, unknown>) => ({ id, reference: `@ch${id}`, display_name: `频道${id}`, title: null, telegram_kind: 'channel', source_type: 'normal',
    status: 'active', enabled: 1, rss_token: 'a'.repeat(64), last_error: null, last_message_at: iso(6e4), last_success_at: iso(6e4), messages_24h: 5, ...x });
  const tgs = telegramSourcesSection({ csrf: 'c', baseUrl: 'https://admin.example', timezone: 'Asia/Taipei', worker: { authorized: 1, heartbeat_at: iso(6e4) },
    sources: [row(1, {}), row(2, { rss_token: null }), row(3, { source_type: 'url', rss_token: null }), row(4, { enabled: 0 }),
      row(5, { summary_failures: 2, summary_failed_window: '2026-10-10T04:00:00.000Z' })] });
  ok('有令牌：链接 + 重置 / 撤销', tgs.includes(`https://admin.example/rss/telegram/source/${'a'.repeat(64)}`) && tgs.includes('>重置</button><button name="action" value="revoke">撤销</button>'));
  ok('令牌已撤销：已撤销 · 生成', tgs.includes('<span class="muted">已撤销</span> <form class="inline" method="post" action="/telegram/sources/2/token">'));
  ok('仅 URL 来源不提供 RSS', /仅提取 URL[\s\S]*<td><span class="muted">—<\/span><\/td>/.test(tgs));
  ok('停用来源仍可管理令牌', /action="\/telegram\/sources\/4\/toggle"[\s\S]*/.test(tgs) && tgs.includes('action="/telegram/sources/4/token"') && tgs.includes('已停用'));
  ok('单频道总结失败显示在对应行', tgs.includes('近 2 天有 2 个时段总结失败（最近 10/10 12:00）') && tgs.includes('不会再自动重做') && !tgs.includes('重新生成要点或服务器重跑时一并重试'));
  ok('行操作回到订阅源 → Telegram', tgs.includes('name="redirect" value="/subscriptions?tab=telegram"'));
  ok('添加失败回填输入', telegramSourcesSection({ csrf: 'c', baseUrl: '', timezone: 'UTC', worker: {}, sources: [], form: { reference: '@abc<', display_name: 'x', source_type: 'url' } })
    .includes('value="@abc&lt;"'));
}

console.log('\n设置校验：\n');
{
  const tg = readyTelegramDb(join(dir, 'telegram2.db'));
  const throws = (fn: () => void) => { try { fn(); return false; } catch { return true; } };
  setVisionDailyLimit(tg, '1000');
  ok('每日上限保存', (tg.prepare('SELECT vision_daily_limit v FROM telegram_settings').get() as any).v === 1000);
  ok('每日上限超过 1440 被拒', throws(() => setVisionDailyLimit(tg, 2000)) && throws(() => setVisionDailyLimit(tg, 0)) && throws(() => setVisionDailyLimit(tg, '1.5')));
  updateTelegramRetention(tg, { keepForever: false, rawDays: '10', summaryDays: 60 });
  const r = tg.prepare('SELECT keep_messages_forever k, raw_retention_days r, summary_retention_days s FROM telegram_settings').get() as any;
  ok('保留设置保存', r.k === 0 && r.r === 10 && r.s === 60);
  ok('保留天数越界被拒', throws(() => updateTelegramRetention(tg, { keepForever: true, rawDays: 0, summaryDays: 30 })));
  ok('设置变更有审计', !!tg.prepare("SELECT 1 FROM telegram_audit_events WHERE action='retention_updated'").get() && !!tg.prepare("SELECT 1 FROM telegram_audit_events WHERE action='vision_daily_limit_updated'").get());
  tg.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
