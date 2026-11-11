// 技术干货板块（含专栏）：预筛、去重、模型判定接线、渲染与 72h 登记的回归测试
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildTutorials, prescreenTutorial, cleanTutorialSummary, tutorialKey, TUTORIAL_SOURCES, TUTORIAL_URL_OVERRIDES } from '../packages/digest/src/tutorials.ts';
import { renderDigestHtml, renderDigestText, renderDigestFeedHtml, digestCount, digestTitles } from '../packages/digest/src/render.ts';
import { recordPushed } from '../packages/digest/src/build.ts';
import { checkEmail } from '../packages/templates/src/email.ts';
import type { DigestData, DigestSourceItem } from '../packages/digest/src/core.ts';

const it = (o: Partial<DigestSourceItem>): DigestSourceItem => ({ id: 1, sourceId: 'linuxdo', sourceName: 'LINUX DO', vendor: 'linuxdo', official: false,
  role: 'context', title: '', text: '', url: null, publishedAt: null, firstSeenAt: '2026-10-22T00:00:00Z', ...o });

const guide = it({ id: 1, title: 'Docker 部署 Nginx 反代踩坑', url: 'https://linux.do/t/1',
  text: '1. 安装 docker\n2. 编写 compose 配置\n3. 启动并验证\n$ docker compose up -d\n最后实测延迟下降 30%，踩坑点是端口冲突。' });
const ask = it({ id: 2, title: '求助：怎么选手机', url: 'https://linux.do/t/2', text: '预算三千，有没有推荐的？大家帮忙看看，谢谢，在线等，挺急的真的，周末要买了。最好是拍照好一点的，电池也要耐用，系统流畅不卡顿，外观好看一些，谢谢各位佬友。' });
const chat = it({ id: 3, title: '今天生日', url: 'https://linux.do/t/3', text: '发红包' });
const mk = it({ id: 4, title: '【公益站】注册送 $10 额度', url: 'https://linux.do/t/4', text: '注册链接 https://x.example/register?aff=abc123 填写邀请码 AB12CD 送额度，欢迎大家来玩，多多支持，稳定运行很久了' });
const repoPost = it({ id: 5, sourceId: 'v2ex', title: '开源了一个部署工具', url: 'https://v2ex.com/t/5', text: '一键部署脚本 https://github.com/foo/bar 教程见 README，安装配置都写好了，欢迎使用，欢迎 star。' });
const dup = it({ id: 6, sourceId: 'v2ex', title: 'Docker 部署 Nginx 反代踩坑', url: 'https://v2ex.com/t/6', text: guide.text });
const official = it({ id: 90, sourceId: 'openai_news', sourceName: 'OpenAI News', vendor: 'openai', official: true, role: 'official', title: 'Introducing X', text: 'x', url: 'https://openai.com/index/x' });
const repostPost = it({ id: 7, title: '转：Introducing X 教程配置', url: 'https://linux.do/t/7', text: '原文 https://openai.com/index/x 配置教程和部署说明，内容很多，请大家仔细阅读并按步骤操作，非常详细的步骤。' });
const twin = it({ id: 9, title: '开源了一个部署工具', url: 'https://linux.do/t/9', text: '一键部署脚本已开源，教程见 README，安装配置都写好了，欢迎使用，欢迎大家来试用，欢迎提意见建议。' });
const pushedBefore = it({ id: 8, title: '昨天已推送的教程', url: 'https://linux.do/t/8?utm_source=a', text: '教程：配置部署的完整步骤，包含命令和配置，已经在昨天的日报里推送过了，所以今天不应该再出现一次。' });

// ---- 预筛 ----
assert.equal(prescreenTutorial(guide).reason, null);
assert.match(prescreenTutorial(chat).reason!, /过短/);
assert.match(prescreenTutorial(mk).reason!, /AFF|营销/);
assert.equal(prescreenTutorial(ask).reason, null, '预筛放宽：只挡短帖与 AFF，其余交给模型');
assert.match(prescreenTutorial(it({ title: '反重力可以用了', text: 'image 780×372 17.7 KB' })).reason!, /过短/, '图片占位不算正文');
assert.equal(tutorialKey('https://linux.do/t/topic/3061561/34'), 'linux.do/t/topic/3061561');
assert.equal(tutorialKey('https://v2ex.com/t/1251245'), 'v2ex.com/t/1251245');
assert.deepEqual(TUTORIAL_SOURCES, ['linuxdo', 'v2ex']);
assert.equal(cleanTutorialSummary('⭐ 在 LINUX DO 上：用 Docker 部署了 Nginx。'), '用 Docker 部署了 Nginx。');

