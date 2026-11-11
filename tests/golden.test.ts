// 黄金集评估与发布闸门（PRD 15.7 / 23.3 / 24.1）
import { evaluate, checkGate, confirmedOnly, formatReport,
         type GoldenSample, type Predicted } from '../packages/domain/src/golden.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const g = (id: string, o: Partial<GoldenSample['expected']> = {}, extra: Partial<GoldenSample> = {}): GoldenSample => ({
  id, source: 'linuxdo', title: 't'+id, body: 'b',
  expected: { decision: 'normal', mandatoryClass: 'none', ...o },
  labelSource: 'human_confirmed', ...extra });
const p = (id: string, o: Partial<Predicted> = {}): Predicted =>
  ({ id, decision: 'normal', mandatoryClass: 'none', ...o });

console.log('强制保留召回（PRD 24.1 硬指标）：\n');
{
  const samples = [
    g('a', { decision:'retain', mandatoryClass:'A' }),
    g('b', { decision:'retain', mandatoryClass:'B' }),
    g('c', { decision:'retain', mandatoryClass:'C' }),
    g('d', { decision:'normal' }),
  ];
  const all = evaluate(samples, [
    p('a', { decision:'retain', mandatoryClass:'A' }),
    p('b', { decision:'retain', mandatoryClass:'B' }),
    p('c', { decision:'retain', mandatoryClass:'C' }),
    p('d'),
  ]);
  ok('全部召回 → 100%', all.mandatoryRecall === 1);
  ok('闸门通过', checkGate(all).pass);

  const missed = evaluate(samples, [
    p('a', { decision:'filter' }),   // 漏掉一个
    p('b', { decision:'retain', mandatoryClass:'B' }),
    p('c', { decision:'retain', mandatoryClass:'C' }),
    p('d'),
  ]);
  ok('漏 1/3 → 召回 66.7%', Math.abs(missed.mandatoryRecall - 2/3) < 1e-9);
  const gate = checkGate(missed);
  ok('召回不足 → 闸门阻断', !gate.pass && gate.failures.some(f => f.includes('召回率')));
  ok('报告指出漏掉的具体条目', missed.mandatoryRecallDetail.missed[0]?.includes('a'));
}
{
  // escalate 不算漏 —— 它会进人工复核
  const s = [g('a', { decision:'retain', mandatoryClass:'A' })];
  ok('判为 escalate 不计为漏项',
     evaluate(s, [p('a', { decision:'escalate' })]).mandatoryRecall === 1);
}
{
  // 摘要样本不参与召回统计
  const s = [g('a', { decision:'retain', mandatoryClass:'A' }, { bodyIsExcerpt: true })];
  const m = evaluate(s, [p('a', { decision:'filter' })]);
  ok('摘要样本被排除在召回统计外', m.mandatoryRecallDetail.expected === 0);
  ok('无强制保留样本时给出覆盖度警告，而非判为通过',
     checkGate(m).warnings.some(w => w.includes('覆盖度缺口')));
}

console.log('\n错误过滤率：\n');
{
  const s = [g('a'), g('b'), g('c', { decision:'filter', filterRuleId:'DF-020' })];
  const m = evaluate(s, [p('a',{decision:'filter'}), p('b'), p('c',{decision:'filter'})]);
  ok('本该收录却被过滤 → 计入错误过滤', m.wrongFilterRate === 0.5 && m.wrongFiltered[0] === 'a');
  ok('应过滤的被过滤不计入', !m.wrongFiltered.includes('c'));
  ok('超阈值阻断发布', !checkGate(m).pass);
}

console.log('\n事件聚类准确率（PRD 7.4「同关键词不等于重复」）：\n');
{
  const s = [g('a', { sameEventAs:['b'] }), g('b'), g('c')];
  const good = evaluate(s, [p('a',{eventKey:'e1'}), p('b',{eventKey:'e1'}), p('c',{eventKey:'e2'})]);
  ok('同事件同 key、异事件异 key → 100%', good.clusterAccuracy === 1);

  const merged = evaluate(s, [p('a',{eventKey:'e1'}), p('b',{eventKey:'e1'}), p('c',{eventKey:'e1'})]);
  ok('误聚类被检出', merged.clusterAccuracy < 1 && merged.clusterErrors.some(e => e.includes('误聚类')));

  const split = evaluate(s, [p('a',{eventKey:'e1'}), p('b',{eventKey:'e2'}), p('c',{eventKey:'e3'})]);
  ok('漏聚类被检出', split.clusterErrors.some(e => e.includes('漏聚类')));
}

console.log('\n摘要事实一致性：\n');
{
  const s = [g('a', { mustMention:['30%','2026-08-21'] })];
  ok('全部提及 → 100%',
     evaluate(s, [p('a',{summary:'增长 30%，于 2026-08-21 发布。'})]).factConsistency === 1);
  const m = evaluate(s, [p('a',{summary:'有所增长。'})]);
  ok('缺失事实被检出', m.factConsistency === 0 && m.factMisses.length === 2);
  ok('事实一致性不足阻断发布', !checkGate(m).pass);
}

console.log('\n与基线对比（PRD 23.3：召回下降即阻断）：\n');
{
  const s = [g('a',{decision:'retain',mandatoryClass:'A'}), g('b',{decision:'retain',mandatoryClass:'A'})];
  const base = evaluate(s, [p('a',{decision:'retain',mandatoryClass:'A'}), p('b',{decision:'retain',mandatoryClass:'A'})]);
  const worse = evaluate(s, [p('a',{decision:'retain',mandatoryClass:'A'}), p('b',{decision:'filter'})]);
  const gate = checkGate(worse, { mandatoryRecall:0.4, wrongFilterRate:1, clusterAccuracy:0, factConsistency:0 }, base);
  ok('即使绝对阈值放宽，较基线下降仍阻断',
     !gate.pass && gate.failures.some(f => f.includes('较基线下降')));
}

console.log('\n只有人工确认的样本计入回归：\n');
{
  const mixed = [g('a'), g('b', {}, { labelSource:'machine_proposed' })];
  ok('机器预标注被排除', confirmedOnly(mixed).length === 1 && confirmedOnly(mixed)[0]!.id === 'a');
}

console.log('\n报告可读性：\n');
{
  const s = [g('a',{decision:'retain',mandatoryClass:'A'})];
  const m = evaluate(s, [p('a',{decision:'filter'})]);
  const r = formatReport(m, checkGate(m));
  ok('报告含各项指标与阻断结论',
     r.includes('强制保留召回率') && r.includes('事实一致性') && r.includes('阻断发布'));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
