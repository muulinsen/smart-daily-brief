// 强制保留 A–D 预判（PRD 8.2）：规则从 rules.yaml 求值，不在代码里写第二遍
import { extractSignals, prescreenMandatory, auditPrescreenCoverage }
  from '../packages/domain/src/signals.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (!c) fail++; console.log(`  ${c ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`);
};

console.log('规则覆盖度自检：\n');
{
  const problems = auditPrescreenCoverage();
  ok('四个类别都有可求值的 prescreen 且信号名有效', problems.length === 0, problems.join('; '));
  const cls = prescreenMandatory({ repo_url: true } as any);
  ok('A 类可由 repo_url 单独触发', cls.includes('A'));
}

console.log('\n代码块信号必须能识别 HTML（B 类的主要依据）：\n');
{
  // 真实场景：论坛正文经 HTML→纯文本转换后围栏没了，只测纯文本会全漏。
  // 实测 linux.do 100 条候选里 11 条含 <code>、7 条含 <pre>，纯文本围栏 0 条。
  const html = '<pre data-code-wrap="bash"><code class="lang-bash">npm install -g foo\nfoo --init</code></pre>';
  const text = '这里演示一下安装过程，效果不错。';
  const d = extractSignals(text, html, 'linux.do');
  ok('<pre><code> 被识别为 code_block', d.signals.code_block === true);
  ok('据此预判出 B 类', prescreenMandatory(d.signals).includes('B'));
}
{
  const d = extractSignals('```\nnpm install foo\nfoo run\n```', '', 'linux.do');
  ok('纯文本围栏仍然识别', d.signals.code_block === true);
}
{
  // 反向：不能因为改测 HTML 就把普通排版误判成配置块。
  // config_block 的「连续三行 key: value」在任何带内联样式的 HTML 里都会命中，
  // 所以它必须保持只测纯文本。
  const html = '<div style="color:red; margin:0; padding:2px; border:none">一段普通正文</div>';
  const d = extractSignals('一段普通正文', html, 'linux.do');
  ok('内联样式不被误判为 config_block', d.signals.config_block === false);
  ok('普通排版不产生 A–D 预判', prescreenMandatory(d.signals).length === 0);
}

console.log('\nD 类的硬性排除（PRD 8.2 D 段）：\n');
{
  const base = { step_markers: true, external_link: true } as any;
  ok('步骤 + 外链 → D 类', prescreenMandatory(base).includes('D'));
  ok('含 AFF 链接则排除 D', !prescreenMandatory({ ...base, aff_link: true }).includes('D'));
  ok('含邀请码则排除 D', !prescreenMandatory({ ...base, invite_code: true }).includes('D'));
  ok('但仍可命中 B（步骤+外链）', prescreenMandatory({ ...base, aff_link: true }).includes('B'));
}

console.log('\nC 类必须有官方可核验入口：\n');
{
  ok('仅提到价格不构成 C', !prescreenMandatory({ price_mention: true } as any).includes('C'));
  ok('官方链接 + 价格 → C',
     prescreenMandatory({ official_link: true, price_mention: true } as any).includes('C'));
  ok('官方链接 + 政策 → C',
     prescreenMandatory({ official_link: true, policy_mention: true } as any).includes('C'));
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