// ---- 编排（模型用桩） ----
const seen: any[] = [];
const provider: any = { name: 'mock', model: 'mock', strictness: 'strict', async complete(req: any) {
  const u = JSON.parse(req.userContent);
  seen.push(req.schemaName);
  if (req.schemaName === 'tutorial_judge') return { data: { results: u.posts.map((p: any) => p.id === 1 || p.id === 6
    ? { id: p.id, tutorial: true, category: 'tech', reason: '', summary: '⭐用 Docker Compose 部署 Nginx 反代，实测延迟下降 30%，需避开端口冲突。' }
    : { id: p.id, tutorial: false, category: 'none', reason: '观点讨论', summary: '' }) } };
  return { data: { verdicts: [] } };
} };
const ctx = { officials: [official], projectRepos: new Set(['foo/bar']), pushedUrls: new Set(['linux.do/t/8']), pushedTitles: [] as string[] };
const r = await buildTutorials(provider, [guide, ask, chat, mk, repoPost, twin, dup, repostPost, pushedBefore, official], ctx);
assert.equal(r.tutorials[0]!.category, 'tech'); assert.equal(r.report.pickedItems[0]!.category, 'tech');
assert.deepEqual(r.tutorials.map(t => t.itemId), [1], '只入选步骤完整的教程，交叉发布去重');
assert.ok(!/[⭐🌟]/.test(r.tutorials[0]!.summary) && r.tutorials[0]!.url === 'https://linux.do/t/1');
assert.deepEqual(r.report.candidates, { linuxdo: 7, v2ex: 2 }, '官方条目不计入候选');
const why = Object.fromEntries(r.report.excluded.map(x => [x.id, x.stage]));
assert.deepEqual(why, { 2: 'model', 3: 'prescreen', 4: 'prescreen', 5: 'project', 9: 'project', 6: 'dup', 7: 'repost', 8: 'history' });
assert.equal(r.report.picked, 1); assert.equal(r.report.pickedItems.length, 1);
// 指定楼层深链覆盖显示链接，去重仍按主题帖
const floorItem = it({ id: 11, title: '限时秒杀信息整理', url: 'https://linux.do/t/topic/3066730', text: guide.text });
const fr = await buildTutorials({ ...provider, async complete(req: any) { return { data: { results: JSON.parse(req.userContent).posts.map((p: any) => ({ id: p.id, tutorial: true, category: 'deals', reason: '限时优惠信息', summary: '整点补库存的限时活动。' })) } }; } } as any,
  [floorItem], { ...ctx, pushedUrls: new Set() });
assert.equal(fr.tutorials[0]!.url, TUTORIAL_URL_OVERRIDES['linux.do/t/topic/3066730']);
const fr2 = await buildTutorials(provider, [floorItem], { ...ctx, pushedUrls: new Set(['linux.do/t/topic/3066730']) });
assert.equal(fr2.report.excluded[0]!.stage, 'history', '带楼层链接登记后，按主题帖去重');
// 模型失败：不收录任何帖子，板块为空而不是整体失败
const bad: any = { ...provider, async complete() { throw new Error('boom'); } };
const r2 = await buildTutorials(bad, [guide], { ...ctx, pushedUrls: new Set() });
assert.equal(r2.tutorials.length, 0); assert.ok(r2.report.modelError);

// ---- 渲染 ----
const base: DigestData = { format: 'digest_v2', date: '2026-10-23', windowLabel: '日报', windowRange: '10-22 08:00–10-23 08:00', vendors: [], emptyVendors: [],
  projects: [{ repo: 'a/b', url: 'https://github.com/a/b', description: '工具', mentionedBy: [] }], politics: ['新闻。'] };
const d: DigestData = { ...base, tutorials: r.tutorials };
const outs = [renderDigestHtml(d), renderDigestText(d), renderDigestFeedHtml(d)];
for (const s of outs) {
  assert.ok(s.includes('三、技术干货') && s.includes('四、时政速览'));
  assert.ok(s.indexOf('二、开源项目') < s.indexOf('三、技术干货') && s.indexOf('三、技术干货') < s.indexOf('四、时政速览'), '位置：开源项目之后、时政速览之前');
  assert.ok(s.includes('实测延迟下降 30%') && s.includes('https://linux.do/t/1'));
  assert.ok(!/[⭐★]/.test(s) && !s.includes('LINUX DO'), '无星标、条目不重复来源名');
}
assert.deepEqual(checkEmail(outs[0]!, outs[1]!), []);
const withTg = { ...d, telegram: { status: 'ready' as const, categories: [{ name: '优惠', items: [{ text: 'x', groups: ['g'] }] }], groups: ['g'] } };
for (const s of [renderDigestText(withTg), renderDigestFeedHtml(withTg)]) assert.ok(s.includes('五、Telegram 群组要点') && s.indexOf('四、时政速览') < s.indexOf('五、Telegram'));
// 空板块
for (const s of [renderDigestHtml({ ...base, tutorials: [] }), renderDigestText({ ...base, tutorials: [] }), renderDigestFeedHtml({ ...base, tutorials: [] })])
  assert.ok(!s.includes('技术干货') && !s.includes('羊毛资讯') && !s.includes('生活经验') && !s.includes('本期无合适') && s.includes('三、时政速览'), '三个新章节当日无内容则整章不显示，编号不留空');
