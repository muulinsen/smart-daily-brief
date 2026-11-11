// L2/L3 复核链路（PRD 15.1 / 15.4 / 15.5）
import { runReview, priorityOf, shouldPromoteToL3, REVIEW_SCHEMA,
         type ReviewInput, type ReviewDeps, type ReviewResult } from '../packages/ai/src/review.ts';
import type { Provider, CompleteRequest, CompleteResult } from '../packages/ai/src/types.ts';
import { ProviderError } from '../packages/ai/src/types.ts';

let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const inp = (id: string, over: Partial<ReviewInput> = {}): ReviewInput => ({
  candidateId: id, sourceId: 'linuxdo', sourceKind: 'forum', title: '标题 ' + id,
  publishedAt: '2026-08-23T00:00:00Z', url: 'https://x/' + id, body: '正文'.repeat(40),
  signals: [], repos: [], officialLinks: [], prescreenClasses: [], contentHash: 'h' + id,
  priorDecision: 'normal', priorConfidence: 0.6, escalationRules: ['ESC-001'], ...over,
});

const reply = (over: Partial<ReviewResult> = {}, id = 'x'): CompleteResult => ({
  data: {
    candidate_id: id, decision: 'normal', mandatory_class: 'none', section: 'ai_tech',
    event_key: 'e', confidence: 0.9, filter_reason: null, conflicts: [], source_limitations: [],
    needs_higher_tier: false, higher_tier_reasons: [], conclusion: '结论', summary_sentences: ['a', 'b'],
    ...over,
  },
  usage: { inputTokens: 800, outputTokens: 200, cachedInputTokens: 0, cacheWriteTokens: 0 },
  responseId: 'r', model: 'fake',
});

function fake(fn: (req: CompleteRequest, call: number) => CompleteResult | Error): Provider {
  let n = 0;
  return { name: 'mock', model: 'fake', strictness: 'strict',
    async complete(req) { const r = fn(req, ++n); if (r instanceof Error) throw r; return r; } };
}
const idOf = (req: CompleteRequest) => JSON.parse(req.userContent).candidate_id as string;

const deps = (l2p: Provider, l3p: Provider, over: Partial<ReviewDeps> = {}): ReviewDeps => ({
  l2: { provider: l2p, budget: { maxItems: 5, inputTokensMax: 25000, outputTokensMax: 5000 } },
  l3: { provider: l3p, budget: { maxItems: 2, inputTokensMax: 15000, outputTokensMax: 3000 } },
  systemPrompt: '复核规则'.repeat(20), bodyCharsMax: 6000,
  highRiskKeywords: ['量化', '临床', '加密'], ...over,
});

console.log('优先级排序（PRD 15.5：名额不足时先保强制保留与高风险）\n');
{
  const cases: Array<[string, ReviewInput, number]> = [
    ['ESC-005 强制保留被判过滤', inp('a', { escalationRules: ['ESC-005'], prescreenClasses: ['A'] }), 0],
    ['其他强制保留候选', inp('b', { prescreenClasses: ['B'] }), 1],
    ['高风险领域', inp('c', { body: '量化策略回测结果' }), 2],
    ['重大新闻', inp('d', { escalationRules: ['ESC-003'] }), 3],
    ['来源冲突', inp('e', { escalationRules: ['ESC-004'] }), 4],
    ['仅低置信', inp('f', { escalationRules: ['ESC-001'] }), 5],
  ];
  for (const [name, c, want] of cases)
    ok(name + ' → 优先级 ' + want, priorityOf(c, deps(fake(() => reply()), fake(() => reply())).highRiskKeywords) === want);
}

