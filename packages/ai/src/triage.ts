import { errorText } from './errors.ts';
import type { Provider, CompleteResult } from './types.ts';
import { ProviderError } from './types.ts';
import { TRIAGE_SCHEMA, validate, type TriageResult } from './schema.ts';

/**
 * L1 批量判定编排器。
 *
 * 负责 PRD 15 里除模型调用本身之外的全部逻辑：分批、输入最小化、
 * Schema 校验、失败重试、升级判定、预算熔断、结果回填。
 * Provider 由外部注入 —— 用 mock 就能把这整条链路测穿，
 * 不需要 key、不花 token（PRD 23.2）。
 */

export type Candidate = {
  candidateId: string;
  sourceId: string;
  sourceKind: string;
  title: string;
  publishedAt: string | null;
  url: string | null;
  body: string;
  signals: string[];
  repos: string[];
  officialLinks: string[];
  prescreenClasses: string[];
  /** 语义指纹。相同指纹已有合格结果时直接复用，不再调模型（PRD 15.2）。 */
  contentHash: string;
};

export type TriageOutcome = {
  candidateId: string;
  result: TriageResult | null;
  /** ok=模型给出结果；reused=命中指纹复用；manual_audit=校验失败转人工；skipped=预算不足 */
  status: 'ok' | 'reused' | 'manual_audit' | 'skipped';
  escalate: boolean;
  escalationRules: string[];
  error?: string;
  attempts: number;
  responseId?: string;
};

export type TriageBudget = {
  inputTokensMax: number;
  outputTokensMax: number;
  /** 单次请求最多塞几个候选 */
  batchSize: number;
  /** 单候选正文字符上限（PRD 15.2） */
  bodyCharsMax: number;
};

export type TriageDeps = {
  provider: Provider;
  systemPrompt: string;
  budget: TriageBudget;
  /** 已有的指纹→结果缓存（PRD 15.2 reuse_by_content_hash） */
  cachedByHash?: Map<string, TriageResult>;
  /** 高风险关键词与重大新闻类型，来自 rules.yaml */
  highRiskKeywords?: string[];
  /** 带守卫的高风险判定；未提供时退回裸关键词匹配 */
  isHighRisk?: (text: string) => boolean;
  majorNewsTypes?: string[];
  /** 人工正例归纳出的无效过滤理由；命中时不得直接过滤，必须升级。 */
  invalidFilterReasonFragments?: string[];
  onUsage?: (u: CompleteResult['usage'], model: string) => void;
};

export type TriageReport = {
  outcomes: TriageOutcome[];
  usedInputTokens: number;
  usedOutputTokens: number;
  calls: number;
  /** 因预算耗尽被跳过的候选数 */
  skippedForBudget: number;
  budgetStopped: boolean;
};

const estTokens = (s: string) => Math.ceil(s.length / 2.2);

/** 组装单个候选的紧凑 payload（PRD 15.2 输入最小化）。 */
export function buildPayload(c: Candidate, bodyCharsMax: number) {
  return {
    candidate_id: c.candidateId,
    source: c.sourceId,
    source_kind: c.sourceKind,
    title: c.title,
    published_at: c.publishedAt,
    url: c.url,
    extracted: {
      repos: c.repos.slice(0, 5),
      official_links: c.officialLinks.slice(0, 5),
      signals: c.signals,
    },
    rule_prescreen: {
      mandatory_classes: c.prescreenClasses,
      deterministic_filter: null,
    },
    body: c.body.slice(0, bodyCharsMax),
  };
}

/**
 * 升级判定（rules.yaml escalation.l1_to_l2，PRD 15.4）。
 * ESC-005 是防漏项的最后一道闸：强制保留预判命中但模型判为过滤，
 * 绝不能直接采信模型 —— 必须升级复核。
 */
export function decideEscalation(
  c: Candidate, r: TriageResult, deps: TriageDeps,
): { escalate: boolean; rules: string[] } {
  const rules: string[] = [];
  const hay = `${c.title}\n${c.body}`;

  if (c.prescreenClasses.length > 0 && r.decision === 'filter') rules.push('ESC-005');
  if (r.decision === 'filter' && r.filter_reason &&
      (deps.invalidFilterReasonFragments ?? []).some(x => r.filter_reason!.includes(x)))
    rules.push('ESC-009');
  if (r.confidence < 0.75) rules.push('ESC-001');
  // 用带守卫的匹配替代裸 includes —— 实测裸匹配 7 条命中里 6 条是误伤
  // （「量化」← 轻量化控制、「币」← 港币、「试验」← 试验品阶段）
  if (deps.isHighRisk ? deps.isHighRisk(hay)
      : (deps.highRiskKeywords ?? []).some(k => hay.includes(k))) rules.push('ESC-002');
  if ((deps.majorNewsTypes ?? []).some(k => hay.includes(k))) rules.push('ESC-003');
  if (r.decision === 'escalate') rules.push('ESC-MODEL');
  if (r.escalation_reasons?.length) rules.push('ESC-MODEL');
  if (c.sourceId === 'elsewhere' && c.body.length > 6000) rules.push('ESC-006');
  if (c.body.length > 20000) rules.push('ESC-008');

  return { escalate: rules.length > 0, rules: [...new Set(rules)] };
}

/**
 * 跑一批候选。
 *
 * 失败处理遵循 FR-044：Schema 不合规时缩短正文重试一次；仍失败则
 * 整批降级为逐条重试；再失败进人工审计，绝不静默丢弃。
 */
