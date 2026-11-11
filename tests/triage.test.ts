// L1 编排器（PRD 15.2 / 15.4 / 15.5 / FR-044）
import { runTriage, decideEscalation, buildPayload, type Candidate, type TriageDeps }
  from '../packages/ai/src/triage.ts';
import type { Provider, CompleteRequest, CompleteResult } from '../packages/ai/src/types.ts';
import { ProviderError } from '../packages/ai/src/types.ts';
import type { TriageResult } from '../packages/ai/src/schema.ts';
import { loadRules } from '../packages/domain/src/rules.ts';

let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  candidateId: id, sourceId: 'linuxdo', sourceKind: 'forum', title: '标题 ' + id,
  publishedAt: '2026-08-23T00:00:00Z', url: 'https://linux.do/t/topic/' + id,
  body: '正文内容'.repeat(50), signals: ['external_link'], repos: [], officialLinks: [],
  prescreenClasses: [], contentHash: 'h-' + id, ...over,
});

/** 可编程的假供应商：按回调决定每次返回什么。 */
function fakeProvider(fn: (req: CompleteRequest, call: number) => CompleteResult | Error): Provider {
  let call = 0;
  return {
    name: 'mock', model: 'fake', strictness: 'strict',
    async complete(req) {
      const r = fn(req, ++call);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const respond = (results: Partial<TriageResult>[], inTok = 500, outTok = 100): CompleteResult => ({
  data: { results: results.map(r => ({
    candidate_id: '', decision: 'normal', mandatory_class: 'none', section: 'ai_tech',
    event_key: 'e', confidence: 0.9, importance: 0.5, novelty: 0.5,
    filter_reason: null, escalation_reasons: [], ...r })) },
  usage: { inputTokens: inTok, outputTokens: outTok, cachedInputTokens: 0, cacheWriteTokens: 0 },
  responseId: 'r1', model: 'fake',
});

const baseDeps = (provider: Provider, over: Partial<TriageDeps> = {}): TriageDeps => ({
  provider, systemPrompt: '系统规则'.repeat(20),
  budget: { inputTokensMax: 50000, outputTokensMax: 8000, batchSize: 3, bodyCharsMax: 4000 },
  highRiskKeywords: ['量化', '临床'], majorNewsTypes: ['监管处罚'], ...over,
});

console.log('输入最小化（PRD 15.2）：\n');
{
  const c = cand('v1', { body: 'x'.repeat(20000), repos: Array(9).fill('https://github.com/a/b') });
  const p = buildPayload(c, 4000);
  ok('正文截到上限', p.body.length === 4000);
  ok('仓库链接截到 5 条', p.extracted.repos.length === 5);
  const keys = Object.keys(p);
  ok('payload 不含 16 源清单等冗余', !JSON.stringify(p).includes('sources.yaml'), keys.join(','));
}

console.log('\n分批与用量累计：\n');
{
  const seen: number[] = [];
  const p = fakeProvider((req) => {
    const n = JSON.parse(req.userContent).candidates.length;
    seen.push(n);
    return respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id })));
  });
  const r = await runTriage([1,2,3,4,5,6,7].map(i => cand('v' + i)), baseDeps(p));
  ok('按 batchSize=3 分批', JSON.stringify(seen) === '[3,3,1]', seen.join('+'));
  ok('7 条全部有结果', r.outcomes.filter(o => o.status === 'ok').length === 7);
  ok('用量累计', r.usedInputTokens === 1500 && r.calls === 3,
     `in=${r.usedInputTokens} calls=${r.calls}`);
}

console.log('\n指纹复用（PRD 15.2 reuse_by_content_hash）：\n');
{
  let calls = 0;
  const p = fakeProvider((req) => { calls++;
    return respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id }))); });
  const cache = new Map<string, TriageResult>([['h-v1', {
    candidate_id: 'old', decision: 'retain', mandatory_class: 'A', section: 'ai_tech',
    event_key: 'cached-evt', confidence: 0.95, importance: 0.5, novelty: 0.5,
    filter_reason: null, escalation_reasons: [] }]]);
  const r = await runTriage([cand('v1'), cand('v2')], baseDeps(p, { cachedByHash: cache }));
  const reused = r.outcomes.find(o => o.candidateId === 'v1')!;
  ok('相同指纹直接复用，不调模型', reused.status === 'reused' && reused.result?.event_key === 'cached-evt');
  ok('复用结果的 candidate_id 已改写为当前条目', reused.result?.candidate_id === 'v1');
  ok('只为未命中的候选发起调用', calls === 1);
}

