import { loadRules } from './rules.ts';

/**
 * 高风险领域匹配（PRD 8.5）。
 *
 * 中文没有词边界，短词做子串匹配极易误伤：实测「量化」会命中
 * 「轻量化控制」、「币」命中「港币」、「加密」命中「HTTPS 加密连接」。
 * 误触发的代价是把大量普通内容送去更贵的复核模型（实测 7 条里 6 条是误伤）。
 *
 * 因此分两类：
 *   keywords         语义明确的长词，直接子串匹配
 *   guarded_keywords 易误伤的短词，要求紧邻字符不在排除表里
 */

export type Guard = { term: string; exclude_before?: string[]; exclude_after?: string[] };

/** 判断某个受保护词在文本中是否有一次「真实」出现。 */
export function guardedHit(text: string, g: Guard): boolean {
  const before = new Set(g.exclude_before ?? []);
  const after = new Set(g.exclude_after ?? []);
  let i = text.indexOf(g.term);
  while (i !== -1) {
    const prev = i > 0 ? text[i - 1]! : '';
    const rest = text.slice(i + g.term.length);
    // exclude_after 的元素可能是多字词（如「连接」「控制」），用前缀判断
    const blockedAfter = [...after].some(a => rest.startsWith(a));
    const blockedBefore = before.has(prev);
    if (!blockedBefore && !blockedAfter) return true;   // 找到一次未被排除的出现
    i = text.indexOf(g.term, i + 1);
  }
  return false;
}

export type RiskHit = { domainId: string; terms: string[]; disclosure: string };

/** 返回命中的高风险领域。空数组表示不涉及高风险。 */
export function matchHighRisk(text: string): RiskHit[] {
  const domains = loadRules().high_risk?.domains ?? [];
  const out: RiskHit[] = [];
  for (const d of domains) {
    const terms: string[] = [];
    for (const k of d.keywords ?? []) if (text.includes(k)) terms.push(k);
    for (const g of d.guarded_keywords ?? []) if (guardedHit(text, g)) terms.push(g.term);
    if (terms.length) out.push({ domainId: d.id, terms, disclosure: d.disclosure ?? '' });
  }
  return out;
}

/** 供编排器使用的简化判断。 */
export const isHighRisk = (text: string): boolean => matchHighRisk(text).length > 0;
