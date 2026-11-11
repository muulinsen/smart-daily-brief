import { readFileSync, existsSync } from 'node:fs';

/**
 * 黄金样本集与离线评估（PRD 15.7 / 23.3 / 24.1）。
 *
 * 存在的理由：这套系统的核心价值是「不漏项」，而漏项是最难事后发现的
 * 失败 —— 漏了你根本不知道漏了。没有标注基线，改 Prompt 或换模型时
 * 只能靠感觉判断好坏。PRD 24.1 因此规定：强制保留召回率跌破阈值
 * 直接阻断发布。
 */

export type GoldenSample = {
  id: string;
  source: string;
  url?: string | null;
  title: string;
  body: string;
  /** 正文是否为 RSS 摘要。true 的样本不能用于校验 A–D 召回 */
  bodyIsExcerpt?: boolean;
  expected: {
    decision: 'retain' | 'normal' | 'filter';
    mandatoryClass: 'A' | 'B' | 'C' | 'D' | 'none';
    section?: string | null;
    /** decision=filter 时必须给出具体规则 ID */
    filterRuleId?: string | null;
    /** 同事件的其他样本 id，用于聚类准确率 */
    sameEventAs?: string[];
    /** 摘要必须提及的事实要点，用于事实一致性检查 */
    mustMention?: string[];
  };
  /**
   * 固化的确定性抽取结果。黄金集评估的是 AI 层，抽取器有独立单测；
   * 若评估时从 body 重抽，HTML 中的链接信号会丢失导致指标失真。
   */
  extracted?: { signals: string[]; repos: string[]; officialLinks: string[]; prescreenClasses: string[] };
  /** 只有 human_confirmed 计入回归 */
  labelSource: 'machine_proposed' | 'human_confirmed';
  note?: string;
  tags?: string[];
};

export type Predicted = {
  id: string;
  decision: string;
  mandatoryClass: string;
  section?: string | null;
  filterRuleId?: string | null;
  eventKey?: string | null;
  summary?: string | null;
};

export type Metrics = {
  sampleCount: number;
  /** 强制保留召回率 —— PRD 24.1 要求 ≥98%，跌破即阻断发布 */
  mandatoryRecall: number;
  mandatoryRecallDetail: { expected: number; recovered: number; missed: string[] };
  /** 错误过滤率：本该收录却被判 filter 的比例 */
  wrongFilterRate: number;
  wrongFiltered: string[];
  /** 分类准确率（A–D 判对） */
  classAccuracy: number;
  /** 事件聚类准确率 */
  clusterAccuracy: number;
  clusterErrors: string[];
  /** 摘要事实一致性：mustMention 覆盖率 */
  factConsistency: number;
  factMisses: string[];
};

export function loadGolden(path: string): GoldenSample[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? raw as GoldenSample[] : [];
}

/** 只有人工确认的样本才计入回归（PRD 23.3）。 */
export const confirmedOnly = (s: GoldenSample[]) => s.filter(x => x.labelSource === 'human_confirmed');

export function evaluate(samples: GoldenSample[], predicted: Predicted[]): Metrics {
  const byId = new Map(predicted.map(p => [p.id, p]));

  // --- 强制保留召回 ---
  // 只用非摘要样本：正文是 RSS 摘要时证据本就不全，据此算召回会失真
  const mandatorySamples = samples.filter(
    s => s.expected.mandatoryClass !== 'none' && !s.bodyIsExcerpt);
  const missed: string[] = [];
  let recovered = 0;
  for (const s of mandatorySamples) {
    const p = byId.get(s.id);
    // 判为 retain 或 escalate 都算「没漏」—— escalate 会进人工复核
    if (p && (p.decision === 'retain' || p.decision === 'escalate')) recovered++;
    else missed.push(`${s.id}(${s.expected.mandatoryClass})`);
  }

  // --- 错误过滤：本该收录却被 filter ---
  const shouldKeep = samples.filter(s => s.expected.decision !== 'filter');
  const wrongFiltered = shouldKeep
    .filter(s => byId.get(s.id)?.decision === 'filter').map(s => s.id);

  // --- 分类准确率 ---
  const classified = samples.filter(s => byId.has(s.id));
  const classHits = classified.filter(
    s => byId.get(s.id)!.mandatoryClass === s.expected.mandatoryClass).length;

  // --- 聚类准确率：同事件应同 key，不同事件应不同 key ---
  const clusterErrors: string[] = [];
  let clusterPairs = 0, clusterHits = 0;
  for (const s of samples) {
    const p = byId.get(s.id); if (!p?.eventKey) continue;
    for (const otherId of s.expected.sameEventAs ?? []) {
      const q = byId.get(otherId); if (!q?.eventKey) continue;
      clusterPairs++;
      if (p.eventKey === q.eventKey) clusterHits++;
      else clusterErrors.push(`漏聚类 ${s.id}↔${otherId}`);
    }
  }
  // 反向：未标注同事件的样本对不应共享 event_key
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i]!, b = samples[j]!;
      if ((a.expected.sameEventAs ?? []).includes(b.id)) continue;
      if ((b.expected.sameEventAs ?? []).includes(a.id)) continue;
      const pa = byId.get(a.id), pb = byId.get(b.id);
      if (!pa?.eventKey || !pb?.eventKey) continue;
      clusterPairs++;
      if (pa.eventKey !== pb.eventKey) clusterHits++;
      else clusterErrors.push(`误聚类 ${a.id}↔${b.id}`);
    }
  }

  // --- 摘要事实一致性 ---
  const factMisses: string[] = [];
  let factTotal = 0, factHits = 0;
  for (const s of samples) {
    const p = byId.get(s.id);
    for (const m of s.expected.mustMention ?? []) {
      factTotal++;
      if (p?.summary?.includes(m)) factHits++;
      else factMisses.push(`${s.id}: 未提及「${m}」`);
    }
  }

  return {
    sampleCount: samples.length,
    mandatoryRecall: mandatorySamples.length ? recovered / mandatorySamples.length : 1,
    mandatoryRecallDetail: { expected: mandatorySamples.length, recovered, missed },
    wrongFilterRate: shouldKeep.length ? wrongFiltered.length / shouldKeep.length : 0,
    wrongFiltered,
    classAccuracy: classified.length ? classHits / classified.length : 1,
    clusterAccuracy: clusterPairs ? clusterHits / clusterPairs : 1,
    clusterErrors: clusterErrors.slice(0, 20),
    factConsistency: factTotal ? factHits / factTotal : 1,
    factMisses: factMisses.slice(0, 20),
  };
}