console.log('\n名额不足时按优先级取用，不是先到先得：\n');
{
  const seen: string[] = [];
  const p = fake((req) => { seen.push(idOf(req)); return reply({}, idOf(req)); });
  // 故意把最该复核的排在最后入队
  const list = [
    inp('low1'), inp('low2'), inp('low3'), inp('low4'), inp('low5'),
    inp('critical', { escalationRules: ['ESC-005'], prescreenClasses: ['A'] }),
    inp('risky', { body: '涉及加密合规' }),
  ];
  const d = deps(p, fake(() => reply()));
  d.l2.budget.maxItems = 2;
  const r = await runReview(list, d);
  ok('L2 只用了 2 个名额', r.l2Used.items === 2, seen.join(','));
  ok('ESC-005 排第一个被复核', seen[0] === 'critical');
  ok('高风险排第二', seen[1] === 'risky');
  ok('被挤掉的转人工而非丢弃',
     r.deferred.length === 5 && r.outcomes.filter(o => o.status === 'skipped').every(o => !!o.error));
  ok('每条候选都有归宿', r.outcomes.length === 7);
}

console.log('\nESC-005：复核层应能推翻 L1 的错误过滤\n');
{
  const p = fake((req) => reply({ decision: 'retain', mandatory_class: 'A' }, idOf(req)));
  const r = await runReview(
    [inp('v1', { prescreenClasses: ['A'], priorDecision: 'filter', escalationRules: ['ESC-005'] })],
    deps(p, fake(() => reply())));
  const o = r.outcomes[0]!;
  ok('L1 的 filter 被推翻为 retain', o.result?.decision === 'retain' && o.result.mandatory_class === 'A');
}

console.log('\nL2 → L3 升级（rules.yaml escalation.l2_to_l3）\n');
{
  const mk = (over: Partial<ReviewResult>): ReviewResult => ({
    candidate_id: 'x', decision: 'normal', mandatory_class: 'none', section: 'ai_tech',
    event_key: 'e', confidence: 0.9, filter_reason: null, conflicts: [], source_limitations: [],
    needs_higher_tier: false, higher_tier_reasons: [], ...over });
  const hr = ['量化', '临床', '加密'];
  ok('ESC-101 复核后仍存冲突',
     shouldPromoteToL3(inp('a'), mk({ conflicts: ['日期不一致'] }), hr).rules.includes('ESC-101'));
  ok('ESC-102 高风险 + 具体数字',
     shouldPromoteToL3(inp('a', { body: '量化策略年化 35%' }), mk({}), hr).rules.includes('ESC-102'));
  ok('高风险但无具体数字 → 不升 L3',
     !shouldPromoteToL3(inp('a', { body: '聊聊量化这个话题' }), mk({}), hr).promote);
  ok('ESC-103 模型自陈需更高层',
     shouldPromoteToL3(inp('a'), mk({ needs_higher_tier: true }), hr).rules.includes('ESC-103'));
  ok('无触发条件 → 不升级', !shouldPromoteToL3(inp('a'), mk({}), hr).promote);
}

console.log('\n人工正例过滤理由保护：\n');
{
  const bad = { decision: 'filter' as const, filter_reason: '纯个人主观讨论，无独立资讯价值',
    conclusion: null, summary_sentences: null };
  const l2 = fake((req) => reply(bad, idOf(req)));
  const l3 = fake((req) => reply(bad, idOf(req)));
  const r = await runReview([inp('v1')], deps(l2, l3,
    { invalidFilterReasonFragments: ['个人主观', '无独立资讯价值'] }));
  const l2o = r.outcomes.find(o => o.tier === 'L2')!;
  const l3o = r.outcomes.find(o => o.tier === 'L3')!;
  ok('L2 命中无效理由时强制升 L3', l2o.promote && l2o.promoteRules.includes('ESC-109'));
  ok('L3 仍只给无效理由时回退普通排序',
     l3o.result?.decision === 'normal' && l3o.result.filter_reason === null);
}

