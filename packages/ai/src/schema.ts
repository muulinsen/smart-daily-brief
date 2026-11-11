import type { JsonSchema } from './types.ts';

/**
 * 两段式输出 Schema。
 *
 * PRD 15.3 原设计是一次性返回 decision + conclusion + summary_sentences，
 * 但按本机 317 条真实语料实测：单期约 80 条候选 × ~220 token 输出
 * = 17,600 token，超 PRD 15.5 的 8,000 输出预算 2.2 倍。
 *
 * 拆成两段后：
 *   triage   80 条 × ~60  token = 4,800
 *   compose  12 条 × ~250 token = 3,000
 *                               ------
 *                                7,800  落回预算内
 * 且被过滤的 68 条不再浪费输出 token，更符合 PRD 1.3「AI 最小化」。
 */

const SECTIONS = ['ai_tech', 'open_source_project', 'developer_product', 'quality_article', 'society_life'];

/** 第一段：只判定，不写摘要。 */
export const TRIAGE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'decision', 'mandatory_class', 'section',
                   'event_key', 'confidence', 'importance', 'novelty',
                   'filter_reason', 'escalation_reasons'],
        properties: {
          candidate_id: { type: 'string' },
          decision: { type: 'string', enum: ['retain', 'normal', 'filter', 'escalate'] },
          mandatory_class: { type: 'string', enum: ['A', 'B', 'C', 'D', 'none'] },
          section: { type: 'string', enum: SECTIONS },
          /** 跨来源同一事件应得到相同 event_key（PRD 7.4 聚类依据） */
          event_key: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          /** 公共重要性 0–1（PRD 8.4 权重 25），程序算不出的语义维度 */
          importance: { type: 'number', minimum: 0, maximum: 1 },
          /** 信息增量 0–1（PRD 8.4 权重 20）：相对已知信息有多少新内容 */
          novelty: { type: 'number', minimum: 0, maximum: 1 },
          filter_reason: { type: ['string', 'null'] },
          escalation_reasons: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** 第二段：只给入选条目写成品文案。 */
export const COMPOSE_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'title', 'conclusion', 'summary_sentences', 'source_limitations'],
        properties: {
          candidate_id: { type: 'string' },
          title: { type: 'string' },
          /** 一句话结论（PRD 9.2） */
          conclusion: { type: 'string', maxLength: 120 },
          /** 2–3 句摘要（PRD 9.2）。风险与未核实状态必须融入正文，不另起字段。 */
          summary_sentences: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
          /** 来源限制说明，由 composer 融进摘要正文，不单独输出到邮件 */
          source_limitations: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export type TriageResult = {
  candidate_id: string;
  decision: 'retain' | 'normal' | 'filter' | 'escalate';
  mandatory_class: 'A' | 'B' | 'C' | 'D' | 'none';
  section: string;
  event_key: string;
  confidence: number;
  importance: number;
  novelty: number;
  filter_reason: string | null;
  escalation_reasons: string[];
};

export type ComposeResult = {
  candidate_id: string;
  title: string;
  conclusion: string;
  summary_sentences: string[];
  source_limitations: string[];
};

/**
 * 轻量 Schema 校验。
 *
 * 不引入 ajv —— 896 MB 机器上能省则省，且这里只需要覆盖
 * 本项目自己定义的两个 Schema 的形状。校验失败返回具体路径，
 * 供 FR-044 的「缩短正文重试一次」与人工审计使用。
 */
export function validate(data: unknown, schema: JsonSchema, path = '$'): string[] {
  const errs: string[] = [];
  const s = schema as any;

  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    const ok = types.some((t: string) =>
      t === actual || (t === 'integer' && actual === 'number'));
    if (!ok) { errs.push(`${path}: 期望类型 ${types.join('|')}，实际 ${actual}`); return errs; }
  }
  if (s.enum && !s.enum.includes(data))
    // 不回显模型给出的值（可能复述输入内容）：只给位置、类型与长度
    errs.push(`${path}: 值不在枚举 [${s.enum.join(', ')}] 内（类型 ${typeof data}${typeof data === 'string' ? `，长度 ${data.length}` : ''}）`);
  if (typeof data === 'number') {
    if (s.minimum !== undefined && data < s.minimum) errs.push(`${path}: ${data} < 最小值 ${s.minimum}`);
    if (s.maximum !== undefined && data > s.maximum) errs.push(`${path}: ${data} > 最大值 ${s.maximum}`);
  }
  if (typeof data === 'string' && s.maxLength !== undefined && data.length > s.maxLength)
    errs.push(`${path}: 长度 ${data.length} 超过上限 ${s.maxLength}`);

  if (Array.isArray(data)) {
    if (s.minItems !== undefined && data.length < s.minItems)
      errs.push(`${path}: 元素 ${data.length} 少于下限 ${s.minItems}`);
    if (s.maxItems !== undefined && data.length > s.maxItems)
      errs.push(`${path}: 元素 ${data.length} 多于上限 ${s.maxItems}`);
    if (s.items) data.forEach((v, i) => errs.push(...validate(v, s.items, `${path}[${i}]`)));
  }

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    for (const k of s.required ?? [])
      if (!(k in o)) errs.push(`${path}.${k}: 缺少必填字段`);
    if (s.additionalProperties === false && s.properties) {
      // 字段名由模型生成，不写进错误：只给数量
      const extra = Object.keys(o).filter(k => !(k in s.properties)).length;
      if (extra) errs.push(`${path}: 不允许的额外字段 ${extra} 个`);
    }
    for (const [k, sub] of Object.entries(s.properties ?? {}))
      if (k in o) errs.push(...validate(o[k], sub as JsonSchema, `${path}.${k}`));
  }
  return errs;
}