export type Gate = { pass: boolean; failures: string[]; warnings: string[] };

/**
 * 发布闸门（PRD 24.1 P0）。
 * 强制保留召回率是硬指标 —— 跌破即阻断，不接受「其他指标都变好了」的抵消。
 */
export function checkGate(
  m: Metrics,
  thresholds = { mandatoryRecall: 0.98, wrongFilterRate: 0.05,
                 clusterAccuracy: 0.9, factConsistency: 0.95 },
  baseline?: Metrics,
): Gate {
  const failures: string[] = [], warnings: string[] = [];

  if (m.mandatoryRecallDetail.expected === 0)
    warnings.push('黄金集中没有强制保留样本，召回率未被验证 —— 这是覆盖度缺口，不是通过');
  else if (m.mandatoryRecall < thresholds.mandatoryRecall)
    failures.push(`强制保留召回率 ${(m.mandatoryRecall * 100).toFixed(1)}% < ${thresholds.mandatoryRecall * 100}%` +
                  `（漏：${m.mandatoryRecallDetail.missed.join(', ')}）`);

  if (m.wrongFilterRate > thresholds.wrongFilterRate)
    failures.push(`错误过滤率 ${(m.wrongFilterRate * 100).toFixed(1)}% > ${thresholds.wrongFilterRate * 100}%`);
  if (m.clusterAccuracy < thresholds.clusterAccuracy)
    warnings.push(`事件聚类准确率 ${(m.clusterAccuracy * 100).toFixed(1)}% 偏低`);
  if (m.factConsistency < thresholds.factConsistency)
    failures.push(`摘要事实一致性 ${(m.factConsistency * 100).toFixed(1)}% < ${thresholds.factConsistency * 100}%`);

  // 与基线对比：召回率下降即阻断（PRD 23.3）
  if (baseline && m.mandatoryRecall < baseline.mandatoryRecall - 1e-9)
    failures.push(`强制保留召回率较基线下降 ` +
      `${(baseline.mandatoryRecall * 100).toFixed(1)}% → ${(m.mandatoryRecall * 100).toFixed(1)}%`);

  return { pass: failures.length === 0, failures, warnings };
}

export function formatReport(m: Metrics, g: Gate): string {
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const L = [
    `样本 ${m.sampleCount} 条`,
    `  强制保留召回率   ${pct(m.mandatoryRecall)}  (${m.mandatoryRecallDetail.recovered}/${m.mandatoryRecallDetail.expected})`,
    `  错误过滤率       ${pct(m.wrongFilterRate)}  (${m.wrongFiltered.length} 条)`,
    `  分类准确率       ${pct(m.classAccuracy)}`,
    `  事件聚类准确率   ${pct(m.clusterAccuracy)}`,
    `  摘要事实一致性   ${pct(m.factConsistency)}`,
  ];
  if (m.mandatoryRecallDetail.missed.length)
    L.push(`  漏掉的强制保留项: ${m.mandatoryRecallDetail.missed.join(', ')}`);
  if (m.wrongFiltered.length) L.push(`  被错误过滤: ${m.wrongFiltered.join(', ')}`);
  if (m.clusterErrors.length) L.push(`  聚类错误: ${m.clusterErrors.slice(0, 5).join('; ')}`);
  if (m.factMisses.length) L.push(`  事实缺失: ${m.factMisses.slice(0, 5).join('; ')}`);
  L.push('');
  g.warnings.forEach(w => L.push(`  ⚠️  ${w}`));
  g.failures.forEach(f => L.push(`  ❌ ${f}`));
  L.push(g.pass ? '  ✅ 闸门通过' : '  ⛔ 闸门未通过，阻断发布');
  return L.join('\n');
}