console.log('\nESC-005：强制保留项被模型判为过滤（防漏项最后一道闸）\n');
{
  const p = fakeProvider((req) =>
    respond(JSON.parse(req.userContent).candidates.map((c: any) =>
      ({ candidate_id: c.candidate_id, decision: 'filter', filter_reason: '像广告' }))));
  const r = await runTriage([cand('v1', { prescreenClasses: ['A'] }), cand('v2')], baseDeps(p));
  const a = r.outcomes.find(o => o.candidateId === 'v1')!;
  const b = r.outcomes.find(o => o.candidateId === 'v2')!;
  ok('强制保留候选被判过滤 → 触发升级', a.escalate && a.escalationRules.includes('ESC-005'));
  ok('普通候选被判过滤 → 不升级', !b.escalate, b.escalationRules.join(','));
}

console.log('\n其余升级规则：\n');
{
  const deps = baseDeps(fakeProvider(() => respond([])));
  const mk = (r: Partial<TriageResult>) => ({
    candidate_id: 'x', decision: 'normal', mandatory_class: 'none', section: 'ai_tech',
    event_key: 'e', confidence: 0.9, importance: 0.5, novelty: 0.5,
    filter_reason: null, escalation_reasons: [], ...r } as TriageResult);
  ok('ESC-001 低置信', decideEscalation(cand('a'), mk({ confidence: 0.6 }), deps).rules.includes('ESC-001'));
  ok('ESC-002 高风险领域', decideEscalation(cand('a', { body: '这是量化策略回测' }), mk({}), deps).rules.includes('ESC-002'));
  ok('ESC-003 重大新闻', decideEscalation(cand('a', { body: '遭监管处罚' }), mk({}), deps).rules.includes('ESC-003'));
  ok('ESC-006 Elsewhere 长文',
     decideEscalation(cand('a', { sourceId: 'elsewhere', body: 'x'.repeat(7000) }), mk({}), deps).rules.includes('ESC-006'));
  ok('模型自陈需复核', decideEscalation(cand('a'), mk({ escalation_reasons: ['两源冲突'] }), deps).rules.includes('ESC-MODEL'));
  ok('人工正例否定的过滤理由触发 ESC-009',
     decideEscalation(cand('a'), mk({ decision: 'filter', filter_reason: '纯个人主观讨论，无独立资讯价值' }),
       { ...deps, invalidFilterReasonFragments: ['个人主观', '无独立资讯价值'] }).rules.includes('ESC-009'));
  const guarded = loadRules().ai_filter_guard.invalid_reason_fragments as string[];
  for (const reason of ['仅为活动预告', '仅为传闻', '销量榜单', '仅为快讯', '日常资讯汇总',
                        '正文仅为一句话', '低信息密度', '缺乏任何实质性事实细节'])
    ok(`新增正例理由“${reason}”触发 ESC-009`,
       decideEscalation(cand('a'), mk({ decision: 'filter', filter_reason: reason }),
         { ...deps, invalidFilterReasonFragments: guarded }).rules.includes('ESC-009'));
  ok('正常候选不升级', decideEscalation(cand('a'), mk({}), deps).rules.length === 0);
}

