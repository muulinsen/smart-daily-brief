import { errorText } from './errors.ts';
import type { Provider, CompleteResult, JsonSchema } from './types.ts';
import { ProviderError } from './types.ts';
import { validate } from './schema.ts';
import type { Candidate } from './triage.ts';
import type { FactEvidence } from './fact-trace.ts';

/**
 * L2/L3 复核编排器（PRD 15.1 / 15.4）。
 *
 * 与 L1 的三点不同：
 *  1. 逐条处理，不分批 —— 这些是难case，且预算按「最多 N 条」限制。
 *  2. 名额有限时必须按重要性排序，不能先到先得（PRD 15.5：超预算时
 *     继续完成强制保留和高风险项，普通低分候选延迟到人工审阅）。
 *  3. L3 失败不再升级，直接转人工（PRD 15.1 表格 l3_on_failure）。
 */

export const REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate_id', 'decision', 'mandatory_class', 'section', 'event_key',
             'confidence', 'filter_reason', 'conflicts', 'source_limitations',
             'needs_higher_tier', 'higher_tier_reasons', 'conclusion',
             'summary_sentences'],
  properties: {
    candidate_id: { type: 'string' },
    decision: { type: 'string', enum: ['retain', 'normal', 'filter'] },
    mandatory_class: { type: 'string', enum: ['A', 'B', 'C', 'D', 'none'] },
    section: { type: 'string',
      enum: ['ai_tech', 'open_source_project', 'developer_product', 'quality_article', 'society_life'] },
    event_key: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    filter_reason: { type: ['string', 'null'] },
    /** 发现的事实冲突。空数组表示未发现冲突。 */
    conflicts: { type: 'array', items: { type: 'string' } },
    /** 来源限制说明，后续必须融入摘要正文（PRD 9.2） */
    source_limitations: { type: 'array', items: { type: 'string' } },
    /** L2 判断是否仍需 L3。L3 层此字段被忽略。 */
    needs_higher_tier: { type: 'boolean' },
    higher_tier_reasons: { type: 'array', items: { type: 'string' } },
    /** 复核层顺带产出的成品文案，可供 compose 复用，避免重复调用 */
    conclusion: { type: ['string', 'null'], maxLength: 120 },
    summary_sentences: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 3 },
  },
};

export type ReviewResult = {
  candidate_id: string;
  decision: 'retain' | 'normal' | 'filter';
  mandatory_class: 'A' | 'B' | 'C' | 'D' | 'none';
  section: string;
  event_key: string;
  confidence: number;
  filter_reason: string | null;
  conflicts: string[];
  source_limitations: string[];
  needs_higher_tier: boolean;
  higher_tier_reasons: string[];
  conclusion?: string | null;
  summary_sentences?: string[] | null;
};

export type ReviewInput = Candidate & {
  /** L1 的判定结果，作为复核的起点 */
  priorDecision: string;
  priorConfidence: number;
  /** 触发升级的规则 */
  escalationRules: string[];
  /** 同事件的其他来源条目，供交叉核验（PRD 15.1 L2「多来源合并」） */
  siblings?: Array<{ sourceId: string; title: string; excerpt: string; url: string | null }>;
  /** 联网取得的原始链接状态与公开搜索结果，仅作事实比对证据。 */
  webEvidence?: FactEvidence;
  /** 已有合格 L2 结果但 L3 失败时，直接从 L3 续跑，避免重做并覆盖 L2。 */
  resumeTier?: 'L2' | 'L3';
};

export type ReviewOutcome = {
  candidateId: string;
  tier: 'L2' | 'L3';
  result: ReviewResult | null;
  status: 'ok' | 'manual_audit' | 'skipped';
  /** L2 之后是否还要送 L3 */
  promote: boolean;
  promoteRules: string[];
  error?: string;
  attempts: number;
  responseId?: string;
};

export type TierBudget = { maxItems: number; inputTokensMax: number; outputTokensMax: number };

/** 同时在途的复核请求数。1 = 顺序执行（旧行为）。 */
export const DEFAULT_REVIEW_CONCURRENCY = 3;

export type ReviewDeps = {
  l2: { provider: Provider; budget: TierBudget };
  l3: { provider: Provider; budget: TierBudget };
  systemPrompt: string;
  bodyCharsMax: number;
  /** 高风险关键词，用于 ESC-102 与优先级排序 */
  highRiskKeywords?: string[];
  /** 带守卫的高风险判定；未提供时退回裸关键词匹配 */
  isHighRisk?: (text: string) => boolean;
  onUsage?: (tier: 'L2' | 'L3', u: CompleteResult['usage'], model: string) => void;
  /** 同时在途的复核请求数，默认 1（顺序）。见 runTier 注释。 */
  concurrency?: number;
  /** 人工正例归纳出的无效过滤理由。L2 命中则升 L3，L3 命中则回退 normal。 */
  invalidFilterReasonFragments?: string[];
};

export type ReviewReport = {
  outcomes: ReviewOutcome[];
  l2Used: { items: number; input: number; output: number };
  l3Used: { items: number; input: number; output: number };
  /** 因名额不足未能复核，转人工审阅的候选 */
  deferred: string[];
};

