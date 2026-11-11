#!/usr/bin/env node
// 交互式标注：node scripts/golden-label.mjs [--filter A|B|C|D|none|unlabeled]
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const FILE = 'tests/golden/samples.json';
const all = JSON.parse(readFileSync(FILE, 'utf8'));
const f = process.argv.includes('--filter') ? process.argv[process.argv.indexOf('--filter')+1] : 'unlabeled';
const queue = all.filter(s => f === 'unlabeled'
  ? s.labelSource === 'machine_proposed'
  : s.expected.mandatoryClass === f);

if (!queue.length) { console.log('没有待标注样本'); process.exit(0); }
const rl = createInterface({ input: stdin, output: stdout });
const save = () => writeFileSync(FILE, JSON.stringify(all, null, 2));

console.log(`待标注 ${queue.length} 条。命令：`);
console.log('  回车=接受预标注  a/b/c/d=改为该类  n=普通  f=过滤  s=跳过  q=保存退出');
console.log('  e <id>=标记与某条同事件   m <文本>=加一条必须提及的事实\n');

let i = 0;
for (const s of queue) {
  i++;
  console.log('─'.repeat(70));
  console.log(`[${i}/${queue.length}] ${s.id}  来源 ${s.source}${s.bodyIsExcerpt ? '  ⚠️ 正文为摘要' : ''}`);
  console.log(`标题: ${s.title}`);
  console.log(`正文: ${String(s.body).replace(/\s+/g,' ').slice(0, 220)}...`);
  console.log(`信号: ${(s.tags ?? []).join(' ') || '（无）'}`);
  console.log(`预标注: decision=${s.expected.decision} class=${s.expected.mandatoryClass}`);

  let done = false;
  while (!done) {
    const a = (await rl.question('> ')).trim();
    if (a === 'q') { save(); console.log(`已保存，本次确认 ${i-1} 条`); rl.close(); process.exit(0); }
    if (a === 's') { done = true; continue; }
    if (a.startsWith('e ')) { (s.expected.sameEventAs ??= []).push(a.slice(2).trim()); console.log('  已记同事件'); continue; }
    if (a.startsWith('m ')) { (s.expected.mustMention ??= []).push(a.slice(2).trim()); console.log('  已记必提事实'); continue; }
    if (/^[abcd]$/i.test(a)) { s.expected.mandatoryClass = a.toUpperCase(); s.expected.decision = 'retain'; }
    else if (a === 'n') { s.expected.mandatoryClass = 'none'; s.expected.decision = 'normal'; }
    else if (a === 'f') {
      s.expected.mandatoryClass = 'none'; s.expected.decision = 'filter';
      s.expected.filterRuleId = (await rl.question('  过滤规则 ID (DF-xxx): ')).trim() || null;
    } else if (a !== '') { console.log('  无法识别，重输'); continue; }
    s.labelSource = 'human_confirmed';
    save();
    done = true;
  }
}
save();
console.log(`\n完成，共确认 ${queue.filter(s=>s.labelSource==='human_confirmed').length} 条`);
rl.close();
