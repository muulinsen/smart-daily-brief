#!/usr/bin/env node
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';
import { acquireVisionLease, releaseVisionLease, recoverVisionFiles, maintainHeldMedia, runOneVisionTask } from '../../../packages/telegram/src/vision.ts';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { telegramPick, legacyFingerprint, legacyTelegramConfig } from '../../../packages/web/src/model-runtime.ts';

const db = readyTelegramDb();
// 跨进程租约：另一个图片识别进程正在运行时直接退出（手动运行与定时器重叠也安全）
const owner = acquireVisionLease(db);
if (!owner) { console.log('Telegram 图片识别：另一个进程正在运行，本次跳过'); db.close(); process.exit(0); }
try {
  const settings = db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get() as any;
  // 当前配置指纹：开关打开时来自库内配置，关着时来自旧配置；读不出配置时为 null
  const pick = telegramPick('telegramVision');
  const current = () => {
    const p = telegramPick('telegramVision');
    if (p === null) return legacyFingerprint(legacyTelegramConfig(db.prepare('SELECT * FROM telegram_settings WHERE singleton=1').get(), 'telegramVision'));
    return p.ok ? p.fingerprint : null;
  };
  // 清理与恢复先于配置错误、暂停判断：保留期与目录上限在故障期间也照常执行
  const fp = current();
  const removed = recoverVisionFiles(db, undefined, new Date(), { owner, fingerprint: fp });
  const held = maintainHeldMedia(db, { fingerprint: fp });
  let result: string;
  if (pick && !pick.ok) {
    result = 'config_error';
    console.log(`Telegram 图片识别：模型配置错误（${pick.error}），本轮不领取任务`);
  } else {
    result = await runOneVisionTask(db, pick
      ? { owner, model: pick.cfg, fingerprint: pick.fingerprint, currentFingerprint: current }
      : { owner, apiKey: resolveSecret(settings.vision_credential_ref), fingerprint: legacyFingerprint(legacyTelegramConfig(settings, 'telegramVision')), currentFingerprint: current });
  }
  db.prepare(`UPDATE telegram_settings SET vision_last_run_at=?,vision_last_result=?,updated_at=? WHERE singleton=1`)
    .run(new Date().toISOString(), result, new Date().toISOString());
  console.log(`Telegram 图片识别：${result}；清理孤儿文件 ${removed}；保留到期 ${held.expired}、放回重试 ${held.released}、超出目录上限删除 ${held.evicted}`);
} finally { releaseVisionLease(db, owner); db.close(); }
