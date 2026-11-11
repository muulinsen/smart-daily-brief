/**
 * 全局模型供应商：所有写操作（docs/model-providers-design.md 第 3 版定稿第 5、8 节）。
 *
 * 每个写操作一个 IMMEDIATE 事务：比对 revision（乐观锁）→ 修改 → 对 7 个使用方的完整引用图重新校验 → 同事务写审计。
 * 配置与审计要么都成功，要么都不发生；多进程、多窗口由 SQLite 保证。审计只记 ID、名称、类型、主机名、模型与字段名。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../../db/src/index.ts';
import { providerFromEnv } from '../../ai/src/registry.ts';
import type { ProviderConfig } from '../../ai/src/types.ts';
import {
  CONSUMERS, CONSUMER_LABEL, PROVIDER_TYPES, PROVIDER_TYPE_LABEL, OPENAI_LIKE, DISABLE_ALLOWED, FOLLOW_RULES,
  seal, unseal, hostOf, keyHint, normalizeBaseUrl, validateBaseUrl, validModelId, validateGraph, readModelConfig,
  loadModelSnapshot, resolveModel, RETIRED_CONSUMER,
  type AssignmentRow, type Consumer, type ProviderRow, type ProviderType,
} from '../../ai/src/model-config.ts';
import { hydrateEnv, resolveEmbeddingConfig, resolveSecret, vaultPath, type SecretName } from './secrets.ts';

export class ModelConfigError extends Error {
  code: 'conflict' | 'invalid' | 'state';
  constructor(message: string, code: 'conflict' | 'invalid' | 'state' = 'invalid') { super(message); this.name = 'ModelConfigError'; this.code = code; }
}

const now = () => new Date().toISOString();

function audit(db: DB, action: string, entityId: string, payload: Record<string, unknown>) {
  db.prepare(`INSERT INTO audit_events (entity_type,entity_id,action,payload_json,created_at) VALUES ('model_config',?,?,?,?)`)
    .run(entityId, action, JSON.stringify({ ...payload, actor: 'owner' }), now());
}

/** 乐观锁：revision 必须等于表单打开时的值，否则有人先改了。返回新 revision。 */
function bump(db: DB, expected: number): number {
  const r = db.prepare('UPDATE model_config_state SET revision = revision + 1 WHERE singleton=1 AND revision = ?').run(expected);
  if (r.changes !== 1) throw new ModelConfigError('配置已在别处被修改，请刷新页面后重试', 'conflict');
  return expected + 1;
}

function checkGraph(db: DB) {
  const raw = readModelConfig(db);
  const errs = validateGraph(raw.providers, raw.assignments, raw.enabled);
  if (errs.length) throw new ModelConfigError(errs.join('；'));
}

function tx<T>(db: DB, fn: () => T): T { return db.transaction(fn).immediate(); }

/** 已删除的来源画像：分配表里永久保留一行「停用」（不引用供应商；旧代码要求 7 行齐全，回滚后仍可用）。 */
function keepRetired(db: DB) {
  db.prepare(`INSERT INTO model_assignments (consumer,provider_id,model,strictness,follow,disabled) VALUES (?,NULL,NULL,NULL,NULL,1)
    ON CONFLICT(consumer) DO UPDATE SET provider_id=NULL, model=NULL, strictness=NULL, follow=NULL, disabled=1`).run(RETIRED_CONSUMER);
}

function newId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'p_' + [...randomBytes(8)].map(b => alphabet[b % alphabet.length]).join('');
}

export type ProviderInput = { name: string; type: string; baseUrl: string; apiKey?: string; clearKey?: boolean };

function checkInput(i: ProviderInput): { name: string; type: ProviderType; baseUrl: string; apiKey: string } {
  const name = String(i.name ?? '').trim();
  if (!name || name.length > 40) throw new ModelConfigError('名称需为 1–40 字');
  const type = String(i.type ?? '') as ProviderType;
  if (!PROVIDER_TYPES.includes(type)) throw new ModelConfigError('供应商类型无效');
  const baseUrl = String(i.baseUrl ?? '').trim().replace(/\/+$/, '');
  const err = validateBaseUrl(type, baseUrl);
  if (err) throw new ModelConfigError(err);
  const apiKey = String(i.apiKey ?? '').trim();
  if (apiKey && (apiKey.length > 500 || /[\s\u0000-\u001f]/.test(apiKey))) throw new ModelConfigError('密钥格式不正确');
  return { name, type, baseUrl, apiKey };
}

