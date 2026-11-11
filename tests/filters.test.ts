// 确定性过滤回归（PRD 8.3 / 23.1）
import { applyDeterministicFilters, assertReasonAllowed } from '../packages/domain/src/filters.ts';
import type { SignalMap } from '../packages/domain/src/signals.ts';

const S = (o: Partial<SignalMap> = {}): SignalMap => ({
  repo_url: false, demo_link: false, official_link: false, external_link: false,
  code_block: false, command_line: false, config_block: false, install_hint: false,
  policy_mention: false, price_mention: false, invite_code: false, step_markers: false,
  aff_link: false, ...o,
});
const base = {
  title: '标题', cleanText: 'x'.repeat(500), signals: S(), externalLinkCount: 2,
  isMandatory: false, alreadySentNoUpdate: false, duplicateCanonical: false,
};
let fail = 0;
const check = (name: string, ctx: any, expect: string | null) => {
  const r = applyDeterministicFilters({ ...base, ...ctx });
  const got = r?.ruleId ?? null;
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(40)} → ${got ?? '不过滤'}${ok ? '' : `  期望 ${expect ?? '不过滤'}`}`);
};

console.log('确定性过滤：\n');
check('正常内容不被过滤', {}, null);
check('空标题', { title: '' }, 'DF-002');
check('空正文', { cleanText: '短' }, 'DF-002');
check('正文抓取失败但标题信息完整 → 不硬过滤',
  { title: '突然多了 50w，这笔钱单纯理财可以用来干什么', cleanText: 'HiFiwu:' }, null);
check('已发送且无更新', { alreadySentNoUpdate: true }, 'DF-001');
check('追踪参数重复', { duplicateCanonical: true }, 'DF-003');
check('密钥泄露', { cleanText: '这是我的 key sk-abcdefghijklmnopqrstuvwx1234' }, 'DF-021');
check('AFF 拉新无内容', { signals: S({ aff_link: true }) }, 'DF-010');
check('仅优惠码', { signals: S({ invite_code: true }), cleanText: '邀请码 ABCD1234' }, 'DF-011');
check('正文恰 10 字 → 不触发 DF-002', { cleanText: '一二三四五六七八九十', externalLinkCount: 3, signals: S({ external_link: true }) }, null);
check('低信息量闲聊', { cleanText: '哈哈哈这个真的好好玩啊，笑死我了，各位怎么看', externalLinkCount: 0 }, 'DF-020');
check('短支付实测不是灌水', { title: 'Claude 用银行卡订阅全部拒付', cleanText: '招行 Visa、葵花 Master、工商 Master 全部拒付', externalLinkCount: 0 }, null);
check('短反诈讨论不是灌水', { title: '开梯子会收到反诈中心电话吗', cleanText: '今天接到电话询问网络工具使用情况，想确认是否为普遍现象', externalLinkCount: 0 }, null);

console.log('\n无障碍辅助项目（DF-048，2026-09-07 人工反馈）：\n');
check('Cboard 辅助沟通项目即使命中 A 类仍过滤', {
  title: '开源辅助沟通 Web 应用 Cboard 借助符号与语音合成协助语言障碍群体',
  cleanText: 'Cboard 是一款开源 AAC 应用，项目仓库提供源码与安装方法。',
  signals: S({ repo_url: true }), isMandatory: true,
}, 'DF-048');
check('英文无障碍辅助软件过滤', {
  title: 'Open-source assistive technology app for visually impaired users',
  cleanText: 'The GitHub repository includes a screen reader and speech synthesis.',
  signals: S({ repo_url: true }), isMandatory: true,
}, 'DF-048');
check('目标群体只在正文中说明的开源项目仍过滤', {
  title: 'Cboard 开源 Web 应用发布',
  cleanText: '该项目使用符号与语音合成帮助语言障碍群体沟通。',
  signals: S({ repo_url: true }), isMandatory: true,
}, 'DF-048');
check('一般无障碍设施新闻不误伤', {
  title: '车站完成无障碍电梯维修', cleanText: '车站宣布无障碍电梯已经恢复运行。',
}, null);
check('技术文章偶然提及无障碍电梯不误伤', {
  title: 'DeepSeek 视觉推理测试', cleanText: '模型凭空建议优先走无障碍电梯，暴露空间推理问题。',
}, null);

const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

console.log('\n公益站/中转站运营与争议（DF-040 / DF-041，来自人工反馈）：\n');
{
  // 用户明确指出这三类应过滤，且给了边界：第三方转售站的自设规则
  // 不是 PRD 8.2 C 类保护的「官方权益」。
  const fire = (text: string) => {
    const r = applyDeterministicFilters({ ...base, cleanText: text, title: text });
    return r?.ruleId ?? null;
  };
  ok('公益站内测招募 → DF-040',
     fire('【首家视频公益站】Seedance 图生视频公益站 主贴 第二波内测开放限时测试') === 'DF-040');
  // 规则要求同时出现「站点类关键词」与「运营动作词」—— 缺任一都不触发，
  // 这是刻意的：只说「计价调整」的正常价格新闻不该被误伤。
  ok('中转站计价调整通知 → DF-040',
     fire('【RelayFor】中转站通知一览：上游计价调整与错误补偿方案') === 'DF-040');
  ok('长文正文举例提到中转站/开放但标题无运营属性 → 不触发',
     applyDeterministicFilters({ ...base, title: '开源模型就是统一战线',
       cleanText: '文章讨论开源模型格局，并举例中转站开放 API 的合成数据' }) === null);
  ok('只有计价调整、无站点词 → 不触发',
     fire('OpenAI 宣布上游计价调整与错误补偿方案') === null);
  ok('站点争议爆料 → DF-040/041',
     ['DF-040', 'DF-041'].includes(fire('【恶臭曝光】KRILL 中转站客服滥用权限全群开盒订单隐私') ?? ''));
  ok('司法纠纷解释新闻不被站点争议规则误伤',
     applyDeterministicFilters({ ...base,
       title: '最高法发布 AI 纠纷司法解释，明确换脸与算法杀熟责任',
       cleanText: '最高人民法院发布人工智能纠纷案件司法解释。媒体称该站已转载全文。',
     })?.ruleId !== 'DF-041');

  // 不得误伤：真实技术内容、官方政策、正常付费教程
  for (const t of [
    'Qwen3.8 27B 单16G显存显卡本地测试与部署教程，含 128K 上下文配置',
    'Tibo 明确发帖称 Codex 订阅不支持通过 sub2api 转换并转售',
    'claude 用 google pay 订阅 pro，招行 visa 全币种实测可行',
    'cursor 生成邮件的 JS 脚本，完全根据 QQ 邮箱来改，附完整代码',
  ]) ok(`不误伤：${t.slice(0, 22)}…`, fire(t) === null, fire(t) ?? '');

  // 有服务商官方链接时不适用 DF-040 —— 那可能是真的官方权益变更
  const withOfficial = applyDeterministicFilters({
    ...base, title: '某中转站公告：上游计价调整',
    cleanText: '某中转站公告：上游计价调整，详见 https://openai.com/pricing',
    signals: S({ official_link: true }) });
  ok('带官方链接的计价公告不被 DF-040 过滤', withOfficial?.ruleId !== 'DF-040', withOfficial?.ruleId ?? '不过滤');
}

console.log('\n政治观点 / 娱乐八卦 / 账号买卖（DF-042~044，来自人工反馈）：\n');
{
  const fire = (text: string, sig: Partial<SignalMap> = {}) =>
    applyDeterministicFilters({ ...base, cleanText: text, title: text, signals: S(sig) })?.ruleId ?? null;

  ok('转发的意识形态论断 → DF-042',
     fire('RT Brett Pike: The Bolsheviks committed mass murder and pure horror') === 'DF-042');
  ok('转发的地缘论战 → DF-042',
     fire('RT Arthur: China is publicly developing superhuman robot armies') === 'DF-042');

  // 关键边界：政策事实新闻必须保留 —— 用户模板里明确收录了这两条
  ok('加拿大对美加征对等关税（政策事实）→ 不过滤',
     fire('加拿大宣布对美国商品实施对等关税，计划自 9 月 8 日起生效') === null);
  ok('澳大利亚首例哺乳动物 H5 感染（政策事实）→ 不过滤',
     fire('澳大利亚确认首例哺乳动物 H5 感染，为一只死亡海狗，官方称公众风险仍低') === null);
  ok('带官方链接的政治新闻 → 不过滤',
     fire('RT 官方账号：监管机构就意识形态审查发布新条例', { official_link: true }) === null);

  ok('明星抄袭争议 → DF-043',
     fire('中国人气男团被指Logo抄袭，经纪公司回应，F1 已立案调查') === 'DF-043');
  ok('技术项目里出现「争议」二字 → 不过滤',
     fire('该开源项目的许可证争议已由作者回应并更新 LICENSE', { repo_url: true }) === null);

  ok('等级号倒卖询价 → DF-044', fire('L站二级号那么贵吗？闲鱼看到的价格太夸张') === 'DF-044');
  ok('代充代练 → DF-044', fire('提供各类账号代充代练服务') === 'DF-044');

  // 中转站推广常不自称「中转站」，但「倍率」是这一类的标志性说法
  ok('倍率+拉群的中转站推广 → DF-040',
     fire('【富可敌国】pro倍率0.2 缓存接近90% 无降智 送测试鸡蛋欢迎佬们来测 加群 159391934') === 'DF-040');
  ok('正常谈论模型倍率但无推广 → 不过滤',
     fire('这篇文章分析了不同模型的定价倍率差异与成本结构', { official_link: true }) === null);
}

console.log('\n社区营销与个人成就（DF-045 / DF-046，2026-09-01 人工反馈）：\n');
{
  const fire = (title: string, sig: Partial<SignalMap> = {}, mandatory = false) =>
    applyDeterministicFilters({ ...base, title, cleanText: title,
      signals: S(sig), isMandatory: mandatory })?.ruleId ?? null;
  ok('Krill 架构字样即使误命中 B 仍过滤',
     fire('🦐 Krill 架构重构完成｜0.15 倍率拼团正式回归，再抽500元现金红包', {}, true) === 'DF-045');
  ok('Token-X 月卡抽奖过滤',
     fire('【TOKEN-X·抽奖】纯Pro号池｜再抽 10 份 Plus 月卡套餐｜每份 ¥100 额度') === 'DF-045');
  ok('全年不落个人徽章过滤',
     fire('入站两年半，终于拿到了「全年不落」徽章！') === 'DF-046');
  ok('开源抽奖组件不误伤',
     fire('开源抽奖组件发布，附 GitHub 仓库', { repo_url: true }, true) === null);
  ok('官方产品月卡活动不误伤',
     fire('官方月卡套餐抽奖活动', { official_link: true }) === null);
}

console.log('\n强制保留候选豁免 normal_only 规则（PRD 8.2）：\n');
check('AFF+强制保留 → 不过滤', { signals: S({ aff_link: true }), isMandatory: true }, null);
check('低信息量+强制保留 → 不过滤', { cleanText: '哈哈哈这个真的好好玩啊，笑死我了，各位怎么看', externalLinkCount: 0, isMandatory: true }, null);
check('密钥泄露+强制保留 → 仍过滤', { cleanText: 'sk-abcdefghijklmnopqrstuvwx1234', isMandatory: true }, 'DF-021');
check('已发送+强制保留 → 仍过滤', { alreadySentNoUpdate: true, isMandatory: true }, 'DF-001');

console.log('\n反向保护闸门（PRD 8.3 末段）：\n');
for (const [r, shouldThrow] of [['开源推广，无实质内容', true], ['star 数少', true],
                                ['羊毛帖', true], ['正文为空', false]] as const) {
  let threw = false;
  try { assertReasonAllowed(r as string); } catch { threw = true; }
  const ok = threw === shouldThrow;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} 「${r}」 → ${threw ? '拒绝并转人工' : '允许'}`);
}
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
