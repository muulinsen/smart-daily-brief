// 高风险领域匹配（PRD 8.5）—— 重点是中文短词的误伤
import { guardedHit, matchHighRisk, isHighRisk } from '../packages/domain/src/risk.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('实测误伤案例（来自 2026-08-22 真实运行）：\n');
{
  const cases: Array<[string, string, boolean]> = [
    ['爬宠温控箱：小程序轻量化控制上有差异化', '量化', false],
    ['Telegram 代理：WebSocket 封装转发加密的 MTProxy 流量', '加密', false],
    ['香港有没有几十港币通宵的网吧', '币', false],
    ['deepseek-V4-Flash-Vision-Exp 目前只是试验品阶段', '试验', false],
    ['具身数据报告讨论数据合规，由无限基金 SEE Fund 联合发布', '合规/基金', false],
    ['绿洲资本是天使轮独家投资方及最大机构股东', '投资', true],
  ];
  for (const [text, , expect] of cases) {
    const got = isHighRisk(text);
    ok(`${expect ? '应' : '不应'}判为高风险：${text.slice(0, 26)}…`, got === expect,
       got ? matchHighRisk(text).flatMap(h => h.terms).join(' ') : '');
  }
}

console.log('\n真高风险仍必须命中：\n');
{
  for (const t of [
    '该量化策略年化收益率 35%，回测区间三年',
    '加密货币交易所遭监管处罚',
    '临床试验三期数据显示疗效显著',
    '公司完成 B 轮融资，估值超十亿',
    '本次判决涉及反垄断合规问题',
    '该基金持仓股票市值大幅波动',
  ]) ok(t.slice(0, 22) + '…', isHighRisk(t), matchHighRisk(t).flatMap(h => h.terms).join(' '));
}

console.log('\nguardedHit 边界行为：\n');
{
  const g = { term: '币', exclude_before: ['港', '美'], exclude_after: ['种'] };
  ok('前置排除字命中时不算', !guardedHit('花了三十港币', g));
  ok('后置排除字命中时不算', !guardedHit('这个币种很稀有', g));
  ok('普通出现算命中', guardedHit('该币近期大涨', g));
  ok('同一文本中一处被排除、另一处正常 → 算命中',
     guardedHit('花了三十港币；另外该币近期大涨', g));
  ok('完全不出现 → 不命中', !guardedHit('今天天气不错', g));
  const g2 = { term: '量化', exclude_before: ['轻'], exclude_after: ['控制', '模型'] };
  ok('多字后置排除词生效', !guardedHit('推理时做量化模型压缩', g2));
  ok('前置单字排除生效', !guardedHit('小程序轻量化控制', g2));
  ok('未命中排除词时正常触发', guardedHit('这套量化系统年化 20%', g2));
}

console.log('\n领域归属：\n');
{
  const h = matchHighRisk('临床试验数据与融资估值同时出现');
  ok('可同时命中多个领域', h.length === 2, h.map(x => x.domainId).join(' '));
  ok('每个领域带免责说明', h.every(x => !!x.disclosure));
  ok('不涉及高风险时返回空', matchHighRisk('今天写了点代码').length === 0);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
