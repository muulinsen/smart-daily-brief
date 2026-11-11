// 聚类与排序（PRD 7.4 / 8.4 / 9.1）
import { clusterCandidates, excludeCoveredToday, selectForBrief, scoreCluster, similarEventTitles, type ClusterInput }
  from '../packages/domain/src/cluster.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const it = (id: string, o: Partial<ClusterInput> = {}): ClusterInput => ({
  candidateId: id, sourceId: 'linuxdo', title: '标题'+id, url: 'https://x/'+id,
  publishedAt: new Date(Date.now()-3600e3).toISOString(), eventKey: 'evt-'+id,
  section: 'ai_tech', decision: 'normal', mandatoryClass: 'none',
  confidence: 0.9, importance: 0.5, novelty: 0.5, signals: [], sourcePriority: 5, ...o });

console.log('跨来源同事件合并（PRD 7.4）：\n');
{
  const cs = clusterCandidates([
    it('a', { eventKey: 'openai-release', sourceId: 'x_openai', sourcePriority: 1, isOfficial: true }),
    it('b', { eventKey: 'openai-release', sourceId: 'tg_durov', sourcePriority: 5 }),
    it('c', { eventKey: 'openai-release', sourceId: 'jike', sourcePriority: 3 }),
    it('d', { eventKey: 'other-thing' }),
  ]);
  ok('三条同事件合并为一簇', cs.length === 2);
  const merged = cs.find(c => c.primary.eventKey === 'openai-release')!;
  ok('官方来源被选为最佳原始来源', merged.primary.sourceId === 'x_openai');
  ok('其他渠道贡献被保留', merged.members.length === 2,
     merged.members.map(m => m.sourceId).join(','));
}

console.log('\n同关键词不等于重复（PRD 7.4 最易错项）：\n');
{
  // 模型给了同一个 event_key，但一个是项目发布、一个是使用教程
  const cs = clusterCandidates([
    it('proj', { eventKey: 'toolx', mandatoryClass: 'A' }),
    it('tut',  { eventKey: 'toolx', mandatoryClass: 'B' }),
  ]);
  ok('A 类项目与 B 类教程不合并', cs.length === 2);
}
{
  const cs = clusterCandidates([
    it('a', { eventKey: 'toolx', section: 'ai_tech' }),
    it('b', { eventKey: 'toolx', section: 'developer_product' }),
  ]);
  ok('不同分区不合并', cs.length === 2);
}

console.log('\n模型事件键漂移时的轻微标题差异：\n');
{
  const cs = clusterCandidates([
    it('mate-a', { title: '华为发布搭载麒麟 9050 Pro 芯片的 Mate XT 2 三折叠手机',
      eventKey: 'huawei-kirin-9050-pro-mate-xt-2-launch-2026-09' }),
    it('mate-b', { title: '华为推出搭载麒麟 9050 Pro 芯片的 Mate XT 2 三折叠手机',
      eventKey: 'huawei-mate-xt-2-kirin-9050-pro-launch' }),
  ]);
  ok('同产品发布/推出的跨来源转述合并', cs.length === 1 && cs[0]?.members.length === 1);
}
{
  const cs = clusterCandidates([
    it('mate-release', { title: '华为发布 Mate XT 2 三折叠手机', eventKey: 'mate-release' }),
    it('mate-price', { title: '华为公布 Mate XT 2 三折叠手机售价', eventKey: 'mate-price' }),
  ]);
  ok('产品发布与售价公布仍保持为不同事件', cs.length === 2);
}

console.log('\n人工确认的同事件别名：\n');
{
  const cs = clusterCandidates([
    it('flood-a', { title: '尼泊尔北部与中国西藏接壤地区洪灾致超160人死亡',
      eventKey: 'nepal-flood-160' }),
    it('flood-b', { title: '尼泊尔与中国西藏边境山洪泥石流致近百人遇难',
      eventKey: 'nepal-tibet-landslide-100' }),
  ]);
  ok('同一洪灾数字更新仍合并', cs.length === 1);
}
{
  const cs = clusterCandidates([
    it('codex-announcement', {
      title: 'Codex 重新开放 Pro $200 订阅，同时调整用量计算方式',
      eventKey: 'codex-subscription-reopen',
    }),
    it('pro-benefit', {
      title: 'Codex Pro $200 订阅新增视频生成权益',
      eventKey: 'codex-pro-benefit',
    }),
    it('pro-guide', {
      title: 'Codex Pro $200 订阅使用教程',
      eventKey: 'codex-pro-guide', mandatoryClass: 'B',
    }),
  ]);
  ok('Pro $200 新权益与使用教程不并入重新开放公告', cs.length === 3);
}
{
  const cs = clusterCandidates([
    it('quota-a', { title: 'Codex 重置了', eventKey: 'codex-reset' }),
    it('quota-b', { title: 'Codex 并非额度用完后可无限使用', eventKey: 'luna-reserve' }),
  ]);
  ok('Codex 重置短讯与额度说明合并', cs.length === 1);
}
{
  const cs = clusterCandidates([
    it('cook-cn', { title: '库克卸任苹果 CEO 发全员信，称不会离开公司',
      eventKey: 'apple-transition-cn', section: 'ai_tech' }),
    it('cook-en', { title: 'RT Tim Cook: Sending love on my last day as CEO',
      eventKey: 'tim-cook-last-day', section: 'society_life' }),
  ]);
  ok('库克卸任的中英文消息跨分区合并', cs.length === 1);
  ok('库克事件统一归入科技趋势', cs[0]?.section === 'ai_tech');
}