export async function runTriage(cands: Candidate[], deps: TriageDeps): Promise<TriageReport> {
  const { provider, budget } = deps;
  const outcomes: TriageOutcome[] = [];
  let usedIn = 0, usedOut = 0, calls = 0, skipped = 0, stopped = false;

  // 1. 指纹复用（PRD 15.2）：相同内容已有合格结果就不再调模型
  const pending: Candidate[] = [];
  for (const c of cands) {
    const hit = deps.cachedByHash?.get(c.contentHash);
    if (hit) {
      const esc = decideEscalation(c, hit, deps);
      outcomes.push({ candidateId: c.candidateId, result: { ...hit, candidate_id: c.candidateId },
                      status: 'reused', escalate: esc.escalate, escalationRules: esc.rules, attempts: 0 });
    } else pending.push(c);
  }

  // 2. 分批
  for (let i = 0; i < pending.length; i += budget.batchSize) {
    const batch = pending.slice(i, i + budget.batchSize);
    const est = estTokens(deps.systemPrompt) +
                estTokens(JSON.stringify(batch.map(c => buildPayload(c, budget.bodyCharsMax))));

    // 预算熔断（PRD 15.5）：超限则停止新调用，但已完成的结果保留，
    // 未处理的标为 skipped 供人工审阅，而不是静默丢弃。
    if (usedIn + est > budget.inputTokensMax || usedOut >= budget.outputTokensMax) {
      stopped = true;
      for (const c of pending.slice(i)) {
        outcomes.push({ candidateId: c.candidateId, result: null, status: 'skipped',
                        escalate: false, escalationRules: [], attempts: 0,
                        error: '本轮 AI 预算已用尽，转人工审阅' });
        skipped++;
      }
      break;
    }

    const r = await callBatch(batch, deps, (u, m) => {
      usedIn += u.inputTokens; usedOut += u.outputTokens; calls++; deps.onUsage?.(u, m);
    });
    outcomes.push(...r);
  }

  return { outcomes, usedInputTokens: usedIn, usedOutputTokens: usedOut,
           calls, skippedForBudget: skipped, budgetStopped: stopped };
}

async function callBatch(
  batch: Candidate[], deps: TriageDeps,
  track: (u: CompleteResult['usage'], model: string) => void,
): Promise<TriageOutcome[]> {
  const { provider, budget } = deps;
  let attempts = 0;
  let lastErr = '';
  let lastKind: string | undefined;

  // max_tokens 是安全上限而非花费承诺 —— 只按实际生成量计费，设高不花钱。
  // 实测真实候选每条约 500 输出 token（含推理过程；短填充内容只需 105，
  // 不能拿它当基准）。按 900/条留两倍余量。
  let outCap = Math.max(2000, batch.length * 900);

  // 尝试 1：正常；尝试 2：视失败原因决定是缩短正文还是提高输出上限。
  // 截断时缩短输入几乎不减少输出 —— 那样重试等于白试，必须提高上限。
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    const chars = attempt === 0 || lastKind === 'truncated'
      ? budget.bodyCharsMax : Math.floor(budget.bodyCharsMax / 3);
    if (lastKind === 'truncated') outCap = Math.min(budget.outputTokensMax, outCap * 3);
    const userContent = JSON.stringify({ candidates: batch.map(c => buildPayload(c, chars)) });
    let res: CompleteResult;
    try {
      res = await provider.complete({
        systemPrompt: deps.systemPrompt,
        userContent,
        schema: TRIAGE_SCHEMA,
        schemaName: 'triage',
        maxOutputTokens: outCap,
        cachePrefix: true,
      });
    } catch (e) {
      const pe = e as ProviderError;
      lastErr = errorText(pe);
      lastKind = pe instanceof ProviderError ? pe.kind : undefined;
      // 拒答与鉴权错误重试无意义，直接转人工
      if (pe instanceof ProviderError && !pe.retryable && pe.kind !== 'bad_request') break;
      continue;
    }
    track(res.usage, res.model);

    const errs = validate(res.data, TRIAGE_SCHEMA);
    if (errs.length) { lastErr = `Schema 校验失败: ${errs.slice(0, 3).join('; ')}`; lastKind = 'schema'; continue; }

    // 结果必须逐条对上 candidate_id，不得遗漏或新增（防止模型串号）
    const byId = new Map<string, TriageResult>(
      (res.data as any).results.map((r: TriageResult) => [r.candidate_id, r]));
    const missing = batch.filter(c => !byId.has(c.candidateId));
    if (missing.length) {
      lastErr = `模型漏判 ${missing.length} 条: ${missing.map(m => m.candidateId).join(',')}`;
      lastKind = 'schema';
      continue;
    }

    return batch.map(c => {
      const r = byId.get(c.candidateId)!;
      const esc = decideEscalation(c, r, deps);
      return { candidateId: c.candidateId, result: r, status: 'ok' as const,
               escalate: esc.escalate, escalationRules: esc.rules,
               attempts, responseId: res.responseId };
    });
  }

  // 两次都失败 → 人工审计，不静默丢弃（FR-044）
  return batch.map(c => ({
    candidateId: c.candidateId, result: null, status: 'manual_audit' as const,
    escalate: true, escalationRules: ['SCHEMA-FAIL'], attempts, error: lastErr,
  }));
}
