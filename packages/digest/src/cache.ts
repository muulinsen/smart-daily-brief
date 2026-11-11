/**
 * AI 结果与向量缓存（迁移 018）。缓存是输入的函数：键含实际输入哈希与配置标识，换模型/端点/提示词即换空间。
 * 写入一律 ON CONFLICT DO NOTHING，随后重读胜出行，保证并发进程使用同一结果。
 * 只读打开的数据库（preview）只读不写；表不存在（未迁移）时整体停用并给出提示。
 */
import { createHash } from 'node:crypto';
import { nowIso, type DB } from '../../db/src/index.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 稳定序列化：对象键排序，保证同一输入得到同一哈希。 */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as any).sort().map(k => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export class AiCache {
  readonly enabled: boolean;
  readonly writable: boolean;
  readonly note: string | null;
  #db: DB | null;
  constructor(db: DB | null) {
    this.#db = db;
    const tables = db ? (db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('ai_item_notes','embedding_cache')`).get() as any).n : 0;
    this.enabled = !!db && tables === 2;
    this.writable = this.enabled && !db!.readonly;
    this.note = !db ? null : this.enabled ? (this.writable ? null : '数据库只读：只读取缓存，未命中的 AI 调用不会写回缓存') : '缓存表缺失，请先运行迁移（npm run migrate）';
  }

  getResult(inputHash: string, task: string, configId: string): { tier: 'L1' | 'L2'; value: any } | null {
    if (!this.enabled) return null;
    const r = this.#db!.prepare('SELECT tier, result_json FROM ai_item_notes WHERE input_sha256=? AND task=? AND config_id=?').get(inputHash, task, configId) as any;
    if (!r) return null;
    try { return { tier: r.tier, value: JSON.parse(r.result_json) }; } catch { return null; }
  }

  /** 写入并返回胜出行（并发时以先写入者为准）。 */
  putResult(inputHash: string, task: string, configId: string, tier: 'L1' | 'L2', value: unknown): { tier: 'L1' | 'L2'; value: any } {
    if (!this.writable) return { tier, value };
    this.#db!.prepare(`INSERT INTO ai_item_notes(input_sha256,task,config_id,tier,result_json,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(input_sha256,task,config_id) DO NOTHING`).run(inputHash, task, configId, tier, JSON.stringify(value), nowIso());
    return this.getResult(inputHash, task, configId) ?? { tier, value };
  }

  getVector(textHash: string, configId: string, reqDims: number): Float32Array | null {
    if (!this.enabled) return null;
    const r = this.#db!.prepare('SELECT actual_dims, vector FROM embedding_cache WHERE text_sha256=? AND config_id=? AND req_dims=?').get(textHash, configId, reqDims) as any;
    if (!r) return null;
    const buf: Buffer = r.vector;
    if (!Buffer.isBuffer(buf) || buf.byteLength !== r.actual_dims * 4) return null;
    const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i]!)) return null;
    return v;
  }

  putVector(textHash: string, configId: string, reqDims: number, v: Float32Array): Float32Array {
    if (!this.writable) return v;
    this.#db!.prepare(`INSERT INTO embedding_cache(text_sha256,config_id,req_dims,actual_dims,vector,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(text_sha256,config_id,req_dims) DO NOTHING`).run(textHash, configId, reqDims, v.length, Buffer.from(v.buffer, v.byteOffset, v.byteLength), nowIso());
    return this.getVector(textHash, configId, reqDims) ?? v;
  }
}

/** brief-maintain：删除 30 天前的缓存行（缓存可随时重建）。 */
export function pruneAiCache(db: DB, days = 30): { notes: number; vectors: number } {
  const t = (db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('ai_item_notes','embedding_cache')`).get() as any).n;
  if (t !== 2) return { notes: 0, vectors: 0 };
  const before = new Date(Date.now() - days * 86400e3).toISOString();
  return {
    notes: db.prepare('DELETE FROM ai_item_notes WHERE created_at < ?').run(before).changes,
    vectors: db.prepare('DELETE FROM embedding_cache WHERE created_at < ?').run(before).changes,
  };
}
