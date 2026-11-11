// Telegram 群组每日要点（daily_v2）：分块提取 → 按分类合并，不设条数上限
import assert from 'node:assert/strict';
import { isDaily, chunkMessages, composeDaily, normalizeCategory, renderDailyHtml, renderDailyMarkdown, dailyCount } from '../packages/telegram/src/daily.ts';
import { collapseDuplicateMessages, SPAM_DUPLICATE_MIN_COUNT, SPAM_DUPLICATE_MIN_LENGTH } from '../packages/telegram/src/core.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import { TELEGRAM_DIGEST_SCHEMA, validateDigest, fallbackDigest } from '../packages/telegram/src/digest.ts';

assert.equal(normalizeCategory('eSIM'), 'eSIM/保号');
assert.equal(normalizeCategory(' 银行/支付 '), '银行/支付');
assert.equal(normalizeCategory(''), '其他');
assert.equal(chunkMessages([{ text: 'a'.repeat(900) }, { text: 'b'.repeat(900) }, { text: 'c' }], 1200).length, 2);
assert.equal((TELEGRAM_DIGEST_SCHEMA.properties.points as any).maxItems, undefined, '取消 10 条上限');
assert.equal(validateDigest({ points: Array.from({ length: 25 }, (_, i) => ({ text: `要点${i}`, detail: '', channels: ['A'] })) }, ['A']).points.length, 25);
{
  const fb = fallbackDigest([{ sourceId: 1, channel: 'A', windowStart: '', summary: { important: Array.from({ length: 15 }, (_, i) => `x${i}`) } },
    { sourceId: 2, channel: 'B', windowStart: '', summary: { important: [], topics: ['t1'] } }], 's', 'e', ['说明']);
  assert.equal(fb.format, 'daily_v2'); assert.equal(isDaily(fb), true);
  assert.equal(dailyCount(fb), 16); assert.deepEqual(fb.groups, ['A', 'B']); assert.deepEqual(fb.notes, ['说明']);
  assert.ok(renderDailyHtml(fb).includes('<h3>B</h3>') && renderDailyHtml(fb).includes('<small>说明</small>'));
}

const calls: string[] = [];
const fake: any = { name: 'mock', model: 'm', strictness: 'strict', async complete(req: any) {
  calls.push(req.schemaName);
  if (req.schemaName === 'tg_extract') {
    const n = (req.userContent.match(/<message /g) ?? []).length;
    const group = /群：(.*)/.exec(req.userContent)![1];
    return { data: { points: Array.from({ length: n }, (_, i) => ({ category: i % 2 ? 'eSIM' : '会员订阅/优惠', text: `${group} 要点 ${i}，价格 5 美元。` })) }, usage: {}, responseId: 'r', model: 'm' };
  }
  const list = JSON.parse(req.userContent.slice(req.userContent.indexOf('\n\n') + 2));
  return { data: { items: list.map((x: any) => ({ text: x.text, groups: [...x.groups, '编造群'] })) }, usage: {}, responseId: 'r', model: 'm' };
} };
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ message_id: i + 1, sent_at: '2026-10-21T00:00:00Z', reply_to_id: null, text: 'x'.repeat(500) + i }));  // 各条文本互不相同，避免被当作垃圾重复消息折叠/丢弃
const d = await composeDaily(fake, [{ group: 'A群', messages: msgs(30) }, { group: 'B群', messages: msgs(3) }], 's', 'e', { maxChars: 3000 });
assert.ok(calls.filter(c => c === 'tg_extract').length > 2, '按群分块提取');
assert.ok(calls.includes('tg_merge'), '按分类合并');
assert.equal(dailyCount(d), 33, '不丢要点、无上限');
assert.deepEqual(d.categories.map(c => c.name), ['会员订阅/优惠', 'eSIM/保号'], '按建议分类顺序');
assert.ok(d.categories.every(c => c.items.every(i => !i.groups.includes('编造群'))), '来源群只能取输入中的群');
assert.ok(renderDailyHtml(d).includes('<h3>eSIM/保号</h3>') && renderDailyMarkdown(d).includes('〔A群〕'));

// 单群提取失败：跳过并标注，其余群照常；全部失败才抛错
process.env.TELEGRAM_DAILY_RETRY_MS = '0';
const flaky: any = { ...fake, async complete(req: any) {
  if (req.schemaName === 'tg_extract' && /群：B群/.test(req.userContent)) throw new Error('响应不是合法 JSON（响应体为空）');
  return fake.complete(req);
} };
const d2 = await composeDaily(flaky, [{ group: 'A群', messages: msgs(3) }, { group: 'B群', messages: msgs(3) }], 's', 'e');
assert.equal(dailyCount(d2), 3, '只保留 A 群');
// 用户决定（2026-11-10）：结尾一句说明哪些群组没有正常汇总
assert.deepEqual(d2.notes, ['本期以下群组未正常汇总：B群（生成失败）']);
assert.deepEqual(d2.issues, [{ sourceId: undefined, group: 'B群', reasons: ['generation_failed'] }]);
assert.ok(renderDailyHtml(d2).endsWith('<p><small>本期以下群组未正常汇总：B群（生成失败）</small></p>'), '说明在最后');
const dead: any = { ...fake, async complete() { throw new Error('down'); } };
await assert.rejects(() => composeDaily(dead, [{ group: 'A群', messages: msgs(2) }, { group: 'B群', messages: msgs(2) }], 's', 'e'), /down/);

