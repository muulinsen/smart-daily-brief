// 新版日报：确定性规则与渲染的回归测试
import assert from 'node:assert/strict';
import { stripVendorPrefix, classifyRepost, decodeEntities, extractRepos, isReplyOrTrivial, linksFor, preMergeByLinks, similarity, type DigestSourceItem, type DigestData } from '../packages/digest/src/core.ts';
import { renderDigestHtml, renderDigestText, renderDigestFeedHtml } from '../packages/digest/src/render.ts';
import { checkEmail } from '../packages/templates/src/email.ts';

const it = (o: Partial<DigestSourceItem>): DigestSourceItem => ({ id: 1, sourceId: 'x_openai', sourceName: '@OpenAI', vendor: 'openai', official: true,
  role: 'official', title: '', text: '', url: null, publishedAt: null, firstSeenAt: '2026-10-22T00:00:00Z', ...o });

assert.equal(decodeEntities('we&#39;re &amp; you'), "we're & you");
assert.ok(isReplyOrTrivial(it({ title: 'R to @foo: thanks', text: 'thanks' })));
assert.ok(isReplyOrTrivial(it({ title: 'lol', text: 'lol https://t.co/x' })));
assert.ok(!isReplyOrTrivial(it({ title: 'Introducing GPT-6', text: 'Introducing GPT-6, our most capable model with new reasoning features.' })));
assert.ok(!isReplyOrTrivial(it({ sourceId: 'openai_news', title: 'Short', text: 'x' })), '官网条目不按长度过滤');

assert.deepEqual(extractRepos('see https://github.com/Foo/Bar.git and github.com/features/copilot, github.com/a-b/c_d.'), ['foo/bar', 'a-b/c_d']);
assert.ok(similarity('OpenAI 发布 GPT-6 模型', 'OpenAI 发布了 GPT-6 模型') > 0.6);
assert.ok(similarity('Cloudflare outage', 'Gemma 4 release') < 0.2);

const off = it({ id: 10, title: 'Introducing Codex cloud', url: 'https://openai.com/index/codex-cloud/' });
assert.equal(classifyRepost(it({ id: 11, official: false, title: '转：OpenAI 新功能', text: '原文 https://openai.com/index/codex-cloud?utm_source=x' }), [off]).verdict, 'repost');
assert.equal(classifyRepost(it({ id: 12, official: false, title: '我写了个 Rust 小工具', text: 'github.com/me/tool' }), [off]).verdict, 'distinct');

const g = preMergeByLinks([off, it({ id: 20, title: 'Codex cloud is here', text: 'Read more https://openai.com/index/codex-cloud/' }), it({ id: 21, title: 'Other', text: 'nothing' })]);
assert.equal(g.length, 2);
assert.deepEqual(linksFor([off, it({ id: 30, sourceName: '@OpenAI', url: 'https://x.com/OpenAI/status/1' })]).map(l => l.label), ['@OpenAI', '@OpenAI (2)']);

const d: DigestData = { format: 'digest_v2', date: '2026-10-22', windowLabel: '午报', windowRange: '10-22 08:00–12:00',
  vendors: [{ vendor: 'openai', name: 'OpenAI', events: [{ title: 'Codex <cloud>', summary: '摘要。', itemIds: [1, 2],
    links: [{ label: 'OpenAI News', url: 'https://openai.com/a' }, { label: '@OpenAI', url: 'javascript:alert(1)' }] }] }],
  emptyVendors: ['Notion', 'DeepSeek'], projects: [{ repo: 'foo/bar', url: 'https://github.com/foo/bar', description: '一个工具', mentionedBy: [{ label: 'V2EX', url: 'https://v2ex.com/t/1' }] }],
  politics: ['第一条新闻。', '第二条<新闻>。'] };
const html = renderDigestHtml(d), text = renderDigestText(d), feed = renderDigestFeedHtml(d);
assert.deepEqual(checkEmail(html, text), []);
for (const s of [html, text, feed]) {
  assert.ok(s.includes('一、官方动态') && s.includes('二、开源项目') && s.includes('三、时政速览'));
  assert.ok(s.includes('Notion、DeepSeek：本期无更新'));
  assert.ok(!/[⭐★]/.test(s), '不得出现星标');
  assert.ok(!s.includes('Telegram'));
}
assert.ok(html.includes('北京时间 10-22 08:00–12:00'));
assert.ok(!html.includes('javascript:') && html.includes('&lt;cloud&gt;'));
assert.equal(stripVendorPrefix('OpenAI 发布 GPT-6', 'openai', 'OpenAI'), '发布 GPT-6');
assert.equal(stripVendorPrefix('Google推出 Gemma 4', 'google', 'Google'), '推出 Gemma 4');
assert.equal(stripVendorPrefix('谷歌：更新搜索', 'google', 'Google'), '更新搜索');
assert.equal(stripVendorPrefix('Claude Code 发布 2.1', 'anthropic', 'Anthropic'), 'Claude Code 发布 2.1', '产品名不是厂商名，保留');
assert.equal(stripVendorPrefix('Codex 新功能', 'openai', 'OpenAI'), 'Codex 新功能');
assert.ok(html.includes('<li style="margin:0 0 6px;">第一条新闻。</li>') && html.includes('第二条&lt;新闻&gt;。'));
assert.ok(text.includes('• 第一条新闻。\n• 第二条<新闻>。'));
assert.ok(feed.includes('<h2>三、时政速览</h2><ul><li>第一条新闻。</li>'));
const old = renderDigestText({ ...d, politics: '旧版一段。' as any });
assert.ok(old.includes('• 旧版一段。'), '兼容旧字符串数据');
assert.ok(renderDigestText({ ...d, politics: [] }).includes('本时段暂无值得关注的时政动态。'));
// ---- 四、Telegram 群组要点 ----
const tgd = { ...d, telegram: { status: 'ready' as const, windowStart: '2026-10-20T23:00:00Z', windowEnd: '2026-10-21T23:00:00Z',
  categories: [{ name: '会员订阅/优惠', items: [{ text: 'Spotify 严查家庭组是否同住，7 天内没完成验证会被降级。', groups: ['折腾频道VIP群', '@TossiPhone'] }] }], groups: ['折腾频道VIP群', '@TossiPhone'] } };
for (const s2 of [renderDigestHtml(tgd), renderDigestText(tgd), renderDigestFeedHtml(tgd)]) {
  assert.ok(s2.includes('四、Telegram 群组要点') && s2.includes('Spotify 严查家庭组') && s2.includes('折腾频道VIP群、@TossiPhone'));
  assert.ok(s2.indexOf('三、时政速览') < s2.indexOf('四、Telegram 群组要点'), 'Telegram 为最后一节');
}
assert.ok(renderDigestText({ ...d, telegram: { status: 'pending', categories: [], groups: [] } }).includes('群组要点生成中'));
assert.ok(!renderDigestText(d).includes('四、Telegram'), '未配置时不出现该节');
assert.deepEqual(checkEmail(renderDigestHtml(tgd), renderDigestText(tgd)), []);
console.log('digest: all passed');
