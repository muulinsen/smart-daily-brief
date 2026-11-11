#!/usr/bin/env node
/**
 * Telegram 群组每日要点的试运行：只读打开 Telegram 库，不写 telegram_digests / 总结缓存。
 *   node apps/worker/src/telegram-daily-preview.ts --end 2026-10-21T23:00:00Z [--hours 24] [--out ./data/preview/tg-daily]
 * 输出 .md（阅读）与 .json（可用 preview.ts --telegram-json 拼进日报预览）。
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { createProvider } from '../../../packages/ai/src/registry.ts';
import { telegramPick } from '../../../packages/web/src/model-runtime.ts';
import { composeDaily, loadWindowMessages, renderDailyMarkdown, dailyCount } from '../../../packages/telegram/src/daily.ts';
import { channelName } from '../../../packages/telegram/src/digest.ts';

const argv = process.argv.slice(2);
const arg = (k: string) => argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const end = new Date(arg('--end') ?? new Date().toISOString());
const start = new Date(end.getTime() - Number(arg('--hours') ?? 24) * 3600e3);
const out = arg('--out') ?? './data/preview/tg-daily';
const db = new Database(process.env.TELEGRAM_DATABASE_PATH ?? './data/telegram.sqlite3', { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const s = db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
const timeoutMs = Number(process.env.TELEGRAM_AI_TIMEOUT_MS) || 240_000;
const pick = telegramPick('telegramSummary');
if (pick && !pick.ok) { console.error(`❌ 模型配置错误（Telegram 总结）：${pick.message}`); process.exit(1); }
const provider = await createProvider(pick ? { ...pick.cfg, timeoutMs } : { provider: s.provider, model: s.model, baseUrl: s.base_url ?? undefined,
  apiKey: resolveSecret(s.credential_ref), timeoutMs });
const groups = loadWindowMessages(db as any, start.toISOString(), end.toISOString(), channelName);
db.close();
const fmt = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(d);
console.log(`窗口 ${fmt(start)} → ${fmt(end)}（北京时间）；${groups.length} 个群，${groups.reduce((n, g) => n + g.messages.length, 0)} 条消息`);
const d = await composeDaily(provider, groups, start.toISOString(), end.toISOString(), { log: m => console.log(m) });
mkdirSync(out.replace(/\/[^/]*$/, '') || '.', { recursive: true });
const md = `# Telegram 群组每日要点（试运行预览）\n\n窗口：北京时间 ${fmt(start)} → ${fmt(end)}；${groups.length} 个群；共 ${dailyCount(d)} 条\n\n` +
  d.categories.map(c => `- ${c.name}：${c.items.length} 条`).join('\n') + '\n\n' + renderDailyMarkdown(d) +
  `\n---\n涉及群组：${d.groups.join('、')}\n\n> 试运行：未写入 telegram_digests，未发送。\n`;
writeFileSync(`${out}.md`, md);
writeFileSync(`${out}.json`, JSON.stringify(d, null, 2));
console.log(`✅ ${out}.md / .json；共 ${dailyCount(d)} 条：${d.categories.map(c => `${c.name} ${c.items.length}`).join('，')}`);
