// 邮件渲染与安全（PRD 9.3 / 9.4 / 17.3）
import { renderHtml, renderText, checkEmail, esc, safeUrl, subjectOf, type BriefData }
  from '../packages/templates/src/email.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

const data = (o: Partial<BriefData> = {}): BriefData => ({
  date: '2026-08-23', windowLabel: '晚报', windowRange: '12:00–22:00',
  highlights: ['要点一', '要点二'],
  sections: [{ id: 'ai_tech', title: 'AI 与科技趋势', items: [{
    title: '某模型发布', conclusion: '这是结论。',
    summarySentences: ['第一句。', '第二句。'],
    sourceName: 'LINUX DO', sourceSite: 'https://linux.do',
    sourceUrl: 'https://linux.do/t/topic/1',
  }] }],
  audit: { mandatoryMisses: [], counts: [{ label: '已过滤', count: 5 }], sourceIssues: [] },
  ...o });

console.log('注入防护（PRD 17.3）：\n');
{
  const evil = data({ sections: [{ id: 'ai_tech', title: '<script>alert(1)</script>', items: [{
    title: '<img src=x onerror=alert(1)>标题',
    conclusion: '"><script>evil()</script>',
    summarySentences: ["' onmouseover='x", '<iframe src=//evil></iframe>'],
    sourceName: '<b>源</b>', sourceUrl: 'javascript:alert(1)',
  }] }] });
  const html = renderHtml(evil);
  ok('script 标签被转义', !/<script/i.test(html));
  ok('iframe 被转义', !/<iframe/i.test(html));
  const tagsHaveHandler = [...html.matchAll(/<[a-z][^>]*>/gi)].some(t => /\son[a-z]+\s*=/i.test(t[0]));
  ok('真实标签内无事件处理器属性', !tagsHaveHandler);
  ok('恶意属性以纯文本形式存在（已被转义）', html.includes('onerror=alert(1)&gt;'));
  ok('javascript: 链接被拒绝', !html.includes('javascript:'));
  ok('无法生成链接时给出替代文案', html.includes('原文链接不可用'));
  ok('整体校验通过', checkEmail(html, renderText(evil)).length === 0,
     checkEmail(html, renderText(evil)).join('; '));
}

console.log('\n链接协议白名单：\n');
{
  ok('https 通过', safeUrl('https://a.com/x?y=1') === 'https://a.com/x?y=1');
  ok('http 被拒', safeUrl('http://a.com') === null);
  ok('javascript: 被拒', safeUrl('javascript:alert(1)') === null);
  ok('data: 被拒', safeUrl('data:text/html,<script>') === null);
  ok('畸形 URL 被拒', safeUrl('not a url') === null);
  ok('空值被拒', safeUrl(null) === null);
}

console.log('\n格式约束（PRD 9.4）：\n');
{
  const html = renderHtml(data());
  ok('含 760px 最大宽度', html.includes('max-width:760px'));
  ok('无 JavaScript', !/<script/i.test(html));
  ok('无外部字体/远程样式表', !/<link[^>]+stylesheet/i.test(html) && !/@import/.test(html));
  ok('无图片（含追踪像素）', !/<img/i.test(html));
  ok('CSS 全部内联', !/<style[\s>]/i.test(html));
  ok('声明 color-scheme 以适配深色模式', html.includes('color-scheme'));
  const kb = Buffer.byteLength(html, 'utf8') / 1024;
  ok('体积远小于 100 KB', kb < 20, kb.toFixed(1) + ' KB');
}

console.log('\n主题与纯文本备用（PRD 9.4 / 9.5）：\n');
{
  const d = data();
  ok('主题使用通用名称并显示条数',
    subjectOf(d) === '智能资讯简报｜2026-08-23｜晚报｜1条', subjectOf(d));
  d.comparisonLabel = '优化版';
  ok('对照邮件主题明确标记版本', subjectOf(d).endsWith('｜优化版'), subjectOf(d));
  const t = renderText(d);
  ok('纯文本不再展示核心要点', !t.includes('【核心要点】'));
  ok('HTML 不再展示核心要点', !renderHtml(d).includes('核心要点'));
  ok('纯文本含来源链接', t.includes('https://linux.do/t/topic/1'));
  ok('纯文本含审计区', t.includes('【来源状态与过滤审计】'));
}