console.log('\n确定性分区校正：\n');
{
  const cs = clusterCandidates([
    it('website-rebuild', { title: 'Website Rebuild Skill 网站逆向与模块化移植工具',
      eventKey: 'website-rebuild-skill', section: 'ai_tech', mandatoryClass: 'A' }),
  ]);
  ok('A 类可复用项目归入开源项目', cs[0]?.section === 'open_source_project');
}

console.log('\n同一自然日跨窗口去重：\n');
{
  ok('相似标题共享实体与事实时判定为同一事件', similarEventTitles(
    '最高法发布 AI 纠纷司法解释，换脸与算法杀熟责任获明确',
    '最高人民法院明确 AI 换脸和算法杀熟纠纷责任'));
  ok('仅同主题但无共同事实不判重复', !similarEventTitles(
    '最高法发布 AI 纠纷司法解释', '最高法公布民事诉讼法司法解释'));
}
{
  const current = clusterCandidates([
    it('phone', { title: '高通宣布全系列芯片涨价幅度',
      eventKey: 'qualcomm-chip-price-rise', section: 'ai_tech' }),
    it('cook', { title: 'RT Tim Cook: my last day as CEO',
      eventKey: 'cook-last-day', section: 'society_life' }),
    it('new', { title: '全新独立事件', eventKey: 'brand-new-event' }),
  ]);
  const r = excludeCoveredToday(current, [
    { title: '国内多家手机厂商统一调价，华为多款机型涨价千元',
      clusterKey: 'chinese-smartphone-price-increase-sept-2026:ai_tech:none' },
    { title: '蒂姆·库克宣布卸任苹果 CEO 并留任执行主席',
      clusterKey: 'apple-ceo-transition-2026:ai_tech:none' },
  ]);
  ok('午报手机调价覆盖晚报高通涨价', r.covered.some(x => x.cluster.primary.candidateId === 'phone'));
  ok('午报库克消息覆盖晚报英文转述', r.covered.some(x => x.cluster.primary.candidateId === 'cook'));
  ok('无关新事件正常保留', r.fresh.length === 1 && r.fresh[0]?.primary.candidateId === 'new');
}
{
  const current = clusterCandidates([
    it('same-url', { title: '同一新闻的另一种模型表达', eventKey: 'drifted-event-key',
      url: 'https://news.example/item/1' }),
    it('same-title', { title: '完全相同的访谈标题', eventKey: 'another-drifted-key',
      url: 'https://news.example/item/2?new=1' }),
  ]);
  const r = excludeCoveredToday(current, [
    { title: '原始标题', clusterKey: 'original-event:ai_tech:none',
      sourceUrl: 'https://news.example/item/1' },
    { title: '完全相同的访谈标题', clusterKey: 'other-event:quality_article:B',
      sourceUrl: 'https://news.example/item/2' },
  ]);
  ok('event_key 漂移时相同原文 URL 仍会跨窗口去重',
    r.covered.some(x => x.cluster.primary.candidateId === 'same-url'));
  ok('event_key 与 URL 都漂移时完全相同标题仍会跨窗口去重',
    r.covered.some(x => x.cluster.primary.candidateId === 'same-title'));
}
{
  const current = clusterCandidates([it('canonical-url', {
    title: '另一种标题表达', eventKey: 'new-key', url: 'https://news.example/item/1?utm_source=x#top',
  })]);
  const r = excludeCoveredToday(current, [{
    title: '原始标题', clusterKey: 'old:ai_tech:none', sourceUrl: 'https://news.example/item/1',
  }]);
  ok('URL 追踪参数与片段差异仍能跨窗口去重', r.covered.length === 1);
}
{
  const current = clusterCandidates([
    it('wording-drift', {
      title: '华为推出搭载麒麟 9050 Pro 芯片的 Mate XT 2 三折叠手机',
      eventKey: 'new-model-key', url: 'https://news.example/new-copy',
    }),
  ]);
  const r = excludeCoveredToday(current, [{
    title: '华为发布搭载麒麟 9050 Pro 芯片的 Mate XT 2 三折叠手机',
    clusterKey: 'old-model-key:ai_tech:none', sourceUrl: 'https://news.example/old-copy',
  }]);
  ok('跨窗口标题仅发布/推出不同仍会去重', r.covered.length === 1);
}
{
  // 官方文章与 X 转述可能跨窗口到达，标题语言和模型 event_key 均不同，
  // 但确定性事件别名必须把它们视为同一事件。
  const current = clusterCandidates([
    it('financial-x', { title: 'Now available: ChatGPT for Financial Services',
      eventKey: 'openai-chatgpt-financial-services-launch-2026-09', sourceId: 'x_openai' }),
    it('live-x', { title: 'GPT-Live-1 is now available in the API',
      eventKey: 'openai-gpt-live-1-api-release-2026-09', sourceId: 'x_openai' }),
  ]);
  const r = excludeCoveredToday(current, [
    { title: 'OpenAI 推出面向金融服务行业的 ChatGPT',
      clusterKey: 'openai-chatgpt-financial-services-launch-2026-09:ai_tech:none' },
    { title: 'OpenAI API 上线 GPT-Live-1 实时语音模型',
      clusterKey: 'openai-gpt-live-1-api-release:ai_tech:none' },
  ]);
  ok('金融服务版 ChatGPT 的 X 转述跨窗口去重',
    r.covered.some(x => x.cluster.primary.candidateId === 'financial-x'));
  ok('GPT-Live-1 的 X 转述跨窗口去重',
    r.covered.some(x => x.cluster.primary.candidateId === 'live-x'));
}
{
  const current = clusterCandidates([
    it('date-drift', { title: '同一事件的新窗口转述',
      eventKey: 'same-event-2026-09' }),
  ]);
  const r = excludeCoveredToday(current, [{
    title: '同一事件的早报原文',
    clusterKey: 'same-event-2026:ai_tech:none',
  }]);
  ok('同一事件键仅日期后缀漂移时跨窗口去重', r.covered.length === 1);
}
{
  const sameWindow = clusterCandidates([
    it('qualcomm', { title: '高通宣布全系列芯片涨价幅度',
      eventKey: 'qualcomm-price', section: 'ai_tech' }),
    it('phones', { title: '国内多家手机厂商统一调价，华为多款机型涨价千元',
      eventKey: 'phone-price', section: 'ai_tech' }),
    it('brands', { title: '华为、小米、荣耀主力机型今日集中上调售价',
      eventKey: 'brand-price', section: 'ai_tech' }),
  ]);
  ok('同一期高通涨价与手机厂商调价合并为一条',
     sameWindow.length === 1 && sameWindow[0]?.members.length === 2);
}

