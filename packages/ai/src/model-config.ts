/**
 * 全局模型供应商：读取、解析、校验（docs/model-providers-design.md 第 3 版定稿）。
 *
 * - 开关（model_config_state.enabled）关着：snapshot.enabled=false，各入口走今天的旧代码，这里不参与。
 * - 开关打开：所有使用方只从 brief.db 的 model_providers / model_assignments 解析，不读 env、不读旧设置。
 * - 一次只读事务得到不可变快照，同一任务单元里所有使用方都从它解析。
 * - Base URL 与密钥都用主密钥 AES-256-GCM 加密，附加认证数据 = 「字段名:供应商 ID」，密文挪到别的行或别的字段都解不开。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProviderConfig, ProviderName, Strictness } from './types.ts';

type DB = Database.Database;

export const CONSUMERS = ['l1', 'l2', 'l3', 'telegramSummary', 'telegramVision', 'embedding'] as const;
/** 已删除的来源画像：model_assignments 里永久保留一行「停用」（迁移 020），旧代码的 7 行校验仍通过；新代码不再读取。 */
export const RETIRED_CONSUMER: string = 'sourceProfiler';
export type Consumer = typeof CONSUMERS[number];
export const CONSUMER_LABEL: Record<Consumer, string> = {
  l1: '日报 L1', l2: '日报 L2', l3: '日报 L3（旧版复核）', telegramSummary: 'Telegram 总结',
  telegramVision: 'Telegram 图片识别', embedding: '向量模型',
};
export const PROVIDER_TYPES = ['openai_compatible', 'openai', 'deepseek', 'qwen', 'anthropic', 'gemini'] as const;
export type ProviderType = typeof PROVIDER_TYPES[number];
export const PROVIDER_TYPE_LABEL: Record<ProviderType, string> = {
  openai_compatible: 'OpenAI 兼容', openai: 'OpenAI', deepseek: 'DeepSeek', qwen: '通义千问（DashScope）', anthropic: 'Anthropic', gemini: 'Gemini',
};
/** 每个使用方允许跟随的对象。l1 必须显式分配。 */
export const FOLLOW_RULES: Record<Consumer, Array<'l1' | 'l2'>> = {
  l1: [], l2: ['l1'], l3: ['l1', 'l2'], telegramSummary: ['l1'], telegramVision: ['l1'], embedding: [],
};
/** 只有向量模型允许「停用」（= 不启用）。 */
export const DISABLE_ALLOWED: ReadonlySet<Consumer> = new Set(['embedding']);
export const OPENAI_LIKE: ReadonlySet<string> = new Set(['openai', 'openai_compatible', 'deepseek', 'qwen']);
/** 能力约束：现有 Anthropic / Gemini 适配器不传图片；向量客户端固定 OpenAI 兼容 /embeddings + Bearer。 */
export const CAPABILITY: Partial<Record<Consumer, ReadonlySet<string>>> = { telegramVision: OPENAI_LIKE, embedding: OPENAI_LIKE };

/** 各类型官方默认地址（与适配器一致）：gemini 含版本路径；anthropic 是站点根（SDK 追加 /v1）；OpenAI 类含 /v1。 */
export const OFFICIAL_BASE: Record<ProviderType, string> = {
  openai_compatible: '',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export type ProviderRow = {
  id: string; name: string; type: ProviderType; base_host: string;
  url_ct: string | null; url_iv: string | null; url_tag: string | null;
  key_ct: string | null; key_iv: string | null; key_tag: string | null; key_hint: string | null;
  config_version: number; models_json: string; models_for: number | null; models_truncated: number;
  manual_models_json: string; models_fetched_at: string | null; models_error_json: string | null;
  models_next_allowed_at: string | null; models_next_allowed_for: number | null; created_at: string; updated_at: string;
};
export type AssignmentRow = {
  consumer: Consumer; provider_id: string | null; model: string | null; strictness: Strictness | null;
  follow: 'l1' | 'l2' | null; disabled: number;
};

export type ConfigError = 'key_unreadable' | 'key_missing' | 'capability' | 'not_assigned' | 'provider_missing' | 'follow_invalid';
export const CONFIG_ERROR_LABEL: Record<ConfigError, string> = {
  key_unreadable: '密钥或地址无法解密（主密钥缺失或不匹配）', key_missing: '供应商没有设置密钥',
  capability: '所选供应商类型不支持该用途', not_assigned: '没有分配模型', provider_missing: '分配的供应商不存在',
  follow_invalid: '跟随关系无效',
};

export type Resolved =
  | { ok: true; disabled?: false; cfg: ProviderConfig; providerId: string; fingerprint: string; host: string }
  | { ok: true; disabled: true }
  | { ok: false; error: ConfigError };

type OpenedProvider = { row: ProviderRow; baseUrl?: string; apiKey?: string; error?: 'key_unreadable' };
export type Snapshot =
  | { enabled: false; revision: number }
  | { enabled: true; revision: number; providers: Map<string, OpenedProvider>; assignments: Map<Consumer, AssignmentRow> };

// ---------- 加密 ----------

export function masterKeyFrom(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}
export function currentMasterKey(): Buffer | null { return masterKeyFrom(process.env.APP_ENCRYPTION_KEY); }

/** 主密钥强度：缺失、过短（< 32 字符）或是示例占位值时返回问题说明。已有密文的派生方式不变（兼容）。 */
export function masterKeyProblem(raw = process.env.APP_ENCRYPTION_KEY): string | null {
  if (!raw) return '未设置 APP_ENCRYPTION_KEY';
  if (/replace-with|changeme|example|placeholder/i.test(raw)) return 'APP_ENCRYPTION_KEY 仍是示例占位值';
  if (raw.length < 32) return 'APP_ENCRYPTION_KEY 太短（至少 32 字符，建议 openssl rand -base64 32 生成）';
  return null;
}

export type Sealed = { ct: string; iv: string; tag: string };
export function seal(key: Buffer, field: 'url' | 'key', id: string, plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${field}:${id}`));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
export function unseal(key: Buffer, field: 'url' | 'key', id: string, s: { ct: string; iv: string; tag: string }): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAAD(Buffer.from(`${field}:${id}`));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8');
}

// ---------- 读取 ----------

export function hasModelTables(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_config_state'`).get();
}

