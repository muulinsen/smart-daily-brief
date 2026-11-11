import { loadRules, re } from './rules.ts';
import type { SignalMap } from './signals.ts';

export type FilterCtx = {
  title: string;
  cleanText: string;
  signals: SignalMap;
  externalLinkCount: number;
  /** 命中强制保留预判（A–D 任一）。决定 normal_only 规则是否适用。 */
  isMandatory: boolean;
  /** 同 canonical key 已发送且语义指纹未变（PRD 7.3）。 */
  alreadySentNoUpdate: boolean;
  /** 去掉追踪参数后与库中已有条目 canonical_url 相同。 */
  duplicateCanonical: boolean;
};

export type FilterHit = { ruleId: string; name: string; reason: string; alert?: boolean };

/**
 * 确定性过滤（rules.yaml deterministic_filters）。命中即返回，不调用 AI。
 *
 * 【为什么用配置驱动的条件求值器】
 * 早先规则在 YAML 里声明、在代码里硬编码实现，两边会静默漂移 ——
 * DF-030 声明了从未实现，后来新增的 DF-040/041 同样没生效，
 * 而没有任何东西会报错。现在条件一律从 YAML 求值，
 * 声明即生效；求值器不认识的条件类型会抛错而不是静默跳过。
 */

/** 上下文里可用的谓词。规则里出现未知谓词时抛错，不静默放过。 */
function evalCond(cond: any, ctx: FilterCtx, ruleId: string): boolean {
  if (cond == null) return false;
  const text = ctx.cleanText;
  const hay = `${ctx.title}\n${text}`;

  if (Array.isArray(cond)) return cond.every(c => evalCond(c, ctx, ruleId));
  if (cond.all_of) return cond.all_of.every((c: any) => evalCond(c, ctx, ruleId));
  if (cond.any_of) return cond.any_of.some((c: any) => evalCond(c, ctx, ruleId));

  if (cond.regex !== undefined) return re(cond).test(hay);
  if (cond.title_regex !== undefined)
    return re({ regex: cond.title_regex, flags: cond.flags }).test(ctx.title);
  if (cond.body_regex !== undefined)
    return re({ regex: cond.body_regex, flags: cond.flags }).test(text);
  if (cond.signal !== undefined) return !!ctx.signals[cond.signal];
  if (cond.not_signal !== undefined) return !ctx.signals[cond.not_signal];
  if (cond.title_length_lt !== undefined) return ctx.title.trim().length < cond.title_length_lt;
  if (cond.clean_text_length_lt !== undefined) return text.trim().length < cond.clean_text_length_lt;
  if (cond.external_link_count_lt !== undefined) return ctx.externalLinkCount < cond.external_link_count_lt;

  throw new Error(`规则 ${ruleId} 含未知条件：${JSON.stringify(cond).slice(0, 80)}`);
}

/** 需要数据库上下文、无法用文本条件表达的规则，在这里给出判定。 */
const CONTEXTUAL: Record<string, (c: FilterCtx) => boolean> = {
  'DF-001': c => c.alreadySentNoUpdate,
  'DF-003': c => c.duplicateCanonical,
  // 需要查询当天已发送简报，由 brief.ts 在聚类后判定；候选初筛阶段不触发。
  'DF-047': () => false,
  // 「整篇转载且无新增信息」需要语义比对，交给 AI，规则层不判
  'DF-030': () => false,
};

/** 规则 ID → 面向用户的过滤理由。必须避开 never_filter_on 清单。 */
const REASONS: Record<string, string> = {
  'DF-001': '同一条目已发送且无实质更新',
  'DF-002': '标题或正文为空',
  'DF-003': '去除追踪参数后与已有条目重复',
  'DF-047': '同一事件已在当天较早窗口推送，本窗口不再重复',
  'DF-010': '联盟推广拉新且无可操作内容',
  'DF-011': '仅有优惠码而无操作步骤',
  'DF-020': '低信息量：无链接、无代码、无步骤且篇幅极短',
  'DF-021': '正文包含疑似泄露的密钥或访问令牌',
  'DF-048': '面向残障或沟通障碍群体的无障碍辅助软件项目，不纳入日报范围',
  'DF-030': '整篇转载且无新增信息',
  'DF-040': '第三方公益站/中转站的运营公告或内测招募，非服务商官方权益',
  'DF-041': '站点争议或个人恩怨爆料，无公共价值',
  'DF-042': '转发的政治或意识形态论断，无官方来源可核验',
  'DF-043': '明星娱乐圈争议与八卦',
  'DF-044': '账号买卖或代充代练',
  'DF-045': '社区第三方平台的拼团、抽奖或红包促销，主要为营销活动',
  'DF-046': '社区签到、站龄或个人徽章成就，缺少公共信息增量',
};

export function applyDeterministicFilters(ctx: FilterCtx): FilterHit | null {
  const defs = loadRules().deterministic_filters ?? [];

  for (const d of defs) {
    const id: string = d.id;
    // normal_only 规则不得淘汰强制保留候选（PRD 8.2）
    if (d.applies_to === 'normal_only' && ctx.isMandatory) continue;

    const ctxFn = CONTEXTUAL[id];
    const fired = ctxFn ? ctxFn(ctx) : evalCond(d.condition, ctx, id);
    if (!fired) continue;

    const reason = REASONS[id] ?? d.description ?? d.name ?? id;
    assertReasonAllowed(reason, id);
    return { ruleId: id, name: d.name, reason, alert: !!d.alert };
  }
  return null;
}

/**
 * 反向保护：过滤理由不得落在 never_filter_on 上（PRD 8.3 末段）。
 * 命中即抛错转人工审计 —— 这是防止规则悄悄退化成
 * 「按热度/商业属性过滤」的闸门。
 */
export function assertReasonAllowed(reason: string, ruleId = ''): void {
  const banned: string[] = loadRules().never_filter_on ?? [];
  const hit = banned.find(b => reason.includes(b));
  if (hit)
    throw new Error(
      `过滤理由命中反向保护清单「${hit}」（规则 ${ruleId}，理由「${reason}」）。` +
      `PRD 8.3 明令这类理由不得单独作为过滤依据，应转人工审计。`);
}

/**
 * 自检：每条声明的规则要么有条件、要么有上下文实现，否则永不生效。
 * 供校验器在 CI 里调用，堵住「YAML 里声明了但代码没实现」这类静默失效。
 */
export function auditRuleCoverage(): string[] {
  const defs = loadRules().deterministic_filters ?? [];
  const problems: string[] = [];
  for (const d of defs) {
    const hasCond = !!d.condition;
    const hasCtx = d.id in CONTEXTUAL;
    if (!hasCond && !hasCtx)
      problems.push(`${d.id}（${d.name}）既无 condition 也无上下文实现 —— 永不生效`);
    if (!(d.id in REASONS))
      problems.push(`${d.id} 缺少面向用户的过滤理由`);
  }
  return problems;
}