// 旧数据（无 tutorials 字段）保持原编号、不出现新板块
for (const s of [renderDigestHtml(base), renderDigestText(base), renderDigestFeedHtml(base)]) assert.ok(!s.includes('技术干货') && s.includes('三、时政速览'));
// 三个并列的顶级章节：技术干货、羊毛资讯、生活经验（顺序固定；缺 category 视为 tech；无内容的章节整章不显示，后续编号顺延）
const mkT = (n: number, category?: any, extra: any = {}) => ({ title: `T${n}`, summary: `摘要${n}。`, url: `https://linux.do/t/${n}`, itemId: n, ...(category ? { category } : {}), ...extra });
const catD: DigestData = { ...base, tutorials: [mkT(1, 'life'), mkT(2, 'deals'), mkT(3), mkT(4, 'tech')], telegram: { status: 'ready', categories: [{ name: '优惠', items: [{ text: 'x', groups: ['g'] }] }], groups: ['g'] } };
for (const s of [renderDigestHtml(catD), renderDigestText(catD), renderDigestFeedHtml(catD)]) {
  const at = (t: string) => s.indexOf(t);
  assert.ok(at('三、技术干货') > 0 && at('三、技术干货') < at('四、羊毛资讯') && at('四、羊毛资讯') < at('五、生活经验') && at('五、生活经验') < at('六、时政速览') && at('六、时政速览') < at('七、Telegram 群组要点'), '顶级章节顺序与编号');
  assert.ok(at('摘要3') < at('摘要4') && at('摘要4') < at('四、羊毛资讯') && at('摘要2') > at('四、羊毛资讯') && at('摘要2') < at('五、生活经验') && at('摘要1') > at('五、生活经验'), '条目归入对应章节');
  assert.ok(!/<h3[^>]*>\s*(技术干货|羊毛资讯|生活经验)/.test(s), '没有小标题层级');
}
const onlyDeals: DigestData = { ...base, tutorials: [mkT(2, 'deals'), mkT(9, 'deals', { channel: 'telegram', url: 'https://t.me/g/9' }), mkT(8, 'deals', { channel: 'telegram', url: '' })] };
for (const s of [renderDigestHtml(onlyDeals), renderDigestText(onlyDeals), renderDigestFeedHtml(onlyDeals)]) {
  assert.ok(s.includes('三、羊毛资讯') && s.includes('四、时政速览') && !s.includes('技术干货') && !s.includes('生活经验'));
  assert.ok(s.includes('原消息') && s.includes('https://t.me/g/9'));
}
const noLink = renderDigestText(onlyDeals).split('\n'); const k = noLink.findIndex(l => l.includes('摘要8'));
assert.ok(!(noLink[k + 1] ?? '').includes('原'), '没有链接的条目不放链接，也不编造');
assert.equal(digestCount(d), 2); assert.deepEqual(digestTitles(d), ['a/b', guide.title]);

// ---- 72h 登记：迁移前不报错；迁移后写入并幂等 ----
const db: any = new Database(':memory:'); db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE briefs(id INTEGER PRIMARY KEY);
 CREATE TABLE pushed_events (id INTEGER PRIMARY KEY, vendor TEXT, title TEXT, summary TEXT, urls_json TEXT, brief_id INTEGER, pushed_at TEXT);
 CREATE TABLE pushed_projects (id INTEGER PRIMARY KEY, repo TEXT, description TEXT, brief_id INTEGER, pushed_at TEXT);`);
db.exec('INSERT INTO briefs(id) VALUES (1),(2)');
recordPushed(db, 1, d);   // 无 pushed_tutorials 表：只登记项目
assert.equal(db.prepare('SELECT count(*) n FROM pushed_projects').get().n, 1);
db.exec(await import('node:fs').then(f => f.readFileSync('./migrations/017_pushed_tutorials.sql', 'utf8')));
recordPushed(db, 2, { ...d, tutorials: [{ ...d.tutorials![0]!, category: 'deals' }] });
assert.equal(db.prepare('SELECT count(*) n FROM pushed_tutorials').get().n, 1);
assert.equal(db.prepare('SELECT category c FROM pushed_tutorials').get().c, 'deals');
recordPushed(db, 2, d);
assert.equal(db.prepare('SELECT count(*) n FROM pushed_tutorials').get().n, 1, '同一期不重复登记');
console.log('tutorials: all passed');
