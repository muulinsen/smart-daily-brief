#!/usr/bin/env node
// 回归测试：内容指纹必须忽略回复数等噪声，但必须捕捉实质更新（PRD 7.3）
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';

const cfg = parse(readFileSync('config/rules.yaml', 'utf8'));
const F = cfg.content_fingerprint;

function fingerprint(text) {
  let t = String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[​-‏﻿]/g, '')
    .replace(/\s+/g, ' ');
  for (const p of F.ignore_patterns) t = t.replace(new RegExp(p.regex, (p.flags ?? '') + 'g'), '');
  t = t.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(t).digest('hex').slice(0, 16);
}
const substantive = text =>
  F.substantive_update_signals.filter(s => new RegExp(s.regex, s.flags ?? '').test(text)).map(s => s.name);

const cases = [
  { name: '回复数变化（linux.do 实测尾注）', pass_if: 'same',
    a: '这是一个开源项目 github.com/foo/bar 26 个帖子 - 21 位参与者 阅读完整话题',
    b: '这是一个开源项目 github.com/foo/bar 48 个帖子 - 35 位参与者 阅读完整话题' },
  { name: '浏览数变化', pass_if: 'same',
    a: '某工具发布了 1200 次浏览', b: '某工具发布了 9800 次浏览' },
  { name: '相对时间变化', pass_if: 'same',
    a: '作者 3 小时前更新了文档', b: '作者 2 天前更新了文档' },
  { name: '纯空白与排版差异', pass_if: 'same',
    a: '标题\n\n正文   内容', b: '标题\n正文 内容' },
  { name: '版本号变化（实质更新）', pass_if: 'diff',
    a: '发布 v1.2.0，修复若干问题', b: '发布 v1.3.0，修复若干问题' },
  { name: '价格变化（实质更新）', pass_if: 'diff',
    a: '订阅价格 $20 每月', b: '订阅价格 $25 每月' },
  { name: '状态变化（实质更新）', pass_if: 'diff',
    a: '该功能已上线', b: '该功能已下线' },
];

let fail = 0;
console.log('内容指纹回归测试（PRD 7.3 / 23.1）\n');
for (const c of cases) {
  const [fa, fb] = [fingerprint(c.a), fingerprint(c.b)];
  const same = fa === fb;
  const ok = c.pass_if === 'same' ? same : !same;
  if (!ok) fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${c.name.padEnd(28)} 指纹${same ? '相同' : '不同'} (期望${c.pass_if === 'same' ? '相同' : '不同'})`);
  if (c.pass_if === 'diff') {
    const sig = substantive(c.b);
    console.log(`       实质更新信号: ${sig.join(', ') || '⚠️ 无（应至少命中一个）'}`);
    if (!sig.length) fail++;
  }
}
console.log(fail ? `\n❌ ${fail} 项失败` : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