export type RawConfig = { enabled: boolean; revision: number; enabledAt: string | null; providers: ProviderRow[]; assignments: AssignmentRow[] };

/** 一次只读事务读出全部配置。缺迁移 019 时抛错（与缺迁移 018 的处理一致）。 */
export function readModelConfig(db: DB): RawConfig {
  if (!hasModelTables(db)) throw new Error('缺少迁移 019 的模型供应商表，请先运行 npm run migrate');
  return db.transaction(() => {
    const st = db.prepare('SELECT enabled, revision, enabled_at FROM model_config_state WHERE singleton=1').get() as any;
    return {
      enabled: st?.enabled === 1, revision: Number(st?.revision ?? 0), enabledAt: st?.enabled_at ?? null,
      providers: db.prepare('SELECT * FROM model_providers ORDER BY created_at, id').all() as ProviderRow[],
      assignments: db.prepare('SELECT * FROM model_assignments').all() as AssignmentRow[],
    };
  })();
}

export function openProvider(row: ProviderRow, key: Buffer | null): OpenedProvider {
  const out: OpenedProvider = { row };
  try {
    if (row.url_ct) {
      if (!key) throw new Error('no key');
      out.baseUrl = unseal(key, 'url', row.id, { ct: row.url_ct, iv: row.url_iv!, tag: row.url_tag! });
    }
    if (row.key_ct) {
      if (!key) throw new Error('no key');
      out.apiKey = unseal(key, 'key', row.id, { ct: row.key_ct, iv: row.key_iv!, tag: row.key_tag! });
    }
  } catch { return { row, error: 'key_unreadable' }; }
  return out;
}

/** 任务单元开始时调用一次。开关关着时只返回 { enabled:false }，调用方走旧代码。 */
export function loadModelSnapshot(db: DB, key: Buffer | null = currentMasterKey()): Snapshot {
  const raw = readModelConfig(db);
  if (!raw.enabled) return { enabled: false, revision: raw.revision };
  return {
    enabled: true, revision: raw.revision,
    providers: new Map(raw.providers.map(r => [r.id, openProvider(r, key)])),
    assignments: new Map(raw.assignments.map(a => [a.consumer, a])),
  };
}

// ---------- 解析 ----------

export function fingerprintOf(providerId: string, configVersion: number, model: string, strictness: string | null | undefined): string {
  return createHash('sha256').update(JSON.stringify([providerId, configVersion, model, strictness ?? null])).digest('hex').slice(0, 16);
}

/** 把 follow 展开到最终的显式分配（最多两跳）。 */
export function effectiveAssignment(assignments: Map<Consumer, AssignmentRow>, consumer: Consumer): AssignmentRow | { error: ConfigError } {
  let cur: Consumer = consumer;
  for (let hops = 0; hops < 3; hops++) {
    const a = assignments.get(cur);
    if (!a) return { error: hops ? 'follow_invalid' : 'not_assigned' };
    if (a.disabled) return hops ? { error: 'follow_invalid' } : a;
    if (!a.follow) return a;
    if (!FOLLOW_RULES[cur].includes(a.follow)) return { error: 'follow_invalid' };
    cur = a.follow;
  }
  return { error: 'follow_invalid' };
}

