// MIME 组装（PRD 9.4：multipart/alternative）
import { buildMime } from '../packages/templates/src/mailer.ts';

let fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (!c) fail++; console.log(`  ${c?'✅':'❌'} ${n}${d?'  '+d:''}`); };

/** 极简 MIME 头/体分割：第一个空行之前是头区。 */
const split = (raw: string) => {
  const i = raw.indexOf('\r\n\r\n');
  return { head: raw.slice(0, i), body: raw.slice(i + 4) };
};
const base = { from: 'a@b.com', to: 'c@d.com', subject: 'Hello',
               text: '纯文本正文', html: '<p>HTML 正文</p>' };

console.log('头区完整性（曾因空行提前终结而全客户端乱码）：\n');
{
  const { head } = split(buildMime(base));
  ok('无额外头时头区仍含 Content-Type', head.includes('Content-Type: multipart/alternative'),
     head.split('\r\n').length + ' 行');
  ok('头区不含空行', !head.includes('\r\n\r\n'));
  ok('From/To/Subject/MIME-Version/Date 齐全',
     ['From:','To:','Subject:','MIME-Version:','Date:'].every(h => head.includes(h)));
}
{
  const { head } = split(buildMime({ ...base, headers: { 'X-Brief-Environment': 'shadow' } }));
  ok('带额外头时头区仍完整',
     head.includes('X-Brief-Environment: shadow') && head.includes('Content-Type: multipart/alternative'));
  ok('额外头未引入空行', !head.includes('\r\n\r\n'));
}

console.log('\n结构与编码：\n');
{
  const raw = buildMime(base);
  const b = raw.match(/boundary="([^"]+)"/)?.[1] ?? '';
  ok('boundary 已声明并使用', !!b && raw.includes(`--${b}\r\n`) && raw.includes(`--${b}--`));
  ok('含 text/plain 与 text/html 两部分',
     raw.includes('Content-Type: text/plain') && raw.includes('Content-Type: text/html'));
  ok('两部分均为 base64', (raw.match(/Content-Transfer-Encoding: base64/g) ?? []).length === 2);
  const parts = raw.split(`--${b}`);
  const decode = (p: string) => Buffer.from(p.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8');
  ok('纯文本可正确解码', decode(parts[1]!).includes('纯文本正文'));
  ok('HTML 可正确解码', decode(parts[2]!).includes('HTML 正文'));
}

console.log('\n中文主题编码（RFC 2047）：\n');
{
  const raw = buildMime({ ...base, subject: '十六源简报｜2026-08-23｜晚报' });
  const line = raw.split('\r\n').find(l => l.startsWith('Subject:'))!;
  ok('中文主题已 Base64 编码', line.includes('=?UTF-8?B?') && line.endsWith('?='));
  const enc = line.match(/=\?UTF-8\?B\?(.+)\?=/)![1]!;
  ok('解码后与原文一致',
     Buffer.from(enc, 'base64').toString('utf8') === '十六源简报｜2026-08-23｜晚报');
  const ascii = buildMime({ ...base, subject: 'Plain ASCII' });
  ok('纯 ASCII 主题不做多余编码',
     ascii.split('\r\n').find(l => l.startsWith('Subject:')) === 'Subject: Plain ASCII');
}

console.log('\n长行折行：\n');
{
  const raw = buildMime({ ...base, html: '<p>' + 'x'.repeat(5000) + '</p>' });
  const tooLong = raw.split('\r\n').filter(l => l.length > 998);
  ok('无超过 998 字节的行（RFC 5322 上限）', tooLong.length === 0,
     tooLong.length ? `最长 ${Math.max(...tooLong.map(l => l.length))}` : '');
}

console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
