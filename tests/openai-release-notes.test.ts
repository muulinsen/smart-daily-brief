import { parseOpenAIReleaseNotesPage } from '../packages/connectors/src/parsers.ts';

const sample = `Title: Release Notes | OpenAI

URL Source: https://openai.com/products/release-notes/

Markdown Content:
API

Sep 3, 2026

GA

## Introducing GPT-6 Astra

Released a new model.

[View source(opens in a new window)](https://developers.openai.com/api/docs/models/gpt-6-astra)

Codex

Sep 1, 2026

GA

## More control over browser and computer use

New policy settings are available.

[View source(opens in a new window)](https://help.openai.com/en/articles/example)
`;

const items = parseOpenAIReleaseNotesPage(sample);
let fail = 0;
const ok = (name: string, pass: boolean) => {
  if (!pass) fail++;
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
};

console.log('OpenAI 产品更新页解析：\n');
ok('按页面顺序解析全部条目', items.length === 2 && items[0]?.title === 'Introducing GPT-6 Astra');
ok('保留官方原文链接', items[0]?.link === 'https://developers.openai.com/api/docs/models/gpt-6-astra');
ok('保留产品、阶段和正文', items[1]?.html.includes('产品：Codex') === true && items[1]?.html.includes('New policy settings') === true);
ok('发布时间来自页面', items[0]?.publishedRaw === 'Sep 3, 2026');
ok('稳定标识不含代理抓取时间', items[0]?.guid === 'openai-release:sep 3, 2026:api:introducing gpt-6 astra');
ok('格式异常时返回空结果', parseOpenAIReleaseNotesPage('Cloudflare challenge').length === 0);

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