export function resolveModel(snap: Snapshot, consumer: Consumer): Resolved {
  if (!snap.enabled) throw new Error('开关关着时应走旧配置，不能调用 resolveModel');
  const a = effectiveAssignment(snap.assignments, consumer);
  if ('error' in a) return { ok: false, error: a.error };
  if (a.disabled) return DISABLE_ALLOWED.has(consumer) ? { ok: true, disabled: true } : { ok: false, error: 'follow_invalid' };
  const p = snap.providers.get(a.provider_id!);
  if (!p) return { ok: false, error: 'provider_missing' };
  if (p.error) return { ok: false, error: p.error };
  const allowed = CAPABILITY[consumer];
  if (allowed && !allowed.has(p.row.type)) return { ok: false, error: 'capability' };
  if (!p.apiKey) return { ok: false, error: 'key_missing' };
  return {
    ok: true, providerId: p.row.id, host: p.row.base_host,
    fingerprint: fingerprintOf(p.row.id, p.row.config_version, a.model!, a.strictness),
    cfg: {
      provider: p.row.type as ProviderName, model: a.model!, apiKey: p.apiKey,
      baseUrl: p.baseUrl || undefined, strictness: a.strictness ?? undefined, isolated: true,
      cacheScope: fingerprintOf(p.row.id, p.row.config_version, a.model!, a.strictness),
    },
  };
}

// ---------- 校验 ----------

const BLOCKED_HOST_SUFFIX = ['.local', '.internal', '.localhost', '.localdomain', '.home.arpa'];

/** Base URL：https only；无用户名密码、查询、片段；主机不能是 IP 字面量或本机 / 内网保留名。返回错误或 null。 */
export function validateBaseUrl(type: ProviderType, raw: string): string | null {
  const s = raw.trim();
  if (!s) return type === 'openai_compatible' ? 'OpenAI 兼容类型必须填写 Base URL' : null;
  if (s.length > 300) return 'Base URL 过长（最多 300 字）';
  let u: URL;
  try { u = new URL(s); } catch { return 'Base URL 格式不正确'; }
  if (u.protocol !== 'https:') return 'Base URL 必须是 https 地址';
  if (u.username || u.password) return 'Base URL 不能包含用户名或密码';
  if (u.search || u.hash || s.includes('?') || s.includes('#')) return 'Base URL 不能包含查询参数或片段';
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || host.includes(':')) return 'Base URL 不能使用 IP 地址，请填写域名';
  if (host === 'localhost' || !host.includes('.') || BLOCKED_HOST_SUFFIX.some(x => host.endsWith(x))) return 'Base URL 不能指向本机或内网主机名';
  return null;
}

/** 规范化：协议与主机小写、去默认端口与末尾 /、路径保留大小写；官方类型留空 = 官方地址。 */
export function normalizeBaseUrl(type: ProviderType, raw: string | undefined): string {
  const s = (raw ?? '').trim() || OFFICIAL_BASE[type];
  if (!s) return '';
  try {
    const u = new URL(s);
    const port = u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) ? `:${u.port}` : '';
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return s; }
}

export function hostOf(raw: string | undefined): string {
  try { return raw ? new URL(raw).hostname.toLowerCase() : ''; } catch { return ''; }
}

/** 模型 ID：OpenAI 兼容类允许一个 '/'（如 vendor/model）；Gemini 等不允许（会拼进请求路径）；不允许 '..'。 */
export function validModelId(type: string, id: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,199}$/.test(id) || id.includes('..')) return false;
  const slashes = (id.match(/\//g) ?? []).length;
  return slashes === 0 || (OPENAI_LIKE.has(type) && slashes === 1 && !id.endsWith('/'));
}

export function keyHint(key: string): string | null { return key.length >= 16 ? key.slice(-4) : null; }

/** 对 7 个使用方的完整引用图校验（每次写入都调用）。enabled=true 时要求 7 行齐全。返回错误列表（不含任何密钥或地址）。 */
export function validateGraph(providers: Array<Pick<ProviderRow, 'id' | 'type'>>, assignments: AssignmentRow[], requireComplete: boolean): string[] {
  const errs: string[] = [];
  const byId = new Map(providers.map(p => [p.id, p]));
  const map = new Map(assignments.map(a => [a.consumer, a]));
  for (const c of CONSUMERS) {
    const a = map.get(c);
    if (!a) { if (requireComplete) errs.push(`${CONSUMER_LABEL[c]}：没有分配`); continue; }
    if (a.disabled && !DISABLE_ALLOWED.has(c)) errs.push(`${CONSUMER_LABEL[c]}：不能停用`);
    if (a.follow && !FOLLOW_RULES[c].includes(a.follow)) errs.push(`${CONSUMER_LABEL[c]}：不能跟随 ${a.follow.toUpperCase()}`);
    if (a.provider_id) {
      const p = byId.get(a.provider_id);
      if (!p) errs.push(`${CONSUMER_LABEL[c]}：供应商不存在`);
      else if (!validModelId(p.type, a.model ?? '')) errs.push(`${CONSUMER_LABEL[c]}：模型 ID 格式不正确`);
    }
    const eff = effectiveAssignment(map, c);
    if ('error' in eff) { if (map.has(c)) errs.push(`${CONSUMER_LABEL[c]}：${CONFIG_ERROR_LABEL[eff.error]}`); continue; }
    if (eff.disabled) continue;
    const p = byId.get(eff.provider_id!);
    const allowed = CAPABILITY[c];
    if (p && allowed && !allowed.has(p.type)) errs.push(`${CONSUMER_LABEL[c]}：${PROVIDER_TYPE_LABEL[p.type]} 不支持该用途（只能用 OpenAI 兼容协议的供应商）`);
  }
  return errs;
}