const estTokens = (s: string) => Math.ceil(s.length / 2.2);

/**
 * 名额有限时的优先级（PRD 15.5）。数字越小越优先。
 *
 * ESC-005 排在最前是刻意的：强制保留预判命中、模型却判为过滤，
 * 这是唯一可能造成「该收录却漏掉」的情形，而漏项是本系统最难
 * 事后发现的失败（PRD 24.1 要求召回率 ≥98%）。宁可挤掉低置信条目。
 */
export function priorityOf(
  c: ReviewInput, highRisk: string[] = [], isHighRisk?: (t: string) => boolean,
): number {
  if (c.escalationRules.includes('ESC-005')) return 0;   // 可能漏掉强制保留项
  if (c.prescreenClasses.length > 0) return 1;           // 其他强制保留候选
  const hay = `${c.title}\n${c.body}`;
  const risky = isHighRisk ? isHighRisk(hay) : highRisk.some(k => hay.includes(k));
  if (risky) return 2;                                   // 高风险领域
  if (c.escalationRules.includes('ESC-003')) return 3;   // 重大新闻
  if (c.escalationRules.includes('ESC-004')) return 4;   // 来源冲突
  return 5;                                              // 低置信等
}

/** L2 → L3 升级判定（rules.yaml escalation.l2_to_l3）。 */
export function shouldPromoteToL3(
  c: ReviewInput, r: ReviewResult, highRisk: string[] = [],
  isHighRisk?: (t: string) => boolean,
): { promote: boolean; rules: string[] } {
  const rules: string[] = [];
  if (r.conflicts.length > 0) rules.push('ESC-101');      // 复核后仍存冲突
  const hay = `${c.title}\n${c.body}`;
  const hasNumbers = /\d+(\.\d+)?\s*(%|％|倍|万|亿|美元|元|人|例)/.test(hay);
  const risky = isHighRisk ? isHighRisk(hay) : highRisk.some(k => hay.includes(k));
  if (risky && hasNumbers) rules.push('ESC-102');
  if (r.needs_higher_tier) rules.push('ESC-103');
  return { promote: rules.length > 0, rules: [...new Set(rules)] };
}

function buildUserContent(c: ReviewInput, bodyChars: number): string {
  return JSON.stringify({
    current_date: new Date().toISOString().slice(0, 10),
    candidate_id: c.candidateId,
    source: c.sourceId,
    title: c.title,
    published_at: c.publishedAt,
    url: c.url,
    extracted: { repos: c.repos.slice(0, 5), official_links: c.officialLinks.slice(0, 5), signals: c.signals },
    rule_prescreen: { mandatory_classes: c.prescreenClasses },
    l1_result: { decision: c.priorDecision, confidence: c.priorConfidence },
    escalation_rules: c.escalationRules,
    siblings: (c.siblings ?? []).slice(0, 4),
    web_evidence: c.webEvidence ?? null,
    body: c.body.slice(0, bodyChars),
  });
}

