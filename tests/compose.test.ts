// compose 第二段（PRD 9.2）
import { runCompose, checkComposed, stripFiller, type ComposeInput, type ComposeDeps }
  from '../packages/ai/src/compose.ts';
import type { Provider, CompleteRequest, CompleteResult } from '../packages/ai/src/types.ts';
import type { ComposeResult } from '../packages/ai/src/schema.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const inp = (id: string, o: Partial<ComposeInput> = {}): ComposeInput => ({
  candidateId: id, sourceName: 'LINUX DO', sourceUrl: 'https://x/'+id,
  title: '标题 '+id, body: '正文'.repeat(60), section: 'ai_tech', mandatoryClass: 'none',
  contributions: [], sourceLimitations: [], precomposed: null, ...o });

const res = (items: any[], over: Partial<ComposeResult> = {}): CompleteResult => ({
  data: { results: items.map((it: any) => ({
    candidate_id: it.candidate_id, title: '干净标题',
    conclusion: '这条说明了一个具体变化。',
    summary_sentences: ['第一句。', '第二句。'],
    source_limitations: it.must_disclose ?? [], ...over })) },
  usage: { inputTokens: 600, outputTokens: 200, cachedInputTokens: 0, cacheWriteTokens: 0 },
  responseId: 'r', model: 'fake',
});
function fake(fn: (req: CompleteRequest, n: number) => CompleteResult | Error): Provider {
  let n = 0;
  return { name:'mock', model:'fake', strictness:'strict',
    async complete(req){ const r = fn(req, ++n); if (r instanceof Error) throw r; return r; } };
}
const itemsOf = (req: CompleteRequest) => JSON.parse(req.userContent).items;
const deps = (p: Provider, o: Partial<ComposeDeps> = {}): ComposeDeps => ({
  provider: p, systemPrompt: '文案规则'.repeat(10), batchSize: 4, bodyCharsMax: 4000,
  outputTokensMax: 3000,
  forbiddenFields: ['标签','信息性质标签','建议','关注建议','行动建议'], ...o });

console.log('复用 L2/L3 已产出的文案：\n');
{
  let calls = 0;
  const p = fake((req) => { calls++; return res(itemsOf(req)); });
  const r = await runCompose([
    inp('a', { precomposed: { title: '缓存中的完整标题', conclusion: '复核层写好的结论', summarySentences: ['甲。','乙。'] } }),
    inp('b'),
  ], deps(p));
  const reused = r.outcomes.find(o => o.candidateId === 'a')!;
  ok('已有文案的直接复用', reused.status === 'reused' && reused.result?.conclusion === '复核层写好的结论');
  ok('复用文案时保留缓存标题', reused.result?.title === '缓存中的完整标题', reused.result?.title);
  ok('只为缺文案的调模型', calls === 1);
}

console.log('\nPRD 9.2 字段禁令：\n');
{
  const bad: ComposeResult = { candidate_id:'x', title:'t',
    conclusion:'行动建议：立即去申请。', summary_sentences:['建议：马上注册。','关注建议：留意后续。'],
    source_limitations: [] };
  const errs = checkComposed(bad, ['建议','关注建议','行动建议']);
  ok('「行动建议：」被拦下', errs.some(e => e.includes('行动建议')), errs.join('; '));
  ok('「关注建议：」被拦下', errs.some(e => e.includes('关注建议')));
}
{
  // 正文里自然出现「建议」二字不应误杀
  const fine: ComposeResult = { candidate_id:'x', title:'t',
    conclusion:'作者建议在生产环境先灰度。', summary_sentences:['第一句。','第二句。'],
    source_limitations: [] };
  ok('正文中自然出现的「建议」不误杀', checkComposed(fine, ['建议','行动建议']).length === 0);
}
{
  const p = fake(() => res([{candidate_id:'a'}], {
    conclusion:'行动建议：快去。', summary_sentences:['建议：注册。','关注建议：跟进。'] }));
  const r = await runCompose([inp('a')], deps(p));
  ok('生成阶段出现禁用字段 → 重试后转人工',
     r.outcomes[0]!.status === 'manual_audit' && r.outcomes[0]!.attempts === 2,
     r.outcomes[0]!.error?.slice(0, 40));
}

console.log('\n剥离空指代与元评论（来自人工反馈）：\n');
{
  const cut = (a: string, b: string) => ok(`「${a.slice(0, 16)}…」`, stripFiller(a) === b, stripFiller(a));
  cut('这是一篇关于 Qwen3.8 本地部署的完整教程，内容为技术分享，无推广或高风险信息。',
      'Qwen3.8 本地部署的完整教程。');
  cut('该项目提供了一款支持多平台的开源视频下载工具。', '一款支持多平台的开源视频下载工具。');
  cut('该文是作者对 Harness 分层实践的思考与总结。', '作者对 Harness 分层实践的思考与总结。');
  // 不得误伤：描述对象的「一篇…长文」与正常陈述
  const keep = (t: string) => ok(`不误伤「${t.slice(0, 18)}…」`, stripFiller(t) === t);
  keep('一篇 Harness 实践长文把 Shell、Sandbox、Skill 串成了可复用架构。');
  keep('GitHub 为 Dependabot 的非安全更新默认增加 3 天冷静期，安全更新仍即时发送。');
  keep('腾讯云面向新用户推出 38 元一年的 4 核 4G 服务器。');
  ok('剥过头则退回原文', stripFiller('该项目很好。') === '该项目很好。', stripFiller('该项目很好。'));
}

console.log('\n结构约束：\n');
{
  ok('摘要少于 2 句被拦',
     checkComposed({candidate_id:'x',title:'t',conclusion:'c',summary_sentences:['一句'],source_limitations:[]}).length > 0);
  ok('conclusion 超 120 字被拦',
     checkComposed({candidate_id:'x',title:'t',conclusion:'字'.repeat(121),summary_sentences:['a','b'],source_limitations:[]})
       .some(e => e.includes('120')));
  ok('conclusion 为空被拦',
     checkComposed({candidate_id:'x',title:'t',conclusion:'  ',summary_sentences:['a','b'],source_limitations:[]}).length > 0);
}

console.log('\n来源限制必须传给模型：\n');
{
  let seen: any = null;
  const p = fake((req) => { seen = itemsOf(req)[0]; return res(itemsOf(req)); });
  await runCompose([inp('a', { sourceLimitations: ['尚未独立核实'], contributions: [{sourceName:'即刻',url:null}] })], deps(p));
  ok('must_disclose 已进入 payload', seen.must_disclose?.[0] === '尚未独立核实');
  ok('其他来源渠道已进入 payload', seen.other_sources?.[0] === '即刻');
}

console.log('\n漏写检测：\n');
{
  const p = fake((req) => res([itemsOf(req)[0]]));   // 只回 2 条中的 1 条
  const r = await runCompose([inp('a'), inp('b')], deps(p));
  ok('模型漏写文案被检出并转人工',
     r.outcomes.every(o => o.status === 'manual_audit'), r.outcomes[0]!.error?.slice(0, 30));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
