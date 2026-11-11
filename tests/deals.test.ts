// 羊毛资讯（全渠道）：Telegram/其他渠道抽取、跨渠道合并、Telegram 汇总去重的回归测试（模型用桩，Telegram 库用临时文件）
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTelegramMessages, collectExtraDeals, mergeAllDeals, stripDealsFromTelegram, DEAL_HINT } from '../packages/digest/src/deals.ts';
import type { DigestSourceItem, DigestTelegram } from '../packages/digest/src/core.ts';

const dir = mkdtempSync(join(tmpdir(), 'tgdeals-'));
const path = join(dir, 'tg.sqlite3');
const db = new Database(path);
db.exec(`CREATE TABLE telegram_sources (id INTEGER PRIMARY KEY, source_type TEXT, enabled INTEGER, display_name TEXT, title TEXT, reference TEXT);
CREATE TABLE telegram_messages (source_id INTEGER, chat_id INTEGER, message_id INTEGER, sent_at TEXT, text TEXT, source_url TEXT, deleted_at TEXT);
CREATE TABLE telegram_media_tasks (chat_id INTEGER, message_id INTEGER, description TEXT, key_text TEXT, superseded_at TEXT, status TEXT);`);
db.prepare(`INSERT INTO telegram_sources VALUES (1,'normal',1,'A群',null,'a'),(2,'normal',0,'停用群',null,'b')`).run();
const ins = db.prepare(`INSERT INTO telegram_messages VALUES (?,?,?,?,?,?,NULL)`);
ins.run(1, 10, 1, '2026-10-23T03:00:00Z', 'ExampleCloud 双11 云服务器 2 核 2G 首年 99 元优惠，限新用户，11 月 11 日截止', 'https://t.me/a/1');
ins.run(1, 10, 2, '2026-10-23T04:00:00Z', '有没有什么羊毛可以薅，求推荐一下最近的福利啊', 'https://t.me/a/2');
ins.run(1, 10, 3, '2026-10-23T05:00:00Z', '免费领 ExampleVPN 会员 30 天，活动页登录即得，本周内有效', null);
ins.run(1, 10, 4, '2026-10-22T10:00:00Z', '窗口外的优惠消息：限时免费领取会员三十天', 'https://t.me/a/4');
ins.run(2, 11, 1, '2026-10-23T05:00:00Z', '停用群里的优惠：限时免费领取会员三十天，活动页登录', 'https://t.me/b/1');
db.prepare(`INSERT INTO telegram_media_tasks VALUES (10,3,'截图','ExampleVPN 免费会员',NULL,'completed')`).run();
db.close();

const msgs = loadTelegramMessages(path, '2026-10-22T16:00:00Z', '2026-10-23T16:00:00Z');
assert.deepEqual(msgs.map(m => m.messageId), [1, 2, 3], '只取窗口内、启用群、未删除的消息');
assert.ok(msgs[2]!.text.includes('[图片文字] ExampleVPN 免费会员'), '带上图片识别文字');
assert.equal(msgs[2]!.link, null, '库里没有消息链接就是 null');
assert.ok(DEAL_HINT.test('限时免费') && !DEAL_HINT.test('今天天气不错'));

const mkItem = (o: Partial<DigestSourceItem>): DigestSourceItem => ({ id: 1, sourceId: 'rss1', sourceName: 'Some RSS', vendor: 'x', official: false, role: 'context',
  title: '', text: '', url: null, publishedAt: null, firstSeenAt: '2026-10-23T00:00:00Z', ...o });
