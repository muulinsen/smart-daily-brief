#!/usr/bin/env node
// 从抓取 fixture 生成黄金集草稿（机器预标注，待人工确认）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, cdataPropName: '__cdata' });
const strip = h => String(h ?? '').replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const TRUNC = /阅读完整话题|阅读完整主题|阅读全文|查看全文/;

const out = [];
for (const [source, file] of [['linuxdo','tests/fixtures/linuxdo-top.xml'], ['v2ex','tests/fixtures/v2ex-hot.xml']]) {
  if (!existsSync(file)) continue;
  const doc = xml.parse(readFileSync(file, 'utf8'));
  for (const it of [].concat(doc?.rss?.channel?.item ?? [])) {
    const title = String(it.title?.__cdata ?? it.title ?? '');
    const body  = strip(it.description?.__cdata ?? it.description ?? '');
    const link  = String(it.link ?? '');
    out.push({
      id: `${source}:${(link.match(/(\d+)\/?$/) ?? [,'?'])[1]}`,
      source, url: link, title, body,
      body_is_excerpt: TRUNC.test(body),
      published_at: String(it.pubDate ?? ''),
      expected: { decision: null, mandatory_class: null, section: null, filter_rule_id: null },
      label_source: 'machine_proposed',
      note: TRUNC.test(body) ? '⚠️ 正文为 RSS 摘要，标注前须补全文' : ''
    });
  }
}
writeFileSync('tests/golden/seed.json', JSON.stringify(out, null, 2));
const need = out.filter(o => o.body_is_excerpt).length;
console.log(`生成草稿 ${out.length} 条 → tests/golden/seed.json`);
console.log(`  其中 ${need} 条正文为摘要，标注前必须补全文（否则不能用于 A–D 召回校验）`);
console.log(`  距 PRD 23.3 要求的 200 条，还缺 ${Math.max(0, 200 - out.length)} 条`);