console.log('\n优化版完整展示：\n');
{
  const mk = (n: number, sourceId: string) => ({
    title: `条目 ${n}`, conclusion: `结论 ${n}`, summarySentences: [`摘要 ${n}-1。`, `摘要 ${n}-2。`],
    sourceName: sourceId, sourceId, sourceUrl: `https://example.com/${n}`,
    score: 100 - n, bodyChars: 500,
  });
  const sections: BriefData['sections'] = [
    { id: 'ai_tech', title: 'AI 与科技趋势', items: Array.from({length: 13}, (_, i) => mk(i + 1, `s${i}`)) },
    { id: 'society', title: '社会与生活', items: [mk(14, 'hot'), mk(15, 'other')] },
  ];
  const d = data({ sections,
    evalAppendix: { filtered: [{ ref:'c9', title:'附录条目', source:'测试源', url:null, reason:'过滤原因' }], pending: [] } });
  const html = renderHtml(d), text = renderText(d);
  ok('全部入选条目都按完整卡片显示', (html.match(/来源渠道：/g) ?? []).length === 15);
  ok('不再显示更多值得看板块', !html.includes('更多值得看') && !text.includes('【更多值得看】'));
  ok('每条的全部摘要句均显示', html.includes('摘要 1-1。') && html.includes('摘要 1-2。'));
  ok('标题直接链接原文', /href="https:\/\/example\.com\/[^\"]+"[^>]*>条目/.test(html));
  ok('评估附录继续保留', html.includes('评估附录') && html.includes('附录条目'));
  ok('优化邮件通过安全校验', checkEmail(html, text).length === 0, checkEmail(html, text).join('; '));
}

