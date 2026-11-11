// 价格条目附购买地址：链接识别、白名单校验（不得编造）、reply 链上下文、可点击渲染（RSS / 日报）
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLinks, findLinks, isTelegramMessageUrl, linkHref, normalizeLink, renderLinkedHtml, restrictLinks } from '../packages/telegram/src/links.ts';
import { composeDaily, renderChunk, renderDailyHtml, renderDailyMarkdown } from '../packages/telegram/src/daily.ts';
import { collapseDuplicateMessages } from '../packages/telegram/src/core.ts';
import { readyTelegramDb } from '../packages/telegram/src/db.ts';
import { addTelegramSource } from '../packages/telegram/src/core.ts';
import { summarizeJob } from '../packages/telegram/src/summarize.ts';
import { renderDigestHtml, renderDigestFeedHtml, renderDigestText } from '../packages/digest/src/render.ts';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- 1. 链接识别 ----------
assert.deepEqual(findLinks('tg7788.com/buy/553 4块').map(l => l.raw), ['tg7788.com/buy/553'], '不带协议头的域名路径');
assert.deepEqual(findLinks('购买见 https://Shop.Example.com/a?b=1。').map(l => l.raw), ['https://Shop.Example.com/a?b=1'], '带协议头；句末标点不算链接');
assert.deepEqual(findLinks('找 t.me/foo_bot 下单，或 claude.ai').map(l => l.raw), ['t.me/foo_bot', 'claude.ai'], 't.me 机器人链接与常见后缀的裸域名');
assert.deepEqual(findLinks('访问shop.xyz/buy/9购买').map(l => l.raw), ['shop.xyz/buy/9'], '中文紧邻时路径不吞中文');
assert.deepEqual(findLinks('Node.js 和 Next.js、版本 v2.0.1、涨到 4.5 元、gpt-4.5、邮箱 a@b.com、e.g. 这种').map(l => l.raw), [], '版本号、小数、Node.js、邮箱不是链接');
assert.equal(findLinks('javascript:alert(1) data:text/html;base64,xx').length, 0, '非 http(s) 协议不识别');
assert.equal(linkHref('tg7788.com/buy/553'), 'https://tg7788.com/buy/553', '无协议头补 https://');
assert.equal(linkHref('http://a.com/x'), 'http://a.com/x', '已有协议头保持');
assert.equal(linkHref('https://user:pw@evil.com/'), null, '带凭据的地址不可点击');
assert.equal(normalizeLink('https://WWW.Tg7788.com/buy/553/'), normalizeLink('tg7788.com/buy/553'));
assert.ok(isTelegramMessageUrl('https://t.me/veovt/32807') && !isTelegramMessageUrl('javascript:alert(1)') && !isTelegramMessageUrl('https://evil.com/t.me/x'));

// ---------- 2. 白名单：链接只能来自输入 ----------
{
  const allowed = collectLinks(['苹果id多少钱独享', 'tg7788.com/buy/553 4块']);
  const r = restrictLinks('独享苹果 ID 4 元，购买：https://tg7788.com/buy/553 或 evil.test/fake', allowed);
  assert.deepEqual(r.removed, ['evil.test/fake'], '编造的链接被剔除');
  assert.ok(r.text.includes('tg7788.com/buy/553') && !r.text.includes('https://tg7788') && !r.text.includes('evil.test'), '真实链接还原为输入里的原样写法');
  const same = restrictLinks('某服务 5 美元，没有地址。', allowed);
  assert.equal(same.text, '某服务 5 美元，没有地址。'); assert.deepEqual(same.removed, [], '没有链接的条目不改动，也不会补链接');
}

// ---------- 3. 渲染：可点击、显示文字保持原样、转义 ----------
assert.equal(renderLinkedHtml('价格 4块 tg7788.com/buy/553。', esc), '价格 4块 <a href="https://tg7788.com/buy/553">tg7788.com/buy/553</a>。');
assert.equal(renderLinkedHtml('<b>x</b> & https://a.com/x?y=1&z=2', esc), '&lt;b&gt;x&lt;/b&gt; &amp; <a href="https://a.com/x?y=1&amp;z=2">https://a.com/x?y=1&amp;z=2</a>');
assert.ok(!renderLinkedHtml('点我 javascript:alert(1)', esc).includes('<a'));
assert.ok(!renderLinkedHtml('http://plain.example/x', esc, { href: u => (u.startsWith('https:') ? u : null) }).includes('<a'), 'href 过滤器可只放行 https');

// ---------- 4. 与重复折叠 / 垃圾丢弃共存 ----------
{
  const m = (id: number, text: string, reply: number | null = null) => ({ message_id: id, reply_to_id: reply, text });
  const items = [m(1, '问价'), ...Array.from({ length: 6 }, (_, i) => m(10 + i, 'tg7788.com/buy/553 4块', 1))];
  const out = collapseDuplicateMessages(items, x => x.text, (x, text) => ({ ...x, text }));
  assert.equal(out.length, 2, '短消息高频重复只折叠，不丢弃');
  assert.ok(out[1]!.text.startsWith('tg7788.com/buy/553 4块') && out[1]!.text.includes('（×6）'), '折叠后链接仍在');
  assert.equal(out[1]!.reply_to_id, 1, 'reply 链保留');
}

