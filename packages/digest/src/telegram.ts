/**
 * 为每日简报读取 Telegram 群组每日要点（telegram_digests，format=daily_v2）。只读打开 Telegram 库。
 * 要点窗口以 telegram_settings.schedule_json 的单一边界（07:00）结束，须在简报截止前 max_age_hours 内。
 * 未就绪时轮询等待，超时返回 pending，由渲染器注明「群组要点生成中」。
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type { DigestTelegram } from './core.ts';

export async function loadTelegramDaily(briefEnd: Date, o: { waitMinutes?: number; maxAgeHours?: number; path?: string; log?: (s: string) => void } = {}): Promise<DigestTelegram> {
  const path = o.path ?? process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3';
  const log = o.log ?? (() => {});
  if (!existsSync(path)) { log(`Telegram 库不存在：${path}`); return { status: 'pending', categories: [], groups: [] }; }
  const from = new Date(briefEnd.getTime() - (o.maxAgeHours ?? 3) * 3600e3).toISOString();
  const deadline = Date.now() + (o.waitMinutes ?? 0) * 60e3;
  for (;;) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma('busy_timeout = 5000');
      const row = db.prepare(`SELECT window_start, window_end, summary_json FROM telegram_digests
        WHERE status='completed' AND window_end>=? AND window_end<=? ORDER BY window_end DESC LIMIT 1`).get(from, briefEnd.toISOString()) as any;
      if (row?.summary_json) {
        const d = JSON.parse(row.summary_json);
        if (d?.format === 'daily_v2') return { status: 'ready', windowStart: row.window_start, windowEnd: row.window_end, categories: d.categories, groups: d.groups ?? [], ...(Array.isArray(d.notes) && d.notes.length ? { notes: d.notes.map(String) } : {}) };
      }
    } catch (e: any) { log(`读取 Telegram 要点失败：${String(e?.message ?? e).slice(0, 160)}`); }
    finally { db.close(); }
    if (Date.now() >= deadline) return { status: 'pending', categories: [], groups: [] };
    log('Telegram 群组要点尚未就绪，60 秒后重试');
    await new Promise(r => setTimeout(r, 60e3));
  }
}