function sealedCols(key: Buffer, id: string, baseUrl: string, apiKey: string | null) {
  const u = baseUrl ? seal(key, 'url', id, baseUrl) : null;
  const k = apiKey ? seal(key, 'key', id, apiKey) : null;
  return { url_ct: u?.ct ?? null, url_iv: u?.iv ?? null, url_tag: u?.tag ?? null, base_host: hostOf(baseUrl),
    key_ct: k?.ct ?? null, key_iv: k?.iv ?? null, key_tag: k?.tag ?? null, key_hint: apiKey ? keyHint(apiKey) : null };
}

export function createModelProvider(db: DB, key: Buffer | null, input: ProviderInput, expected: number): { id: string; revision: number } {
  if (!key) throw new ModelConfigError('未设置 APP_ENCRYPTION_KEY，无法保存密钥', 'state');
  const i = checkInput(input);
  if (!i.apiKey) throw new ModelConfigError('新增供应商必须填写密钥');
  return tx(db, () => {
    const revision = bump(db, expected);
    const id = newId();
    const c = sealedCols(key, id, i.baseUrl, i.apiKey);
    db.prepare(`INSERT INTO model_providers (id,name,type,base_host,url_ct,url_iv,url_tag,key_ct,key_iv,key_tag,key_hint,config_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, i.name, i.type, c.base_host, c.url_ct, c.url_iv, c.url_tag, c.key_ct, c.key_iv, c.key_tag, c.key_hint, now(), now());
    checkGraph(db);
    audit(db, 'model_provider_created', id, { name: i.name, type: i.type, host: c.base_host || 'official' });
    return { id, revision };
  });
}

/** 修改供应商。类型或地址变化时必须重新填写密钥（不能把旧密钥发到新地址）。type / 地址 / 密钥任一变化 config_version + 1。 */
export function updateModelProvider(db: DB, key: Buffer | null, id: string, input: ProviderInput, expected: number): { revision: number; reconfigured: boolean } {
  if (!key) throw new ModelConfigError('未设置 APP_ENCRYPTION_KEY，无法保存密钥', 'state');
  const i = checkInput(input);
  return tx(db, () => {
    const revision = bump(db, expected);
    const row = db.prepare('SELECT * FROM model_providers WHERE id=?').get(id) as ProviderRow | undefined;
    if (!row) throw new ModelConfigError('供应商不存在');
    let oldUrl: string | null = null;
    try { oldUrl = row.url_ct ? unseal(key, 'url', id, { ct: row.url_ct, iv: row.url_iv!, tag: row.url_tag! }) : ''; } catch { oldUrl = null; }
    const endpointChanged = row.type !== i.type || oldUrl === null || normalizeBaseUrl(row.type, oldUrl) !== normalizeBaseUrl(i.type, i.baseUrl);
    if (endpointChanged && !i.apiKey && !input.clearKey)
      throw new ModelConfigError('修改类型或 Base URL 后必须重新填写密钥');
    let keep: string | null = null;
    if (!i.apiKey && !input.clearKey && row.key_ct) {
      try { keep = unseal(key, 'key', id, { ct: row.key_ct, iv: row.key_iv!, tag: row.key_tag! }); }
      catch { throw new ModelConfigError('原密钥无法解密（主密钥可能已变化），请重新填写密钥'); }
    }
    const newKey = i.apiKey || (input.clearKey ? null : keep);
    const keyChanged = !!i.apiKey || (!!input.clearKey && !!row.key_ct);
    const reconfigured = endpointChanged || keyChanged;
    const c = sealedCols(key, id, i.baseUrl, newKey);
    db.prepare(`UPDATE model_providers SET name=?,type=?,base_host=?,url_ct=?,url_iv=?,url_tag=?,key_ct=?,key_iv=?,key_tag=?,key_hint=?,
      config_version=config_version+?,updated_at=?,
      models_next_allowed_at=CASE WHEN ? THEN NULL ELSE models_next_allowed_at END,
      models_next_allowed_for=CASE WHEN ? THEN NULL ELSE models_next_allowed_for END WHERE id=?`)
      .run(i.name, i.type, c.base_host, c.url_ct, c.url_iv, c.url_tag, c.key_ct, c.key_iv, c.key_tag, c.key_hint,
        reconfigured ? 1 : 0, now(), reconfigured ? 1 : 0, reconfigured ? 1 : 0, id);
    checkGraph(db);
    const changes = [row.name !== i.name && 'name', row.type !== i.type && 'type', endpointChanged && 'base_url', keyChanged && 'api_key'].filter(Boolean);
    audit(db, 'model_provider_updated', id, { name: i.name, type: i.type, host: c.base_host || 'official', changes });
    return { revision, reconfigured };
  });
}

export function deleteModelProvider(db: DB, id: string, expected: number): { revision: number } {
  return tx(db, () => {
    const revision = bump(db, expected);
    const row = db.prepare('SELECT name, type FROM model_providers WHERE id=?').get(id) as any;
    if (!row) throw new ModelConfigError('供应商不存在');
    const users = (db.prepare('SELECT consumer FROM model_assignments WHERE provider_id=?').all(id) as any[]).map(r => CONSUMER_LABEL[r.consumer as Consumer]);
    if (users.length) throw new ModelConfigError(`该供应商正被使用：${users.join('、')}。请先改分配再删除`);
    db.prepare('DELETE FROM model_providers WHERE id=?').run(id);
    audit(db, 'model_provider_deleted', id, { name: row.name, type: row.type });
    return { revision };
  });
}

export function setManualModels(db: DB, id: string, models: string[], expected: number): { revision: number } {
  return tx(db, () => {
    const revision = bump(db, expected);
    const row = db.prepare('SELECT type FROM model_providers WHERE id=?').get(id) as any;
    if (!row) throw new ModelConfigError('供应商不存在');
    const list = [...new Set(models.map(m => m.trim()).filter(Boolean))];
    if (list.length > 100) throw new ModelConfigError('手动模型最多 100 个');
    const bad = list.filter(m => !validModelId(row.type, m));
    if (bad.length) throw new ModelConfigError(`模型 ID 格式不正确：${bad.slice(0, 3).join('、').slice(0, 120)}`);
    db.prepare('UPDATE model_providers SET manual_models_json=?, updated_at=? WHERE id=?').run(JSON.stringify(list.sort()), now(), id);
    audit(db, 'model_provider_manual_models', id, { count: list.length });
    return { revision };
  });
}

export type AssignmentInput = { consumer: Consumer; mode: 'provider' | 'follow' | 'disabled'; providerId?: string; model?: string; strictness?: string; follow?: string };

function toRow(i: AssignmentInput): AssignmentRow {
  if (!CONSUMERS.includes(i.consumer)) throw new ModelConfigError('未知使用方');
  const label = CONSUMER_LABEL[i.consumer];
  if (i.mode === 'disabled') {
    if (!DISABLE_ALLOWED.has(i.consumer)) throw new ModelConfigError(`${label}不能停用`);
    return { consumer: i.consumer, provider_id: null, model: null, strictness: null, follow: null, disabled: 1 };
  }
  if (i.mode === 'follow') {
    const f = i.follow as 'l1' | 'l2';
    if (!FOLLOW_RULES[i.consumer].includes(f)) throw new ModelConfigError(`${label}不能跟随该层`);
    return { consumer: i.consumer, provider_id: null, model: null, strictness: null, follow: f, disabled: 0 };
  }
  const model = String(i.model ?? '').trim();
  if (!i.providerId || !model) throw new ModelConfigError(`${label}：请选择供应商并填写模型`);
  const st = String(i.strictness ?? '').trim();
  if (st && !['strict', 'json', 'none'].includes(st)) throw new ModelConfigError(`${label}：结构化输出强度无效`);
  return { consumer: i.consumer, provider_id: i.providerId, model, strictness: (st || null) as any, follow: null, disabled: 0 };
}

/** 整表保存：提交内容就是完整的分配表（没提交的用途被清除）。开关打开时要求 7 行齐全，否则整次回滚。 */
export function saveAssignments(db: DB, inputs: AssignmentInput[], expected: number): { revision: number } {
  const rows = inputs.map(toRow);
  if (new Set(rows.map(r => r.consumer)).size !== rows.length) throw new ModelConfigError('使用方重复');
  return tx(db, () => {
    const revision = bump(db, expected);
    const before = new Map((db.prepare('SELECT * FROM model_assignments').all() as AssignmentRow[]).map(a => [a.consumer, a]));
    const ins = db.prepare(`INSERT INTO model_assignments (consumer,provider_id,model,strictness,follow,disabled) VALUES (?,?,?,?,?,?)
      ON CONFLICT(consumer) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model, strictness=excluded.strictness, follow=excluded.follow, disabled=excluded.disabled`);
    const keep = new Set(rows.map(r => r.consumer));
    const del = db.prepare('DELETE FROM model_assignments WHERE consumer=?');
    for (const c of before.keys()) if (!keep.has(c) && (c as string) !== RETIRED_CONSUMER) del.run(c);
    keepRetired(db);
    for (const r of rows) {
      if (r.provider_id && !db.prepare('SELECT 1 FROM model_providers WHERE id=?').get(r.provider_id)) throw new ModelConfigError(`${CONSUMER_LABEL[r.consumer]}：供应商不存在`);
      ins.run(r.consumer, r.provider_id, r.model, r.strictness, r.follow, r.disabled);
    }
    checkGraph(db);
    const describe = (a?: AssignmentRow) => !a ? 'none' : a.disabled ? 'disabled' : a.follow ? `follow:${a.follow}` : `${a.provider_id}/${a.model}${a.strictness ? `/${a.strictness}` : ''}`;
    const changes = [...rows.filter(r => describe(before.get(r.consumer)) !== describe(r)).map(r => ({ consumer: r.consumer, from: describe(before.get(r.consumer)), to: describe(r) })),
      ...[...before.keys()].filter(c => !keep.has(c) && (c as string) !== RETIRED_CONSUMER).map(c => ({ consumer: c, from: describe(before.get(c)), to: 'none' }))];
    audit(db, 'model_assignments_saved', 'assignments', { changes });
    return { revision };
  });
}

/** 启用 / 停用整体开关。启用时要求 7 行齐全且引用图有效。 */
export function setModelConfigEnabled(db: DB, enabled: boolean, expected: number): { revision: number } {
  return tx(db, () => {
    const revision = bump(db, expected);
    db.prepare('UPDATE model_config_state SET enabled=?, enabled_at=CASE WHEN ? THEN ? ELSE enabled_at END WHERE singleton=1')
      .run(enabled ? 1 : 0, enabled ? 1 : 0, now());
    checkGraph(db);
    audit(db, enabled ? 'model_config_enabled' : 'model_config_disabled', 'state', {});
    return { revision };
  });
}

// ---------------- 模型列表结果回写（不改 revision） ----------------

export type ModelsFetchResult =
  | { ok: true; models: string[]; truncated: boolean }
  | { ok: false; kind: string; status?: number; retryAfterSec?: number };

/** 回写前核对供应商仍存在且 config_version 未变；否则丢弃（不覆盖新配置、不复活已删除的供应商）。返回是否已写入。 */
export function applyModelsFetch(db: DB, id: string, configVersion: number, r: ModelsFetchResult): boolean {
  return tx(db, () => {
    const row = db.prepare('SELECT config_version FROM model_providers WHERE id=?').get(id) as any;
    if (!row || row.config_version !== configVersion) return false;
    if (r.ok) {
      db.prepare(`UPDATE model_providers SET models_json=?, models_for=?, models_truncated=?, models_fetched_at=?, models_error_json=NULL WHERE id=?`)
        .run(JSON.stringify(r.models), configVersion, r.truncated ? 1 : 0, now(), id);
    } else {
      const next = r.retryAfterSec ? new Date(Date.now() + Math.min(r.retryAfterSec, 3600) * 1000).toISOString() : null;
      db.prepare(`UPDATE model_providers SET models_error_json=?,
        models_next_allowed_at=CASE WHEN ? IS NOT NULL THEN ? ELSE models_next_allowed_at END,
        models_next_allowed_for=CASE WHEN ? IS NOT NULL THEN ? ELSE models_next_allowed_for END WHERE id=?`)
        .run(JSON.stringify({ kind: r.kind, status: r.status ?? null, at: now() }), next, next, next, configVersion, id);
    }
    return true;
  });
}

// ---------------- 首次导入 ----------------

/**
 * 构造 worker 实际看到的环境：process.env 副本 + 保管库 hydrate（只补未设置的键），与 worker 启动时 hydrateEnv() 之后一致。
 */
export function workerEnvCopy(path = vaultPath()): NodeJS.ProcessEnv {
  const env = { ...process.env };
  hydrateEnv(path, env);
  return env;
}

type LegacyPick = { consumer: Consumer; disabled?: boolean; cfg?: ProviderConfig; reason?: string };

const SDK_IMPLICIT_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS'];

/** 收集每个使用方当前实际生效的旧配置（全部基于同一份环境副本）。 */
export function collectLegacy(telegramSettings: any, env: NodeJS.ProcessEnv, path = vaultPath()): LegacyPick[] {
  const out: LegacyPick[] = [];
  for (const t of ['L1', 'L2', 'L3'] as const) out.push({ consumer: t.toLowerCase() as Consumer, cfg: providerFromEnv(t, env) });
  const sec = (name: string) => resolveSecret(name as SecretName, path, env);
  if (!telegramSettings) {
    out.push({ consumer: 'telegramSummary', reason: '读不到 Telegram 设置' }, { consumer: 'telegramVision', reason: '读不到 Telegram 设置' });
  } else {
    out.push({ consumer: 'telegramSummary', cfg: { provider: telegramSettings.provider, model: telegramSettings.model,
      baseUrl: telegramSettings.base_url ?? undefined, apiKey: sec(telegramSettings.credential_ref) } });
    out.push({ consumer: 'telegramVision', cfg: { provider: telegramSettings.vision_provider, model: telegramSettings.vision_model,
      baseUrl: telegramSettings.vision_base_url ?? undefined, apiKey: sec(telegramSettings.vision_credential_ref) } });
  }
  const emb = resolveEmbeddingConfig(path, env);
  out.push(emb.config.enabled && !emb.errors.length
    ? { consumer: 'embedding', cfg: { provider: 'openai_compatible', model: emb.config.model, baseUrl: emb.config.baseUrl, apiKey: emb.config.apiKey } }
    : { consumer: 'embedding', disabled: true });
  return out;
}

const keyHash = (k: string) => createHash('sha256').update(k).digest('hex');
const identity = (c: ProviderConfig) => JSON.stringify([c.provider, normalizeBaseUrl(c.provider as ProviderType, c.baseUrl), keyHash(c.apiKey ?? '')]);
const sameModel = (a: ProviderConfig, b: ProviderConfig) => identity(a) === identity(b) && a.model === b.model && (a.strictness ?? null) === (b.strictness ?? null);

export type ImportReport = { ok: boolean; reasons: string[]; providers?: number; revision?: number };

/**
 * 从当前配置导入：全程同步（没有 await），后台进程内不会穿插其他请求。任一使用方无法导入则整体不导入。
 * 事务内：确认开关关着且没有供应商 → 写供应商与 7 行分配 → 用新数据解析并与旧配置逐项比对 → 打开开关、审计。
 */
export function importLegacy(db: DB, key: Buffer | null, telegramSettings: any, expected: number, env = workerEnvCopy()): ImportReport {
  if (!key) return { ok: false, reasons: ['未设置 APP_ENCRYPTION_KEY'] };
  const picks = collectLegacy(telegramSettings, env);
  const reasons: string[] = [];
  for (const p of picks) {
    const label = CONSUMER_LABEL[p.consumer];
    if (p.reason) { reasons.push(`${label}：${p.reason}`); continue; }
    if (p.disabled) continue;
    const c = p.cfg!;
    if (c.provider === 'mock') { reasons.push(`${label}：当前是模拟供应商（mock），无法导入`); continue; }
    if (!PROVIDER_TYPES.includes(c.provider as ProviderType)) { reasons.push(`${label}：供应商类型不支持`); continue; }
    if (!c.apiKey) { reasons.push(`${label}：当前配置没有密钥`); continue; }
    const urlErr = validateBaseUrl(c.provider as ProviderType, (c.baseUrl ?? '').trim());
    if (urlErr) { reasons.push(`${label}：${urlErr}`); continue; }
    if (!validModelId(c.provider, c.model)) { reasons.push(`${label}：模型 ID 为空或格式不正确`); continue; }
    if ((p.consumer === 'telegramVision' || p.consumer === 'embedding') && !OPENAI_LIKE.has(c.provider))
      reasons.push(`${label}：${PROVIDER_TYPE_LABEL[c.provider as ProviderType]} 不支持该用途`);
    if (c.provider === 'anthropic') {
      const hit = SDK_IMPLICIT_ENV.filter(k => (env[k] ?? '').trim());
      if (hit.length) reasons.push(`${label}：环境变量 ${hit.join('、')} 会改变 Anthropic 的实际请求，导入后行为会不同，请先移除`);
    }
  }
  if (reasons.length) return { ok: false, reasons };

  const byConsumer = new Map(picks.map(p => [p.consumer, p]));
  const l1 = byConsumer.get('l1')!.cfg!, l2 = byConsumer.get('l2')!.cfg!;
  const groups = new Map<string, { id: string; cfg: ProviderConfig }>();
  for (const p of picks) if (p.cfg && !groups.has(identity(p.cfg))) groups.set(identity(p.cfg), { id: newId(), cfg: p.cfg });
  const rows: AssignmentRow[] = picks.map(p => {
    const base = { consumer: p.consumer, provider_id: null, model: null, strictness: null, follow: null, disabled: 0 } as AssignmentRow;
    if (p.disabled) return { ...base, disabled: 1 };
    const c = p.cfg!;
    if (p.consumer !== 'l1' && FOLLOW_RULES[p.consumer].includes('l1') && sameModel(c, l1)) return { ...base, follow: 'l1' };
    if (p.consumer === 'l3' && sameModel(c, l2)) return { ...base, follow: 'l2' };
    return { ...base, provider_id: groups.get(identity(c))!.id, model: c.model, strictness: (c.strictness ?? null) as any };
  });

  try {
    return tx(db, () => {
      const st = db.prepare('SELECT enabled FROM model_config_state WHERE singleton=1').get() as any;
      if (st?.enabled === 1 || db.prepare('SELECT 1 FROM model_providers LIMIT 1').get())
        throw new ModelConfigError('已导入或已手动建立供应商，不能重复导入', 'state');
      const revision = bump(db, expected);
      // 没有供应商时已有的分配只可能是「停用 / 跟随」；导入以完整的 7 行替换它们
      db.prepare('DELETE FROM model_assignments').run();
      for (const g of groups.values()) {
        const c = sealedCols(key, g.id, (g.cfg.baseUrl ?? '').trim().replace(/\/+$/, ''), g.cfg.apiKey!);
        const host = c.base_host || hostOf(normalizeBaseUrl(g.cfg.provider as ProviderType, ''));
        const name = `${PROVIDER_TYPE_LABEL[g.cfg.provider as ProviderType]} · ${host}`.slice(0, 40);
        db.prepare(`INSERT INTO model_providers (id,name,type,base_host,url_ct,url_iv,url_tag,key_ct,key_iv,key_tag,key_hint,config_version,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(g.id, name, g.cfg.provider, c.base_host, c.url_ct, c.url_iv, c.url_tag, c.key_ct, c.key_iv, c.key_tag, c.key_hint, now(), now());
      }
      const ins = db.prepare('INSERT INTO model_assignments (consumer,provider_id,model,strictness,follow,disabled) VALUES (?,?,?,?,?,?)');
      for (const r of rows) ins.run(r.consumer, r.provider_id, r.model, r.strictness, r.follow, r.disabled);
      keepRetired(db);
      db.prepare('UPDATE model_config_state SET enabled=1, enabled_at=? WHERE singleton=1').run(now());
      checkGraph(db);
      // 用新数据解析，与旧配置逐项比对；差异报告只列使用方与字段名，不输出任何值
      const snap = loadModelSnapshot(db, key);
      const diffs: string[] = [];
      for (const p of picks) {
        const r = resolveModel(snap, p.consumer);
        const label = CONSUMER_LABEL[p.consumer];
        if (p.disabled) { if (!(r.ok && r.disabled)) diffs.push(`${label}：停用状态`); continue; }
        if (!r.ok || r.disabled) { diffs.push(`${label}：无法解析`); continue; }
        const a = r.cfg, b = p.cfg!;
        const fields = [a.provider !== b.provider && '类型', normalizeBaseUrl(a.provider as ProviderType, a.baseUrl) !== normalizeBaseUrl(b.provider as ProviderType, b.baseUrl) && '地址',
          a.apiKey !== b.apiKey && '密钥', a.model !== b.model && '模型', (a.strictness ?? null) !== (b.strictness ?? null) && '结构化输出强度'].filter(Boolean);
        if (fields.length) diffs.push(`${label}：${fields.join('、')}不同`);
      }
      if (diffs.length) throw new ModelConfigError(`导入结果与当前配置不一致，已放弃：${diffs.join('；')}`);
      audit(db, 'model_config_imported', 'import', { providers: groups.size,
        assignments: rows.map(r => ({ consumer: r.consumer, mode: r.disabled ? 'disabled' : r.follow ? `follow:${r.follow}` : 'provider' })) });
      return { ok: true, reasons: [], providers: groups.size, revision };
    });
  } catch (e) {
    if (e instanceof ModelConfigError) return { ok: false, reasons: [e.message] };
    throw e;
  }
}