async function reviewOne(
  c: ReviewInput, tier: 'L2' | 'L3', deps: ReviewDeps,
  track: (u: CompleteResult['usage'], m: string) => void,
): Promise<ReviewOutcome> {
  const { provider, budget } = tier === 'L2' ? deps.l2 : deps.l3;
  let attempts = 0, lastErr = '';
  let lastKind: string | undefined;
  // 单条复核只需判定与 2–3 句摘要。过大的 max_tokens 会让部分兼容线路
  // 预留过多上游资源并返回 502；保持充足余量，同时避免无意义的 5k–8k 上限。
  let outCap = Math.min(budget.outputTokensMax, tier === 'L3' ? 3000 : 2000);

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    const chars = attempt === 0 || lastKind === 'truncated'
      ? deps.bodyCharsMax : Math.floor(deps.bodyCharsMax / 3);
    if (lastKind === 'truncated') outCap = Math.min(budget.outputTokensMax, outCap * 2);
    let res: CompleteResult;
    try {
      res = await provider.complete({
        systemPrompt: deps.systemPrompt + `\n\n当前复核层级：${tier}。`,
        userContent: buildUserContent(c, chars),
        schema: REVIEW_SCHEMA,
        schemaName: 'review',
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

    const errs = validate(res.data, REVIEW_SCHEMA);
    if (errs.length) { lastErr = `Schema 校验失败: ${errs.slice(0, 3).join('; ')}`; lastKind = 'schema'; continue; }

    let r = res.data as ReviewResult;
    if (r.candidate_id !== c.candidateId) {
      lastErr = `candidate_id 不匹配：期望 ${c.candidateId}，返回的 ID 不在输入中`;
      lastKind = 'schema';
      continue;
    }
    const badReason = r.decision === 'filter' && r.filter_reason
      ? (deps.invalidFilterReasonFragments ?? []).find(x => r.filter_reason!.includes(x))
      : null;
    if (badReason && tier === 'L2') {
      r = { ...r, needs_higher_tier: true,
        higher_tier_reasons: [...r.higher_tier_reasons, `过滤理由命中人工正例保护：${badReason}`] };
    } else if (badReason && tier === 'L3') {
      // 两层模型仍只给出被人工明确否定的理由时，宁可进入普通排序，
      // 不能让无效理由造成不可见的最终漏项。
      r = { ...r, decision: 'normal', mandatory_class: 'none', filter_reason: null,
        needs_higher_tier: false, higher_tier_reasons: [] };
    }
    // L2 才判断是否上 L3；L3 之后不再升级（PRD 15.1）
    const p = tier === 'L2'
      ? shouldPromoteToL3(c, r, deps.highRiskKeywords, deps.isHighRisk)
      : { promote: false, rules: [] };
    if (badReason && tier === 'L2' && !p.rules.includes('ESC-109')) {
      p.promote = true;
      p.rules.push('ESC-109');
    }
    return { candidateId: c.candidateId, tier, result: r, status: 'ok',
             promote: p.promote, promoteRules: p.rules, attempts, responseId: res.responseId };
  }

  return { candidateId: c.candidateId, tier, result: null, status: 'manual_audit',
           promote: false, promoteRules: [], attempts, error: lastErr };
}

/**
 * 并发跑一层复核。
 *
 * 【为什么要并发】
 * 实测单条 L2 约 58 秒（deepseek-v4-pro 逐条送全文）。顺序执行时，
 * 名额从 5 提到 20 意味着运行时长从 5 分钟涨到 20 分钟，
 * 超出 PRD 3 章 P95 < 12 分钟的要求。并发 3 路把同样的量压回 7 分钟。
 *
 * 【名额与预算怎么保证不超】
 * 名额在派发前就切片预留，不会超发。token 预算只能在派发前用估算值
 * 拦截 —— 并发下最多有 (并发数 - 1) 条已在途，故实际可能略微超出
 * input_tokens_max。这是刻意的取舍：token 上限是兜底护栏，
 * 名额才是主约束（见 rules.yaml budget_per_run 注释）。
 */
async function runTier(
  queue: ReviewInput[], tier: 'L2' | 'L3', deps: ReviewDeps,
  budget: TierBudget, used: { items: number; input: number; output: number },
  outcomes: ReviewOutcome[], deferred: string[],
): Promise<ReviewInput[]> {
  // 名额在派发前切片预留 —— 并发下不可能超发
  const take = queue.slice(0, budget.maxItems);
  for (const c of queue.slice(budget.maxItems)) {
    deferred.push(c.candidateId);
    outcomes.push({ candidateId: c.candidateId, tier, result: null, status: 'skipped',
                    promote: false, promoteRules: [], attempts: 0,
                    error: tier === 'L2' ? 'L2 名额/预算已用尽，转人工审阅'
                                         : 'L3 名额/预算已用尽，保留 L2 判定并转人工复核' });
  }

  const promoted: ReviewInput[] = [];
  let next = 0;
  let budgetExhausted = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= take.length) return;
      const c = take[i]!;

      const est = estTokens(deps.systemPrompt) + estTokens(buildUserContent(c, deps.bodyCharsMax));
      if (budgetExhausted || used.input + est > budget.inputTokensMax ||
          used.output >= budget.outputTokensMax) {
        // token 兜底触发：这条及之后的都不再派发
        budgetExhausted = true;
        deferred.push(c.candidateId);
        outcomes.push({ candidateId: c.candidateId, tier, result: null, status: 'skipped',
                        promote: false, promoteRules: [], attempts: 0,
                        error: tier === 'L2' ? 'L2 名额/预算已用尽，转人工审阅'
                                             : 'L3 名额/预算已用尽，保留 L2 判定并转人工复核' });
        continue;
      }
      used.input += est;   // 先按估算占位，回调里换成实际用量

      const o = await reviewOne(c, tier, deps, (u, m) => {
        used.input += u.inputTokens - est; used.output += u.outputTokens;
        deps.onUsage?.(tier, u, m);
      });
      used.items++;
      outcomes.push(o);
      if (o.promote) promoted.push(c);
    }
  };

  const lanes = Math.max(1, Math.min(deps.concurrency ?? 1, take.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return promoted;
}

export async function runReview(inputs: ReviewInput[], deps: ReviewDeps): Promise<ReviewReport> {
  const outcomes: ReviewOutcome[] = [];
  const l2Used = { items: 0, input: 0, output: 0 };
  const l3Used = { items: 0, input: 0, output: 0 };
  const deferred: string[] = [];

  const queue = [...inputs].sort((a, b) =>
    priorityOf(a, deps.highRiskKeywords, deps.isHighRisk) -
    priorityOf(b, deps.highRiskKeywords, deps.isHighRisk));

  const resumeL3 = queue.filter(c => c.resumeTier === 'L3');
  const startL2 = queue.filter(c => c.resumeTier !== 'L3');
  const promoted = await runTier(startL2, 'L2', deps, deps.l2.budget, l2Used, outcomes, deferred);
  await runTier([...resumeL3, ...promoted], 'L3', deps, deps.l3.budget, l3Used, outcomes, deferred);

  return { outcomes, l2Used, l3Used, deferred };
}