// 内容被模型过滤：不重试、跳过该块，并与「生成失败」区分标注
{
  const filteredErr = () => { const e = new ProviderError('bad_request', '内容被模型过滤（响应无 choices，补全 0 token）'); e.contentFiltered = true; return e; };
  let extractCalls: Record<string, number> = {};
  const prov: any = { ...fake, async complete(req: any) {
    if (req.schemaName === 'tg_extract') {
      const group = /群：(.*)/.exec(req.userContent)![1]!; extractCalls[group] = (extractCalls[group] ?? 0) + 1;
      if (group === 'F群') throw filteredErr();
      if (group === 'G群') throw new Error('响应不是合法 JSON（响应体为空）');
      if (group === 'P群' && /分块 2\//.test(req.userContent)) throw filteredErr();
    }
    return fake.complete(req);
  } };
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ message_id: i + 1, sent_at: '2026-10-21T00:00:00Z', reply_to_id: null, text: 'y'.repeat(500) + i }));
  const d3 = await composeDaily(prov, [{ group: 'A群', messages: msgs(3) }, { group: 'F群', messages: msgs(3) }, { group: 'G群', messages: msgs(3) },
    { group: 'P群', messages: big(8) }], 's', 'e', { maxChars: 3000 });
  assert.equal(extractCalls['F群'], 1, '被过滤的块不重试');
  assert.equal(extractCalls['G群'], 3, '普通失败仍重试 3 次');
  assert.deepEqual(d3.notes, ['本期以下群组未正常汇总：F群（内容被模型过滤）；G群（生成失败）；P群（部分内容被模型过滤）']);
  assert.ok(dailyCount(d3) > 0 && d3.categories.every(c => c.items.every(i => !i.groups.includes('F群'))));
}

// 同窗口完全相同消息折叠成一条并标 ×N
{
  const rows = [
    { message_id: 1, sent_at: 't1', reply_to_id: null, text: '广告 A' },
    { message_id: 2, sent_at: 't2', reply_to_id: null, text: '正常讨论 1' },
    { message_id: 3, sent_at: 't3', reply_to_id: null, text: '  广告   A\n' },      // 空白差异，规范化后相同
    { message_id: 4, sent_at: 't4', reply_to_id: 3, text: '回复被折叠的消息' },
    { message_id: 5, sent_at: 't5', reply_to_id: null, text: '广告 A' },
    { message_id: 6, sent_at: 't6', reply_to_id: null, text: '广告 B' },
  ];
  const out = collapseDuplicateMessages(rows, m => m.text, (m, text) => ({ ...m, text }));
  assert.deepEqual(out.map(m => m.message_id), [1, 2, 4, 6], '保留首次出现，其余顺序不变');
  assert.equal(out[0]!.text, '广告 A\n（×3）'); assert.equal(out[0]!.sent_at, 't1');
  assert.equal(out[1]!.text, '正常讨论 1', 'N=1 不加标注');
  assert.equal(out[2]!.reply_to_id, 1, '回复被折叠消息时指向保留的那条');
  assert.equal(out[3]!.text, '广告 B');
  assert.equal(rows[0]!.text, '广告 A', '不修改输入');
}

// 垃圾重复消息：长文本重复 ≥5 次整组丢弃；短文本只折叠；2～4 次折叠；回复被丢弃的消息不悬空
{
  assert.equal(SPAM_DUPLICATE_MIN_COUNT, 5); assert.equal(SPAM_DUPLICATE_MIN_LENGTH, 30);
  const longAd = '点击链接领取限时福利资源，立即免费观看，名额有限先到先得，不要错过！'; // 规范化后 ≥ 30 字符
  assert.ok(longAd.length >= 30);
  const mk = (id: number, text: string, reply: number | null = null) => ({ message_id: id, sent_at: `t${id}`, reply_to_id: reply, text });
  const dropped: Array<{ count: number; length: number; hash: string }> = [];
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => mk(i + 1, i % 2 ? `  ${longAd}  ` : longAd)),   // 长文本 ×5（含空白差异）→ 丢弃
    ...Array.from({ length: 6 }, (_, i) => mk(10 + i, '哈哈')),                              // 短文本 ×6 → 折叠保留
    ...Array.from({ length: 4 }, (_, i) => mk(20 + i, longAd + '（另一条）')),             // 长文本 ×4 → 折叠保留
    mk(30, '正常消息'),
    mk(31, '回复垃圾广告', 3),                                                               // 回复被丢弃的消息
    mk(32, '回复被折叠的消息', 22),                                                          // 回复被折叠消息 → 指向保留的那条
  ];
  const out = collapseDuplicateMessages(rows, m => m.text, (m, text) => ({ ...m, text }), { onDrop: d => dropped.push(d) });
  assert.deepEqual(out.map(m => m.message_id), [10, 20, 30, 31, 32]);
  assert.equal(out[0]!.text, '哈哈\n（×6）', '短文本高频只折叠、不丢弃');
  assert.equal(out[1]!.text, longAd + '（另一条）\n（×4）', '2～4 次折叠并标 ×N');
  assert.equal(out.find(m => m.message_id === 31)!.reply_to_id, null, '回复被丢弃的垃圾消息：reply_to 置空，不报错');
  assert.equal(out.find(m => m.message_id === 32)!.reply_to_id, 20);
  assert.equal(dropped.length, 1); assert.equal(dropped[0]!.count, 5);
  assert.ok(JSON.stringify(dropped).indexOf('福利') < 0, '回调/日志信息不含原文');
  assert.ok(/^[0-9a-f]{8}$/.test(dropped[0]!.hash));
  assert.equal(collapseDuplicateMessages(rows.slice(0, 4), m => m.text, (m, text) => ({ ...m, text })).length, 1, '长文本 ×4 折叠成 1 条');
  assert.equal(collapseDuplicateMessages(rows.slice(0, 5), m => m.text, (m, text) => ({ ...m, text })).length, 0, '长文本 ×5 全部丢弃');
}
console.log('telegram-daily: all passed');