// ---------- 5. 每日要点：价格和链接在不同消息里（问价 / 回复） ----------
const T = '2026-10-27T14:00:00Z';
const group = { group: 'G群', messages: [
  { message_id: 1, sent_at: T, reply_to_id: null, text: '苹果id多少钱独享', source_url: null },
  { message_id: 2, sent_at: T, reply_to_id: 1, text: '1u', source_url: null },
  { message_id: 3, sent_at: T, reply_to_id: 1, text: 'tg7788.com/buy/553 4块', source_url: 'https://t.me/g/3' },
  { message_id: 4, sent_at: T, reply_to_id: null, text: '某机场套餐 5 美元一个月，没有给地址', source_url: 'https://t.me/g/4' },
  { message_id: 5, sent_at: T, reply_to_id: null, text: '另一个套餐 8 美元', source_url: null },
] };
{
  const prompts: string[] = []; const mergeInputs: string[] = [];
  const prov: any = { name: 'mock', model: 'm', strictness: 'strict', async complete(req: any) {
    if (req.schemaName === 'tg_extract') {
      prompts.push(req.userContent);
      return { data: { points: [
        { category: '数码/系统', text: '独享苹果 ID 1u 或 4 元，购买：https://tg7788.com/buy/553，备用 evil.test/fake。' },
        { category: '网络/代理', text: '某机场套餐 5 美元一个月。' }, { category: '网络/代理', text: '另一个套餐 8 美元。' },
      ] }, usage: {}, responseId: 'r', model: 'm' };
    }
    mergeInputs.push(req.userContent);
    const list = JSON.parse(req.userContent.slice(req.userContent.indexOf('\n\n') + 2));
    return { data: { items: list.map((x: any) => ({ text: `${x.text} 详见 fake.invalid/x`, groups: x.groups })) }, usage: {}, responseId: 'r', model: 'm' };
  } };
  const d = await composeDaily(prov, [group], 's', 'e');
  const all = d.categories.flatMap(c => c.items);
  const apple = all.find(i => i.text.includes('苹果'))!;
  assert.ok(apple.text.includes('tg7788.com/buy/553') && !apple.text.includes('https://tg7788'), '价格条目带着购买地址（原样写法）');
  assert.ok(!all.some(i => /evil\.test|fake\.invalid/.test(i.text)), '编造的链接在提取和合并两步都被剔除');
  assert.deepEqual(apple.sourceUrls, ['https://t.me/g/3'], '原消息有 source_url：按链接回查附上');
  assert.ok(all.filter(i => !i.text.includes('tg7788')).every(i => !findLinks(i.text).length && !i.sourceUrls), '没有购买地址的价格条目不会被补链接或 source_url');
  assert.ok(mergeInputs.length > 0 && mergeInputs.every(x => !x.includes('tg7788')), '带地址的条目不交给合并模型，地址不会在合并中被改写');
  const html = renderDailyHtml(d);
  assert.ok(html.includes('<a href="https://tg7788.com/buy/553">tg7788.com/buy/553</a>'), 'RSS/后台 HTML 里是可点击链接，显示文字保持原样');
  assert.ok(html.includes('<a href="https://t.me/g/3">原消息</a>'));
  assert.ok(renderDailyMarkdown(d).includes('tg7788.com/buy/553') && renderDailyMarkdown(d).includes('https://t.me/g/3'));
  assert.ok(!/<a [^>]*>[^<]*(机场|套餐)/.test(html), '无地址的条目没有链接');
  // 提示词里保留了链接、reply_to 和同块的回复关系
  assert.ok(prompts[0]!.includes('tg7788.com/buy/553') && prompts[0]!.includes('reply_to="1"'));
  assert.ok(!prompts[0]!.includes('reply_to_text'), '被回复消息就在同一块里时不重复附引用');
}
{
  // 问价与回复被分块切开：回复所在块里附上被回复消息的开头
  const prompts: string[] = [];
  const prov: any = { name: 'mock', model: 'm', strictness: 'strict', async complete(req: any) { prompts.push(req.userContent); return { data: { points: [] }, usage: {}, responseId: 'r', model: 'm' }; } };
  await composeDaily(prov, [{ group: 'G群', messages: group.messages.slice(0, 3) }], 's', 'e', { maxChars: 140 });
  assert.equal(prompts.length, 3);
  assert.ok(prompts[2]!.includes('reply_to_text="苹果id多少钱独享"'), '分块后回复仍带上被回复的问价消息');
  assert.ok(renderChunk([group.messages[2]!], new Map(group.messages.map(m => [m.message_id, m]))).includes('reply_to_text="苹果id多少钱独享"'));
}
{
  // 渲染转义：条目文本里的 HTML 不会进入页面；sourceUrls 只放行 t.me 消息链接
  const html = renderDailyHtml({ format: 'daily_v2', windowStart: '', windowEnd: '', groups: ['G'],
    categories: [{ name: 'c', items: [{ text: '<script>x</script> a.com/<b>', groups: ['G'], sourceUrls: ['javascript:alert(1)', 'https://evil.com/x'] }] }] });
  assert.ok(!html.includes('<script>') && !html.includes('javascript:') && !html.includes('evil.com'));
}

