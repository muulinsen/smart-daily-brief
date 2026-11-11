import { pickHighlights, mergeSameKind } from '../packages/domain/src/highlights.ts';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${n}`); };
const S = ['ai_tech', 'dev_tools', 'community'];
const it = (section: string, score: number, conclusion: string) => ({ section, score, conclusion });

console.log('\n核心要点覆盖全部分区：\n');
{
  // 一个分区霸占全部高分 —— 纯按分数排序会让另两个分区完全消失
  const items = [
    it('ai_tech', 99, 'A 公司发布新模型'), it('ai_tech', 98, 'B 公司开源权重'),
    it('ai_tech', 97, 'C 实验室公布论文'), it('ai_tech', 96, 'D 团队更新推理框架'),
    it('dev_tools', 40, 'E 工具支持增量构建'),
    it('community', 30, 'F 站点调整发帖规则'),
  ];
  const h = pickHighlights(items, S, 4);
  ok('低分分区仍出现在要点里', h.some(x => x.includes('E 工具')) && h.some(x => x.includes('F 站点')));
  ok('不超过上限', h.length <= 4);
  ok('每个分区至少一条', S.every(id => h.some(x =>
    items.some(i => i.section === id && x.includes(i.conclusion)))));
}
{
  const h = pickHighlights([it('ai_tech', 90, 'X'), it('ai_tech', 80, 'Y')], S, 8);
  ok('只有一个分区时不报错且如实少于上限', h.length === 2);
  ok('内容不足时不凑数', h.length === 2);
}
{
  const items = [it('community', 10, '社区条目'), it('ai_tech', 90, 'AI 条目')];
  const h = pickHighlights(items, S, 8);
  ok('按分区固定顺序排列而非分数', h[0]!.includes('AI 条目'));
}

console.log('\n同类合并：\n');
{
  const merged = mergeSameKind([
    it('community', 50, 'PM 公益站清理零调用账号'),
    it('community', 45, 'PM 公益站缩减运维投入'),
    it('ai_tech', 40, '某公司发布新版本'),
  ]);
  ok('同分区同主体合并为一条', merged.length === 2);
  ok('合并后两段内容都在', merged[0]!.includes('清理零调用账号') && merged[0]!.includes('缩减运维投入'));
  ok('合并后主体不重复出现', merged[0]!.split('PM 公益站').length - 1 === 1);
  ok('不同分区不合并', merged[1]!.includes('某公司'));
}
{
  const merged = mergeSameKind([
    it('community', 50, 'A 站发布公告'), it('ai_tech', 45, 'A 站发布另一条公告'),
  ]);
  ok('主体相同但分区不同：不合并', merged.length === 2);
}
{
  const merged = mergeSameKind([
    it('ai_tech', 50, 'Anthropic 发布新模型'), it('ai_tech', 45, 'OpenAI 发布新模型'),
  ]);
  ok('主体不同不误合并', merged.length === 2);
}
{
  // 公共前缀切断拉丁词：Open 不是主体
  const merged = mergeSameKind([
    it('ai_tech', 50, 'OpenAI 调整定价'), it('ai_tech', 45, 'OpenCode 调整定价'),
  ]);
  ok('公共前缀切断拉丁词时不合并', merged.length === 2);
}
{
  const merged = mergeSameKind([
    it('ai_tech', 50, '某公司发布 A'), it('ai_tech', 45, '某公司发布 B'), it('ai_tech', 40, '某公司发布 C'),
  ]);
  ok('三条同主体全部合并为一条', merged.length === 1);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