console.log('\n完整两级链路：\n');
{
  const l2seen: string[] = [], l3seen: string[] = [];
  const l2 = fake((req) => { const id = idOf(req); l2seen.push(id);
    return reply(id === 'v1' ? { conflicts: ['关键日期冲突'], needs_higher_tier: true } : {}, id); });
  const l3 = fake((req) => { const id = idOf(req); l3seen.push(id);
    return reply({ confidence: 0.97, conflicts: [] }, id); });
  const r = await runReview([inp('v1'), inp('v2')], deps(l2, l3));
  ok('两条都过 L2', l2seen.length === 2);
  ok('只有冲突那条上 L3', l3seen.length === 1 && l3seen[0] === 'v1');
  const l3o = r.outcomes.find(o => o.tier === 'L3')!;
  ok('L3 结果置信度更高', l3o.result?.confidence === 0.97);
  ok('L3 之后不再升级（PRD 15.1）', l3o.promote === false);
  ok('用量分层统计', r.l2Used.items === 2 && r.l3Used.items === 1,
     `L2=${r.l2Used.items} L3=${r.l3Used.items} in=${r.l2Used.input}/${r.l3Used.input}`);
}

console.log('\n失败续跑：\n');
{
  let l2calls = 0, l3calls = 0;
  const l2 = fake((req) => { l2calls++; return reply({}, idOf(req)); });
  const l3 = fake((req) => { l3calls++; return reply({}, idOf(req)); });
  const r = await runReview([inp('resume', {
    resumeTier: 'L3', priorDecision: 'normal', priorConfidence: 0.9,
    escalationRules: ['ESC-103'],
  })], deps(l2, l3));
  ok('已有 L2 结果时不重复调用 L2', l2calls === 0 && r.l2Used.items === 0);
  ok('直接续跑 L3 并产出结论', l3calls === 1 && r.outcomes[0]?.tier === 'L3' && !!r.outcomes[0]?.result);
}

console.log('\n失败路径：\n');
{
  const p = fake(() => reply({ decision: 'MAYBE' as any }));
  const r = await runReview([inp('v1')], deps(p, fake(() => reply())));
  ok('Schema 违规两次 → 转人工', r.outcomes[0]!.status === 'manual_audit' && r.outcomes[0]!.attempts === 2);
}
{
  // 模型把 candidate_id 写错 —— 串号必须被检出
  const p = fake(() => reply({}, 'WRONG-ID'));
  const r = await runReview([inp('v1')], deps(p, fake(() => reply())));
  ok('candidate_id 串号被检出', r.outcomes[0]!.status === 'manual_audit',
     r.outcomes[0]!.error?.slice(0, 44));
}
{
  const p = fake(() => new ProviderError('rate_limited', '429', 429));
  const r = await runReview([inp('v1')], deps(p, fake(() => reply())));
  ok('限流重试后仍失败 → 转人工', r.outcomes[0]!.status === 'manual_audit');
}
{
  // L3 名额耗尽：保留 L2 判定，不丢结果
  const l2 = fake((req) => reply({ needs_higher_tier: true }, idOf(req)));
  const l3 = fake((req) => reply({}, idOf(req)));
  const d = deps(l2, l3); d.l3.budget.maxItems = 1;
  const r = await runReview([inp('v1'), inp('v2'), inp('v3')], d);
  const l3ok = r.outcomes.filter(o => o.tier === 'L3' && o.status === 'ok').length;
  const l3skip = r.outcomes.filter(o => o.tier === 'L3' && o.status === 'skipped').length;
  ok('L3 只跑 1 条，其余标 skipped', l3ok === 1 && l3skip === 2);
  ok('L2 判定仍完整保留', r.outcomes.filter(o => o.tier === 'L2' && o.status === 'ok').length === 3);
}

