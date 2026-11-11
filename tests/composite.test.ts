import { expandCompositeDigest, expandSuperTechFansDigest } from '../packages/connectors/src/parsers.ts';
import { fulltextFetcher } from '../packages/connectors/src/fulltext.ts';

let fail = 0;
const ok = (name: string, pass: boolean, detail = '') => {
  if (!pass) fail++;
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

const parent = {
  title: '一觉醒来发生了什么 08月28日',
  html: `2026年8月28日<br>🌍资讯快读<br>1、我国开展汽车质量提升专项行动<br>
    https://www.jiemian.com/article/1.html<br>2、OpenAI代理安全事件<br>
    https://www.jiemian.com/article/2.html<br>👬即刻镇小报<br>
    1、如何无痛积累自己的语料<br>https://m.okjike.com/originalPosts/abc`,
  link: 'https://m.okjike.com/originalPosts/parent', guid: 'parent',
  publishedRaw: '2026-08-28T00:00:00Z', author: '即刻',
};

console.log('复合型 RSS 日报拆分：\n');
const children = expandCompositeDigest(parent);
ok('每条编号消息成为独立条目', children.length === 3, String(children.length));
ok('保留各自标题', children[1]?.title === 'OpenAI代理安全事件');
ok('保留各自原文 URL', children[2]?.link === 'https://m.okjike.com/originalPosts/abc');
ok('继承发布时间', children.every(x => x.publishedRaw === parent.publishedRaw));
ok('普通文章不被误拆', expandCompositeDigest({ ...parent, title: '普通文章' }).length === 1);
ok('即刻拆分子项有全文抓取器',
  typeof fulltextFetcher('jike', 'jike:test', children[2]?.link ?? null) === 'function');

console.log('\nSuperTechFans HackerNews 日报拆分：\n');
const hnParent = {
  title: '2026 09 06 HackerNews',
  html: `<h1>2026-09-06 Hacker News Top Stories</h1>
    <h2 id=&#34;first&#34;>1. 第一条消息 (First story) <a href=&#34;#first&#34;>#</a></h2>
    <p><a href=&#34;https://example.com/story?a=1&amp;b=2&#34;>原文</a></p><p>第一条正文</p>
    <h3>HN 热度</h3><p><a href=&#34;https://news.ycombinator.com/item?id=49568506&#34;>讨论</a></p>
    <h2>2. 第二条消息 (Second story) <a href=&#34;#second&#34;>#</a></h2>
    <p><a href=&#34;https://example.org/second&#34;>原文</a></p><p>第二条正文</p>
    <h3>HN 热度</h3><p><a href=&#34;https://news.ycombinator.com/item?id=49570669&#34;>讨论</a></p>
    <h2>Hacker News 精彩评论及翻译</h2><p>不属于第二条的汇总内容</p>`,
  link: 'https://supertechfans.com/cn/post/2026-09-06-HackerNews/',
  guid: 'daily-parent', publishedRaw: 'Sun, 06 Sep 2026 07:35:52 +0800', author: null,
};
const hn = expandSuperTechFansDigest(hnParent)!;
ok('每个编号 h2 成为独立消息', hn.length === 2, String(hn.length));
ok('去掉排名与锚点，保留中英文标题', hn[0]?.title === '第一条消息 (First story)');
ok('第一条外链作为原文地址并解码实体', hn[0]?.link === 'https://example.com/story?a=1&b=2');
ok('使用 HN item id 构造稳定标识', hn[0]?.guid === 'hn:49568506');
ok('正文按下一个 h2 截断', hn[0]?.html.includes('第一条正文') === true && !hn[0]?.html.includes('第二条正文'));
ok('排除末尾非消息汇总段', !hn[1]?.html.includes('不属于第二条'));
ok('继承日报发布时间', hn.every(x => x.publishedRaw === hnParent.publishedRaw));
ok('统一解析入口自动拆分', expandCompositeDigest(hnParent).length === 2);
const malformed = { ...hnParent, html: '<h2>1. only</h2>' };
const malformedOut = expandSuperTechFansDigest(malformed)!;
ok('结构异常时保留父条目', malformedOut.length === 1 && malformedOut[0] === malformed);

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
