import { parseV2exHotJson } from '../packages/connectors/src/parsers.ts';

const rows = parseV2exHotJson(JSON.stringify([{
  id: 123,
  title: '测试热门主题',
  url: 'http://www.v2ex.com/t/123',
  content: '正文',
  content_rendered: '<p>正文</p>',
  created: 1_700_000_000,
  member: { username: 'alice' },
}]));

if (rows.length !== 1) throw new Error('应解析一个 V2EX 热门主题');
const item = rows[0]!;
if (item.guid !== 'v2ex:t:123') throw new Error(`身份键错误: ${item.guid}`);
if (item.link !== 'https://www.v2ex.com/t/123') throw new Error(`链接未升级 HTTPS: ${item.link}`);
if (item.author !== 'alice') throw new Error(`作者错误: ${item.author}`);
if (item.publishedRaw !== '2023-11-14T22:13:20.000Z') throw new Error(`时间错误: ${item.publishedRaw}`);

let rejected = false;
try { parseV2exHotJson('{}'); } catch { rejected = true; }
if (!rejected) throw new Error('非数组响应应被拒绝');

console.log('✓ V2EX 官方热门 JSON 解析测试通过');
