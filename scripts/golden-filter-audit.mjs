#!/usr/bin/env node
/** 离线核对确定性过滤规则是否误伤人工正例，不调用任何外部模型。 */
import { readFileSync } from 'node:fs';
import { applyDeterministicFilters } from '../packages/domain/src/filters.ts';

const file = process.env.GOLDEN_PATH ?? 'tests/golden/samples.json';
const all = JSON.parse(readFileSync(file, 'utf8'))
  .filter(s => s.labelSource === 'human_confirmed');
const positives = all.filter(s => s.expected.decision !== 'filter');
const negatives = all.filter(s => s.expected.decision === 'filter');

const predict = (s) => {
  const names = s.extracted?.signals ?? s.tags ?? [];
  const signals = Object.fromEntries(names.map(k => [k, true]));
  return applyDeterministicFilters({
    title: s.title ?? '', cleanText: s.body ?? '', signals,
    externalLinkCount: signals.external_link ? 1 : 0,
    isMandatory: s.expected.mandatoryClass !== 'none',
    alreadySentNoUpdate: false, duplicateCanonical: false,
  });
};

const falseHits = positives.map(s => ({ sample: s, hit: predict(s) })).filter(x => x.hit);
const trueHits = negatives.map(s => ({ sample: s, hit: predict(s) })).filter(x => x.hit);
console.log(`人工确认样本 ${all.length}：正例 ${positives.length}，负例 ${negatives.length}`);
console.log(`确定性规则误伤正例 ${falseHits.length} 条`);
for (const x of falseHits)
  console.log(`  ❌ ${x.sample.id} ${x.hit.ruleId} ${x.sample.title}`);
console.log(`确定性规则直接命中负例 ${trueHits.length}/${negatives.length} 条（其余交给 AI）`);
for (const x of trueHits)
  console.log(`  ✅ ${x.sample.id} ${x.hit.ruleId} ${x.sample.title}`);
process.exit(falseHits.length ? 1 : 0);