console.log('\nFR-044 失败重试与人工审计：\n');
{
  // 第 1 次 Schema 违规，第 2 次（缩短正文）成功
  const p = fakeProvider((req, call) => call === 1
    ? respond([{ candidate_id: 'v1', decision: 'MAYBE' as any }])
    : respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id }))));
  const r = await runTriage([cand('v1')], baseDeps(p));
  ok('缩短正文重试一次后成功', r.outcomes[0]!.status === 'ok' && r.outcomes[0]!.attempts === 2);
}
{
  const p = fakeProvider(() => respond([{ candidate_id: 'v1', decision: 'MAYBE' as any }]));
  const r = await runTriage([cand('v1')], baseDeps(p));
  const o = r.outcomes[0]!;
  ok('两次都失败 → 转人工，不静默丢弃', o.status === 'manual_audit' && o.result === null);
  ok('人工审计项标记为需升级', o.escalate && o.escalationRules.includes('SCHEMA-FAIL'));
  ok('保留失败原因供诊断', !!o.error, o.error?.slice(0, 46));
}
{
  // 模型漏判：只回了 2 条中的 1 条
  const p = fakeProvider((req) => respond([{ candidate_id: 'v1' }]));
  const r = await runTriage([cand('v1'), cand('v2')], baseDeps(p));
  ok('模型漏判被检出并转人工', r.outcomes.every(o => o.status === 'manual_audit'),
     r.outcomes[0]?.error?.slice(0, 40));
}
{
  const p = fakeProvider(() => new ProviderError('auth', '无效 key', 401));
  const r = await runTriage([cand('v1')], baseDeps(p));
  ok('鉴权失败不重试，直接转人工', r.outcomes[0]!.status === 'manual_audit' && r.outcomes[0]!.attempts === 1);
}

console.log('\n输出截断的重试策略：\n');
{
  // 截断时缩短输入几乎不减少输出 —— 必须提高输出上限，否则重试是白试。
  // 真实运行里这个问题连续出现三次（triage/compose 各一次）。
  const caps: number[] = [];
  const bodies: number[] = [];
  const p = fakeProvider((req, call) => {
    caps.push(req.maxOutputTokens);
    bodies.push(JSON.parse(req.userContent).candidates[0].body.length);
    if (call === 1) return new ProviderError('truncated', '输出被 max_tokens 截断（已生成 2080 token）');
    return respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id })));
  });
  const r = await runTriage([cand('v1', { body: 'x'.repeat(9000) })], baseDeps(p));
  ok('截断后重试成功', r.outcomes[0]!.status === 'ok' && r.outcomes[0]!.attempts === 2);
  ok('第二次提高了输出上限', caps[1]! > caps[0]!, `${caps[0]} → ${caps[1]}`);
  ok('第二次未缩短正文（缩短无助于减少输出）', bodies[1] === bodies[0],
     `${bodies[0]} → ${bodies[1]}`);
}
{
  // 对照：Schema 违规时仍应缩短正文重试（FR-044 原策略）
  const bodies: number[] = [];
  const p = fakeProvider((req, call) => {
    bodies.push(JSON.parse(req.userContent).candidates[0].body.length);
    if (call === 1) return respond([{ candidate_id: 'v1', decision: 'MAYBE' as any }]);
    return respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id })));
  });
  // 正文必须长于 bodyCharsMax，否则两次截断后长度相同、看不出差别
  await runTriage([cand('v1', { body: 'x'.repeat(9000) })], baseDeps(p));
  ok('Schema 违规时仍缩短正文重试', bodies[1]! < bodies[0]!, `${bodies[0]} → ${bodies[1]}`);
}

console.log('\n预算熔断（PRD 15.5）：\n');
{
  const p = fakeProvider((req) =>
    respond(JSON.parse(req.userContent).candidates.map((c: any) => ({ candidate_id: c.candidate_id })), 4000, 500));
  const deps = baseDeps(p, { budget: { inputTokensMax: 9000, outputTokensMax: 8000, batchSize: 2, bodyCharsMax: 4000 } });
  const r = await runTriage([1,2,3,4,5,6,7,8].map(i => cand('v' + i)), deps);
  ok('超输入预算后停止新调用', r.budgetStopped);
  ok('已完成的结果保留', r.outcomes.filter(o => o.status === 'ok').length > 0,
     `ok=${r.outcomes.filter(o => o.status === 'ok').length}`);
  ok('未处理的标为 skipped 转人工，不静默丢弃',
     r.skippedForBudget > 0 && r.outcomes.filter(o => o.status === 'skipped').every(o => !!o.error),
     `skipped=${r.skippedForBudget}`);
  ok('每条候选都有归宿', r.outcomes.length === 8);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