console.log('\n名额不足的候选必须保持待复核状态（PRD 15.5）：\n');
{
  // 真实运行踩过的坑：给 skipped 项也写 evaluations，会让待复核查询
  // （NOT EXISTS terra/sol）把它们当成已复核，从此永远轮不到 —— 与
  // 「延迟到人工审阅」的意图相反，实为静默丢弃。
  const l2 = fake((req) => reply({}, idOf(req)));
  const d = deps(l2, fake(() => reply()));
  d.l2.budget.maxItems = 1;
  const r = await runReview([inp('a'), inp('b'), inp('c')], d);
  const skipped = r.outcomes.filter(o => o.status === 'skipped');
  ok('超额的标为 skipped 而非 manual_audit', skipped.length === 2);
  ok('skipped 项没有 result（未被复核过）', skipped.every(o => o.result === null));
  ok('skipped 项带明确原因', skipped.every(o => !!o.error && o.error.includes('名额')));
  ok('deferred 列出全部被推迟的候选',
     r.deferred.length === 2 && skipped.every(o => r.deferred.includes(o.candidateId)));
  ok('已复核的那条有完整结果', r.outcomes.filter(o => o.status === 'ok').length === 1);
}

console.log('\nSchema 形状：\n');
{
  const req = REVIEW_SCHEMA as any;
  ok('conflicts 与 source_limitations 为必填',
     req.required.includes('conflicts') && req.required.includes('source_limitations'));
  ok('严格模式要求所有属性列入 required',
     Object.keys(req.properties).every(k => req.required.includes(k)));
  ok('decision 不含 escalate（复核层必须给结论）',
     !req.properties.decision.enum.includes('escalate'));
  ok('conclusion 允许为 null（判 filter 时）',
     req.properties.conclusion.type.includes('null'));
}


console.log('\n并发复核（PRD 3 章 P95 < 12 分钟）：\n');
{
  // 单条 L2 实测约 58 秒。名额从 5 提到 24 后若仍顺序执行，
  // 运行时长会从 5 分钟涨到 23 分钟，超出 P95 要求。
  let inFlight = 0, peak = 0;
  const slow: Provider = {
    name: 'mock', model: 'fake', strictness: 'strict',
    async complete(req) {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return reply({}, idOf(req));
    },
  };
  const list = Array.from({ length: 9 }, (_, i) => inp(`v${i}`));
  const d = deps(slow, fake(() => reply()), { concurrency: 3 });
  d.l2.budget.maxItems = 9;
  const r = await runReview(list, d);
  ok('确实并发执行', peak > 1, `峰值在途 ${peak}`);
  ok('并发不超过设定路数', peak <= 3, `峰值在途 ${peak}`);
  ok('全部完成且无重复', r.l2Used.items === 9
     && new Set(r.outcomes.map(o => o.candidateId)).size === 9);
}
{
  // 并发下名额仍不得超发 —— 名额在派发前切片预留
  let calls = 0;
  const p = fake((req) => { calls++; return reply({}, idOf(req)); });
  const d = deps(p, fake(() => reply()), { concurrency: 4 });
  d.l2.budget.maxItems = 3;
  const r = await runReview(Array.from({ length: 12 }, (_, i) => inp(`v${i}`)), d);
  ok('名额不超发', calls === 3, `实际调用 ${calls} 次`);
  ok('超额的仍转人工而非丢弃', r.deferred.length === 9);
  ok('每条候选都有归宿', r.outcomes.length === 12);
}
{
  // token 兜底：并发下允许略微超出（最多 并发-1 条在途），但必须停下来
  let calls = 0;
  const p: Provider = {
    name: 'mock', model: 'fake', strictness: 'strict',
    async complete(req) { calls++; return reply({}, idOf(req)); },
  };
  const d = deps(p, fake(() => reply()), { concurrency: 3 });
  d.l2.budget.maxItems = 100;
  d.l2.budget.inputTokensMax = 9000;   // 每条约 2000+，撑不了 30 条
  const r = await runReview(Array.from({ length: 30 }, (_, i) => inp(`v${i}`)), d);
  ok('token 预算触发后停止派发', calls < 30, `实际调用 ${calls} 次`);
  ok('未派发的转人工而非静默丢弃', r.deferred.length === 30 - calls);
  ok('已派发的结果完整', r.outcomes.filter(o => o.status === 'ok').length === calls);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