console.log('\n排序权重（PRD 8.4 合计 100）：\n');
{
  const hi = it('hi', { importance: 1, novelty: 1, sourcePriority: 1, isOfficial: true,
    signals: ['official_link','repo_url','demo_link','external_link','code_block','command_line','config_block','step_markers'] });
  const lo = it('lo', { importance: 0, novelty: 0, sourcePriority: 7,
    publishedAt: new Date(Date.now()-96*3600e3).toISOString() });
  const sHi = scoreCluster(hi, [hi]), sLo = scoreCluster(lo, [lo]);
  ok('满分接近 100', sHi >= 95, String(sHi));
  ok('最低分接近 0', sLo <= 10, String(sLo));
  const multi = scoreCluster(hi, [hi, it('x')]);
  ok('多来源互证提高可验证性', multi >= sHi, `单源=${sHi} 多源=${multi}`);
}

console.log('\n入选规则（PRD 8.4 / 9.1）：\n');
{
  const mk = (i: number, score: number, mc = 'none') =>
    ({ clusterKey: 'k'+i, section: 'ai_tech', primary: it('p'+i), members: [],
       mandatoryClass: mc, score });
  const many = Array.from({length: 20}, (_, i) => mk(i, 90 - i));
  const r = selectForBrief(many as any);
  ok('普通候选按分数截到 12 条', r.selected.length === 12, String(r.selected.length));
  ok('落选的进 dropped', r.dropped.length === 8);

  const withMandatory = [...Array.from({length: 12}, (_, i) => mk(i, 90 - i)),
                         mk(90, 30, 'A'), mk(91, 20, 'D')];
  const r2 = selectForBrief(withMandatory as any);
  ok('强制保留项不参与篇幅淘汰，总数可超 12', r2.selected.length === 14, String(r2.selected.length));
  ok('低分强制保留项仍入选',
     r2.selected.some(c => c.mandatoryClass === 'A' && c.score === 30));

  const weak = Array.from({length: 10}, (_, i) => mk(i, 20));
  const r3 = selectForBrief(weak as any);
  ok('全部低于分数线 → 收 0 条（禁止凑数，PRD 9.1）', r3.selected.length === 0);

  const boundary = selectForBrief([mk(95, 25), mk(96, 24.9)] as any);
  ok('正例校准后的 25 分边界生效',
     boundary.selected.length === 1 && boundary.selected[0]!.score === 25);

  const humanRetained = mk(99, 20);
  humanRetained.primary.decision = 'retain';
  const r4 = selectForBrief([humanRetained] as any);
  ok('人工 retain 不受分类和最低分限制', r4.selected.length === 1);
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