console.log('\n渠道名可点击跳转到对应源：\n');
{
  const html = renderHtml(data()), text = renderText(data());
  ok('显示渠道名而非内部 id', html.includes('LINUX DO') && !html.includes('>linuxdo<'));
  ok('渠道名带「来源渠道：」前缀', html.includes('来源渠道：'));
  // safeUrl 会规范化 URL（补尾斜杠），断言语义而非字面：
  // 渠道名必须包在指向主页的 <a> 里
  ok('渠道名链接到主页',
     /<a href="https:\/\/linux\.do\/?"[^>]*>LINUX DO<\/a>/.test(html),
     html.match(/<a href="https:\/\/linux\.do[^"]*"[^>]*>[^<]*<\/a>/)?.[0]?.slice(0, 60) ?? '未找到');
  ok('原文链接独立于渠道链接', html.includes('href="https://linux.do/t/topic/1"'));
  ok('纯文本同时给出渠道主页与原文',
     /来源渠道：LINUX DO https:\/\/linux\.do/.test(text) && text.includes('原文：https://linux.do/t/topic/1'));

  // 无主页时不得生成空链接
  const noSite = data();
  noSite.sections[0]!.items[0]!.sourceSite = null;
  const h2 = renderHtml(noSite);
  ok('无主页时渠道名不做成链接', h2.includes('LINUX DO') && !/href="[^"]*">LINUX DO/.test(h2));
  ok('仍通过整体校验', checkEmail(h2, renderText(noSite)).length === 0);

  // http 主页必须被拒（只放行 https）
  const bad = data();
  bad.sections[0]!.items[0]!.sourceSite = 'http://evil.example';
  ok('http 主页被拒绝', !renderHtml(bad).includes('evil.example'));
}

console.log('\n补录条目按普通条目展示（PRD 6.3 的标注要求已按使用方决定去除）：\n');
{
  const d = data({ sections: [{ id:'ai_tech', title:'A', items:[{
    title:'延迟条目', conclusion:'c', summarySentences:['a。','b。'],
    sourceName:'V2EX', sourceUrl:'https://v2ex.com/t/1',
    lateDiscovery: { originWindow:'2026-08-23:noon', publishedAt:'2026-08-23 09:24', firstSeenAt:'2026-08-23 12:20' },
  }] }] });
  const html = renderHtml(d), text = renderText(d);
  // 补录是采集时序的产物，对读者不构成信息；标注只制造噪声。
  // 可审计性由 candidates.late_discovery 与审计区计数保证，不依赖邮件正文。
  ok('HTML 不出现补录徽章', !html.includes('补录'));
  ok('HTML 不展示原窗口等采集元信息',
     !html.includes('原发布') && !html.includes('原窗口') && !html.includes('首次发现'));
  ok('纯文本同样不标注', !text.includes('补录') && !text.includes('原窗口'));
  ok('补录条目本身正常展示', html.includes('延迟条目') && text.includes('延迟条目'));
}

console.log('\n审计区（PRD 9.3）：\n');
{
  const d = data({ audit: {
    mandatoryMisses: [{ title:'某开源项目', url:'https://linux.do/t/topic/9', reason:'人工判定为重复' }],
    counts: [{ label:'已过滤', count:12 }, { label:'无更新', count:3 }],
    sourceIssues: [{ source:'x_claudeai', status:'抓取失败', detail:'HTTP 404，连续 2 次' },
                   { source:'jike', status:'来源异常', detail:'200 但解析出 0 条' }],
  } });
  const html = renderHtml(d), text = renderText(d);
  ok('强制保留未收录项逐条列出（含链接与原因）',
     html.includes('某开源项目') && html.includes('人工判定为重复'));
  ok('抓取失败与来源异常分别标明',
     html.includes('抓取失败') && html.includes('来源异常'));
  ok('抓取失败未被写成「无更新」', !/x_claudeai[\s\S]{0,80}无更新/.test(html));
  // 剥标签后再比对：断言内容而非标记结构，改样式不该让测试误报
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ok('普通过滤按类别计数', /已过滤\s*12/.test(plain) && /无更新\s*3/.test(plain));
  ok('纯文本含全部审计信息',
     text.includes('某开源项目') && text.includes('抓取失败') && text.includes('来源异常'));
}

console.log('\ncheckEmail 拦截：\n');
{
  ok('超大 HTML 不因体积被拦截', checkEmail('x'.repeat(110*1024), 't').length === 0);
  ok('含 script 被拦', checkEmail('<script>a</script>', 't').some(e => e.includes('script')));
  ok('含 img 被拦', checkEmail('<img src=x>', 't').some(e => e.includes('图片')));
  ok('http 链接被拦', checkEmail('<a href="http://a.com">x</a>', 't').some(e => e.includes('非 HTTPS')));
  ok('纯文本为空被拦', checkEmail('<p>a</p>', '  ').some(e => e.includes('纯文本')));
  ok('正常内容通过', checkEmail(renderHtml(data()), renderText(data())).length === 0);
}

// 后台「消息渠道 → 邮件」与 worker 共用的通道判断：凭证不完整时如实回落到落盘（不返回任何凭证值）
{
  const { resolveMailTransport } = await import('../packages/templates/src/mailer.ts');
  ok('SMTP 缺凭证回落落盘', resolveMailTransport({ MAIL_TRANSPORT: 'smtp' }).kind === 'file');
  ok('SMTP 凭证齐全', resolveMailTransport({ MAIL_TRANSPORT: 'smtp', SMTP_USER: 'u', SMTP_PASS: 'p' }).kind === 'smtp');
  ok('Gmail 缺凭证回落落盘', resolveMailTransport({ GMAIL_REFRESH_TOKEN: 'r' }).kind === 'file');
  ok('Gmail 凭证齐全', resolveMailTransport({ GMAIL_REFRESH_TOKEN: 'r', GMAIL_CLIENT_ID: 'i', GMAIL_CLIENT_SECRET: 's', MAIL_FROM: 'f@x' }).kind === 'gmail');
  ok('结果不含凭证', !JSON.stringify(resolveMailTransport({ MAIL_TRANSPORT: 'smtp', SMTP_USER: 'u', SMTP_PASS: 'secret-pass' })).includes('secret-pass'));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
