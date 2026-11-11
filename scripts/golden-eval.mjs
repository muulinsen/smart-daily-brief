#!/usr/bin/env node
// 离线评估：用当前 Prompt + 模型跑黄金集，出 PRD 15.7 五项指标并判定发布闸门。
//   node scripts/golden-eval.mjs                 用配置的供应商（默认 mock）
//   node scripts/golden-eval.mjs --baseline f.json  与基线对比
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadGolden, confirmedOnly, evaluate, checkGate, formatReport } from '../packages/domain/src/golden.ts';
import { loadRules } from '../packages/domain/src/rules.ts';
import { createProvider, providerFromEnv } from '../packages/ai/src/registry.ts';
import { runTriage } from '../packages/ai/src/triage.ts';
import { extractSignals, prescreenMandatory } from '../packages/domain/src/signals.ts';

const argv = process.argv.slice(2);
// 默认包含机器预标注。人工确认后可加 --confirmed-only 得到更严格的基线。
const ALL = !argv.includes('--confirmed-only');
const basePath = argv.includes('--baseline') ? argv[argv.indexOf('--baseline')+1] : null;
const savePath = argv.includes('--save') ? argv[argv.indexOf('--save')+1] : null;

const GOLDEN = process.env.GOLDEN_PATH
  ?? (process.env.DATABASE_PATH?.startsWith('/var/lib/') ? '/var/lib/briefing/golden.json'
                                                        : 'tests/golden/samples.json');
const raw = loadGolden(GOLDEN);
const samples = ALL ? raw : confirmedOnly(raw);
if (!samples.length) {
  console.log(`黄金集中没有${ALL ? '' : '人工确认的'}样本。`);
  console.log('先跑 node scripts/golden-seed.mjs 生成草稿，再用 golden-label.mjs 逐条确认。');
  console.log('（加 --include-unconfirmed 可用机器预标注试跑，但结果不能作为回归基线）');
  process.exit(0);
}

const rules = loadRules();
const cfg = providerFromEnv('L1');
const provider = await createProvider(cfg);
const prompt = readFileSync('config/prompts/triage.md', 'utf8');
const host = { linuxdo:'linux.do', v2ex:'v2ex.com', elsewhere:'elsewhere.news' };

const cands = samples.map(s => {
  // 优先用样本里固化的抽取结果 —— 从 body 重抽会丢掉 HTML 中的链接信号
  const e = s.extracted;
  const d = e ? null : extractSignals(s.body, '', host[s.source] ?? '');
  return { candidateId: s.id, sourceId: s.source, sourceKind: 'forum', title: s.title,
    publishedAt: null, url: s.url ?? null, body: s.body,
    signals: e ? e.signals : Object.entries(d.signals).filter(([,v])=>v).map(([k])=>k),
    repos: e ? e.repos : d.repos,
    officialLinks: e ? e.officialLinks : d.officialLinks,
    prescreenClasses: e ? e.prescreenClasses : prescreenMandatory(d.signals),
    contentHash: s.id };
});

const conf = raw.filter(s => s.labelSource === 'human_confirmed').length;
console.log(`供应商 ${cfg.provider}${cfg.model ? '/'+cfg.model : ''} | 样本 ${samples.length} 条` +
  (ALL ? `（其中人工确认 ${conf} 条）` : '') + '\n');
if (ALL && conf < samples.length)
  console.log('注意：机器预标注的期望值来自程序预判，因此本报告衡量的是\n' +
              '「模型是否与确定性预判一致」，不是真实召回率。它能抓出模型\n' +
              '推翻硬证据的情形（主要漏项风险），但无法验证预判本身是否正确。\n');

const rep = await runTriage(cands, {
  provider, systemPrompt: prompt,
  budget: { inputTokensMax: 1e9, outputTokensMax: 1e9, batchSize: 8, bodyCharsMax: 6000 },
  highRiskKeywords: (rules.high_risk?.domains ?? []).flatMap(d => d.keywords ?? []),
  majorNewsTypes: rules.major_news_types ?? [],
});

const predicted = rep.outcomes.map(o => ({
  id: o.candidateId,
  decision: o.escalate ? 'escalate' : (o.result?.decision ?? 'escalate'),
  mandatoryClass: o.result?.mandatory_class ?? 'none',
  eventKey: o.result?.event_key ?? null,
  summary: null,
}));

const m = evaluate(samples, predicted);
const baseline = basePath && existsSync(basePath) ? JSON.parse(readFileSync(basePath,'utf8')) : undefined;
const gate = checkGate(m, undefined, baseline);
console.log(formatReport(m, gate));
if (savePath) { writeFileSync(savePath, JSON.stringify(m, null, 2)); console.log(`\n指标已存至 ${savePath}`); }
process.exit(gate.pass ? 0 : 1);
