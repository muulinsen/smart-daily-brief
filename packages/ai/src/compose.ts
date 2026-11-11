import { errorText } from './errors.ts';
import type { Provider, CompleteResult } from './types.ts';
import { ProviderError } from './types.ts';
import { COMPOSE_SCHEMA, validate, type ComposeResult } from './schema.ts';

/**
 * 第二段：只为最终入选条目生成成品文案（PRD 9.2）。
 *
 * 复用优先：L2/L3 复核时已顺带产出 conclusion 与 summary_sentences，
 * 那些条目不再调模型 —— 它们恰好是最难、最贵的那批。
 */

export type ComposeInput = {
  candidateId: string;
  sourceName: string;
  sourceUrl: string | null;
  title: string;
  body: string;
  section: string;
  mandatoryClass: string;
  /** 同事件其他来源的贡献，用于「合并后列出各渠道贡献」（PRD 7.4） */
  contributions: Array<{ sourceName: string; url: string | null }>;
  /** 必须融入摘要正文的限制说明（PRD 9.2） */
  sourceLimitations: string[];
  /** 程序判定的来源事实，供模型决定是否点明来源局限（compose.md 表格） */
  sourceEvidence?: Record<string, boolean | string>;
  /** L2/L3 已产出的文案，有则直接复用 */
  precomposed?: { title?: string; conclusion: string; summarySentences: string[] } | null;
};

export type ComposeOutcome = {
  candidateId: string;
  result: ComposeResult | null;
  status: 'ok' | 'reused' | 'manual_audit';
  error?: string;
  attempts: number;
};

export type ComposeDeps = {
  provider: Provider;
  systemPrompt: string;
  batchSize: number;
  bodyCharsMax: number;
  outputTokensMax: number;
  /** 兼容线路的批次冷却时间；默认 0，不影响官方接口与测试。 */
  interBatchDelayMs?: number;
  /** 邮件里禁止出现的字段名（PRD 9.2），生成后校验 */
  forbiddenFields?: string[];
  onUsage?: (u: CompleteResult['usage'], model: string) => void;
};

/**
 * 成品文案的硬性校验（PRD 9.2）。
 * 模型很容易自作主张加「建议」「行动建议」这类字段或段落 ——
 * PRD 明令禁止，必须在进入邮件前拦下。
 */
