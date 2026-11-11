/**
 * 各入口取模型配置的唯一途径（docs/model-providers-design.md 第 3 版定稿）。
 *
 * - 开关关着：原样调用今天的旧代码（providerFromEnv / resolveEmbeddingConfig / 画像设置 / telegram_settings），逐字不变。
 * - 开关打开：只从 brief.db 的快照解析；本地可判定的配置错误返回 { ok:false }，由调用方在派发请求前处理。
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { providerFromEnv } from '../../ai/src/registry.ts';
import type { ProviderConfig } from '../../ai/src/types.ts';
import { parseEmbeddingFields, validateEmbeddingConfig, type EmbeddingConfig } from '../../ai/src/embeddings.ts';
import {
  loadModelSnapshot, resolveModel, normalizeBaseUrl, CONFIG_ERROR_LABEL, OFFICIAL_BASE,
  type Consumer, type ConfigError, type Snapshot, type ProviderType,
} from '../../ai/src/model-config.ts';
import { resolveEmbeddingConfig, resolveSettings, resolveSecret } from './secrets.ts';

export type ModelPick =
  | { ok: true; cfg: ProviderConfig; fingerprint: string; source: 'assignment' | 'legacy' }
  | { ok: false; error: ConfigError; message: string };

/** 以只读方式打开 brief.db（不会因路径错误而新建空库）。 */
export function openBriefDbReadonly(path = process.env.DATABASE_PATH ?? './data/brief.db'): Database.Database {
  if (!existsSync(path)) throw new Error(`找不到日报数据库（DATABASE_PATH），无法读取模型配置`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/** 从 brief.db 读一次快照。缺文件或缺迁移 019 时抛错（调用方以配置错误处理，不回退）。 */
export function snapshotFromBriefDb(path?: string): Snapshot {
  const db = openBriefDbReadonly(path);
  try { return loadModelSnapshot(db); } finally { db.close(); }
}

/** 旧配置的指纹：类型、规范化地址、模型、strictness、密钥哈希（用于图片识别暂停的归属判断）。 */
export function legacyFingerprint(cfg: ProviderConfig): string {
  const keyHash = cfg.apiKey ? createHash('sha256').update(cfg.apiKey).digest('hex') : '';
  const base = cfg.provider === 'mock' ? '' : normalizeBaseUrl(cfg.provider as ProviderType, cfg.baseUrl);
  return createHash('sha256').update(JSON.stringify(['legacy', cfg.provider, base, cfg.model, cfg.strictness ?? null, keyHash])).digest('hex').slice(0, 16);
}

function fromResolved(snap: Snapshot & { enabled: true }, consumer: Consumer): ModelPick {
  const r = resolveModel(snap, consumer);
  if (!r.ok) return { ok: false, error: r.error, message: CONFIG_ERROR_LABEL[r.error] };
  if (r.disabled) return { ok: false, error: 'not_assigned', message: '该用途已在后台停用' };
  return { ok: true, cfg: r.cfg, fingerprint: r.fingerprint, source: 'assignment' };
}

/** 日报 L1 / L2 / L3。env 只给后台用：后台不 hydrate，测试旧配置时传入 worker 看到的环境副本。 */
export function tierPick(snap: Snapshot, tier: 'L1' | 'L2' | 'L3', env: NodeJS.ProcessEnv = process.env): ModelPick {
  if (!snap.enabled) { const cfg = providerFromEnv(tier, env); return { ok: true, cfg, fingerprint: legacyFingerprint(cfg), source: 'legacy' }; }
  return fromResolved(snap, tier.toLowerCase() as Consumer);
}

/** 给 createTierEnv：可用配置或配置错误（该层直接标记不可用，不派发请求）。 */
export function tierInput(snap: Snapshot, tier: 'L1' | 'L2'): ProviderConfig | { configError: string } {
  const p = tierPick(snap, tier);
  return p.ok ? p.cfg : { configError: p.error };
}

/** 进程入口用：取不到就带着错误类型退出（旧流程 / triage / brief / review / 预览）。 */
export function tierConfigOrExit(snap: Snapshot, tier: 'L1' | 'L2' | 'L3'): ProviderConfig {
  const p = tierPick(snap, tier);
  if (p.ok) return p.cfg;
  console.error(`❌ 模型配置错误（${tier}）：${p.message}（${p.error}）。请在后台「模型分配」中修正。`);
  process.exit(1);
}

/** 向量模型：返回可用配置或不可用原因（与今天「向量未配置」的处理一致）。 */
export function embeddingPick(snap: Snapshot): { config: EmbeddingConfig | null; note: string } {
  if (!snap.enabled) {
    const emb = resolveEmbeddingConfig();
    return { config: emb.config.enabled && !emb.errors.length ? emb.config : null,
      note: !emb.config.enabled ? '后台未启用向量模型' : emb.errors.join('；') };
  }
  const r = resolveModel(snap, 'embedding');
  if (r.ok && r.disabled) return { config: null, note: '后台已停用向量模型' };
  if (!r.ok) return { config: null, note: `向量模型配置错误：${CONFIG_ERROR_LABEL[r.error]}` };
  const s = resolveSettings();   // 维度与阈值仍在原处
  // 官方类型地址留空 = 官方默认地址（向量客户端自己没有默认值）
  const baseUrl = r.cfg.baseUrl || OFFICIAL_BASE[r.cfg.provider as ProviderType] || '';
  const config = parseEmbeddingFields({ enabled: 'true', baseUrl, model: r.cfg.model,
    dimensions: s.embeddingDimensions, simHigh: s.dedupSimHigh, simLow: s.dedupSimLow }, r.cfg.apiKey);
  config.scope = r.fingerprint;
  const errors = validateEmbeddingConfig(config);
  return errors.length ? { config: null, note: errors.join('；') } : { config, note: '' };
}

/**
 * Telegram 三类任务：每个任务领取前调用。开关关着返回 null（调用方用 telegram_settings 旧逻辑）。
 * 读快照本身失败（缺库、缺迁移）也算配置错误：不领取任务，等修好后自动继续。
 */
export function telegramPick(consumer: 'telegramSummary' | 'telegramVision', dbPath?: string): ModelPick | null {
  let snap: Snapshot;
  try { snap = snapshotFromBriefDb(dbPath); }
  catch (e: any) { return { ok: false, error: 'key_unreadable', message: `读取模型配置失败：${String(e?.message ?? e).slice(0, 120)}` }; }
  if (!snap.enabled) return null;
  return fromResolved(snap, consumer);
}

/** 旧配置下 Telegram 的模型配置（与今天 runDueSummaries / runOneVisionTask 的读取一致），用于计算旧配置指纹。 */
export function legacyTelegramConfig(settings: any, consumer: 'telegramSummary' | 'telegramVision', env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  return consumer === 'telegramSummary'
    ? { provider: settings.provider, model: settings.model, baseUrl: settings.base_url ?? undefined, apiKey: resolveSecret(settings.credential_ref, undefined, env) }
    : { provider: settings.vision_provider, model: settings.vision_model, baseUrl: settings.vision_base_url ?? undefined, apiKey: resolveSecret(settings.vision_credential_ref, undefined, env) };
}