const items = [
  mkItem({ id: 1, title: 'ExampleSaaS 限时免费 3 个月', text: '新用户注册即可免费使用三个月高级版，活动截至 11 月底。', url: 'https://example.com/promo' }),
  mkItem({ id: 2, sourceId: 'linuxdo', title: '论坛帖', text: '限时免费领取会员的论坛帖子，这里不应由其他渠道流程处理。', url: 'https://linux.do/t/1' }),
  mkItem({ id: 3, role: 'politics', title: '政治新闻 免费', text: '免费 免费 免费 政治素材不应进入羊毛资讯的候选范围里。' }),
  mkItem({ id: 4, title: '已在官方动态', text: '限时免费领取的官方发布内容，已经出现在官方动态章节里面。' }),
];
const calls: string[] = [];
const provider: any = { name: 'mock', model: 'mock', strictness: 'strict', async complete(req: any) {
  calls.push(req.schemaName); const u = JSON.parse(req.userContent);
  if (req.schemaName === 'deal_judge') return { data: { results: u.items.map((x: any) => /羊毛可以薅/.test(x.text)
    ? { id: x.id, deal: false, title: '', reason: '闲聊提问', summary: '' }
    : { id: x.id, deal: true, title: x.text.slice(0, 8), reason: '', summary: `⭐${x.text.slice(0, 30)}。` }) } };
  if (req.schemaName === 'deal_merge') return { data: { groups: [{ ids: u.items.filter((i: any) => /ExampleVPN|VPN/.test(i.title + i.summary)).map((i: any) => i.id), summary: '合并后的 ExampleVPN 免费会员。' },
    ...u.items.filter((i: any) => !/VPN/.test(i.title + i.summary)).map((i: any) => ({ ids: [i.id], summary: i.summary }))].filter(g => g.ids.length) } };
  if (req.schemaName === 'tg_deal_match') return { data: { remove: u.lines.filter((l: any) => /ExampleCloud/.test(l.text)).map((l: any) => l.id) } };
  throw new Error('unexpected ' + req.schemaName);
} };
const ctx = { items, skipItemIds: new Set([4]), forumSources: ['linuxdo', 'v2ex'], telegramPath: path, start: '2026-10-22T16:00:00Z', end: '2026-10-23T16:00:00Z', pushedUrls: new Set<string>(), pushedTitles: [] as string[] };
const ex = await collectExtraDeals(provider, ctx);
assert.equal(ex.report.other.candidates, 1, '其他渠道候选不含论坛、时政、已在官方动态的条目');
assert.equal(ex.report.telegram.messages, 3); assert.equal(ex.report.telegram.hinted, 3);
assert.deepEqual(ex.extras.map(e => e.channel).sort(), ['other', 'telegram', 'telegram']);
assert.deepEqual(ex.report.rejected.map(r => r.reason), ['闲聊提问'], '被模型否掉的线索条目进入报告，便于复核');
assert.ok(ex.extras.every(e => !/[⭐🌟]/.test(e.summary)));
const noLink = ex.extras.find(e => e.channel === 'telegram' && e.url === '');
assert.ok(noLink, '库里没有 t.me 链接的 Telegram 条目 url 为空，不编造');
// 72h 内已推送的不再出现
const ex2 = await collectExtraDeals(provider, { ...ctx, pushedUrls: new Set(['t.me/a/1']) });
assert.equal(ex2.report.dropped.length, 1);

// 合并：论坛 + 其他渠道 + Telegram 的同一优惠合成一条，保留有链接的来源
const forum = [{ title: 'ExampleVPN 免费会员', summary: '论坛说的 ExampleVPN 免费会员。', url: 'https://linux.do/t/topic/9', itemId: 9, category: 'deals' as const }];
const merged = await mergeAllDeals(provider, forum, ex.extras, ex.report);
assert.equal(merged.length, 3, 'ExampleVPN 两条合并为一条，其余各自一条');
const vpn = merged.find(m => m.summary.includes('合并后'))!;
assert.equal(vpn.url, 'https://linux.do/t/topic/9', '合并后优先用有链接、且论坛来源的链接');
assert.ok(merged.every(m => m.category === 'deals'));
assert.equal(ex.report.merged.find(m => m.summary.includes('合并后'))!.members.length, 2);
// 模型合并失败：按原样保留，不丢条目
const broken: any = { ...provider, async complete(req: any) { if (req.schemaName === 'deal_merge') throw new Error('boom'); return provider.complete(req); } };
const rep2 = { ...ex.report, merged: [] as any[] };
const kept = await mergeAllDeals(broken, forum, ex.extras, rep2);
assert.equal(kept.length, 4); assert.ok(rep2.modelError);

// Telegram 汇总：去掉已单独成条的羊毛行，其余不变
const tg: DigestTelegram = { status: 'ready', groups: ['A群'], categories: [
  { name: '会员订阅/优惠', items: [{ text: 'ExampleCloud 双11 云服务器首年 99 元', groups: ['A群'] }, { text: '另一条与羊毛无关的要点', groups: ['A群'] }] },
  { name: '其他', items: [{ text: 'ExampleCloud 讨论', groups: ['A群'] }] }] };
const s = await stripDealsFromTelegram(provider, tg, merged);
assert.deepEqual(s.tg.categories.map(c => [c.name, c.items.length]), [['会员订阅/优惠', 1]], '空分类整个去掉');
assert.equal(s.removed.length, 2);
assert.equal(tg.categories[0]!.items.length, 2, '不修改入参');
assert.deepEqual((await stripDealsFromTelegram(provider, { ...tg, status: 'pending' }, merged)).removed, [], 'pending 状态原样返回');
rmSync(dir, { recursive: true, force: true });
console.log('deals: all passed');
