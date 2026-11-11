/**
 * 核心要点选取（PRD 9.1）。
 *
 * 【为什么不是简单取分数前 N】
 * 纯按分数排序会让要点全部落在一两个高分分区，其余分区在要点里完全
 * 不出现 —— 读者看完要点以为已经读完，实际漏掉整块内容。所以先给每个
 * 有条目的分区留一个名额（该分区最高分那条），再把剩余名额按分数补给
 * 全局次高的条目，最后按分区在简报中的固定顺序排列。
 *
 * 同一分区里若有多条讲同一类事，合并成一句，避免要点里连着两行
 * 说几乎相同的事。
 */
export type HighlightItem = { section: string; score: number; conclusion: string };

/**
 * 求两条结论的共同主体（最长公共前缀）。
 *
 * 早先用「首个标点前的片段」当主体，但真实结论开头往往整句没有标点
 * （「PM 公益站清理零调用账号」），主体永远取到整句，合并从不触发。
 * 公共前缀能稳定抓住共同的行为主体。
 *
 * 返回 null 表示不构成可合并的同一主体。
 */
export function commonSubject(a: string, b: string): string | null {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  let p = a.slice(0, n);

  // 不能把拉丁词切成两半：「OpenAI」与「OpenClip」的公共前缀「Open」不是主体
  if (/[A-Za-z0-9]/.test(a[n] ?? '') || /[A-Za-z0-9]/.test(b[n] ?? ''))
    p = p.replace(/[A-Za-z0-9]+$/, '');
  // 前缀末尾的连接词/标点不属于主体
  p = p.replace(/[\s、，,。：:；;（(的了在为与和把对将新]+$/, '');

  return p.trim().length >= 3 ? p.trim() : null;
}

/**
 * 合并同分区里主体相同的要点。
 *
 * 判据保守是有意的：合并错了比不合并更糟 —— 读者会以为两件事是一件。
 * 因此只在「同分区 + 共同主体 ≥3 字」时合并，且合并后保留各自的完整
 * 谓语，不做归纳改写（改写等于凭空生成内容）。
 */
export function mergeSameKind(list: HighlightItem[]): string[] {
  const out: string[] = [];
  const used = new Set<number>();
  for (let a = 0; a < list.length; a++) {
    if (used.has(a)) continue;
    const ia = list[a]!;
    let text = ia.conclusion;
    for (let b = a + 1; b < list.length; b++) {
      const ib = list[b]!;
      if (used.has(b) || ib.section !== ia.section) continue;
      const subj = commonSubject(ia.conclusion, ib.conclusion);
      if (!subj) continue;
      // 去掉重复的主体，只接上后一条的谓语部分
      const rest = ib.conclusion.slice(subj.length).replace(/^[\s、，,：:]+/, '');
      text += `；另${rest || ib.conclusion}`;
      used.add(b);
    }
    out.push(text);
  }
  return out;
}

/**
 * 选出核心要点。`sectionIds` 决定分区的固定顺序。
 * 返回条数可能少于 max（内容不足时如实反映，不用旧消息凑数）。
 */
export function pickHighlights<T extends HighlightItem>(
  items: T[], sectionIds: string[], max: number,
): string[] {
  const byScore = [...items].sort((a, b) => b.score - a.score);
  const order = new Map(sectionIds.map((id, i) => [id, i] as const));

  const picked: T[] = [];
  const seen = new Set<T>();
  for (const id of sectionIds) {                    // 每分区先占一个名额
    const top = byScore.find(i => i.section === id);
    if (top) { picked.push(top); seen.add(top); }
  }
  for (const i of byScore) {                        // 余额按分数补
    if (picked.length >= max) break;
    if (!seen.has(i)) { picked.push(i); seen.add(i); }
  }
  picked.sort((a, b) => (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99)
                     || b.score - a.score);
  return mergeSameKind(picked.slice(0, max));
}
