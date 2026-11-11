#!/usr/bin/env node
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { runDueSummaries } from '../../../packages/telegram/src/summarize.ts';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { telegramPick } from '../../../packages/web/src/model-runtime.ts';

const db=readyTelegramDb();
try {
  const settings=db.prepare('SELECT credential_ref FROM telegram_settings WHERE singleton=1').get() as any;
  // 全局模型供应商：每个任务领取前重新解析（开关关着时返回 null，沿用 telegram_settings 旧配置）
  const select=()=>{ const p=telegramPick('telegramSummary'); return p===null?null:p.ok?{cfg:p.cfg}:{error:p.error}; };
  const done=await runDueSummaries(db,resolveSecret(settings.credential_ref),select);
  console.log(`Telegram 总结完成 ${done} 个窗口`);
} finally { db.close(); }