// ---------- 6. 单频道总结路径 ----------
{
  const dir = mkdtempSync(join(tmpdir(), 'brief-links-')); const db = readyTelegramDb(join(dir, 'telegram.db'));
  const src = addTelegramSource(db, { reference: 't.me/linkchan', sourceType: 'normal' });
  const ws = '2026-10-27T14:00:00.000Z', we = '2026-10-27T15:00:00.000Z';
  const ins = db.prepare(`INSERT INTO telegram_messages(source_id,chat_id,message_id,sent_at,text,reply_to_id,content_hash,collected_at) VALUES(?,?,?,?,?,?,?,?)`);
  ins.run(src.id, -1002, 1, '2026-10-27T14:01:00.000Z', '苹果id多少钱独享 ' + 'y'.repeat(1900), null, 'h1', ws);
  ins.run(src.id, -1002, 2, '2026-10-27T14:09:00.000Z', 'tg7788.com/buy/553 4块', 1, 'h2', ws);
  const job = db.prepare(`INSERT INTO telegram_summary_jobs(source_id,window_start,window_end,input_hash,provider,model,prompt_version,status,created_at,updated_at) VALUES(?,?,?,'','mock','m',1,'pending',?,?)`).run(src.id, ws, we, ws, ws);
  const prompts: string[] = [];
  const prov: any = { name: 'mock', model: 'm', strictness: 'strict', async complete(req: any) {
    prompts.push(req.userContent);
    return { data: { topics: [], important: ['独享苹果 ID 4 元，购买：https://tg7788.com/buy/553 ，另见 https://fake.invalid/x'], viewpoints: [], sources: [], uncertainty: ['无地址的报价 5 美元。'] }, usage: {}, responseId: 'r', model: 'm' };
  } };
  assert.equal(await summarizeJob(db, Number(job.lastInsertRowid), { provider: 'mock', model: 'm', promptRules: "", promptVersion: 1, summaryRetentionDays: 30, maxInputChars: 2000 }, prov), true);
  assert.ok(prompts.some(p => p.includes('tg7788.com/buy/553') && p.includes('reply_to_text="苹果id多少钱独享')), '分块后总结提示词里仍带被回复消息');
  const row = db.prepare('SELECT summary_json,rendered_html FROM telegram_summaries WHERE job_id=?').get(job.lastInsertRowid) as any;
  const v = JSON.parse(row.summary_json);
  assert.ok(v.important[0].includes('tg7788.com/buy/553') && !v.important[0].includes('fake.invalid') && !v.important[0].includes('https://tg7788'), '编造链接被剔除，真实链接保持原样');
  assert.ok(row.rendered_html.includes('<a href="https://tg7788.com/buy/553">tg7788.com/buy/553</a>'));
  assert.ok(!row.rendered_html.includes('fake.invalid') && v.uncertainty[0] === '无地址的报价 5 美元。');
  db.close();
}

// ---------- 7. 日报（邮件 / RSS / 纯文本）第七节 ----------
{
  const base: any = { format: 'digest_v2', date: '2026-10-27', windowLabel: '早报', windowRange: '10-27 08:00–12:00', vendors: [], emptyVendors: [], projects: [], tutorials: [], politics: [],
    telegram: { status: 'ready', windowStart: '2026-10-26T23:00:00Z', windowEnd: '2026-10-27T23:00:00Z', groups: ['G群'], categories: [{ name: '数码/系统', items: [
      { text: '独享苹果 ID 1u 或 4 元，购买：tg7788.com/buy/553。', groups: ['G群'], sourceUrls: ['https://t.me/g/3', 'javascript:alert(1)'] },
      { text: '旧链接 http://plain.example/x 不可点击。', groups: ['G群'] }, { text: '某套餐 5 美元。', groups: ['G群'] }] }] } };
  for (const html of [renderDigestHtml(base), renderDigestFeedHtml(base)]) {
    assert.ok(html.includes('href="https://tg7788.com/buy/553"') && html.includes('>tg7788.com/buy/553</a>'), '日报里购买地址可点击，显示文字原样');
    assert.ok(html.includes('href="https://t.me/g/3"') && !html.includes('javascript:'), '原消息链接只放行 t.me');
    assert.ok(!html.includes('href="http://plain.example'), '日报只放行 https 链接');
    assert.ok(html.includes('某套餐 5 美元。</li>') || html.includes('某套餐 5 美元。 <'), '无地址条目原样');
  }
  const text = renderDigestText(base);
  assert.ok(text.includes('tg7788.com/buy/553') && text.includes('原消息：https://t.me/g/3'));
}
console.log('✅ 价格购买地址测试通过');