export function checkComposed(r: ComposeResult, forbidden: string[] = []): string[] {
  const errs: string[] = [];
  if (!r.conclusion?.trim()) errs.push('conclusion 为空');
  if (r.conclusion && r.conclusion.length > 120) errs.push(`conclusion 超过 120 字（${r.conclusion.length}）`);
  const n = r.summary_sentences?.length ?? 0;
  if (n < 2 || n > 3) errs.push(`summary_sentences 应为 2–3 句，实为 ${n}`);

  const blob = [r.title, r.conclusion, ...(r.summary_sentences ?? [])].join('\n');
  for (const f of forbidden) {
    // 匹配「建议：」「行动建议:」这类字段式写法，而非正文中偶然出现的词
    if (new RegExp(`(^|\\n)\\s*${escapeRe(f)}\\s*[:：]`).test(blob))
      errs.push(`输出含 PRD 9.2 禁止的字段「${f}」`);
  }
  return errs;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 剥掉结论开头的空指代与结尾的元评论。
 *
 * 提示词里已明令禁止，但模型仍会写「这是一篇关于 X 的教程」——
 * 「这是一篇关于」六个字不给读者任何信息。同理「内容为技术分享、
 * 无推广或高风险信息」是系统内部的判定依据，不该出现在给人看的文字里。
 * 提示词负责质量，这里负责兜底。
 */
const LEAD_FILLER = /^(这|那)?(是一[篇个份条项款]|篇)?\s*(关于\s*)?|^(该|本|这)(文|篇文章|帖|贴|项目|工具|教程|方案|服务|产品|应用|库|插件|模型|站点)\s*(是|为|提供了?|介绍了?|讲述了?|描述了?|说明了?)?\s*/;
const META_TAIL = /[，,、;；]?\s*(内容)?(为|属于|系)?\s*(纯)?(技术分享|技术讨论|经验分享|个人分享|信息分享)?[，,]?\s*(无|不含|没有)(推广|广告|AFF|高风险信息|风险信息|营销内容)[^。]*。?$|[，,、]?\s*(属于|符合|不属于)[^。]{0,20}(可保留类别|收录标准|过滤条件)[^。]*。?$|[，,、]?\s*信息(增益|价值)(高|低|较高|较低)[^。]*。?$/g;

export function stripFiller(text: string): string {
  let t = String(text ?? '').trim();
  const before = t;
  t = t.replace(META_TAIL, '').trim();
  // 只在开头确实是空指代时剥离，且剥完不能把句子掏空
  const m = t.match(/^(这是一[篇个份条项款]|那是一[篇个份条项款]|该文|本文|该篇文章|这篇文章|该帖|该贴|该项目|该工具|该教程|该方案|该服务|该产品|该应用|该库|该插件|该模型|该站点)\s*(是|为|提供了?|介绍了?|讲述了?|描述了?|说明了?)?\s*(关于\s*)?/);
  if (m && t.length - m[0].length >= 12) t = t.slice(m[0].length).trim();
  t = t.replace(/^[，,、：:]\s*/, '').replace(/[，,、]$/, '');
  if (t && !/[。！？.!?]$/.test(t)) t += '。';
  return t.length >= 8 ? t : before;   // 剥过头就退回原文
}
void LEAD_FILLER;

export async function runCompose(
  items: ComposeInput[], deps: ComposeDeps,
): Promise<{ outcomes: ComposeOutcome[]; usedInput: number; usedOutput: number; calls: number }> {
  const outcomes: ComposeOutcome[] = [];
  let usedInput = 0, usedOutput = 0, calls = 0;

  // 1. 复用 L2/L3 已产出的文案
  const pending: ComposeInput[] = [];
  for (const it of items) {
    if (it.precomposed?.conclusion && (it.precomposed.summarySentences?.length ?? 0) >= 2) {
      outcomes.push({
        candidateId: it.candidateId, status: 'reused', attempts: 0,
        result: {
          candidate_id: it.candidateId, title: it.precomposed.title?.trim() || it.title,
          conclusion: it.precomposed.conclusion,
          summary_sentences: it.precomposed.summarySentences.slice(0, 3),
          source_limitations: it.sourceLimitations,
        },
      });
    } else pending.push(it);
  }

  // 2. 其余分批生成
  for (let i = 0; i < pending.length; i += deps.batchSize) {
    if (i > 0 && (deps.interBatchDelayMs ?? 0) > 0)
      await new Promise(resolve => setTimeout(resolve, deps.interBatchDelayMs));
    const batch = pending.slice(i, i + deps.batchSize);
    outcomes.push(...await composeBatch(batch, deps, (u, m) => {
      usedInput += u.inputTokens; usedOutput += u.outputTokens; calls++; deps.onUsage?.(u, m);
    }));
  }
  return { outcomes, usedInput, usedOutput, calls };
}

async function composeBatch(
  batch: ComposeInput[], deps: ComposeDeps,
  track: (u: CompleteResult['usage'], m: string) => void,
): Promise<ComposeOutcome[]> {
  let attempts = 0, lastErr = '';
  let lastKind: string | undefined;
  // 实测 3 条一批生成 3600+ 输出 token（含推理过程），原按 1200/条 会被截断。
  let outCap = Math.min(deps.outputTokensMax, Math.max(4000, batch.length * 3000));

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    // 截断时提高上限而非缩短输入（见 triage.ts 注释）
    const chars = attempt === 0 || lastKind === 'truncated'
      ? deps.bodyCharsMax : Math.floor(deps.bodyCharsMax / 3);
    if (lastKind === 'truncated') outCap = Math.min(deps.outputTokensMax, outCap * 3);
    const userContent = JSON.stringify({
      items: batch.map(b => ({
        candidate_id: b.candidateId,
        source: b.sourceName,
        url: b.sourceUrl,
        title: b.title,
        section: b.section,
        mandatory_class: b.mandatoryClass,
        must_disclose: b.sourceLimitations,
        source_evidence: b.sourceEvidence ?? {},
        other_sources: b.contributions.map(c => c.sourceName),
        body: b.body.slice(0, chars),
      })),
    });

    let res: CompleteResult;
    try {
      res = await deps.provider.complete({
        systemPrompt: deps.systemPrompt, userContent,
        schema: COMPOSE_SCHEMA, schemaName: 'compose',
        maxOutputTokens: outCap,
        cachePrefix: true,
      });
    } catch (e) {
      const pe = e as ProviderError;
      lastErr = errorText(pe);
      lastKind = pe instanceof ProviderError ? pe.kind : undefined;
      if (pe instanceof ProviderError && !pe.retryable && pe.kind !== 'bad_request') break;
      continue;
    }
    track(res.usage, res.model);

    const errs = validate(res.data, COMPOSE_SCHEMA);
    if (errs.length) { lastErr = `Schema 校验失败: ${errs.slice(0, 3).join('; ')}`; lastKind = 'schema'; continue; }

    const byId = new Map<string, ComposeResult>(
      (res.data as any).results.map((r: ComposeResult) => [r.candidate_id, r]));
    const missing = batch.filter(b => !byId.has(b.candidateId));
    if (missing.length) { lastErr = `模型漏写 ${missing.length} 条文案`; lastKind = 'schema'; continue; }

    // PRD 9.2 字段禁令校验
    const bad: string[] = [];
    for (const b of batch) {
      const e = checkComposed(byId.get(b.candidateId)!, deps.forbiddenFields);
      if (e.length) bad.push(`${b.candidateId}: ${e.join('; ')}`);
    }
    if (bad.length) { lastErr = bad.slice(0, 2).join(' | '); lastKind = 'schema'; continue; }

    return batch.map(b => {
      const r = byId.get(b.candidateId)!;
      return { candidateId: b.candidateId, attempts, status: 'ok' as const,
        result: { ...r, conclusion: stripFiller(r.conclusion),
                  summary_sentences: r.summary_sentences.map(stripFiller) } };
    });
  }

  return batch.map(b => ({
    candidateId: b.candidateId, result: null, status: 'manual_audit' as const, attempts, error: lastErr,
  }));
}
